import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import { browserCaseFixture, browserRunFixture } from './fixtures/browser-view.ts';

// Mount the actual panel and workspace. HTTP outcomes are controlled; no business journey or model runs.
test('running one unselected journey names it in the run and leaves the saved selection unchanged', { timeout: 60000 }, async t => {
  const item = browserCaseFixture({ id: 'save', name: 'Save a workspace', goal: 'Save and reopen the workspace', expectedOutcomes: ['The saved workspace is shown'], assertions: [{ type: 'text-visible', value: 'Workspace {run}' }],
    steps: [{ id: 'save', title: 'Save workspace' }, { id: 'reopen', title: 'Reopen workspace' }] });
  let runs: ReturnType<typeof browserRunFixture>[] = [];
  const posts: { path: string; input: Record<string, unknown> }[] = [];
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
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'selection-ui-test', resolveId(id) { if (id.endsWith('/__selection-ui.tsx')) return '\0selection-ui.tsx'; }, load(id) { if (id === '\0selection-ui.tsx') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.includes('/__controller')) {
          const path = req.url.split('/__controller')[1].split('?')[0];
          let result: unknown = state();
          if (req.method === 'POST') {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            posts.push({ path, input });
            if (path === '/api/browser/run') { const run = browserRunFixture({ id: 'one-off', status: 'passed', caseIds: input.caseIds, caseSummaries: [item] }); runs = [run]; result = { run }; }
            else if (path === '/api/browser/config') result = { config: input.config };
            else result = { error: 'Unexpected write.' };
          }
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
        }
        if (req.url === '/build/__selection-ui') {
          res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__selection-ui', '<div id="root"></div><script type="module" src="/build/__selection-ui.tsx"></script>')); return;
        }
        next();
      });
    },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__selection-ui`);
  const selection = page.getByRole('checkbox', { name: `Select ${item.name}` });
  await expect(selection).not.toBeChecked();
  await page.getByRole('button', { name: `Actions for ${item.name}` }).click();
  await page.getByRole('menuitem', { name: 'Run', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => posts.filter(post => post.path === '/api/browser/run').length).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The run names its journey; no case write selects it first or deselects it afterwards.
  assert.deepEqual(posts.find(post => post.path === '/api/browser/run')!.input.caseIds, ['save']);
  await page.getByRole('button', { name: 'Close tests', exact: true }).click();
  await page.getByRole('button', { name: 'Open tests', exact: true }).click();
  await expect(selection).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toHaveCount(0);
  assert.deepEqual(posts.map(post => post.path).filter(path => path !== '/api/browser/config'), ['/api/browser/run']);
});
