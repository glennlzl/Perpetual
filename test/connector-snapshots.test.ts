import test from 'node:test';
import assert from 'node:assert/strict';
import { api, connectLaunchLink, session } from '../client/src/lib/api.ts';
import { connectorSnapshot, githubSnapshot } from '../client/src/lib/connector-snapshots.ts';
import { githubConnectionChanges } from '../client/src/lib/github-connection-changes.ts';
import type { ConnectorsReply } from '../contract/connectors.ts';
import type { GitHubConnection } from '../contract/github.ts';

const accounts: ConnectorsReply = { apps: [{ provider: 'slack', name: 'Slack', configured: true, account: { status: 'connected' } }] };
const github: GitHubConnection = { available: true, authenticated: true, account: { login: 'developer', name: null }, connected: true, source: null };

test('recent connector snapshots expire without reads extending their lifetime and GitHub revisions must match', t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  connectorSnapshot.clear(); githubSnapshot.clear();
  connectorSnapshot.write(accounts); githubSnapshot.write(github, 'account-one');
  now += 14_999;
  assert.deepEqual(connectorSnapshot.read(), accounts);
  assert.deepEqual(githubSnapshot.read('account-one'), github);
  assert.equal(githubSnapshot.read('account-two'), null);
  now++;
  assert.equal(connectorSnapshot.read(), null);
  assert.equal(githubSnapshot.read('account-one'), null);
});

test('invalidating connector evidence prevents a late read from replacing a newer mutation result', () => {
  connectorSnapshot.clear();
  const reading = connectorSnapshot.generation();
  connectorSnapshot.write(accounts, '', reading);
  connectorSnapshot.clear();
  const disconnected: ConnectorsReply = { ...accounts, apps: [{ ...accounts.apps[0], account: null }] };
  connectorSnapshot.write(disconnected);
  connectorSnapshot.write(accounts, '', reading);
  assert.deepEqual(connectorSnapshot.read(), disconnected);
});

test('GitHub account notifications discard cached evidence even without a mounted Connectors page', () => {
  for (const change of ['connect', 'disconnect'] as const) {
    githubSnapshot.write(github, 'account-one');
    const reading = githubSnapshot.generation();
    githubConnectionChanges.notify(change);
    assert.equal(githubSnapshot.read('account-one'), null);
    githubSnapshot.write(github, 'account-one', reading);
    assert.equal(githubSnapshot.read('account-one'), null);
  }
});

test('a controller session refusal clears both snapshots and fences reads from before authorization recovery', async t => {
  connectorSnapshot.write(accounts); githubSnapshot.write(github, 'account-one');
  const accountRead = connectorSnapshot.generation(), githubRead = githubSnapshot.generation();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Open the controller launch link.' }, { status: 401 }));
  await assert.rejects(api('/api/state'), { statusCode: 401 });
  assert.equal(session.signedOut(), true);
  assert.equal(connectorSnapshot.read(), null);
  assert.equal(githubSnapshot.read('account-one'), null);
  // Even a fresh write cannot retain account evidence while the page is signed out.
  connectorSnapshot.write(accounts); githubSnapshot.write(github, 'account-one');
  assert.equal(connectorSnapshot.read(), null);
  assert.equal(githubSnapshot.read('account-one'), null);

  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:4317' }, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { setItem() {} }, configurable: true });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ token: 'fixture-session-token' }));
  await connectLaunchLink(`http://127.0.0.1:4317/#secret=${'a'.repeat(64)}`);
  assert.equal(session.signedOut(), false);
  connectorSnapshot.write(accounts, '', accountRead); githubSnapshot.write(github, 'account-one', githubRead);
  assert.equal(connectorSnapshot.read(), null);
  assert.equal(githubSnapshot.read('account-one'), null);
  connectorSnapshot.write(accounts); githubSnapshot.write(github, 'account-two');
  assert.deepEqual(connectorSnapshot.read(), accounts);
  assert.deepEqual(githubSnapshot.read('account-two'), github);
});
