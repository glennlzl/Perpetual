// The GitHub CLI as the controller runs it: one environment, one runner, one reply parser and one
// failure classifier, for every module that reaches GitHub through gh (workflow runs, deployments,
// the gate's branch head and commit status, source selection, device sign-in, provider status).
// A caller keeps its own timeouts and its own words for a failure; what a failure *is* is decided
// here, from the exit alone: raw output is read to classify and never returned.
import { execFile, spawn, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** owner/name as GitHub accepts it. */
export const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i;
/** A full 40-hex commit id. */
export const SHA = /^[a-f\d]{40}$/i;
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const STATUS_LINE = /^HTTP\/[\d.]+ (\d{3})\b/;

/** Whether `value` names a repository as owner/name; a name of `.` or `..` never does. */
export const isRepository = (value: unknown): value is string => typeof value === 'string' && REPOSITORY.test(value) && !['.', '..'].includes(value.split('/')[1]);

/**
 * gh's environment: its own account and keychain configuration, without the inherited git commands,
 * helpers and trace output that would change what it runs; `strip` removes more keys and `set` adds a
 * caller's own variables. Read at call time.
 */
export function githubEnvironment({ strip = [], set = {} }: { strip?: readonly string[]; set?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  for (const key of ['GH_DEBUG', 'GH_FORCE_TTY', ...strip]) delete env[key];
  return { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', ...set };
}

export type GitHubRun = (file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
/** Runs gh with `githubEnvironment()`; a failure rejects as execFile's does, for `githubFailureKind` to read. */
export function runGitHub(args: string[], { timeout = 20_000, maxBuffer = 4 * 1024 * 1024, env = githubEnvironment(), run = exec as GitHubRun }: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; run?: GitHubRun } = {}) {
  return run('gh', args, { timeout, maxBuffer, encoding: 'utf8', windowsHide: true, env });
}

/** A streamed device login; its caller owns parsing, deadlines and cancellation, never the CLI credential store. */
export function startGitHubLogin() {
  // Colour, debugging and clipboard output cannot change the device-code protocol. Omitting --git-protocol
  // also preserves the user's GitHub preference; this operation requests no extra scopes or SSH keys.
  const env = githubEnvironment({ strip: ['DEBUG', 'CLICOLOR_FORCE', 'SSH_ASKPASS'], set: { NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0' } });
  return spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--skip-ssh-key', '--clipboard=false'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
  });
}

/** The arguments of one `gh api --include` GET, conditional when an entity tag is given. */
export const githubGetArgs = (endpoint: string, etag: string | null = null) => ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), endpoint];

export interface GitHubResponse { status: number; etag?: string | null; headers?: Record<string, string>; data?: unknown }
/**
 * A `gh api --include` reply: its status, its entity tag when valid, its headers by lowercase name
 * and its JSON body. A 304 comes back bare. Anything else that cannot be read throws the error
 * `unreadable` makes of the message, so a caller keeps its own error type.
 */
export function parseGitHubResponse(stdout: string, unreadable: (message: string) => Error = message => new Error(message)): GitHubResponse {
  const separator = /\r?\n\r?\n/.exec(stdout), status = STATUS_LINE.exec(stdout);
  if (status?.[1] === '304') return { status: 304 };
  if (!separator || !status) throw unreadable('GitHub CLI returned an unreadable response. Update gh and try again.');
  let data: unknown;
  try { data = JSON.parse(stdout.slice(separator.index + separator[0].length)); }
  catch { throw unreadable('GitHub returned an unreadable response. Try again.'); }
  const headers: Record<string, string> = {};
  for (const line of stdout.slice(0, separator.index).split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const etag = headers.etag;
  return { status: Number(status[1]), etag: etag && ENTITY_TAG.test(etag) ? etag : null, headers, data };
}

/** Whether a failed conditional request was gh reporting 304: gh exits non-zero on it, with the status line in its output. */
export const notModified = (error: unknown, etag: string | null) => Boolean(etag) && /^HTTP\/[\d.]+ 304\b/.test(String((error as { stdout?: unknown } | null | undefined)?.stdout || ''));

export type GitHubFailureKind = 'missing' | 'timeout' | 'too-large' | 'rate-limit' | 'unauthenticated' | 'not-found' | 'denied' | 'other';
/** Why a gh or git command failed, from its exit and its output; the output itself never leaves this function. */
export function githubFailureKind(error: unknown): GitHubFailureKind {
  const failure = error as (ExecFileException & { stderr?: unknown }) | null | undefined;
  const detail = String(failure?.stderr || failure?.message || '').toLowerCase();
  if (failure?.code === 'ENOENT') return 'missing';
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  if (failure?.killed || failure?.code === 'ETIMEDOUT') return 'timeout';
  if (/rate limit|secondary rate/.test(detail)) return 'rate-limit';
  if (/http 401|bad credentials|authentication failed|gh auth login|not logged|could not read username|could not read password/.test(detail)) return 'unauthenticated';
  if (/http 404|repository not found|couldn.t find remote ref|remote branch.*not found/.test(detail)) return 'not-found';
  if (/http 403|permission denied|access denied|saml|sso|resource not accessible/.test(detail)) return 'denied';
  return 'other';
}

/** The HTTP status gh printed for a request GitHub refused, such as `(HTTP 409)` or `HTTP 422:`, or null. */
export function githubHttpStatus(error: unknown): number | null {
  const failure = error as { stderr?: unknown; message?: unknown } | null | undefined;
  const match = /\bHTTP (\d{3})\b/i.exec(String(failure?.stderr || failure?.message || ''));
  return match ? Number(match[1]) : null;
}

/** The words every caller shares for the failures that are the machine's, not the request's. */
export const GITHUB_MESSAGES = {
  missing: 'GitHub CLI is unavailable. Install gh, then run gh auth login --hostname github.com.',
  'rate-limit': 'GitHub has temporarily limited requests. Wait before trying again.',
  unauthenticated: 'Sign in with gh auth login --hostname github.com, then reconnect GitHub.',
} as const;
