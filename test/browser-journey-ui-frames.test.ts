import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameStore, frameIdentity, type FrameSource } from '../client/src/lib/frame-store.ts';

type Frame = Blob | null;
// A JPEG frame as the controller streams it; its bytes are never read here.
const jpeg = () => new Blob([], { type:'image/jpeg' });

const flush = () => new Promise(resolve => setImmediate(resolve));
const source = (caseId = 'happy', runId = 'run-1') => ({ repoPath:'/repo', stageId:'beta', runId, caseId });
function harness(t: TestContext, options: { load?: (item: FrameSource) => Frame | Promise<Frame> } = {}) {
  t.mock.timers.enable({ apis:['setTimeout', 'Date'] });
  const calls: { caseId: string; runId: string; signal: AbortSignal }[] = [], revoked: string[] = [], state = { hidden:false, reduced:false };
  let urls = 0;
  const store = createFrameStore({ load: async (item, signal) => { calls.push({ caseId:item.caseId, runId:item.runId, signal }); return options.load ? options.load(item) : jpeg(); }, createUrl: () => `blob:${++urls}`, revokeUrl: url => revoked.push(url), hidden: () => state.hidden, reducedMotion: () => state.reduced });
  return { store, calls, revoked, state };
}

test('viewports of the same journey share one fetch loop at the fastest interval', async t => {
  const { store, calls } = harness(t);
  let notified = 0;
  const first = store.subscribe(source(), () => notified++, { status:'running', interval:1000 });
  const second = store.subscribe(source(), () => {}, { status:'running', interval:350 });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(store.getSnapshot(source()).url, 'blob:1');
  assert.equal(notified, 1);
  t.mock.timers.tick(349); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  second();
  t.mock.timers.tick(350); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(650); await flush();
  assert.equal(calls.length, 3);
  first();
  assert.equal(store.size(), 0);
});
test('frames never cross journey or run identities', async t => {
  const { store, revoked } = harness(t);
  const stop = [store.subscribe(source('happy'), () => {}, { status:'running' }), store.subscribe(source('payment'), () => {}, { status:'running' }), store.subscribe(source('happy', 'run-2'), () => {}, { status:'running' })];
  await flush();
  const snapshots = [source('happy'), source('payment'), source('happy', 'run-2')].map(item => store.getSnapshot(item));
  assert.deepEqual(snapshots.map(item => item.identity), [frameIdentity(source('happy')), frameIdentity(source('payment')), frameIdentity(source('happy', 'run-2'))]);
  assert.equal(new Set(snapshots.map(item => item.url)).size, 3);
  stop.forEach(unsubscribe => unsubscribe());
  assert.equal(revoked.length, 3);
  assert.equal(store.getSnapshot(source('happy')).url, '');
});
test('polling pauses while the page is hidden and resumes when visible', async t => {
  const { store, calls, state } = harness(t);
  store.subscribe(source(), () => {}, { status:'running' });
  await flush();
  state.hidden = true;
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls.length, 1);
  state.hidden = false; store.resume(); await flush();
  assert.equal(calls.length, 2);
});
test('nothing subscribed means nothing fetched, and late responses are discarded', async t => {
  let release = (_frame: Frame) => {};
  const { store, calls, revoked } = harness(t, { load: () => new Promise<Frame>(resolve => { release = resolve; }) });
  const unsubscribe = store.subscribe(source(), () => {}, { status:'running' });
  await flush();
  unsubscribe();
  assert.equal(calls[0].signal.aborted, true);
  release(jpeg()); await flush();
  assert.equal(store.getSnapshot(source()).url, '');
  t.mock.timers.tick(10000); await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(revoked, []);
});
test('reduced motion refreshes on a new progress revision or every five seconds', async t => {
  const { store, calls, state } = harness(t);
  state.reduced = true;
  store.subscribe(source(), () => {}, { status:'running', revision:1 });
  await flush();
  t.mock.timers.tick(4999); await flush();
  assert.equal(calls.length, 1);
  store.update(source(), { status:'running', revision:2 }); await flush();
  assert.equal(calls.length, 2);
  store.update(source(), { status:'running', revision:2 }); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls.length, 3);
});
test('reduced motion refreshes at most every two seconds while revisions keep arriving', async t => {
  const { store, calls, state } = harness(t);
  state.reduced = true;
  store.subscribe(source(), () => {}, { status:'running', revision:1 });
  await flush();
  store.update(source(), { status:'running', revision:2 }); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1999); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  for (const revision of [3, 4, 5]) { store.update(source(), { status:'running', revision }); t.mock.timers.tick(500); await flush(); }
  assert.equal(calls.length, 2);
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(4999); await flush();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 4);
});
test('queued journeys wait; a terminal transition fetches one final frame', async t => {
  const { store, calls } = harness(t);
  store.subscribe(source(), () => {}, { status:'queued' });
  t.mock.timers.tick(2000); await flush();
  assert.equal(calls.length, 0);
  store.update(source(), { status:'running' }); await flush();
  assert.equal(calls.length, 1);
  store.update(source(), { status:'passed' }); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls.length, 2);
  store.update(source(), { status:'running' });
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls.length, 2);
});
test('a finished journey fetches its last frame once; a 204 keeps the previous frame', async t => {
  let frames = 0;
  const { store, calls } = harness(t, { load: () => frames++ ? null : jpeg() });
  store.subscribe(source(), () => {}, { status:'running' });
  await flush(); t.mock.timers.tick(350); await flush();
  assert.deepEqual([calls.length, store.getSnapshot(source()).url, store.getSnapshot(source()).error], [2, 'blob:1', '']);
  const stop = store.subscribe(source('done'), () => {}, { status:'failed' });
  await flush(); t.mock.timers.tick(5000); await flush();
  assert.equal(calls.filter(call => call.caseId === 'done').length, 1);
  stop();
});
test('errors are reported without dropping the last frame', async t => {
  let fail = false;
  const { store } = harness(t, { load: () => { if (fail) throw new Error('Stream unavailable'); return jpeg(); } });
  store.subscribe(source(), () => {}, { status:'running' });
  await flush();
  fail = true;
  t.mock.timers.tick(350); await flush();
  assert.deepEqual([store.getSnapshot(source()).url, store.getSnapshot(source()).error], ['blob:1', 'Stream unavailable']);
});
test('a failed last frame is fetched again after 1, 2 and 4 seconds, and once more when the page is shown again', async t => {
  let fail = true;
  const { store, calls, state } = harness(t, { load: () => { if (fail) throw new Error('Stream unavailable'); return jpeg(); } });
  store.subscribe(source('done'), () => {}, { status:'failed' });
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(999); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(2000); await flush();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(4000); await flush();
  assert.equal(calls.length, 4);
  t.mock.timers.tick(60000); await flush();
  assert.equal(calls.length, 4, 'The retries are bounded.');
  assert.equal(store.getSnapshot(source('done')).error, 'Stream unavailable');
  fail = false; state.hidden = true; store.resume(); await flush();
  assert.equal(calls.length, 4, 'A hidden page fetches nothing.');
  state.hidden = false; store.resume(); await flush();
  assert.equal(calls.length, 5);
  assert.deepEqual([store.getSnapshot(source('done')).url, store.getSnapshot(source('done')).error], ['blob:1', '']);
  t.mock.timers.tick(60000); store.resume(); await flush();
  assert.equal(calls.length, 5, 'A fetched last frame is final.');
});
// The controller refuses a frame only while it saves a source change, as it refuses every read of that source.
const busy = () => Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409, sourceBusy: true });
test('a live frame refused while a source change saves stays as last read, without an error, and is fetched at its interval', async t => {
  let refuse = false, notified = 0;
  const { store, calls } = harness(t, { load: () => { if (refuse) throw busy(); return jpeg(); } });
  store.subscribe(source(), () => notified++, { status:'running' });
  await flush();
  refuse = true;
  t.mock.timers.tick(350); await flush();
  assert.deepEqual([calls.length, store.getSnapshot(source()).url, store.getSnapshot(source()).error, notified], [2, 'blob:1', '', 1]);
  refuse = false;
  t.mock.timers.tick(350); await flush();
  assert.deepEqual([calls.length, store.getSnapshot(source()).url, store.getSnapshot(source()).error, notified], [3, 'blob:2', '', 2]);
});
test('a last frame refused while a source change saves is fetched again every second, without spending its retries', async t => {
  let refused = 0;
  const { store, calls } = harness(t, { load: () => { if (refused < 5) { refused++; throw busy(); } return jpeg(); } });
  store.subscribe(source('done'), () => {}, { status:'failed' });
  await flush();
  for (let fetched = 2; fetched <= 6; fetched++) {
    t.mock.timers.tick(999); await flush();
    assert.equal(calls.length, fetched - 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(calls.length, fetched);
  }
  assert.deepEqual([store.getSnapshot(source('done')).url, store.getSnapshot(source('done')).error], ['blob:1', '']);
  t.mock.timers.tick(60000); await flush();
  assert.equal(calls.length, 6, 'A fetched last frame is final.');
});
