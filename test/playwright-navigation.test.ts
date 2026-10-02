import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPlaywrightRuntime } from '../src/journeys/playwright/runtime.ts';
import { specHash } from '../src/journeys/playwright/specs.ts';
import type { ApprovedCase } from '../src/journeys/playwright/checks.ts';
import type { WorkerEvent } from '../src/browser/runtime.ts';
import type { JourneyFacts } from '../src/journeys/playwright/reporter.ts';

// Catch an immediate reload racing the browser-side commit of the document a click opened.
// The hook only supplies renderer pressure; the milestone actions run through the real fixture unchanged.
test('real Chromium reload waits for the clicked document to become active, with no reload retry', { timeout: 90000 }, async t => {
  let notes = 0, reads = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.method === 'POST') { notes++; response.writeHead(303, { location: '/notes' }); response.end(); return; }
      reads++;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<p>Notes ${notes}</p><form method="post" action="/notes"><button>Add note</button></form>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const item: ApprovedCase = { id: 'notes', name: 'Save note', goal: 'Keep a note after reload', steps: [
    { id: 'before', title: 'Read notes', checks: [{ type: 'read-number', label: 'Notes', name: 'before' }] },
    { id: 'save', title: 'Save and reopen', checks: [{ type: 'compare-number', label: 'Notes', name: 'after', op: '>', than: 'before' }] },
  ] };
  const code = `import { test } from 'perpetual';
    test.beforeEach(async ({ page, context }) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 100 });
    });
    test('Save note', async ({ page, journey }) => {
      await journey.milestone('before', async () => {});
      await journey.milestone('save', async () => {
        await page.getByRole('button', { name: 'Add note' }).click();
        await page.reload();
      });
    });`;
  const run = async (blockWrites = false) => {
    const events: WorkerEvent[] = [];
    await createPlaywrightRuntime({ checkTimeoutMs: 1000 }).start({ mode: 'run', targetUrl: origin + '/notes', allowedOrigins: [origin], timeoutSeconds: 20, case: item, spec: { code, hash: specHash(code) }, blockWrites }, event => { if (event.type !== 'frame') events.push(event); }).promise;
    return { events, facts: events.find(event => event.type === 'result')?.result as JourneyFacts };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = reads, result = await run();
    assert.equal(result.facts.stopCause, 'none', JSON.stringify(result.facts));
    assert.equal(notes, attempt + 1);
    assert.equal(reads - before, 3, 'Exactly the entry, redirect and one reload reach the application.');
  }
  const before = reads, control = await run(true);
  assert.equal(control.facts.stopCause, 'none', JSON.stringify(control.facts));
  assert.equal(control.facts.controlRead, true, 'The unchanged reviewed outcome still catches the blocked write after its fresh reload.');
  assert.equal(notes, 3);
  assert.equal(reads - before, 2, 'A control reaches only entry and one reload.');
});

test('reload synchronization does not wait for the preceding document’s stalled assets', { timeout: 30000 }, async t => {
  let writes = 0, reads = 0, assets = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.url === '/held.png') { assets++; return; }
      if (request.method === 'POST') { writes++; response.writeHead(303, { location: '/notes' }); response.end(); return; }
      reads++; response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<p>Notes ${writes}</p><form method="post"><button>Add note</button></form>${writes ? '<img src="/held.png">' : ''}`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const item: ApprovedCase = { id: 'notes', name: 'Save note', goal: 'Keep a note after reload', steps: [
    { id: 'before', title: 'Read notes', checks: [{ type: 'read-number', label: 'Notes', name: 'before' }] },
    { id: 'save', title: 'Save and reopen', checks: [{ type: 'compare-number', label: 'Notes', name: 'after', op: '>', than: 'before' }] },
  ] };
  const code = `import { test } from 'perpetual'; test('Save note', async ({ page, journey }) => {
    await journey.milestone('before', async () => {});
    await journey.milestone('save', async () => {
      await page.getByRole('button', { name: 'Add note' }).click();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 2000 });
    });
  });`;
  const events: WorkerEvent[] = [];
  await createPlaywrightRuntime({ checkTimeoutMs: 1000 }).start({ mode: 'run', targetUrl: origin + '/notes', allowedOrigins: [origin], timeoutSeconds: 10, case: item, spec: { code, hash: specHash(code) } }, event => { if (event.type !== 'frame') events.push(event); }).promise;
  const facts = events.find(event => event.type === 'result')?.result as JourneyFacts;
  assert.equal(facts.stopCause, 'none', JSON.stringify(facts));
  assert.equal(writes, 1); assert.equal(reads, 3); assert.ok(assets >= 1);
  const actions = events.filter(event => event.type === 'case').at(-1)?.actions;
  assert.ok(Array.isArray(actions));
  assert.deepEqual(actions.map(action => ({ type: action.type, status: action.status })), [
    { type: 'click', status: 'passed' }, { type: 'wait', status: 'passed' }, { type: 'reload_page', status: 'passed' },
  ], 'The real readiness wait and the one reload are reported in their execution order.');
});
