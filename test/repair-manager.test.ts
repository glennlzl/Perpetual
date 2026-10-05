import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseFailure } from '../src/providers.ts';
import { createRepairManager, type Repair, type RepairContext, type RepairGitHub, type RepairOutcome, type RepairSource, type RepairSteps } from '../src/repair/manager.ts';
import { autopilotStages } from '../src/repair/view.ts';
import type { BranchHeadInput } from '../src/gate/github.ts';
import type { WorkflowRun } from '../src/github-runs.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
const KEY = 'github:owner/app:/';
const CI = '.github/workflows/ci.yml', LINT = '.github/workflows/lint.yml';
const NO_AGENT = 'Automatic repair is unavailable. Fix the failure in a pull request.';
const LOGS = {
  build: "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  configuration: 'Error: VERCEL_TOKEN is required',
  availability: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
};
const PULL = { number: 7, url: 'https://github.com/owner/app/pull/7', branch: 'perpetual/repair/bbbbbbb' };
type HttpError = Error & { statusCode?: number };
type Saved = { version: number; repairs: Repair[]; autoMerge?: Record<string, boolean>; passed?: Record<string, string> };
const run = (id: string, sha: string, conclusion: string | null, { status = conclusion ? 'completed' : 'in_progress', attempt = 1, path = CI, branch = 'main', event = 'push' } = {}): WorkflowRun =>
  ({ id, workflowId: path === LINT ? '8' : '7', name: 'CI', path, event, status, conclusion, attempt, sha, branch, url: `https://github.com/owner/app/actions/runs/${id}`, createdAt: null, startedAt: null, updatedAt: null, jobs: [] });
// A failed run as the view names it.
const shown = (id: string, path = CI) => ({ id, name: 'CI', path, url: `https://github.com/owner/app/actions/runs/${id}` });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const aborted = (signal: AbortSignal) => new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }); });
// Hold the first terminal save at the filesystem boundary; all writes still use the real store.
async function holdTerminalSave(t: TestContext, dataDir: string) {
  const entered = deferred(), release = deferred(), write = fs.writeFile, root = await realpath(join(dataDir, 'repairs'));
  let held = false;
  const saving = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
    const [path, content] = args;
    if (!held && typeof path === 'string' && path.startsWith(join(root, '.state-')) && typeof content === 'string' && content.includes('"status":"needs-person"')) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: release.resolve, restore() { saving.mock.restore(); syncBuiltinESMExports(); } };
}
async function until(check: () => unknown) {
  for (let attempt = 0; attempt < 5000; attempt++) { if (check()) return; await new Promise(done => setTimeout(done, 2)); }
  throw new Error('The repair did not settle.');
}

// An agent step that records its contexts; behaviour defaults to a fix that is ready.
function agent(behaviour: (context: RepairContext, signal: AbortSignal) => Promise<RepairOutcome> = async () => ({ status: 'ready' }), extra: Partial<RepairSteps> = {}) {
  const contexts: RepairContext[] = [];
  const steps: RepairSteps = { unavailable: () => null, async repair(context, signal) { contexts.push(context); return behaviour(context, signal); }, ...extra };
  return { steps, contexts };
}

// Injected source and GitHub record what the manager read; nothing reaches the network, a model or Docker.
// clock: the milliseconds after 10:00 its clock starts at, such as a later start of the same controller.
async function harness(t: TestContext, { dataDir, steps, connection = { login: 'developer', repository: 'owner/app' }, clock = 0 }: { dataDir?: string; steps?: RepairSteps; connection?: { login: string; repository: string } | null; clock?: number } = {}) {
  const dir = dataDir ?? await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  let tick = clock;
  const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, 0, tick++)).toISOString();
  const current: RepairSource = { key: KEY, branch: 'main', repository: 'owner/app', checkoutPath: '/data/sources/github-1/app', rootDirectory: '/' };
  // hold, while set, keeps failure reads waiting; onRuns runs, and is awaited, within each runs read.
  const github = { head: A, headError: null as Error | null, rerunError: null as Error | null, connection, runs: {} as Record<string, WorkflowRun[]>, logs: {} as Record<string, string>, hold: null as Promise<void> | null, onRuns: null as (() => unknown) | null };
  const calls = { heads: [] as BranchHeadInput[], runs: [] as string[], failures: [] as string[], reruns: [] as string[], connections: 0 };
  const fake: RepairGitHub = {
    async connection() { calls.connections++; return github.connection; },
    async head(input) {
      calls.heads.push(input);
      if (github.headError) throw github.headError;
      const etag = `"${github.head.slice(0, 7)}"`;
      return input.etag === etag ? { status: 304 } : { status: 200, sha: github.head, etag };
    },
    async runs({ sha }) { calls.runs.push(sha); await github.onRuns?.(); return { runs: structuredClone(github.runs[sha] ?? []) }; },
    async failure({ runId }) {
      calls.failures.push(runId);
      if (github.hold) await github.hold;
      const log = github.logs[runId] ?? LOGS.build;
      return { runId, jobs: [{ id: `job-${runId}`, name: 'test', conclusion: 'failure', failedSteps: ['Typecheck'] }], log, tail: log, diagnosis: diagnoseFailure(log), observedAt: now() };
    },
    async rerun({ runId }) { calls.reruns.push(runId); if (github.rerunError) throw github.rerunError; },
  };
  const manager = await createRepairManager({ dataDir: dir, source: () => current, github: fake, steps, now });
  t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); });
  const saved = async (): Promise<Saved> => JSON.parse(await readFile(join(dir, 'repairs', 'state.json'), 'utf8'));
  // One poll and the work it started.
  const poll = async () => { await manager.check(); await manager.idle(); };
  const repair = (sha: string) => manager.view().repairs.find(item => item.sha === sha);
  // The first poll reads head A, a baseline; the next head is B, failed with the given runs.
  async function failHead(runs: WorkflowRun[], sha = B) {
    if (!calls.heads.length) await poll();
    github.head = sha;
    github.runs[sha] = runs;
    await manager.check();
  }
  return { manager, current, github, calls, dataDir: dir, saved, poll, repair, failHead };
}

test('the head seen at start is a baseline; a later head opens one repair once every run completed and one failed', async t => {
  const a = agent(async context => { await context.report({ status: 'verifying-ci', pullRequest: PULL }); return { status: 'ready' }; });
  const h = await harness(t, { steps: a.steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  assert.deepEqual(h.manager.view().repairs, [], 'A failed head first seen at start opens nothing.');
  assert.deepEqual([h.calls.runs, h.manager.view().head?.failed], [[A], [shown('1')]], 'A baseline head is read only to offer a person\'s Repair.');
  h.github.head = B;
  h.github.runs[B] = [run('2', B, 'failure'), run('3', B, null, { path: LINT })];
  await h.poll();
  assert.deepEqual(h.manager.view().repairs, [], 'A run still in progress waits.');
  h.github.runs[B][1] = run('3', B, 'success', { path: LINT });
  await h.poll();
  const repair = h.repair(B)!;
  assert.deepEqual([repair.trigger, repair.status, repair.category], ['push', 'ready', 'build']);
  assert.deepEqual(repair.runs, [{ id: '2', name: 'CI', path: CI, url: 'https://github.com/owner/app/actions/runs/2' }]);
  assert.deepEqual(repair.pullRequest, { number: 7, url: PULL.url });
  await h.poll();
  assert.equal(h.manager.view().repairs.length, 1, 'A head has one repair.');
  assert.equal(a.contexts.length, 1);
  assert.equal(h.calls.heads.at(-1)?.etag, `"${B.slice(0, 7)}"`, 'An unchanged head is read with its ETag.');
});

test('a head whose runs passed opens nothing and is not read again; runs without a workflow file never open a repair', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'success'), run('9', B, 'failure', { path: 'dynamic/pages/pages-build-deployment' })]);
  await h.poll();
  await h.poll();
  assert.deepEqual(h.manager.view().repairs, []);
  assert.deepEqual(h.calls.runs, [A, B], 'The baseline is read once, and the passing head once.');
  assert.equal(a.contexts.length, 0);
});

test('a head is judged by the latest run of each workflow, as Build admission reads it: a newer run that passed clears an older failure', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure'), run('3', B, 'success', { event: 'workflow_dispatch' })]);
  await h.poll();
  assert.deepEqual([h.manager.view().repairs, h.manager.view().head?.failed, a.contexts.length], [[], [], 0]);
  await assert.rejects(h.manager.repair({ runId: '2' }), (error: HttpError) => error.statusCode === 409 && error.message === 'Choose a failed workflow run.');
});

test('configuration failures need a person with the reason, and never rerun or reach the agent', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  h.github.logs['2'] = LOGS.configuration;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  const repair = h.repair(B)!;
  assert.deepEqual([repair.status, repair.category], ['needs-person', 'configuration']);
  assert.match(repair.reason ?? '', /Credentials or permissions need attention/);
  assert.deepEqual([a.contexts.length, h.calls.reruns], [0, []]);
});

test('an availability failure reruns its failed jobs once, and a passing rerun is flaky, never silently green', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  h.github.logs['2'] = LOGS.availability;
  await h.failHead([run('2', B, 'failure'), run('3', B, 'success', { path: LINT })]);
  await h.manager.idle();
  assert.equal(h.repair(B)?.status, 'rerunning');
  assert.deepEqual(h.calls.reruns, ['2']);
  await h.poll();
  h.github.runs[B][0] = run('2', B, null, { attempt: 2 });
  await h.poll();
  assert.equal(h.repair(B)?.status, 'rerunning', 'The rerun attempt is still running.');
  h.github.runs[B][0] = run('2', B, 'success', { attempt: 2 });
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.category], ['flaky', 'availability']);
  assert.deepEqual([a.contexts.length, h.calls.reruns], [0, ['2']]);
});

test('an assertion failure beside a negative-path timeout reaches repair without an automatic rerun', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  h.github.logs['2'] = '[cache] Request timed out; using fallback\nFAIL src/report.test.ts > stores the report\nAssertionError: expected draft to equal stored';
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.category], ['ready', 'test-regression']);
  assert.deepEqual(h.calls.reruns, [], 'An assertion mismatch never spends the transient-failure rerun.');
  assert.equal(a.contexts.length, 1);
  assert.equal(a.contexts[0].repair.failures?.[0].diagnosis.category, 'test-regression');
});

test('a rerun that fails again goes to repair with the new attempt, and never reruns twice', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  h.github.logs['2'] = LOGS.availability;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.runs[B] = [run('2', B, 'failure', { attempt: 2 })];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'ready');
  assert.deepEqual(h.calls.reruns, ['2']);
  assert.deepEqual(h.calls.failures, ['2', '2'], 'Triage reads the rerun attempt again.');
  assert.equal(a.contexts[0].repair.runs[0].attempt, 2);
});

test('a rerun GitHub refuses needs a person with its message', async t => {
  const h = await harness(t, { steps: agent().steps });
  h.github.logs['2'] = LOGS.availability;
  h.github.rerunError = new Error('GitHub denied the rerun. Check write access to Actions in this repository.');
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['needs-person', 'GitHub denied the rerun. Check write access to Actions in this repository.']);
});

test('the agent step gets the failure, the account, the managed source copy and its own directory, and records progress', async t => {
  const release = deferred();
  const a = agent(async (context, signal) => {
    await context.report({ status: 'verifying-ci', pullRequest: PULL, attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: '2026-09-25T10:00:00.000Z', failure: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123', cost: 0.12 }], diffHash: 'f'.repeat(64), ciRuns: ['41'] });
    await Promise.race([release.promise, aborted(signal)]);
    return { status: 'ready' };
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-ci');
  const [context] = a.contexts;
  assert.deepEqual([context.repair.sha, context.repair.branch, context.repair.repository, context.repair.login, context.repair.checkoutPath, context.repair.rootDirectory], [B, 'main', 'owner/app', 'developer', '/data/sources/github-1/app', '/']);
  assert.equal(context.repair.status, 'repairing');
  assert.deepEqual(context.repair.failures?.map(failure => [failure.runId, failure.diagnosis.category, failure.jobs[0].failedSteps]), [['2', 'build', ['Typecheck']]]);
  assert.equal(context.directory, join(await realpath(h.dataDir), 'repairs', context.repair.id));
  assert.equal((await stat(context.directory)).mode & 0o777, 0o700);
  await assert.rejects(context.report({ status: 'merged' } as never), /Invalid repair progress/);
  await assert.rejects(context.report({ pullRequest: { ...PULL, url: 'https://evil.example/pull/7' } }), /Invalid repair progress/);
  release.resolve();
  await h.manager.idle();
  const [stored] = (await h.saved()).repairs;
  assert.deepEqual([stored.status, stored.pullRequest, stored.diffHash, stored.ciRuns], ['ready', PULL, 'f'.repeat(64), ['41']]);
  assert.equal(stored.attempts?.[0].failure, 'token=[REDACTED]', 'Stored attempts are scrubbed.');
  assert.equal((await stat(join(h.dataDir, 'repairs', 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(h.dataDir, 'repairs'))).mode & 0o777, 0o700);
});

test('without an OpenRouter API key or an agent step, a repair that needs the agent needs a person', async t => {
  const noKey = () => 'Add an OpenRouter API key in Settings.';
  for (const [name, steps, reason] of [['no key', { unavailable: noKey, repair: async () => ({ status: 'ready' as const }) }, noKey()], ['no key and no step', { unavailable: noKey }, noKey()], ['no step', undefined, NO_AGENT]] as const) {
    await t.test(name, async t => {
      const h = await harness(t, { steps });
      await h.failHead([run('2', B, 'failure')]);
      await h.manager.idle();
      assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.category], ['needs-person', reason, 'build']);
    });
  }
});

test('retrying a finished repair waits for its terminal save before opening the next repair', async t => {
  let configured = false;
  const a = agent(undefined, { unavailable: () => configured ? null : 'Add an OpenRouter API key in Settings.' });
  const h = await harness(t, { steps: a.steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  const saving = await holdTerminalSave(t, h.dataDir);
  try {
    await h.manager.repair({ runId: '1' });
    await saving.entered;
    assert.equal(h.repair(A)?.status, 'needs-person', 'The terminal outcome is visible while its save is outstanding.');
    assert.equal((await h.saved()).repairs[0].status, 'triaging');
    configured = true;
    const again = h.manager.repair({ runId: '1' }).then(view => ({ view }), (error: HttpError) => ({ error }));
    // Drain this turn's immediate GitHub reads while the terminal filesystem operation stays held.
    await new Promise<void>(done => setImmediate(done));
    assert.equal(h.manager.view().repairs.length, 1, 'No next repair is admitted before the finished execution is saved.');
    saving.release();
    const result = await again;
    assert.ok('view' in result, 'error' in result ? `${result.error.statusCode}: ${result.error.message}` : undefined);
    assert.equal(result.view.repairs.length, 2);
    await h.manager.idle();
    assert.deepEqual((await h.saved()).repairs.map(repair => repair.status), ['ready', 'needs-person']);
    assert.equal(a.contexts.length, 1, 'Only the new, configured repair reaches the agent.');
  } finally {
    saving.release();
    await h.manager.idle();
    saving.restore();
  }
});

test('a retry waiting for a finished repair revalidates source, account and failed-run evidence', async t => {
  for (const changed of ['source', 'account', 'run'] as const) await t.test(changed, async t => {
    const a = agent(undefined, { unavailable: () => 'Add an OpenRouter API key in Settings.' });
    const h = await harness(t, { steps: a.steps });
    h.github.runs[A] = [run('1', A, 'failure')];
    await h.poll();
    const saving = await holdTerminalSave(t, h.dataDir);
    try {
      await h.manager.repair({ runId: '1' });
      await saving.entered;
      const again = h.manager.repair({ runId: '1' }).then(view => ({ view }), (error: HttpError) => ({ error }));
      await new Promise<void>(done => setImmediate(done));
      if (changed === 'source') h.current.rootDirectory = '/client';
      if (changed === 'account') h.github.connection = { login: 'another-developer', repository: 'owner/app' };
      if (changed === 'run') h.github.runs[A] = [run('1', A, 'success', { attempt: 2 })];
      saving.release();
      const result = await again;
      assert.ok('error' in result, 'A changed admission condition cannot start the requested repair.');
      assert.equal(result.error.statusCode, 409);
      const expected = { source: 'The active source changed. Reload the pipeline.', account: 'The GitHub connection changed. Start the repair again.', run: 'Choose a failed workflow run.' };
      assert.equal(result.error.message, expected[changed]);
      assert.deepEqual([h.manager.view().repairs.length, a.contexts.length], [1, 0]);
    } finally {
      saving.release();
      await h.manager.idle();
      saving.restore();
    }
  });
});

test('a normal terminal repair still refuses a retry while resource cleanup is pending or failed', async t => {
  const entered = deferred(), release = deferred();
  const a = agent(async () => ({ status: 'failed' }), { async cleanup() { entered.resolve(); await release.promise; throw new Error('Docker removal failed'); } });
  const h = await harness(t, { steps: a.steps });
  try {
    await h.failHead([run('2', B, 'failure')]);
    await entered.promise;
    const again = h.manager.repair({ runId: '2' }).then(view => ({ view }), (error: HttpError) => ({ error }));
    const result = await Promise.race([again, new Promise<null>(done => setImmediate(() => done(null)))]);
    assert.ok(result && 'error' in result, 'Pending resource cleanup refuses admission without waiting for that cleanup.');
    assert.deepEqual([result.error.statusCode, result.error.message], [409, 'The previous repair is still ending. Try again.']);
    release.resolve();
    await h.manager.idle();
    await assert.rejects(h.manager.repair({ runId: '2' }), (error: HttpError) => error.statusCode === 409 && error.message === 'The previous repair is still ending. Try again.');
    assert.deepEqual([h.manager.view().repairs.length, a.contexts.length], [1, 1]);
    assert.equal(h.repair(B)?.cleanup?.status, 'failed');
  } finally {
    release.resolve();
    await h.manager.idle();
  }
});

test('an agent step that throws or returns no result needs a person, and its error is scrubbed', async t => {
  const thrown = await harness(t, { steps: agent(async () => { throw new Error('Push failed: https://x:ghp_abcdefghijklmnop123456@github.com/owner/app.git'); }).steps });
  await thrown.failHead([run('2', B, 'failure')]);
  await thrown.manager.idle();
  assert.equal(thrown.repair(B)?.status, 'needs-person');
  assert.equal(thrown.repair(B)?.reason, 'Push failed: https://[REDACTED]@github.com/owner/app.git');
  const empty = await harness(t, { steps: agent(async () => ({}) as never).steps });
  await empty.failHead([run('2', B, 'failure')]);
  await empty.manager.idle();
  assert.deepEqual([empty.repair(B)?.status, empty.repair(B)?.reason], ['needs-person', 'The repair ended without a result.']);
});

test('a new head supersedes active work at once, aborting the agent step, and keeps its pull request open until a newer head passes', async t => {
  let stopped = false;
  const closed: string[] = [];
  const a = agent(async (context, signal) => { await context.report({ pullRequest: PULL }); await aborted(signal); stopped = true; return { status: 'failed' }; }, { async close(repair) { closed.push(repair.pullRequest!.url); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.pullRequest);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.manager.check();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['superseded', `Superseded by ${C.slice(0, 7)}.`]);
  await h.manager.idle();
  assert.equal(stopped, true);
  assert.deepEqual(closed, [], 'Its pull request may hold a valid fix, so it stays open.');
  assert.equal(h.repair(B)?.status, 'superseded', 'The aborted step returns no verdict.');
  await assert.rejects(a.contexts[0].report({ status: 'verifying-ci' }), (error: HttpError) => error.statusCode === 409);
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, closed], ['superseded', [PULL.url]], 'A newer head that passes closes it, once.');
  assert.equal((await h.saved()).repairs[0].pullRequest?.closed, true);
});

test('a newer repair\'s own pull request closes an older unverified one\'s at once, and a verified fix\'s only once the newer fix is verified too', async t => {
  const closed: number[] = [], numbers: Record<string, number> = { [B]: 7, [C]: 8, [D]: 9 };
  let passes = true;
  // Each repair opens a draft; when its CI passes it is marked ready for review and the repair is ready.
  const a = agent(async (context, signal) => {
    const number = numbers[context.repair.sha], pullRequest = { number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${context.repair.sha.slice(0, 7)}`, draft: true };
    await context.report({ status: 'verifying-ci', pullRequest });
    if (number === 7) await aborted(signal);
    if (!passes) return { status: 'failed', reason: 'The build was not fixed in 4 attempts.' };
    await context.report({ pullRequest: { ...pullRequest, draft: false } });
    return { status: 'ready' };
  }, { async close(repair) { closed.push(repair.pullRequest!.number); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.pullRequest);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'superseded');
  await h.poll(); // the head's repair starts once the aborted step has settled
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.pullRequest?.draft, closed], ['ready', false, [7]], 'The superseded repair\'s pull request closes once the newer one opens.');
  assert.equal(h.repair(B)?.reason, `Superseded by ${C.slice(0, 7)}.`);
  passes = false;
  await h.failHead([run('4', D, 'failure')], D);
  await h.manager.idle();
  assert.deepEqual([h.repair(D)?.status, h.repair(C)?.status, closed], ['failed', 'ready', [7]], 'A verified fix stays open beside a newer draft, and after that repair fails.');
  passes = true;
  await h.manager.repair({ runId: '4' });
  await h.manager.idle();
  assert.deepEqual([h.repair(D)?.status, h.repair(C)?.status, h.repair(C)?.reason, closed], ['ready', 'superseded', `Superseded by ${D.slice(0, 7)}.`, [7, 8]], 'It closes once a newer fix is verified.');
});

test('repairs of one commit share its pull request, which closes once when a newer head passes', async t => {
  const a = pulled(() => ({ status: 'failed', reason: 'The build was not fixed in 4 attempts.' }), {});
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  await h.manager.repair({ runId: '2' });
  await h.manager.idle();
  assert.deepEqual((await h.saved()).repairs.map(repair => [repair.status, repair.pullRequest?.number]), [['failed', 7], ['failed', 7]]);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  await h.poll();
  assert.deepEqual(a.closed, [7], 'One close, and so one comment.');
  assert.deepEqual((await h.saved()).repairs.map(repair => [repair.status, repair.pullRequest?.closed]), [['superseded', true], ['superseded', true]]);
});

test('a close that failed is tried again at each check, even after a restart, and one GitHub refuses is recorded and not tried again', async t => {
  const NETWORK = 'Closing the pull request failed. Check your network connection and try again.', DENIED = 'GitHub denied the pull request. Check write access to this repository.';
  // A failed repair of B keeps its pull request 7, and head C passes; close answers with the queued errors, then merged or closed.
  async function superseded(t: TestContext, errors: Error[], merged = { value: false }) {
    const closed: number[] = [];
    const steps = agent(async context => { await context.report({ pullRequest: PULL }); return { status: 'failed', reason: 'The build was not fixed in 4 attempts.' }; }, {
      async close(repair) { closed.push(repair.pullRequest!.number); const error = errors.shift(); if (error) throw error; return merged.value ? { state: 'merged', mergeCommit: E } : undefined; },
    }).steps;
    const h = await harness(t, { steps });
    await h.failHead([run('2', B, 'failure')]);
    await h.manager.idle();
    h.github.head = C;
    h.github.runs[C] = [run('3', C, 'success')];
    await h.poll();
    return { h, closed, steps };
  }
  await t.test('a network error', async t => {
    const { h, closed, steps } = await superseded(t, [new Error(NETWORK), new Error(NETWORK)]);
    const [first] = (await h.saved()).repairs;
    assert.deepEqual([closed, first.status, first.pullRequest?.closed, first.closeError], [[7], 'superseded', undefined, undefined], 'Nothing is recorded as closed.');
    await h.poll();
    assert.deepEqual(closed, [7, 7], 'It is tried again at the next check.');
    const restarted = await harness(t, { dataDir: h.dataDir, steps });
    await restarted.poll();
    assert.deepEqual([closed, (await restarted.saved()).repairs[0].pullRequest?.closed], [[7, 7, 7], true], 'A restart closes it at its first check.');
    await restarted.poll();
    assert.deepEqual(closed, [7, 7, 7]);
  });
  await t.test('a person merged it after the failed close', async t => {
    const merged = { value: false };
    const { h, closed } = await superseded(t, [new Error(NETWORK)], merged);
    merged.value = true;
    await h.poll();
    assert.deepEqual([closed, h.repair(B)?.status, h.repair(B)?.reason], [[7, 7], 'merged', 'Merged on GitHub.']);
  });
  await t.test('GitHub refuses it', async t => {
    const { h, closed } = await superseded(t, [Object.assign(new Error(DENIED), { refused: true })]);
    await h.poll();
    await h.poll();
    const [first] = (await h.saved()).repairs;
    assert.deepEqual([closed, first.status, first.closeError, first.pullRequest?.closed], [[7], 'superseded', DENIED, undefined]);
  });
});

test('a ready repair is superseded, and its pull request closed, only once a newer head passes', async t => {
  const closed: string[] = [];
  const h = await harness(t, { steps: agent(async context => { await context.report({ pullRequest: PULL }); return { status: 'ready' }; }, { async close(repair) { closed.push(repair.id); } }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'ready', 'A newer head still running leaves the fix ready.');
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'superseded');
  assert.deepEqual(closed, [h.repair(B)?.id]);
});

// A docs-only commit can pass while the workflow that failed never ran at it, such as one with a paths filter.
test('a newer passing head where the failed workflow did not run keeps the fix and its pull request open', async t => {
  const closed: string[] = [];
  const h = await harness(t, { steps: agent(async context => { await context.report({ pullRequest: PULL }); return { status: 'ready' }; }, { async close(repair) { closed.push(repair.id); } }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'success', { path: LINT })];
  await h.poll();
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, closed], ['ready', []], 'Nothing showed the branch fixed.');
  h.github.head = D;
  h.github.runs[D] = [run('4', D, 'success'), run('5', D, 'success', { path: LINT })];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, closed], ['superseded', [h.repair(B)?.id]], 'A head where it passed retires the fix.');
});

test('a ready repair whose pull request a person merged is recorded as merged once a newer head passes, never superseded', async t => {
  const h = await harness(t, { steps: agent(async context => { await context.report({ pullRequest: PULL }); return { status: 'ready' }; }, { async close() { return { state: 'merged', mergeCommit: E }; } }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['merged', 'Merged on GitHub.']);
  await assert.rejects(h.manager.repair({ runId: '3' }), /Choose a failed workflow run/, 'A merged repair is finished.');
});

test('what an agent step pushed is recorded, even while it unwinds, and a person\'s next Repair of that commit starts from it', async t => {
  const X = 'e'.repeat(40);
  const a = agent(async (context, signal) => {
    if (a.contexts.length > 1) return { status: 'failed' };
    await aborted(signal);
    await assert.rejects(context.report({ pushed: X }), (error: HttpError) => error.statusCode === 409);
    return { status: 'failed' };
  });
  const h = await harness(t, { steps: a.steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  await h.manager.repair({ runId: '1' });
  await until(() => h.repair(A)?.status === 'repairing');
  await h.manager.stop({ id: h.repair(A)!.id });
  await h.manager.idle();
  assert.equal((await h.saved()).repairs[0].pushed, X);
  await h.manager.repair({ runId: '1' });
  await h.manager.idle();
  assert.deepEqual(a.contexts.map(context => context.repair.pushed), [undefined, X]);
  await assert.rejects(a.contexts[1].report({ pushed: 'main' }), /Invalid repair progress/);
});

test('one repair runs at a time: another source\'s failed head waits until the active repair ends', async t => {
  const release = deferred();
  const a = agent(async (_context, signal) => { await Promise.race([release.promise, aborted(signal)]); return { status: 'ready' }; });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'repairing');
  // The connected repository follows the managed source.
  Object.assign(h.current, { key: 'github:owner/other:/', repository: 'owner/other' });
  h.github.connection = { login: 'developer', repository: 'owner/other' };
  await h.manager.check(); // the other source's first head is its baseline
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.manager.check();
  assert.deepEqual(h.manager.view().repairs, [], 'The other source waits.');
  await assert.rejects(h.manager.repair({ runId: '3' }), (error: HttpError) => error.statusCode === 409 && error.message === 'Another repair is running.');
  release.resolve();
  await h.manager.idle();
  await h.poll();
  assert.equal(h.repair(C)?.status, 'ready');
  assert.equal(a.contexts.length, 2);
});

test('switching the pipeline to another branch stops that branch\'s repair under way, and keeps its pull request', async t => {
  const a = agent(async (context, signal) => { await context.report({ status: 'verifying-ci', pullRequest: PULL }); await aborted(signal); return { status: 'ready' }; });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-ci');
  h.current.branch = 'dev';
  await h.poll();
  assert.deepEqual(h.manager.view().repairs, [], 'The repair of main is not shown for dev.');
  h.current.branch = 'main';
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.pullRequest?.number], ['needs-person', 'Interrupted when the pipeline switched to dev.', 7]);
  assert.equal(a.contexts.length, 1);
});

// Another root directory of the same repository is another pipeline, whose connection check still passes for the repair.
test('switching the pipeline to another root directory of the repository stops the repair under way of the one it left', async t => {
  const a = agent(async (context, signal) => { await context.report({ status: 'verifying-ci', pullRequest: PULL }); await aborted(signal); return { status: 'ready' }; });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-ci');
  Object.assign(h.current, { key: 'github:owner/app:/web', rootDirectory: '/web' });
  await h.poll();
  Object.assign(h.current, { key: KEY, rootDirectory: '/' });
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.pullRequest?.number], ['needs-person', 'Interrupted when the pipeline switched to another source.', 7]);
});

// A rerun follows its own repository whatever the pipeline shows, but no agent starts for a branch nothing watches.
test('a rerun of a branch the pipeline left that fails again needs a person, and never starts the agent', async t => {
  const a = agent();
  const h = await harness(t, { steps: a.steps });
  h.github.logs['2'] = LOGS.availability;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.equal(h.repair(B)?.status, 'rerunning');
  h.current.branch = 'dev';
  h.github.runs[B] = [run('2', B, 'failure', { attempt: 2 })];
  await h.poll();
  h.current.branch = 'main';
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.runs.map(item => item.id), a.contexts.length], ['needs-person', 'Interrupted when the pipeline switched to dev.', ['2'], 0]);
});

test('a person repairs the failed baseline head, may start a finished repair again, and never a held one', async t => {
  const h = await harness(t);
  h.github.runs[A] = [run('1', A, 'failure'), run('2', A, 'success', { path: LINT })];
  await h.poll();
  const started = await h.manager.repair({ runId: '1' });
  assert.deepEqual([started.repairs[0].sha, started.repairs[0].trigger, started.repairs[0].status], [A, 'person', 'triaging']);
  await h.manager.idle();
  assert.deepEqual([h.repair(A)?.status, h.repair(A)?.reason], ['needs-person', NO_AGENT]);
  const [first] = (await h.saved()).repairs;
  assert.equal(first.login, 'developer');
  await h.manager.repair({ runId: 1 });
  await h.manager.idle();
  const saved = (await h.saved()).repairs;
  assert.equal(saved.length, 2, 'A finished repair is kept beside the new one.');
  assert.notEqual(saved[0].id, first.id);
  saved[0].status = 'ready';
  await writeFile(join(h.dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: saved }));
  const restarted = await harness(t, { dataDir: h.dataDir });
  restarted.github.runs[A] = h.github.runs[A];
  await assert.rejects(restarted.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && error.message === 'This commit already has a repair.');
});

test('a person\'s Repair names a failed run at the current head of a connected, managed source', async t => {
  const h = await harness(t);
  h.github.runs[A] = [run('1', A, 'failure'), run('2', A, 'success', { path: LINT }), run('4', A, null, { path: LINT })];
  await assert.rejects(h.manager.repair({ runId: 'latest' }), /Choose a failed workflow run/);
  await assert.rejects(h.manager.repair({ runId: '2' }), (error: HttpError) => error.statusCode === 409 && /Choose a failed workflow run/.test(error.message));
  await assert.rejects(h.manager.repair({ runId: '4' }), (error: HttpError) => error.statusCode === 409 && /Choose a failed workflow run/.test(error.message));
  await assert.rejects(h.manager.repair({ runId: '99' }), (error: HttpError) => error.statusCode === 409 && error.message === 'This run is not at the head of main.');
  h.github.connection = null;
  await assert.rejects(h.manager.repair({ runId: '1' }), /Connect GitHub to repair builds/);
  h.current.repository = null;
  await assert.rejects(h.manager.repair({ runId: '1' }), /Connect a GitHub repository to repair its builds/);
  assert.deepEqual(h.manager.view().repairs, []);
});

test('a person\'s Repair is refused when the head cannot be read again, or moves while its runs are read', async t => {
  const h = await harness(t, { steps: agent().steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  h.github.headError = new Error('GitHub has temporarily limited requests. Wait before trying again.');
  await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && error.message === 'GitHub has temporarily limited requests. Wait before trying again.');
  h.github.headError = null;
  // B is pushed while the Repair reads the runs of A, and a check reads it before the repair would open.
  let reads = 0;
  h.github.onRuns = async () => {
    if (++reads < 2) return;
    h.github.onRuns = null;
    h.github.head = B;
    h.github.runs[B] = [run('2', B, null)];
    await h.manager.check();
  };
  await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && error.message === 'The head of main moved. Reload the pipeline.');
  await h.manager.idle();
  assert.deepEqual([h.manager.view().repairs, h.manager.view().head?.sha, h.calls.failures], [[], B, []], 'No repair of the older commit opens, so nothing is read or spent.');
});

test('a person\'s Repair refuses changed source evidence while the selected head\'s failed runs are read', async t => {
  const changes: Partial<RepairSource>[] = [
    { branch: 'release' }, { key: 'github:owner/other:/' }, { repository: 'owner/other' },
    { checkoutPath: '/data/sources/another/app' }, { rootDirectory: '/web' },
  ];
  for (const change of changes) await t.test(Object.keys(change)[0], async t => {
    const a = agent(), h = await harness(t, { steps: a.steps });
    h.github.runs[A] = [run('1', A, 'failure')];
    await h.poll();
    let reads = 0;
    h.github.onRuns = () => { if (++reads === 2) Object.assign(h.current, change); };
    await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && /active source changed/i.test(error.message));
    await h.manager.idle();
    assert.deepEqual(a.contexts, [], 'The agent must not start for a source the person has left.');
    assert.deepEqual((await h.saved()).repairs, [], 'The old source must not acquire an invisible repair.');
  });
});

test('a person\'s Repair refuses an account change while the selected head\'s failed runs are read', async t => {
  for (const connection of [null, { login: 'other', repository: 'owner/app' }]) await t.test(connection?.login ?? 'disconnected', async t => {
    const a = agent(), h = await harness(t, { steps: a.steps });
    h.github.runs[A] = [run('1', A, 'failure')];
    await h.poll();
    let reads = 0;
    h.github.onRuns = () => { if (++reads === 2) h.github.connection = connection; };
    await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && /connection changed/i.test(error.message));
    await h.manager.idle();
    assert.deepEqual(a.contexts, []);
    assert.deepEqual((await h.saved()).repairs, []);
  });
});

test('Stop cancels an active repair and aborts its work; a finished or unknown repair cannot be stopped', async t => {
  let stopped = false;
  const h = await harness(t, { steps: agent(async (_context, signal) => { await aborted(signal); stopped = true; return { status: 'ready' }; }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'repairing');
  const id = h.repair(B)!.id;
  assert.equal((await h.manager.stop({ id })).repairs[0].status, 'cancelled');
  await h.manager.idle();
  assert.deepEqual([stopped, h.repair(B)?.status], [true, 'cancelled']);
  await assert.rejects(h.manager.stop({ id }), (error: HttpError) => error.statusCode === 409 && error.message === 'This repair is not running.');
  await assert.rejects(h.manager.stop({ id: 'missing' }), (error: HttpError) => error.statusCode === 404);
});

test('a stopped rerun stays stopped when its attempt passes', async t => {
  const h = await harness(t, { steps: agent().steps });
  h.github.logs['2'] = LOGS.availability;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  await h.manager.stop({ id: h.repair(B)!.id });
  h.github.runs[B] = [run('2', B, 'success', { attempt: 2 })];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'cancelled');
});

// An agent step whose one attempt fails, as the agent step records it, costing `cost` dollars; the repair ends failed.
const fruitless = (cost = 0.5) => agent(async context => {
  const at = '2026-09-25T10:00:00.000Z';
  await context.report({ attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: at, completedAt: at, failure: 'The model stopped without calling done.', cost }] });
  return { status: 'failed', reason: 'The build was not fixed in 4 attempts.' };
});
// Failing heads one after another, each repair ending before the next head.
async function failHeads(h: Awaited<ReturnType<typeof harness>>, heads: [string, WorkflowRun[]][]) {
  for (const [sha, runs] of heads) { await h.failHead(runs, sha); await h.manager.idle(); }
}

test('after three repairs of the same failure failed in a row, the next waits for a person without the agent, who may still start Repair', async t => {
  const a = fruitless();
  const h = await harness(t, { steps: a.steps });
  await failHeads(h, [[B, [run('2', B, 'failure')]], [C, [run('3', C, 'failure')]], [D, [run('4', D, 'failure')]]]);
  assert.deepEqual([h.repair(D)?.status, a.contexts.length], ['failed', 3]);
  await failHeads(h, [[E, [run('5', E, 'failure')]]]);
  assert.deepEqual([h.repair(E)?.status, h.repair(E)?.reason, a.contexts.length], ['needs-person', 'The last 3 repairs of CI failed. Start Repair to try again.', 3], 'The agent does not start.');
  assert.deepEqual([h.calls.failures, h.manager.view().head?.failed], [['2', '3', '4', '5'], [shown('5')]], 'Triage still read the failure, and Build offers Repair.');
  await h.manager.repair({ runId: '5' });
  await h.manager.idle();
  assert.deepEqual([h.repair(E)?.trigger, h.repair(E)?.status, a.contexts.length], ['person', 'failed', 4], 'A person\'s Repair starts the agent.');
});

test('a run of failed repairs ends at a head that passed, remembered across a restart, and at a repair of another failure', async t => {
  const [F, G, H, I, J] = ['1', '2', '3', '4', '5'].map(digit => digit.repeat(40));
  const a = fruitless();
  const h = await harness(t, { steps: a.steps });
  await failHeads(h, [[B, [run('2', B, 'failure')]], [C, [run('3', C, 'failure')]], [D, [run('4', D, 'failure')]]]);
  h.github.head = E;
  h.github.runs[E] = [run('5', E, 'success')];
  await h.poll();
  assert.equal(typeof (await h.saved()).passed?.[KEY], 'string', 'The pass is kept with the repairs.');
  await failHeads(h, [[F, [run('6', F, 'failure')]]]);
  assert.deepEqual([h.repair(F)?.status, a.contexts.length], ['failed', 4], 'The same failure after a pass is a new run.');
  await h.manager.close();
  const b = fruitless();
  const restarted = await harness(t, { dataDir: h.dataDir, steps: b.steps, clock: 60_000 });
  // F and G are two failed repairs of CI since the pass; Lint's at H ends that run, so I and J make two again.
  await failHeads(restarted, [[G, [run('7', G, 'failure')]], [H, [run('8', H, 'failure', { path: LINT })]], [I, [run('9', I, 'failure')]], [J, [run('10', J, 'failure')]]]);
  assert.deepEqual([G, H, I, J].map(sha => restarted.repair(sha)?.status), ['failed', 'failed', 'failed', 'failed']);
  assert.equal(b.contexts.length, 4, 'Every run ended before it reached three.');
});

test('once a pipeline\'s repairs cost $10 in a day, a failing head\'s repair waits for a person, whose Repair may spend past it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:30:00.000Z', yesterday = '2026-09-24T09:30:00.000Z';
  const attempt = (startedAt: string, cost: number) => ({ number: 1, model: 'openai/gpt-6-luna', startedAt, completedAt: startedAt, cost });
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'merged', runs: [], createdAt: at, updatedAt: at };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [
    { ...base, id: 'today', sha: '5'.repeat(40), merged: '6'.repeat(40), attempts: [attempt(at, 6), attempt(at, 3)] },
    { ...base, id: 'yesterday', sha: '7'.repeat(40), merged: '8'.repeat(40), attempts: [attempt(yesterday, 5)] },
    { ...base, id: 'other', key: 'github:owner/other:/', repository: 'owner/other', sha: '9'.repeat(40), merged: '0'.repeat(40), attempts: [attempt(at, 5)] },
  ] }));
  // Each repair spends what it may: what is left of the cap for one Autopilot started, $2 for a person's.
  const a = agent(async context => {
    await context.report({ attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: '2026-09-25T10:00:00.000Z', cost: context.spendable ?? 2 }] });
    return { status: 'ready' };
  });
  const h = await harness(t, { dataDir, steps: a.steps });
  await failHeads(h, [[B, [run('2', B, 'failure')]]]);
  assert.deepEqual([h.repair(B)?.status, a.contexts[0].spendable], ['ready', 1], 'Only today\'s $9 of this pipeline counts, leaving $1.');
  await failHeads(h, [[C, [run('3', C, 'failure')]]]);
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'Repairs reached this pipeline\'s $10.00 daily cost cap. Start Repair to try again.', 1]);
  await h.manager.repair({ runId: '3' });
  await h.manager.idle();
  assert.deepEqual([h.repair(C)?.status, a.contexts.length, a.contexts[1].spendable], ['ready', 2, undefined], 'A person\'s Repair starts the agent, bounded by its own cap only.');
});

test('attempts a stopped repair reports while it unwinds are recorded with what they cost', async t => {
  const started = '2026-09-25T10:00:00.000Z';
  const a = agent(async (context, signal) => {
    await context.report({ status: 'repairing', attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: started }] });
    await aborted(signal);
    await assert.rejects(context.report({ attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: started, completedAt: started, cost: 0.4 }] }), (error: HttpError) => error.statusCode === 409);
    return { status: 'ready' };
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'repairing');
  await h.manager.stop({ id: h.repair(B)!.id });
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.attempts], ['cancelled', [{ number: 1, model: 'openai/gpt-6-luna', cost: 0.4 }]]);
  assert.equal((await h.saved()).repairs[0].attempts?.[0].cost, 0.4);
});

test('a controller restart ends active repairs as needing a person, keeps finished ones, and starts no work', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/data/sources/github-1/app', rootDirectory: '/', trigger: 'push', createdAt: at, updatedAt: at };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [
    { ...base, id: 'r1', sha: B, status: 'verifying-ci', runs: [{ id: '2', name: 'CI', path: CI, attempt: 1, url: null }], pullRequest: PULL },
    { ...base, id: 'r2', sha: A, status: 'rerunning', runs: [{ id: '1', name: 'CI', path: CI, attempt: 1, url: null }], reruns: [{ id: '1', attempt: 1 }] },
    { ...base, id: 'r3', sha: C, status: 'ready', runs: [] },
  ] }));
  const a = agent();
  const h = await harness(t, { dataDir, steps: a.steps });
  const saved = (await h.saved()).repairs;
  assert.deepEqual(saved.map(item => [item.id, item.status, item.reason]), [['r1', 'needs-person', 'Interrupted by a controller restart.'], ['r2', 'needs-person', 'Interrupted by a controller restart.'], ['r3', 'ready', undefined]]);
  assert.deepEqual(saved[0].pullRequest, PULL, 'Its pull request stays.');
  h.github.head = D; // pushed and failed while the controller was down
  h.github.runs[D] = [run('5', D, 'failure')];
  h.manager.start();
  await h.manager.idle();
  assert.equal(h.repair(D), undefined, 'The head first seen at start is a baseline.');
  assert.deepEqual([a.contexts.length, h.calls.reruns, h.calls.failures], [0, [], []]);
});

test('a controller start removes the directories of repairs that no longer run, such as an interrupted repair\'s host copy', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs', 'r1', 'clone', '.git'), { recursive: true });
  await writeFile(join(dataDir, 'repairs', 'r1', 'clone', 'add.js'), 'module.exports = 1;\n');
  await writeFile(join(dataDir, 'repairs', 'r1', 'change.diff'), 'diff --git a/add.js b/add.js\n');
  await mkdir(join(dataDir, 'repairs', 'pruned-long-ago'));
  const at = '2026-09-25T09:00:00.000Z';
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'r1', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'repairing', runs: [], createdAt: at, updatedAt: at }] }));
  const h = await harness(t, { dataDir });
  assert.deepEqual((await readdir(join(dataDir, 'repairs'))).sort(), ['state.json']);
  assert.equal((await h.saved()).repairs[0].status, 'needs-person');
});

// Six workflows failing together, with full logs, over a long history once outgrew what a start reads back.
test('finished repairs keep their failures in brief, and the state file stays within what a start reads back', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z', log = `${LOGS.build}\n`.repeat(400);
  const failure = { runId: '2', jobs: [{ id: 'job-2', name: 'test', conclusion: 'failure', failedSteps: ['Typecheck'] }], log, tail: log, diagnosis: diagnoseFailure(LOGS.build), observedAt: at };
  const record = (index: number, extra: object) => ({ id: `r${index}`, key: KEY, repository: 'owner/app', branch: 'main', sha: index.toString(16).padStart(40, '0'), login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'failed', runs: [], createdAt: at, updatedAt: at, ...extra });
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: Array.from({ length: 20 }, (_, index) => record(index, { failures: Array.from({ length: 6 }, () => failure) })) }));
  const h = await harness(t, { dataDir });
  const saved = await h.saved();
  assert.ok((await stat(join(dataDir, 'repairs', 'state.json'))).size < 1024 * 1024);
  assert.deepEqual([saved.repairs.length, saved.repairs[0].failures?.length, saved.repairs[0].failures?.[0].log.length, saved.repairs[0].failures?.[0].diagnosis.category], [20, 5, 2000, 'build']);
  await h.manager.close();
  // Whatever else a record holds, the oldest finished repairs give way before the file outgrows half the read limit.
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: Array.from({ length: 40 }, (_, index) => record(index, { reason: 'x'.repeat(300_000) })) }));
  const bounded = await harness(t, { dataDir });
  const kept = (await bounded.saved()).repairs;
  assert.ok((await stat(join(dataDir, 'repairs', 'state.json'))).size <= 8 * 1024 * 1024);
  assert.deepEqual([kept.length < 40, kept[0].id], [true, 'r0'], 'The newest repairs stay.');
});

// Earlier controllers wrote the file without a bound, and a start that refused it kept the whole controller from starting.
test('a start reads back a larger file an earlier controller wrote and trims it, keeping a merge and an open pull request longest', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z', file = join(dataDir, 'repairs', 'state.json');
  const failure = { runId: '2', jobs: [{ id: 'job-2', name: 'test', conclusion: 'failure', failedSteps: ['Typecheck'] }], log: 'x'.repeat(20_000), tail: 'y'.repeat(12_000), diagnosis: diagnoseFailure(LOGS.build), observedAt: at };
  const record = (index: number, extra: object) => ({ id: `r${index}`, key: KEY, repository: 'owner/app', branch: 'main', sha: index.toString(16).padStart(40, '0'), login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'failed', runs: [], createdAt: at, updatedAt: at, ...extra });
  await writeFile(file, JSON.stringify({ version: 1, repairs: Array.from({ length: 100 }, (_, index) => record(index, { failures: Array.from({ length: 6 }, () => failure) })) }));
  assert.ok((await stat(file)).size > 16 * 1024 * 1024);
  const legacy = await harness(t, { dataDir });
  assert.deepEqual([(await legacy.saved()).repairs.length, (await stat(file)).size < 8 * 1024 * 1024], [100, true]);
  await legacy.manager.close();
  const reason = 'x'.repeat(300_000), closedPull = { ...PULL, number: 8, url: 'https://github.com/owner/app/pull/8', closed: true };
  await writeFile(file, JSON.stringify({ version: 1, repairs: Array.from({ length: 40 }, (_, index) => record(index, { reason,
    ...(index === 39 ? { status: 'merged', merged: C } : index === 38 ? { pullRequest: PULL } : index === 37 ? { pullRequest: closedPull } : {}) })) }));
  const bounded = await harness(t, { dataDir });
  const kept = (await bounded.saved()).repairs.map(item => item.id);
  assert.deepEqual([kept[0], kept.includes('r39'), kept.includes('r38'), kept.includes('r37'), kept.length < 40], ['r0', true, true, false, true], 'The loop guard\'s merge and open pull request outlast older repairs.');
});

test('the newest hundred repairs of each pipeline are kept, so a busy pipeline never drops another\'s merge', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z', OTHER = 'github:owner/other:/';
  const record = (id: string, key: string, repository: string, sha: string, extra: object = {}) => ({ id, key, repository, branch: 'main', sha, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'failed', runs: [], createdAt: at, updatedAt: at, ...extra });
  const others = Array.from({ length: 100 }, (_, index) => record(`o${index}`, OTHER, 'owner/other', (index + 1).toString(16).padStart(40, '0')));
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [...others, record('merged', KEY, 'owner/app', B, { status: 'merged', merged: C, pullRequest: PULL })] }));
  const h = await harness(t, { dataDir, steps: agent().steps });
  Object.assign(h.current, { key: OTHER, repository: 'owner/other' });
  h.github.connection = { login: 'developer', repository: 'owner/other' };
  await h.failHead([run('2', D, 'failure')], D);
  await h.manager.idle();
  const saved = (await h.saved()).repairs;
  assert.deepEqual([saved.filter(item => item.key === OTHER).length, saved.filter(item => item.key === OTHER).at(-1)?.id, saved.some(item => item.id === 'merged')], [100, 'o98', true]);
});

test('a saved repair that is not a complete record makes the state unsupported, never a later TypeError', async t => {
  const at = '2026-09-25T09:00:00.000Z';
  const valid = { id: 'r', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'ready', runs: [], createdAt: at, updatedAt: at };
  for (const repairs of [[{ ...valid, id: '../outside' }], [{ ...valid, cleanup: { status: 'gone' } }], [{ ...valid, cleanup: { status: 'failed', reason: 42 } }], [null], [{ id: 'r', status: 'ready' }], [{ ...valid, status: 'shipped' }], [{ ...valid, sha: 'main' }], [{ ...valid, runs: [{ id: 'x' }] }], [{ ...valid, pullRequest: { ...PULL, url: 'https://evil.example/pull/7' } }], [{ ...valid, failures: [{ runId: '1' }] }]]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
    await mkdir(join(dataDir, 'repairs')); await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs }));
    await assert.rejects(harness(t, { dataDir }), /Unsupported repair state/);
  }
});

test('without a connected account or a managed source nothing is read', async t => {
  const h = await harness(t, { connection: null });
  await h.poll();
  assert.deepEqual(h.calls.heads, []);
  h.github.connection = { login: 'developer', repository: 'owner/app' };
  h.current.repository = null;
  const connections = h.calls.connections;
  await h.poll();
  assert.deepEqual([h.calls.heads, h.calls.connections], [[], connections], 'A local checkout is never repaired, so nothing is asked of GitHub.');
  assert.deepEqual(h.manager.view(), { repairs: [] });
});

test('a head read failure is kept for the view and never throws', async t => {
  const h = await harness(t);
  h.github.headError = new Error('Could not read main from GitHub.');
  await h.poll();
  assert.equal(h.manager.view().watchError, 'Could not read main from GitHub.');
  h.github.headError = null;
  await h.poll();
  assert.equal(h.manager.view().watchError, undefined);
});

test('a head whose runs were cancelled or wait for approval never passes: a ready repair stays, and a later failure of that head opens a repair', async t => {
  const closed: string[] = [];
  const h = await harness(t, { steps: agent(async context => { await context.report({ pullRequest: PULL }); return { status: 'ready' }; }, { async close(repair) { closed.push(repair.id); } }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  for (const conclusion of ['cancelled', 'action_required', 'stale']) {
    h.github.head = C;
    h.github.runs[C] = [run('3', C, conclusion)];
    await h.poll();
    assert.deepEqual([h.repair(B)?.status, closed], ['ready', []], `A ${conclusion} head is not a pass.`);
    assert.equal(h.repair(C), undefined, `A ${conclusion} head is not a failure.`);
  }
  h.github.runs[C] = [run('3', C, 'skipped'), run('4', C, 'skipped', { path: LINT })];
  await h.poll();
  assert.equal(h.repair(B)?.status, 'ready', 'Runs that all skipped passed nothing.');
  h.github.runs[C] = [run('3', C, 'failure', { attempt: 2 })];
  await h.poll();
  assert.equal(h.repair(C)?.status, 'ready', 'The head was never cached as passing.');
  assert.equal(h.repair(B)?.status, 'ready', 'A failed newer head leaves the fix ready.');
});

test('a rerun that ends cancelled, waiting for approval, stale or skipped needs a person and is never flaky', async t => {
  for (const conclusion of ['cancelled', 'action_required', 'stale', 'skipped']) {
    await t.test(conclusion, async t => {
      const h = await harness(t, { steps: agent().steps });
      h.github.logs['2'] = LOGS.availability;
      await h.failHead([run('2', B, 'failure')]);
      await h.manager.idle();
      h.github.runs[B] = [run('2', B, conclusion, { attempt: 2 })];
      await h.poll();
      assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['needs-person', `The rerun ended as ${conclusion.replace('_', ' ')}.`]);
    });
  }
});

test('Stop and supersede hold the one-at-a-time lock until the aborted agent step has settled', async t => {
  let running = 0, most = 0;
  const unwinds: (() => void)[] = [];
  // Each step waits for its abort, then for the test to let it finish unwinding.
  const a = agent(async (_context, signal) => {
    running++; most = Math.max(most, running);
    try { await aborted(signal); const unwind = deferred(); unwinds.push(unwind.resolve); await unwind.promise; return { status: 'failed' }; } finally { running--; }
  });
  const finish = async () => { await until(() => unwinds.length); unwinds.shift()!(); await h.manager.idle(); };
  const h = await harness(t, { steps: a.steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  await h.manager.repair({ runId: '1' });
  await until(() => h.repair(A)?.status === 'repairing');
  await h.manager.stop({ id: h.repair(A)!.id });
  await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && error.message === 'The previous repair is still ending. Try again.');
  h.github.head = B;
  h.github.runs[B] = [run('2', B, 'failure')];
  await h.manager.check();
  assert.equal(h.repair(B), undefined, 'A new head waits while the stopped step unwinds.');
  await finish();
  await h.manager.check();
  await until(() => h.repair(B)?.status === 'repairing');
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.manager.check();
  assert.deepEqual([h.repair(B)?.status, h.repair(C)], ['superseded', undefined], 'The newest head waits for the superseded step.');
  await finish();
  await h.manager.check();
  // The status is set before it is saved and the step starts; wait for the step itself.
  await until(() => h.repair(C)?.status === 'repairing' && a.contexts.length === 3);
  assert.deepEqual([most, a.contexts.length], [1, 3]);
  await h.manager.stop({ id: h.repair(C)!.id });
  await finish();
});

test('a pull request the agent step reports while it unwinds is recorded and stays open, until a newer repair opens its own', async t => {
  const closed: string[] = [];
  const reports: unknown[] = [];
  const a = agent(async (context, signal) => {
    await aborted(signal);
    const number = context.repair.sha === B ? 7 : 8, pullRequest = { number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${context.repair.sha.slice(0, 7)}` };
    reports.push(await context.report({ pullRequest }).then(() => 'recorded', (error: HttpError) => error.statusCode));
    return { status: 'failed' };
  }, { async close(repair) { closed.push(repair.pullRequest!.url); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'repairing');
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.pullRequest], ['superseded', { number: 7, url: 'https://github.com/owner/app/pull/7' }]);
  assert.deepEqual(closed, [], 'It may hold a valid fix.');
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.manager.check();
  await until(() => h.repair(C)?.status === 'repairing');
  await h.manager.stop({ id: h.repair(C)!.id });
  await h.manager.idle();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.pullRequest?.number], ['cancelled', 8], 'A stopped repair records its pull request and keeps it open.');
  assert.deepEqual(closed, ['https://github.com/owner/app/pull/7'], 'The newer repair\'s pull request closes the superseded one\'s.');
  assert.deepEqual(reports, [409, 409], 'The step still learns that the repair stopped.');
});

test('a rerun\'s result is recorded while the head cannot be read', async t => {
  const h = await harness(t, { steps: agent().steps });
  h.github.logs['2'] = LOGS.availability;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.runs[B] = [run('2', B, 'success', { attempt: 2 })];
  h.github.headError = new Error('Could not read main from GitHub.');
  await h.poll();
  assert.equal(h.repair(B)?.status, 'flaky');
  assert.equal(h.manager.view().watchError, 'Could not read main from GitHub.');
});

test('close() waits for a repair opened during shutdown, which then reads nothing from GitHub', async t => {
  const h = await harness(t, { steps: agent().steps });
  await h.poll();
  let closing: Promise<void> | undefined;
  h.github.onRuns = () => { h.github.onRuns = null; setImmediate(() => { closing = h.manager.close(); }); };
  await h.failHead([run('2', B, 'failure')]);
  await closing;
  const failures = h.calls.failures.length;
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual([failures, h.calls.failures.length], [0, 0]);
  assert.ok(closing, 'close() ran while the repair was being opened.');
});

test('the rerun is sent only while the account and repository that opened the repair are still connected', async t => {
  for (const [name, connection, reason] of [
    ['disconnected', null, 'Connect GitHub to repair builds.'],
    ['another account', { login: 'someone-else', repository: 'owner/app' }, 'The GitHub connection changed. Start the repair again.'],
    ['another repository', { login: 'developer', repository: 'owner/other' }, 'The GitHub connection changed. Start the repair again.'],
  ] as const) {
    await t.test(name, async t => {
      const h = await harness(t, { steps: agent().steps });
      const hold = deferred();
      h.github.logs['2'] = LOGS.availability;
      h.github.hold = hold.promise;
      await h.failHead([run('2', B, 'failure')]);
      await until(() => h.calls.failures.length);
      h.github.connection = connection;
      hold.resolve();
      await h.manager.idle();
      assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.calls.reruns], ['needs-person', reason, []]);
    });
  }
});

test('failed runs of a tag, a pull request or another branch at the head open nothing and are never rerun', async t => {
  const h = await harness(t, { steps: agent().steps });
  h.github.logs['3'] = LOGS.availability;
  h.github.logs['4'] = LOGS.availability;
  h.github.runs[A] = [run('1', A, 'success'), run('3', A, 'failure', { branch: 'v1.0.0' }), run('4', A, 'failure', { branch: 'feature', event: 'pull_request' }), run('5', A, 'failure', { event: 'schedule' })];
  await h.poll();
  for (const runId of ['3', '4', '5']) await assert.rejects(h.manager.repair({ runId }), (error: HttpError) => error.statusCode === 409 && error.message === 'This run is not a build of main.');
  await h.failHead([run('2', B, 'success'), run('6', B, 'failure', { branch: 'v1.0.0' }), run('7', B, 'failure', { branch: 'feature', event: 'pull_request' })]);
  await h.poll();
  assert.deepEqual([h.manager.view().repairs, h.calls.reruns, h.calls.failures], [[], [], []]);
  await h.failHead([run('8', C, 'failure'), run('9', C, 'failure', { branch: 'v1.1.0' }), run('10', C, 'success', { event: 'workflow_dispatch', path: LINT })], C);
  await h.manager.idle();
  assert.deepEqual(h.repair(C)?.runs.map(item => item.id), ['8'], 'A repair covers the branch\'s own failed runs only.');
  assert.deepEqual(h.calls.failures, ['8']);
});

test('the view names the watched head of a connected, managed source, and a person\'s Repair names a failed run at that head', async t => {
  const release = deferred();
  const h = await harness(t, { steps: agent(async (_context, signal) => { await Promise.race([release.promise, aborted(signal)]); return { status: 'ready' }; }).steps });
  assert.equal(h.manager.view().head, undefined, 'No head is known before the first read.');
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  assert.deepEqual(h.manager.view().head, { sha: A, branch: 'main', failed: [shown('1')] });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'repairing');
  assert.deepEqual(h.manager.view().head, { sha: B, branch: 'main', failed: [shown('2')] });
  await assert.rejects(h.manager.repair({ runId: '1' }), (error: HttpError) => error.statusCode === 409 && error.message === 'This run is not at the head of main.');
  assert.equal((await h.manager.repair({ runId: '2' })).repairs[0].status, 'repairing', 'The head\'s running repair is the one a person asked for.');
  release.resolve();
  await h.manager.idle();
  h.github.connection = null;
  await h.poll();
  assert.equal(h.manager.view().head, undefined, 'Without a connected account no head is watched.');
  h.github.connection = { login: 'developer', repository: 'owner/app' };
  await h.poll();
  h.current.repository = null;
  assert.equal(h.manager.view().head, undefined, 'A local checkout has no watched head.');
});

test('the view offers the head\'s own failed builds for Repair, at a baseline, after its repair needed a person, and never while they rerun', async t => {
  const h = await harness(t);
  h.github.runs[A] = [run('1', A, 'failure'), run('2', A, 'success', { path: LINT }), run('3', A, 'failure', { branch: 'v1.0.0' }), run('4', A, 'failure', { branch: 'feature', event: 'pull_request' }), run('5', A, 'failure', { path: 'dynamic/pages/pages-build-deployment' })];
  await h.poll();
  assert.deepEqual([h.manager.view().head, h.manager.view().repairs], [{ sha: A, branch: 'main', failed: [shown('1')] }, []], 'A tag\'s, a pull request\'s or a dynamic run is not the branch\'s build.');
  await h.failHead([run('6', B, 'failure'), run('7', B, null, { path: LINT })]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.manager.view().head?.failed], [undefined, [shown('6')]], 'A failed run is offered while another still runs.');
  h.github.runs[B][1] = run('7', B, 'success', { path: LINT });
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.manager.view().head?.failed], ['needs-person', NO_AGENT, [shown('6')]]);
  const again = await h.manager.repair({ runId: '6' });
  assert.deepEqual([again.repairs.length, again.repairs[0].sha, again.repairs[0].trigger], [2, B, 'person'], 'A person starts the head\'s finished repair again.');
  await h.manager.idle();
  h.github.runs[B][0] = run('6', B, null, { attempt: 2 });
  await h.poll();
  assert.deepEqual(h.manager.view().head?.failed, [], 'A run that reruns is not failed.');
  h.github.runs[B][0] = run('6', B, 'success', { attempt: 2 });
  await h.poll();
  assert.deepEqual(h.manager.view().head?.failed, []);
});

test('a start after a restart interrupted a repair recovers its leftovers once; a clean start asks nothing', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/data/sources/github-1/app', rootDirectory: '/', trigger: 'push', createdAt: at, updatedAt: at };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ ...base, id: 'r1', sha: B, status: 'repairing', runs: [], holds: ['The change touches tests.'] }] }));
  let recovered = 0;
  const h = await harness(t, { dataDir, steps: { ...agent().steps, async recover() { recovered++; } } });
  h.manager.start();
  await h.manager.idle();
  assert.deepEqual([recovered, (await h.saved()).repairs[0].holds], [1, ['The change touches tests.']]);
  const clean = await harness(t, { steps: { ...agent().steps, async recover() { recovered++; } } });
  clean.manager.start();
  await clean.manager.idle();
  assert.equal(recovered, 1);
});

// An agent step that opens pull request 7 for B, 8 for C and 9 for D, and a state step that answers from `states`.
// A merged pull request's read names its merge commit: E unless commits names another, or null for a read that names none.
function pulled(outcomes: () => RepairOutcome, states: Record<number, 'open' | 'closed' | 'merged'>, { reads = [] as number[], closed = [] as number[], failing = { reads: 0 }, commits = {} as Record<number, string | null> } = {}) {
  const numbers: Record<string, number> = { [B]: 7, [C]: 8, [D]: 9 };
  const a = agent(async context => {
    const number = numbers[context.repair.sha];
    await context.report({ pullRequest: { number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${context.repair.sha.slice(0, 7)}` } });
    return outcomes();
  }, {
    async state(repair) {
      const number = repair.pullRequest!.number, state = states[number] ?? 'open';
      reads.push(number);
      if (failing.reads > 0) { failing.reads--; throw new Error('GitHub has temporarily limited requests. Wait before trying again.'); }
      return { state, mergeCommit: state === 'merged' ? commits[number] === undefined ? E : commits[number] : null };
    },
    async close(repair) { closed.push(repair.pullRequest!.number); },
  });
  return { ...a, reads, closed };
}

test('a finished repair whose pull request a person merged is merged once the head moves, even when the new head fails', async t => {
  const states: Record<number, 'open' | 'closed' | 'merged'> = {};
  let outcome: RepairOutcome = { status: 'ready' };
  const a = pulled(() => outcome, states);
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.equal(h.repair(B)?.status, 'ready');
  states[7] = 'merged';
  outcome = { status: 'failed', reason: 'The build was not fixed in 4 attempts.' };
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['merged', 'Merged on GitHub.']);
  assert.equal(h.repair(C)?.status, 'failed', 'The merge commit\'s own failure opens its own repair.');
  states[8] = 'merged';
  h.github.head = D;
  h.github.runs[D] = [run('4', D, null)];
  await h.poll();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason], ['merged', 'Merged on GitHub.'], 'A failed repair\'s draft a person merged is merged too.');
  await h.poll();
  assert.deepEqual([a.reads, a.closed], [[7, 8], []], 'Each pull request is read once per head, and nothing is closed.');
  assert.deepEqual((await h.saved()).repairs.map(repair => [repair.sha, repair.status]), [[C, 'merged'], [B, 'merged']]);
});

test('a pull request a person closed is recorded and not read again; a read that failed is tried at the next check', async t => {
  const a = pulled(() => ({ status: 'failed', reason: 'The build was not fixed in 4 attempts.' }), { 7: 'closed' }, { failing: { reads: 1 } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.poll();
  assert.equal((await h.saved()).repairs[0].pullRequest?.closed, undefined, 'A read that failed records nothing.');
  await h.poll();
  await h.poll();
  assert.deepEqual(a.reads, [7, 7]);
  assert.deepEqual([h.repair(B)?.status, (await h.saved()).repairs[0].pullRequest?.closed], ['failed', true], 'A person\'s close leaves the repair as it is.');
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, a.closed], ['superseded', []], 'A passing head supersedes it, and nothing is posted on the closed pull request.');
});

test('open pull requests of failed, stopped and interrupted repairs close as superseded once a newer head passes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z', E = 'e'.repeat(40), F = 'f'.repeat(40);
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/data/sources/github-1/app', rootDirectory: '/', trigger: 'push', runs: [], createdAt: at, updatedAt: at };
  const pull = (number: number) => ({ number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${number}${'0'.repeat(6)}` });
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [
    { ...base, id: 'failed', sha: B, status: 'failed', reason: 'The build was not fixed in 4 attempts.', pullRequest: pull(7) },
    { ...base, id: 'stopped', sha: C, status: 'cancelled', pullRequest: pull(8) },
    { ...base, id: 'interrupted', sha: E, status: 'verifying-ci', pullRequest: pull(9) },
    { ...base, id: 'triaged', sha: F, status: 'needs-person', reason: 'Credentials or permissions need attention.' },
  ] }));
  const a = pulled(() => ({ status: 'ready' }), {});
  const h = await harness(t, { dataDir, steps: a.steps });
  h.github.head = D;
  h.github.runs[D] = [run('5', D, 'success')];
  await h.poll();
  const saved = (await h.saved()).repairs;
  assert.deepEqual(saved.map(repair => [repair.id, repair.status, repair.reason]), [
    ['failed', 'superseded', `Superseded by ${D.slice(0, 7)}.`], ['stopped', 'superseded', `Superseded by ${D.slice(0, 7)}.`],
    ['interrupted', 'superseded', `Superseded by ${D.slice(0, 7)}.`], ['triaged', 'needs-person', 'Credentials or permissions need attention.'],
  ]);
  assert.deepEqual([a.reads, a.closed.sort()], [[7, 8, 9], [7, 8, 9]], 'Each is read for a person\'s merge first, then closed.');
  assert.deepEqual(a.contexts, [], 'The head seen at start opens nothing.');
});

test('the merge step records verifying-gates, the gates it ran and the merge commit; a merged outcome without one has no result', async t => {
  const release = deferred();
  const gates = [{ gateId: 'g1', stageId: 'beta', sha: 'F'.repeat(40), status: 'passed' }];
  const a = agent(async context => {
    await context.report({ status: 'verifying-ci', pullRequest: { ...PULL, draft: false } });
    await context.report({ status: 'verifying-gates' });
    await context.report({ gates });
    await release.promise;
    await context.report({ merged: D });
    return { status: 'merged', merged: D };
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-gates');
  await assert.rejects(a.contexts[0].report({ gates: [{ ...gates[0], sha: 'main' }] }), /Invalid repair progress/);
  await assert.rejects(a.contexts[0].report({ merged: 'main' }), /Invalid repair progress/);
  release.resolve();
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged], ['merged', D]);
  const [stored] = (await h.saved()).repairs;
  assert.deepEqual([stored.status, stored.merged, stored.gates], ['merged', D, [{ ...gates[0], sha: 'f'.repeat(40) }]]);
  const empty = await harness(t, { steps: agent(async () => ({ status: 'merged' })).steps });
  await empty.failHead([run('2', B, 'failure')]);
  await empty.manager.idle();
  assert.deepEqual([empty.repair(B)?.status, empty.repair(B)?.reason], ['needs-person', 'The repair ended without a result.']);
});

test('a ready repair shows its head verified only while that head, as Perpetual last pushed it, is the one CI and the gates passed', async t => {
  for (const [name, reports, shown] of [
    ['verified', [{ pushed: C }, { verified: C }], true],
    ['updated after', [{ pushed: C }, { verified: C }, { pushed: D }], undefined],
    ['never verified', [{ pushed: C }], undefined],
  ] as const) {
    await t.test(name, async t => {
      const h = await harness(t, { steps: agent(async context => { for (const progress of reports) await context.report(progress); return { status: 'ready', reason: 'Auto-merge is off.' }; }).steps });
      await h.failHead([run('2', B, 'failure')]);
      await h.manager.idle();
      assert.deepEqual([h.repair(B)?.status, h.repair(B)?.verified], ['ready', shown]);
    });
  }
  const h = await harness(t, { steps: agent(async context => { await context.report({ verified: 'main' }); return { status: 'ready' }; }).steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason], ['needs-person', 'Invalid repair progress.']);
});

test('a new head never supersedes a fix verifying its gates at once; a newer head that passes retires it and closes its pull request', async t => {
  let stopped = false;
  const closed: number[] = [];
  const a = agent(async (context, signal) => {
    await context.report({ status: 'verifying-ci', pullRequest: { ...PULL, draft: false } });
    await context.report({ status: 'verifying-gates' });
    await aborted(signal);
    stopped = true;
    return { status: 'ready' };
  }, { async close(repair) { closed.push(repair.pullRequest!.number); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-gates');
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.manager.check();
  assert.deepEqual([h.repair(B)?.status, stopped, h.repair(C)], ['verifying-gates', false, undefined], 'Its merge step verifies the moved target branch; a newer failure waits.');
  h.github.runs[C] = [run('3', C, 'success')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, stopped, closed], ['superseded', `Superseded by ${C.slice(0, 7)}.`, true, [7]]);
});

test('a merge reported while a stopped repair unwinds makes it merged, and a restart keeps a recorded merge', async t => {
  const a = agent(async (context, signal) => {
    await context.report({ status: 'verifying-gates', pullRequest: { ...PULL, draft: false } });
    await aborted(signal);
    await assert.rejects(context.report({ merged: D }), (error: HttpError) => error.statusCode === 409);
    return { status: 'ready' };
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.status === 'verifying-gates');
  await h.manager.stop({ id: h.repair(B)!.id });
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.merged], ['merged', undefined, D], 'The pull request merged, whatever stopped the repair.');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', runs: [], createdAt: at, updatedAt: at, pullRequest: PULL };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ ...base, id: 'r1', sha: B, status: 'verifying-gates' }, { ...base, id: 'r2', sha: C, status: 'verifying-gates', merged: D }] }));
  const restarted = await harness(t, { dataDir });
  assert.deepEqual((await restarted.saved()).repairs.map(repair => [repair.id, repair.status, repair.reason]), [['r1', 'needs-person', 'Interrupted by a controller restart.'], ['r2', 'merged', undefined]]);
});

test('auto-merge is on by default, set per pipeline as a boolean, persisted, and read live by a running repair', async t => {
  const reads: boolean[] = [], release = deferred();
  const a = agent(async context => { reads.push(context.autoMerge()); await release.promise; reads.push(context.autoMerge()); return { status: 'ready' }; });
  const h = await harness(t, { steps: a.steps });
  assert.equal(h.manager.view().autoMerge, true);
  await h.failHead([run('2', B, 'failure')]);
  await until(() => reads.length === 1);
  for (const enabled of ['false', 0, null, undefined]) await assert.rejects(h.manager.setAutoMerge({ enabled }), /Choose on or off/);
  assert.equal((await h.manager.setAutoMerge({ enabled: false })).autoMerge, false);
  release.resolve();
  await h.manager.idle();
  assert.deepEqual(reads, [true, false], 'Turning the switch off while a repair runs is read before it merges.');
  assert.deepEqual((await h.saved()).autoMerge, { [KEY]: false });
  Object.assign(h.current, { key: 'github:owner/other:/', repository: 'owner/other' });
  assert.equal(h.manager.view().autoMerge, true, 'Another pipeline keeps its own switch.');
  Object.assign(h.current, { key: KEY, repository: 'owner/app' });
  await h.manager.close();
  const restarted = await harness(t, { dataDir: h.dataDir });
  assert.equal(restarted.manager.view().autoMerge, false, 'The switch survives a restart.');
  Object.assign(restarted.current, { repository: null, checkoutPath: null });
  assert.equal(restarted.manager.view().autoMerge, undefined, 'A local checkout has no switch.');
  await assert.rejects(restarted.manager.setAutoMerge({ enabled: true }), /Connect a GitHub repository/);
  for (const autoMerge of [[], { [KEY]: 'yes' }]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
    await mkdir(join(dataDir, 'repairs')); await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [], autoMerge }));
    await assert.rejects(harness(t, { dataDir }), /Unsupported repair state/);
  }
});

test('loop guard: the merge of a repair that fails again needs a person, and a person may still repair it', async t => {
  const a = agent(async context => {
    if (context.repair.trigger === 'person') return { status: 'ready' };
    await context.report({ status: 'verifying-gates', pullRequest: { ...PULL, draft: false } });
    return { status: 'merged', merged: C };
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged], ['merged', C]);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'The merge of repair #7 failed again.', 1], 'No repair opens by itself, and triage never runs.');
  assert.deepEqual(h.calls.failures, ['2']);
  await h.manager.repair({ runId: '3' });
  await h.manager.idle();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.trigger, a.contexts.length], ['ready', 'person', 2]);
});

test('loop guard: a person\'s merge of a repair\'s pull request is known by the merge commit of the read that found it merged', async t => {
  const reads: number[] = [];
  const a = pulled(() => ({ status: 'ready' }), { 7: 'merged' }, { reads, commits: { 7: C.toUpperCase() } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged, reads], ['merged', C, [7]], 'One read of the pull request names its merge commit.');
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason], ['needs-person', 'The merge of repair #7 failed again.']);
  assert.deepEqual([a.contexts.length, reads], [1, [7]], 'A merged repair that knows its merge commit is not read again.');
});

test('loop guard: a merged repair whose read named no merge commit is read again at each check until one does, and its failing merge opens no repair meanwhile', async t => {
  const reads: number[] = [], commits: Record<number, string | null> = { 7: null }, failing = { reads: 0 };
  const a = pulled(() => ({ status: 'ready' }), { 7: 'merged' }, { reads, commits, failing });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged, h.repair(C)], ['merged', undefined, undefined], 'The failing head may be its merge, so it waits.');
  failing.reads = 1;
  await h.poll();
  assert.deepEqual([reads, h.repair(C)], [[7, 7], undefined], 'A read that failed is tried again at the next check.');
  commits[7] = C;
  await h.poll();
  assert.deepEqual([reads, h.repair(B)?.merged, (await h.saved()).repairs.find(repair => repair.sha === B)?.merged], [[7, 7, 7], C, C]);
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'The merge of repair #7 failed again.', 1]);
  await h.poll();
  assert.deepEqual(reads, [7, 7, 7], 'Once known, it is not read again.');
});

test('a pull request found merged when it is closed as superseded records the merge commit that read names, and one naming none is read again', async t => {
  for (const named of [D, null]) {
    const reads: number[] = [], numbers: Record<string, number> = { [B]: 7, [C]: 8 };
    let merged = false;
    // A person merges pull request 7 just before Perpetual closes it, once a newer repair opened its own.
    const h = await harness(t, { steps: agent(async context => {
      const number = numbers[context.repair.sha];
      await context.report({ pullRequest: { number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${context.repair.sha.slice(0, 7)}` } });
      return { status: 'ready' };
    }, {
      async state(repair) { const number = repair.pullRequest!.number; reads.push(number); return merged && number === 7 ? { state: 'merged', mergeCommit: D } : { state: 'open', mergeCommit: null }; },
      async close() { merged = true; return { state: 'merged', mergeCommit: named }; },
    }).steps });
    await h.failHead([run('2', B, 'failure')]);
    await h.manager.idle();
    await h.failHead([run('3', C, 'failure')], C);
    await h.manager.idle();
    assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.merged ?? null, reads], ['merged', 'Merged on GitHub.', named, [7]], 'The close\'s own read names the merge commit.');
    await h.poll();
    // The newer fix, ready at the head, has its pull request 8 read at each check.
    assert.deepEqual([h.repair(B)?.merged, h.repair(C)?.status, reads], [D, 'ready', named ? [7, 8] : [7, 7, 8]], named ? 'A known merge commit is not read again.' : 'One naming none is read at the next check.');
  }
});

test('a ready repair\'s pull request is read at every check, so one a person closes reads Not merged and its failed run may be repaired again', async t => {
  const reads: number[] = [], states: Record<number, 'open' | 'closed' | 'merged'> = {};
  const a = pulled(() => ({ status: 'ready', reason: 'Auto-merge is off.' }), states, { reads });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  await h.poll();
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.pullRequest?.closed, reads], ['ready', undefined, [7, 7]], 'The fix at the watched head is read at each check.');
  assert.deepEqual(autopilotStages(h.manager.view(), 'build').build.failed?.runs, [], 'A fix waiting with its pull request is not started again.');
  await assert.rejects(h.manager.repair({ runId: '2' }), (error: HttpError) => error.statusCode === 409 && error.message === 'This commit already has a repair.');
  states[7] = 'closed';
  await h.poll();
  const reached = reads.length;
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.pullRequest?.closed, reads.length], ['ready', true, reached], 'A closed pull request is recorded and not read again.');
  assert.equal((await h.saved()).repairs[0].pullRequest?.closed, true);
  const stage = autopilotStages(h.manager.view(), 'build').build;
  assert.deepEqual([stage.changes[0].status, stage.failed?.runs], ['not-merged', [shown('2')]], 'The rejected fix reads Not merged, and Build offers Repair again.');
  await h.manager.repair({ runId: '2' });
  await h.manager.idle();
  assert.deepEqual([h.manager.view().repairs.length, h.repair(B)?.trigger, h.repair(B)?.status, a.contexts.length], [2, 'person', 'ready', 2]);
});

test('a ready repair whose pull request a person merges is merged at the next check, before the head moves, and its merge failing needs a person', async t => {
  const states: Record<number, 'open' | 'closed' | 'merged'> = {};
  const a = pulled(() => ({ status: 'ready', reason: 'Auto-merge is off.' }), states, { commits: { 7: C } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  states[7] = 'merged';
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.reason, h.repair(B)?.merged], ['merged', 'Merged on GitHub.', C]);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'The merge of repair #7 failed again.', 1]);
});

test('loop guard: a person\'s merge of a pull request whose repair was verifying its gates is read once the repair ends at ready or is stopped', async t => {
  for (const end of ['ready', 'cancelled'] as const) {
    const reads: number[] = [], release = deferred();
    const a = agent(async (context, signal) => {
      if (context.repair.sha !== B) return { status: 'ready' };
      await context.report({ status: 'verifying-gates', pullRequest: { ...PULL, draft: false } });
      await Promise.race([release.promise, aborted(signal)]);
      return { status: 'ready', reason: 'Auto-merge is off.' };
    }, { async state(repair) { reads.push(repair.pullRequest!.number); return { state: 'merged', mergeCommit: C }; } });
    const h = await harness(t, { steps: a.steps });
    await h.failHead([run('2', B, 'failure')]);
    await until(() => h.repair(B)?.status === 'verifying-gates');
    // A person merges pull request 7 as C, which fails, while its repair's gates are at work.
    h.github.head = C;
    h.github.runs[C] = [run('3', C, 'failure')];
    await h.manager.check();
    assert.deepEqual([h.repair(B)?.status, h.repair(C), reads], ['verifying-gates', undefined, []], 'The merge step owns its pull request, and a newer failure waits.');
    if (end === 'ready') release.resolve(); else await h.manager.stop({ id: h.repair(B)!.id });
    await h.manager.idle();
    assert.equal(h.repair(B)?.status, end);
    await h.poll();
    assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged, reads], ['merged', C, [7]], 'Its pull request is read at the head once the repair ended.');
    assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'The merge of repair #7 failed again.', 1]);
  }
});

test('loop guard: a pull request still being closed as superseded, or whose close GitHub refused, is read at a failing head, and its merge needs a person', async t => {
  for (const failure of [new Error('connect ECONNRESET 140.82.112.3:443'), Object.assign(new Error('Pull request is locked.'), { refused: true })]) {
    const reads: number[] = [], states: Record<number, 'open' | 'merged'> = {};
    const a = pulled(() => ({ status: 'ready' }), states, { reads, commits: { 7: D } });
    a.steps.close = async () => { throw failure; };
    const h = await harness(t, { steps: a.steps });
    await h.failHead([run('2', B, 'failure')]);
    await h.manager.idle();
    await h.failHead([run('3', C, 'failure')], C);
    await h.manager.idle();
    const older = (await h.saved()).repairs.find(repair => repair.sha === B);
    assert.deepEqual([older?.status, older?.pullRequest?.closing, Boolean(older?.closeError)], ['superseded', true, 'refused' in failure], 'Pull request 8 retired 7, whose close failed.');
    // A person merges pull request 7 as D, which fails.
    states[7] = 'merged';
    h.github.head = D;
    h.github.runs[D] = [run('4', D, 'failure')];
    await h.poll();
    assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged, reads], ['merged', D, [7, 8, 7]]);
    assert.deepEqual([h.repair(D)?.status, h.repair(D)?.reason, a.contexts.length], ['needs-person', 'The merge of repair #7 failed again.', 2]);
  }
});

test('loop guard: a pull request it cannot read, or whose merge commit GitHub never names, holds a failing head for ten checks, then that head needs a person and no later head waits for it', async t => {
  for (const answer of ['unreadable', 'unnamed'] as const) {
    const reads: number[] = [];
    const a = agent(async context => {
      const number = context.repair.sha === B ? 7 : 9;
      await context.report({ pullRequest: { number, url: `https://github.com/owner/app/pull/${number}`, branch: `perpetual/repair/${context.repair.sha.slice(0, 7)}` } });
      return { status: 'ready' };
    }, {
      async state(repair) {
        const number = repair.pullRequest!.number;
        reads.push(number);
        if (number !== 7) return { state: 'open', mergeCommit: null };
        if (answer === 'unreadable') throw new Error('GitHub returned an unreadable pull request.');
        return { state: 'merged', mergeCommit: null };
      },
    });
    const h = await harness(t, { steps: a.steps });
    await h.failHead([run('2', B, 'failure')]);
    await h.manager.idle();
    h.github.head = C;
    h.github.runs[C] = [run('3', C, 'failure')];
    for (let check = 1; check < 10; check++) await h.poll();
    assert.deepEqual([h.repair(C), reads.length], [undefined, 9], 'C may be the merge of pull request 7, so it waits.');
    await h.poll();
    assert.deepEqual([h.repair(C)?.status, h.repair(C)?.reason, a.contexts.length], ['needs-person', 'Could not tell whether this is the merge of repair #7.', 1]);
    h.github.head = D;
    h.github.runs[D] = [run('4', D, 'failure')];
    await h.poll();
    assert.deepEqual([h.repair(D)?.status, a.contexts.length, reads.length], ['ready', 2, 10], 'The guard no longer waits for pull request 7, nor reads it.');
  }
});

test('loop guard: a repair of the repository under a name the connected account no longer uses is never waited for, since it cannot be read as that account', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z', reads: string[] = [];
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'renamed', key: KEY, repository: 'Owner/App', branch: 'main', sha: B, login: 'developer', checkoutPath: '/c', rootDirectory: '/',
    trigger: 'push', status: 'ready', runs: [], pullRequest: PULL, createdAt: at, updatedAt: at }] }));
  // As the agent step reads it: another repository than the connected one's is refused before GitHub is read.
  const a = agent(async () => ({ status: 'ready' }), {
    async state(repair) { reads.push(repair.repository); if (repair.repository !== 'owner/app') throw new Error('The GitHub connection changed. Start the repair again.'); return { state: 'open', mergeCommit: null }; },
    async close() {},
  });
  const h = await harness(t, { dataDir, steps: a.steps });
  await h.failHead([run('3', C, 'failure')], C);
  await h.manager.idle();
  assert.deepEqual([h.repair(C)?.status, a.contexts.length, reads], ['ready', 1, []]);
});

test('cleanup ownership is durable before work, and failed cleanup preserves a merged result until retry', async t => {
  let cleans = 0, failed = true, owned = false;
  const a = agent(async context => {
    const saved = JSON.parse(await readFile(join(context.directory, '..', 'state.json'), 'utf8'));
    owned = saved.repairs.find((repair: Repair) => repair.id === context.repair.id)?.cleanup?.status === 'pending';
    await mkdir(join(context.directory, 'clone'));
    await writeFile(join(context.directory, 'clone', 'evidence'), 'keep until resources are absent');
    await context.report({ merged: E });
    return { status: 'merged', merged: E, reason: 'The pull request label needs attention.' };
  }, { async cleanup({ directory }) { cleans++; if (failed) throw new Error('Docker removal failed'); await rm(directory, { recursive: true, force: true }); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]); await h.manager.idle();
  assert.equal(owned, true, 'Resources are owned durably before the agent can allocate them.');
  const saved = (await h.saved()).repairs[0];
  assert.deepEqual([saved.status, saved.merged, saved.reason, saved.cleanup], ['merged', E, 'The pull request label needs attention.', { status: 'failed', reason: 'Docker removal failed' }]);
  assert.equal(await readFile(join(h.dataDir, 'repairs', saved.id, 'clone', 'evidence'), 'utf8'), 'keep until resources are absent');
  await h.failHead([run('3', C, 'failure')], C); await h.manager.idle();
  assert.equal(a.contexts.length, 1, 'Unresolved resources hold new work.');
  failed = false;
  h.github.connection = null; // Cleanup does not need GitHub or a source selection.
  await h.poll();
  assert.equal((await h.saved()).repairs.find(repair => repair.id === saved.id)?.cleanup, undefined);
  assert.equal(a.contexts.length, 1, 'Retry only cleans; it never reruns the merged repair.');
  assert.ok(cleans >= 2);
});

test('a restart retains terminal repair resources until recovery confirms deletion and never resumes paid work', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs', 'finished', 'clone'), { recursive: true });
  await writeFile(join(dataDir, 'repairs', 'finished', 'clone', 'evidence'), 'retained');
  const at = '2026-09-25T09:00:00.000Z';
  const record = { id: 'finished', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'merged', merged: E, runs: [], createdAt: at, updatedAt: at };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [record] }));
  let recoveries = 0, failed = true, cleans = 0;
  const a = agent(undefined, {
    async recover() { recoveries++; if (failed) throw new Error('Docker unavailable'); },
    async cleanup({ directory }) { cleans++; await rm(directory, { recursive: true, force: true }); },
  });
  const h = await harness(t, { dataDir, steps: a.steps });
  assert.equal(await readFile(join(dataDir, 'repairs', 'finished', 'clone', 'evidence'), 'utf8'), 'retained');
  h.manager.start(); await h.manager.idle();
  assert.deepEqual([recoveries, cleans, a.contexts.length], [1, 0, 0]);
  const held = (await h.saved()).repairs[0];
  assert.deepEqual([held.status, held.merged, held.cleanup], ['merged', E, { status: 'failed', reason: 'Docker unavailable' }]);
  failed = false; await h.poll();
  assert.deepEqual([recoveries, cleans, a.contexts.length, (await h.saved()).repairs[0].cleanup], [2, 1, 0, undefined]);
  await assert.rejects(stat(join(dataDir, 'repairs', 'finished')), { code: 'ENOENT' });
});

test('a known merge survives an agent failure and Stop retains cleanup until the aborted agent ends', async t => {
  const ended = deferred(); let cleaning = 0;
  const a = agent(async (context, signal) => {
    await context.report({ merged: E });
    await aborted(signal); await ended.promise;
    throw new Error('The agent ended after GitHub merged.');
  }, { async cleanup() { cleaning++; throw new Error('Still attached'); } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]);
  await until(() => h.repair(B)?.merged === E);
  await h.manager.stop({ id: h.repair(B)!.id });
  assert.equal(cleaning, 0, 'Stop does not race cleanup with a live agent.');
  ended.resolve(); await h.manager.idle();
  const saved = (await h.saved()).repairs[0];
  assert.deepEqual([saved.status, saved.merged, saved.cleanup], ['merged', E, { status: 'failed', reason: 'Still attached' }]);
});

test('startup recovery is an admission barrier and runs once before a new agent owns resources', async t => {
  let failed = true;
  const previous = agent(async () => ({ status: 'failed', reason: 'No fix.' }), { async cleanup() { if (failed) throw new Error('Docker unavailable'); } });
  const h = await harness(t, { steps: previous.steps });
  await h.failHead([run('2', B, 'failure')]); await h.manager.idle(); await h.manager.close();
  const release = deferred(), entered = deferred(); let recoveries = 0;
  const next = agent(async () => ({ status: 'ready' }), {
    async recover() { recoveries++; entered.resolve(); await release.promise; },
    async cleanup() {},
  });
  const restarted = await harness(t, { dataDir: h.dataDir, steps: next.steps });
  restarted.github.head = B; restarted.github.runs[B] = [run('2', B, 'failure')];
  restarted.manager.start(); await entered.promise;
  const manual = restarted.manager.repair({ runId: '2' });
  await new Promise(done => setTimeout(done, 5));
  assert.equal(next.contexts.length, 0);
  assert.equal((await restarted.saved()).repairs[0].cleanup?.status, 'failed');
  failed = false; release.resolve();
  await manual; await restarted.manager.idle();
  assert.deepEqual([recoveries, next.contexts.length, (await restarted.saved()).repairs[0].cleanup], [1, 1, undefined]);
  await restarted.poll(); assert.equal(recoveries, 1, 'A later check cannot sweep a different live repair.');
});

test('legacy merged history without its clone still recovers Docker ownership before admission', async t => {
  const previous = agent(async () => ({ status: 'merged', merged: E }));
  const h = await harness(t, { steps: previous.steps });
  await h.failHead([run('2', B, 'failure')]); await h.manager.idle(); await h.manager.close();
  const saved = (await h.saved()).repairs[0];
  await rm(join(h.dataDir, 'repairs', saved.id), { recursive: true, force: true });
  let failed = true, recovered = 0;
  const next = agent(undefined, { async recover() { recovered++; if (failed) throw new Error('Docker list failed'); }, async cleanup() {} });
  const restarted = await harness(t, { dataDir: h.dataDir, steps: next.steps });
  restarted.manager.start(); await restarted.manager.idle();
  assert.deepEqual([recovered, next.contexts.length], [1, 0]);
  assert.deepEqual((await restarted.saved()).repairs.map(repair => [repair.status, repair.merged, repair.cleanup]), [['merged', E, undefined]], 'The sweep\'s failure holds new repairs without marking history as owning what it may not.');
  assert.match(restarted.manager.view().watchError ?? '', /cleanup must finish before another repair can start\. Docker list failed/);
  failed = false; await restarted.poll();
  assert.deepEqual([recovered, next.contexts.length, (await restarted.saved()).repairs[0].cleanup], [2, 0, undefined]);
});

// A machine without Docker: a repair that needed a person at triage, or whose agent step could not start, made no box.
test('history that never made a box needs no Docker sweep at a start', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  const base = { key: KEY, repository: 'owner/app', branch: 'main', login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', runs: [], createdAt: at, updatedAt: at };
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [
    { ...base, id: 'triaged', sha: B, status: 'needs-person', reason: 'VERCEL_TOKEN is required', category: 'configuration' },
    { ...base, id: 'unstarted', sha: C, status: 'needs-person', reason: 'Install Docker to repair builds.', category: 'build', startedAt: at },
  ] }));
  let recoveries = 0;
  const h = await harness(t, { dataDir, steps: agent(undefined, { async recover() { recoveries++; throw new Error('Docker unavailable'); }, async cleanup() {} }).steps });
  h.github.runs[A] = [run('1', A, 'failure')];
  await h.poll();
  assert.deepEqual([recoveries, h.manager.view().watchError, h.manager.view().head?.failed, (await h.saved()).repairs.map(repair => repair.cleanup)], [0, undefined, [shown('1')], [undefined, undefined]]);
});

test('a startup sweep that fails holds new repairs, while heads and pull requests are still followed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'fixed', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'ready', runs: [{ id: '2', name: 'CI', path: CI, attempt: 1, url: null }], pullRequest: PULL, createdAt: at, updatedAt: at }] }));
  let failed = true;
  const a = agent(undefined, { async recover() { if (failed) throw new Error('Docker unavailable'); }, async cleanup() {}, async state() { return { state: 'merged', mergeCommit: C }; } });
  const h = await harness(t, { dataDir, steps: a.steps });
  h.github.head = C;
  h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.merged, h.calls.heads.length, h.manager.view().head?.failed], ['merged', C, 1, []], 'The head is read and a person\'s merge followed; no Repair is offered while the sweep holds.');
  assert.match(h.manager.view().watchError ?? '', /cleanup must finish before another repair can start\. Docker unavailable/);
  await assert.rejects(h.manager.repair({ runId: '3' }), (error: HttpError) => error.statusCode === 409 && error.message === 'Repair cleanup must finish before another repair can start. Docker unavailable', 'A person reads the sweep\'s reason.');
  failed = false;
  await h.poll();
  assert.deepEqual([h.manager.view().watchError, h.manager.view().head?.failed, a.contexts.length], [undefined, [shown('3')], 0]);
});

// A machine that once had Docker and no longer has it still triages and reruns its failures; only the agent needs Docker.
test('while the startup sweep fails, triage and reruns go ahead, and a failure the agent would take needs a person with the sweep\'s reason', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-'));
  await mkdir(join(dataDir, 'repairs'));
  const at = '2026-09-25T09:00:00.000Z';
  await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'old', key: KEY, repository: 'owner/app', branch: 'main', sha: E, login: 'developer', checkoutPath: '/c', rootDirectory: '/', trigger: 'push', status: 'merged', merged: '9'.repeat(40), runs: [], createdAt: at, updatedAt: at }] }));
  let failed = true;
  const a = agent(undefined, { async recover() { if (failed) throw new Error('Docker unavailable'); }, async cleanup() {} });
  const h = await harness(t, { dataDir, steps: a.steps });
  h.github.logs['2'] = LOGS.configuration;
  await h.failHead([run('2', B, 'failure')]);
  await h.manager.idle();
  assert.deepEqual([h.repair(B)?.status, h.repair(B)?.category], ['needs-person', 'configuration'], 'Triage needs no Docker.');
  h.github.logs['3'] = LOGS.availability;
  await h.failHead([run('3', C, 'failure')], C);
  await h.manager.idle();
  assert.deepEqual([h.repair(C)?.status, h.calls.reruns], ['rerunning', ['3']], 'Nor does a rerun.');
  await h.failHead([run('4', D, 'failure')], D);
  await h.manager.idle();
  assert.deepEqual([h.repair(D)?.status, h.repair(D)?.reason, h.repair(D)?.cleanup, a.contexts.length], ['needs-person', 'Repair cleanup must finish before another repair can start. Docker unavailable', undefined, 0], 'No agent starts before the sweep.');
  failed = false;
  await h.poll();
  assert.deepEqual(h.manager.view().head?.failed, [shown('4')], 'Once the sweep succeeds, a person may repair it.');
  await h.manager.repair({ runId: '4' });
  await h.manager.idle();
  assert.deepEqual([h.repair(D)?.status, a.contexts.length], ['ready', 1]);
});

test('cleanup held by another source stays visible and withholds Repair until cleanup succeeds', async t => {
  let failed = true;
  const secret = `sk-or-v1-${'a'.repeat(600)}`;
  const a = agent(async () => ({ status: 'failed', reason: 'No fix.' }), {
    async cleanup() { if (failed) throw new Error(`Docker refused token ${secret}`); },
  });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]); await h.manager.idle();
  Object.assign(h.current, { key: 'github:acme/beta:/', repository: 'acme/beta', checkoutPath: '/data/sources/github-2/beta' });
  h.github.connection = { login: 'developer', repository: 'acme/beta' };
  h.github.head = C; h.github.runs[C] = [run('3', C, 'failure')];
  await h.poll();
  const held = h.manager.view();
  assert.deepEqual(held.repairs, [], 'Another source\'s history is not copied into this stage.');
  assert.deepEqual(held.head?.failed, [], 'Global cleanup admission holds apply even with no visible repair.');
  assert.match(held.watchError ?? '', /cleanup/i);
  assert.match(held.watchError ?? '', /Docker refused token \[REDACTED\]/);
  assert.ok(!held.watchError?.includes('sk-or-v1-'), 'The complete secret is redacted before any limit.');
  h.github.headError = new Error('GitHub is temporarily unavailable.'); await h.poll();
  assert.match(h.manager.view().watchError ?? '', /GitHub is temporarily unavailable/);
  assert.match(h.manager.view().watchError ?? '', /cleanup/i, 'A normal watch error does not hide the cleanup hold.');
  failed = false; await h.poll();
  assert.equal(h.manager.view().watchError, 'GitHub is temporarily unavailable.', 'Cleanup success preserves an independent watch error.');
  h.github.headError = null; await h.poll();
  assert.equal(h.manager.view().watchError, undefined);
  assert.deepEqual(h.manager.view().head?.failed, [shown('3')], 'The current source offers Repair again after cleanup succeeds.');
  assert.deepEqual(h.manager.view().repairs, []);
  assert.equal(a.contexts.length, 1, 'Cleanup recovery did not run another agent.');
});

test('successful cleanup in progress withholds another source\'s Repair without reporting an error', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const a = agent(async () => ({ status: 'ready' }), { async cleanup() { entered.resolve(); await release.promise; } });
  const h = await harness(t, { steps: a.steps });
  await h.failHead([run('2', B, 'failure')]); await entered.promise;
  Object.assign(h.current, { key: 'github:acme/beta:/', repository: 'acme/beta', checkoutPath: '/data/sources/github-2/beta' });
  h.github.connection = { login: 'developer', repository: 'acme/beta' };
  h.github.head = C; h.github.runs[C] = [run('3', C, 'failure')];
  await h.manager.check();
  const held = h.manager.view();
  assert.deepEqual([held.repairs, held.head?.failed, held.watchError], [[], [], undefined]);
  release.resolve(); await h.manager.idle(); await h.poll();
  assert.deepEqual(h.manager.view().head?.failed, [shown('3')]);
  assert.equal(h.manager.view().watchError, undefined);
});

test('successful restart cleanup clears its own error even while GitHub is disconnected', async t => {
  for (const legacy of ['history', 'orphan']) await t.test(legacy, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-')), root = join(dataDir, 'repairs');
    await mkdir(root);
    if (legacy === 'history') {
      const at = '2026-09-25T09:00:00.000Z';
      await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'finished', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/neutral/source', rootDirectory: '/', trigger: 'push', status: 'merged', merged: E, runs: [], createdAt: at, updatedAt: at }] }));
    } else await mkdir(join(root, 'orphan'));
    let failed = true;
    const a = agent(undefined, { async recover() { if (failed) throw new Error('Docker unavailable'); }, async cleanup() {} });
    const h = await harness(t, { dataDir, steps: a.steps, connection: null });
    await h.poll();
    assert.match(h.manager.view().watchError ?? '', /Docker unavailable/);
    assert.equal(h.calls.heads.length, 0, 'Disconnected recovery does not need a GitHub read.');
    failed = false; await h.poll();
    assert.equal(h.manager.view().watchError, undefined, 'A confirmed recovery clears the error it owns.');
    assert.equal(a.contexts.length, 0, 'Recovery never resumes authoring.');
  });
});
