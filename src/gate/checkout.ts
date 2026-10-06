// A local checkout a gate builds a twin from. A twin copies the checkout as it is on disk, so a commit status for a
// commit holds only when the checkout is at that commit with nothing the copy would take beside it.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REGISTRY_CONFIG_BYTES, copiedConfig, isRegistryConfig, snapshotKeeps } from '../environments/plans.ts';
import { gitReadOnly } from '../process.ts';

const git = (path: string, args: string[]) => gitReadOnly(path, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
const CHANGED = 'The checkout has uncommitted changes, which a twin would copy. Commit or discard them, then run the gate.';
/** A path git status lists, relative to the repository's top level, with its two status letters. */
type Change = { code: string; file: string };

/**
 * Whether a twin copies the checkout's package manager config at `top` as it would copy the commit's: without their
 * credential lines, one the commit lacks being compared with none, so an .npmrc that only adds a registry token is no
 * change.
 */
async function sameConfig(path: string, top: string, { code, file }: Change) {
  const info = await lstat(join(top, file)).catch(() => null);
  const committed = /^(?:\?\?|A)/.test(code) ? '' : await git(path, ['cat-file', 'blob', `HEAD:${file}`]).then(({ stdout }) => stdout, () => null);
  if (!info?.isFile() || committed === null) return false;
  const current = info.size > REGISTRY_CONFIG_BYTES ? null : copiedConfig(file, await readFile(join(top, file))), before = copiedConfig(file, Buffer.from(committed));
  return current && before ? current.equals(before) : current === before;
}

/**
 * Resolves when the checkout at `path` is at `sha` and has no change a snapshot would copy: a tracked file edited, staged
 * or deleted, or an untracked file it keeps; ignored files and those it never copies, such as .perpetual or .env, do not
 * count, nor does a package manager's config that differs from the commit's only in the credential lines the copy
 * removes. Otherwise throws what to do, which a gate shows as why it needs release.
 */
export async function assertCheckoutAt(path: string, sha: string) {
  const head = await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(({ stdout }) => stdout.trim(), () => null);
  const short = (value: string) => value.slice(0, 7);
  if (head !== sha) throw new Error(`The checkout is at ${head ? short(head) : 'no commit'}, not ${short(sha)}. Scan the repository again, or check out ${short(sha)}, then run the gate.`);
  // Porcelain v1 with -z: "XY path" entries, a rename's or copy's original path as the entry after it.
  const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then(({ stdout }) => stdout, () => null);
  if (status === null) throw new Error(CHANGED);
  const entries = status.split('\0').filter(Boolean), changes: Change[] = [];
  for (let index = 0; index < entries.length; index++) { changes.push({ code: entries[index].slice(0, 2), file: entries[index].slice(3) }); if (/^[RC]/.test(entries[index])) index++; }
  const copied = changes.filter(change => snapshotKeeps(change.file));
  const top = copied.some(change => isRegistryConfig(change.file)) ? await git(path, ['rev-parse', '--show-toplevel']).then(({ stdout }) => stdout.trim(), () => null) : null;
  for (const change of copied) if (!top || !isRegistryConfig(change.file) || !await sameConfig(path, top, change)) throw new Error(CHANGED);
}
