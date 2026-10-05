import { startServer as start, type Controller, type ServerOptions } from '../../src/server.ts';

// Every API request needs the controller's launch secret. A test that calls the API starts its controller here, which
// takes the browser secret from its launch link as the page does, and imports this module's `fetch` in place of the
// global one: it sends that secret with every request to that controller, so each request goes out as the page's would.
// A request that sets its own X-Perpetual-Browser-Secret or X-Perpetual-Secret header is sent as it is, and the global
// fetch sends neither.
const secrets = new Map<string, string>();

/** Takes the browser secret from a controller's launch link, as the page does, and keeps it for that controller. */
export function signIn(launchUrl: string) {
  const link = new URL(launchUrl), secret = /^#secret=([0-9a-f]{64})$/.exec(link.hash)?.[1];
  if (!secret) throw new Error('The launch link carries no browser secret.');
  secrets.set(link.origin, secret);
}

/** A controller started as src/server.ts starts one, and signed in through its launch link. */
export async function startServer(options?: ServerOptions): Promise<Controller> {
  const app = await start(options);
  try { signIn(app.launchUrl); } catch (error) { await app.close(); throw error; }
  return app;
}

/** The browser secret of the controller at `url`, as headers for a request sent without fetch. */
export function sessionHeaders(url: string | URL): Record<string, string> {
  const secret = secrets.get(new URL(url).origin);
  return secret ? { 'X-Perpetual-Browser-Secret': secret } : {};
}

/** fetch, with the browser secret on every request to a controller this module signed in to. */
export function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('x-perpetual-browser-secret') && !headers.has('x-perpetual-secret')) for (const [name, value] of Object.entries(sessionHeaders(input))) headers.set(name, value);
  return globalThis.fetch(input, { ...init, headers });
}
