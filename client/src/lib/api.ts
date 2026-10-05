/** A request's method (POST when it has input) and its abort signal. */
export interface ApiOptions { method?: string; signal?: AbortSignal }
/** A failed request: the controller's message and the HTTP status. */
export type ApiError = Error & { statusCode: number };
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

/** A reply's error message, when the controller sent one. */
export const replyError = (data: unknown) => data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
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
  if (!response.ok) throw Object.assign(new Error(replyError(data) || `Request failed (${response.status}).`), { statusCode: response.status });
  return data as T;
}
