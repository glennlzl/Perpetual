import test from 'node:test';
import assert from 'node:assert/strict';
import { stageActivity, environmentWorking, type ActivitySnapshot } from '../client/src/lib/stage-activity.ts';
import type { BrowserRun } from '../client/src/lib/browser-test-ui.ts';
import type { BrowserPreparation, Environment, StageRemoval } from '../client/src/lib/test-workspace.ts';

const beta = { id: 'beta', kind: 'sandbox', name: 'Beta' };
// Shapes follow /api/state: environments.summaries, browser.summary and stageRemovals.
const environment = (status: string, extra: Partial<Environment> = {}): Environment => ({ id: `env-${status}`, stageId: 'beta', status, step: status === 'ready' ? 'Ready' : 'Preparing application', sourceRevision: 'cb9292c', createdAt: '2026-09-23T10:00:00.000Z', updatedAt: '2026-09-23T10:01:00.000Z', ...extra });
const run = (mode: BrowserRun['mode'], status: BrowserRun['status']): Pick<BrowserRun, 'mode' | 'status'> => ({ mode, status });
const snapshot = ({ environments = [], runs = [], preparation = null, stageRemovals = [] }: { environments?: Environment[]; runs?: Pick<BrowserRun, 'mode' | 'status'>[]; preparation?: Pick<BrowserPreparation, 'status'> | null; stageRemovals?: StageRemoval[] } = {}): ActivitySnapshot => ({ environments, browserTests: { beta: { runs, preparation } }, stageRemovals });

test('ready environments and finished runs are idle', () => {
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('ready')], runs: [run('run', 'passed'), run('discover', 'completed')], preparation: { status: 'completed' } })), null);
  assert.equal(stageActivity(beta, {}), null);
});

test('environment lifecycle drives provisioning and removal activity', () => {
  for (const status of ['queued', 'creating', 'preparing']) assert.equal(stageActivity(beta, snapshot({ environments: [environment(status)] })), 'provisioning', status);
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('destroying')] })), 'removing');
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('failed'), environment('cleanup_failed')] })), null);
});

test('confirmed stage removal is removing until it completes or fails', () => {
  for (const status of ['queued', 'removing']) assert.equal(stageActivity(beta, snapshot({ environments: [environment('ready')], stageRemovals: [{ id: 'removal', stageId: 'beta', status }] })), 'removing');
  for (const status of ['completed', 'failed']) assert.equal(stageActivity(beta, snapshot({ stageRemovals: [{ id: 'removal', stageId: 'beta', status }] })), null);
  assert.equal(stageActivity(beta, snapshot({ stageRemovals: [{ id: 'removal', stageId: 'gamma', status: 'removing' }] })), null);
});

test('browser runs distinguish testing from discovery', () => {
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('ready')], runs: [run('run', 'running')] })), 'testing');
  assert.equal(stageActivity(beta, snapshot({ runs: [run('run', 'queued')] })), 'testing');
  assert.equal(stageActivity(beta, snapshot({ runs: [run('discover', 'running')] })), 'discovering');
  for (const status of ['preparing', 'discovering']) assert.equal(stageActivity(beta, snapshot({ preparation: { status } })), 'discovering');
  assert.equal(stageActivity(beta, snapshot({ preparation: { status: 'needs_setup' } })), null);
});

test('removal outranks provisioning, which outranks testing and discovery', () => {
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('creating')], stageRemovals: [{ stageId: 'beta', status: 'removing' }] })), 'removing');
  assert.equal(stageActivity(beta, snapshot({ environments: [environment('preparing')], runs: [run('run', 'running')] })), 'provisioning');
  assert.equal(stageActivity(beta, snapshot({ runs: [run('run', 'running'), run('discover', 'running')] })), 'testing');
});

test('other stages and other stage records never borrow sandbox activity', () => {
  const busy = snapshot({ environments: [environment('creating')], runs: [run('run', 'running')] });
  for (const kind of ['source', 'build', 'production']) assert.equal(stageActivity({ id: 'beta', kind }, busy), null, kind);
  assert.equal(stageActivity({ id: 'gamma', kind: 'sandbox' }, busy), null);
});

test('only in-flight environment operations count as working', () => {
  assert.deepEqual(['queued', 'creating', 'preparing', 'destroying', 'ready', 'failed', 'destroyed', 'cleanup_failed', undefined].map(environmentWorking), [true, true, true, true, false, false, false, false, false]);
});
