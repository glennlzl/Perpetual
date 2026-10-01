import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { browserCaseFixture, browserRunFixture } from './fixtures/browser-view.ts';

// Mount the actual panel and workspace. HTTP outcomes are controlled; no business journey or model runs.
test('one-off selection can be restored after a failed save without starting the journey again', { timeout: 60000 }, async t => {
  let item = browserCaseFixture({ id: 'save', name: 'Save a workspace', goal: 'Save and reopen the workspace', expectedOutcomes: ['The saved workspace is shown'], assertions: [{ type: 'text-visible', value: 'Workspace {run}' }],
    steps: [{ id: 'save', title: 'Save workspace' }, { id: 'reopen', title: 'Reopen workspace' }] });
  const original = structuredClone(item);
  let runs: ReturnType<typeof browserRunFixture>[] = [], failRestore = true, startFails = false, restoreAttempts = 0, starts = 0;
  const state = () => ({ cases: [item], runs, accounts: [], specs: { save: { draft: { hash: 'a'.repeat(64), stale: false } } },
    config: { targetUrl: 'http://127.0.0.1:3000/', signInUrl: '', scope: '', requirements: '', maxSteps: 60, journeyTimeoutSeconds: 60, externalOrigins: [], authEndpoints: [] },
    capabilities: { provider: 'openrouter', modelConfigured: true, runtimeInstalled: true, browserInstalled: true, playwright: { browserInstalled: true } } });
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import BrowserTestingPanel from '/src/BrowserTestingPanel.tsx';
    import { TestWorkspaceContext } from '/src/lib/use-test-workspace.tsx';
    import { createTestWorkspace } from '/src/lib/test-workspace.ts';
    import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
    import '/src/index.css';
    import '/src/workspace.css';
    const controller = async (path, input) => {
      const response = await fetch('/build/__controller' + path, input === undefined ? {} : {method:'POST', body:JSON.stringify(input)});
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), {statusCode:response.status});
      return result;
    };
    const workspace = createTestWorkspace({controller, pollInterval:0});
    workspace.activate({path:'/acme/app', branch:'main'}, {browserTests:{beta: await controller('/api/browser')}});
    const root = createRoot(document.getElementById('root'));
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(TestWorkspaceContext.Provider, {value:workspace}, React.createElement(TooltipProvider, {},
        React.createElement('button', {onClick:()=>setOpen(!open)}, open ? 'Close tests' : 'Open tests'),
        open && React.createElement(BrowserTestingPanel, {repoPath:'/acme/app', stageId:'beta'})));
    }
    root.render(React.createElement(Fixture));
  `;
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'selection-ui-test', resolveId(id) { if (id.endsWith('/__selection-ui.tsx')) return '\0selection-ui.tsx'; }, load(id) { if (id === '\0selection-ui.tsx') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.includes('/__controller')) {
          const path = req.url.split('/__controller')[1].split('?')[0];
          let result: unknown = state(), status = 200;
          if (req.method === 'POST') {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            if (path === '/api/browser/cases') {
              assert.deepEqual(input.baseCases, [item], 'Every write carries the current controller conflict base.');
              if (!input.cases[0].selected) restoreAttempts++;
              if (!input.cases[0].selected && failRestore) { status = 503; result = { error: 'Selection could not be restored.' }; }
              else { item = input.cases[0]; result = { cases: [item] }; }
            } else if (path === '/api/browser/run') {
              starts++;
              if (startFails) { status = 409; result = { error: 'The run could not start.' }; }
              else { const run = browserRunFixture({ id: 'one-off', status: 'passed', caseIds: ['save'], caseSummaries: [item] }); runs = [run]; result = { run }; }
            } else if (path === '/api/browser/config') result = { config: input.config };
          }
          res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
        }
        if (req.url === '/build/__selection-ui') {
          res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__selection-ui', '<div id="root"></div><script type="module" src="/build/__selection-ui.tsx"></script>')); return;
        }
        next();
      });
    },
  }] });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const scenario of ['retry after remount', 'failed start then reload', 'user deselects and selects again']) await t.test(scenario, async t => {
    item = structuredClone(original); runs = []; failRestore = true; startFails = scenario === 'failed start then reload'; restoreAttempts = 0; starts = 0;
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__selection-ui`);
    const selection = page.getByRole('checkbox', { name: `Select ${item.name}` });
    await expect(selection).not.toBeChecked();
    await page.getByRole('button', { name: `Actions for ${item.name}` }).click();
    await page.getByRole('menuitem', { name: 'Run', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => restoreAttempts).toBe(1);
    await expect(page.getByRole('alert')).toContainText('Selection could not be restored.');
    if (startFails) await expect(page.getByRole('alert')).toContainText('The run could not start.');
    await expect(selection).toBeChecked();
    const runSelected = page.getByRole('button', { name: 'Run selected (1)', exact: true });
    await expect(runSelected).toHaveAttribute('aria-disabled', 'true');
    await runSelected.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (scenario === 'retry after remount') {
      await page.getByRole('button', { name: 'Close tests', exact: true }).click();
      await page.getByRole('button', { name: 'Open tests', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeVisible();
      assert.equal(restoreAttempts, 1, 'Mounting does not repeatedly retry a known failed save.');
      failRestore = false;
      await page.getByRole('button', { name: 'Restore selection', exact: true }).click();
    } else if (startFails) {
      failRestore = false;
      await page.reload();
    } else {
      failRestore = false;
      await selection.click();
    }
    await expect(selection).not.toBeChecked();
    assert.equal(restoreAttempts, 2);
    if (scenario === 'user deselects and selects again') {
      await selection.click(); await expect(selection).toBeChecked();
      await page.reload(); await expect(selection).toBeChecked();
      await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toHaveCount(0);
      assert.equal(restoreAttempts, 2, 'A later user selection is not an owned temporary choice.');
    }
    assert.equal(starts, 1, 'Restoring a choice never retries a business journey.');
  });
});
