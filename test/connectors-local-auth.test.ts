import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createConnectorManager } from '../src/connectors/manager.ts';
import type { ConnectorsReply, ConnectorProvider } from '../contract/connectors.ts';
import { fetch as controllerFetch, startServer } from './fixtures/controller.ts';

const account = (reply: ConnectorsReply, provider: ConnectorProvider = 'linear') => reply.apps.find(app => app.provider === provider)!.account;
const origin = () => 'http://127.0.0.1:4317';
const env = { PERPETUAL_LINEAR_CLIENT_ID: 'fixture-client' };
function fixture() {
  const calls: { path: string; body: URLSearchParams }[] = [];
  let deny = false, offline = false, challenge = '', hold: Promise<void> | undefined;
  const started = Promise.withResolvers<void>();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ path: url.pathname, body });
    if (offline) throw new Error('transport error containing fixture-private-token');
    if (url.pathname === '/oauth/token') {
      assert.equal(url.origin, 'https://api.linear.app');
      if (deny) return Response.json({ error: 'invalid_grant', error_description: 'fixture-private-token' }, { status: 400 });
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('client_id'), 'fixture-client');
        assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge);
      }
      return Response.json({ access_token: 'fixture-private-access', refresh_token: 'fixture-private-refresh', expires_in: 3600, scope: 'read' });
    }
    assert.equal(url.href, 'https://api.linear.app/graphql');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-private-access');
    if (hold) { started.resolve(); await hold; }
    if (deny) return Response.json({ error: 'invalid_token' }, { status: 401 });
    return Response.json({ data: { viewer: { id: 'user-1', name: 'Example Developer', email: 'developer@example.test' } } });
  };
  return { calls, transport, started, setChallenge(value: string) { challenge = value; }, setDenied(value: boolean) { deny = value; }, setOffline(value: boolean) { offline = value; }, hold(value: Promise<void>) { hold = value; } };
}
async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-direct-oauth-')), f = fixture();
  let manager = await createConnectorManager({ dataDir, env, origin, transport: f.transport });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const start = async () => {
    const url = new URL(account(await manager.start({ provider: 'linear' }))!.redirectUrl!);
    f.setChallenge(url.searchParams.get('code_challenge')!);
    return new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')! });
  };
  return { dataDir, f, get manager() { return manager; }, start, async restart() { await manager.close(); manager = await createConnectorManager({ dataDir, env, origin, transport: f.transport }); return manager; } };
}

test('local auth initializes private SQLite and a stable secret without a provider request', async t => {
  const f = await setup(t);
  assert.equal(f.f.calls.length, 0);
  const files = await readdir(join(f.dataDir, 'connectors'));
  assert.deepEqual(files.sort(), ['auth.json', 'auth.sqlite']);
  for (const file of files) assert.equal((await stat(join(f.dataDir, 'connectors', file))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.dataDir, 'connectors'))).mode & 0o777, 0o700);
  const before = await readFile(join(f.dataDir, 'connectors/auth.json'), 'utf8');
  await f.restart(); assert.equal(await readFile(join(f.dataDir, 'connectors/auth.json'), 'utf8'), before);
  await assert.rejects(f.manager.start({ provider: 'gmail' }), /connector broker/);
  assert.equal(f.f.calls.length, 0);
});

test('Better Auth owns PKCE, links the account, encrypts grants and restores the binding on restart', async t => {
  const f = await setup(t), params = await f.start();
  const pending = account(f.manager.snapshot())!;
  assert.equal(new URL(pending.redirectUrl!).searchParams.get('redirect_uri'), origin() + '/connectors/auth/callback/linear');
  assert.equal(new URL(pending.redirectUrl!).searchParams.get('code_challenge_method'), 'S256');
  assert.equal(account(await f.manager.start({ provider: 'linear' }))!.redirectUrl, pending.redirectUrl, 'An existing attempt is reused.');
  await f.manager.complete('linear', params);
  assert.equal(account(f.manager.snapshot())?.status, 'connected');
  assert.equal(account(f.manager.snapshot())?.label, 'Example Developer');
  const database = new DatabaseSync(join(f.dataDir, 'connectors/auth.sqlite'));
  const stored = database.prepare('SELECT accessToken, refreshToken FROM account').get()!;
  assert.notEqual(stored.accessToken, 'fixture-private-access'); assert.notEqual(stored.refreshToken, 'fixture-private-refresh'); database.close();
  const visible = JSON.stringify(f.manager.snapshot());
  for (const secret of ['fixture-private-access', 'fixture-private-refresh', 'fixture-code', 'cookie', 'codeVerifier']) assert.ok(!visible.includes(secret));
  await assert.rejects(f.manager.complete('linear', params), /expired|match/);
  await f.restart(); assert.equal(account(f.manager.snapshot())?.checking, true);
  assert.equal(account(await f.manager.read())?.status, 'connected');
  await assert.rejects(f.manager.remove({ provider: 'linear', cancel: true }), /Disconnect/);
  const before = f.f.calls.length;
  await f.manager.remove({ provider: 'linear' }); assert.equal(account(f.manager.snapshot()), null);
  assert.equal(f.f.calls.length, before, 'Disconnect cleans local credentials without remote revocation.');
});

test('wrong, repeated, cancelled and expired callbacks cannot exchange credentials', async t => {
  const f = await setup(t), params = await f.start();
  await assert.rejects(f.manager.complete('gmail', params), /connection service/);
  const duplicate = new URLSearchParams(params); duplicate.append('state', params.get('state')!);
  await assert.rejects(f.manager.complete('linear', duplicate), /expired|match/);
  const wrong = new URLSearchParams(params); wrong.set('state', 'wrong');
  await assert.rejects(f.manager.complete('linear', wrong), /expired|match/);
  assert.equal(f.f.calls.length, 0);
  await f.manager.remove({ provider: 'linear', cancel: true });
  await assert.rejects(f.manager.complete('linear', params), /expired|match/);
  const cancelled = await f.start(); cancelled.set('error', 'access_denied'); cancelled.delete('code');
  await assert.rejects(f.manager.complete('linear', cancelled), /could not finish/);
  assert.equal(account(f.manager.snapshot())?.status, 'needs-auth'); assert.equal(f.f.calls.length, 0);
  await f.start(); await f.manager.close();
  const path = join(f.dataDir, 'connectors/auth.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.accounts.linear.pending.createdAt -= 11 * 60_000; await writeFile(path, JSON.stringify(saved));
  await f.restart(); assert.equal(account(f.manager.snapshot())?.status, 'needs-auth');
  assert.equal(f.f.calls.length, 0);
});

test('pending sign-in resumes across a restart but an uncertain exchange is never replayed', async t => {
  const f = await setup(t), params = await f.start();
  await f.restart(); assert.equal(account(f.manager.snapshot())?.status, 'pending');
  await f.manager.complete('linear', params); assert.equal(account(f.manager.snapshot())?.status, 'connected');
  await f.manager.remove({ provider: 'linear' }); await f.start(); await f.manager.close();
  const path = join(f.dataDir, 'connectors/auth.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.accounts.linear.pending.exchanging = true; await writeFile(path, JSON.stringify(saved));
  const count = f.f.calls.length; await f.restart(); await f.manager.read();
  assert.equal(f.f.calls.length, count); assert.equal(account(f.manager.snapshot())?.status, 'needs-auth');
});

test('expired tokens refresh through Better Auth; outages and revoked grants stay distinct', async t => {
  const f = await setup(t); await f.manager.complete('linear', await f.start());
  const expire = () => { const db = new DatabaseSync(join(f.dataDir, 'connectors/auth.sqlite')); db.prepare('UPDATE account SET accessTokenExpiresAt = ?').run(Date.now() - 10_000); db.close(); };
  expire(); await f.manager.read('linear');
  assert.ok(f.f.calls.some(call => call.body.get('grant_type') === 'refresh_token'));
  assert.equal(account(f.manager.snapshot())?.status, 'connected');
  expire(); f.f.setOffline(true); await f.manager.read('linear');
  assert.equal(account(f.manager.snapshot())?.status, 'unverified');
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes('fixture-private'));
  f.f.setOffline(false); f.f.setDenied(true); await f.manager.read('linear');
  assert.equal(account(f.manager.snapshot())?.status, 'needs-auth');
});

test('slow verification does not block snapshots and simultaneous reads share one check', async t => {
  const f = await setup(t); await f.manager.complete('linear', await f.start()); await f.restart();
  const release = Promise.withResolvers<void>(); f.f.hold(release.promise);
  const calls = f.f.calls.length, first = f.manager.read(), second = f.manager.read();
  await f.f.started.promise;
  assert.equal(account(f.manager.snapshot())?.checking, true);
  assert.equal(f.f.calls.length, calls + 1);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(account(f.manager.snapshot())?.status, 'connected');
});

test('an expired grant without a refresh token requires sign-in rather than appearing temporarily unavailable', async t => {
  const f = await setup(t); await f.manager.complete('linear', await f.start());
  const db = new DatabaseSync(join(f.dataDir, 'connectors/auth.sqlite'));
  db.prepare('UPDATE account SET accessTokenExpiresAt = ?, refreshToken = NULL').run(Date.now() - 10_000); db.close();
  const count = f.f.calls.length;
  await f.manager.read('linear');
  assert.equal(account(f.manager.snapshot())?.status, 'needs-auth');
  assert.equal(f.f.calls.length, count);
});

test('missing secrets and redirected database files are refused without overwriting outside files', async t => {
  const f = await setup(t); await f.manager.close();
  await rm(join(f.dataDir, 'connectors/auth.json'));
  await assert.rejects(createConnectorManager({ dataDir: f.dataDir, origin, env }), /Restore auth.json/);
  await rm(join(f.dataDir, 'connectors/auth.sqlite'));
  const outside = join(f.dataDir, 'outside'); await writeFile(outside, 'keep'); await symlink(outside, join(f.dataDir, 'connectors/auth.sqlite'));
  await assert.rejects(createConnectorManager({ dataDir: f.dataDir, origin, env }), /Restore auth.json/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('controller exposes only the guarded callback, never Better Auth token or session routes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-auth-http-')), f = fixture();
  const app = await startServer({ port: 0, dataDir, connectors: { env, transport: f.transport } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await globalThis.fetch(app.url + '/api/connectors')).status, 401);
  assert.equal((await globalThis.fetch(app.url + '/api/connectors', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const { token } = await (await controllerFetch(app.url + '/api/session')).json();
  const post = (path: string, data: unknown) => controllerFetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-perpetual-token': token }, body: JSON.stringify(data) });
  assert.equal((await controllerFetch(app.url + '/api/connectors/start', { method: 'POST', body: '{}' })).status, 403);
  for (const route of ['/api/connectors/setup', '/api/connectors/options', '/api/connectors/browser', '/connectors/auth/local-owner', '/connectors/auth/get-access-token']) assert.equal((await post(route, {})).status, 404, route);
  const started = await post('/api/connectors/start', { provider: 'linear' });
  assert.equal(started.headers.get('set-cookie'), null);
  const url = new URL(account(await started.json())!.redirectUrl!); f.setChallenge(url.searchParams.get('code_challenge')!);
  const callback = new URL(url.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', url.searchParams.get('state')!);
  const completed = await globalThis.fetch(callback, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal(completed.status, 200);
  assert.match(completed.headers.get('content-type')!, /^text\/html; charset=utf-8$/);
  assert.equal(completed.headers.get('cache-control'), 'no-store');
  assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
  assert.match(completed.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(completed.headers.get('set-cookie'), null);
  const page = await completed.text();
  assert.match(page, /<title>Connected<\/title>/);
  assert.match(page, /You can close this tab\./);
  assert.doesNotMatch(page, /<script|<link|href=|src=/i);
  assert.doesNotMatch(page, /fixture-code|state=|fixture-private/);
  assert.equal((await globalThis.fetch(app.url + '/', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await globalThis.fetch(app.url + '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const visible = await (await controllerFetch(app.url + '/api/connectors?cached=1')).text();
  assert.ok(visible.includes('connected')); assert.ok(!visible.includes('fixture-private'));
  assert.equal((await globalThis.fetch(callback, { redirect: 'manual' })).status, 400);
});

test('Slack public-client authorization returns through localhost and exchanges the same redirect URI', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-slack-http-'));
  let redirect = '', challenge = '', exchanges = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://slack.com');
    if (url.pathname === '/api/oauth.v2.access') {
      exchanges++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('redirect_uri'), redirect);
      assert.equal(body.get('client_secret'), null);
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge);
      return Response.json({ ok: true, authed_user: { id: 'U123', token_type: 'user', access_token: 'fixture-slack-private', scope: 'users:read,users:read.email' } });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-slack-private');
    if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' });
    assert.equal(url.pathname, '/api/users.info');
    return Response.json({ ok: true, user: { id: 'U123', team_id: 'T123', real_name: 'Example Developer', profile: { email: 'developer@example.test' } } });
  };
  const app = await startServer({ port: 0, dataDir, connectors: { env: { PERPETUAL_SLACK_CLIENT_ID: 'fixture-slack-client' }, transport } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { token } = await (await controllerFetch(app.url + '/api/session')).json();
  const started = await controllerFetch(app.url + '/api/connectors/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-perpetual-token': token }, body: JSON.stringify({ provider: 'slack' }) });
  const url = new URL(account(await started.json(), 'slack')!.redirectUrl!);
  assert.equal(url.searchParams.get('scope'), '');
  redirect = url.searchParams.get('redirect_uri')!; challenge = url.searchParams.get('code_challenge')!;
  const callback = new URL(redirect);
  assert.equal(callback.hostname, 'localhost'); assert.equal(callback.port, new URL(app.url).port);
  callback.searchParams.set('code', 'fixture-slack-code'); callback.searchParams.set('state', url.searchParams.get('state')!);
  const wrongHost = new URL(callback); wrongHost.hostname = '127.0.0.1';
  assert.equal((await globalThis.fetch(wrongHost, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' })).status, 403);
  assert.equal(exchanges, 0);
  const completed = await globalThis.fetch(callback, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal(completed.status, 200); assert.equal(completed.headers.get('location'), null);
  assert.equal(completed.headers.get('set-cookie'), null); assert.equal(exchanges, 1);
  assert.equal(completed.headers.get('cache-control'), 'no-store');
  assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
  const completionPage = await completed.text();
  assert.match(completionPage, /<title>Connected<\/title>/);
  assert.match(completionPage, /You can close this tab\./);
  assert.doesNotMatch(completionPage, /<script|<link|href=|src=|fixture-slack-code|state=/i);
  assert.equal((await globalThis.fetch(app.url + '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const visible = await (await controllerFetch(app.url + '/api/connectors?cached=1')).json();
  assert.equal(account(visible, 'slack')?.status, 'connected');
});
