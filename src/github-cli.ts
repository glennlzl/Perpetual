// The GitHub CLI as the controller runs it: one environment, one runner, one reply parser and one
// failure classifier, for every module that reaches GitHub through gh (workflow runs, deployments,
// the gate's branch head and commit status, source selection, device sign-in, provider status).
// A caller keeps its own timeouts and its own words for a failure; what a failure *is* is decided
// here, from the exit alone: raw output is read to classify and never returned. So is what GitHub
// unreachable is, and how work waits it out.
import { execFile, spawn, type ExecFileException } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** owner/name as GitHub accepts it; an Enterprise Managed User's login, handle_shortcode, owns repositories too. */
export const REPOSITORY = /^[a-z\d][a-z\d_-]{0,38}\/[a-z\d._-]{1,100}$/i;
/** A full 40-hex commit id. */
export const SHA = /^[a-f\d]{40}$/i;
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const STATUS_LINE = /^HTTP\/[\d.]+ (\d{3})\b/;

/** A Git branch ref, before it is placed in a command or an API path. */
export function isBranchName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && value.length <= 1024 && !value.startsWith('-') && value !== '@' && !value.endsWith('.')
    && !/[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));
}

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

/** Authenticate Git's first HTTPS request, including Git versions without proactiveAuth. Credentials live only in the child environment, scoped to GitHub; redirects are refused. */
export async function githubGitEnvironment({ env = githubEnvironment(), run = exec as GitHubRun }: { env?: NodeJS.ProcessEnv; run?: GitHubRun } = {}): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await runGitHub(['auth', 'token', '--hostname', 'github.com'], { env, run, timeout: 10_000, maxBuffer: 4096 });
  const token = stdout.trim();
  if (!token || /\s|[\u0000-\u001f\u007f]/u.test(token)) throw new Error(GITHUB_MESSAGES.unauthenticated);
  return { ...env, GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
  };
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

/** Whether a reply's Link header names a next page. */
export const hasNextPage = (response: Pick<GitHubResponse, 'headers'>) => /;\s*rel="?next"?(?:\s*,|\s*$)/i.test(response.headers?.link || '');

/** Whether a failed conditional request was gh reporting 304: gh exits non-zero on it, with the status line in its output. */
export const notModified = (error: unknown, etag: string | null) => Boolean(etag) && /^HTTP\/[\d.]+ 304\b/.test(String((error as { stdout?: unknown } | null | undefined)?.stdout || ''));

export type GitHubFailureKind = 'missing' | 'timeout' | 'too-large' | 'rate-limit' | 'unauthenticated' | 'not-found' | 'denied' | 'other';
/** Why a gh or git command failed, from its exit and its output; the output itself never leaves this function. */
export function githubFailureKind(error: unknown): GitHubFailureKind {
  const failure = error as (ExecFileException & { stderr?: unknown }) | null | undefined;
  // A command's own output, never execFile's message, which repeats the command line: its repository, branch and paths
  // are names, not GitHub's reply. Each family below is read as gh, git and GitHub print it, never as a bare word a
  // name or a local path can hold.
  const detail = String((typeof failure?.stderr === 'string' ? failure.stderr : failure?.message) || '').toLowerCase();
  if (failure?.code === 'ENOENT') return 'missing';
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  if (failure?.killed || failure?.code === 'ETIMEDOUT') return 'timeout';
  if (/rate limit|secondary rate|returned error: 429\b/.test(detail)) return 'rate-limit';
  if (/http 401|bad credentials|authentication failed|gh auth login|not logged|could not read username|could not read password|returned error: 401\b/.test(detail)) return 'unauthenticated';
  if (/http 404|repository not found|couldn.t find remote ref|remote branch.*not found/.test(detail)) return 'not-found';
  if (/http 403|returned error: 403\b|permission to \S+ denied to|write access to repository not granted|resource not accessible by|saml (?:sso|enforcement)|permission denied \(publickey|access denied/.test(detail)) return 'denied';
  return 'other';
}

/** The HTTP status gh printed for a request GitHub refused, such as `(HTTP 409)` or `HTTP 422:`, or null. */
export function githubHttpStatus(error: unknown): number | null {
  const failure = error as { stderr?: unknown; message?: unknown } | null | undefined;
  // As for the failure's kind: the command's own output, never execFile's message, which repeats its arguments.
  const match = /\bHTTP (\d{3})\b/i.exec(String((typeof failure?.stderr === 'string' ? failure.stderr : failure?.message) || ''));
  return match ? Number(match[1]) : null;
}

/** The words every caller shares for the failures that are the machine's, not the request's. */
export const GITHUB_MESSAGES = {
  missing: 'GitHub CLI is unavailable. Install gh, then run gh auth login --hostname github.com.',
  'rate-limit': 'GitHub has temporarily limited requests. Wait before trying again.',
  unauthenticated: 'Sign in with gh auth login --hostname github.com, then reconnect GitHub.',
  unreachable: 'GitHub is unreachable. Check your network connection.',
} as const;

/**
 * Whether a failure of this kind is GitHub not answering for now, on a timeout, a rate limit, or a network or server
 * failure, rather than an answer such as a refusal or a missing CLI.
 */
export const unanswered = (kind: GitHubFailureKind) => kind === 'timeout' || kind === 'rate-limit' || kind === 'other';
/**
 * GitHub did not answer the account check for now (`unanswered`): that says nothing about the account, so it is no
 * disconnect. A refusal answers 502, and work that needs GitHub waits it out.
 */
export const githubUnreachable = (message?: string) => Object.assign(new Error(message || GITHUB_MESSAGES.unreachable), { statusCode: 502, unreachable: true as const });
export const isUnreachable = (error: unknown) => Boolean(error) && typeof error === 'object' && (error as { unreachable?: unknown }).unreachable === true;
/** How often work asks GitHub again while it is unreachable, and how long it waits before giving up. */
export const OUTAGE = { pollMs: 30_000, waitMs: 15 * 60_000 };
/**
 * `read()`, asked again every `pollMs` while it fails because GitHub is unreachable, until it answers or `waitMs`
 * passed, when that failure is thrown. Any other failure is thrown at once, and `signal` ends the wait with its reason.
 */
export async function untilReachable<T>(read: () => Promise<T>, { signal, pollMs = OUTAGE.pollMs, waitMs = OUTAGE.waitMs, clock = Date.now }: { signal?: AbortSignal; pollMs?: number; waitMs?: number; clock?: () => number } = {}): Promise<T> {
  const started = clock();
  for (;;) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) { if (!isUnreachable(error) || clock() - started >= waitMs) throw error; }
    await delay(pollMs, undefined, { signal }).catch((error: unknown) => { throw signal?.aborted ? signal.reason : error; });
  }
}
