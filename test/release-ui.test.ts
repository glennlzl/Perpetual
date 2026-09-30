import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleasePoller, releaseBadge, releaseRequest } from '../client/src/lib/production-release.ts';
import type { ReleaseRecord, ReleaseReply, ReleaseView } from '../contract/releases.ts';
import type { PageVisibility, Timers } from '../client/src/lib/utils.ts';

const SHA = 'c'.repeat(40);
const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
const view = (extra: Partial<ReleaseView> = {}): ReleaseView => ({ sha: SHA, target, canDeploy: true, blockedReason: null, current: null, recent: [], ...extra });
const record = (status: ReleaseRecord['status']): ReleaseRecord => ({ id: 'release-1', sha: SHA, ...target, status, createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z' });

test('only recorded deployment work spins; an unknown result remains unresolved instead of looking deployed', () => {
  for (const status of ['requesting', 'queued', 'deploying'] as const) assert.equal(releaseBadge(record(status))?.active, true, status);
  for (const status of ['unknown', 'deployed', 'failed', 'inactive'] as const) assert.equal(releaseBadge(record(status))?.active, false, status);
  assert.equal(releaseBadge(record('unknown'))?.tone, 'blocked');
  assert.equal(releaseBadge(record('deployed'))?.tone, 'passed');
  assert.equal(releaseBadge(record('failed'))?.tone, 'failed');
  assert.equal(releaseBadge({ ...record('failed'), error: 'The deployment workflow failed.' })?.hint, 'The deployment workflow failed.');
  assert.equal(releaseBadge(record('deployed'))?.sha, 'ccccccc');
  assert.equal(releaseBadge(null), null);
});

test('a deployment confirmation remains bound to the reviewed commit and target across polling', () => {
  const confirmed = { sha: SHA, target };
  assert.deepEqual(releaseRequest(view(), confirmed), { sha: SHA, target });
  assert.equal(releaseRequest(view({ sha: 'd'.repeat(40) }), confirmed), null, 'A newer eligible commit needs a new confirmation.');
  assert.equal(releaseRequest(view({ target: { ...target, environment: 'staging' } }), confirmed), null);
  assert.equal(releaseRequest(view({ target: { ...target, workflowPath: '.github/workflows/other.yml' } }), confirmed), null);
  assert.equal(releaseRequest(view({ target: { ...target, productionEnvironment: false } }), confirmed), null);
  assert.equal(releaseRequest(view({ canDeploy: false }), confirmed), null, 'New blocking evidence disables the pending confirmation.');
  assert.equal(releaseRequest(null, confirmed), null, 'An unreadable controller cannot authorize a deployment.');
});

test('the submitted target is an independent snapshot so the server can reject a target changed elsewhere', () => {
  const confirmed = { sha: SHA, target: { ...target } };
  const request = releaseRequest(view(), confirmed);
  assert.ok(request);
  assert.deepEqual(request.target, target);
  confirmed.target.environment = 'another';
  assert.equal(request.target.environment, 'production');
});

test('release polling clears stale readiness on a failed read or another source and pauses while hidden', async () => {
  const callbacks: (() => void)[] = [];
  const timers: Timers = { setTimeout(fn) { callbacks.push(fn); return fn; }, clearTimeout() {} };
  const document: PageVisibility & { hidden: boolean } = { hidden: false };
  const values: (ReleaseReply | null)[] = [];
  let reads = 0;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document, onChange: value => values.push(value), controller: async path => {
    assert.equal(path, '/api/releases?repoPath=%2Fsources%2Fapp');
    reads++;
    if (reads === 1) return { repoPath: '/sources/app', ...view() };
    if (reads === 2) return { repoPath: '/sources/another', ...view() };
    throw new Error('Controller unavailable.');
  } });
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  assert.equal(values[0]?.canDeploy, true);
  poller.refresh(); await tick();
  assert.equal(values[1], null);
  poller.refresh(); await tick();
  assert.equal(values[2], null);
  document.hidden = true;
  callbacks.at(-1)?.(); await tick();
  assert.equal(reads, 3);
  poller.stop();
});

test('a stopped release poller ignores an in-flight response from the old source', async () => {
  const values: (ReleaseReply | null)[] = [];
  let resolve!: (reply: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const poller = createReleasePoller({ repoPath: '/sources/app', document: null, onChange: value => values.push(value), controller: async () => pending });
  poller.stop();
  resolve({ repoPath: '/sources/app', ...view() });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(values, []);
});

test('a pending first release read is not an error, and failed reads recover without retaining their error', async t => {
  const errors: (string | null)[] = [];
  let resolve!: (reply: unknown) => void, reject!: (error: Error) => void;
  let reply = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  const poller = createReleasePoller({ repoPath: '/sources/app', document: null, onChange() {}, onError: error => errors.push(error), controller: async () => reply });
  t.after(() => poller.stop());
  assert.deepEqual(errors, [], 'A request still loading has no failure to announce.');
  reject(new Error('Controller unavailable.'));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(errors, ['Controller unavailable.']);
  reply = new Promise<unknown>(done => { resolve = done; });
  poller.refresh();
  resolve({ repoPath: '/sources/app', ...view() });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(errors, ['Controller unavailable.', null]);
  poller.stop();
});
