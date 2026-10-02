import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createPlaywrightRuntime } from '../src/journeys/playwright/runtime.ts';
import { specHash } from '../src/journeys/playwright/specs.ts';
import type { ApprovedCase } from '../src/journeys/playwright/checks.ts';
import type { WorkerEvent } from '../src/browser/runtime.ts';
import type { JourneyFacts } from '../src/journeys/playwright/reporter.ts';

type Evidence = { events: { source: string; name: string; at: number; error?: string; status?: string; reason?: string; code?: number; failed?: boolean; method?: string; redirectStatus?: number }[] };
async function evidenceFiles(directory: string) {
  // Persistence is deliberately outside job settlement. Only atomic, completed JSON files count.
  for (const end = Date.now() + 3000; Date.now() < end;) {
    const files = (await readdir(directory).catch(() => [] as string[])).filter(file => file.endsWith('.json'));
    if (files.length) return files;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return [];
}

// An induced closed-page failure checks the recorder end to end; it is not a reproduction of issue #31.
test('real Chromium failure keeps lifecycle evidence while success and a caught control keep none', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-lifecycle-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let notes = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') { notes++; response.writeHead(303, { location: '/notes?token=private-query' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<title>Private page title</title><form method=post><button>Add note</button></form><p>Notes ${notes}</p><p>private-page-text</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const targetUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/notes?token=private-query`;
  const item: ApprovedCase = { id: 'notes', name: 'Save note', goal: 'Keep a note after reload', steps: [
    { id: 'before', title: 'Read notes', checks: [{ type: 'read-number', label: 'Notes', name: 'before' }] },
    { id: 'save', title: 'Save and reopen', checks: [{ type: 'compare-number', label: 'Notes', name: 'after', op: '>', than: 'before' }] },
  ] };
  const code = (close = false) => `import { test } from 'perpetual';
    test('Save note', async ({ page, journey }) => {
      await journey.milestone('before', async () => {});
      await journey.milestone('save', async () => {
        await page.getByRole('button', { name: 'Add note' }).click();
        await page.waitForLoadState('load');
        ${close ? 'await page.close();' : ''}
        await page.reload();
      });
    });`;
  const run = async (diagnosticsDir: string, { close = false, blockWrites = false } = {}) => {
    const events: WorkerEvent[] = [], spec = code(close);
    await createPlaywrightRuntime({ diagnosticsDir, checkTimeoutMs: 500 }).start({ mode: 'run', targetUrl, allowedOrigins: [new URL(targetUrl).origin], timeoutSeconds: 20, case: item, spec: { code: spec, hash: specHash(spec) }, blockWrites }, event => { if (event.type !== 'frame') events.push(event); }).promise;
    assert.ok(!events.some(event => event.type === 'lifecycle'), 'Private diagnostics never enter product events.');
    return events.find(event => event.type === 'result')?.result as JourneyFacts;
  };
  const directory = join(root, 'evidence');
  assert.equal((await run(directory)).stopCause, 'none');
  const control = await run(directory, { blockWrites: true });
  assert.equal(control.controlRead, true, 'The failed control is caught by the independent persistence check.');
  assert.deepEqual(await readdir(directory).catch(() => []), []);
  const failed = await run(directory, { close: true });
  assert.equal(failed.stopCause, 'action');
  const files = await evidenceFiles(directory);
  assert.equal(files.length, 1, 'Only the induced ordinary failure retains one lifecycle file.');
  const text = await readFile(join(directory, files[0]), 'utf8'), evidence: Evidence = JSON.parse(text);
  for (const name of ['page-open', 'frame-navigated', 'reload-begin', 'reload-end', 'page-close', 'context-close', 'browser-disconnected', 'worker-exit', 'worker-close', 'worker-done']) assert.ok(evidence.events.some(event => event.name === name), name);
  const reload = evidence.events.find(event => event.name === 'reload-end');
  assert.equal(reload?.error, 'closed');
  assert.ok(!evidence.events.some(event => event.error === 'inactive-page'), 'A canary is not the historical inactive-page failure.');
  assert.ok(!evidence.events.some(event => event.name === 'worker-stop'), 'This failure was not supervisor cancellation.');
  assert.ok(evidence.events.some(event => event.name === 'worker-close' && event.code === 0), 'Business failure and worker exit status are distinct.');
  assert.ok(evidence.events.some(event => event.name === 'document-request' && event.method === 'POST'));
  assert.ok(evidence.events.some(event => event.name === 'document-request' && event.method === 'GET' && event.redirectStatus === 303), 'Keep the real POST/303 transition without its address or payload.');
  for (const secret of ['private-query', 'private-page-text', 'Private page title', '127.0.0.1', 'Add note']) assert.ok(!text.includes(secret), secret);
  // A failed diagnostic write cannot turn an ordinary journey failure into a worker/cleanup failure.
  const unavailable = join(root, 'unavailable'); await writeFile(unavailable, 'keep');
  assert.equal((await run(unavailable, { close: true })).stopCause, 'action');
  assert.equal(await readFile(unavailable, 'utf8'), 'keep');

  const held = join(await realpath(root), 'held'), write = fs.writeFile;
  let entered!: () => void, release!: () => void, settled = false;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const mock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(held + '/')) { entered(); await released; }
    return write(...args);
  });
  syncBuiltinESMExports();
  const pending = run(held, { close: true }).then(result => { settled = true; return result; });
  try {
    await writing;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'A held diagnostic write must not hold job completion or the manager’s browser lease.');
  } finally { release(); mock.mock.restore(); syncBuiltinESMExports(); await pending; await evidenceFiles(held); }
});

test('real Chromium cancellation records supervisor cause and cleanup before retaining evidence', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-lifecycle-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Notes</h1>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const targetUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const item: ApprovedCase = { id: 'notes', name: 'Read notes', goal: 'Read saved notes', steps: [{ id: 'read', title: 'Read notes', checks: [{ type: 'text-visible', value: 'Notes' }] }] };
  const code = `import { test } from 'perpetual'; test('Read notes', async ({ page, journey }) => { await journey.milestone('read', async () => { await page.waitForTimeout(30000); }); });`;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  // Exercise the environment opt-in used by native CI, without forwarding its path to the child.
  const runtime = createPlaywrightRuntime({ env: { ...process.env, PERPETUAL_PLAYWRIGHT_DIAGNOSTICS_DIR: root } });
  const job = runtime.start({ mode: 'run', targetUrl, allowedOrigins: [targetUrl], timeoutSeconds: 35, case: item, spec: { code, hash: specHash(code) } }, event => { if (event.type === 'journey-step' && event.status === 'running') started(); });
  const finished = job.promise.then(() => null, error => error as Error);
  await ready; job.cancel();
  const error = await finished;
  assert.match(error?.message ?? '', /cancelled/);
  const files = await evidenceFiles(root); assert.equal(files.length, 1);
  const evidence: Evidence = JSON.parse(await readFile(join(root, files[0]), 'utf8'));
  assert.ok(evidence.events.some(event => event.name === 'runtime-cancel'));
  assert.ok(evidence.events.some(event => event.source === 'supervisor' && event.name === 'worker-stop' && event.reason === 'cancel'));
  assert.ok(evidence.events.some(event => event.name === 'worker-done' && event.failed === true));
  const names = evidence.events.map(event => event.name);
  assert.ok(names.indexOf('worker-close') < names.lastIndexOf('runtime-end'), 'Evidence is saved after the owned worker has closed.');
});
