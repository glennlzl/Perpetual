import { startGitHubLogin } from './github-cli.ts';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getGitHubSession, type GitHubAccount, type GitHubSession } from './github-source.ts';

export type SignInStatus = 'starting' | 'pending' | 'complete' | 'error' | 'expired' | 'cancelled';
/** What the browser may see of one device sign-in: never CLI output or credentials. */
export interface SignInSnapshot {
  id: string; status: SignInStatus; userCode: string | null; verificationUrl: string | null;
  expiresAt: string; account: GitHubAccount | null; error: string | null;
}
interface SignIn extends SignInSnapshot {
  output: string; child: ChildProcess | null;
  startupTimer?: NodeJS.Timeout; expiryTimer?: NodeJS.Timeout; killTimer?: NodeJS.Timeout;
}
export interface GitHubAuthManager {
  start(): SignInSnapshot; isPending(): boolean; status(id: unknown): SignInSnapshot; cancel(id: unknown): SignInSnapshot; dispose(): void;
}

const VERIFICATION_URL = 'https://github.com/login/device';
const STARTUP_TIMEOUT = 30_000;
const SESSION_TIMEOUT = 15 * 60_000;
const MAX_OUTPUT = 16 * 1024;
const MAX_SESSIONS = 8;
const PENDING = new Set<SignInStatus>(['starting', 'pending']);

function authError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Local GitHub CLI device login. Only start() launches authorization; imports,
 * status(), and construction never do. Credentials stay in gh's credential
 * store and never enter the browser, app state, or process logs.
 *
 * Non-TTY gh --web emits its user code + URL and polls without opening a browser:
 * https://github.com/cli/cli/blob/v2.96.0/internal/authflow/flow.go
 * CLI output is not a stable JSON API: reject unsupported output with a bounded
 * timeout instead of guessing a code, OAuth client ID, or authorization URL.
 */
export function createGitHubAuthManager(): GitHubAuthManager {
  const sessions = new Map<string, SignIn>();
  let active: SignIn | null = null;
  let disposed = false;

  function snapshot(session: SignIn): SignInSnapshot {
    return {
      id: session.id, status: session.status,
      userCode: session.userCode, verificationUrl: session.verificationUrl,
      expiresAt: session.expiresAt, account: session.account,
      error: session.error,
    };
  }

  function stopChild(session: SignIn) {
    const child = session.child;
    if (!child) return;
    child.kill('SIGTERM');
    session.killTimer = setTimeout(() => {
      if (session.child === child) child.kill('SIGKILL');
    }, 1_000);
    session.killTimer.unref();
  }

  function finish(session: SignIn, status: SignInStatus, error: string | null = null) {
    if (!PENDING.has(session.status)) return;
    session.status = status;
    session.error = error;
    session.userCode = null;
    session.verificationUrl = null;
    session.output = '';
    clearTimeout(session.startupTimer);
    clearTimeout(session.expiryTimer);
    if (status !== 'complete') stopChild(session);
  }

  function find(id: unknown) {
    const session = typeof id === 'string' ? sessions.get(id) : null;
    if (!session) throw authError('This GitHub sign-in has ended. Start again.', 404);
    return session;
  }

  function readOutput(session: SignIn, chunk: string) {
    if (!PENDING.has(session.status)) return;
    session.output += chunk;
    if (session.output.length > MAX_OUTPUT) {
      finish(session, 'error', 'GitHub sign-in returned an unsupported response. Update GitHub CLI and try again.');
      return;
    }
    // The shared login runner sets NO_COLOR. Do not return any other CLI output, even on error.
    const code = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(session.output);
    // Wait for the complete line so a split pipe chunk cannot look like an
    // unexpected/truncated authorization URL.
    const url = /Open this URL to continue in your web browser:[ \t]*(https?:\/\/[^\s]+)\r?\n/.exec(session.output);
    if (url && url[1] !== VERIFICATION_URL) {
      finish(session, 'error', 'GitHub device sign-in is unavailable. Update GitHub CLI and try again.');
      return;
    }
    if (code && url) {
      session.userCode = code[1];
      session.verificationUrl = VERIFICATION_URL;
      session.status = 'pending';
      clearTimeout(session.startupTimer);
    }
  }

  async function closed(session: SignIn, code: number | null) {
    session.child = null;
    clearTimeout(session.killTimer);
    if (!PENDING.has(session.status)) return;
    if (code !== 0 || !session.userCode) {
      const expired = /expired_token|code (?:has )?expired/i.test(session.output);
      finish(session, expired ? 'expired' : 'error', expired
        ? 'The GitHub code expired. Start sign-in again.'
        : 'GitHub sign-in did not finish. Try again.');
      return;
    }
    // A successful child exit alone is insufficient: confirm the active account
    // via GitHub before the UI persists its existing connection marker.
    let verified: GitHubSession | undefined;
    try { verified = await getGitHubSession(); } catch { /* fixed message below */ }
    if (!PENDING.has(session.status)) return;
    if (!verified?.authenticated || !verified.account?.login) {
      finish(session, 'error', 'Could not verify the GitHub account. Try connecting again.');
      return;
    }
    session.account = verified.account;
    finish(session, 'complete');
  }

  function isPending() {
    // Keep account/source operations blocked while a cancelled child winds down
    // or the newly authenticated account is being verified.
    return Boolean(active && (active.child || PENDING.has(active.status)));
  }

  function start() {
    if (disposed) throw authError('GitHub sign-in is unavailable. Reload the application.', 503);
    if (active && PENDING.has(active.status)) return snapshot(active);
    if (isPending()) throw authError('The previous GitHub sign-in is closing. Try again in a moment.');

    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const session: SignIn = {
      id: randomUUID(), status: 'starting', userCode: null, verificationUrl: null,
      expiresAt: new Date(Date.now() + SESSION_TIMEOUT).toISOString(),
      account: null, error: null, output: '', child: null,
    };
    sessions.set(session.id, session);
    active = session;

    // gh refuses to persist browser credentials when an environment token takes
    // precedence. Do not silently discard or override the user's existing token.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      finish(session, 'error', 'GitHub uses an environment token. Continue with the existing account.');
      return snapshot(session);
    }

    session.startupTimer = setTimeout(() => finish(session, 'error',
      'Could not start GitHub sign-in. Check your connection and update GitHub CLI.'), STARTUP_TIMEOUT);
    session.expiryTimer = setTimeout(() => finish(session, 'expired',
      'The GitHub code expired. Start sign-in again.'), SESSION_TIMEOUT);
    session.startupTimer.unref();
    session.expiryTimer.unref();

    let child;
    try {
      child = startGitHubLogin();
    } catch {
      finish(session, 'error', 'Could not launch GitHub CLI. Install or update gh and try again.');
      return snapshot(session);
    }
    session.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => readOutput(session, chunk));
    }
    child.on('error', () => {
      finish(session, 'error', 'Could not launch GitHub CLI. Install or update gh and try again.');
    });
    child.on('close', code => { void closed(session, code); });
    return snapshot(session);
  }

  return {
    start, isPending,
    status(id: unknown) { return snapshot(find(id)); },
    cancel(id: unknown) {
      const session = find(id);
      finish(session, 'cancelled');
      return snapshot(session);
    },
    dispose() {
      disposed = true;
      for (const session of sessions.values()) finish(session, 'cancelled');
    },
  };
}
