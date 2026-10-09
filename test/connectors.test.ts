import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorManager } from '../src/connectors/manager.ts';
import type { ConnectorProvider } from '../contract/connectors.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-connectors-'));
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const close of cleanup) await close(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const calls: { path: string; method: string }[] = [], accounts = new Map<string, Record<string, unknown>>();
  const managedConfigs = new Map<string, { id: string; name: string }>();
  let linkReplyLost = false, rejected = false, readFailure = false, removeFailure = false, wrongOwner = false, unsafeLink = false, emptyConfigs = false, configReplyLost = false, configNotCreated = false, configDenied = false, disabledConfigs = false, unsupportedManaged = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method || 'GET'; calls.push({ path: url.pathname, method });
    assert.equal(url.origin, 'https://backend.composio.dev'); assert.equal(new Headers(init?.headers).get('x-api-key'), 'fixture-key');
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.pathname.includes('/toolkits/')) return response({ composio_managed_auth_schemes: unsupportedManaged ? [] : ['OAUTH2'] });
    if (url.pathname.endsWith('/auth_configs')) {
      if (rejected) return response({ api_key: 'fixture-key' }, 401);
      if (method === 'POST') {
        if (configDenied) return response({}, 403);
        const body = JSON.parse(String(init?.body)) as { toolkit: { slug: string }; auth_config: { type: string; name: string } };
        assert.equal(body.auth_config.type, 'use_composio_managed_auth');
        const config = { id: `ac_${body.toolkit.slug}`, name: body.auth_config.name }; if (!configNotCreated) managedConfigs.set(body.toolkit.slug, config);
        if (configReplyLost) throw new Error('Creation reply was lost');
        return response({ toolkit: { slug: body.toolkit.slug }, auth_config: { ...config, auth_scheme: 'OAUTH2', is_composio_managed: true } }, 201);
      }
      const provider = url.searchParams.get('toolkit_slug');
      if (emptyConfigs) { const config = managedConfigs.get(provider!); return response({ items: config ? [{ ...config, toolkit: { slug: provider }, auth_scheme: 'OAUTH2', status: 'ENABLED' }] : disabledConfigs ? [{ id: `ac_${provider}`, name: 'Disabled OAuth', toolkit: { slug: provider }, auth_scheme: 'OAUTH2', status: 'DISABLED' }] : [] }); }
      return response({ items: [{ id: `ac_${provider}`, name: `${provider} OAuth`, toolkit: { slug: provider }, auth_scheme: 'OAUTH2', status: 'ENABLED' }, { id: 'wrong-provider', toolkit: { slug: 'other' }, auth_scheme: 'OAUTH2', status: 'ENABLED' }, { id: 'wrong-scheme', toolkit: { slug: provider }, auth_scheme: 'API_KEY', status: 'ENABLED' }, { id: 'disabled', toolkit: { slug: provider }, auth_scheme: 'OAUTH2', status: 'DISABLED' }] });
    }
    if (url.pathname.endsWith('/link')) {
      const body = JSON.parse(String(init?.body)) as { auth_config_id: string; user_id: string; alias: string };
      const id = `ca_${body.auth_config_id.slice(3)}`;
      accounts.set(id, { id, user_id: body.user_id, alias: body.alias, auth_config: { id: body.auth_config_id, auth_scheme: 'OAUTH2' }, toolkit: { slug: body.auth_config_id.slice(3) }, status: 'INITIATED', state: { val: { access_token: 'secret-account-token' } } });
      if (linkReplyLost) throw new Error('Network failed: fixture-key secret-account-token');
      return response({ connected_account_id: id, redirect_url: unsafeLink ? 'https://example.test/steal' : 'https://connect.composio.dev/link/ln_example', expires_at: new Date(Date.now() + 3600000).toISOString(), link_token: 'secret-link-token' });
    }
    if (url.pathname.endsWith('/connected_accounts')) return response({ items: [...accounts.values()] });
    const id = url.pathname.split('/').at(-1)!;
    if (method === 'DELETE') { if (removeFailure) return response({ token: 'secret-account-token' }, 500); accounts.delete(id); return response({ success: true }); }
    if (readFailure) throw new Error('Provider failed: secret-account-token');
    const account = accounts.get(id); if (!account) return response({}, 404);
    return response(wrongOwner ? { ...account, user_id: 'other-installation' } : account);
  };
  let manager = await createConnectorManager({ dataDir, transport });
  return { dataDir, calls, accounts, transport, cleanup, get manager() { return manager; }, async restart() { await manager.close(); manager = await createConnectorManager({ dataDir, transport }); }, set flags(value: { linkReplyLost?: boolean; rejected?: boolean; readFailure?: boolean; removeFailure?: boolean; wrongOwner?: boolean; unsafeLink?: boolean; emptyConfigs?: boolean; configReplyLost?: boolean; configNotCreated?: boolean; configDenied?: boolean; disabledConfigs?: boolean; unsupportedManaged?: boolean }) { ({ linkReplyLost = linkReplyLost, rejected = rejected, readFailure = readFailure, removeFailure = removeFailure, wrongOwner = wrongOwner, unsafeLink = unsafeLink, emptyConfigs = emptyConfigs, configReplyLost = configReplyLost, configNotCreated = configNotCreated, configDenied = configDenied, disabledConfigs = disabledConfigs, unsupportedManaged = unsupportedManaged } = value); } };
}
async function start(manager: Awaited<ReturnType<typeof createConnectorManager>>, provider: ConnectorProvider) { return manager.start({ provider, configId: `ac_${provider}` }); }

test('project snapshots check stale and restarted bindings while cancellation verifies fresh authorization', async t => {
  const f = await fixture(t); await f.manager.setup({ apiKey: 'fixture-key' }); await start(f.manager, 'gmail');
  assert.equal(f.manager.snapshot().apps.find(app => app.provider === 'gmail')?.account?.status, 'pending');
  f.accounts.get('ca_gmail')!.status = 'ACTIVE';
  await assert.rejects(f.manager.remove({ provider: 'gmail', cancel: true }), /Sign-in completed/);
  const account = () => f.manager.snapshot().apps.find(app => app.provider === 'gmail')!.account!;
  assert.equal(account().status, 'connected'); assert.equal(account().checking, undefined);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 30_000);
  const before = f.calls.length; assert.equal(account().checking, true); assert.equal(f.calls.length, before);
  await f.restart(); assert.equal(account().checking, true); assert.equal(account().status, 'unverified');
  await f.manager.read(); assert.equal(account().status, 'connected'); assert.equal(account().checking, undefined);
});

test('setup explains incompatible Composio key types before sending or saving them', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-connectors-key-'));
  let calls = 0;
  const manager = await createConnectorManager({ dataDir, transport: async () => {
    calls++;
    return new Response('{}', { status: 401 });
  } });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (const [apiKey, kind] of [['ck_example_consumer', 'Connect'], ['uak_example_user', 'user']] as const) {
    await assert.rejects(manager.setup({ apiKey }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`${kind} key`));
      assert.match(error.message, /Platform.*project.*API Keys/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
  assert.equal(calls, 0);
  assert.equal((await manager.read()).configured, false);
  await assert.rejects(readFile(join(dataDir, 'connectors', 'connectors.json')), { code: 'ENOENT' });
});

test('a fresh project prepares managed OAuth only on sign-in and reuses it after restart', async t => {
  const f = await fixture(t); f.flags = { emptyConfigs: true };
  await f.manager.setup({ apiKey: 'fixture-key' });
  assert.deepEqual((await f.manager.options({ provider: 'linear' })).configs, []);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const result = await f.manager.start({ provider: 'linear' });
  assert.equal(result.apps.find(app => app.provider === 'linear')?.account?.status, 'pending');
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth_configs') && call.method === 'POST').length, 1);
  await f.manager.remove({ provider: 'linear', cancel: true }); await f.restart();
  await f.manager.start({ provider: 'linear' });
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth_configs') && call.method === 'POST').length, 1);
});

test('lost OAuth setup replies recover by the persisted name and never create duplicates', async t => {
  const f = await fixture(t); f.flags = { emptyConfigs: true, configReplyLost: true };
  await f.manager.setup({ apiKey: 'fixture-key' });
  await assert.rejects(f.manager.start({ provider: 'gmail' }), /Could not read Composio/);
  await f.restart();
  assert.equal((await f.manager.read()).apps.find(app => app.provider === 'gmail')?.account, null);
  const result = await f.manager.start({ provider: 'gmail' });
  assert.equal(result.apps.find(app => app.provider === 'gmail')?.account?.status, 'pending');
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth_configs') && call.method === 'POST').length, 1);
});

test('an uncertain missing configuration holds its intent across restart instead of repeating the write', async t => {
  const f = await fixture(t); f.flags = { emptyConfigs: true, configReplyLost: true, configNotCreated: true };
  await f.manager.setup({ apiKey: 'fixture-key' });
  await assert.rejects(f.manager.start({ provider: 'jira' }), /Could not read Composio/);
  await f.restart();
  await assert.rejects(f.manager.start({ provider: 'jira' }), /could not be confirmed/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth_configs') && call.method === 'POST').length, 1);
  assert.equal(f.accounts.size, 0);
});

test('managed sign-in respects disabled configurations, unsupported OAuth, invalid choices and write permissions', async t => {
  const f = await fixture(t); f.flags = { emptyConfigs: true, disabledConfigs: true };
  await f.manager.setup({ apiKey: 'fixture-key' });
  await assert.rejects(f.manager.start({ provider: 'slack' }), /Check the OAuth configuration/);
  f.flags = { disabledConfigs: false, unsupportedManaged: true };
  await assert.rejects(f.manager.start({ provider: 'slack' }), /needs an OAuth configuration/);
  f.flags = { unsupportedManaged: false };
  await assert.rejects(f.manager.start({ provider: 'slack', configId: 'ac_unselected' }), /Choose an enabled/);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  f.flags = { configDenied: true };
  await assert.rejects(f.manager.start({ provider: 'slack' }), /Auth configs write permission/);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'connectors', 'connectors.json'), 'utf8')) as { configSetups: object };
  assert.deepEqual(saved.configSetups, {});
  f.flags = { configDenied: false };
  assert.equal((await f.manager.start({ provider: 'slack' })).apps.find(app => app.provider === 'slack')?.account?.status, 'pending');
});

test('four actual OAuth lifecycles persist, verify ownership, and clean up without executing provider tools', async t => {
  const f = await fixture(t), m = f.manager;
  assert.equal((await m.read()).configured, false); assert.equal(f.calls.length, 0);
  await assert.rejects(m.start({ provider: 'slack', configId: 'ac_slack' }), /Set up/);
  await m.setup({ apiKey: 'fixture-key' });
  assert.deepEqual((await m.options({ provider: 'slack' })).configs.map(item => item.id), ['ac_slack']);
  for (const provider of ['slack', 'linear', 'gmail', 'jira'] as const) {
    const result = await start(m, provider);
    assert.equal(result.apps.find(app => app.provider === provider)?.account?.status, 'pending');
    await assert.rejects(start(m, provider), /already has/);
    f.accounts.get(`ca_${provider}`)!.status = 'ACTIVE';
  }
  const view = await m.read(); assert.ok(view.apps.every(app => app.account?.status === 'connected'));
  assert.ok(!JSON.stringify(view).includes('secret-')); assert.ok(!JSON.stringify(view).includes('fixture-key')); assert.ok(!JSON.stringify(view).includes('ca_'));
  const stateFile = join(f.dataDir, 'connectors', 'connectors.json');
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600); assert.equal((await stat(join(f.dataDir, 'connectors'))).mode & 0o777, 0o700);
  const stored = await readFile(stateFile, 'utf8'); assert.ok(!stored.includes('secret-account-token')); assert.ok(!stored.includes('secret-link-token'));
  await f.restart(); assert.ok((await f.manager.read()).apps.every(app => app.account?.status === 'connected'));
  for (const provider of ['slack', 'linear', 'gmail', 'jira']) await f.manager.remove({ provider });
  assert.ok((await f.manager.read()).apps.every(app => !app.account)); assert.equal(f.accounts.size, 0);
  assert.ok(f.calls.every(call => call.path.includes('auth_configs') || call.path.includes('connected_accounts')));
});

test('failed verification and disconnect preserve recoverable ownership; cancellation cannot remove completed authorization', async t => {
  const f = await fixture(t); await f.manager.setup({ apiKey: 'fixture-key' }); await start(f.manager, 'gmail');
  f.accounts.get('ca_gmail')!.status = 'ACTIVE';
  await assert.rejects(f.manager.remove({ provider: 'gmail', cancel: true }), /Sign-in completed/); assert.equal(f.accounts.size, 1);
  f.flags = { wrongOwner: true };
  assert.equal((await f.manager.read()).apps.find(app => app.provider === 'gmail')?.account?.status, 'unverified');
  await assert.rejects(f.manager.remove({ provider: 'gmail' }), /does not match/); assert.equal(f.accounts.size, 1);
  f.flags = { wrongOwner: false, removeFailure: true };
  await assert.rejects(f.manager.remove({ provider: 'gmail' }), /could not complete/); assert.equal(f.accounts.size, 1);
  f.flags = { removeFailure: false, readFailure: true };
  const result = await f.manager.read(); assert.equal(result.apps.find(app => app.provider === 'gmail')?.account?.status, 'unverified'); assert.ok(!JSON.stringify(result).includes('secret-account-token'));
  f.flags = { readFailure: false }; await f.manager.remove({ provider: 'gmail' }); assert.equal(f.accounts.size, 0);
});

test('a lost link reply recovers its original owned account after restart instead of creating a duplicate', async t => {
  const f = await fixture(t); await f.manager.setup({ apiKey: 'fixture-key' }); f.flags = { linkReplyLost: true };
  await assert.rejects(start(f.manager, 'linear'), /Could not read Composio/); assert.equal(f.accounts.size, 1);
  await f.restart();
  const result = await f.manager.read(); assert.equal(result.apps.find(app => app.provider === 'linear')?.account?.status, 'pending');
  await assert.rejects(start(f.manager, 'linear'), /already has/);
  f.accounts.get('ca_linear')!.status = 'ACTIVE'; assert.equal((await f.manager.read()).apps.find(app => app.provider === 'linear')?.account?.status, 'connected');
  await f.manager.remove({ provider: 'linear' }); assert.equal(f.accounts.size, 0);
});

test('untrusted provider URLs, invalid input, failed setup and malformed snapshots never expose credentials or reset records', async t => {
  const f = await fixture(t); f.flags = { rejected: true };
  await assert.rejects(f.manager.setup({ apiKey: 'fixture-key' }), /denied access/); assert.equal((await f.manager.read()).configured, false);
  f.flags = { rejected: false, unsafeLink: true }; await f.manager.setup({ apiKey: 'fixture-key' });
  await assert.rejects(f.manager.start({ provider: 'other', configId: 'ac_slack' }), /Choose an available/);
  await assert.rejects(f.manager.start({ provider: 'slack', configId: '../escape' }), /Choose an enabled/);
  await assert.rejects(start(f.manager, 'slack'), /invalid sign-in link/);
  const result = await f.manager.read(); assert.equal(result.apps[0].account?.redirectUrl, undefined);
  await f.manager.remove({ provider: 'slack' });
  const file = join(f.dataDir, 'connectors', 'connectors.json'); await f.manager.close(); await writeFile(file, '{bad');
  await assert.rejects(createConnectorManager({ dataDir: f.dataDir, transport: f.transport })); assert.equal(await readFile(file, 'utf8'), '{bad');
});

test('connector HTTP routes require the launch session and mutation token, and return only public connection data', async t => {
  const { startServer, fetch: controllerFetch } = await import('./fixtures/controller.ts');
  const f = await fixture(t);
  const app = await startServer({ port: 0, dataDir: join(f.dataDir, 'controller'), connectors: { transport: f.transport } });
  f.cleanup.push(() => app.close());
  assert.equal((await globalThis.fetch(app.url + '/api/connectors')).status, 401);
  const { token } = await (await controllerFetch(app.url + '/api/session')).json() as { token: string };
  const post = (path: string, body: unknown, authenticated = true) => controllerFetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Perpetual-Token': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/connectors/setup', { apiKey: 'fixture-key' }, false)).status, 403);
  const incompatible = await post('/api/connectors/setup', { apiKey: 'ck_example_consumer' });
  assert.equal(incompatible.status, 400);
  const incompatibleReply = await incompatible.text(); assert.match(incompatibleReply, /Composio Connect key/); assert.ok(!incompatibleReply.includes('ck_example_consumer')); assert.equal(f.calls.length, 0);
  const setup = await post('/api/connectors/setup', { apiKey: 'fixture-key' }); assert.equal(setup.status, 200); assert.ok(!JSON.stringify(await setup.json()).includes('fixture-key'));
  const options = await post('/api/connectors/options', { provider: 'jira' }); assert.equal(options.status, 200);
  const started = await post('/api/connectors/start', { provider: 'jira', configId: 'ac_jira' }); assert.equal(started.status, 200); const text = await started.text(); assert.ok(text.includes('pending')); assert.ok(!text.includes('secret-account-token'));
  const list = await controllerFetch(app.url + '/api/connectors'); assert.equal(list.status, 200);
  const removed = await post('/api/connectors/remove', { provider: 'jira', cancel: true }); assert.equal(removed.status, 200); assert.equal(f.accounts.size, 0);
});
