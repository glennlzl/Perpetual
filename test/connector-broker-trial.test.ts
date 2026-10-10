import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalBrokerTrial } from '../src/connectors/broker-trial.ts';
import { writeStateFile } from '../src/store.ts';

const pairing = () => ({ brokerUrl: 'http://127.0.0.1:43179', token: randomBytes(32).toString('base64url') });
const response = (value: unknown, status = 200) => Response.json(value, { status });

async function fixture(t: test.TestContext, transport: typeof fetch, provider: 'linear' | 'gmail' | 'slack' | 'jira' = 'linear') {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-broker-trial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairingValue = pairing(), pairingPath = join(root, 'pairing.json');
  await writeStateFile(pairingPath, JSON.stringify(pairingValue));
  const manager = await createLocalBrokerTrial({ dataDir: join(root, 'data'), provider, env: { [`PERPETUAL_${provider.toUpperCase()}_BROKER_PAIRING`]: pairingPath }, transport });
  assert.ok(manager);
  return { root, pairingPath, pairingValue, manager };
}

test('broker trial is opt-in and exposes a configured Linear app without local Linear OAuth credentials', async () => {
  assert.equal(await createLocalBrokerTrial({ dataDir: tmpdir(), env: {} }), undefined);
  const root = await mkdtemp(join(tmpdir(), 'perpetual-broker-unconfigured-'));
  try {
    const p = pairing(), path = join(root, 'pairing.json'); await writeStateFile(path, JSON.stringify(p));
    const manager = await createLocalBrokerTrial({ dataDir: join(root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: path }, transport: async () => { throw new Error('offline'); } });
    assert.deepEqual(manager!.snapshot(), { provider: 'linear', name: 'Linear', configured: true, account: null });
    await manager!.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects unsafe, malformed, non-private pairing files before sending any request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-broker-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [
    { brokerUrl: 'https://attacker.example', token: pairing().token },
    { brokerUrl: 'http://127.0.0.1:43179', token: pairing().token, userId: 'other' },
    { brokerUrl: 'http://127.0.0.1:43179', token: 'bad' },
  ]) {
    const path = join(root, `${Math.random()}.json`); await writeStateFile(path, JSON.stringify(value));
    await assert.rejects(createLocalBrokerTrial({ dataDir: join(root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: path }, transport: async () => { throw new Error('must not call'); } }), /pairing is invalid/u);
  }
  const exposed = join(root, 'exposed.json'); await writeFile(exposed, JSON.stringify(pairing()), { mode: 0o644 });
  await assert.rejects(createLocalBrokerTrial({ dataDir: join(root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: exposed } }), /pairing is invalid/u);
});

test('only a verified connected status followed by profile verification becomes Connected', async t => {
  const calls: Array<{ path: string; method: string; authorization: string | null; body?: string }> = [];
  let status: string = 'not-connected';
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    calls.push({ path: url.pathname, method, authorization: new Headers(init.headers).get('authorization'), body: typeof init.body === 'string' ? init.body : undefined });
    if (url.pathname.endsWith('/status')) return response({ status });
    if (url.pathname.endsWith('/profile')) return response({ id: 'lin-user-1', name: 'Example User', email: 'user@example.test' });
    if (url.pathname.endsWith('/connect')) { status = 'pending'; return response({ redirectUrl: 'https://connect.composio.dev/session/opaque' }); }
    if (url.pathname.endsWith('/disconnect')) return response({ status: 'not-connected' });
    return response({ error: 'not found' }, 404);
  };
  const f = await fixture(t, transport);
  const started = await f.manager.start();
  assert.equal(started.account?.status, 'pending');
  assert.equal(started.account?.redirectUrl, 'https://connect.composio.dev/session/opaque');
  assert.deepEqual(await f.manager.read(true), started);
  assert.equal(calls.filter(call => call.path.endsWith('/connect')).length, 1);
  assert.equal(calls.some(call => call.path.endsWith('/profile')), false);

  status = 'connected';
  const connected = await f.manager.read(true);
  assert.deepEqual(connected.account, { status: 'connected', label: 'user@example.test' });
  assert.equal(calls.filter(call => call.path.endsWith('/profile')).length, 1);
  assert.ok(calls.every(call => call.authorization === `Bearer ${f.pairingValue.token}`));
  assert.ok(calls.filter(call => call.method === 'POST').every(call => call.body === '{}'));
  await f.manager.close();
});

test('startup never treats saved pending consent as Connected and expires its link after ten minutes', async t => {
  let status = 'not-connected';
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) return response({ status });
    if (path.endsWith('/connect')) { status = 'pending'; return response({ redirectUrl: 'https://connect.composio.dev/session/opaque' }); }
    return response({ id: 'lin-user', name: 'Example', email: 'user@example.test' });
  };
  const f = await fixture(t, transport);
  const started = await f.manager.start();
  assert.equal(started.account?.status, 'pending');
  await f.manager.close();

  const restarted = await createLocalBrokerTrial({ dataDir: join(f.root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: f.pairingPath }, transport });
  assert.equal(restarted!.snapshot().account?.status, 'pending');
  await restarted!.close();

  // The test uses the manager's persisted timestamp by moving the private metadata back in time.
  const metadataPath = join(f.root, 'data', 'connectors', 'broker-trial.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { schema: number; pending?: { redirectUrl: string; createdAt: number } };
  metadata.pending!.createdAt = Date.now() - 11 * 60_000;
  await writeStateFile(metadataPath, JSON.stringify(metadata));
  const expiredManager = await createLocalBrokerTrial({ dataDir: join(f.root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: f.pairingPath }, transport });
  assert.equal(expiredManager!.snapshot().account?.status, 'needs-auth');
  status = 'not-connected';
  assert.equal((await expiredManager!.read(true)).account, null);
  await expiredManager!.close();
});

test('start refreshes an Unverified observation before reusing a pending link', async t => {
  let status = 'not-connected', reads = 0, starts = 0;
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) { reads++; return response({ status }); }
    if (path.endsWith('/connect')) { starts++; status = 'pending'; return response({ redirectUrl: 'https://connect.composio.dev/session/current' }); }
    return response({ id: 'lin-user', name: 'Example', email: 'user@example.test' });
  };
  const f = await fixture(t, transport);
  await f.manager.start();
  status = 'unverified';
  assert.equal((await f.manager.read(true)).account?.status, 'unverified');
  status = 'pending';
  const refreshed = await f.manager.start();
  assert.equal(refreshed.account?.status, 'pending');
  assert.equal(refreshed.account?.redirectUrl, 'https://connect.composio.dev/session/current');
  assert.equal(starts, 1);
  assert.equal(reads, 3);
});

test('an explicit start clears a saved link after the broker restarted and lost its mapping', async t => {
  let status = 'not-connected', connects = 0;
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) return response({ status });
    if (path.endsWith('/connect')) {
      connects++; status = 'pending';
      return response({ redirectUrl: `https://connect.composio.dev/session/link-${connects}` });
    }
    return response({ id: 'lin-user', name: 'Example', email: 'user@example.test' });
  };
  const f = await fixture(t, transport);
  assert.equal((await f.manager.start()).account?.redirectUrl, 'https://connect.composio.dev/session/link-1');
  status = 'not-connected'; // The broker's volatile mapping was lost on restart.
  const restarted = await f.manager.start();
  assert.equal(restarted.account?.redirectUrl, 'https://connect.composio.dev/session/link-2');
  assert.equal(connects, 2);
});

test('rejects a persisted pending timestamp too far in the future', async t => {
  const f = await fixture(t, async input => new URL(String(input)).pathname.endsWith('/status') ? response({ status: 'not-connected' }) : response({ redirectUrl: 'https://connect.composio.dev/session/opaque' }));
  await f.manager.start(); await f.manager.close();
  const metadataPath = join(f.root, 'data', 'connectors', 'broker-trial.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { schema: number; pending?: { redirectUrl: string; createdAt: number } };
  metadata.pending!.createdAt = Date.now() + 120_001;
  await writeStateFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(createLocalBrokerTrial({ dataDir: join(f.root, 'data'), env: { PERPETUAL_LINEAR_BROKER_PAIRING: f.pairingPath } }), /private Linear broker trial state/u);
});

test('30-second observation cache avoids duplicate remote reads until forced', async t => {
  let statusCalls = 0, profileCalls = 0;
  const transport: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/status')) { statusCalls++; return response({ status: 'connected' }); }
    profileCalls++; return response({ id: 'lin-user-1', name: 'Example User', email: 'user@example.test' });
  };
  const f = await fixture(t, transport);
  await f.manager.read(true);
  await f.manager.read();
  assert.equal(statusCalls, 1); assert.equal(profileCalls, 1);
  await f.manager.read(true);
  assert.equal(statusCalls, 2); assert.equal(profileCalls, 2);
});

test('cancel refuses when a fresh status says consent already completed; disconnect clears remote and local state', async t => {
  let status = 'connected', disconnects = 0;
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) return response({ status });
    if (path.endsWith('/profile')) return response({ id: 'lin-user-1', name: 'Example User', email: 'user@example.test' });
    if (path.endsWith('/disconnect')) { disconnects++; status = 'not-connected'; return response({ status }); }
    return response({ redirectUrl: 'https://connect.composio.dev/session/opaque' });
  };
  const f = await fixture(t, transport);
  await assert.rejects(f.manager.remove(true), /sign-in completed/u);
  assert.equal(disconnects, 0);
  const result = await f.manager.remove(false);
  assert.equal(disconnects, 1);
  assert.equal(result.account, null);
});

test('broker failures become fixed Unverified errors and never expose response text', async t => {
  const f = await fixture(t, async () => new Response('fixture-secret raw provider response', { status: 503, headers: { 'content-type': 'application/json' } }));
  const result = await f.manager.read(true);
  assert.equal(result.account?.status, 'unverified');
  assert.equal(result.account?.error, 'Could not check the Linear connection. Try again.');
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|raw provider/u);
});

test('loopback transport failures are distinct from broker HTTP failures and retain the last verified label', async t => {
  let mode: 'ok' | 'offline' | 'http' | 'needs-auth' = 'ok';
  const f = await fixture(t, async input => {
    const path = new URL(String(input)).pathname;
    if (mode === 'offline') throw new Error('ECONNREFUSED private socket detail');
    if (path.endsWith('/status')) {
      if (mode === 'http') return response({ error: 'private provider detail' }, 503);
      return response({ status: mode === 'needs-auth' ? 'needs-auth' : 'connected' });
    }
    return response({ id: 'lin-user', name: 'Example User', email: 'known@example.test' });
  });

  assert.deepEqual((await f.manager.read(true)).account, { status: 'connected', label: 'known@example.test' });
  mode = 'offline';
  const offline = await f.manager.read(true);
  assert.deepEqual(offline.account, { status: 'unverified', label: 'known@example.test', error: 'Connection service is unavailable. Try again.' });
  assert.doesNotMatch(JSON.stringify(offline), /ECONNREFUSED|private socket/u);

  mode = 'http';
  const httpFailure = await f.manager.read(true);
  assert.deepEqual(httpFailure.account, { status: 'unverified', label: 'known@example.test', error: 'Could not check the Linear connection. Try again.' });
  assert.doesNotMatch(JSON.stringify(httpFailure), /private provider detail/u);

  mode = 'needs-auth';
  assert.deepEqual((await f.manager.read(true)).account, { status: 'needs-auth', error: 'Linear authorization needs attention. Reconnect the broker trial.' });
  await f.manager.close();
});

test('invalid broker pairing stays a pairing error during refresh and keeps the verified label', async t => {
  let unauthorized = false;
  const f = await fixture(t, async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) return unauthorized ? response({ error: 'private detail' }, 401) : response({ status: 'connected' });
    return response({ id: 'lin-user', name: 'Example User', email: 'known@example.test' });
  });
  await f.manager.read(true);
  unauthorized = true;
  const result = await f.manager.read(true);
  assert.deepEqual(result.account, { status: 'unverified', label: 'known@example.test', error: 'The Linear broker pairing is invalid. Re-pair this installation.' });
  assert.doesNotMatch(JSON.stringify(result), /private detail/u);
  await f.manager.close();
});

test('profile verification failure does not claim the reachable service is offline and can recover without sign-in', async t => {
  let failed = true;
  const f = await fixture(t, async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) return response({ status: 'connected' });
    assert.ok(path.endsWith('/profile'));
    return failed ? response({ error: 'private upstream failure' }, 502) : response({ id: 'lin-user', name: 'Example User', email: 'user@example.test' });
  });
  assert.deepEqual((await f.manager.read(true)).account, { status: 'unverified', error: 'Could not verify the Linear account. Try again.' });
  failed = false;
  assert.deepEqual((await f.manager.read(true)).account, { status: 'connected', label: 'user@example.test' });
});

test('Gmail uses its own broker routes and validates mailbox metadata without exposing message data', async t => {
  const paths: string[] = [];
  let status = 'not-connected';
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('/status')) return response({ status });
    if (path.endsWith('/connect')) { status = 'pending'; return response({ redirectUrl: 'https://connect.composio.dev/session/gmail' }); }
    if (path.endsWith('/profile')) return response({ emailAddress: 'mailbox@example.test', messagesTotal: 17, threadsTotal: 9, historyId: 'history-1' });
    if (path.endsWith('/disconnect')) { status = 'not-connected'; return response({ status }); }
    return response({}, 404);
  };
  const f = await fixture(t, transport, 'gmail');
  assert.deepEqual(f.manager.snapshot(), { provider: 'gmail', name: 'Gmail', configured: true, account: null });
  await f.manager.start();
  status = 'connected';
  const connected = await f.manager.read(true);
  assert.deepEqual(connected.account, { status: 'connected', label: 'mailbox@example.test' });
  await f.manager.remove(false);
  assert.deepEqual(paths, ['/trial/gmail/status', '/trial/gmail/connect', '/trial/gmail/status', '/trial/gmail/profile', '/trial/gmail/disconnect']);
  const metadata = JSON.parse(await readFile(join(f.root, 'data', 'connectors', 'gmail-broker.json'), 'utf8')) as { label?: string };
  assert.equal(metadata.label, undefined, 'disconnect clears only Gmail broker metadata.');
  await assert.rejects(readFile(join(f.root, 'data', 'connectors', 'broker-trial.json'), 'utf8'), /ENOENT/u);
});

test('Gmail rejects malformed mailbox metadata and keeps its state separate from Linear', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-broker-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const linearPairingPath = join(root, 'linear-pairing.json'), gmailPairingPath = join(root, 'gmail-pairing.json');
  await writeStateFile(linearPairingPath, JSON.stringify(pairing()));
  await writeStateFile(gmailPairingPath, JSON.stringify(pairing()));
  const dataDir = join(root, 'data');
  const linear = await createLocalBrokerTrial({ dataDir, env: { PERPETUAL_LINEAR_BROKER_PAIRING: linearPairingPath }, transport: async input => new URL(String(input)).pathname.endsWith('/status') ? response({ status: 'connected' }) : response({ id: 'lin-1', name: 'Example', email: 'linear@example.test' }) });
  assert.equal((await linear!.read(true)).account?.label, 'linear@example.test');

  for (const badProfile of [
    { emailAddress: 'mailbox@example.test', messagesTotal: 3, historyId: 'h1' },
    { emailAddress: 'mailbox@example.test', messagesTotal: -1, threadsTotal: 1, historyId: 'h1' },
    { emailAddress: 'mailbox@example.test', messagesTotal: 3, threadsTotal: 1, historyId: 'h1', messages: [{ body: 'private' }] },
  ]) {
    const gmail = await createLocalBrokerTrial({ provider: 'gmail', dataDir, env: { PERPETUAL_GMAIL_BROKER_PAIRING: gmailPairingPath }, transport: async input => new URL(String(input)).pathname.endsWith('/status') ? response({ status: 'connected' }) : response(badProfile) });
    const result = await gmail!.read(true);
    assert.deepEqual(result.account, { status: 'unverified', error: 'Could not verify the Gmail account. Try again.' });
    await gmail!.close();
  }
  const linearMetadata = JSON.parse(await readFile(join(dataDir, 'connectors', 'broker-trial.json'), 'utf8')) as { label?: string };
  assert.equal(linearMetadata.label, 'linear@example.test');
  await assert.rejects(readFile(join(dataDir, 'connectors', 'gmail-broker.json'), 'utf8'), /ENOENT/u);
  await linear!.close();
});

for (const provider of ['slack', 'jira'] as const) test(`${provider} validates the broker identity profile and never invents an email`, async t => {
  let status = 'not-connected';
  const paths: string[] = [];
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('/status')) return response({ status });
    if (path.endsWith('/connect')) { status = 'pending'; return response({ redirectUrl: 'https://connect.composio.dev/session/identity' }); }
    if (path.endsWith('/profile')) return response({ id: 'account-1', label: 'Example workspace' });
    if (path.endsWith('/disconnect')) { status = 'not-connected'; return response({ status }); }
    return response({}, 404);
  };
  const f = await fixture(t, transport, provider);
  await f.manager.start(); status = 'connected';
  const connected = await f.manager.read(true);
  assert.deepEqual(connected.account, { status: 'connected', label: 'Example workspace' });
  assert.equal(JSON.stringify(connected).includes('@'), false);
  await f.manager.remove(false);
  assert.deepEqual(paths, [`/trial/${provider}/status`, `/trial/${provider}/connect`, `/trial/${provider}/status`, `/trial/${provider}/profile`, `/trial/${provider}/disconnect`]);
  await f.manager.close();
});

for (const profile of [
  { id: 'account-1', label: 'Example workspace', email: 'unexpected@example.test' },
  { id: '', label: 'Example workspace' },
  { id: 'account-1', label: 'x'.repeat(321) },
]) for (const provider of ['slack', 'jira'] as const) test(`${provider} rejects malformed broker identity profile`, async t => {
  const f = await fixture(t, async input => new URL(String(input)).pathname.endsWith('/status') ? response({ status: 'connected' }) : response(profile), provider);
  assert.deepEqual((await f.manager.read(true)).account, { status: 'unverified', error: `Could not verify the ${provider === 'slack' ? 'Slack' : 'Jira'} account. Try again.` });
  await f.manager.close();
});
