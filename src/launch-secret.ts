// The launch secret every API request needs. The controller keeps it in its data directory, created once and reused
// across restarts, and a local tool or agent reads the file and sends the secret in a header. A browser never holds it:
// the launch link `serve` prints carries a browser secret derived from it, in the link's fragment, which a browser never
// sends to a server. The page keeps that secret in its own origin's storage and sends it in a header of its own. Neither
// is ever a cookie, since a browser sends a host's cookies to every port on it, a twin's app included.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateFile, writeStateFile } from './store.ts';

/** The header a local tool sends the launch secret in. */
export const SECRET_HEADER = 'x-perpetual-secret';
/** The header the page sends its browser secret in. */
export const BROWSER_HEADER = 'x-perpetual-browser-secret';
const FILE = 'launch-secret', SECRET = /^[0-9a-f]{64}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();
/** Whether a request's value is the one `expected` digests: compared in constant time, and anything else, or nothing, is not. */
const same = (value: unknown, expected: Buffer) => typeof value === 'string' && timingSafeEqual(digest(value), expected);

/** The data directory's launch secret, kept in a 0600 file and created when there is none; a file holding anything else is refused. */
export async function launchSecret(dataDir: string) {
  const file = join(dataDir, FILE), invalid = `Cannot read the launch secret; remove ${file} to create a new one.`;
  const saved = (await readPrivateFile(file, { limit: 1024, invalid }))?.trim();
  if (saved !== undefined && !SECRET.test(saved)) throw new Error(invalid);
  const secret = saved ?? randomBytes(32).toString('hex');
  if (saved === undefined) await writeStateFile(file, secret, { prefix: '.launch-secret-' });
  else await chmod(file, 0o600);
  // The page's own secret: it lasts as long as the launch secret, so a printed link stays valid, but it is not the launch
  // secret, so a copy taken from the browser never passes as a local tool's, which needs no session token.
  const browser = createHmac('sha256', secret).update('perpetual browser secret').digest('hex');
  const expected = digest(secret), browserExpected = digest(browser);
  return {
    /** Whether a request's value is the launch secret, which a local tool sends. */
    matches: (value: unknown) => same(value, expected),
    /** Whether a request's value is the browser secret, which the page sends. */
    signedIn: (value: unknown) => same(value, browserExpected),
    /** The launch link of the controller at `url`: the browser secret rides in its fragment, which the page reads and drops. */
    link: (url: string) => `${url}/#secret=${browser}`,
  };
}
