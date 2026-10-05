import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type Controller } from '../src/server.ts';

// Every API request needs the controller's launch secret, which a local tool sends from the file its data directory
// keeps, or the browser secret derived from it, which the launch link gives the page. These requests use the global
// fetch, which sends neither unless a test adds one.
const json = { 'Content-Type': 'application/json' };

/** A controller over an empty checkout, with its secret file and a restart over the same data directory. */
async function controller(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-')), dataDir = join(dir, 'data');
  let app: Controller = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, dataDir, file: join(dataDir, 'launch-secret'), app: () => app,
    async restart() { await app.close(); app = await startServer({ port: 0, repo: dir, dataDir }); return app; } };
}

/** The browser secret a launch link carries in its fragment, which a browser never sends to a server. */
function browserSecret(launchUrl: string) {
  const link = new URL(launchUrl), secret = /^#secret=([0-9a-f]{64})$/.exec(link.hash)?.[1];
  assert.deepEqual([link.pathname, link.search, typeof secret], ['/', '', 'string'], launchUrl);
  return secret!;
}

test('the launch secret is kept in a 0600 file in the data directory, created once and reused across restarts', async t => {
  const f = await controller(t), secret = await readFile(f.file, 'utf8');
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const browser = browserSecret(f.app().launchUrl);
  assert.notEqual(browser, secret, 'The link carries a secret of its own, never the launch secret.');
  await chmod(f.file, 0o644);
  const restarted = await f.restart();
  assert.equal(browserSecret(restarted.launchUrl), browser, 'A restart keeps the secret, so the printed link stays valid.');
  assert.equal(await readFile(f.file, 'utf8'), secret);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600, 'A restart keeps the file private.');
});

test('a launch secret file that holds anything else is refused, and removing it makes a new secret', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-file-')), dataDir = join(dir, 'data'), file = join(dataDir, 'launch-secret');
  let app: Controller | undefined = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const first = await readFile(file, 'utf8'), firstBrowser = browserSecret(app.launchUrl);
  await app.close(); app = undefined;
  await writeFile(join(dir, 'elsewhere'), first);
  for (const replace of [() => writeFile(file, 'password'), () => symlink(join(dir, 'elsewhere'), file)]) {
    await rm(file); await replace();
    await assert.rejects(startServer({ port: 0, repo: dir, dataDir }), /^Error: Cannot read the launch secret; remove .+launch-secret to create a new one\.$/);
  }
  await rm(file);
  app = await startServer({ port: 0, repo: dir, dataDir });
  const second = await readFile(file, 'utf8');
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(second, first);
  assert.notEqual(browserSecret(app.launchUrl), firstBrowser, 'A new secret signs out the browsers the old link signed in.');
});

test('without the browser secret or the launch secret, the API refuses reads, the session token and changes alike', async t => {
  const f = await controller(t), { url, launchUrl } = f.app(), secret = await readFile(f.file, 'utf8'), browser = browserSecret(launchUrl);
  const { token } = await (await fetch(`${url}/api/session`, { headers: { 'X-Perpetual-Browser-Secret': browser } })).json();
  const other = '0'.repeat(64);
  const refused: Record<string, string>[] = [
    {}, { 'X-Perpetual-Browser-Secret': other }, { 'X-Perpetual-Secret': other },
    // Each secret counts in its own header only, and neither in a cookie, which a browser sends to every port on the host.
    { 'X-Perpetual-Secret': browser }, { 'X-Perpetual-Browser-Secret': secret },
    { Cookie: `perpetual-secret-${new URL(url).port}=${secret}; perpetual-browser-secret=${browser}` },
  ];
  for (const headers of refused) {
    const sent = JSON.stringify(headers);
    for (const path of ['/api/state', '/api/session', '/api/settings/model', `/api/github-actions?${new URLSearchParams({ repoPath: f.dir })}`, '/api', '/api/missing']) {
      const response = await fetch(url + path, { headers });
      assert.equal(response.status, 401, `GET ${path} with ${sent}`);
      assert.match((await response.json()).error, /^Open the link perpetual serve printed/);
    }
    // The page's session token is no session of its own, whatever the method.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${url}/api/scan`, { method, headers: { ...headers, ...json, 'X-Perpetual-Token': token }, body: JSON.stringify({ path: f.dir }) });
      assert.equal(response.status, 401, `${method} /api/scan with ${sent}`);
    }
  }
  await assert.rejects(stat(join(f.dataDir, 'state.json')), { code: 'ENOENT' }, 'No refused change saved anything.');
  // The interface itself holds no secret and stays public.
  for (const [path, status] of [['/', 200], ['/assets/brand/perpetual-mark-small-light.svg', 200], ['/favicon.ico', 204]] as const) {
    assert.equal((await fetch(url + path)).status, status, path);
  }
});

test('the launch link signs a page in through its fragment, with no cookie, and the page\'s changes still carry its session token', async t => {
  const f = await controller(t), { url, launchUrl } = f.app(), secret = await readFile(f.file, 'utf8'), browser = browserSecret(launchUrl);
  assert.notEqual(browser, secret);
  // A browser asks for the page alone, without the fragment, and the controller sets no cookie.
  const page = await fetch(`${url}/`);
  assert.deepEqual([page.status, page.headers.getSetCookie()], [200, []]);
  const headers = { 'X-Perpetual-Browser-Secret': browser };
  assert.equal((await fetch(`${url}/api/state`, { headers })).status, 200);
  const { token } = await (await fetch(`${url}/api/session`, { headers })).json();
  const scan = (sent: Record<string, string>) => fetch(`${url}/api/scan`, { method: 'POST', headers: { ...json, ...sent }, body: JSON.stringify({ path: f.dir }) });
  assert.equal((await scan(headers)).status, 403, 'A change from the page also needs its session token.');
  assert.equal((await scan({ ...headers, 'X-Perpetual-Token': token })).status, 200);
  // A copy of the browser secret never passes as the launch secret, which needs no session token.
  assert.equal((await scan({ 'X-Perpetual-Secret': browser })).status, 401);
});

test('a local tool reads and changes with the secret from the data directory, within the same-origin checks', async t => {
  const f = await controller(t), { url } = f.app(), headers = { 'X-Perpetual-Secret': await readFile(f.file, 'utf8') };
  assert.equal((await fetch(`${url}/api/state`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/api/scan`, { method: 'POST', headers: { ...headers, ...json }, body: JSON.stringify({ path: f.dir }) })).status, 200, 'The secret needs no page token.');
  assert.notEqual((await (await fetch(`${url}/api/state`, { headers })).json()).scan, null);
  for (const other of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'same-site' }] as Record<string, string>[]) {
    assert.equal((await fetch(`${url}/api/state`, { headers: { ...headers, ...other } })).status, 403, JSON.stringify(other));
  }
});
