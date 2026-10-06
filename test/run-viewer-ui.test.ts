import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { browserCaseFixture, browserRunFixture } from './fixtures/browser-view.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

const journey = browserCaseFixture({ id: 'save', name: 'Save a workspace', expectedOutcomes: ['The saved workspace is shown'] });

// The run viewer itself, polling a run whose replies are supplied only at the HTTP boundary.
test('the run viewer closes without cancelling, reads a refused or unanswered run again, confirms Cancel run, keeps its failure and stops reading a finished or missing run', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import BrowserAgentViewer from '/src/BrowserAgentViewer.tsx';
    import '/src/index.css';
    const root = createRoot(document.getElementById('root')), cases = ${JSON.stringify([journey])};
    function Fixture({ runId }) {
      const [open, setOpen] = React.useState(true);
      return React.createElement(React.Fragment, {}, React.createElement('button', { onClick: () => setOpen(true) }, 'Open viewer'),
        open && React.createElement(BrowserAgentViewer, { repoPath: '/acme/app', stageId: 'beta', runId, mode: 'run', cases, onClose: () => setOpen(false) }));
    }
    window.addEventListener('fixture:viewer', event => root.render(React.createElement(Fixture, { key: event.detail, runId: event.detail })));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'run-viewer-test', resolveId(id) { if (id.endsWith('/__viewer-ui.tsx')) return '\0viewer-ui.tsx'; }, load(id) { if (id === '\0viewer-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__viewer-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__viewer-ui', '<div id="root"></div><script type="module" src="/build/__viewer-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const runId = '11111111-1111-4111-8111-111111111111', missing = '22222222-2222-4222-8222-222222222222', gone = '33333333-3333-4333-8333-333333333333';
  let status: 'running' | 'passed' = 'running', stopFails = true, refused = false, unreachable = false, goneMissing = false;
  const reads: string[] = [], stops: unknown[] = [], frames: string[] = [];
  const busy = { status: 409, json: { error: 'A source change is still being saved. Please wait.', sourceBusy: true } };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/session') return route.fulfill({ json: { token: 'fixture-token' } });
    if (path === '/api/browser/stop') {
      stops.push(route.request().postDataJSON());
      return route.fulfill(stopFails ? { status: 503, json: { error: 'The run could not be stopped.' } } : { json: {} });
    }
    // A stopped controller answers nothing at all.
    if (unreachable) return route.abort('connectionrefused');
    // While a source change saves, the controller refuses the run and its frames as busy.
    if (refused && path.endsWith('/frame')) { frames.push(path); return route.fulfill(busy); }
    if (path.endsWith('/frame')) return path.includes(gone) ? route.fulfill({ contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }) : route.fulfill({ status: 204, body: '' });
    const id = decodeURIComponent(path.split('/').at(-1)!);
    reads.push(id);
    if (refused) return route.fulfill(busy);
    if (id === missing || id === gone && goneMissing) return route.fulfill({ status: 404, json: { error: 'Browser run not found in this stage.' } });
    const state = id === gone ? 'running' : status;
    const run = browserRunFixture({ id, status: state, caseIds: ['save'], caseSummaries: [journey], progress: { revision: 1, cases: [{ id: 'save', status: state }] }, ...(state === 'passed' ? { completedAt: '2026-01-01T00:05:00Z' } : {}) });
    await route.fulfill({ json: { run, results: state === 'passed' ? [{ caseId: 'save', status: 'passed', assertions: [] }] : [], progress: run.progress } });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__viewer-ui`);
  const open = (id: string) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture:viewer', { detail })), id);
  const viewer = page.getByRole('dialog');
  // Only a check that nothing more is read waits a fixed time; a read that should happen is polled for.
  const quiet = async () => { const before = reads.length; await page.waitForTimeout(1500); return reads.length - before; };
  const readAgain = async (message: string) => { const before = reads.length; await expect.poll(() => reads.length, { message }).toBeGreaterThan(before); };

  // Closing only hides the viewer; the run keeps going.
  await open(runId);
  await expect(viewer.getByText('Running', { exact: true }).first()).toBeVisible();
  await viewer.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  assert.deepEqual(stops, []);
  await page.getByRole('button', { name: 'Open viewer', exact: true }).click();
  // A read refused while a source change saves keeps the run as last read, without an error, and is read again.
  refused = true;
  await readAgain('A refused read is read again.');
  await readAgain('A refused read is read again until it succeeds.');
  assert.ok(frames.length > 0, 'Its frames are refused too.');
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await expect(viewer.getByText('Browser stream unavailable.', { exact: true })).toHaveCount(0);
  await expect(viewer.getByText('Reconnecting', { exact: true })).toHaveCount(0);
  await expect(viewer.getByText('Running', { exact: true }).first()).toBeVisible();
  // One a stopped controller never answers is read again until it succeeds, saying why meanwhile.
  refused = false; unreachable = true;
  await expect(viewer.getByRole('alert')).toHaveText('The local server is unavailable. Try reconnecting.');
  await expect(viewer.getByRole('status').filter({ hasText: 'The local server is unavailable. Try reconnecting.' })).toBeVisible();
  unreachable = false;
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await expect(viewer.getByText('The local server is unavailable. Try reconnecting.')).toHaveCount(0);
  await expect(viewer.getByText('Running', { exact: true }).first()).toBeVisible();
  // Cancel run asks first, and a failed stop stays explained while the run is still read.
  await viewer.getByRole('button', { name: 'Cancel run', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Keep running', exact: true }).click();
  assert.deepEqual(stops, []);
  await viewer.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await confirm.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect.poll(() => stops).toEqual([{ repoPath: '/acme/app', stageId: 'beta', id: runId }]);
  await expect(viewer.getByRole('alert')).toHaveText('The run could not be stopped.');
  await readAgain('The run is still read.');
  await expect(viewer.getByRole('alert')).toHaveText('The run could not be stopped.');
  // A finished run is read no more and offers no Cancel run.
  status = 'passed';
  await expect(viewer.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
  assert.equal(await quiet(), 0, 'Polling ends with the run.');
  await viewer.getByRole('button', { name: 'Close viewer', exact: true }).click();
  // A run the stage does not have says so once, and is never read again.
  await open(missing);
  await expect(viewer.getByRole('alert')).toHaveText('Browser run not found in this stage.');
  await expect(viewer.getByText('Reconnecting')).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
  assert.equal(await quiet(), 0, 'A missing run is not read again.');
  // Nor is a run that leaves the stage after showing a frame, and its last frame claims no reconnection.
  await open(gone);
  await expect(viewer.getByRole('img', { name: 'Live browser viewport', exact: true })).toBeVisible();
  goneMissing = true;
  await expect(viewer.getByRole('alert')).toHaveText('Browser run not found in this stage.');
  await expect(viewer.getByRole('img', { name: 'Live browser viewport', exact: true })).toBeVisible();
  await expect(viewer.getByText('Reconnecting')).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
  assert.equal(await quiet(), 0, 'A run that left the stage is not read again.');
  assert.deepEqual(pageErrors, []);
});

test('a discovery\'s viewer shows whether its report was forced and the tokens it spent, never the counts behind them', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import BrowserAgentViewer from '/src/BrowserAgentViewer.tsx';
    import '/src/index.css';
    const root = createRoot(document.getElementById('root'));
    window.addEventListener('fixture:viewer', event => root.render(React.createElement(BrowserAgentViewer, { key: event.detail, repoPath: '/acme/app', stageId: 'beta', runId: event.detail, mode: 'discover', onClose: () => {} })));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'discovery-viewer-test', resolveId(id) { if (id.endsWith('/__discovery-ui.tsx')) return '\0discovery-ui.tsx'; }, load(id) { if (id === '\0discovery-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__discovery-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__discovery-ui', '<div id="root"></div><script type="module" src="/build/__discovery-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const forced = '44444444-4444-4444-8444-444444444444', plain = '55555555-5555-4555-8555-555555555555';
  const diagnostics = { modelCalls: 3, modelFailures: { timeout: 0, invalid_output: 2, provider: 0, other: 0 }, stepsWithoutActions: 2, actionCount: 4, modelMs: 5200, inputTokens: 12000, outputTokens: 800, forcedFinalization: true };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { token: 'fixture-token' } });
    if (path.endsWith('/frame')) return route.fulfill({ status: 204, body: '' });
    const id = decodeURIComponent(path.split('/').at(-1)!);
    const run = browserRunFixture({ id, mode: 'discover', status: 'failed', error: 'Browser agent did not return business cases.', progress: { revision: 1, cases: [{ id: 'discovery', name: 'Explore application', status: 'failed' }] }, ...(id === forced ? { diagnostics } : {}) });
    await route.fulfill({ json: { run, results: [], progress: run.progress } });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__discovery-ui`);
  const open = (id: string) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture:viewer', { detail })), id);
  const viewer = page.getByRole('dialog');
  await open(forced);
  await expect(viewer.getByRole('alert')).toHaveText('Browser agent did not return business cases.');
  await expect(viewer.getByText('Ended early', { exact: true })).toBeVisible();
  await expect(viewer.getByText('12,800 tokens', { exact: true })).toBeVisible();
  for (const detail of ['5200', 'invalid_output', 'Model calls']) await expect(viewer.getByText(detail)).toHaveCount(0);
  await open(plain);
  await expect(viewer.getByRole('alert')).toHaveText('Browser agent did not return business cases.');
  await expect(viewer.getByText('Ended early', { exact: true })).toHaveCount(0);
  await expect(viewer.getByText(/tokens$/)).toHaveCount(0);
});
