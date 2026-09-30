import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateManager, type GateSource } from '../src/gate/manager.ts';
import type { CommitStatusPost } from '../src/gate/github.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function storage(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-source-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
const source = (): GateSource => ({ key: 'github:acme/app:/', branch: 'main', sha: A, repository: 'acme/app', stages: [{ id: 'beta', name: 'Beta', kind: 'sandbox' }] });
const noJourneys = { prepare: async (gate: unknown) => gate, journeys: () => 0, rebuild: async () => null, run: async () => null };

test('watched Build heads require the current source, repository, branch and verified account', async t => {
  let current = source(), fail = false;
  const manager = await createGateManager({ dataDir: await storage(t), source: () => current,
    github: { connection: async () => ({ login: 'tester', repository: 'acme/app' }), head: async () => { if (fail) throw new Error('Cannot read branch head.'); return { status: 200, sha: B, etag: null }; }, post: async () => {} }, steps: noJourneys,
  });
  t.after(() => manager.close());
  const scope = { key: current.key, repository: 'acme/app', branch: 'main', login: 'tester' };
  assert.equal(manager.watchedHead(scope), null);
  await manager.watch();
  assert.deepEqual(manager.watchedHead(scope), { key: current.key, branch: 'main', sha: B });
  for (const changed of [{ login: 'other' }, { repository: 'acme/other' }, { branch: 'other' }, { key: '/other' }]) assert.equal(manager.watchedHead({ ...scope, ...changed }), null);
  current = { ...current, repository: null };
  assert.equal(manager.watchedHead(scope), null, 'A local source never borrows a managed head.');
  current = source(); fail = true; await manager.watch();
  assert.throws(() => manager.watchedHead(scope), /Cannot read branch head/, 'A failed watch must not fall back to an older green commit.');
});

test('a failed watcher account read does not expose the previously successful head', async t => {
  const current = source(); let failed = false;
  const manager = await createGateManager({ dataDir: await storage(t), source: () => current,
    github: { connection: async () => { if (failed) throw new Error('Cannot verify the GitHub account.'); return { login: 'tester', repository: 'acme/app' }; }, head: async () => ({ status: 200, sha: B, etag: null }), post: async () => {} }, steps: noJourneys,
  });
  t.after(() => manager.close());
  const scope = { key: current.key, repository: 'acme/app', branch: 'main', login: 'tester' };
  await manager.watch(); assert.equal(manager.watchedHead(scope)?.sha, B);
  failed = true; await manager.watch();
  assert.throws(() => manager.watchedHead(scope), /Cannot verify the GitHub account/);
});

test('a head read during a branch switch is saved only for its original source and account', async t => {
  const current = { ...source(), stages: [] };
  const followed: string[] = [];
  const manager = await createGateManager({ dataDir: await storage(t), source: () => current,
    github: { connection: async () => ({ login: 'tester', repository: 'acme/app' }), head: async () => { current.branch = 'release'; return { status: 200, sha: B, etag: null }; }, post: async () => {} },
    steps: noJourneys, follow: async head => { followed.push(head.sha); },
  });
  t.after(() => manager.close());
  await manager.watch();
  const scope = { key: current.key, repository: 'acme/app', branch: 'main', login: 'tester' };
  assert.equal(manager.watchedHead(scope), null, 'The selected release branch cannot show the old main head.');
  assert.equal(manager.watchedHead({ ...scope, branch: 'release' }), null, 'The response must not be stored under the branch selected later.');
  assert.deepEqual(followed, [], 'Reading another branch never moves this source.');
  current.branch = 'main';
  assert.equal(manager.watchedHead(scope)?.sha, B, 'Returning to the original source can use its saved baseline.');
  assert.equal(manager.watchedHead({ ...scope, login: 'someone-else' }), null);
});

test('Run now refuses a branch switch while it reads the requested source head', async t => {
  let current = source();
  const reading = deferred(), head = deferred(), prepared: unknown[] = [];
  const manager = await createGateManager({ dataDir: await storage(t), source: () => current,
    github: { connection: async () => ({ login: 'tester', repository: 'acme/app' }), head: async () => { reading.resolve(); await head.promise; return { status: 200, sha: A, etag: null }; }, post: async () => {} },
    steps: { ...noJourneys, prepare: async gate => { prepared.push(gate); return gate; } },
  });
  t.after(() => manager.close());
  const running = manager.run({ stageId: 'beta' });
  const refused = assert.rejects(running, (error: Error & { statusCode?: number }) => error.statusCode === 409 && /source changed/i.test(error.message));
  await reading.promise;
  current = { ...current, branch: 'feature', sha: B };
  head.resolve();
  await refused;
  await manager.idle();
  assert.deepEqual(prepared, []);
  assert.deepEqual(manager.view().stages, {});
});

test('commit status waits for its original source when the repository changes during account verification', async t => {
  let current = source(), calls = 0;
  const original = current, reading = deferred(), account = deferred(), posts: CommitStatusPost[] = [];
  const manager = await createGateManager({ dataDir: await storage(t), source: () => current,
    github: {
      connection: async () => { if (++calls === 3) { reading.resolve(); await account.promise; } return { login: 'tester', repository: current.repository! }; },
      build: async () => ({ status: 'passed' }),
      head: async () => ({ status: 200, sha: A, etag: null }), post: async input => { posts.push(input); },
    }, steps: noJourneys,
  });
  t.after(() => manager.close());
  await manager.run({ stageId: 'beta' });
  await reading.promise;
  current = { ...current, key: 'github:acme/other:/', repository: 'acme/other', sha: B };
  account.resolve();
  await manager.idle();
  assert.deepEqual(posts, [], 'The previous source must never report on the newly selected repository.');
  current = original;
  manager.start();
  await manager.idle();
  assert.deepEqual(posts, [{ repository: 'acme/app', sha: A, state: 'pending', context: 'perpetual/Beta', description: 'Needs release' }]);
});
