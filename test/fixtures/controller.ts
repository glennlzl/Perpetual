import { startServer as start, type Controller, type ServerOptions } from '../../src/server.ts';

// Every API request needs the controller's launch secret. A test that calls the API starts its controller here, which
// opens the launch link as a browser does, and imports this module's `fetch` in place of the global one: it sends the
// session cookie that link set with every request to that controller, so each request goes out as the page's would. A
// request that sets its own Cookie or X-Perpetual-Secret header is sent as it is, and the global fetch sends neither.
const cookies = new Map<string, string>();

/** Opens a controller's launch link as a browser does, and keeps the session cookie it sets for that controller. */
export async function signIn(launchUrl: string) {
  const response = await globalThis.fetch(launchUrl, { redirect: 'manual' });
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (response.status !== 303 || !cookie) throw new Error(`The launch link set no session cookie (${response.status}).`);
  cookies.set(new URL(launchUrl).origin, cookie);
}

/** A controller started as src/server.ts starts one, and signed in through its launch link. */
export async function startServer(options?: ServerOptions): Promise<Controller> {
  const app = await start(options);
  try { await signIn(app.launchUrl); } catch (error) { await app.close(); throw error; }
  return app;
}

/** The session cookie of the controller at `url`, as headers for a request sent without fetch. */
export function sessionHeaders(url: string | URL): Record<string, string> {
  const cookie = cookies.get(new URL(url).origin);
  return cookie ? { Cookie: cookie } : {};
}

/** fetch, with the session cookie on every request to a controller this module signed in to. */
export function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('cookie') && !headers.has('x-perpetual-secret')) for (const [name, value] of Object.entries(sessionHeaders(input))) headers.set(name, value);
  return globalThis.fetch(input, { ...init, headers });
}
