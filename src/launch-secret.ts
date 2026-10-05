// The launch secret every API request needs. The controller keeps it in its data directory, created once and reused
// across restarts. `serve` prints a launch link that carries it, and opening the link exchanges it for the browser's
// session cookie, HttpOnly and SameSite=Strict. A local tool or agent reads the file and sends the secret in a header.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateFile, writeStateFile } from './store.ts';

/** The header a local tool sends the secret in. */
export const SECRET_HEADER = 'x-perpetual-secret';
/** The launch link's query parameter that carries the secret. */
export const SECRET_PARAMETER = 'secret';
const FILE = 'launch-secret', SECRET = /^[0-9a-f]{64}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** The data directory's launch secret, kept in a 0600 file and created when there is none; a file holding anything else is refused. */
export async function launchSecret(dataDir: string) {
  const file = join(dataDir, FILE), invalid = `Cannot read the launch secret; remove ${file} to create a new one.`;
  const saved = (await readPrivateFile(file, { limit: 1024, invalid }))?.trim();
  if (saved !== undefined && !SECRET.test(saved)) throw new Error(invalid);
  const secret = saved ?? randomBytes(32).toString('hex');
  if (saved === undefined) await writeStateFile(file, secret, { prefix: '.launch-secret-' });
  else await chmod(file, 0o600);
  const expected = digest(secret);
  /** Whether a request's value is the secret: compared in constant time, and anything else, or nothing, is not. */
  const matches = (value: unknown) => typeof value === 'string' && timingSafeEqual(digest(value), expected);
  // A browser keeps one set of cookies for all of a host's ports, so the name holds the port: controllers on other ports
  // keep their own sessions.
  const name = (port: number | undefined) => `perpetual-secret-${port}`;
  return {
    matches,
    /** The launch link of the controller at `url`. */
    link: (url: string) => `${url}/?${SECRET_PARAMETER}=${secret}`,
    /** The session cookie the launch link sets: HttpOnly, SameSite=Strict and sent to the API only. */
    cookie: (port: number | undefined) => `${name(port)}=${secret}; Path=/api; HttpOnly; SameSite=Strict`,
    /** Whether a request's Cookie header holds the session cookie with the secret. */
    inCookie: (header: unknown, port: number | undefined) => typeof header === 'string' && header.split(';').some(pair => {
      const at = pair.indexOf('=');
      return at > 0 && pair.slice(0, at).trim() === name(port) && matches(pair.slice(at + 1).trim());
    }),
  };
}
