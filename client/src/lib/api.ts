/** A request's method (POST when it has input) and its abort signal. */
export interface ApiOptions { method?: string; signal?: AbortSignal }
/** A failed request: the controller's message and the HTTP status. */
export type ApiError = Error & { statusCode: number };
/** A request to the local controller, such as api. Its reply is the route's JSON, in the shape the controller defines. */
export type Controller = (path: string, input?: Record<string, unknown>, options?: ApiOptions) => Promise<unknown>;

let sessionToken: string | undefined, signedOut = false;
const signedOutListeners = new Set<() => void>();
/**
 * Whether the controller refused this page's session, with a 401: the cookie its launch link sets is missing or stale.
 * Only the link `perpetual serve` printed signs the browser in again, so the page stops and asks for it.
 */
export const session = {
  subscribe(listener: () => void) { signedOutListeners.add(listener); return () => { signedOutListeners.delete(listener); }; },
  signedOut: () => signedOut,
};
/** A reply's error message, when the controller sent one. */
export const replyError = (data: unknown) => data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
// T is the route's reply as the local controller, this app's own server, defines it; the reply is not re-validated here.
export async function api<T = unknown>(path: string, input?: unknown, options: ApiOptions = {}, retry = true): Promise<T> {
  if (input !== undefined && !sessionToken) {
    // The token authorizes every write, so it is checked, not assumed.
    const reply = await api('/api/session', undefined, options);
    sessionToken = reply !== null && typeof reply === 'object' && 'token' in reply && typeof reply.token === 'string' ? reply.token : undefined;
  }
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : options.method || 'POST',
    // Header values are strings; String() is the conversion fetch applies.
    headers: input === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', 'X-Perpetual-Token': String(sessionToken) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: options.signal,
  });
  if (response.status === 401 && !signedOut) { signedOut = true; for (const listener of signedOutListeners) listener(); }
  if (response.status === 403 && input !== undefined && retry) { sessionToken = undefined; return api<T>(path, input, options, false); }
  let data: unknown;
  try { data = await response.json(); } catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new Error('The local server is unavailable. Try reconnecting.'); }
  if (!response.ok) throw Object.assign(new Error(replyError(data) || `Request failed (${response.status}).`), { statusCode: response.status });
  return data as T;
}
