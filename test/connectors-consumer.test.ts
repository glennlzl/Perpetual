import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsumerConnections } from '../src/connectors/consumer.ts';
import { consumerFixture } from './fixtures/consumer-oauth.ts';

test('consumer authorization and account binding survive restart; reads cannot add accounts and disconnect stays local', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-')), f = consumerFixture();
  const options = { dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport: f.transport };
  let manager = await createConsumerConnections(options);
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual(await manager.read(), {}); assert.deepEqual(await manager.options('slack'), []); assert.equal(f.calls.length, 0);
  const signIn = new URL((await manager.start('slack'))!); assert.equal((await manager.read()).slack?.status, 'pending');
  await manager.close(); manager = await createConsumerConnections(options);
  await assert.rejects(manager.complete({ code: 'fixture-code', state: 'bad-state' }), /does not match/); assert.equal(f.accounts.length, 0);
  assert.equal(await manager.complete({ code: 'fixture-code', state: signIn.searchParams.get('state') }), 'https://connect.composio.dev/link/ln_fixture');
  assert.equal(f.accounts.length, 1); assert.equal((await manager.read()).slack?.status, 'pending');
  assert.equal(await manager.start('slack'), 'https://connect.composio.dev/link/ln_fixture');
  assert.equal(f.calls.filter(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'add').length, 1);
  f.accounts[0].status = 'ACTIVE'; f.accounts[0].alias = 'private_fixture_bearer';
  assert.equal((await manager.read()).slack?.status, 'connected');
  await assert.rejects(manager.remove('slack', true), /completed/);
  assert.ok(!JSON.stringify(await manager.options('slack')).includes('private_fixture_bearer'));
  f.flags = { failRead: true }; const view = await manager.read(); assert.equal(view.slack?.status, 'unverified'); assert.ok(!JSON.stringify(view).includes('private_fixture_bearer'));
  f.flags = { failRead: false, expired: true }; assert.equal((await manager.read()).slack?.status, 'unverified');
  assert.deepEqual(await manager.options('slack'), []);
  const again = new URL((await manager.start('slack'))!); assert.equal(again.origin, 'https://connect.composio.dev'); assert.equal((await manager.read()).slack?.status, 'pending');
  await manager.remove('slack'); assert.deepEqual(await manager.read(), {}); assert.equal(f.accounts.length, 1);
  assert.equal(f.calls.filter(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'add').length, 1); assert.ok(!f.calls.some(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'remove'));
});

test('lost consumer add replies hold their intent; an incompatible list schema cannot trigger a write', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-held-')), f = consumerFixture();
  const options = { dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport: f.transport };
  let manager = await createConsumerConnections(options);
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const signIn = new URL((await manager.start('gmail'))!); f.flags = { lostAdd: true };
  await assert.rejects(manager.complete({ state: signIn.searchParams.get('state'), code: 'fixture-code' }));
  await manager.close(); manager = await createConsumerConnections(options);
  assert.equal((await manager.read()).gmail?.status, 'unverified'); await assert.rejects(manager.start('gmail'), /pending/);
  assert.equal(f.calls.filter(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'add').length, 1);
  f.flags = { supportsList: false }; await assert.rejects(manager.start('jira'), /unavailable/);
  assert.equal(f.calls.filter(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'add').length, 1);
  assert.ok((await readFile(join(dataDir, 'connectors/browser-connections.json'), 'utf8')).includes('initiating'));
});

test('OAuth callback alone accepts cross-site navigation; protected API routes still require the launch session', async t => {
  const { startServer, fetch: controllerFetch } = await import('./fixtures/controller.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-http-')), f = consumerFixture();
  const app = await startServer({ port: 0, dataDir, connectors: { consumerTransport: f.transport } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await globalThis.fetch(app.url + '/api/connectors')).status, 401);
  assert.equal((await globalThis.fetch(app.url + '/api/connectors', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const { token } = await (await controllerFetch(app.url + '/api/session')).json() as { token: string };
  const post = (path: string, body: unknown) => controllerFetch(app.url + path, { method: 'POST', headers: { 'X-Perpetual-Token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const started = await post('/api/connectors/start', { provider: 'jira' }); const view = await started.json(); const signIn = new URL(view.apps.find((a: { provider: string }) => a.provider === 'jira').account.redirectUrl);
  const callback = new URL(app.url + '/connectors/oauth/callback'); callback.searchParams.set('state', signIn.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code');
  const request = (url: string) => globalThis.fetch(url, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal((await request(callback.href + '&state=duplicate')).status, 400); assert.equal(f.accounts.length, 0);
  const completed = await request(callback.href); assert.equal(completed.status, 302); assert.equal(completed.headers.get('location'), 'https://connect.composio.dev/link/ln_fixture');
  assert.equal(completed.headers.get('referrer-policy'), 'no-referrer'); assert.equal(f.accounts.length, 1);
  assert.equal((await request(callback.href)).status, 400); assert.equal(f.accounts.length, 1);
  const data = await (await controllerFetch(app.url + '/api/connectors')).text(); assert.ok(!data.includes('private_fixture_bearer')); assert.ok(!data.includes('client_fixture'));
});

test('browser-owned recovery stays in browser mode after optional project setup and restarts a verified failed app flow', async t => {
  const { createConnectorManager } = await import('../src/connectors/manager.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-method-')), f = consumerFixture();
  const manager = await createConnectorManager({ dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', consumerTransport: f.transport, transport: async () => new Response(JSON.stringify({ items: [] })) });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const started = await manager.start({ provider: 'gmail' }); const signIn = new URL(started.apps.find(a => a.provider === 'gmail')!.account!.redirectUrl!);
  await manager.complete({ code: 'fixture-code', state: signIn.searchParams.get('state') });
  f.accounts[0].status = 'ACTIVE'; await manager.setup({ apiKey: 'fixture_project_key' });
  const view = await manager.read(); assert.equal(view.method, 'project'); assert.equal(view.apps.find(a => a.provider === 'gmail')!.account!.method, 'browser');
  const options = await manager.options({ provider: 'gmail' }); assert.equal(options.accounts?.length, 1); assert.deepEqual(options.configs, []);
  await manager.start({ provider: 'gmail', accountId: f.accounts[0].id });
  f.accounts[0].status = 'FAILED'; assert.equal((await manager.read()).apps.find(a => a.provider === 'gmail')!.account!.status, 'needs-auth');
  const reconnected = await manager.start({ provider: 'gmail' }); assert.equal(reconnected.apps.find(a => a.provider === 'gmail')!.account!.status, 'pending');
  assert.equal(f.calls.filter(c => (c.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'add').length, 2);
  assert.equal(f.accounts[0].status, 'FAILED'); assert.equal(f.accounts.length, 2);
});
