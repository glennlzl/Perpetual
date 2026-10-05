import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../client/src/lib/pipeline-github.ts';
import type { GitHubRun } from '../client/src/lib/pipeline-github.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), CI = '.github/workflows/ci.yml';
const run = (fields: Partial<GitHubRun> = {}): GitHubRun => ({ id: '2', workflowId: '7', name: 'CI', path: CI, event: 'push', attempt: 1,
  sha: B, branch: 'main', status: 'completed', conclusion: 'success', url: null, createdAt: null, startedAt: null, updatedAt: null,
  jobs: [
    { id: '21', name: 'Tests (1/2)', status: 'completed', conclusion: 'success', url: null, startedAt: null, completedAt: null, steps: [{ number: 1, name: 'Unit tests', status: 'completed', conclusion: 'success' }] },
    { id: '22', name: 'Tests (2/2)', status: 'completed', conclusion: 'failure', url: null, startedAt: null, completedAt: null, steps: [{ number: 1, name: 'Unit tests', status: 'completed', conclusion: 'failure' }] },
  ], ...fields });
const reply = (runs = [run()]) => ({ repoPath: '/acme/app', repository: 'acme/app', branch: 'main', sha: B, scannedSha: A, source: 'watched' as const, runs });
const configured = [{ file: CI, name: 'Old CI', jobs: [{ id: 'tests', name: 'Tests (${{ matrix.shard }}/2)', steps: [{ id: 'old', name: 'Old step' }] }] }];

test('a watched Build uses its own commit and actual workflow set, without replacing scanned source provenance', () => {
  const view = reply([run({ path: '.github/workflows/new.yml', status: 'in_progress', conclusion: null })]);
  assert.equal(display.buildForSource(view, { repoPath: '/acme/app', branch: 'main', scannedSha: A }), view);
  assert.deepEqual(display.watchedBuildStatus(view), { kind: 'working', text: 'Running', sha: 'bbbbbbb' });
  assert.deepEqual(display.watchedBuildSummary(view), { status: 'running', sha: 'bbbbbbb' });
  assert.equal(view.scannedSha, A);
});

test('a stale source, branch or scan reply cannot carry a successful Build into the new selection', () => {
  const view = reply();
  for (const source of [{ repoPath: '/other/app', branch: 'main', scannedSha: A }, { repoPath: '/acme/app', branch: 'release', scannedSha: A }, { repoPath: '/acme/app', branch: 'main', scannedSha: B }]) {
    assert.equal(display.buildForSource(view, source), null);
  }
  assert.equal(display.buildForSource(null, { repoPath: '/acme/app', branch: 'main', scannedSha: A }), null);
});

test('unknown, failed reads and absent eligible runs never borrow a prior passing status', () => {
  assert.deepEqual(display.watchedBuildStatus(null, 'Reconnect GitHub.'), { kind: 'idle', text: 'Unverified', hint: 'Reconnect GitHub.' });
  assert.equal(display.watchedBuildSummary(null), null);
  assert.equal(display.watchedBuildStatus(reply([]))?.text, 'Not run');
  for (const fields of [{ branch: 'release' }, { sha: A }, { event: 'pull_request' }]) {
    assert.equal(display.watchedBuildStatus(reply([run(fields)]))?.text, 'Not run');
  }
  assert.equal(display.watchedBuildStatus({ ...reply(), branch: null })?.text, 'Unverified');
});

test('matrix jobs and their steps retain observed identities and mixed results without guessing configured names', () => {
  const rows = display.buildWorkflowRows(reply(), configured, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'CI');
  assert.deepEqual(rows[0].runs[0].jobs?.map(job => [job.id, job.name, job.conclusion, job.steps[0].conclusion]), [
    ['21', 'Tests (1/2)', 'success', 'success'], ['22', 'Tests (2/2)', 'failure', 'failure'],
  ]);
  assert.deepEqual(rows[0].jobs, [], 'Another commit\'s job/step configuration must not describe this run.');
});

test('new and removed workflows at the watched commit do not inherit the old configuration tree', () => {
  const rows = display.buildWorkflowRows(reply([run({ path: '.github/workflows/new.yml', name: 'New CI' })]), configured, A);
  assert.deepEqual(rows.map(row => [row.file, row.name, row.jobs.length]), [['.github/workflows/new.yml', 'New CI', 0]]);
  assert.deepEqual(display.buildWorkflowRows(reply([]), configured, A), []);
  const current = { ...reply([]), sha: A, source: 'scanned' as const };
  assert.deepEqual(display.buildWorkflowRows(current, configured, A).map(row => [row.file, row.jobs[0]?.name, row.runs.length]), [[CI, 'Tests (${{ matrix.shard }}/2)', 0]], 'Same-commit configured jobs without a run remain visible and unverified.');
});

test('while Build cannot be read the discovered workflows stand without runs, and nothing stands before its first read', () => {
  assert.deepEqual(display.buildWorkflowRows(null, configured, A, true).map(row => [row.file, row.name, row.jobs[0]?.name, row.runs.length]), [[CI, 'Old CI', 'Tests (${{ matrix.shard }}/2)', 0]]);
  assert.deepEqual(display.buildWorkflowRows(null, configured, A), [], 'A Build still loading lists nothing yet.');
  assert.deepEqual(display.buildWorkflowRows(reply(), configured, A, true).map(row => [row.file, row.jobs.length, row.runs.length]), [[CI, 0, 1]], 'A newer Build that was read never takes the older scan\'s tree.');
});

test('latest eligible workflow attempt owns the actual job tree, including unavailable jobs', () => {
  const rows = display.buildWorkflowRows(reply([run({ id: '1', conclusion: 'failure' }), run({ attempt: 2, jobs: null })]), configured, A);
  assert.deepEqual(rows[0].runs.map(item => [item.id, item.attempt, item.jobs]), [['2', 2, null]]);
});

test('Build polling clears a prior success on read failure and discards a completed read after stop', async () => {
  const callbacks: (() => unknown)[] = [], reads: unknown[] = [], paths: string[] = [];
  const timers = { setTimeout(callback: () => unknown) { callbacks.push(callback); return callback; }, clearTimeout() {} };
  let fail = false, release: ((value: unknown) => void) | undefined;
  const poller = display.createGitHubBuildPoller({ repoPath: '/acme/app', branch: 'main', controller: async path => {
    paths.push(path); if (fail) throw new Error('Reconnect GitHub.'); return reply();
  }, onChange: value => reads.push(value), timers, document: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(paths, ['/api/github/build?repoPath=%2Facme%2Fapp&branch=main']);
  fail = true; await callbacks.shift()!();
  assert.deepEqual(reads.at(-1), { view: null, error: 'Reconnect GitHub.' });
  poller.stop();
  const pending = display.createGitHubBuildPoller({ repoPath: '/acme/app', branch: 'main', controller: () => new Promise(resolve => { release = resolve; }), onChange: value => reads.push(value), timers, document: null });
  pending.stop(); release!(reply()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2);
});

test('a Build read refused while a source change saves keeps the Build last read, without a read error', async t => {
  const delays: number[] = [], reads: unknown[] = [];
  let busy = false;
  const poller = display.createGitHubBuildPoller({ repoPath: '/acme/app', branch: 'main', document: null,
    controller: async () => { if (busy) throw Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409, sourceBusy: true }); return reply([run({ status: 'in_progress', conclusion: null })]); },
    onChange: value => reads.push(value), timers: { setTimeout(_callback, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} },
  });
  t.after(() => poller.stop());
  await new Promise(resolve => setImmediate(resolve));
  busy = true; poller.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1, 'Build stays as last read rather than Unverified.');
  assert.equal(delays.at(-1), 5000, 'The run in progress is read again soon.');
});

test('a refresh during an unfinished Build read rereads once before waiting for the idle interval', async t => {
  const pending: ((value: unknown) => void)[] = [], seen: display.BuildRead[] = [];
  const scheduled: (() => void)[] = [];
  const poller = display.createGitHubBuildPoller({ repoPath: '/acme/app', branch: 'main', document: null,
    controller: () => new Promise(resolve => pending.push(resolve)),
    onChange: value => { if (value) seen.push(value); },
    timers: { setTimeout(callback) { scheduled.push(callback); return callback; }, clearTimeout() {} },
  });
  t.after(() => poller.stop());
  poller.refresh();
  poller.refresh();
  assert.equal(pending.length, 1, 'Refreshes do not overlap the active read.');
  pending[0](reply());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, 'A changed Build is reread after the older request settles.');
  assert.equal(scheduled.length, 0, 'The explicit refresh must not wait for a polling timer.');
  pending[1](reply([run({ status: 'in_progress', conclusion: null })]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, 'Several pending refreshes coalesce into one read.');
  assert.equal(seen.at(-1)?.view?.runs[0].status, 'in_progress');
  assert.equal(scheduled.length, 1);
});
