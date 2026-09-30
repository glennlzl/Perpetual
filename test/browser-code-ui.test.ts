import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import type { BrowserCase } from '../client/src/lib/browser-test-ui.ts';

// Actual panel, workspace and controls in Chromium. Only the controller/model boundary is a fixture.
const journey: BrowserCase = { id: 'save', name: 'Save and reopen a workflow', goal: 'Save a workflow and reopen it.',
  preconditions: ['A test account'], expectedOutcomes: ['The saved workflow is shown'], assertions: [{ type: 'text-visible', value: 'Workflow {run}' }],
  steps: [{ id: 'save', title: 'Save workflow' }, { id: 'reopen', title: 'Reopen workflow' }], selected: true, needsReview: false, isolation: 'shared', evidence: [] };
const hash = 'a'.repeat(64);

test('journey authoring offers account choices and an actionable missing-check state in Chromium', { timeout: 60000 }, async t => {
  let item = structuredClone(journey);
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const state = () => ({ cases: [item], runs: [], accounts: [], specs: { save: { draft: { hash, stale: false } } },
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
    const controller = async (path, input) => (await fetch('/build/__controller' + path, input === undefined ? {} : {method:'POST', body:JSON.stringify(input)})).json();
    const workspace = createTestWorkspace({controller, pollInterval:0});
    workspace.activate({path:'/acme/app', branch:'main'}, {browserTests:{beta: await controller('/api/browser')}});
    createRoot(document.getElementById('root')).render(React.createElement(TestWorkspaceContext.Provider, {value:workspace}, React.createElement(TooltipProvider, {}, React.createElement(BrowserTestingPanel, {repoPath:'/acme/app', stageId:'beta'}))));
  `;
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'journey-ui-test',
    resolveId(id) { if (id.endsWith('/__journey-ui.tsx')) return '\0journey-ui.tsx'; },
    load(id) { if (id === '\0journey-ui.tsx') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.includes('/__controller')) {
          const path = req.url.split('/__controller')[1];
          if (req.method === 'POST') {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body); requests.push({ path, input });
            if (path === '/api/browser/cases') item = input.cases[0];
          }
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state())); return;
        }
        if (req.url === '/build/__journey-ui') {
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/__journey-ui', '<div id="root"></div><script type="module" src="/build/__journey-ui.tsx"></script>')); return;
        }
        next();
      });
    },
  }] });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__journey-ui`;
  for (const [action, button, path] of [['Verify code', 'Verify', 'verify'], ['Regenerate code', 'Generate', 'generate']]) {
    await t.test(`${action} sends the entered account only on submission`, async t => {
      requests.length = 0; item = structuredClone(journey);
      const page = await browser.newPage(); t.after(() => page.close());
      await page.goto(url);
      await page.getByRole('button', { name: `Actions for ${journey.name}` }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible({ timeout: 2000 });
      assert.equal(requests.length, 0, 'Opening the account dialog starts no work.');
      await dialog.getByRole('switch', { name: 'Use test account' }).click();
      await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('tester@example.test');
      await dialog.getByLabel('Password', { exact: true }).fill('temporary-fixture-password');
      await dialog.getByRole('button', { name: button, exact: true }).click();
      await expect.poll(() => requests.filter(value => value.path === `/api/browser/specs/${path}`).length).toBe(1);
      const request = requests.find(value => value.path === `/api/browser/specs/${path}`)!.input;
      assert.deepEqual(request.credentials, { username: 'tester@example.test', password: 'temporary-fixture-password' });
      assert.equal(request.caseId, 'save');
      if (path === 'verify') assert.equal(request.hash, hash);
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: `Actions for ${journey.name}` }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('switch', { name: 'Use test account' })).not.toBeChecked();
    });
  }
  await t.test('a checkless draft cannot finish review and opens directly on editable checks', async t => {
    requests.length = 0; item = { ...structuredClone(journey), assertions: [], needsReview: true, selected: false };
    const page = await browser.newPage(); t.after(() => page.close()); await page.goto(url);
    await expect(page.getByText('Needs checks', { exact: true })).toBeVisible({ timeout: 2000 });
    await page.getByRole('button', { name: `Actions for ${journey.name}` }).click();
    await page.getByRole('menuitem', { name: 'Add checks', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Review & save' }).click();
    await expect(dialog.getByRole('alert')).toContainText('check');
    assert.equal(requests.length, 0);
    await dialog.getByRole('button', { name: 'Add check', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Check 1 value', exact: true }).fill('Workflow {run}');
    await dialog.getByRole('button', { name: 'Review & save' }).click();
    await expect(dialog).toBeHidden();
    assert.equal(item.needsReview, false); assert.deepEqual(item.assertions, [{ type: 'text-visible', value: 'Workflow {run}' }]);
  });
  await t.test('a selected legacy journey without checks can be deselected but cannot be selected again', async t => {
    requests.length = 0; item = { ...structuredClone(journey), assertions: [] };
    const page = await browser.newPage(); t.after(() => page.close()); await page.goto(url);
    const selection = page.getByRole('checkbox', { name: `Select ${journey.name}` });
    await expect(selection).toBeChecked();
    await expect(selection).toBeEnabled({ timeout: 2000 });
    await selection.click();
    await expect(selection).not.toBeChecked();
    await expect(selection).toBeDisabled();
    assert.equal(item.selected, false); assert.equal(item.needsReview, false);
    assert.deepEqual(item.assertions, [], 'Deselecting does not invent an acceptance check.');
    await page.getByRole('button', { name: `Actions for ${journey.name}` }).click();
    await expect(page.getByRole('menuitem', { name: /^(Generate|Regenerate|Verify|Approve) code$/ })).toHaveCount(0);
  });
  await t.test('a selected legacy journey without checks can return to an unselected draft', async t => {
    requests.length = 0; item = { ...structuredClone(journey), assertions: [] };
    const page = await browser.newPage(); t.after(() => page.close()); await page.goto(url);
    await page.getByRole('button', { name: `Actions for ${journey.name}` }).click();
    const review = page.getByRole('menuitem', { name: 'Needs review', exact: true });
    await expect(review).toBeVisible({ timeout: 2000 });
    await review.click();
    await expect.poll(() => [item.selected, item.needsReview]).toEqual([false, true]);
    const selection = page.getByRole('checkbox', { name: `Select ${journey.name}` });
    await expect(selection).not.toBeChecked(); await expect(selection).toBeDisabled();
    assert.deepEqual(item.assertions, []);
  });
});
