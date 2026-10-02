import test from 'node:test';
import assert from 'node:assert/strict';
import type { CDPSession, Page } from '@playwright/test';
import { synchronizeReload } from '../src/journeys/playwright/navigation.ts';

// The protocol boundary can hold a renderer read independently of the clock. No browser is needed to prove
// that this wait cannot reset the navigation budget or issue a reload after readiness fails.
function boundary(read: () => Promise<void>, closed = false) {
  const navigations: (Parameters<Page['reload']>[0])[] = [];
  const page = { isClosed: () => closed, reload: async (options: Parameters<Page['reload']>[0]) => { navigations.push(options); return null; } };
  const cdp = { send: async (method: string) => { assert.equal(method, 'Page.getFrameTree'); await read(); return { frameTree: { frame: { id: 'fixture' } } }; } };
  synchronizeReload(page as unknown as Page, cdp as unknown as CDPSession, action => action());
  return { page, navigations };
}

test('a reload spends one explicit timeout across readiness and navigation', async () => {
  const f = boundary(() => new Promise(resolve => setTimeout(resolve, 40)));
  await f.page.reload({ timeout: 200, waitUntil: 'domcontentloaded' });
  assert.equal(f.navigations.length, 1);
  assert.equal(f.navigations[0]?.waitUntil, 'domcontentloaded');
  assert.ok(f.navigations[0]?.timeout && f.navigations[0].timeout < 180 && f.navigations[0].timeout > 0);
});

test('an expired readiness budget never sends reload, even if the renderer later answers', async () => {
  let release!: () => void;
  const f = boundary(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(f.page.reload({ timeout: 20 }), { name: 'TimeoutError' });
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.navigations, []);
});

test('a closed or cancelled readiness session is not retried and never sends reload', async () => {
  let fail!: (error: Error) => void;
  const f = boundary(() => new Promise((_resolve, reject) => { fail = reject; }));
  const pending = f.page.reload({ timeout: 1000 });
  fail(new Error('Target page, context or browser has been closed'));
  await assert.rejects(pending, /has been closed/);
  assert.deepEqual(f.navigations, []);
});

test('reload keeps an explicit disabled timeout and delegates an already closed page unchanged', async () => {
  const open = boundary(async () => {});
  await open.page.reload({ timeout: 0, waitUntil: 'commit' });
  assert.deepEqual(open.navigations, [{ timeout: 0, waitUntil: 'commit' }]);
  const closed = boundary(async () => { throw new Error('An already closed page must not start a protocol read.'); }, true);
  await closed.page.reload({ timeout: 123 });
  assert.deepEqual(closed.navigations, [{ timeout: 123 }]);
});
