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
test('the run viewer closes without cancelling, confirms Cancel run, keeps its failure and stops reading a finished or missing run', { timeout: 60000 }, async t => {
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
  const runId = '11111111-1111-4111-8111-111111111111', missing = '22222222-2222-4222-8222-222222222222';
  let status: 'running' | 'passed' = 'running', stopFails = true;
  const reads: string[] = [], stops: unknown[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/session') return route.fulfill({ json: { token: 'fixture-token' } });
    if (path === '/api/browser/stop') {
      stops.push(route.request().postDataJSON());
      return route.fulfill(stopFails ? { status: 503, json: { error: 'The run could not be stopped.' } } : { json: {} });
    }
    if (path.endsWith('/frame')) return route.fulfill({ status: 204, body: '' });
    const id = decodeURIComponent(path.split('/').at(-1)!);
    reads.push(id);
    if (id !== runId) return route.fulfill({ status: 404, json: { error: 'Browser run not found in this stage.' } });
    const run = browserRunFixture({ id: runId, status, caseIds: ['save'], caseSummaries: [journey], progress: { revision: 1, cases: [{ id: 'save', status }] }, ...(status === 'passed' ? { completedAt: '2026-01-01T00:05:00Z' } : {}) });
    await route.fulfill({ json: { run, results: status === 'passed' ? [{ caseId: 'save', status: 'passed', assertions: [] }] : [], progress: run.progress } });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__viewer-ui`);
  const open = (id: string) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture:viewer', { detail })), id);
  const viewer = page.getByRole('dialog');
  const quiet = async () => { const before = reads.length; await page.waitForTimeout(1500); return reads.length - before; };

  // Closing only hides the viewer; the run keeps going.
  await open(runId);
  await expect(viewer.getByText('Running', { exact: true }).first()).toBeVisible();
  await viewer.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  assert.deepEqual(stops, []);
  // Cancel run asks first, and a failed stop stays explained while the run is still read.
  await page.getByRole('button', { name: 'Open viewer', exact: true }).click();
  await viewer.getByRole('button', { name: 'Cancel run', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Keep running', exact: true }).click();
  assert.deepEqual(stops, []);
  await viewer.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await confirm.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect.poll(() => stops).toEqual([{ repoPath: '/acme/app', stageId: 'beta', id: runId }]);
  await expect(viewer.getByRole('alert')).toHaveText('The run could not be stopped.');
  assert.ok(await quiet() > 0, 'The run is still read.');
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
  assert.deepEqual(pageErrors, []);
});
