// The repair box: a Docker container that is a repair agent's whole workspace. The host clone of the failing commit is
// copied into /workspace, and every agent tool runs inside it. The box is labelled as Perpetual's, capped in memory,
// CPU and processes, runs with no-new-privileges and only the capabilities package installs need. It sits alone on an
// internal network with no route to the host or anywhere else, and reaches public package registries only through its
// egress proxy (src/repair/egress.ts). Docker Desktop's storage has no per-container quota, so the box is removed once
// it writes more than its disk limit or leaves Docker too little free space. It never gets a host mount, the Docker
// socket, the GitHub token, the OpenRouter key or any host environment. The docker CLI runs through spawn with argument
// arrays, never a shell string.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { SHA } from '../github-cli.ts';
import { dockerEngineEnvironment } from '../process.ts';
import { failureText } from '../redaction.ts';
import { EGRESS, EGRESS_SCRIPT, egressEnvironment } from './egress.ts';

export interface BoxResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
/** limit bytes of each stream are kept, from its start (head) or end (tail); stdin is written and closed. */
export interface BoxExecOptions { timeoutMs?: number; stdin?: string; signal?: AbortSignal; limit?: number; keep?: 'head' | 'tail' }
export interface RepairBox {
  /** The workspace's real path inside the box: /workspace. */
  readonly root: string;
  readonly image: string;
  exec(argv: readonly string[], options?: BoxExecOptions): Promise<BoxResult>;
  /** `git diff --binary` of the workspace against base, untracked files included and ignored ones not, as git wrote it. */
  diff(base: string): Promise<Buffer>;
  remove(): Promise<void>;
  /** Aborts when cleanup is requested; commands remain stopped even if deletion needs retrying. */
  readonly signal?: AbortSignal;
}
export interface RepairBoxes {
  /** Why no box can start, such as Docker not running; null when one can. */
  available(): Promise<string | null>;
  /** A box from image, or from the first of fallbacks Docker Hub has a tag for when it has none for image. */
  create(input: { id: string; image: string; fallbacks?: readonly string[]; source: string; signal?: AbortSignal }): Promise<RepairBox>;
  /** Confirms the resources owned by one repair are absent, including a partially created box. */
  remove(id: string): Promise<void>;
  /** Removes this controller's repair boxes that outlived their repair. */
  removeLeftovers(): Promise<void>;
}

export const ROOT = '/workspace';
/** Bytes of a change the box returns at most; a larger one is refused. */
export const DIFF_LIMIT = 10 * 1024 * 1024;
export const TOO_LARGE = 'The change is larger than 10 MB. Keep it to the files the fix needs.';
// What package installs need as root, and nothing else.
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'KILL'];
const LIMITS = ['--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--pids-limit', '1024'];
const PROXY_LIMITS = ['--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '128'];
/** Bytes the box may write, the free space it must leave Docker, and how often both are read while it works. */
export const DISK = { limit: 20 * 1024 ** 3, floor: 2 * 1024 ** 3, checkMs: 15_000 };
/** Checks between reads of a box no command runs in: once a minute at the default interval. */
const IDLE_CHECKS = 4;
const measure = (bytes: number) => bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3 * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
const IMAGE = /^(?:node|python|golang|buildpack-deps):[\w.-]{1,64}$/;
const ID = /^[\w-]{1,64}$/;
// How a registry answers a tag it does not have, such as node:14-bookworm.
const MISSING_IMAGE = /manifest unknown|manifest for \S+ not found|pull access denied|repository does not exist/i;
/**
 * The workspace against base through a temporary index, so the agent's own git use neither hides nor adds changes:
 * untracked files count and ignored ones do not; no hook, monitor, external diff or rename detection runs. Names are
 * read with their case, as on Linux, so a case-only rename is a delete and an add even when the copy came from macOS.
 */
export const DIFF_SCRIPT = [
  'set -e', 'd=$(mktemp -d)', 'trap \'rm -rf "$d"\' EXIT', 'export GIT_INDEX_FILE="$d/index"',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.ignorecase=false -c core.precomposeunicode=false "$@"; }',
  'g read-tree "$1"', 'g add -A -- .',
  'g diff --cached --binary --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ "$1"',
].join('\n');

type Capture = { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number; signal?: AbortSignal; limit?: number; keep?: 'head' | 'tail'; group?: boolean };
export type BoxBytes = Omit<BoxResult, 'stdout' | 'stderr'> & { stdout: Buffer; stderr: Buffer };
/**
 * Runs a program with arguments, keeping at most limit bytes of each stream as it wrote them. On the time limit it is
 * killed (its process group with `group`) and timedOut is set; an abort kills it and rejects with the signal's reason.
 */
export function captureBytes(file: string, args: readonly string[], { cwd, env, stdin, timeoutMs = 120_000, signal, limit = 1024 * 1024, keep = 'head', group = false }: Capture = {}): Promise<BoxBytes> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: group, windowsHide: true });
    let timedOut = false, truncated = false, settled = false;
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] }, sizes = { stdout: 0, stderr: 0 };
    const collect = (name: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (keep === 'head') {
        const room = limit - sizes[name];
        if (room <= 0) { truncated = true; return; }
        if (chunk.length > room) truncated = true;
        streams[name].push(chunk.subarray(0, room)); sizes[name] += Math.min(room, chunk.length);
        return;
      }
      streams[name].push(chunk); sizes[name] += chunk.length;
      if (sizes[name] > limit * 2) { const kept = Buffer.concat(streams[name]).subarray(-limit); streams[name] = [kept]; sizes[name] = kept.length; truncated = true; }
    };
    const kill = () => { try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    const done = (error: Error | null, code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (error) return reject(error);
      const bytes = (name: 'stdout' | 'stderr') => { const all = Buffer.concat(streams[name]); if (keep === 'tail' && all.length > limit) truncated = true; return keep === 'tail' ? all.subarray(-limit) : all; };
      const stdout = bytes('stdout'), stderr = bytes('stderr');
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, truncated });
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => done(error, null));
    child.on('close', code => done(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}
/** captureBytes with each stream decoded as UTF-8. */
export async function capture(file: string, args: readonly string[], options: Capture = {}): Promise<BoxResult> {
  const result = await captureBytes(file, args, options);
  return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}

const firstLine = (value: string) => failureText(value, 300).trim().split('\n')[0] ?? '';

/**
 * Repair boxes through the docker CLI. The box, its egress proxy and its network are labelled perpetual.owner=<owner>,
 * perpetual.repair=<id> and perpetual.data=<this data directory's hash>; leftovers are removed by those labels only,
 * before each new box.
 */
export function createRepairBoxes({ dataDir, owner = 'repair', docker: program = 'docker', disk: diskOptions = {} }: { dataDir: string; owner?: string; docker?: string; disk?: Partial<typeof DISK> }): RepairBoxes {
  const disk = { ...DISK, ...diskOptions };
  if (!/^[\w-]{1,32}$/.test(owner)) throw new Error('Invalid repair box owner.');
  let scope: Promise<string> | null = null;
  const dataScope = () => scope ??= realpath(dataDir).then(path => createHash('sha256').update(path).digest('hex').slice(0, 16));
  const docker = (args: readonly string[], options: Capture = {}) => capture(program, args, { env: dockerEngineEnvironment(), timeoutMs: 60_000, ...options });
  const dockerBytes = (args: readonly string[], options: Capture = {}) => captureBytes(program, args, { env: dockerEngineEnvironment(), timeoutMs: 60_000, ...options });
  const live = new Map<string, () => Promise<void>>();
  const cleanupError = (error: unknown) => Object.assign(new Error(`Repair box cleanup is incomplete: ${firstLine(error instanceof Error ? error.message : String(error))}`), { cleanupIncomplete: true });
  async function removeOwned(id?: string) {
    const filters = ['--filter', `label=perpetual.owner=${owner}`, '--filter', `label=perpetual.data=${await dataScope()}`,
      ...(id ? ['--filter', `label=perpetual.repair=${id}`] : [])];
    const list = async (kind: 'containers' | 'networks') => {
      const result = await docker(kind === 'containers' ? ['ps', '-aq', '--no-trunc', ...filters] : ['network', 'ls', '-q', '--no-trunc', ...filters], { timeoutMs: 20_000 });
      const ids = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
      if (result.exitCode !== 0 || result.timedOut || result.truncated || ids.some(value => !/^[a-f\d]{12,64}$/.test(value))) throw new Error(firstLine(result.stderr) || `Could not list Docker ${kind}.`);
      return ids;
    };
    try {
      const containers = await list('containers'), networks = await list('networks');
      // An already removed resource may make rm fail. Only a complete, successful observation of absence confirms cleanup.
      let failure = '';
      for (const args of [containers.length ? ['rm', '-f', '-v', ...containers] : [], networks.length ? ['network', 'rm', ...networks] : []]) {
        if (!args.length) continue;
        try { const result = await docker(args); if (result.exitCode !== 0) failure = firstLine(result.stderr); }
        catch (error) { failure = firstLine(error instanceof Error ? error.message : String(error)); }
      }
      const remainingContainers = await list('containers'), remainingNetworks = await list('networks');
      if (remainingContainers.length || remainingNetworks.length) throw new Error(failure || 'Docker resources remain after removal.');
    } catch (error) { throw cleanupError(error); }
  }
  const remove = async (id: string) => {
    if (!ID.test(id)) throw new Error('Invalid repair box.');
    await (live.get(id)?.() ?? removeOwned(id));
  };
  const removeLeftovers = async () => {
    for (const remove of live.values()) await remove();
    await removeOwned();
  };
  return {
    async available() {
      try {
        const result = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
        return result.exitCode === 0 && result.stdout.trim() ? null : 'Start Docker to repair builds.';
      } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Install Docker to repair builds.' : 'Start Docker to repair builds.'; }
    },
    removeLeftovers, remove,
    async create({ id, image, fallbacks = [], source, signal }) {
      const images = [image, ...fallbacks];
      if (!ID.test(id) || !images.every(item => IMAGE.test(item)) || !isAbsolute(source) || source.includes('\0')) throw new Error('Invalid repair box.');
      let chosen = image;
      await removeLeftovers();
      const name = `perpetual-${owner}-${id}`, proxy = `${name}-proxy`, network = name, scope = await dataScope();
      const labels = [`perpetual.owner=${owner}`, `perpetual.repair=${id}`, `perpetual.data=${scope}`].flatMap(label => ['--label', label]);
      const stopped = new AbortController();
      let watchdog: NodeJS.Timeout | undefined, removing: Promise<void> | null = null, removed = false;
      const remove = () => {
        clearInterval(watchdog);
        if (!stopped.signal.aborted) stopped.abort(new Error('Repair box cleanup was requested; commands are stopped.'));
        if (removed) return Promise.resolve();
        if (removing) return removing;
        const attempt = removeOwned(id).then(() => { removed = true; live.delete(id); });
        removing = attempt;
        void attempt.finally(() => { if (removing === attempt) removing = null; }).catch(() => {});
        return attempt;
      };
      live.set(id, remove);
      const step = async (args: readonly string[], failure: string, timeoutMs = 10 * 60_000) => {
        const result = await docker(args, { timeoutMs, signal });
        if (result.exitCode !== 0) throw new Error(`${failure}: ${firstLine(result.stderr) || `docker ${args[0]} failed`}.`);
      };
      try {
        // The box's network has no route out; the proxy alone joins it from the default bridge, as `proxy`. Its bridge
        // gets no address either, since Docker otherwise gives an internal network's bridge one, through which the box
        // would reach every service of the engine's host listening on all addresses.
        await step(['network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', ...labels, network], 'Could not create the repair box network', 60_000);
        await step(['create', '--name', proxy, ...labels, '--init', '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', EGRESS.user, ...PROXY_LIMITS,
          '--network', 'bridge', '--pull', 'missing', EGRESS.image, 'node', '-e', EGRESS_SCRIPT, String(EGRESS.port)], `Could not create the repair box proxy from ${EGRESS.image}`, 15 * 60_000);
        await step(['network', 'connect', '--alias', EGRESS.alias, network, proxy], 'Could not start the repair box proxy', 60_000);
        await step(['start', proxy], 'Could not start the repair box proxy', 60_000);
        const environment = Object.entries({ CI: 'true', DEBIAN_FRONTEND: 'noninteractive', GIT_TERMINAL_PROMPT: '0', ...egressEnvironment() }).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
        // An image whose tag the registry does not have, such as an old version without a bookworm build, gives way to
        // the next one named; any other failure ends the creation.
        for (const [index, candidate] of images.entries()) {
          const created = await docker(['create', '--name', name, ...labels, '--init', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
            ...CAPABILITIES.flatMap(capability => ['--cap-add', capability]), ...LIMITS, '--network', network, '--workdir', ROOT, ...environment,
            '--pull', 'missing', candidate, 'sleep', 'infinity'], { timeoutMs: 15 * 60_000, signal });
          if (created.exitCode === 0) { chosen = candidate; break; }
          if (index === images.length - 1 || !MISSING_IMAGE.test(created.stderr)) throw new Error(`Could not create the repair box from ${candidate}: ${firstLine(created.stderr) || 'docker create failed'}.`);
        }
        // The copy keeps host owners on some engines; the workspace is root's, as a runner's is its user's, so git and
        // package managers running as root treat it as their own. A case-insensitive host such as macOS holds one file
        // for paths that differ only in case, so the box, case-sensitive as the runner is, checks the commit out again
        // from the copy's index: its workspace is the commit, and its diff names no file the agent did not change.
        for (const args of [['start', name], ['cp', `${source}/.`, `${name}:${ROOT}`], ['exec', name, 'chown', '-R', '0:0', ROOT],
          ['exec', '-w', ROOT, name, 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.ignorecase=false', '-c', 'core.precomposeunicode=false', 'reset', '--hard', '--quiet']]) await step(args, 'Could not start the repair box');
      } catch (error) {
        try { await remove(); } catch (cleanup) { throw cleanupError(`${firstLine(error instanceof Error ? error.message : String(error))}; ${String(cleanup)}`); }
        throw error;
      }
      // While the box works, what it wrote and Docker's free space are read; past either bound the box is removed, and
      // its commands reject with why once it is gone. An idle box is read every IDLE_CHECKS checks, since a process a
      // command left running in the background may still write while the model thinks or CI runs.
      let busy = 0, used = false, checking = false, idle = 0;
      const halted = async () => { if (stopped.signal.aborted) { await removing; throw stopped.signal.reason; } };
      async function check() {
        if (checking || stopped.signal.aborted) return;
        if (!busy && !used && ++idle < IDLE_CHECKS) return;
        checking = true; used = false; idle = 0;
        try {
          const [size, free] = await Promise.all([
            docker(['container', 'inspect', '--size', '--format', '{{.SizeRw}}', name], { timeoutMs: 60_000 }),
            docker(['exec', name, 'df', '-Pk', '/'], { timeoutMs: 30_000 }),
          ]);
          const written = size.exitCode === 0 ? Number(size.stdout.trim()) : NaN, available = free.exitCode === 0 ? Number(free.stdout.trim().split('\n').at(-1)?.split(/\s+/)[3]) * 1024 : NaN;
          const reason = written > disk.limit ? `The repair box wrote more than ${measure(disk.limit)} and was removed.`
            : available < disk.floor ? `Docker has less than ${measure(disk.floor)} of disk space left, so the repair box was removed. Free space in Docker, then start the repair again.` : null;
          if (reason && !stopped.signal.aborted) {
            const failure = new Error(reason.replace('was removed', 'was stopped; cleanup is pending'));
            stopped.abort(failure);
            try { await remove(); failure.message = reason; } catch (error) { failure.message = `${failure.message} ${String(error)}`; throw error; }
          }
        } finally { checking = false; }
      }
      watchdog = setInterval(() => { void check().catch(() => {}); }, disk.checkMs);
      watchdog.unref?.();
      // Commands run under the box's own timeout; killing docker exec leaves its process running in the box, so an abort
      // stops what the timeout wrapper runs.
      async function execute<T extends BoxResult | BoxBytes>(argv: readonly string[], { timeoutMs = 120_000, stdin, signal: stop, limit, keep }: BoxExecOptions, run: (args: readonly string[], options: Capture) => Promise<T>): Promise<T> {
        await halted();
        const seconds = Math.max(1, Math.ceil(timeoutMs / 1000)), started = Date.now();
        const args = ['exec', ...(stdin === undefined ? [] : ['-i']), '-w', ROOT, name, 'timeout', '-k', '10', String(seconds), ...argv];
        busy += 1; used = true;
        try {
          const result = await run(args, { stdin, timeoutMs: timeoutMs + 30_000, signal: stop, limit, keep });
          await halted();
          return { ...result, timedOut: result.timedOut || result.exitCode === 124 || result.exitCode === 137 && Date.now() - started >= timeoutMs };
        } catch (error) {
          if (stop?.aborted) void docker(['exec', name, 'pkill', '-TERM', '-x', 'timeout'], { timeoutMs: 10_000 }).catch(() => {});
          await halted();
          throw error;
        } finally { busy -= 1; }
      }
      const box: RepairBox = {
        root: ROOT, image: chosen, signal: stopped.signal,
        exec: (argv, options = {}) => execute(argv, options, docker),
        async diff(base) {
          if (!SHA.test(base)) throw new Error('Invalid base commit.');
          const result = await execute(['sh', '-c', DIFF_SCRIPT, 'sh', base], { timeoutMs: 180_000, limit: DIFF_LIMIT }, dockerBytes);
          if (result.truncated) throw Object.assign(new Error(TOO_LARGE), { rejected: true });
          if (result.exitCode !== 0) throw new Error(`Could not read the change from the repair box: ${firstLine(result.stderr.toString('utf8')) || 'git failed'}.`);
          return result.stdout;
        },
        remove,
      };
      return box;
    },
  };
}
