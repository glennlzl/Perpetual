import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBroker } from './broker.ts';
import type { Adapter, BrokerState, BrokerStateStore } from './broker.ts';

const EXPECTED_CONFIG = 'linear-auth-config';
const token = (letter: string) => `fixture-install-token-${letter}-0123456789`;
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(overrides: Partial<Adapter> = {}, stateStore?: BrokerStateStore, provider: 'linear' | 'gmail' | 'slack' | 'jira' = 'linear') {
  const calls = { start: [] as string[], inspect: [] as string[], remove: [] as string[], profile: [] as string[] };
  const details = new Map<string, { userId: string; toolkit: string; authConfigId: string; status: string }>();
  const adapter: Adapter = {
    async start(userId) {
      calls.start.push(userId);
      const id = `connection-${userId}`;
      details.set(id, { userId, toolkit: provider, authConfigId: EXPECTED_CONFIG, status: 'INITIALIZING' });
      return { id, redirectUrl: 'https://connect.composio.dev/session/opaque' };
    },
    async inspect(id) { calls.inspect.push(id); return details.get(id) ?? { userId: 'missing', toolkit: provider, authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' }; },
    async remove(id, userId, terminalStatuses) {
      calls.remove.push(`${id}:${userId}`);
      const detail = details.get(id);
      if (!detail || detail.userId !== userId) throw new Error('not owned');
      if (terminalStatuses && !terminalStatuses.includes(detail.status)) throw new Error('status changed');
      details.delete(id);
      return 'removed';
    },
    async profile(id, userId) { calls.profile.push(`${id}:${userId}`); return provider === 'slack' || provider === 'jira' ? { id: 'identity-1', label: 'Example User' } : provider === 'gmail' ? { emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1' } : { id: 'lin-user-1', name: 'Example User', email: 'user@example.test' }; },
    ...overrides,
  };
  const handle = createBroker({ adapter, expectedAuthConfigId: EXPECTED_CONFIG, provider, stateStore, principals: [
    { id: 'principal-a', tokenHash: tokenHash(token('a')) },
    { id: 'principal-b', tokenHash: tokenHash(token('b')) },
  ] });
  const request = (path: string, who: 'a' | 'b' = 'a', init: RequestInit = {}) => handle(new Request(`https://broker.example.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token(who)}`, ...(init.headers as Record<string, string> | undefined) },
  }));
  return { handle, request, calls, details };
}

function memoryStateStore(initial?: unknown) {
  let current = initial;
  const saved: BrokerState[] = [];
  const store: BrokerStateStore = {
    async load() { return current; },
    async save(state) { current = structuredClone(state); saved.push(structuredClone(state)); },
  };
  return { store, saved, get current() { return current; }, set current(value: unknown) { current = value; } };
}

const post = (path: string, who: 'a' | 'b' = 'a', body = '{}', headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});

test('rejects unauthenticated callers without exposing adapter errors', async () => {
  const f = fixture();
  const response = await f.handle(new Request('https://broker.example.test/trial/connect', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required.' });
  assert.deepEqual(f.calls.start, []);
});

test('creates one pending link per authenticated principal and does not accept identity selection', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.request('/trial/connect', 'a', post('/trial/connect')),
    f.request('/trial/connect', 'a', post('/trial/connect')),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), await second.json());
  assert.deepEqual(f.calls.start, ['principal-a']);
  const injected = await f.request('/trial/connect', 'b', post('/trial/connect', 'b', JSON.stringify({ userId: 'principal-a', connectedAccountId: 'connection-principal-a' })));
  assert.equal(injected.status, 400);
  assert.deepEqual(f.calls.start, ['principal-a']);
});

test('status and profile select only the authenticated principal connection', async () => {
  const f = fixture();
  await f.request('/trial/connect', 'a', post('/trial/connect'));
  await f.request('/trial/connect', 'b', post('/trial/connect'));
  f.details.get('connection-principal-a')!.status = 'ACTIVE';
  f.details.get('connection-principal-b')!.status = 'ACTIVE';
  const profile = await f.request('/trial/profile', 'b', post('/trial/profile', 'b'));
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), { id: 'lin-user-1', name: 'Example User', email: 'user@example.test' });
  assert.deepEqual(f.calls.profile, ['connection-principal-b:principal-b']);
  const status = await f.request('/trial/status', 'a');
  assert.deepEqual(await status.json(), { status: 'connected' });
});

test('connection metadata ownership, toolkit and auth-config mismatches cannot authorize profile reads', async t => {
  for (const mismatch of [
    { userId: 'principal-b', toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' },
    { userId: 'principal-a', toolkit: 'gmail', authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' },
    { userId: 'principal-a', toolkit: 'linear', authConfigId: 'other-config', status: 'ACTIVE' },
  ]) await t.test(JSON.stringify(mismatch), async () => {
    const f = fixture({ async inspect(id) { f.calls.inspect.push(id); return mismatch; } });
    await f.request('/trial/connect', 'a', post('/trial/connect'));
    const status = await f.request('/trial/status', 'a');
    assert.deepEqual(await status.json(), { status: 'unverified' });
    const response = await f.request('/trial/profile', 'a', post('/trial/profile'));
    assert.equal(response.status, 409);
    assert.deepEqual(f.calls.profile, []);
  });
});

test('profile is unavailable until Composio reports ACTIVE; pending and revoked states are explicit', async () => {
  const f = fixture();
  await f.request('/trial/connect', 'a', post('/trial/connect'));
  assert.deepEqual(await (await f.request('/trial/status')).json(), { status: 'pending' });
  assert.equal((await f.request('/trial/profile', 'a', post('/trial/profile'))).status, 409);
  assert.deepEqual(f.calls.profile, []);
  f.details.get('connection-principal-a')!.status = 'REVOKED';
  assert.deepEqual(await (await f.request('/trial/status')).json(), { status: 'needs-auth' });
  assert.equal((await f.request('/trial/profile', 'a', post('/trial/profile'))).status, 409);
});

test('profile without a connection is rejected instead of returning a not-connected status', async () => {
  const f = fixture();
  const response = await f.request('/trial/profile', 'a', post('/trial/profile'));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Connection is not ready.' });
  assert.deepEqual(f.calls.profile, []);
});

test('disconnect returns not-connected without a mapping and removes only the authenticated principal mapping', async () => {
  const f = fixture();
  const empty = await f.request('/trial/disconnect', 'a', post('/trial/disconnect'));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { status: 'not-connected' });
  assert.deepEqual(f.calls.remove, []);

  await f.request('/trial/connect', 'a', post('/trial/connect'));
  await f.request('/trial/connect', 'b', post('/trial/connect'));
  f.details.get('connection-principal-a')!.status = 'ACTIVE';
  const response = await f.request('/trial/disconnect', 'a', post('/trial/disconnect'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'not-connected' });
  assert.deepEqual(f.calls.remove, ['connection-principal-a:principal-a']);
  assert.deepEqual(await (await f.request('/trial/status', 'a')).json(), { status: 'not-connected' });
  assert.deepEqual(await (await f.request('/trial/status', 'b')).json(), { status: 'pending' });
  assert.deepEqual(await (await f.request('/trial/disconnect', 'b', post('/trial/disconnect'))).json(), { status: 'not-connected' });
  assert.deepEqual(f.calls.remove, ['connection-principal-a:principal-a', 'connection-principal-b:principal-b']);
});

test('disconnect refuses an owner mismatch and retains the private mapping', async () => {
  const f = fixture();
  await f.request('/trial/connect', 'a', post('/trial/connect'));
  f.details.get('connection-principal-a')!.userId = 'principal-b';
  const response = await f.request('/trial/disconnect', 'a', post('/trial/disconnect'));
  assert.equal(response.status, 409);
  assert.deepEqual(f.calls.remove, []);
  assert.deepEqual(await (await f.request('/trial/status', 'a')).json(), { status: 'unverified' });
});

test('uncertain disconnect keeps the mapping for explicit retry and prevents duplicate connect', async () => {
  let removals = 0, starts = 0;
  const f = fixture({
    async start(userId) { starts++; const id = `connection-${userId}`; f.details.set(id, { userId, toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' }); return { id, redirectUrl: 'https://connect.composio.dev/session/opaque' }; },
    async remove() { removals++; if (removals === 1) throw new Error('unknown provider outcome'); return 'removed'; },
  });
  await f.request('/trial/connect', 'a', post('/trial/connect'));
  assert.equal((await f.request('/trial/disconnect', 'a', post('/trial/disconnect'))).status, 502);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  assert.equal(starts, 1);
  assert.deepEqual(await (await f.request('/trial/disconnect', 'a', post('/trial/disconnect'))).json(), { status: 'not-connected' });
  assert.equal(removals, 2);
});

test('rejects query strings, unknown body fields, malformed bodies and browser-origin requests', async () => {
  const f = fixture();
  for (const path of ['/trial/connect?userId=principal-a', '/trial/profile?connectedAccountId=connection-principal-a', '/trial/disconnect?connectedAccountId=connection-principal-a']) {
    assert.equal((await f.request(path, 'a', post(path))).status, 400);
  }
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect', 'a', '{"tool":"LINEAR_GET_PROFILE"}'))).status, 400);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect', 'a', '{'))).status, 400);
  assert.equal((await f.request('/trial/disconnect', 'a', post('/trial/disconnect', 'a', '{"connectedAccountId":"connection-principal-a"}'))).status, 400);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect', 'a', '{}', { origin: 'https://client.example.test' }))).status, 403);
  assert.equal((await f.request('/trial/status', 'a', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
  assert.deepEqual(f.calls.start, []);
});

test('bounds chunked request bodies even when Content-Length is absent', async () => {
  const f = fixture();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(4096))); controller.close(); } });
  const response = await f.handle(new Request('https://broker.example.test/trial/connect', {
    method: 'POST', headers: { authorization: `Bearer ${token('a')}`, 'content-type': 'application/json' }, body, duplex: 'half',
  } as RequestInit));
  assert.equal(response.status, 400);
  assert.deepEqual(f.calls.start, []);
});

test('exposes no arbitrary provider, tool, endpoint or connected-account route', async () => {
  const f = fixture();
  for (const path of ['/trial/tools', '/trial/proxy', '/trial/LINEAR_GET_PROFILE', '/trial/connect/connection-principal-a', '/trial/profile/https://api.linear.app', '/trial/disconnect/connection-principal-a']) {
    const response = await f.request(path, 'a', post(path));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(f.calls.profile, []);
});

test('serializes one principal and enforces a per-minute request budget', async () => {
  let tick = 10_000;
  let active = 0, peak = 0;
  const adapter: Adapter = {
    async start(userId) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { id: `connection-${userId}`, redirectUrl: 'https://connect.composio.dev/session/opaque' };
    },
    async inspect(id) { return { userId: id.slice('connection-'.length), toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'INITIALIZING' }; },
    async remove() { return 'removed'; },
    async profile() { return { id: 'lin-user-1', name: 'Example User', email: 'user@example.test' }; },
  };
  const handle = createBroker({ adapter, expectedAuthConfigId: EXPECTED_CONFIG, requestsPerMinute: 2, now: () => tick, principals: [{ id: 'principal-a', tokenHash: tokenHash(token('a')) }] });
  const request = () => handle(new Request('https://broker.example.test/trial/connect', {
    method: 'POST', headers: { authorization: `Bearer ${token('a')}`, 'content-type': 'application/json' }, body: '{}',
  }));
  const responses = await Promise.all([request(), request()]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(peak, 1);
  assert.equal((await request()).status, 429);
  tick += 60_000;
  assert.equal((await request()).status, 200);
});

test('an uncertain start is tombstoned and cannot create a second Composio attempt', async () => {
  let attempts = 0;
  const f = fixture({ async start() { attempts++; throw new Error('timeout after request may have reached Composio'); } });
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  assert.equal(attempts, 1);
  assert.deepEqual(await (await f.request('/trial/status')).json(), { status: 'needs-auth' });
});

test('persists the uncertain-start tombstone before adapter start and restores it after restart', async () => {
  const disk = memoryStateStore();
  let attempts = 0;
  const f = fixture({ async start() {
    attempts++;
    assert.deepEqual(disk.current, { version: 1, connections: [{ principalId: 'principal-a', createdAt: 7000, failed: true }] });
    throw new Error('uncertain provider outcome');
  } }, disk.store);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  const restart = fixture({ async start() { attempts++; throw new Error('must not happen'); } }, disk.store);
  assert.equal((await restart.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  assert.equal(attempts, 1);
  assert.equal((await restart.request('/trial/status', 'b')).status, 200);
  assert.deepEqual(await (await restart.request('/trial/status', 'b')).json(), { status: 'not-connected' });
});

test('restores a tracked account only for its paired principal across broker restart', async () => {
  const disk = memoryStateStore();
  const first = fixture({}, disk.store);
  assert.equal((await first.request('/trial/connect', 'a', post('/trial/connect'))).status, 200);
  const saved = disk.saved.at(-1)!;
  assert.equal(saved.version, 1);
  assert.equal(saved.connections[0]?.principalId, 'principal-a');
  assert.equal(saved.connections[0]?.id, 'connection-principal-a');
  assert.ok(Number.isSafeInteger(saved.connections[0]?.createdAt));
  const restarted = fixture({ async inspect() { return { userId: 'principal-a', toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'INITIALIZING' }; } }, disk.store);
  const own = await restarted.request('/trial/status', 'a');
  assert.deepEqual(await own.json(), { status: 'pending' });
  assert.deepEqual(await (await restarted.request('/trial/status', 'b')).json(), { status: 'not-connected' });
  assert.equal((await restarted.request('/trial/profile', 'b', post('/trial/profile', 'b'))).status, 409);
});

test('refuses malformed restored state, unknown principals and duplicate remote IDs', async t => {
  const invalidStates: unknown[] = [
    { version: 2, connections: [] },
    { version: 1, connections: [{ principalId: 'principal-unknown', id: 'ca_1', createdAt: 1 }] },
    { version: 1, connections: [
      { principalId: 'principal-a', id: 'ca_1', createdAt: 1 },
      { principalId: 'principal-b', id: 'ca_1', createdAt: 2 },
    ] },
    { version: 1, connections: [{ principalId: 'principal-a', id: 'ca_1', createdAt: 'yesterday' }] },
    { version: 1, connections: [{ principalId: 'principal-a', id: 'ca_1', createdAt: Date.now() + 61_000 }] },
    { version: 1, connections: [{ principalId: 'principal-a', id: 'ca_1', createdAt: 1, token: 'must-not-load' }] },
  ];
  for (const state of invalidStates) await t.test(JSON.stringify(state), async () => {
    const disk = memoryStateStore(state);
    const f = fixture({}, disk.store);
    await assert.rejects(f.handle.ready, /Invalid broker connection state/u);
    assert.equal((await f.request('/trial/status')).status, 503);
  });
});

test('does not call the adapter when the pre-start tombstone cannot be saved', async () => {
  let attempts = 0;
  const store: BrokerStateStore = { async load() { return undefined; }, async save() { throw new Error('disk full'); } };
  const f = fixture({ async start() { attempts++; return { id: 'ca_1', redirectUrl: 'https://connect.composio.dev/session/x' }; } }, store);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 503);
  assert.equal(attempts, 0);
});

test('keeps the persisted tombstone when saving the successful start result fails', async () => {
  let state: unknown, saves = 0, attempts = 0;
  const store: BrokerStateStore = {
    async load() { return state; },
    async save(next) {
      saves++;
      if (saves === 2) throw new Error('disk write failed after remote success');
      state = structuredClone(next);
    },
  };
  const first = fixture({ async start(userId) { attempts++; return { id: `connection-${userId}`, redirectUrl: 'https://connect.composio.dev/session/opaque' }; } }, store);
  assert.equal((await first.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  const persisted = state as BrokerState;
  assert.equal(persisted.version, 1);
  assert.equal(persisted.connections.length, 1);
  assert.equal(persisted.connections[0]?.principalId, 'principal-a');
  assert.equal(persisted.connections[0]?.failed, true);
  assert.equal(persisted.connections[0]?.id, undefined);
  const restarted = fixture({ async start() { attempts++; throw new Error('must not create another remote link'); } }, store);
  assert.equal((await restarted.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
  assert.equal(attempts, 1);
});

test('isolates provider routes, mappings and durable state while retaining Linear aliases', async () => {
  const linearDisk = memoryStateStore(), gmailDisk = memoryStateStore();
  const linear = fixture({}, linearDisk.store, 'linear');
  const gmail = fixture({ async profile() { return { emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1' }; } }, gmailDisk.store, 'gmail');

  assert.equal((await linear.request('/trial/gmail/status')).status, 404);
  assert.equal((await gmail.request('/trial/status')).status, 404);
  await linear.request('/trial/linear/connect', 'a', post('/trial/linear/connect'));
  await gmail.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));
  linear.details.get('connection-principal-a')!.status = 'ACTIVE';
  gmail.details.get('connection-principal-a')!.status = 'ACTIVE';

  assert.deepEqual(await (await linear.request('/trial/status')).json(), { status: 'connected' });
  assert.deepEqual(await (await gmail.request('/trial/gmail/status')).json(), { status: 'connected' });
  assert.deepEqual(await (await gmail.request('/trial/gmail/profile', 'a', post('/trial/gmail/profile'))).json(), {
    emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1',
  });
  assert.deepEqual((linearDisk.current as BrokerState).connections.map(item => item.id), ['connection-principal-a']);
  assert.deepEqual((gmailDisk.current as BrokerState).connections.map(item => item.id), ['connection-principal-a']);

  const restartedGmail = fixture({ async inspect(id) { return { userId: 'principal-a', toolkit: 'gmail', authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' }; }, async profile() {
    return { emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1' };
  } }, gmailDisk.store, 'gmail');
  assert.deepEqual(await (await restartedGmail.request('/trial/gmail/status')).json(), { status: 'connected' });
  assert.equal((await restartedGmail.request('/trial/status')).status, 404);
});

test('Slack and Jira identities use provider-prefixed routes and return only normalized identity fields', async t => {
  for (const provider of ['slack', 'jira'] as const) await t.test(provider, async () => {
    const disk = memoryStateStore();
    const f = fixture({}, disk.store, provider);
    const prefix = `/trial/${provider}`;
    assert.equal((await f.request('/trial/status')).status, 404);
    assert.equal((await f.request('/trial/gmail/status')).status, 404);
    await f.request(`${prefix}/connect`, 'a', post(`${prefix}/connect`));
    f.details.get('connection-principal-a')!.status = 'ACTIVE';
    assert.deepEqual(await (await f.request(`${prefix}/status`)).json(), { status: 'connected' });
    assert.deepEqual(await (await f.request(`${prefix}/profile`, 'a', post(`${prefix}/profile`))).json(), { id: 'identity-1', label: 'Example User' });
    assert.deepEqual((disk.current as BrokerState).connections.map(item => item.principalId), ['principal-a']);
  });
});

test('Slack and Jira reject malformed normalized profiles', async t => {
  for (const provider of ['slack', 'jira'] as const) await t.test(provider, async () => {
    const f = fixture({ async profile() { return { id: 'bad\nid', label: 'Example User' }; } }, undefined, provider);
    const prefix = `/trial/${provider}`;
    await f.request(`${prefix}/connect`, 'a', post(`${prefix}/connect`));
    f.details.get('connection-principal-a')!.status = 'ACTIVE';
    const response = await f.request(`${prefix}/profile`, 'a', post(`${prefix}/profile`));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /bad\nid/u);
  });
});

test('expired pending consent remains mapped and is not removed automatically', async () => {
  let tick = 50_000, starts = 0;
  const adapter: Adapter = {
    async start(userId) { starts++; return { id: `connection-${userId}`, redirectUrl: 'https://connect.composio.dev/session/opaque' }; },
    async inspect(id) { return { userId: id.slice('connection-'.length), toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'INITIALIZING' }; },
    async remove() { return 'removed'; },
    async profile() { return { id: 'lin-user-1', name: 'Example User', email: 'user@example.test' }; },
  };
  const handle = createBroker({ adapter, expectedAuthConfigId: EXPECTED_CONFIG, now: () => tick, principals: [{ id: 'principal-a', tokenHash: tokenHash(token('a')) }] });
  const request = () => handle(new Request('https://broker.example.test/trial/connect', {
    method: 'POST', headers: { authorization: `Bearer ${token('a')}`, 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal((await request()).status, 200);
  tick += 10 * 60_000;
  assert.equal((await request()).status, 502);
  assert.equal(starts, 1);
});

test('replaces a verified expired account with a fresh consent link', async () => {
  const disk = memoryStateStore({ version: 1, connections: [{ principalId: 'principal-a', id: 'connection-old', createdAt: 1 }] });
  let starts = 0, removals = 0;
  let replacementCreated = false;
  const f = fixture({
    async inspect() { return { userId: 'principal-a', toolkit: 'gmail', authConfigId: EXPECTED_CONFIG, status: replacementCreated ? 'INITIALIZING' : 'EXPIRED' }; },
    async remove(_id, _userId, terminalStatuses) {
      assert.ok(terminalStatuses?.includes('EXPIRED'));
      removals++;
      return 'removed';
    },
    async start() {
      starts++;
      replacementCreated = true;
      f.calls.start.push('principal-a');
      return { id: `connection-new-${starts}`, redirectUrl: 'https://connect.composio.dev/session/opaque' };
    },
  }, disk.store, 'gmail');

  const replacement = await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));
  assert.equal(replacement.status, 200);
  assert.deepEqual(await replacement.json(), { redirectUrl: 'https://connect.composio.dev/session/opaque' });
  assert.equal(removals, 1);
  assert.deepEqual(f.calls.start, ['principal-a']);
  assert.equal(starts, 1);
  assert.equal((disk.current as BrokerState).connections[0]?.id, 'connection-new-1');
  assert.deepEqual(await (await f.request('/trial/gmail/status')).json(), { status: 'pending' });
});

test('an expired account that becomes active during cleanup is not deleted or replaced', async () => {
  let f: ReturnType<typeof fixture>;
  let inspections = 0;
  f = fixture({
    async inspect(id) {
      f.calls.inspect.push(id);
      inspections++;
      return { userId: 'principal-a', toolkit: 'gmail', authConfigId: EXPECTED_CONFIG, status: inspections === 1 ? 'EXPIRED' : 'ACTIVE' };
    },
    async remove(id, userId, terminalStatuses) {
      f.calls.remove.push(`${id}:${userId}`);
      inspections++;
      const status = inspections === 1 ? 'EXPIRED' : 'ACTIVE';
      if (!terminalStatuses?.includes(status)) throw new Error('status changed before delete');
      return 'removed';
    },
  }, undefined, 'gmail');
  await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));

  assert.equal((await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 502);
  assert.deepEqual(f.calls.remove, ['connection-principal-a:principal-a']);
  assert.deepEqual(f.calls.start, ['principal-a']);
});

test('connect never removes active, unknown, mismatched or uncertain connections', async t => {
  for (const scenario of [
    { name: 'active', status: 'ACTIVE', owner: 'principal-a', toolkit: 'gmail', config: EXPECTED_CONFIG },
    { name: 'unknown status', status: 'FUTURE_STATUS', owner: 'principal-a', toolkit: 'gmail', config: EXPECTED_CONFIG },
    { name: 'wrong owner', status: 'EXPIRED', owner: 'principal-b', toolkit: 'gmail', config: EXPECTED_CONFIG },
    { name: 'wrong toolkit', status: 'EXPIRED', owner: 'principal-a', toolkit: 'linear', config: EXPECTED_CONFIG },
    { name: 'wrong auth config', status: 'EXPIRED', owner: 'principal-a', toolkit: 'gmail', config: 'other-config' },
  ]) await t.test(scenario.name, async () => {
    const f = fixture({}, undefined, 'gmail');
    await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));
    Object.assign(f.details.get('connection-principal-a')!, {
      status: scenario.status, userId: scenario.owner, toolkit: scenario.toolkit, authConfigId: scenario.config,
    });

    assert.notEqual((await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 200);
    assert.deepEqual(f.calls.remove, []);
    assert.deepEqual(f.calls.start, ['principal-a']);
  });

  const tombstone = fixture({ async start() { throw new Error('uncertain start'); } }, undefined, 'gmail');
  assert.equal((await tombstone.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 502);
  assert.equal((await tombstone.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 502);
  assert.deepEqual(tombstone.calls.remove, []);
  assert.deepEqual(tombstone.calls.start, []);
});

test('failed terminal cleanup keeps the mapping and never starts a replacement', async () => {
  let removals = 0;
  const f = fixture({ async remove() { removals++; throw new Error('unknown removal outcome'); } }, undefined, 'gmail');
  await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));
  f.details.get('connection-principal-a')!.status = 'FAILED';

  assert.equal((await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 502);
  assert.equal(removals, 1);
  assert.deepEqual(f.calls.start, ['principal-a']);
  assert.deepEqual(await (await f.request('/trial/gmail/status')).json(), { status: 'needs-auth' });
});

test('failed terminal cleanup persistence retains ownership and does not create a new link', async () => {
  let saves = 0;
  const disk = memoryStateStore();
  const store: BrokerStateStore = {
    async load() { return disk.current; },
    async save(state) {
      saves++;
      if (saves === 3) throw new Error('disk write failed after remote cleanup');
      await disk.store.save(state);
    },
  };
  const f = fixture({}, store, 'gmail');
  await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'));
  f.details.get('connection-principal-a')!.status = 'EXPIRED';

  assert.equal((await f.request('/trial/gmail/connect', 'a', post('/trial/gmail/connect'))).status, 502);
  assert.deepEqual(f.calls.remove, ['connection-principal-a:principal-a']);
  assert.deepEqual(f.calls.start, ['principal-a']);
  assert.equal((disk.current as BrokerState).connections[0]?.id, 'connection-principal-a');
});

test('the pending consent TTL expires an unused link but never an ACTIVE connection', async () => {
  let tick = 100_000;
  const adapter: Adapter = {
    async start(userId) { return { id: `connection-${userId}`, redirectUrl: 'https://connect.composio.dev/session/opaque' }; },
    async inspect(id) { return { userId: id.slice('connection-'.length), toolkit: 'linear', authConfigId: EXPECTED_CONFIG, status: 'ACTIVE' }; },
    async remove() { return 'removed'; },
    async profile() { return { id: 'lin-user-1', name: 'Example User', email: 'user@example.test' }; },
  };
  const handle = createBroker({ adapter, expectedAuthConfigId: EXPECTED_CONFIG, now: () => tick, principals: [{ id: 'principal-a', tokenHash: tokenHash(token('a')) }] });
  const connect = () => handle(new Request('https://broker.example.test/trial/connect', {
    method: 'POST', headers: { authorization: `Bearer ${token('a')}`, 'content-type': 'application/json' }, body: '{}',
  }));
  const status = () => handle(new Request('https://broker.example.test/trial/status', { headers: { authorization: `Bearer ${token('a')}` } }));
  await connect();
  tick += 11 * 60_000;
  assert.deepEqual(await (await status()).json(), { status: 'connected' });
  tick += 11 * 60_000;
  assert.deepEqual(await (await status()).json(), { status: 'connected' });
});

test('redirect URLs are restricted to the Composio hosted handoff', async () => {
  const f = fixture({ async start(userId) { return { id: `connection-${userId}`, redirectUrl: 'https://attacker.example.test/collect' }; } });
  const response = await f.request('/trial/connect', 'a', post('/trial/connect'));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /attacker|connection-principal-a/u);
  assert.equal((await f.request('/trial/connect', 'a', post('/trial/connect'))).status, 502);
});

test('adapter failures never leak their details or connection IDs', async () => {
  const f = fixture({
    async inspect(id) { throw new Error(`adapter leaked project secret fixture-key and ${id}`); },
  });
  await f.request('/trial/connect', 'a', post('/trial/connect'));
  const status = await f.request('/trial/status');
  assert.deepEqual(await status.json(), { status: 'unverified' });

  const g = fixture({ async profile() { throw new Error('raw response includes fixture-private-token'); } });
  await g.request('/trial/connect', 'a', post('/trial/connect'));
  g.details.get('connection-principal-a')!.status = 'ACTIVE';
  const failed = await g.request('/trial/profile', 'a', post('/trial/profile'));
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /fixture-private-token|connection-principal-a/u);

  const h = fixture({ async profile() { return { id: 'bad\nid', name: 'Example User', email: 'user@example.test' }; } });
  await h.request('/trial/connect', 'a', post('/trial/connect'));
  h.details.get('connection-principal-a')!.status = 'ACTIVE';
  assert.equal((await h.request('/trial/profile', 'a', post('/trial/profile'))).status, 502);
});
