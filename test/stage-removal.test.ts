import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStageRemovalManager } from '../src/environments/stage-removal.ts';
import { createEnvironmentUsage, type EnvironmentUsage, type StageRef } from '../src/environments/usage.ts';
import type { PublicEnvironment } from '../src/environments/manager.ts';

type RemovalManager = Awaited<ReturnType<typeof createStageRemovalManager>>;
type FixtureOptions = { dataDir?: string; usage?: EnvironmentUsage; items?: PublicEnvironment[]; cleanup?: (id: string) => Promise<void>; browserActive?: () => boolean; remove?: (context: StageRef) => Promise<void> };

const context = { key: 'source-a', stageId: 'beta', scan: { credentials: 'never-persist', repo: { path: '/repo/a' } } };
// A ready Beta sandbox as environment summaries list it.
const ready = (id: string): PublicEnvironment => ({ id, pipelineKey: context.key, stageId: 'beta', repoPath: '/repo/a', sourceBranch: null, sourceRevision: null, status: 'ready', step: 'Ready', services: [], apps: [], createdAt: '2026-09-23T00:00:00.000Z', sandboxId: `sandbox-${id}` });
const deferred = () => { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const fixtures = new WeakMap<TestContext, { managers: RemovalManager[]; directories: string[] }>();

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  if (!fixtures.has(t)) {
    const owned: { managers: RemovalManager[]; directories: string[] } = { managers: [], directories: [] };
    fixtures.set(t, owned);
    t.after(async () => {
      for (const manager of owned.managers.toReversed()) await manager.close();
      for (const directory of owned.directories) await rm(directory, { recursive: true, force: true });
    });
  }
  const dataDir = options.dataDir || await mkdtemp(join(tmpdir(), 'perpetual-stage-removal-'));
  if (!options.dataDir) fixtures.get(t)!.directories.push(dataDir);
  const usage = options.usage || createEnvironmentUsage();
  const items = options.items || [ready('first'), ready('second')];
  const calls: string[] = [], removed: StageRef[] = [], forgotten: StageRef[][] = [], jobs = new Map<string, Promise<void>>();
  const environments: Parameters<typeof createStageRemovalManager>[0]['environments'] = {
    summaries: key => key === context.key ? structuredClone(items) : [],
    async destroy(received, id, { removalToken } = {}) {
      assert.deepEqual(received, { key: context.key, stageId: context.stageId });
      const release = usage.acquire(received, { environmentId: id, operation: 'destroy', removalToken });
      calls.push(id);
      const item = items.find(value => value.id === id)!;
      item.status = 'destroying';
      const job = Promise.resolve().then(async () => {
        try {
          await options.cleanup?.(id);
          item.status = 'destroyed';
        } catch (error) { item.status = 'cleanup_failed'; item.error = (error as Error).message; }
        finally { release(); jobs.delete(id); }
      });
      jobs.set(id, job);
      return { environment: structuredClone(item) };
    },
    // A record removed from the list reads back as undefined, as a lost ownership record would.
    async awaitIdle(id) { await jobs.get(id); return structuredClone(items.find(item => item.id === id)!); },
    async forget(stages) { forgotten.push(structuredClone(stages)); },
  };
  const manager = await createStageRemovalManager({ dataDir, usage, environments,
    browser: { isActive: () => options.browserActive?.() || false },
    removeStage: async received => { await options.remove?.(received); removed.push(received); },
  });
  fixtures.get(t)!.managers.push(manager);
  return { dataDir, usage, items, calls, removed, forgotten, manager };
}

test('accepted removal owns all cleanup and removes the pinned stage after every sandbox finishes', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { cleanup: async id => { if (id === 'first') { entered.resolve(); await finish.promise; } } });
  const reply = await f.manager.start(context);
  await entered.promise;
  assert.ok(['queued', 'removing'].includes(reply.removal!.status));
  assert.equal(f.removed.length, 0);
  assert.throws(() => f.usage.acquire({ key: 'other', stageId: 'gamma' }, { environmentId: 'second', operation: 'browser' }), /remov|delet|busy|progress/i);
  const stored = await readFile(join(f.dataDir, 'stage-removals', 'state.json'), 'utf8');
  assert.doesNotMatch(stored, /never-persist|credentials|scan|\/repo\/a/);
  assert.match(stored, /source-a/);
  context.scan.repo.path = '/repo/source-was-switched';
  finish.resolve();
  await f.manager.awaitIdle(context);
  assert.deepEqual(f.calls, ['first', 'second']);
  assert.deepEqual(f.removed, [{ key: 'source-a', stageId: 'beta' }]);
  assert.equal(f.manager.view(context).removal?.status, 'completed');
  // The stage's twin config, detection and draft go with it, and a restart drops any that remain.
  assert.deepEqual(f.forgotten, [[{ key: 'source-a', stageId: 'beta' }]]);
  await f.manager.close();
  const restarted = await fixture(t, { dataDir: f.dataDir, usage: createEnvironmentUsage(), items: [] });
  assert.deepEqual(restarted.forgotten, [[{ key: 'source-a', stageId: 'beta' }]]);
  assert.equal(f.manager.summaries('other').length, 0);
  assert.equal(f.manager.summaries('source-a').length, 1);
});

test('duplicate requests join one durable intent without duplicate destruction', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { cleanup: async () => { entered.resolve(); await finish.promise; } });
  const replies = await Promise.all([f.manager.start(context), f.manager.start(context)]);
  await entered.promise;
  assert.equal(replies[0].removal?.id, replies[1].removal?.id);
  finish.resolve();
  await f.manager.awaitIdle(context);
  const completed = await f.manager.start(context);
  assert.equal(completed.removal?.id, replies[0].removal?.id);
  assert.deepEqual(f.calls, ['first', 'second']);
  assert.equal(f.removed.length, 1);
});

test('active browser, environment work and preparation refuse removal before recording consent', async t => {
  let browserActive = true;
  const f = await fixture(t, { browserActive: () => browserActive });
  await assert.rejects(f.manager.start(context), /browser/i);
  assert.equal(f.manager.view(context).removal, null);
  browserActive = false;
  const release = f.usage.acquire({ key: 'other', stageId: 'gamma' }, { environmentId: 'first', operation: 'browser' });
  await assert.rejects(f.manager.start(context), /busy|progress|use|running|operations/i);
  release();
  f.items[0].status = 'preparing';
  await assert.rejects(f.manager.start(context), /operation|prepar|finish/i);
  assert.equal(f.manager.view(context).removal, null);
  assert.deepEqual(f.calls, []);
});

test('cleanup failure preserves the stage and barrier, and explicit retry reuses the intent', async t => {
  let fail = true;
  const f = await fixture(t, { cleanup: async id => { if (id === 'second' && fail) throw new Error('Docker is unavailable'); } });
  const first = await f.manager.start(context);
  await f.manager.awaitIdle(context);
  assert.equal(f.manager.view(context).removal?.status, 'failed');
  assert.match(f.manager.view(context).removal!.error!, /Docker is unavailable/);
  assert.deepEqual(f.manager.view(context).removal?.completedEnvironmentIds, ['first']);
  assert.equal(f.removed.length, 0);
  assert.throws(() => f.usage.acquire(context, { operation: 'create' }), /remov|delet/i);
  fail = false;
  const second = await f.manager.start(context);
  await f.manager.awaitIdle(context);
  assert.equal(second.removal?.id, first.removal?.id);
  assert.deepEqual(f.calls, ['first', 'second', 'second']);
  assert.equal(f.removed.length, 1);
});

test('close joins current cleanup, checkpoints the remaining work, and restart completes it', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { cleanup: async id => { if (id === 'first') { entered.resolve(); await finish.promise; } } });
  await f.manager.start(context);
  await entered.promise;
  let closed = false;
  const closing = f.manager.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  finish.resolve();
  await closing;
  assert.deepEqual(f.calls, ['first']);
  assert.equal(f.removed.length, 0);
  assert.equal(f.manager.view(context).removal?.status, 'queued');
  await assert.rejects(f.manager.start(context), /shutting down/i);
  const resumed = await fixture(t, { dataDir: f.dataDir, items: f.items });
  await resumed.manager.awaitIdle(context);
  assert.deepEqual(resumed.calls, ['second']);
  assert.equal(resumed.removed.length, 1);
  assert.equal(resumed.manager.view(context).removal?.status, 'completed');
});

test('restart restores failed intent protection without silently retrying failed cleanup', async t => {
  const f = await fixture(t, { cleanup: async () => { throw new Error('Still owned'); } });
  await f.manager.start(context);
  await f.manager.awaitIdle(context);
  await f.manager.close();
  const resumed = await fixture(t, { dataDir: f.dataDir, items: f.items });
  await resumed.manager.awaitIdle(context);
  assert.deepEqual(resumed.calls, []);
  assert.equal(resumed.manager.view(context).removal?.status, 'failed');
  assert.throws(() => resumed.usage.acquire(context, { operation: 'create' }), /remov|delet/i);
  await resumed.manager.start(context);
  await resumed.manager.awaitIdle(context);
  assert.equal(resumed.manager.view(context).removal?.status, 'completed');
});

test('missing ownership metadata is not treated as successful cleanup', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { cleanup: async () => { entered.resolve(); await finish.promise; } });
  await f.manager.start(context);
  await entered.promise;
  f.items.splice(1, 1);
  finish.resolve();
  await f.manager.awaitIdle(context);
  assert.equal(f.manager.view(context).removal?.status, 'failed');
  assert.match(f.manager.view(context).removal!.error!, /confirm|missing|ownership/i);
  assert.equal(f.removed.length, 0);
});

test('already destroyed and clean failed environments need no cleanup, and other stages are untouched', async t => {
  const items: PublicEnvironment[] = [ { ...ready('deleted'), status: 'destroyed' }, { ...ready('failed'), status: 'failed', cleanedAt: 'earlier' }, { ...ready('other'), stageId: 'gamma' } ];
  const f = await fixture(t, { items });
  await f.manager.start(context);
  await f.manager.awaitIdle(context);
  assert.deepEqual(f.calls, []);
  assert.equal(f.removed.length, 1);
  assert.equal(items[2].status, 'ready');
});
