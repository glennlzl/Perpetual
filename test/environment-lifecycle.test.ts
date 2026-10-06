import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentUsage, holdsResources, scopeId } from '../src/environments/usage.ts';
import type { EnvironmentManager, EnvironmentRecord, ManagedRuntime } from '../src/environments/manager.ts';
import type { EnvironmentUsage } from '../src/environments/usage.ts';

const context = { key: 'local:fixture', stageId: 'beta', scan: { repo: { path: '/fixture/source', sha: 'fixture-revision', branch: 'main' }, services: [] } };
const plan = { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } };
const deferred = () => { let resolve!: () => void, reject!: (reason?: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ready = { status: 'ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:50123' }] } satisfies Partial<EnvironmentRecord>;
const exists = (path: string) => access(path).then(() => true, () => false);
const unexpected = async () => { throw new Error('Unexpected runtime operation'); };
// A runtime with only the calls a test expects; any other call fails as it would without it.
const only = (calls: Partial<ManagedRuntime>) => calls as ManagedRuntime;

// After-hooks run in the order they are registered, and the fixture's hook closes the manager, which waits for every
// runtime call: a test registers the hook that ends a blocked call before calling fixture, so a failure cannot hang it.
async function fixture(t: TestContext, overrides: Partial<ManagedRuntime> = {}, options: Partial<Parameters<typeof createEnvironmentManager>[0]> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-lifecycle-'));
  const usage = createEnvironmentUsage();
  const runtime: ManagedRuntime = { prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); return structuredClone(ready); },
    environmentLogs: async () => '', environmentHealth: async () => ({ status: 'ready' }), destroySandbox: async () => {}, ...overrides };
  const manager = await createEnvironmentManager({ dataDir, usage, runtime, ...options });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.savePlan(context, plan);
  return { manager, dataDir, usage, runtime };
}

async function createReady(manager: EnvironmentManager) {
  const { environment } = await manager.create(context);
  const settled = await manager.awaitIdle(environment.id);
  assert.equal(settled.status, 'ready');
  return settled;
}

async function remainsPending(promise: Promise<unknown>) {
  assert.equal(await Promise.race([promise.then(() => 'done'), delay(15).then(() => 'pending')]), 'pending');
}

test('close waits for an allocated create to clean up and persists cleanup ownership before returning', async t => {
  const entered = deferred(), release = deferred(), cleaning = deferred(), cleaned = deferred();
  const { manager, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate, cancelled }) => {
      await onUpdate({ sandboxId: environment.id, status: 'preparing' }); entered.resolve();
      await release.promise;
      assert.equal(cancelled(), true);
      throw new Error('Controller is shutting down.');
    },
    destroySandbox: async ({ environment }) => { assert.equal(environment.sandboxId, environment.id); cleaning.resolve(); await cleaned.promise; },
  });
  const { environment } = await manager.create(context);
  await entered.promise;
  const closing = manager.close();
  await remainsPending(closing);
  await assert.rejects(manager.create(context), /shutting down/);
  release.resolve(); await cleaning.promise;
  await remainsPending(closing);
  cleaned.resolve(); await closing;
  const saved = JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8'));
  assert.equal(saved.environments[0].id, environment.id);
  assert.equal(saved.environments[0].status, 'failed');
  assert.ok(saved.environments[0].cleanedAt);
});

test('Stop keeps creation busy until the running operation and its sandbox cleanup finish', async t => {
  const entered = deferred(), stopped = deferred(), cleaning = deferred(), cleaned = deferred();
  let signal: AbortSignal | undefined;
  const { manager, usage } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate, signal: input }) => {
      signal = input;
      await onUpdate({ sandboxId: environment.id, status: 'preparing', step: 'Setting up dependency' }); entered.resolve();
      await stopped.promise;
      throw new Error('Environment creation cancelled.');
    },
    destroySandbox: async () => { cleaning.resolve(); await cleaned.promise; },
  });
  t.after(() => { stopped.resolve(); cleaned.resolve(); });
  const { environment } = await manager.create(context); await entered.promise;
  try {
    const reply = await manager.cancel(context, environment.id);
    assert.equal(reply.environment.step, 'Stopping');
    assert.ok(reply.environment.cancellationRequestedAt);
    assert.equal(signal?.aborted, true);
    assert.equal(usage.isBusy(environment.id), true);
    const settled = manager.awaitIdle(environment.id);
    await remainsPending(settled);
    stopped.resolve(); await cleaning.promise;
    assert.equal((await manager.view(context)).environments[0].step, 'Stopping');
    assert.equal(usage.isBusy(environment.id), true);
    await remainsPending(settled);
    cleaned.resolve();
    const final = await settled;
    assert.equal(final.status, 'failed'); assert.equal(final.step, 'Stopped'); assert.ok(final.cleanedAt);
    assert.equal(usage.isBusy(environment.id), false);
  } finally { stopped.resolve(); cleaned.resolve(); }
});

test('Stop preserves the source and ownership when sandbox cleanup fails', async t => {
  const entered = deferred(), stopped = deferred();
  let snapshot = '';
  const { manager } = await fixture(t, {
    prepareEnvironment: async ({ environment, directory, onUpdate }) => {
      snapshot = join(directory, 'source'); await mkdir(snapshot); await writeFile(join(snapshot, 'app.mjs'), 'app');
      await onUpdate({ sandboxId: environment.id, status: 'preparing' }); entered.resolve();
      await stopped.promise; throw new Error('Environment creation cancelled.');
    },
    destroySandbox: async () => { throw new Error('Docker cleanup unavailable'); },
  });
  const { environment } = await manager.create(context); await entered.promise;
  try { await manager.cancel(context, environment.id); } finally { stopped.resolve(); }
  const final = await manager.awaitIdle(environment.id);
  assert.equal(final.status, 'cleanup_failed'); assert.equal(final.sandboxId, environment.id);
  assert.match(final.cleanupError!, /Docker cleanup unavailable/);
  assert.equal(await exists(join(snapshot, 'app.mjs')), true);
});

test('close owns create admission even before its background job has been queued', async t => {
  let preparations = 0;
  const { manager, usage, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ cancelled }) => { preparations++; assert.equal(cancelled(), true); throw new Error('Environment creation cancelled.'); },
  });
  const creation = manager.create(context);
  assert.throws(() => usage.beginRemoval(context), { statusCode: 409 });
  const closing = manager.close();
  const { environment } = await creation;
  await closing;
  assert.equal(preparations, 1);
  assert.equal(usage.isBusy(environment.id), false);
  const saved = JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8'));
  assert.equal(saved.environments[0].status, 'failed');
  assert.equal(saved.environments[0].sandboxId, undefined);
});

test('close waits for destroy failure and retains the owned resource for retry', async t => {
  const entered = deferred(), release = deferred();
  const { manager, dataDir } = await fixture(t, { destroySandbox: async () => { entered.resolve(); await release.promise; throw new Error('Cleanup unavailable'); } });
  const environment = await createReady(manager);
  await manager.destroy(context, environment.id); await entered.promise;
  const closing = manager.close(); await remainsPending(closing);
  release.resolve(); await closing;
  const saved = JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8'));
  assert.equal(saved.environments[0].status, 'cleanup_failed');
  assert.equal(saved.environments[0].sandboxId, environment.id);
  assert.match(saved.environments[0].error, /Cleanup unavailable/);
});

test('shared environment usage blocks deletion across stages and a pending deletion blocks other use', async t => {
  const destroying = deferred(), finishDestroy = deferred();
  const { manager, usage } = await fixture(t, { destroySandbox: async () => { destroying.resolve(); await finishDestroy.promise; } });
  const environment = await createReady(manager);
  const releaseBrowser = usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: environment.id, operation: 'browser-run' });
  await assert.rejects(manager.destroy(context, environment.id), { statusCode: 409 });
  assert.equal(manager.resolveTarget('http://localhost:50123/')?.status, 'ready');
  releaseBrowser();
  await manager.destroy(context, environment.id);
  await destroying.promise;
  assert.throws(() => usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: environment.id, operation: 'browser-run' }), { statusCode: 409 });
  finishDestroy.resolve();
  assert.equal((await manager.awaitIdle(environment.id)).status, 'destroyed');
  assert.equal(usage.isBusy(environment.id), false);
});

test('create hands the ready environment lease to browser preparation and joins that follow-up', async t => {
  const entered = deferred(), finish = deferred();
  let usage: EnvironmentUsage;
  const setup = await fixture(t, {}, { onReady: async (scope, environment) => {
    const release = usage.acquire(scope, { environmentId: environment.id, operation: 'browser-discovery' });
    entered.resolve();
    try { await finish.promise; } finally { release(); }
  } });
  usage = setup.usage;
  const environment = await createReady(setup.manager);
  await entered.promise;
  const closing = setup.manager.close(); await remainsPending(closing);
  finish.resolve(); await closing;
  assert.equal(usage.isBusy(environment.id), false);
});

test('close joins an in-flight health check and does not admit an overlapping check', async t => {
  const entered = deferred(), finish = deferred();
  let healthCalls = 0;
  const { manager, usage } = await fixture(t, { environmentHealth: async () => { healthCalls++; entered.resolve(); await finish.promise; return { status: 'ready' }; } });
  const environment = await createReady(manager);
  const ticking = manager.tick(); await entered.promise;
  await manager.tick(); assert.equal(healthCalls, 1);
  const closing = manager.close(); await remainsPending(closing);
  finish.resolve(); await ticking; await closing;
  assert.equal(usage.isBusy(environment.id), false);
});

test('a creation first deletes the stage’s earlier twin that still holds resources, and one that cannot be deleted stops it', async t => {
  const destroyed: string[] = [];
  let cleanup: Error | null = null;
  const { manager } = await fixture(t, {
    environmentHealth: async () => ({ status: 'failed', final: true, error: 'Stopped: app exited (1).' }),
    destroySandbox: async ({ environment }) => { if (cleanup) throw cleanup; destroyed.push(environment.id); },
  });
  const first = await createReady(manager);
  // Docker restarted: the monitor fails the twin, which still owns its containers, ports and snapshot.
  await manager.tick();
  assert.deepEqual([manager.summaries(context.key)[0].step, holdsResources(manager.summaries(context.key)[0])], ['Unhealthy', true]);
  // A creation refused for its config deletes nothing.
  await manager.savePlan(context, { services: {}, apps: {} });
  await assert.rejects(manager.create(context), /Add an app/);
  assert.deepEqual([destroyed, manager.summaries(context.key).map(item => item.status)], [[], ['failed']]);
  await manager.savePlan(context, plan);
  const second = await createReady(manager);
  assert.deepEqual(destroyed, [first.id]);
  assert.deepEqual(manager.summaries(context.key).map(item => [item.id, item.status]), [[second.id, 'ready'], [first.id, 'destroyed']]);
  // A twin whose deletion fails keeps its resources, and the creation fails with the cleanup error.
  cleanup = new Error('compose down failed');
  await assert.rejects(manager.create(context), /compose down failed/);
  assert.deepEqual(manager.summaries(context.key).map(item => [item.id, item.status]), [[second.id, 'cleanup_failed'], [first.id, 'destroyed']]);
  // Creating again retries the deletion.
  cleanup = null;
  const third = await createReady(manager);
  assert.deepEqual(destroyed, [first.id, second.id]);
  assert.deepEqual(manager.summaries(context.key).filter(holdsResources).map(item => item.id), [third.id]);
});

test('a creation from another checkout of the same source replaces the twin an earlier checkout built', async t => {
  const destroyed: string[] = [];
  const { manager } = await fixture(t, { destroySandbox: async ({ environment }) => { destroyed.push(environment.id); } });
  const earlier = await createReady(manager);
  // The source saved again on dev is checked out afresh, under the same pipeline and stage.
  const switched = { ...context, scan: { repo: { path: '/fixture/source-dev', sha: 'fixture-dev-revision', branch: 'dev' }, services: [] } };
  const replaced = await manager.awaitIdle((await manager.create(switched)).environment.id);
  assert.deepEqual([replaced.status, replaced.repoPath, replaced.sourceBranch], ['ready', '/fixture/source-dev', 'dev']);
  assert.deepEqual(destroyed, [earlier.id]);
  assert.deepEqual(manager.summaries(context.key).filter(holdsResources).map(item => item.id), [replaced.id]);
});

test('a creation after a controller crash deletes the twin the interrupted operation left', async t => {
  const destroyed: string[] = [];
  const f = await fixture(t, { destroySandbox: async ({ environment }) => { destroyed.push(environment.id); } });
  const interrupted = await createReady(f.manager);
  await f.manager.close();
  // The controller was killed while it prepared this twin.
  const file = join(f.dataDir, 'environments/state.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(saved.environments[0], { status: 'preparing', step: 'Preparing twin' });
  await writeFile(file, JSON.stringify(saved));
  const manager = await createEnvironmentManager({ dataDir: f.dataDir, runtime: f.runtime });
  try {
    assert.equal(manager.summaries(context.key)[0].status, 'cleanup_failed');
    const { environment } = await manager.create(context);
    assert.equal((await manager.awaitIdle(environment.id)).status, 'ready');
    assert.deepEqual(destroyed, [interrupted.id]);
  } finally { await manager.close(); }
});

test('a creation waits for the health check of the twin it replaces, and names that twin when another use holds it', async t => {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const checking = deferred(), checked = deferred();
  t.after(() => checked.resolve());
  const stopped = { status: 'failed', final: true, error: 'Stopped: app exited (1).' };
  let check = async () => stopped;
  const destroyed: string[] = [];
  const { manager, usage } = await fixture(t, { environmentHealth: () => check(), destroySandbox: async ({ environment }) => { destroyed.push(environment.id); } });
  const first = await createReady(manager);
  await manager.tick();
  assert.equal(manager.summaries(context.key)[0].step, 'Unhealthy');
  // The monitor rechecks the stopped twin as a person creates the stage's environment.
  check = async () => { checking.resolve(); await checked.promise; return stopped; };
  time += 30_000;
  const ticking = manager.tick();
  await checking.promise;
  const creating = manager.create(context);
  await remainsPending(creating);
  checked.resolve(); await ticking;
  const second = await manager.awaitIdle((await creating).environment.id);
  assert.equal(second.status, 'ready');
  assert.deepEqual(destroyed, [first.id]);
  // A journey run holds the twin until it finishes: the creation is refused, and the twin kept.
  const releaseRun = usage.acquire(context, { environmentId: second.id, operation: 'browser-run' });
  await assert.rejects(manager.create(context), { statusCode: 409, message: 'The stage’s previous twin is in use. Create the environment again once it is free.' });
  releaseRun();
  assert.deepEqual(manager.summaries(context.key).map(item => [item.id, item.status]), [[second.id, 'ready'], [first.id, 'destroyed']]);
});

test('a stage at the local limit can replace its own twin, and another stage cannot add one', async t => {
  const { manager } = await fixture(t);
  const stages = Array.from({ length: 8 }, (_, index) => ({ ...context, stageId: `stage-${index}` }));
  for (const stage of stages) {
    await manager.savePlan(stage, plan);
    const { environment } = await manager.create(stage);
    assert.equal((await manager.awaitIdle(environment.id)).status, 'ready');
  }
  const ninth = { ...context, stageId: 'stage-8' };
  await manager.savePlan(ninth, plan);
  await assert.rejects(manager.create(ninth), /local limit: eight/);
  const { environment } = await manager.create(stages[0]);
  assert.equal((await manager.awaitIdle(environment.id)).status, 'ready');
  assert.equal(manager.summaries(context.key).filter(holdsResources).length, 8);
});

test('creates admitted together count toward the local limit before their environments are recorded', async t => {
  const { manager } = await fixture(t);
  const stages = Array.from({ length: 9 }, (_, index) => ({ ...context, stageId: `stage-${index}` }));
  for (const stage of stages) await manager.savePlan(stage, plan);
  for (const stage of stages.slice(0, 7)) {
    const { environment } = await manager.create(stage);
    assert.equal((await manager.awaitIdle(environment.id)).status, 'ready');
  }
  // Seven twins hold resources, and two stages create at once: only one fits.
  const [created, refused] = await Promise.allSettled([manager.create(stages[7]), manager.create(stages[8])]);
  assert.deepEqual([created.status, refused.status], ['fulfilled', 'rejected']);
  assert.match(String(refused.status === 'rejected' && refused.reason), /local limit: eight/);
  assert.equal(created.status === 'fulfilled' && (await manager.awaitIdle(created.value.environment.id)).status, 'ready');
  assert.equal(manager.summaries(context.key).filter(holdsResources).length, 8);
});

test('failed plan validation releases create admission', async t => {
  const { manager, usage } = await fixture(t);
  await manager.savePlan(context, { services: { mailpit: {} } });
  await assert.rejects(manager.create(context), /Add an app/);
  await assert.rejects(manager.savePlan(context, { services: { unknown: {} } }), /Unknown service/);
  const removal = usage.beginRemoval(context); usage.endRemoval(removal);
  await manager.savePlan(context, plan);
  const environment = await createReady(manager);
  assert.equal(usage.isBusy(environment.id), false);
});

test('failed admission persistence releases ownership and close reports an unwritable final state', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-storage-failure-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const usage = createEnvironmentUsage();
  const manager = await createEnvironmentManager({ dataDir, usage, runtime: only({ prepareEnvironment: unexpected }) });
  await manager.savePlan(context, plan);
  const file = join(dataDir, 'environments/state.json');
  await rm(file); await mkdir(file);
  await assert.rejects(manager.create(context), /EISDIR|ENOTEMPTY|rename/);
  const removal = usage.beginRemoval(context); usage.endRemoval(removal);
  await assert.rejects(manager.close(), /EISDIR|ENOTEMPTY|rename/);
});

test('restarted owned twins expose host-browser app links without rewriting stored URLs', async t => {
  const legacy = 'http://host.docker.internal:50123/workspace?tab=billing#plan', external = 'https://preview.example/workspace';
  const { manager, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => {
      await onUpdate({ sandboxId: environment.id });
      return { ...ready, apps: [{ id: 'app', url: legacy }, { id: 'preview', url: external }] };
    },
  });
  const created = await createReady(manager);
  await manager.close();
  const reopened = await createEnvironmentManager({ dataDir, runtime: only({ prepareEnvironment: unexpected, destroySandbox: unexpected, environmentHealth: unexpected, environmentLogs: unexpected }), onReady: unexpected });
  try {
    const expected = [{ id: 'app', url: 'http://127.0.0.1:50123/workspace?tab=billing#plan' }, { id: 'preview', url: external }];
    assert.deepEqual((await reopened.view(context)).environments[0].apps, expected);
    assert.deepEqual(reopened.summaries(context.key)[0].apps, expected);
    assert.deepEqual(reopened.resolveTarget(legacy)?.apps, expected);
    assert.equal(reopened.resolveTarget(expected[0].url)?.id, created.id);
    const stored = JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8'));
    assert.equal(stored.environments[0].apps[0].url, legacy);
  } finally { await reopened.close(); }
});

test('environments without twin ownership preserve their application URLs', async t => {
  const { manager } = await fixture(t, { prepareEnvironment: async () => structuredClone(ready) });
  const environment = await createReady(manager);
  assert.equal(environment.apps[0].url, ready.apps[0].url);
});

test('a stage keeps the records of its newest ten twins that are gone, and one a stage removal still names', async t => {
  let fail = false;
  const { manager, usage, dataDir } = await fixture(t, { prepareEnvironment: async ({ environment, onUpdate }) => {
    await onUpdate({ sandboxId: environment.id });
    if (fail) throw new Error('The app did not start.');
    return structuredClone(ready);
  } });
  const gamma = { ...context, stageId: 'gamma' };
  await manager.savePlan(gamma, plan);
  const { environment: other } = await manager.create(gamma);
  assert.equal((await manager.awaitIdle(other.id)).status, 'ready');
  await manager.destroy(gamma, other.id);
  assert.equal((await manager.awaitIdle(other.id)).status, 'destroyed');
  // Each creation deletes the stage's twin before it: twelve leave eleven deleted twins, and the oldest record goes.
  const ids: string[] = [];
  for (let index = 0; index < 12; index += 1) ids.push((await createReady(manager)).id);
  const beta = (records: { id: string; stageId: string }[]) => records.filter(item => item.stageId === 'beta').map(item => item.id).sort();
  assert.deepEqual(beta(manager.summaries(context.key)), [...ids.slice(1)].sort());
  const saved = async () => JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8')).environments as { id: string; stageId: string }[];
  assert.deepEqual(beta(await saved()), [...ids.slice(1)].sort());
  assert.ok(manager.summaries(context.key).some(item => item.id === other.id), 'Another stage keeps its own.');
  // A record a stage removal names stays while the removal holds it.
  const token = usage.beginRemoval(context, [ids[11], ids[1]]);
  await manager.destroy(context, ids[11], { removalToken: token });
  assert.equal((await manager.awaitIdle(ids[11])).status, 'destroyed');
  assert.deepEqual(beta(manager.summaries(context.key)), [...ids.slice(1)].sort());
  usage.endRemoval(token);
  // A failed creation's twin is gone too, once it is cleaned up: the two oldest go, and its record is the newest.
  fail = true;
  const { environment: failed } = await manager.create(context);
  assert.equal((await manager.awaitIdle(failed.id)).status, 'failed');
  assert.deepEqual(beta(await saved()), [...ids.slice(3), failed.id].sort());
});

test('an application URL of a twin whose record was dropped resolves to the stage’s twin that is not ready, never to an external app', async t => {
  let port = 50200;
  const { manager, dataDir } = await fixture(t, { prepareEnvironment: async ({ environment, onUpdate }) => {
    await onUpdate({ sandboxId: environment.id });
    return { status: 'ready', services: [], apps: [{ id: 'app', url: `http://host.docker.internal:${port++}` }] };
  } });
  const ids: string[] = [];
  for (let index = 0; index < 12; index += 1) ids.push((await createReady(manager)).id);
  assert.ok(!manager.summaries(context.key).some(item => item.id === ids[0]), 'The oldest gone twin’s record is dropped.');
  const dropped = manager.resolveTarget('http://localhost:50200/');
  assert.deepEqual([dropped?.status, dropped?.stageId], ['destroyed', 'beta']);
  assert.equal(manager.resolveTarget('http://localhost:50211/')?.id, ids[11]);
  assert.equal(manager.resolveTarget('http://localhost:50212/'), null, 'An address no twin had is an external app.');
  // A restart keeps them, and the newest gone twin keeps at most 50 such addresses, the newest.
  await manager.close();
  const file = join(dataDir, 'environments/state.json'), state = JSON.parse(await readFile(file, 'utf8'));
  const oldest = state.environments.find((item: { id: string }) => item.id === ids[1]);
  oldest.origins = Array.from({ length: 60 }, (_, index) => `http://127.0.0.1:${51000 + index}`);
  await writeFile(file, JSON.stringify(state));
  const restarted = await createEnvironmentManager({ dataDir, runtime: { prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); return structuredClone(ready); },
    environmentLogs: async () => '', environmentHealth: async () => ({ status: 'ready' }), destroySandbox: async () => {} } });
  try {
    assert.equal(restarted.resolveTarget('http://localhost:50200/')?.status, 'destroyed');
    // The next creation deletes the ready twin, and the record that held the 60 addresses is dropped.
    await createReady(restarted);
    assert.ok(!restarted.summaries(context.key).some(item => item.id === ids[1]));
    assert.equal(restarted.resolveTarget('http://localhost:51048/')?.status, 'destroyed');
    assert.equal(restarted.resolveTarget('http://localhost:51049/'), null);
  } finally { await restarted.close(); }
});

test('a removed stage’s twin config, the scan it was detected from and its draft go, and other stages keep theirs', async t => {
  const { manager, dataDir } = await fixture(t);
  const gamma = { ...context, stageId: 'gamma' };
  await manager.savePlan(gamma, plan);
  await manager.close();
  // Beta's config is still detected, and its last generation failed.
  const file = join(dataDir, 'environments/state.json'), state = JSON.parse(await readFile(file, 'utf8')), beta = scopeId(context);
  Object.assign(state, { plans: { ...state.plans, [beta]: plan }, detected: { [beta]: 'scan' }, drafts: { [beta]: { text: '{}', feedback: '# Attempt 4 of 4' } } });
  await writeFile(file, JSON.stringify(state));
  const restarted = await createEnvironmentManager({ dataDir, runtime: only({}) });
  try { await restarted.forget([context]); } finally { await restarted.close(); }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([Object.keys(saved.plans), saved.detected, saved.drafts], [[scopeId(gamma)], {}, {}]);
});

test('the twins of a pipeline the active source left are deleted once free, and a creation under way is stopped', async t => {
  const entered = deferred(), cleaned: string[] = [], failing = new Set<string>();
  let active: string | null = context.key;
  const stage = (stageId: string) => ({ ...context, stageId });
  const { manager, usage } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate, signal }) => {
      await onUpdate({ sandboxId: environment.id });
      // Gamma's creation is under way until it is stopped.
      if (environment.stageId === 'gamma') {
        entered.resolve();
        await new Promise((_resolve, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      }
      return structuredClone(ready);
    },
    destroySandbox: async ({ environment }) => { if (failing.has(environment.id)) throw new Error('compose down failed'); cleaned.push(environment.id); },
  }, { activeKey: () => active });
  for (const id of ['gamma', 'delta', 'epsilon', 'zeta']) await manager.savePlan(stage(id), plan);
  const readyIn = async (stageId: string) => { const { environment } = await manager.create(stage(stageId)); return (await manager.awaitIdle(environment.id)).id; };
  const beta = (await createReady(manager)).id, delta = await readyIn('delta'), epsilon = await readyIn('epsilon'), zeta = await readyIn('zeta');
  // Epsilon's cleanup failed, a journey run holds delta, and a stage removal holds zeta.
  failing.add(epsilon);
  await manager.destroy(stage('epsilon'), epsilon);
  assert.equal((await manager.awaitIdle(epsilon)).status, 'cleanup_failed');
  failing.clear();
  const releaseRun = usage.acquire(stage('delta'), { environmentId: delta, operation: 'browser-run' });
  const removal = usage.beginRemoval(stage('zeta'), [zeta]);
  const { environment: { id: gamma } } = await manager.create(stage('gamma'));
  await entered.promise;
  // The active source keeps its twins.
  await manager.tick();
  assert.deepEqual(cleaned, []);
  // Another source becomes active.
  active = 'github:acme/app:/';
  await manager.tick();
  assert.deepEqual([(await manager.awaitIdle(beta)).status, (await manager.awaitIdle(gamma)).status], ['destroyed', 'failed']);
  assert.equal((await manager.awaitIdle(gamma)).step, 'Stopped', 'The creation under way is stopped and cleans up its twin.');
  const statuses = () => Object.fromEntries(manager.summaries(context.key).map(item => [item.id, item.status]));
  assert.deepEqual([statuses()[delta], statuses()[epsilon], statuses()[zeta]], ['ready', 'cleanup_failed', 'ready']);
  // The run ends, and the next pass deletes its twin; the removal deletes its own.
  releaseRun();
  await manager.tick();
  assert.equal((await manager.awaitIdle(delta)).status, 'destroyed');
  assert.deepEqual(cleaned.sort(), [beta, gamma, delta].sort());
  usage.endRemoval(removal);
  // While no source is active, nothing is deleted.
  active = null;
  await manager.tick();
  assert.equal(statuses()[zeta], 'ready');
});

test('owned-target resolution canonicalizes loopback aliases and retains stale ownership after deletion', async t => {
  const { manager } = await fixture(t);
  const environment = await createReady(manager);
  assert.equal(manager.resolveTarget('http://localhost:50123/workspace')?.id, environment.id);
  assert.equal(manager.resolveTarget('http://[::1]:50123/workspace')?.id, environment.id);
  assert.equal(manager.resolveTarget('http://host.docker.internal:50123/')?.id, environment.id);
  assert.equal(environment.apps[0].url, 'http://127.0.0.1:50123/');
  assert.equal(manager.resolveTarget('https://preview.example/workspace'), null);
  assert.equal(manager.resolveTarget('http://127.0.0.1:50124/'), null);
  await manager.destroy(context, environment.id); await manager.awaitIdle(environment.id);
  assert.equal(manager.resolveTarget('http://localhost:50123/')?.status, 'destroyed');
});

test('an origin resolves to the twin that holds it over a deleted twin that used the same ports', async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const { manager } = await fixture(t, { prepareEnvironment: async ({ environment, onUpdate }) => {
    await onUpdate({ sandboxId: environment.id });
    if (environment.stageId === context.stageId) await release.promise;
    return structuredClone(ready);
  } });
  const gamma = { ...context, stageId: 'gamma' };
  await manager.savePlan(gamma, plan);
  const { environment: older } = await manager.create(context);
  // Another stage's twin takes the free ports, becomes ready and is deleted while the first still prepares.
  const { environment: newer } = await manager.create(gamma);
  assert.equal((await manager.awaitIdle(newer.id)).status, 'ready');
  await manager.destroy(gamma, newer.id);
  assert.equal((await manager.awaitIdle(newer.id)).status, 'destroyed');
  release.resolve();
  assert.equal((await manager.awaitIdle(older.id)).status, 'ready');
  assert.equal(manager.resolveTarget('http://localhost:50123/')?.id, older.id);
});

test('a ready twin runs from its source snapshot until deletion; a failed twin is cleaned up with it', async t => {
  let fail = false, keepTwin = false;
  const cleaned: string[] = [];
  const { manager, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ environment, directory, onUpdate }) => {
      await mkdir(join(directory, 'source')); await writeFile(join(directory, 'source', 'app.mjs'), 'snapshot');
      await mkdir(join(directory, 'twin')); await writeFile(join(directory, 'twin', 'twin.json'), '{}');
      await onUpdate({ sandboxId: environment.id });
      if (fail) throw new Error('web did not become healthy');
      return structuredClone(ready);
    },
    environmentLogs: async () => 'web | crashed\n',
    destroySandbox: async ({ environment }) => {
      if (keepTwin) throw new Error('compose down failed');
      cleaned.push(environment.id); await rm(join(dataDir, 'environments', environment.id, 'twin'), { recursive: true });
    },
  });
  const directory = (id: string) => join(dataDir, 'environments', id);
  const environment = await createReady(manager);
  assert.ok(await exists(join(directory(environment.id), 'source')), 'A ready twin keeps the snapshot its apps mount.');
  await manager.destroy(context, environment.id);
  assert.equal((await manager.awaitIdle(environment.id)).status, 'destroyed');
  assert.equal(await exists(directory(environment.id)), false, 'Deletion leaves no environment directory behind.');
  fail = true;
  const { environment: failed } = await manager.create(context);
  const settled = await manager.awaitIdle(failed.id);
  assert.equal(settled.status, 'failed');
  assert.ok(settled.cleanedAt);
  assert.deepEqual(cleaned, [environment.id, failed.id]);
  assert.equal(await exists(directory(failed.id)), false);
  assert.deepEqual(await manager.logs(context, failed.id), { logs: 'web | crashed\n' });
  keepTwin = true;
  const { environment: stuck } = await manager.create(context);
  assert.equal((await manager.awaitIdle(stuck.id)).status, 'cleanup_failed');
  assert.ok(await exists(join(directory(stuck.id), 'twin', 'twin.json')), 'A twin whose cleanup failed keeps its files for another attempt.');
});

test('loading replaces a pre-twin plan with detection and retires a Cua guest until it is deleted', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-environment-legacy-')));
  let manager: EnvironmentManager | undefined;
  t.after(async () => { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const repo = join(dataDir, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { express: '1.0.0' }, scripts: { start: 'node server.js' } }));
  const scoped = { ...context, scan: { repo: { path: repo }, services: [{ id: 'service:.', path: '.', framework: 'Express' }] } };
  const scope = createHash('sha256').update(`${scoped.key}\0${scoped.stageId}`).digest('hex');
  const ids = { ready: randomUUID(), cleaned: randomUUID(), cleanup: randomUUID() };
  const legacy = { services: [{ id: 'web', name: 'Web', directory: '.', installCommand: 'npm ci', startCommand: 'npm start', port: 3000, readyPath: '/', env: {} }] };
  const guest = { scope, pipelineKey: scoped.key, stageId: scoped.stageId, sandboxId: '6f1c2f56-8f52-4b0c-9d55-7a1c2f7b9e10', plan: legacy, services: [{ id: 'web', url: 'http://127.0.0.1:53000' }], serviceOrigins: ['http://127.0.0.1:53000'] };
  await mkdir(join(dataDir, 'environments'), { mode: 0o700 });
  await writeFile(join(dataDir, 'environments', 'state.json'), JSON.stringify({ version: 1, plans: { [scope]: legacy }, environments: [
    { ...guest, id: ids.ready, status: 'ready' },
    { ...guest, id: ids.cleaned, status: 'failed', cleanedAt: '2026-09-22T00:00:00.000Z', serviceOrigins: [] },
    { ...guest, id: ids.cleanup, status: 'cleanup_failed', serviceOrigins: [] },
  ] }));
  const destroyed: (string | undefined)[] = [];
  manager = await createEnvironmentManager({ dataDir, runtime: only({ destroySandbox: async ({ environment }) => { destroyed.push(environment.sandboxId); } }) });
  const view = await manager.view(scoped);
  assert.deepEqual(view.plan, { services: {}, apps: { service: { directory: '.', build: 'npm install', start: 'npm run start', port: 3000 } } });
  const byId = Object.fromEntries(view.environments.map(item => [item.id, item]));
  assert.deepEqual({ status: byId[ids.ready].status, step: byId[ids.ready].step, error: byId[ids.ready].error, services: byId[ids.ready].services },
    { status: 'failed', step: 'Retired', error: 'Delete this environment to remove its Cua guest.', services: [] });
  assert.equal(byId[ids.cleaned].status, 'failed');
  assert.equal(byId[ids.cleaned].step, undefined, 'A cleaned guest is already gone.');
  assert.equal(byId[ids.cleanup].status, 'cleanup_failed');
  assert.equal(manager.resolveTarget('http://localhost:53000/')?.id, ids.ready, 'A retired guest keeps its address until deletion.');
  await manager.destroy(scoped, ids.ready);
  assert.equal((await manager.awaitIdle(ids.ready)).status, 'destroyed');
  assert.deepEqual(destroyed, [guest.sandboxId]);
});

test('a twin that still runs adds its live logs to the evidence an earlier attempt left, while it prepares and once it is unhealthy', async t => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let output = 'web | starting';
  const { manager } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => {
      // A generation's second attempt: the first one's teardown evidence is already saved.
      await onUpdate({ sandboxId: environment.id, status: 'preparing', step: 'Preparing twin', logs: 'attempt 1 | web exited (1)' });
      entered.resolve(); await finish.promise;
      return structuredClone(ready);
    },
    environmentLogs: async () => output,
    environmentHealth: async () => ({ status: 'failed', final: true, error: 'Stopped: web exited (1).' }),
  });
  const { environment } = await manager.create(context);
  await entered.promise;
  assert.deepEqual(await manager.logs(context, environment.id), { logs: 'attempt 1 | web exited (1)\n\nweb | starting' });
  finish.resolve();
  assert.equal((await manager.awaitIdle(environment.id)).status, 'ready');
  // Its containers stop and the monitor fails it: the person sees why now, not only the earlier attempt's evidence.
  await manager.tick();
  assert.equal(manager.summaries(context.key)[0].step, 'Unhealthy');
  output = 'web | Error: connection refused';
  assert.deepEqual(await manager.logs(context, environment.id), { logs: 'attempt 1 | web exited (1)\n\nweb | Error: connection refused' });
});

test('a long failure keeps its start, which names the step, and its end, where the error is', async t => {
  const progress = Array.from({ length: 400 }, (_, index) => `layer${index}: Pulling fs layer`).join('\n');
  const { manager } = await fixture(t, { prepareEnvironment: async () => { throw new Error(`Supabase: ${progress}\nfailed to start: container is unhealthy`); } });
  const { environment } = await manager.create(context);
  const failed = await manager.awaitIdle(environment.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error!.length <= 1500);
  assert.match(failed.error!, /^Supabase: layer0: /);
  assert.match(failed.error!, /failed to start: container is unhealthy$/);
});

test('Creation failure persists redacted service evidence before owned teardown', async t => {
  let storedBeforeTeardown = '';
  const { manager, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); throw new Error('Auth request deadline; write outcome unknown'); },
    environmentLogs: async () => 'Auth log: password=private-fixture\ndatabase waiting\ngateway connected\n',
    destroySandbox: async () => { storedBeforeTeardown = await readFile(join(dataDir, 'environments/state.json'), 'utf8'); },
  });
  const { environment } = await manager.create(context), failed = await manager.awaitIdle(environment.id);
  assert.match(storedBeforeTeardown, /database waiting/);
  assert.doesNotMatch(storedBeforeTeardown, /private-fixture/);
  assert.match(failed.error!, /Auth request deadline; write outcome unknown/);
  const logs = await manager.logs(context, environment.id);
  assert.match(logs.logs, /gateway connected/);
  assert.doesNotMatch(logs.logs, /private-fixture/);
});

test('Log collection failure remains visible and does not replace the preparation or cleanup failure', async t => {
  const { manager } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); throw new Error('Original account failure'); },
    environmentLogs: async () => { throw new Error('log reader unavailable password=private-fixture'); },
    destroySandbox: async () => { throw new Error('cleanup unavailable'); },
  });
  const { environment } = await manager.create(context), failed = await manager.awaitIdle(environment.id);
  assert.equal(failed.status, 'cleanup_failed');
  assert.equal(failed.error, 'Original account failure');
  assert.match(failed.cleanupError!, /cleanup unavailable/);
  const logs = await manager.logs(context, environment.id);
  assert.match(logs.logs, /log.*unavailable/i);
  assert.doesNotMatch(logs.logs, /private-fixture/);
});

test('The first failed failure-state save still cleans resources and keeps the original failure', async t => {
  let data = '', cleaned = false;
  const { manager, dataDir } = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => {
      await onUpdate({ sandboxId: environment.id });
      const file = join(data, 'environments/state.json'); await rm(file); await mkdir(file);
      throw new Error('Original account failure');
    },
    environmentLogs: async () => 'Auth service evidence',
    destroySandbox: async () => { cleaned = true; await rm(join(data, 'environments/state.json'), { recursive: true }); },
  });
  data = dataDir;
  const { environment } = await manager.create(context), failed = await manager.awaitIdle(environment.id);
  assert.equal(cleaned, true);
  assert.equal(failed.error, 'Original account failure');
  assert.match((await manager.logs(context, environment.id)).logs, /could not be saved before cleanup/);
});

test('Expired evidence stays expired across repeated log reads and restart without dropping cleanup ownership', async t => {
  const f = await fixture(t, {
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); throw new Error('account failed'); },
    environmentLogs: async () => 'original private service evidence',
    destroySandbox: async () => { throw new Error('resources still owned'); },
  });
  const { environment } = await f.manager.create(context); await f.manager.awaitIdle(environment.id); await f.manager.close();
  const path = join(f.dataDir, 'environments/state.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.environments[0].logsAt = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(saved));
  const manager = await createEnvironmentManager({ dataDir: f.dataDir, runtime: only({ environmentLogs: async () => { assert.fail('expired evidence cannot fall through to the old twin logs'); } }) });
  try {
    for (let index = 0; index < 2; index++) assert.deepEqual(await manager.logs(context, environment.id), { logs: 'Failure evidence expired.' });
    const view = await manager.view(context);
    assert.equal(view.environments[0].status, 'cleanup_failed');
    assert.equal(view.environments[0].sandboxId, environment.id);
    assert.doesNotMatch(await readFile(path, 'utf8'), /original private service evidence/);
  } finally { await manager.close(); }
});
