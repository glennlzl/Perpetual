import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserManager } from '../src/browser/manager.ts';
import { createEnvironmentUsage, isStageHeld, stageHeld } from '../src/environments/usage.ts';
import { createGateSteps, createReadiness, reviewedJourneys, type GateEnvironment, type GateBrowser, type GateEnvironments, type GateStepsOptions, type IdleEnvironment, type JourneySelection } from '../src/gate/steps.ts';

const context = { key: 'github:owner/app:/', stageId: 'beta', scan: { repo: { path: '/sources/app', sha: 'a'.repeat(40) } } };
type Context = typeof context & { sha?: string };
type HttpError = Error & { statusCode?: number };
type Fakes = { environments?: GateEnvironment[]; created?: IdleEnvironment; destroyed?: IdleEnvironment['status']; target?: string; resolves?: string; runs?: string[]; cases?: (JourneySelection & { id: string })[] };

// An environments manager and browser manager that record the gate's calls.
function fakes({ environments: list = [], created = { id: 'new', status: 'ready' }, destroyed = 'destroyed', target = 'http://127.0.0.1:43100', resolves = 'new', runs = ['queued', 'running', 'passed'], cases = [] }: Fakes = {}) {
  const calls: string[] = [], readiness = createReadiness();
  const environments: GateEnvironments<Context> = {
    summaries: key => (assert.equal(key, context.key), list),
    admitting: () => false,
    async destroy(ctx, id) { calls.push(`destroy ${id}`); },
    async awaitIdle(id) { calls.push(`await ${id}`); return id === created.id ? created : { id, status: destroyed, error: destroyed === 'destroyed' ? undefined : 'Docker refused to stop it.' }; },
    async create(ctx) { calls.push(`create ${ctx.stageId}`); if (created.status === 'ready') setTimeout(() => readiness.done(created.id), 5); return { environment: { id: created.id, status: 'queued' } }; },
    resolveTarget: url => (url === target ? { id: resolves } : null),
  };
  let polls = 0;
  const browser: GateBrowser<Context> = {
    isActive: () => false,
    summary: () => ({ cases }),
    async view() { return { config: { targetUrl: target } }; },
    async run(ctx, input) { calls.push(`run ${JSON.stringify(input)}`); return { run: { id: 'run-1', status: 'queued', environmentId: resolves } }; },
    async runProgress(ctx, id) { calls.push(`progress ${id}`); return { run: { id, status: runs[Math.min(polls++, runs.length - 1)] } }; },
  };
  return { calls, readiness, environments, browser };
}
const steps = (f: ReturnType<typeof fakes>, extra: Partial<GateStepsOptions<Context>> = {}) => createGateSteps<Context>({ environments: f.environments, browser: f.browser, readiness: f.readiness, checkout: async gate => ({ ...context, sha: gate.sha }), interval: 1, ...extra });

test('only reviewed, selected journeys count; drafts never run', () => {
  const cases = [{ id: 'a', selected: true }, { id: 'b', selected: true, needsReview: true }, { id: 'c', selected: false }, { id: 'd', selected: true, needsReview: false }];
  assert.deepEqual(reviewedJourneys(cases).map(item => item.id), ['a', 'd']);
  assert.equal(steps(fakes({ cases })).journeys(context), 2);
  assert.equal(steps(fakes()).journeys(context), 0);
});

test('a busy stage defers the gate before the source moves', async () => {
  const f = fakes({ environments: [{ id: 'old', stageId: 'beta', status: 'creating' }] });
  let moved = false;
  await assert.rejects(steps(f, { checkout: async () => { moved = true; return context; } }).prepare({ key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) }), (error: HttpError) => error.statusCode === 409);
  // Another stage's twin still copying the source also defers it; one that is only preparing does not.
  f.environments.summaries = () => [{ id: 'gamma', stageId: 'gamma', status: 'queued' }];
  await assert.rejects(steps(f, { checkout: async () => { moved = true; return context; } }).prepare({ key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) }), (error: HttpError) => error.statusCode === 409);
  f.environments.summaries = () => [{ id: 'gamma', stageId: 'gamma', status: 'preparing' }];
  assert.equal((await steps(f).prepare({ key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) })).sha, 'b'.repeat(40));
  f.environments.summaries = () => [];
  f.browser.isActive = () => true;
  await assert.rejects(steps(f, { checkout: async () => { moved = true; return context; } }).prepare({ key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) }), (error: HttpError) => error.statusCode === 409);
  assert.equal(moved, false);
  f.browser.isActive = () => false;
  assert.equal((await steps(f).prepare({ key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) })).sha, 'b'.repeat(40));
});

test('the source never moves under another stage\'s twin that is admitted but unrecorded, or still reads the checkout', async () => {
  const gate = { key: context.key, branch: 'main', stageId: 'beta', sha: 'b'.repeat(40) };
  const f = fakes();
  let moved = 0, admitting = true;
  const guarded = () => steps(f, { checkout: async () => { moved++; return context; } });
  f.environments.admitting = key => (assert.equal(key, context.key), admitting);
  await assert.rejects(guarded().prepare(gate), (error: HttpError) => error.statusCode === 409, 'A create another stage was admitted for, not yet recorded.');
  admitting = false;
  // A twin being prepared from a generated config reads the checkout, for its evidence and failure drafts, until it settles.
  f.environments.summaries = () => [{ id: 'gamma', stageId: 'gamma', status: 'preparing', readsCheckout: true }];
  await assert.rejects(guarded().prepare(gate), (error: HttpError) => error.statusCode === 409);
  assert.equal(moved, 0);
  f.environments.summaries = () => [{ id: 'gamma', stageId: 'gamma', status: 'preparing' }];
  await guarded().prepare(gate);
  assert.equal(moved, 1);
});

test('a twin is rebuilt only from a checkout that is exactly the gate\'s commit', async () => {
  const f = fakes();
  const checked: string[] = [];
  await assert.rejects(steps(f, { checkoutAt: async ctx => { checked.push(ctx.stageId); throw new Error('The checkout has uncommitted changes, which a twin would copy. Commit or discard them, then run again.'); } }).rebuild(context), /uncommitted changes/);
  assert.deepEqual([checked, f.calls], [['beta'], []], 'Nothing is deleted or created.');
  await steps(f, { checkoutAt: async () => {} }).rebuild(context);
  assert.deepEqual(f.calls, ['create beta', 'await new']);
});

test('rebuild deletes the stage twins that hold resources, creates a new twin and waits for its browser preparation', async () => {
  const f = fakes({ environments: [
    { id: 'ready', stageId: 'beta', status: 'ready', sandboxId: 'ready' },
    { id: 'cleanup', stageId: 'beta', status: 'cleanup_failed', sandboxId: 'cleanup' },
    { id: 'gone', stageId: 'beta', status: 'destroyed' },
    { id: 'failed-clean', stageId: 'beta', status: 'failed', sandboxId: 'failed-clean', cleanedAt: 'x' },
    { id: 'other', stageId: 'gamma', status: 'ready', sandboxId: 'other' },
  ] });
  let prepared = false;
  const wait = f.readiness.wait;
  f.readiness.wait = id => wait(id).then(() => { prepared = true; });
  const twin = await steps(f).rebuild(context);
  assert.equal(twin.id, 'new');
  assert.equal(prepared, true);
  assert.deepEqual(f.calls, ['destroy ready', 'await ready', 'destroy cleanup', 'await cleanup', 'create beta', 'await new']);
});

test('rebuild stops when the old twin cannot be deleted or the new one is not ready', async () => {
  await assert.rejects(steps(fakes({ environments: [{ id: 'old', stageId: 'beta', status: 'ready' }], destroyed: 'cleanup_failed' })).rebuild(context), /Docker refused to stop it/);
  const failed = fakes({ created: { id: 'new', status: 'failed', error: 'App web exited (1).' } });
  await assert.rejects(steps(failed).rebuild(context), /App web exited/);
});

test('rebuild gives up waiting for preparation when the controller shuts down', async () => {
  const f = fakes({ created: { id: 'new', status: 'ready' } });
  f.environments.create = async () => ({ environment: { id: 'new' } }); // onReady never runs after shutdown
  const stop = new AbortController();
  const pending = steps(f, { signal: stop.signal }).rebuild(context);
  setTimeout(() => stop.abort(), 5);
  await assert.rejects(pending, (error: HttpError) => error.statusCode === 409);
});

test('the run targets the rebuilt twin with the default reviewed selection and waits for its roll-up', async () => {
  const f = fakes();
  const run = await steps(f).run(context, { id: 'new', status: 'ready' });
  assert.deepEqual(run, { id: 'run-1', status: 'passed' });
  assert.deepEqual(f.calls, ['run {}', 'progress run-1', 'progress run-1', 'progress run-1']);
});

test('a health lease on the rebuilt twin delays browser admission and starts the journey only once', async () => {
  const f = fakes(), usage = createEnvironmentUsage();
  const releaseHealth = usage.acquire(context, { environmentId: 'new', operation: 'health' });
  let started = 0;
  f.browser.run = async () => {
    const release = usage.acquire(context, { environmentId: 'new', operation: 'browser run' });
    started++; release();
    return { run: { id: 'run-1', environmentId: 'new' } };
  };
  const running = steps(f).run(context, { id: 'new', status: 'ready' });
  const state = running.then(() => 'completed', () => 'failed');
  try {
    assert.equal(await Promise.race([state, delay(10).then(() => 'pending')]), 'pending');
    assert.equal(started, 0);
    releaseHealth();
    assert.equal((await running).status, 'passed');
    assert.equal(started, 1);
  } finally { releaseHealth(); }
});

test('a person\'s operation or a model settings save holding the stage delays browser admission and starts the journeys once', async () => {
  const f = fakes(), holds = ['A browser operation is already in progress for this stage.', 'Model settings are being saved. Please wait.'];
  let started = 0;
  f.browser.run = async () => {
    const hold = holds.shift();
    if (hold) throw stageHeld(hold);
    started++;
    return { run: { id: 'run-1', environmentId: 'new' } };
  };
  assert.equal((await steps(f).run(context, { id: 'new', status: 'ready' })).status, 'passed');
  assert.deepEqual([holds, started], [[], 1]);
});

test('the browser refuses a run while a person\'s save holds the stage, with a hold the gate waits for', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-steps-'));
  const runtime = { async capabilities() { return { runtimeInstalled: true, browserInstalled: true, modelConfigured: true }; }, start() { throw new Error('No journey starts while the stage is held.'); } };
  const manager = await createBrowserManager({ dataDir, runtime, playwright: runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const stage = { key: context.key, stageId: 'beta', scan: { repo: { path: dataDir, sha: 'a'.repeat(40) } } };
  const saving = manager.saveCases(stage, []);
  await assert.rejects(manager.run(stage, {}), (error: unknown) => isStageHeld(error));
  await saving;
});

test('a gate waiting for a health lease refuses a target changed before browser admission', async () => {
  const f = fakes(), usage = createEnvironmentUsage();
  const releaseHealth = usage.acquire(context, { environmentId: 'new', operation: 'health' });
  let started = 0;
  f.browser.run = async () => {
    const release = usage.acquire(context, { environmentId: 'new', operation: 'browser run' });
    started++; release(); return { run: { id: 'run-1', environmentId: 'new' } };
  };
  const running = steps(f).run(context, { id: 'new', status: 'ready' });
  const rejected = assert.rejects(running, /application URL to the rebuilt twin/);
  await delay(5);
  f.browser.view = async () => ({ config: { targetUrl: 'https://another.example.test/' } });
  releaseHealth();
  await rejected;
  assert.equal(started, 0);
});

test('a run the browser admitted for another application never becomes the gate\'s verdict', async () => {
  for (const environmentId of ['other', undefined]) {
    const f = fakes();
    // A person saved another application URL between the gate's check and the browser's admission.
    f.browser.run = async () => ({ run: { id: 'run-1', ...(environmentId ? { environmentId } : {}) } });
    await assert.rejects(steps(f).run(context, { id: 'new', status: 'ready' }), /application URL to the rebuilt twin/);
    assert.deepEqual(f.calls, [], 'The run is never followed for a verdict.');
  }
});

test('a run is refused when the application URL does not point at the rebuilt twin', async () => {
  const f = fakes({ resolves: 'old' });
  await assert.rejects(steps(f).run(context, { id: 'new', status: 'ready' }), /application URL to the rebuilt twin/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(steps(fakes({ target: '' })).run(context, { id: 'new', status: 'ready' }), /application URL/);
});

test('waiting for a run stops at shutdown', async () => {
  const f = fakes({ runs: ['running'] });
  const stop = new AbortController();
  const pending = steps(f, { signal: stop.signal, interval: 1000 }).run(context, { id: 'new', status: 'ready' });
  setTimeout(() => stop.abort(), 5);
  await assert.rejects(pending, (error: HttpError) => error.statusCode === 409);
});
