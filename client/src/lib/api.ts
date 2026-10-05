/** A request's method (POST when it has input) and its abort signal. */
export interface ApiOptions { method?: string; signal?: AbortSignal }
/** A failed request: the controller's message and the HTTP status. */
export type ApiError = Error & { statusCode: number };
/** A request to the local controller, such as api. Its reply is the route's JSON, in the shape the controller defines. */
export type Controller = (path: string, input?: Record<string, unknown>, options?: ApiOptions) => Promise<unknown>;

let sessionToken: string | undefined;
/** A reply's error message, when the controller sent one. */
export const replyError = (data: unknown) => data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
/** What a request reads when the controller could not answer it, such as while it is stopped or restarting. */
export const UNAVAILABLE = 'The local server is unavailable. Try reconnecting.';
/**
 * fetch for a controller route. A refused connection or a timeout, which browsers word as they like, reads as
 * UNAVAILABLE; an abort the caller asked for through `caller` keeps its own reason.
 */
export async function controllerFetch(path: string, init: RequestInit, caller?: AbortSignal | null): Promise<Response> {
  try { return await fetch(path, init); }
  catch (error) { if (caller?.aborted) throw error; throw new Error(UNAVAILABLE); }
}
// T is the route's reply as the local controller, this app's own server, defines it; the reply is not re-validated here.
export async function api<T = unknown>(path: string, input?: unknown, options: ApiOptions = {}, retry = true): Promise<T> {
  if (input !== undefined && !sessionToken) {
    // The token authorizes every write, so it is checked, not assumed.
    const session = await api('/api/session', undefined, options);
    sessionToken = session !== null && typeof session === 'object' && 'token' in session && typeof session.token === 'string' ? session.token : undefined;
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
