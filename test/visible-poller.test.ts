import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisiblePoller, type PollResult } from '../client/src/lib/visible-poller.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
type Timer = { callback: () => void; delay: number };
function harness() {
  const queue = new Set<Timer>();
  const timers = {
    setTimeout(callback: () => void, delay: number) { const timer = { callback, delay }; queue.add(timer); return timer; },
    clearTimeout(timer: unknown) { queue.delete(timer as Timer); },
  };
  const document = Object.assign(new EventTarget(), { hidden: false });
  return { timers, queue, document,
    visible(value: boolean) { document.hidden = !value; document.dispatchEvent(new Event('visibilitychange')); },
    async fire() { const next = queue.values().next().value; assert.ok(next); queue.delete(next); next.callback(); await flush(); },
  };
}

test('an unreadable controller reports its failure and keeps polling until it recovers', async t => {
  const h = harness(), results: PollResult<number>[] = [], failure = new Error('Disconnected');
  let reads = 0;
  const poller = createVisiblePoller({ ...h, read: async () => { if (++reads === 1) throw failure; return 7; },
    onResult: result => results.push(result), interval: () => 2500,
  });
  t.after(() => poller.stop());
  await flush();
  assert.deepEqual(results, [{ ok: false, error: failure }]);
  assert.equal(h.queue.values().next().value?.delay, 2500);
  await h.fire();
  assert.deepEqual(results.at(-1), { ok: true, value: 7 });
  assert.equal(h.queue.size, 1);
});

test('a queued refresh waits while hidden and resumes as one read when visible', async t => {
  const h = harness(), pending: ((value: number) => void)[] = [], results: PollResult<number>[] = [];
  h.visible(false);
  const poller = createVisiblePoller({ ...h, read: () => new Promise<number>(resolve => pending.push(resolve)),
    onResult: result => results.push(result), interval: () => 3000,
  });
  t.after(() => poller.stop());
  poller.refresh();
  assert.equal(pending.length, 0);
  h.visible(true);
  assert.equal(pending.length, 1);
  poller.refresh();
  h.visible(false);
  pending[0](1);
  await flush();
  assert.deepEqual(results, [{ ok: true, value: 1 }], 'A completed read still records its evidence.');
  assert.equal(pending.length, 1, 'The queued refresh does not read on a hidden page.');
  assert.equal(h.queue.size, 0);
  h.visible(true);
  assert.equal(pending.length, 2);
  pending[1](2);
  await flush();
  assert.equal(h.queue.size, 1);
  assert.equal(pending.length, 2, 'Visibility does not leave an extra deferred refresh.');
});

test('stopping discards the unfinished read, its queued refresh and all later visibility changes', async () => {
  const h = harness(), results: PollResult<number>[] = [];
  let resolve!: (value: number) => void, reads = 0;
  const poller = createVisiblePoller({ ...h, read: () => { reads++; return new Promise<number>(done => { resolve = done; }); },
    onResult: result => results.push(result), interval: () => 3000,
  });
  poller.refresh();
  poller.stop();
  resolve(1);
  await flush();
  h.visible(false); h.visible(true); poller.refresh();
  assert.deepEqual(results, []);
  assert.equal(reads, 1);
  assert.equal(h.queue.size, 0);
});

test('a refresh raised by a published result is coalesced before the next timer', async t => {
  const h = harness(), results: number[] = [];
  let reads = 0;
  const poller = createVisiblePoller({ ...h, read: async () => ++reads, interval: () => 3000,
    onResult(result) {
      assert.equal(result.ok, true);
      if (!result.ok) return;
      results.push(result.value);
      if (result.value === 1) { poller.refresh(); poller.refresh(); }
    },
  });
  t.after(() => poller.stop());
  await flush();
  assert.deepEqual(results, [1, 2]);
  assert.equal(h.queue.size, 1);
});

test('a read refused while a source change saves publishes nothing, and the next read follows at the interval', async t => {
  const h = harness(), results: PollResult<number>[] = [];
  const busy = Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409, sourceBusy: true });
  let reads = 0;
  const poller = createVisiblePoller({ ...h, read: async () => { if (++reads === 2) throw busy; return reads; },
    onResult: result => results.push(result), interval: () => 2500,
  });
  t.after(() => poller.stop());
  await flush();
  await h.fire();
  assert.deepEqual(results, [{ ok: true, value: 1 }], 'The caller keeps its last result.');
  assert.equal(h.queue.values().next().value?.delay, 2500);
  await h.fire();
  assert.deepEqual(results, [{ ok: true, value: 1 }, { ok: true, value: 3 }]);
});
