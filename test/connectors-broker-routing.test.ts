import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createConnectorManager } from '../src/connectors/manager.ts';

for (const provider of ['linear', 'gmail', 'slack', 'jira'] as const) test(`${provider} uses its paired broker without direct client credentials`, async t => {
  const prefix = provider === 'linear' ? '/trial' : `/trial/${provider}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-broker-routing-'));
  const pairing = join(dataDir, 'pairing.json');
  const token = randomBytes(32).toString('base64url');
  await writeFile(pairing, JSON.stringify({ brokerUrl: 'http://127.0.0.1:43179', token }), { mode: 0o600 });
  let remote: 'not-connected' | 'pending' | 'connected' = 'not-connected';
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:43179');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    calls.push(url.pathname);
    switch (url.pathname.slice(prefix.length)) {
      case '/connect': remote = 'pending'; return Response.json({ redirectUrl: 'https://connect.composio.dev/link/example' });
      case '/status': return Response.json({ status: remote });
      case '/profile': assert.equal(remote, 'connected'); return Response.json(provider === 'gmail' ? { emailAddress: 'user@example.test', historyId: '123', messagesTotal: 5, threadsTotal: 3 } : provider === 'linear' ? { id: 'example-user', name: 'Example User', email: 'user@example.test' } : { id: 'example-user', label: 'Example account' });
      case '/disconnect': remote = 'not-connected'; return Response.json({ status: remote });
      default: throw new Error('Unexpected provider request.');
    }
  };
  const manager = await createConnectorManager({ dataDir, origin: () => 'http://127.0.0.1:4317', env: { [`PERPETUAL_${provider.toUpperCase()}_BROKER_PAIRING`]: pairing }, transport });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const linear = () => manager.snapshot().apps.find(app => app.provider === provider)!;
  assert.equal(linear().configured, true, 'The page must offer sign-in, not the direct OAuth setup error.');
  assert.equal(linear().setupError, undefined);
  assert.equal(calls.length, 0, 'Opening the page must not create a grant.');
  const started = await manager.start({ provider });
  assert.equal(started.apps.find(app => app.provider === provider)!.account?.status, 'pending');
  assert.equal(linear().account?.redirectUrl, 'https://connect.composio.dev/link/example');
  remote = 'connected';
  await manager.read(provider);
  assert.equal(linear().account?.status, 'connected');
  assert.equal(linear().account?.label, provider === 'slack' || provider === 'jira' ? 'Example account' : 'user@example.test');
  await assert.rejects(manager.complete(provider, new URLSearchParams({ code: 'example', state: 'example' })), /broker|service|sign-in|Sign-in/i);
  await manager.remove({ provider });
  assert.equal(linear().account, null);
  assert.equal(remote, 'not-connected');
  assert.ok(calls.includes(`${prefix}/disconnect`));
});
