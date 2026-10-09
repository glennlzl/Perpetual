import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsumerConnections } from '../src/connectors/consumer.ts';
import { consumerFixture } from './fixtures/consumer-oauth.ts';
import { createConnectorManager } from '../src/connectors/manager.ts';

test('concurrent account verification shares one read but a queued removal supersedes it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-connector-shared-')), f = consumerFixture();
  const barrier = () => {
    let release!: () => void, receive!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { receive = resolve; });
    return { held, started, release, receive };
  };
  let gate: ReturnType<typeof barrier> | undefined;
  const manager = await createConnectorManager({ dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', consumerTransport: async (input, init) => {
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (gate && body.method === 'tools/call' && body.params?.arguments?.toolkits?.[0]?.action === 'list') { gate.receive(); await gate.held; }
    return f.transport(input, init);
  } });
  t.after(async () => { gate?.release(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const signIn = new URL((await manager.start({ provider: 'gmail' })).apps.find(app => app.provider === 'gmail')!.account!.redirectUrl!);
  await manager.complete({ code: 'fixture-code', state: signIn.searchParams.get('state') });
  const lists = () => f.calls.filter(call => (call.args?.toolkits as { action?: string }[] | undefined)?.[0]?.action === 'list').length;
  const before = lists(); gate = barrier();
  const first = manager.read(); await gate.started;
  const second = manager.read(); gate.release(); await Promise.all([first, second]);
  assert.equal(lists(), before + 1, 'Concurrent pages must not queue duplicate remote verification');
  gate = barrier(); const older = manager.read(); await gate.started;
  const removal = manager.remove({ provider: 'gmail' });
  const afterRemoval = manager.read(); gate.release();
  await older; await removal;
  assert.equal((await afterRemoval).apps.find(app => app.provider === 'gmail')!.account, null, 'Reads requested after a mutation must observe that mutation');
});

test('HTTP connector snapshots do not wait for held remote verification', async t => {
  const { startServer, fetch: controllerFetch } = await import('./fixtures/controller.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-connector-snapshot-')), f = consumerFixture();
  let hold = false, release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { received = resolve; });
  const transport: typeof fetch = async (input, init) => {
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (hold && body.method === 'tools/call' && body.params?.arguments?.toolkits?.[0]?.action === 'list') { received(); await held; }
    return f.transport(input, init);
  };
  const app = await startServer({ port: 0, dataDir, connectors: { consumerTransport: transport } });
  const reads: Promise<Response>[] = [];
  t.after(async () => { release(); await Promise.allSettled(reads); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { token } = await (await controllerFetch(app.url + '/api/session')).json() as { token: string };
  const start = await controllerFetch(app.url + '/api/connectors/start', { method: 'POST', headers: { 'X-Perpetual-Token': token, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'gmail' }) });
  const signIn = new URL((await start.json()).apps.find((app: { provider: string }) => app.provider === 'gmail').account.redirectUrl);
  await controllerFetch(app.url + '/connectors/oauth/callback?code=fixture-code&state=' + signIn.searchParams.get('state'), { redirect: 'manual' });
  hold = true;
  reads.push(controllerFetch(app.url + '/api/connectors')); await started;
  const cached = controllerFetch(app.url + '/api/connectors?cached=1'); reads.push(cached);
  const response = await Promise.race([cached, new Promise<undefined>(resolve => setTimeout(resolve, 250))]);
  assert.ok(response, 'Initial local account state must return without waiting for vendor verification');
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.apps.find((app: { provider: string }) => app.provider === 'gmail').account.checking, true);
  assert.ok(!JSON.stringify(snapshot).includes('private_fixture_bearer'));
  release(); await reads[0];
  const verified = await (await controllerFetch(app.url + '/api/connectors?cached=1')).json();
  assert.equal(verified.apps.find((app: { provider: string }) => app.provider === 'gmail').account.status, 'pending');
});

test('browser snapshots retain bindings without claiming stale or restarted authorization', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-cache-')), f = consumerFixture();
  const options = { dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport: f.transport };
  let manager = await createConsumerConnections(options);
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const signIn = new URL((await manager.start('gmail'))!);
  await manager.complete({ code: 'fixture-code', state: signIn.searchParams.get('state') });
  f.accounts[0].status = 'ACTIVE'; await manager.read();
  assert.equal(manager.snapshot().gmail?.status, 'connected');
  assert.equal(manager.snapshot().gmail?.checking, undefined);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 30_000);
  const before = f.calls.length;
  assert.equal(manager.snapshot().gmail?.checking, true);
  assert.equal(f.calls.length, before, 'Snapshots must never perform remote checks');
  await manager.close(); manager = await createConsumerConnections(options);
  assert.equal(manager.snapshot().gmail?.checking, true);
  assert.equal(manager.snapshot().gmail?.status, 'unverified');
  f.accounts[0].status = 'FAILED';
  assert.equal((await manager.read()).gmail?.status, 'needs-auth');
  assert.equal(manager.snapshot().gmail?.checking, undefined);
  await manager.remove('gmail');
  assert.deepEqual(manager.snapshot(), {});
  await manager.start('gmail');
  assert.equal(manager.snapshot().gmail?.checking, true, 'A new binding cannot reuse the previous account observation');
});

test('a snapshot cannot keep Connected after another operation discovers revoked authorization', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-consumer-revoked-')), f = consumerFixture();
  const manager = await createConsumerConnections({ dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport: f.transport });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const signIn = new URL((await manager.start('gmail'))!);
  await manager.complete({ code: 'fixture-code', state: signIn.searchParams.get('state') });
  f.accounts[0].status = 'ACTIVE'; await manager.read();
  assert.equal(manager.snapshot().gmail?.status, 'connected');
  f.flags = { expired: true }; await assert.rejects(manager.options('gmail'), /Sign in again/);
  assert.notEqual(manager.snapshot().gmail?.status, 'connected');
});

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
