import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, removeStateFile, writeStateFile } from '../store.ts';

export type LocalBuildPhase = 'install' | 'build';
export type LocalBuildRestore = 'hit' | 'miss' | 'damaged';
export type LocalBuildCommand = (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
export type LocalBuildHelper = (image: string, args: string[], volumeMounts: string[]) => Promise<{ stdout: string; stderr?: string }>;

type Entry = { schema: 1; key: string; repository: string; phase: LocalBuildPhase; volume: string; sha256: string };
const HASH = /^[a-f0-9]{64}$/;
const DOCKER_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INVALID = 'Invalid local build cache metadata.';
const LABEL = 'perpetual.local-build-cache';
const queues = new Map<string, ReturnType<typeof createSaveQueue>>();
function queue(path: string) {
  let result = queues.get(path);
  if (!result) { result = createSaveQueue(); queues.set(path, result); }
  return result;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function entry(value: unknown, repository: string, phase: LocalBuildPhase): Entry | undefined {
  if (!isRecord(value) || value.schema !== 1 || typeof value.key !== 'string' || !HASH.test(value.key)
    || value.repository !== repository || value.phase !== phase || typeof value.volume !== 'string'
    || !new RegExp(`^perpetual-local-build-${repository}-${phase}-[a-f0-9]{32}$`).test(value.volume)
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) return undefined;
  return value as unknown as Entry;
}
function preserveFailure(error: unknown): boolean {
  return isRecord(error) && (error.cleanupIncomplete === true || error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR');
}
function missingVolume(error: unknown): boolean {
  if (!isRecord(error) || error.code !== 1) return false;
  return /no such volume|volume .* does not exist|volume .* not found/i.test([error.message, error.stderr, error.stdout].filter(value => typeof value === 'string').join('\n'));
}
/** A bounded local archive cache for successful workspace preparation. The caller owns command bounds and helper-container cleanup. */
export function createLocalBuildCache({ dataDir, owner, repository, docker, cleanupDocker = docker, helper }: {
  dataDir: string; owner: string; repository: string; docker: LocalBuildCommand; cleanupDocker?: LocalBuildCommand; helper: LocalBuildHelper;
}) {
  const repositoryHash = digest(repository).slice(0, 16), ownerHash = digest(owner);
  const directory = join(dataDir, 'local-build-cache', `${ownerHash}-${repositoryHash}`);
  const fileFor = (phase: LocalBuildPhase) => join(directory, `${phase}.json`);
  const volumeFor = (phase: LocalBuildPhase) => `perpetual-local-build-${repositoryHash}-${phase}-${randomUUID().replaceAll('-', '')}`;
  const labels = [`perpetual.shared=local-build`, `${LABEL}=true`, `perpetual.owner=${ownerHash}`, `perpetual.repository=${repositoryHash}`];
  const mounts = (workspaceVolume: string, cacheVolume: string, workspaceReadOnly: boolean, cacheReadOnly: boolean) => [
    `type=volume,src=${workspaceVolume},dst=/workspace${workspaceReadOnly ? ',readonly' : ''}`,
    `type=volume,src=${cacheVolume},dst=/cache${cacheReadOnly ? ',readonly' : ''}`,
  ];

  async function read(phase: LocalBuildPhase): Promise<Entry | undefined> {
    const path = fileFor(phase);
    await privateDirectory(directory, INVALID);
    let saved: unknown;
    try { saved = await readStateFile(path, { limit: 16 * 1024, invalid: INVALID }); }
    catch { return undefined; }
    return entry(saved, repositoryHash, phase);
  }

  async function volumeOwned(volume: string, run = docker): Promise<boolean> {
    let stdout: string;
    try {
      ({ stdout } = await run(['volume', 'inspect', '--format', '{{json .Labels}}', volume]));
    } catch (error) {
      if (preserveFailure(error)) throw error;
      if (missingVolume(error)) return false;
      throw error;
    }
    let saved: unknown;
    try { saved = JSON.parse(stdout.trim()); }
    catch { throw new Error('Local build cache volume labels could not be verified.'); }
    return isRecord(saved) && saved[LABEL] === 'true' && saved['perpetual.owner'] === ownerHash && saved['perpetual.repository'] === repositoryHash;
  }

  async function removeVolume(volume: string) {
    if (!new RegExp(`^perpetual-local-build-${repositoryHash}-(?:install|build)-[a-f0-9]{32}$`).test(volume) || !await volumeOwned(volume, cleanupDocker)) return;
    await cleanupDocker(['volume', 'rm', volume]);
  }

  async function restore(key: string, phase: LocalBuildPhase, workspaceVolume: string, imageId: string, onRestore?: () => unknown): Promise<LocalBuildRestore> {
    if (!HASH.test(key) || !DOCKER_VOLUME.test(workspaceVolume) || !imageId) return 'miss';
    return queue(fileFor(phase)).run(async () => {
      const current = await read(phase);
      if (!current || current.key !== key || !await volumeOwned(current.volume)) return 'miss';
      // Publish the restore step only after the cache identity and ownership are verified, and before extraction starts.
      // Keep this outside the extraction catch: a progress persistence failure must not invalidate a valid archive.
      await onRestore?.();
      // Checksum validation precedes clearing. A later extraction error may leave a partial restore; callers reset the workspace before fallback.
      const command = `echo '${current.sha256}  /cache/archive.tar' | sha256sum -c - && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /workspace -xf /cache/archive.tar`;
      try {
        await helper(imageId, ['sh', '-c', command], mounts(workspaceVolume, current.volume, false, true));
        return 'hit';
      } catch (error) {
        if (preserveFailure(error)) throw error;
        // A bad or missing archive is a miss. Extraction may have started after validation, so the caller resets the workspace.
        try {
          await removeVolume(current.volume);
          await removeStateFile(fileFor(phase), INVALID);
        } catch (cleanupError) {
          throw Object.assign(new Error(`Local build cache was unusable and its cleanup failed: ${(cleanupError as Error).message}`), { cleanupIncomplete: true as const, cause: cleanupError });
        }
        return 'damaged';
      }
    });
  }

  async function save(key: string, phase: LocalBuildPhase, workspaceVolume: string, imageId: string): Promise<void> {
    if (!HASH.test(key) || !DOCKER_VOLUME.test(workspaceVolume) || !imageId) throw new Error('Invalid local build cache input.');
    return queue(fileFor(phase)).run(async () => {
      await privateDirectory(directory, INVALID);
      const previous = await read(phase), volume = volumeFor(phase);
      let committed = false;
      try {
        await docker(['volume', 'create', ...labels.flatMap(label => ['--label', label]), volume]);
        const { stdout } = await helper(imageId, ['sh', '-c', 'tar -C /workspace -cf /cache/archive.tar . && sha256sum /cache/archive.tar'], mounts(workspaceVolume, volume, true, false));
        const match = /^([a-f0-9]{64})\s+\/cache\/archive\.tar\s*$/.exec(stdout.trim());
        if (!match) throw new Error('Local build cache archive did not produce a valid checksum.');
        const saved: Entry = { schema: 1, key, repository: repositoryHash, phase, volume, sha256: match[1] };
        await writeStateFile(fileFor(phase), `${JSON.stringify(saved)}\n`);
        committed = true;
      } catch (error) {
        // A cancelled volume-create command may have created it before its reply was lost.
        if (!committed) {
          try { await removeVolume(volume); }
          catch (cleanupError) { throw Object.assign(new Error(`${(error as Error).message} Cache cleanup failed: ${(cleanupError as Error).message}`), { cleanupIncomplete: true as const, cause: cleanupError }); }
        }
        throw error;
      }
      if (previous && previous.volume !== volume) {
        try { await removeVolume(previous.volume); }
        catch (error) { throw Object.assign(new Error(`Local build cache was saved, but the previous archive could not be removed: ${(error as Error).message}`), { cleanupIncomplete: true as const, cause: error }); }
      }
    });
  }

  return { restore, save };
}
