import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import { browserCaseFixture, browserRunFixture } from './fixtures/browser-view.ts';

const hash = 'a'.repeat(64);
const journey = browserCaseFixture({ id: 'save', name: 'Save a workspace', goal: 'Save and reopen the workspace', expectedOutcomes: ['The saved workspace is shown'],
  assertions: [{ type: 'text-visible', value: 'Workspace {run}' }], steps: [{ id: 'save', title: 'Save workspace' }, { id: 'reopen', title: 'Reopen workspace' }] });
const config = { targetUrl: 'http://127.0.0.1:3000/', signInUrl: '', scope: '', requirements: '', maxSteps: 60, journeyTimeoutSeconds: 60, externalOrigins: [], authEndpoints: [] };
const capabilities = { provider: 'openrouter', modelConfigured: true, runtimeInstalled: true, browserInstalled: true, playwright: { browserInstalled: true } };
/** GET /api/browser for the Beta stage; each test varies only its own facts. */
const browserView = (extra: Record<string, unknown> = {}) => ({ cases: [journey], runs: [], accounts: [], specs: {}, preparation: null, config, capabilities, ...extra });
type Reply = { status?: number; json: unknown };

// The actual panel and workspace in Chromium; only the controller boundary is a fixture. Query parameters are the panel's props.
async function journeyPanel(t: TestContext) {
  const controller = {
    view: browserView() as Record<string, unknown>, requests: [] as { path: string; input: Record<string, unknown> }[],
    reply: undefined as ((path: string, input: Record<string, unknown>) => Reply | undefined) | undefined,
  };
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
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error), {statusCode:response.status});
      return data;
    };
    const props = Object.fromEntries(new URLSearchParams(location.search));
    const workspace = createTestWorkspace({controller, pollInterval:0});
    workspace.activate({path:'/acme/app', branch:'main'}, {browserTests:{beta: await controller('/api/browser')}});
    createRoot(document.getElementById('root')).render(React.createElement(TestWorkspaceContext.Provider, {value:workspace}, React.createElement(TooltipProvider, {}, React.createElement(BrowserTestingPanel, {repoPath:'/acme/app', stageId:'beta', ...props}))));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'journey-panel-test', resolveId(id) { if (id.endsWith('/__journey-panel.tsx')) return '\0journey-panel.tsx'; }, load(id) { if (id === '\0journey-panel.tsx') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.includes('/__controller')) {
          const path = req.url.split('/__controller')[1].split('?')[0];
          let input: Record<string, unknown> = {};
          if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; input = JSON.parse(body); controller.requests.push({ path, input }); }
          const reply = controller.reply?.(path, input) ?? { json: controller.view };
          res.statusCode = reply.status ?? 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply.json)); return;
        }
        if (req.url?.startsWith('/build/__journey-panel?') || req.url === '/build/__journey-panel') {
          res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__journey-panel', '<div id="root"></div><script type="module" src="/build/__journey-panel.tsx"></script>')); return;
        }
        next();
      });
    },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__journey-panel`;
  const pageErrors: string[] = [];
  async function open(t: TestContext, props: Record<string, string> = {}) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${url}?${new URLSearchParams(props)}`);
    return page;
  }
  return { controller, open, pageErrors };
}

test('a journey card opens to show code being generated and code that failed to generate or verify', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  const passed = browserRunFixture({ id: 'passed', status: 'passed', caseIds: ['save'], caseSummaries: [journey], results: [{ caseId: 'save', status: 'passed' }] });
  const states = [
    { name: 'generating', specs: { generation: { status: 'running' } }, runs: [], badge: 'Generating', error: '' },
    { name: 'generation failed', specs: { generation: { status: 'failed', error: 'The generator wrote no test file.' } }, runs: [], badge: 'Generation failed', error: 'The generator wrote no test file.' },
    { name: 'verification failed after passing runs', specs: { draft: { hash, stale: false, verification: { status: 'failed', passes: 3, error: 'The control run was not caught.' } } }, runs: [passed], badge: 'Verification failed', error: 'The control run was not caught.' },
  ];
  for (const state of states) await t.test(state.name, async t => {
    fixture.controller.view = browserView({ specs: { save: state.specs }, runs: state.runs });
    const page = await fixture.open(t);
    await expect(page.getByRole('button', { name: 'Save a workspace details', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(state.badge, { exact: true })).toBeVisible();
    if (state.error) await expect(page.getByText(state.error, { exact: true })).toBeVisible();
  });
  await t.test('approved code needing nothing leaves a passed journey collapsed', async t => {
    fixture.controller.view = browserView({ specs: { save: { approved: { hash, stale: false } } }, runs: [passed] });
    const page = await fixture.open(t);
    await expect(page.getByRole('button', { name: 'Save a workspace details', exact: true })).toHaveAttribute('aria-expanded', 'false');
  });
  assert.deepEqual(fixture.pageErrors, []);
});

test('a kept editor draft saves the selection the journey has now, not the one it had when editing began', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  let cases = [{ ...journey, selected: false }];
  fixture.controller.view = browserView({ cases });
  fixture.controller.reply = (path, input) => {
    if (path !== '/api/browser/cases') return undefined;
    cases = input.cases as typeof cases; fixture.controller.view = browserView({ cases });
    return { json: { cases } };
  };
  const page = await fixture.open(t), dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Actions for Save a workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Business goal').fill('Save, reopen and rename the workspace');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Save a workspace', exact: true }).click();
  await expect.poll(() => cases[0].selected).toBe(true);
  await page.getByRole('button', { name: 'Actions for Save a workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByLabel('Business goal')).toHaveValue('Save, reopen and rename the workspace');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(cases[0].goal, 'Save, reopen and rename the workspace');
  assert.equal(cases[0].selected, true, 'The later selection still holds, so the gate keeps running the journey.');
  assert.deepEqual(fixture.pageErrors, []);
});
