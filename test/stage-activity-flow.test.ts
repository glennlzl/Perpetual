import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionFlow, environmentBehind, readyArrivals, repairHead, shallowEqual, sourceEnvironments } from '../client/src/lib/pipeline-flow.ts';
import type { BrowserRun } from '../client/src/lib/browser-test-ui.ts';
import type { ActivitySnapshot } from '../client/src/lib/stage-activity.ts';
import type { Environment } from '../client/src/lib/test-workspace.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
const OLD = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const stages = [{ id: 'source', kind: 'source' }, { id: 'build', kind: 'build' }, { id: 'beta', kind: 'sandbox' }, { id: 'gamma', kind: 'sandbox' }, { id: 'production', kind: 'production' }];
const edge = (source: string, target: string, blocked = false) => ({ id: `${source}-${target}`, source, target, blocked });
const environment = (status: string, extra: Partial<Environment> = {}): Environment => ({ id: `beta-${status}`, stageId: 'beta', status, sourceRevision: SHA, updatedAt: '2026-09-23T10:00:00.000Z', ...extra });
const context = ({ environments = [], runs = [], build = null, latest = {} }: { environments?: Environment[]; runs?: Pick<BrowserRun, 'mode' | 'status'>[]; build?: { status: string; sha?: string } | null; latest?: Record<string, Environment> } = {}) => {
  const snapshot: ActivitySnapshot & { browserTests: NonNullable<ActivitySnapshot['browserTests']> } = { environments, browserTests: { beta: { runs } }, stageRemovals: [] };
  return { stages, sha: SHA, build, latest, snapshot };
};

test('Source to Build flows only while a current-commit run is queued or in progress', () => {
  for (const status of ['running', 'queued']) assert.equal(transitionFlow(edge('source', 'build'), context({ build: { status, sha: SHA.slice(0, 7) } })), 'active', status);
  for (const status of ['passed', 'failed', 'cancelled', 'waiting', 'skipped']) assert.equal(transitionFlow(edge('source', 'build'), context({ build: { status } })), null, status);
  assert.equal(transitionFlow(edge('source', 'build'), context()), null);
});

test('Build to a sandbox flows while it provisions or a browser run is active on it', () => {
  for (const status of ['queued', 'creating', 'preparing']) assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [environment(status)] })), 'active', status);
  for (const status of ['queued', 'running'] as const) assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [environment('ready')], runs: [{ mode: 'run', status }] })), 'active', status);
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [environment('ready')], runs: [{ mode: 'discover', status: 'running' }] })), 'active');
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [environment('ready')], runs: [{ mode: 'run', status: 'passed' }] })), null);
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [environment('destroying')] })), null);
  assert.equal(transitionFlow(edge('beta', 'gamma'), context({ environments: [environment('creating')] })), null, 'Another stage must not borrow Beta activity.');
});

test('a sandbox fed by another sandbox never flows, because it is built from the scanned commit', () => {
  const gamma = (status: string, extra: Partial<Environment> = {}) => environment(status, { id: `gamma-${status}`, stageId: 'gamma', ...extra });
  for (const status of ['queued', 'creating', 'preparing']) assert.equal(transitionFlow(edge('beta', 'gamma'), context({ environments: [environment('ready'), gamma(status)] })), null, status);
  const running = context({ environments: [environment('ready'), gamma('ready')] });
  running.snapshot.browserTests.gamma = { runs: [{ mode: 'run', status: 'running' }] };
  assert.equal(transitionFlow(edge('beta', 'gamma'), running), null, 'A Gamma browser run shows on its card, not as Beta-to-Gamma motion.');
  const behind = gamma('ready', { sourceRevision: OLD });
  assert.equal(transitionFlow(edge('beta', 'gamma'), context({ environments: [behind], latest: { gamma: behind } })), 'behind', 'Drift is still marked statically on its inbound edge.');
});

test('blocked edges and edges into Production never flow', () => {
  assert.equal(transitionFlow(edge('build', 'beta', true), context({ environments: [environment('creating')] })), null);
  assert.equal(transitionFlow(edge('source', 'build', true), context({ build: { status: 'running' } })), null);
  assert.equal(transitionFlow(edge('beta', 'production'), context({ environments: [environment('creating')], build: { status: 'running' } })), null);
});

test('a ready sandbox on an older revision draws a static behind edge', () => {
  const behind = environment('ready', { sourceRevision: OLD });
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [behind], latest: { beta: behind } })), 'behind');
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [behind], latest: { beta: behind }, runs: [{ mode: 'run', status: 'running' }] })), 'active', 'Actual activity takes precedence over drift.');
  assert.equal(transitionFlow(edge('build', 'beta', true), context({ latest: { beta: behind } })), null);
});

test('drift requires a ready environment and both known revisions', () => {
  assert.equal(environmentBehind(environment('ready', { sourceRevision: OLD }), SHA), true);
  assert.equal(environmentBehind(environment('ready'), SHA), false);
  assert.equal(environmentBehind(environment('destroyed', { sourceRevision: OLD }), SHA), false);
  assert.equal(environmentBehind(environment('creating', { sourceRevision: OLD }), SHA), false);
  assert.equal(environmentBehind(environment('ready', { sourceRevision: null }), SHA), false);
  assert.equal(environmentBehind(environment('ready', { sourceRevision: OLD }), null), false);
  assert.equal(environmentBehind(null, SHA), false);
});

// GET /api/state lists every environment of the pipeline; a repair's journey gate builds its twin from the pull request
// checkout Perpetual owns (repoPath), on the repair branch at the pull request head, and names the repair.
test('a twin a repair\'s journey gate built is the stage\'s twin, at its pull request head rather than behind', () => {
  const PR = 'f'.repeat(40), repaired = environment('ready', { id: 'pr', repoPath: '/data/repairs/r1/gate-fffffff', sourceBranch: 'perpetual/repair/0a1b2c3', sourceRevision: PR, repair: 'r1' });
  const other = environment('ready', { id: 'other', repoPath: '/data/sources/github-old/app', sourceRevision: OLD }), own = environment('destroyed', { id: 'own', repoPath: '/work/app' });
  assert.deepEqual(sourceEnvironments([repaired, other, own, environment('ready', { id: 'unscoped' })], '/work/app').map(item => item.id), ['pr', 'own', 'unscoped'], 'Another checkout\'s twin is left out.');
  assert.equal(environmentBehind(repaired, SHA), false);
  assert.equal(transitionFlow(edge('build', 'beta'), context({ environments: [repaired], latest: { beta: repaired } })), null);
  assert.equal(repairHead(repaired), 'perpetual/repair/0a1b2c3 · fffffff');
  assert.equal(repairHead({ ...repaired, status: 'destroyed' }), '');
  assert.equal(repairHead(environment('ready', { sourceRevision: OLD })), '');
});

test('arrival is reported once, only for an observed provisioning to ready transition', () => {
  const first = readyArrivals(null, [environment('ready', { id: 'already' }), environment('preparing', { id: 'fresh' })]);
  assert.deepEqual(first.arrived, [], 'An environment already ready on first observation never flashes.');
  const updatedAt = '2026-09-23T10:05:00.000Z';
  const second = readyArrivals(first.seen, [environment('ready', { id: 'already' }), environment('ready', { id: 'fresh', updatedAt })]);
  assert.deepEqual(second.arrived, [{ stageId: 'beta', key: `fresh:${updatedAt}` }]);
  assert.deepEqual(readyArrivals(second.seen, [environment('ready', { id: 'fresh', updatedAt })]).arrived, [], 'An unchanged poll does not repeat the arrival.');
  assert.deepEqual(readyArrivals(readyArrivals(null, [environment('ready', { id: 'fresh' })]).seen, [environment('failed', { id: 'fresh' })]).arrived, []);
  assert.deepEqual(readyArrivals(readyArrivals(null, [environment('creating', { id: 'fresh' })]).seen, [environment('failed', { id: 'fresh' })]).arrived, []);
});

test('shallow equality compares own keys by identity', () => {
  const fn = () => {}, list = [1];
  assert.equal(shallowEqual({ a: 1, fn, list }, { a: 1, fn, list }), true);
  assert.equal(shallowEqual({ a: 1, list }, { a: 1, list: [1] }), false);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(shallowEqual(null, {}), false);
});
