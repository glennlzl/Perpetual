/** A request's method (POST when it has input) and its abort signal. */
export interface ApiOptions { method?: string; signal?: AbortSignal }
/** A failed request: the controller's message and the HTTP status. */
export type ApiError = Error & { statusCode: number };
/** A request to the local controller, such as api. Its reply is the route's JSON, in the shape the controller defines. */
export type Controller = (path: string, input?: Record<string, unknown>, options?: ApiOptions) => Promise<unknown>;

let sessionToken: string | undefined;
/** A reply's error message, when the controller sent one. */
export const replyError = (data: unknown) => data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
// T is the route's reply as the local controller, this app's own server, defines it; the reply is not re-validated here.
export async function api<T = unknown>(path: string, input?: unknown, options: ApiOptions = {}, retry = true): Promise<T> {
  if (input !== undefined && !sessionToken) {
    // The token authorizes every write, so it is checked, not assumed.
    const session = await api('/api/session', undefined, options);
    sessionToken = session !== null && typeof session === 'object' && 'token' in session && typeof session.token === 'string' ? session.token : undefined;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: input === undefined ? 'GET' : options.method || 'POST',
      // Header values are strings; String() is the conversion fetch applies.
      headers: input === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', 'X-Perpetual-Token': String(sessionToken) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: options.signal,
    });
  } catch (error) {
    // A stopped or restarting controller refuses the connection, which browsers word as they like.
    if (options.signal?.aborted) throw error;
    throw new Error('The local server is unavailable. Try reconnecting.');
  }
  if (response.status === 403 && input !== undefined && retry) { sessionToken = undefined; return api<T>(path, input, options, false); }
  let data: unknown;
  try { data = await response.json(); } catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new Error('The local server is unavailable. Try reconnecting.'); }
  if (!response.ok) throw Object.assign(new Error(replyError(data) || `Request failed (${response.status}).`), { statusCode: response.status });
  return data as T;
}
