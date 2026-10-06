import type { ErrorReply } from '../../../contract/error.ts';

/** A request's method (POST when it has input) and its abort signal. */
export interface ApiOptions { method?: string; signal?: AbortSignal }
/** A failed request: the controller's message and the HTTP status, and `sourceBusy` as its reply marks it. */
export type ApiError = Error & { statusCode: number; sourceBusy?: true };
/** A request to the local controller, such as api. Its reply is the route's JSON, in the shape the controller defines. */
export type Controller = (path: string, input?: Record<string, unknown>, options?: ApiOptions) => Promise<unknown>;

// Every request carries the browser secret. The launch link `perpetual serve` prints holds it in its fragment, which a
// browser never sends to a server; the page keeps it in this origin's storage, which a twin's app on another port of this
// host cannot read, and sends it in a header. A cookie would reach that app too.
const LAUNCH = '#secret=', STORED = 'perpetual-browser-secret';
let browserSecret = '', sessionToken: string | undefined, signedOut = false;
const signedOutListeners = new Set<() => void>();
const changed = () => { for (const listener of signedOutListeners) listener(); };
/**
 * Whether the controller refused this page's browser secret, with a 401: it is missing, or another launch secret's.
 * Only the link `perpetual serve` printed signs the browser in again, so the page stops and asks for it.
 */
export const session = {
  subscribe(listener: () => void) { signedOutListeners.add(listener); return () => { signedOutListeners.delete(listener); }; },
  signedOut: () => signedOut,
};

/** Signs the page in with the browser secret this browser kept, and with a launch link's whenever the address holds one, which it then drops. */
export function signIn() {
  try { browserSecret = localStorage.getItem(STORED) ?? ''; } catch { /* Without storage, only a launch link signs the page in. */ }
  const launched = () => {
    if (!location.hash.startsWith(LAUNCH)) return;
    browserSecret = location.hash.slice(LAUNCH.length);
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    try { localStorage.setItem(STORED, browserSecret); } catch { /* The secret still signs this page in. */ }
    // A link opened over the signed-out page, which changes only its fragment, signs it in again.
    if (signedOut) { signedOut = false; changed(); }
  };
  launched();
  addEventListener('hashchange', launched);
}

/** Recovers this page with a launch link for this exact controller. Refused credentials never replace stored access. */
export async function connectLaunchLink(input: unknown) {
  let link: URL;
  try { link = new URL(typeof input === 'string' && input.length <= 2048 ? input.trim() : ''); }
  catch { throw new Error('Paste the full launch link from the terminal.'); }
  if (link.origin !== location.origin || link.username || link.password || link.pathname !== '/' || link.search) {
    throw new Error('Use the launch link for this address.');
  }
  const secret = /^#secret=([0-9a-f]{64})$/.exec(link.hash)?.[1];
  if (!secret) throw new Error('Paste the full launch link from the terminal.');
  let response: Response;
  try { response = await fetch('/api/session', { headers: { 'X-Perpetual-Browser-Secret': secret }, credentials: 'omit', redirect: 'error' }); }
  catch { throw new Error(UNAVAILABLE); }
  if (response.status === 401) throw new Error('This launch link is no longer valid. Copy the latest link from the terminal.');
  if (!response.ok) throw new Error(UNAVAILABLE);
  browserSecret = secret;
  sessionToken = undefined;
  try { localStorage.setItem(STORED, secret); } catch { /* Access still works for this page when storage is unavailable. */ }
  signedOut = false;
  changed();
}

/** A reply's error message, when the controller sent one. */
export const replyError = (data: unknown) => data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
/**
 * Whether a reply, or the error a request threw for it, was refused only while the controller saved a source change.
 * The same request succeeds once the change is saved, so a poll keeps what it last read and reads again.
 */
export const sourceBusy = (value: unknown) => value !== null && typeof value === 'object' && (value as Partial<ErrorReply>).sourceBusy === true;
/** The error a refused reply throws: the controller's message, else `fallback`, with the HTTP status and the busy mark. */
export const replyFailure = (data: unknown, statusCode: number, fallback = `Request failed (${statusCode}).`): ApiError =>
  Object.assign(new Error(replyError(data) || fallback), { statusCode, ...(sourceBusy(data) ? { sourceBusy: true as const } : {}) });
/** What a request reads when the controller could not answer it, such as while it is stopped or restarting. */
export const UNAVAILABLE = 'The local server is unavailable. Try reconnecting.';
/**
 * fetch for a controller route, signed with the browser secret; a 401 ends the page's session. A refused connection or
 * a timeout, which browsers word as they like, reads as UNAVAILABLE; an abort the caller asked for through `caller` keeps
 * its own reason.
 */
export async function controllerFetch(path: string, init: RequestInit = {}, caller?: AbortSignal | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (browserSecret) headers.set('X-Perpetual-Browser-Secret', browserSecret);
  let response: Response;
  try { response = await fetch(path, { ...init, headers }); }
  catch (error) { if (caller?.aborted) throw error; throw new Error(UNAVAILABLE); }
  if (response.status === 401 && !signedOut) { signedOut = true; changed(); }
  return response;
}
// T is the route's reply as the local controller, this app's own server, defines it; the reply is not re-validated here.
export async function api<T = unknown>(path: string, input?: unknown, options: ApiOptions = {}, retry = true): Promise<T> {
  if (input !== undefined && !sessionToken) {
    // The token authorizes every write, so it is checked, not assumed.
    const reply = await api('/api/session', undefined, options);
    sessionToken = reply !== null && typeof reply === 'object' && 'token' in reply && typeof reply.token === 'string' ? reply.token : undefined;
  }
  const response = await controllerFetch(path, {
    method: input === undefined ? 'GET' : options.method || 'POST',
    // Header values are strings; String() is the conversion fetch applies.
    headers: input === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', 'X-Perpetual-Token': String(sessionToken) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: options.signal,
  }, options.signal);
  if (response.status === 403 && input !== undefined && retry) { sessionToken = undefined; return api<T>(path, input, options, false); }
  let data: unknown;
  try { data = await response.json(); } catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new Error(UNAVAILABLE); }
  if (!response.ok) throw replyFailure(data, response.status);
  return data as T;
}
