// How the controller runs the local tools it does not own, one policy per tool. Read-only git
// against a checkout runs here for every reader (the scanner, evidence, the gate's checkout check,
// edit links); the Git graph keeps its stricter reader in src/git-history.ts on purpose. A docker
// CLI pinned to a local engine by `--host` runs with the ambient endpoint removed. The twin runtime's
// docker and service CLIs (src/twin/runtime.ts) inherit the whole environment on purpose: they reach
// the user's engine through DOCKER_HOST, credential helpers and the Docker config. Their bounded command
// lifecycle, cancellation and owned-resource cleanup are handled in the twin runtime. The repair box's docker
// (src/repair/box.ts) reaches the user's engine with the engine variables and the shell basics only, since the box
// must see nothing else of the host's.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type GitRun = (file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

/** The environment of a read-only git: no prompt, no lock file, the user's global config in effect (safe.directory included). */
export const gitReadOnlyEnvironment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

/**
 * A read-only git query against the checkout at `path`: no fetch, no write, the repository's file
 * system monitor off. The environment is read at call time. Failures reject as execFile does;
 * each caller says what a failure means for it.
 */
export function gitReadOnly(path: string, args: string[], { timeout = 10_000, maxBuffer = 4 * 1024 * 1024, run = exec as GitRun, signal }: { timeout?: number; maxBuffer?: number; run?: GitRun; signal?: AbortSignal } = {}) {
  signal?.throwIfAborted();
  return run('git', ['-c', 'core.fsmonitor=false', '-C', path, ...args], { timeout, maxBuffer, encoding: 'utf8', windowsHide: true, env: gitReadOnlyEnvironment(), ...(signal ? { signal } : {}) });
}

/** The environment of the docker CLI that runs a repair box: how to reach the user's engine and its config, and the shell basics, nothing else of the host's. */
export function dockerEngineEnvironment(values: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR'];
  return Object.fromEntries(keep.filter(key => typeof values[key] === 'string').map(key => [key, values[key] as string]));
}

/** The environment of a docker CLI that names its local engine with `--host`: the ambient endpoint and its TLS settings never apply. */
export function localDockerEnvironment(values: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...values };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  return env;
}
