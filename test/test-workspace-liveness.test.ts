import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace } from '../client/src/lib/test-workspace.ts';
import type { BrowserRun, CaseProgress, RunProgress } from '../client/src/lib/browser-test-ui.ts';
import type { Environment } from '../client/src/lib/test-workspace.ts';

const source = { path: '/project', branch: 'main' };
const journey = { id: 'journey', name: 'Run a workflow and spend credits', needsReview: false, steps: [{ id: 'sign-in', title: 'Sign in' }, { id: 'run', title: 'Run workflow' }] };
const progress = (revision: number, status = 'running', extra: Partial<CaseProgress> = {}): RunProgress => ({ revision, cases: [{ id: 'journey', caseId: 'journey', name: 'Run a workflow and spend credits', status, actionCount: revision, lastAction: { type: 'click', status: 'passed' }, steps: [{ id: 'sign-in', title: 'Sign in', status: 'completed' }, { id: 'run', title: 'Run workflow', status: 'running' }], ...extra }] });
const run = (id: string, extra: Partial<BrowserRun> = {}): BrowserRun => ({ id, stageId: 'beta', mode: 'run', status: 'running', targetUrl: 'http://localhost:3000/', sourceRevision: null, caseSummaries: [], createdAt: '2026-09-23T10:00:00.000Z', caseIds: ['journey'], progress: progress(3), ...extra });
const summary = (runs: BrowserRun[], environments: Environment[] = [{ id: 'env', stageId: 'beta', status: 'ready', updatedAt: '2026-09-23T09:00:00.000Z', health: { checkedAt: '2026-09-23T10:00:00.000Z', ok: true, consecutiveFailures: 0 } }]) => ({ scan: { repo: source }, browserTests: { beta: { cases: [journey], runs, preparation: null } }, environments, stageRemovals: [{ id: 'removal', stageId: 'gamma', status: 'failed' }] });
function fixture(t: TestContext, reply: (path: string, input?: Record<string, unknown>) => unknown, options: Omit<Parameters<typeof createTestWorkspace>[0], 'controller'> = {}) {
  const calls: string[] = [];
  const workspace = createTestWorkspace({ controller: async (path, input) => { calls.push(path); return structuredClone(await reply(path, input)); }, pollInterval: 0, ...options });
  workspace.activate(source, { browserTests: { beta: { cases: [], runs: [] } } });
  t.after(() => workspace.dispose());
  return { workspace, calls, stage: workspace.stage('beta') };
}

test('an unchanged poll keeps the graph snapshot and each stage referentially identical', async t => {
  const { workspace } = fixture(t, () => summary([run('a'), run('b', { status: 'passed', progress: progress(9, 'passed') })]));
  await workspace.refreshSource();
  const before = workspace.getSnapshot();
  await workspace.refreshSource();
  const after = workspace.getSnapshot();
  assert.equal(after.browserTests.beta, before.browserTests.beta);
  assert.equal(after.browserTests, before.browserTests);
  assert.equal(after.environments, before.environments);
  assert.equal(after.stageRemovals, before.stageRemovals);
  assert.equal(after, before, 'Subscribers observe no change for an unchanged poll.');
});

test('a changed run replaces only its own records', async t => {
  let revision = 3;
  const { workspace } = fixture(t, () => summary([run('a', { progress: progress(revision) }), run('b', { status: 'passed', progress: progress(9, 'passed') })]));
  await workspace.refreshSource();
  const before = workspace.getSnapshot().browserTests.beta, environments = workspace.getSnapshot().environments;
  revision = 4;
  await workspace.refreshSource();
  const after = workspace.getSnapshot().browserTests.beta;
  assert.notEqual(after, before);
  assert.notEqual(after.runs[0], before.runs[0]);
  assert.equal(after.runs[0].progress?.revision, 4);
  assert.equal(after.runs[1], before.runs[1], 'An unchanged run keeps its identity.');
  assert.equal(after.cases, before.cases);
  assert.equal(workspace.getSnapshot().environments, environments, 'Other stage records keep their identity.');
});

test('progress is keyed on its revision while case states still update', async t => {
  let value = progress(5);
  const { workspace } = fixture(t, () => summary([run('a', { progress: value })]));
  await workspace.refreshSource();
  const first = workspace.getSnapshot().browserTests.beta.runs[0].progress;
  value = progress(5);
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().browserTests.beta.runs[0].progress, first);
  value = progress(5, 'skipping');
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().browserTests.beta.runs[0].progress?.cases?.[0].status, 'skipping', 'A scheduler state change is never hidden by an unchanged revision.');
  value = progress(5, 'skipping', { frameUpdatedAt: '2026-09-23T10:00:05.000Z' });
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().browserTests.beta.runs[0].progress?.cases?.[0].frameUpdatedAt, '2026-09-23T10:00:05.000Z');
});

test('an unchanged environment health poll keeps identity and a new heartbeat replaces it', async t => {
  let checkedAt = '2026-09-23T10:00:00.000Z';
  const environment = () => [{ id: 'env', stageId: 'beta', status: 'ready', updatedAt: '2026-09-23T09:00:00.000Z', health: { checkedAt, ok: true, consecutiveFailures: 0 } }];
  const { workspace } = fixture(t, () => summary([], environment()));
  await workspace.refreshSource();
  const before = workspace.getSnapshot().environments;
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().environments, before);
  checkedAt = '2026-09-23T10:00:30.000Z';
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().environments[0].health?.checkedAt, checkedAt);
});

test('an unchanged inspector read keeps the stage view identical', async t => {
  const view = { config: { targetUrl: 'http://127.0.0.1:55887/login' }, cases: [journey], runs: [run('a')], preparation: null, capabilities: { browser: true } };
  const { stage, workspace } = fixture(t, () => view);
  await stage.refresh('browser');
  const before = stage.getSnapshot(), graph = workspace.getSnapshot().browserTests.beta;
  await stage.refresh('browser');
  assert.equal(stage.getSnapshot(), before);
  assert.equal(workspace.getSnapshot().browserTests.beta, graph);
});

test('polling pauses while the page is hidden and resumes immediately when visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const { workspace, calls } = fixture(t, () => summary([]), { pollInterval: 3000, document });
  const stop = workspace.subscribe(() => {});
  t.after(stop);
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
  calls.length = 0;
  t.mock.timers.tick(3000); await settle();
  assert.deepEqual(calls, ['/api/state']);
  document.hidden = true;
  t.mock.timers.tick(3000); await settle();
  t.mock.timers.tick(30000); await settle();
  assert.equal(calls.length, 1, 'A hidden page does not poll.');
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls.length, 2, 'Returning to the page refreshes without waiting for the interval.');
  t.mock.timers.tick(3000); await settle();
  assert.equal(calls.length, 3);
  workspace.dispose();
  document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls.length, 3, 'A disposed workspace ignores visibility.');
});
