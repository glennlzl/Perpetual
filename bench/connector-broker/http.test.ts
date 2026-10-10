import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import { createBroker } from './broker.ts';
import { listenTrial } from './http.ts';
import { provisionTrial } from './setup.ts';

test('two provisioned clients are private, distinct and cannot choose one another over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-boundary-'));
  let server: Server | undefined;
  try {
    const { principalsFile, clientsDirectory } = await provisionTrial(dir);
    const principals = JSON.parse(await readFile(principalsFile, 'utf8'));
    const a = JSON.parse(await readFile(join(clientsDirectory, 'a.json'), 'utf8'));
    const b = JSON.parse(await readFile(join(clientsDirectory, 'b.json'), 'utf8'));
    assert.notEqual(a.token, b.token);
    assert.equal(Object.keys(a).sort().join(','), 'brokerUrl,token');
    assert.equal((await stat(join(clientsDirectory, 'a.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(clientsDirectory)).mode & 0o777, 0o700);
    assert.equal(principals[0].tokenHash, createHash('sha256').update(a.token).digest('hex'));
    await assert.rejects(provisionTrial(dir));
    let calls = 0;
    const adapter = {
      async start(userId: string) { assert.equal(userId, principals[0].id); calls++; return { id: 'ca_fixture', redirectUrl: 'https://connect.composio.dev/link/test' }; },
      async inspect() { return { userId: principals[0].id, toolkit: 'linear', authConfigId: 'ac_fixture', status: 'ACTIVE' }; },
      async remove(id: string, userId: string) { assert.equal(id, 'ca_fixture'); assert.equal(userId, principals[0].id); calls++; return 'removed' as const; },
      async profile() { calls++; return { id: 'person-a', name: 'Example', email: 'example@example.test' }; },
    };
    server = await listenTrial(createBroker({ adapter, expectedAuthConfigId: 'ac_fixture', principals }), 0);
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const send = (path: string, token: string, body?: string) => fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });
    assert.equal((await send('/trial/connect', a.token, '{}')).status, 200);
    assert.deepEqual(await (await send('/trial/status', b.token)).json(), { status: 'not-connected' });
    assert.equal((await send('/trial/profile', b.token, '{}')).status, 409);
    assert.equal((await send('/trial/profile', b.token, JSON.stringify({ user_id: principals[0].id, connected_account_id: 'ca_fixture' }))).status, 400);
    assert.equal((await send('/trial/profile', a.token, '{}')).status, 200);
    assert.deepEqual(await (await send('/trial/disconnect', b.token, '{}')).json(), { status: 'not-connected' });
    assert.deepEqual(await (await send('/trial/disconnect', a.token, '{}')).json(), { status: 'not-connected' });
    assert.equal(calls, 3);
    assert.equal((await fetch(origin + '/trial/status', { headers: { Authorization: `Bearer ${a.token}`, Origin: 'https://example.test' } })).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin + '/trial/status', { headers: { Host: 'example.test', Authorization: `Bearer ${a.token}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
  } finally {
    if (server) { const running = server; running.closeAllConnections(); await new Promise<void>(resolve => running.close(() => resolve())); }
    await rm(dir, { recursive: true, force: true });
  }
});
