import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { browserCaseFixture, browserRunFixture } from './fixtures/browser-view.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

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

test('a run requested from the canvas names what keeps its dialog from running', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  const approved = { save: { approved: { hash, stale: false } } };
  const blockers = [
    { name: 'no target URL', view: browserView({ specs: approved, config: { ...config, targetUrl: '' } }), notice: 'Set a target URL.' },
    { name: 'no code', view: browserView(), notice: 'Generate code first.' },
  ];
  for (const blocker of blockers) await t.test(blocker.name, async t => {
    fixture.controller.view = blocker.view;
    const page = await fixture.open(t, { initialCaseId: '!run:save', caseRequestKey: '1' });
    const dialog = page.getByRole('dialog', { name: 'Save a workspace', exact: true });
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toHaveText(blocker.notice);
  });
  await t.test('a runnable journey shows no notice', async t => {
    fixture.controller.view = browserView({ specs: approved });
    const page = await fixture.open(t, { initialCaseId: '!run:save', caseRequestKey: '1' });
    const dialog = page.getByRole('dialog', { name: 'Save a workspace', exact: true });
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });
  assert.deepEqual(fixture.pageErrors, []);
});

test('the journey list, a focused journey and its recording tabs have the roles and names assistive technology reads', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  const failed = browserRunFixture({ id: 'failed', status: 'failed', caseIds: ['save'], caseSummaries: [journey], results: [{ caseId: 'save', status: 'failed' }],
    progress: { revision: 1, cases: [{ id: 'save', status: 'failed', videos: ['page@1.webm', 'page@2.webm'] }] } });
  fixture.controller.view = browserView({ specs: { save: { approved: { hash, stale: false } } }, runs: [failed] });
  const page = await fixture.open(t, { initialCaseId: 'save', caseRequestKey: '1' });
  const list = page.getByRole('list', { name: 'Integration tests', exact: true });
  const card = list.getByRole('listitem', { name: 'Save a workspace', exact: true });
  // A journey opened from the canvas is focused as the named item of the list.
  await expect(card).toBeFocused();
  const tab = card.getByRole('tab', { name: 'Tab 2', exact: true });
  await tab.click();
  const panel = page.locator(`#${await tab.getAttribute('aria-controls')}`);
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel.getByLabel('Save a workspace recording', { exact: true })).toHaveCount(1);
  // The tabs come before their panels, and a panel is no stop of its own, so Tab moves from the chosen tab into its recording.
  await expect(panel).toHaveAttribute('tabindex', '-1');
  await tab.press('Tab');
  assert.ok(await panel.evaluate(element => element !== document.activeElement && element.contains(document.activeElement)), 'The recording, or its retry, is focused.');
  assert.deepEqual(fixture.pageErrors, []);
});

test('Discard draft asks first and discards exactly the draft it was chosen for', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  fixture.controller.view = browserView({ specs: { save: { draft: { hash, stale: false, verification: { status: 'passed', passes: 3, control: 'caught' } } } } });
  const page = await fixture.open(t), confirm = page.getByRole('alertdialog', { name: 'Discard draft?', exact: true });
  const discard = async () => {
    await page.getByRole('button', { name: 'Actions for Save a workspace', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Discard draft', exact: true }).click();
  };
  await discard();
  await expect(confirm.getByText('Save a workspace', { exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  assert.deepEqual(fixture.controller.requests, [], 'A verified draft is never discarded by the menu item alone.');
  await discard();
  await confirm.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  assert.deepEqual(fixture.controller.requests, [{ path: '/api/browser/specs/discard', input: { caseId: 'save', hash, repoPath: '/acme/app', stageId: 'beta' } }]);
  assert.deepEqual(fixture.pageErrors, []);
});

test('a journey cannot be edited while its code is generated, and can once generation stops', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  fixture.controller.view = browserView({ specs: { save: { generation: { status: 'running' } } } });
  const page = await fixture.open(t);
  await expect(page.getByRole('button', { name: 'Save a workspace: Edit', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for Save a workspace', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Stop generating', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  fixture.controller.view = browserView({ specs: {} });
  const ready = await fixture.open(t);
  await ready.getByRole('button', { name: 'Save a workspace: Edit', exact: true }).click();
  await expect(ready.getByRole('dialog', { name: 'Edit test', exact: true })).toBeVisible();
  assert.deepEqual(fixture.pageErrors, []);
});

test('an unconfirmed browser cleanup offers Cleanup done, which asks first and then releases the application', { timeout: 60000 }, async t => {
  const fixture = await journeyPanel(t);
  fixture.controller.view = browserView({ cleanup: { operation: 'run', startedAt: '2026-10-01T00:00:00.000Z' } });
  fixture.controller.reply = path => {
    if (path !== '/api/browser/cleanup') return undefined;
    fixture.controller.view = browserView();
    return { json: { cleanup: null } };
  };
  const page = await fixture.open(t);
  await expect(page.getByText('Cleanup unconfirmed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cleanup done', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Confirm browser cleanup?' })).toBeVisible();
  await expect(dialog.getByText('http://127.0.0.1:3000', { exact: true })).toBeVisible();
  // Cancelling confirms nothing.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(fixture.controller.requests.filter(request => request.path === '/api/browser/cleanup'), []);
  await page.getByRole('button', { name: 'Cleanup done', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cleanup done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Cleanup unconfirmed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cleanup done', exact: true })).toHaveCount(0);
  assert.deepEqual(fixture.controller.requests.filter(request => request.path === '/api/browser/cleanup').map(request => [request.input.repoPath, request.input.stageId]), [['/acme/app', 'beta']]);
  assert.deepEqual(fixture.pageErrors, []);
});
