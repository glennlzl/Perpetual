import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type Controller } from '../src/server.ts';

// Every API request needs the controller's launch secret: the session cookie its launch link sets in a browser, or the
// header a local tool sends with the secret its data directory keeps. These requests use the global fetch, which sends
// neither unless a test adds one.
const json = { 'Content-Type': 'application/json' };

/** A controller over an empty checkout, with its secret file and a restart over the same data directory. */
async function controller(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-')), dataDir = join(dir, 'data');
  let app: Controller = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, dataDir, file: join(dataDir, 'launch-secret'), app: () => app,
    async restart() { await app.close(); app = await startServer({ port: 0, repo: dir, dataDir }); return app; } };
}

/** Opens a launch link without following its redirect: its reply, the cookies it sets and the session cookie to send back. */
async function launch(url: string) {
  const response = await fetch(url, { redirect: 'manual' }), cookies = response.headers.getSetCookie();
  return { response, cookies, cookie: cookies[0]?.split(';')[0] ?? '' };
}

test('the launch secret is kept in a 0600 file in the data directory, created once and reused across restarts', async t => {
  const f = await controller(t), secret = await readFile(f.file, 'utf8');
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal(f.app().launchUrl, `${f.app().url}/?secret=${secret}`);
  await chmod(f.file, 0o644);
  const restarted = await f.restart();
  assert.equal(restarted.launchUrl, `${restarted.url}/?secret=${secret}`, 'A restart keeps the secret, so the printed link stays valid.');
  assert.equal(await readFile(f.file, 'utf8'), secret);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600, 'A restart keeps the file private.');
});

test('a launch secret file that holds anything else is refused, and removing it makes a new secret', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-file-')), dataDir = join(dir, 'data'), file = join(dataDir, 'launch-secret');
  let app: Controller | undefined = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const first = await readFile(file, 'utf8');
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
});

test('without the session cookie or the secret, the API refuses reads, the session token and changes alike', async t => {
  const f = await controller(t), { url, launchUrl } = f.app();
  const { cookie } = await launch(launchUrl);
  const { token } = await (await fetch(`${url}/api/session`, { headers: { Cookie: cookie } })).json();
  const stale = cookie.replace(/=.*/, `=${'0'.repeat(64)}`);
  for (const headers of [{}, { Cookie: stale }, { 'X-Perpetual-Secret': '0'.repeat(64) }] as Record<string, string>[]) {
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

test('the launch link sets an HttpOnly, SameSite=Strict session cookie and redirects to the page without the secret', async t => {
  const f = await controller(t), { url, launchUrl } = f.app(), secret = await readFile(f.file, 'utf8');
  const { response, cookies, cookie } = await launch(launchUrl);
  assert.deepEqual([response.status, response.headers.get('location')], [303, '/']);
  assert.equal(cookies.length, 1);
  const [, ...attributes] = cookies[0].split(';').map(part => part.trim());
  assert.equal(cookie.slice(cookie.indexOf('=') + 1), secret);
  assert.deepEqual(attributes.sort(), ['HttpOnly', 'Path=/api', 'SameSite=Strict']);
  // The cookie reads, and a change from the page still carries the page's session token.
  assert.equal((await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  const { token } = await (await fetch(`${url}/api/session`, { headers: { Cookie: cookie } })).json();
  const scan = (headers: Record<string, string>) => fetch(`${url}/api/scan`, { method: 'POST', headers: { Cookie: cookie, ...json, ...headers }, body: JSON.stringify({ path: f.dir }) });
  assert.equal((await scan({})).status, 403);
  assert.equal((await scan({ 'X-Perpetual-Token': token })).status, 200);
  // The address keeps its other parameters, and a wrong or outdated secret sets no cookie.
  const other = await launch(`${url}/?watch=browser&secret=${'0'.repeat(64)}&stage=beta`);
  assert.deepEqual([other.response.status, other.response.headers.get('location'), other.cookies], [303, '/?watch=browser&stage=beta', []]);
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
