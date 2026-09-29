import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentUsage } from '../src/environments/usage.ts';
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
