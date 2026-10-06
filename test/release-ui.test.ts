import test from 'node:test';
import assert from 'node:assert/strict';
import { abandonRequest, createReleasePoller, gatesReleasable, releaseAbandonable, releaseBadge, releaseForSource, releaseRequest, shownRelease } from '../client/src/lib/production-release.ts';
import type { GateView, StageGate } from '../contract/gate.ts';
import type { ReleaseRecord, ReleaseReply, ReleaseView } from '../contract/releases.ts';
import type { PageVisibility, Timers } from '../client/src/lib/utils.ts';

const SHA = 'c'.repeat(40);
const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
const view = (extra: Partial<ReleaseView> = {}): ReleaseView => ({ sha: SHA, target, canDeploy: true, blockedReason: null, current: null, unresolved: null, recent: [], ...extra });
const record = (status: ReleaseRecord['status']): ReleaseRecord => ({ id: 'release-1', sha: SHA, ...target, status, createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z' });

test('a new commit in the same checkout immediately hides the previous commit deployment and eligibility', () => {
  const previous = { repoPath: '/sources/app', ...view({ current: record('deployed') }) };
  assert.equal(releaseForSource(previous, '/sources/app', SHA), previous);
  assert.equal(releaseForSource(previous, '/sources/app', 'd'.repeat(40)), null, 'A retained checkout path does not make old deployment evidence current.');
  assert.equal(releaseForSource(previous, '/sources/another', SHA), null);
  assert.equal(releaseForSource(previous, '/sources/app', null), null, 'Without a scanned commit no non-null commit is shown.');
  const unconnected = { repoPath: '/sources/app', ...view({ sha: null, target: null, canDeploy: false, blockedReason: 'Connect a GitHub source before deploying.' }) };
  assert.equal(releaseForSource(unconnected, '/sources/app', SHA), unconnected, 'A legitimate unconnected response retains its actionable reason.');
  assert.equal(releaseForSource(null, '/sources/app', SHA), null);
});

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

test('an abandoned release reads Abandoned with who abandoned it, and Abandon stays bound to the confirmed release', () => {
  assert.deepEqual(releaseBadge({ ...record('abandoned'), abandonedBy: 'owner' }), { label: 'Abandoned', tone: 'idle', active: false, hint: 'Abandoned by owner', sha: 'ccccccc' });
  for (const status of ['unknown', 'queued', 'deploying'] as const) assert.equal(releaseAbandonable(record(status)), true, status);
  for (const status of ['requesting', 'deployed', 'failed', 'inactive', 'abandoned'] as const) assert.equal(releaseAbandonable(record(status)), false, status);
  assert.equal(releaseAbandonable(null), false);
  const confirmed = { id: 'release-1', sha: SHA, environment: 'production' };
  assert.deepEqual(abandonRequest(view({ current: record('queued') }), confirmed), { id: 'release-1' });
  assert.deepEqual(abandonRequest(view({ current: record('failed'), unresolved: { ...record('deploying'), id: 'release-0' } }), { ...confirmed, id: 'release-0' }), { id: 'release-0' }, 'An earlier commit\'s unresolved release.');
  assert.equal(abandonRequest(view({ current: record('deployed') }), confirmed), null, 'It ended meanwhile.');
  assert.equal(abandonRequest(view({ current: { ...record('queued'), id: 'release-2' } }), confirmed), null, 'Another release is never abandoned in its place.');
  assert.equal(abandonRequest(null, confirmed), null);
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

test('a release is read every 3 seconds only while it is pending, and otherwise once a minute', async t => {
  const delays: number[] = [];
  const timers: Timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} };
  let status: ReleaseRecord['status'] | null = null;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document: null, onChange() {}, controller: async () => ({ repoPath: '/sources/app', ...view({ current: status ? record(status) : null }) }) });
  t.after(() => poller.stop());
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  assert.equal(delays.at(-1), 60000, 'With nothing requested, each read checking the GitHub session waits a minute.');
  for (const pending of ['requesting', 'queued', 'deploying', 'unknown'] as const) { status = pending; poller.refresh(); await tick(); assert.equal(delays.at(-1), 3000, pending); }
  for (const settled of ['deployed', 'failed', 'inactive'] as const) { status = settled; poller.refresh(); await tick(); assert.equal(delays.at(-1), 60000, settled); }
});

test('an earlier commit\'s unresolved release is shown before this commit\'s and read every 3 seconds until it ends', async t => {
  const earlier: ReleaseRecord = { ...record('deploying'), id: 'release-0', sha: 'd'.repeat(40), logUrl: 'https://ci.example.test/runs/7' };
  assert.equal(shownRelease(view({ current: record('failed'), unresolved: earlier })), earlier, 'The release that blocks Deploy is the one shown.');
  assert.equal(releaseBadge(shownRelease(view({ unresolved: earlier })))?.sha, 'ddddddd');
  assert.equal(shownRelease(view({ current: record('deployed') }))?.status, 'deployed');
  assert.equal(shownRelease(view()), null);
  assert.equal(shownRelease(null), null);
  const delays: number[] = [];
  const timers: Timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} };
  let unresolved: ReleaseRecord | null = earlier;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document: null, onChange() {}, controller: async () => ({ repoPath: '/sources/app', ...view({ unresolved }) }) });
  t.after(() => poller.stop());
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  assert.equal(delays.at(-1), 3000);
  unresolved = null; poller.refresh(); await tick();
  assert.equal(delays.at(-1), 60000);
});

test('a release the gates allow but Deploy cannot use yet is read every 3 seconds, until their commit statuses reach it', async t => {
  const delays: number[] = [];
  const timers: Timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} };
  const unreported = view({ canDeploy: false, blockedReason: 'Every Sandbox gate must pass or be explicitly released and reported for this commit.' });
  let reply = unreported, ready = true;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document: null, onChange() {}, gatesReady: () => ready, controller: async () => ({ repoPath: '/sources/app', ...reply }) });
  t.after(() => poller.stop());
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  assert.equal(delays.at(-1), 3000, 'The gates passed the commit; reporting their statuses changes nothing else the page reads.');
  reply = view(); poller.refresh(); await tick();
  assert.equal(delays.at(-1), 60000, 'Deployable.');
  for (const [reason, settled] of [
    ['already deployed', view({ canDeploy: false, blockedReason: 'This commit is already deployed to this target.', current: record('deployed') })],
    ['no target, which Configure deployment reads again', view({ target: null, canDeploy: false, blockedReason: 'Configure a deployment target.' })],
  ] as const) { reply = settled; poller.refresh(); await tick(); assert.equal(delays.at(-1), 60000, reason); }
  reply = unreported; ready = false; poller.refresh(); await tick();
  assert.equal(delays.at(-1), 60000, 'Gates that do not allow the commit read the release again when their verdict changes.');
});

test('a failed release read keeps the cadence of the view before it', async t => {
  const delays: number[] = [];
  const timers: Timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} };
  let fails = false;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document: null, onChange() {}, controller: async () => {
    if (fails) throw new Error('Controller unavailable.');
    return { repoPath: '/sources/app', ...view({ current: record('deploying') }) };
  } });
  t.after(() => poller.stop());
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  assert.equal(delays.at(-1), 3000);
  fails = true; poller.refresh(); await tick();
  assert.equal(delays.at(-1), 3000, 'A deployment in progress is read again soon after one failed read.');
});

test('a release read refused while a source change saves keeps the view as last read and announces no error', async t => {
  const delays: number[] = [], values: (ReleaseReply | null)[] = [], errors: (string | null)[] = [];
  const timers: Timers = { setTimeout(_fn, delay) { delays.push(delay); return delays.length; }, clearTimeout() {} };
  let busy = false;
  const poller = createReleasePoller({ repoPath: '/sources/app', timers, document: null, onChange: value => values.push(value), onError: error => errors.push(error), controller: async () => {
    if (busy) throw Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409, sourceBusy: true });
    return { repoPath: '/sources/app', ...view({ current: record('deploying') }) };
  } });
  t.after(() => poller.stop());
  const tick = () => new Promise(done => setImmediate(done));
  await tick();
  busy = true; poller.refresh(); await tick();
  assert.equal(values.length, 1, 'The Production card keeps the release it read.');
  assert.deepEqual(errors, [null], 'No failure is announced.');
  assert.equal(delays.at(-1), 3000, 'The deployment in progress is read again soon.');
  busy = false; poller.refresh(); await tick();
  assert.deepEqual([values.length, errors.length], [2, 2]);
});

test('the gates allow a release only when every stage passed or was released at the scanned commit without a report error', () => {
  const gate = (extra: Partial<StageGate> = {}): StageGate => ({ id: 'gate-1', stageId: 'beta', sha: SHA, status: 'passed', detectedAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z', ...extra });
  const gates = (stages: Record<string, StageGate>, production: GateView['production'] = { sha: SHA, status: 'ready' }): GateView => ({ stages, production });
  assert.equal(gatesReleasable(gates({ beta: gate(), gamma: gate({ stageId: 'gamma', status: 'released' }) }), SHA), true);
  assert.equal(gatesReleasable(gates({ beta: gate({ statusError: 'Connect GitHub to report commit status.' }) }), SHA), false, 'A failed report changes the gate view once it is reported.');
  assert.equal(gatesReleasable(gates({ beta: gate({ sha: 'd'.repeat(40), status: 'running' }) }), SHA), false, 'A newer commit at work in a stage.');
  assert.equal(gatesReleasable(gates({ beta: gate({ status: 'running' }) }), SHA), false, 'The commit run again.');
  assert.equal(gatesReleasable(gates({ beta: gate() }, null), SHA), false);
  assert.equal(gatesReleasable(gates({ beta: gate() }), 'd'.repeat(40)), false, 'Ready for another commit.');
  assert.equal(gatesReleasable(null, SHA), false);
});
