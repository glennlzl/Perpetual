// A state file the controller owns: how its directory is kept private, how it is read back and how
// it is written. Every manager keeps its own file, its own size limits, its own words for a bad file
// and its own restart recovery; what they share is here, so a guard exists once.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Creates `path` as the controller's own directory (mode 0700), refuses a symbolic link with `message`, and returns its real path. */
export async function privateDirectory(path: string, message: string, { resolveAliases = true } = {}): Promise<string> {
  const configured = resolve(path);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if ((await lstat(configured)).isSymbolicLink()) throw new Error(message);
  const root = resolveAliases ? await realpath(configured) : configured;
  await chmod(root, 0o700);
  return root;
}

/** The text of a file the controller keeps, or undefined when there is none; a link, a non-file or one over `limit` bytes throws `invalid`. */
export async function readPrivateFile(file: string, { limit, invalid }: { limit: number; invalid: string }): Promise<string | undefined> {
  let stat;
  try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(invalid);
  return await readFile(file, 'utf8');
}

/** The parsed JSON of a state file, or undefined when there is none; a link, a non-file or one over `limit` bytes throws `invalid`. */
export async function readStateFile(file: string, options: { limit: number; invalid: string }): Promise<unknown> {
  const text = await readPrivateFile(file, options);
  // The controller's own file; the caller decides whether what it holds is state it can load.
  return text === undefined ? undefined : JSON.parse(text) as unknown;
}

/** Check whether an owned regular file exists, without following a symbolic link. */
export async function privateFileExists(file: string, invalid: string): Promise<boolean> {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(invalid);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Prepare an owned SQLite file before handing it to the database library; refuse redirected files and journals. */
export async function privateDatabaseFile(file: string, invalid: string): Promise<void> {
  for (const path of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(invalid);
      await chmod(path, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  try { const handle = await open(file, 'wx', 0o600); await handle.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** Remove a retired state file only after its replacement has been saved. Never follow links. */
export async function removeStateFile(file: string, invalid: string): Promise<void> {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(invalid);
    await rm(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/**
 * Writes `content` to `file` (mode 0600) through a private temporary file beside it and one rename, so a reader sees the
 * old file or the new one. A failed save removes its temporary file, so failures never pile files up, unless a caller
 * keeps it with `removeTemporary: false`; the save's own error is the one reported.
 */
export async function writeStateFile(file: string, content: string, { prefix = '.state-', removeTemporary = true } = {}) {
  const temporary = join(dirname(file), `${prefix}${randomUUID()}.tmp`);
  try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); }
  catch (error) { if (removeTemporary) await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/** One save at a time, in order; a rejected save never blocks the next, and `idle()` settles once every queued save has. */
export function createSaveQueue() {
  let saving: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => Promise<T>): Promise<T> => { const operation = saving.then(work); saving = operation.catch(() => {}); return operation; };
  return { run, idle: () => saving };
}
