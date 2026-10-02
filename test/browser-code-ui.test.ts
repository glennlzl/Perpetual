import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import type { BrowserCase } from '../client/src/lib/browser-test-ui.ts';

// Actual panel, workspace and controls in Chromium. Only the controller/model boundary is a fixture.
const journey: BrowserCase = { id: 'save', name: 'Save and reopen a workflow', goal: 'Save a workflow and reopen it.',
  preconditions: ['A test account'], expectedOutcomes: ['The saved workflow is shown'], assertions: [{ type: 'text-visible', value: 'Workflow {run}' }],
  steps: [{ id: 'save', title: 'Save workflow' }, { id: 'reopen', title: 'Reopen workflow' }], selected: true, needsReview: false, isolation: 'shared', evidence: [] };
const hash = 'a'.repeat(64);

test('journey authoring offers account choices and an actionable missing-check state in Chromium', { timeout: 60000 }, async t => {
  let item = structuredClone(journey);
  let reviewMode: 'none' | 'ready' | 'unavailable' = 'none';
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const state = () => ({ cases: [item], runs: [], accounts: [], specs: { save: { draft: { hash, stale: false, ...(reviewMode !== 'none' ? { verification: { status: 'passed', passes: 3 } } : {}) } } },
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    };
    const workspace = createTestWorkspace({controller, pollInterval:0});
    workspace.activate({path:'/acme/app', branch:'main'}, {browserTests:{beta: await controller('/api/browser')}});
    createRoot(document.getElementById('root')).render(React.createElement(TestWorkspaceContext.Provider, {value:workspace}, React.createElement(TooltipProvider, {}, React.createElement(BrowserTestingPanel, {repoPath:'/acme/app', stageId:'beta'}))));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'journey-ui-test',
    resolveId(id) { if (id.endsWith('/__journey-ui.tsx')) return '\0journey-ui.tsx'; },
    load(id) { if (id === '\0journey-ui.tsx') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith('/api/browser/specs/code?')) {
          res.setHeader('Content-Type', 'application/json');
          if (reviewMode === 'unavailable') {
            res.statusCode = 503; res.end(JSON.stringify({ error: 'Could not read the draft. Try again.' })); return;
          }
          const code = Array.from({ length: 60 }, (_, index) => `  await page.getByRole('button', { name: 'Workflow milestone ${index + 1}' }).click();`).join('\n');
          res.end(JSON.stringify({ authoring:[{id:'11111111-1111-1111-1111-111111111111',startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T00:00:03.000Z',durationMs:3000,caseHash:hash,outputHash:hash,outcome:'draft',cleanup:'complete',provenance:{harness:'opencode@1.18.32',generator:'playwright-test-generator@1.63.0',model:'openrouter/example/model'},attempts:[{phase:'generation',startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T00:00:03.000Z',durationMs:3000,outcome:'completed',outputHash:hash,codeHash:hash,outputBytes:100,eventsTruncated:false,reportedFinishReason:'unknown',usage:null,events:[{tool:'browser_click',outcome:'error'}]}]}], draft: { hash, code: `${code}\n  await page.getByText('Workflow saved').waitFor();` }, approved: { code } })); return;
        }
        if (req.url?.includes('/__controller')) {
          const path = req.url.split('/__controller')[1];
          if (req.method === 'POST') {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body); requests.push({ path, input });
            if (path === '/api/browser/specs/approve') {
              res.statusCode = 409; res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'This draft changed. Close this review and approve the latest verified code.' })); return;
            }
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
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__journey-ui`;
  await t.test('authoring diagnostics are readable before verification and trigger no work', async t => {
    requests.length = 0; reviewMode = 'none';
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } }); t.after(() => page.close());
    page.on('pageerror', error => t.diagnostic(`Page error: ${error.message}`));
    page.on('requestfailed', request => { if (request.resourceType() === 'script') t.diagnostic(`Module failed: ${request.url()} ${request.failure()?.errorText}`); });
    page.on('response', response => { if (response.status() >= 400 && response.request().resourceType() === 'script') t.diagnostic(`Module HTTP ${response.status()}: ${response.url()}`); });
    await page.goto(url);
    await page.getByRole('button', { name: `Actions for ${journey.name}`, exact: true }).click();
    const menu = page.getByRole('menuitem', { name: 'Authoring diagnostics', exact: true });
    await expect(menu).toBeVisible({ timeout: 2000 }); await menu.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Authoring diagnostics' })).toBeVisible();
    await dialog.getByRole('button', { name: /Draft generated/ }).click();
    await expect(dialog.getByText('Finish reason: Unknown', { exact: true })).toBeVisible();
    await expect(dialog.getByText('browser click', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Tool error', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    assert.equal(requests.length, 0, 'A read-only diagnostic performs no generation, run or approval.');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  });
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
  await t.test('an invalid long journey keeps its error and editor controls in view on a narrow screen', async t => {
    requests.length = 0;
    item = { ...structuredClone(journey), steps: Array.from({ length: 12 }, (_, index) => ({
      id: `step-${index}`, title: `Milestone ${index + 1}: save the workflow, reopen the persisted result, and confirm that the expected business outcome is visible.`,
      checks: [{ type: 'text-visible', value: 'Workflow saved' }],
    })) };
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } }); t.after(() => page.close());
    await page.goto(url);
    const opener = page.getByRole('button', { name: `${journey.name}: Edit`, exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Step 1 title', exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const error = dialog.getByRole('alert');
    await expect(error).toHaveText('Name each business step.');
    await expect(error).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('heading', { name: 'Edit test', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 });
    assert.equal(requests.length, 0, 'An invalid draft never reaches the controller.');
    await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    assert.ok(item.steps?.[0].title, 'Discarding the local edit keeps the saved milestone.');
  });
  await t.test('a rejected approval keeps the code review title, error and controls visible', async t => {
    requests.length = 0; item = structuredClone(journey); reviewMode = 'ready';
    t.after(() => { reviewMode = 'none'; });
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } }); t.after(() => page.close());
    await page.goto(url);
    const opener = page.getByRole('button', { name: `Actions for ${journey.name}`, exact: true });
    await opener.click();
    await page.getByRole('menuitem', { name: 'Approve code', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('This draft changed.');
    await expect(dialog.getByRole('heading', { name: 'Approve code', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('alert')).toBeInViewport({ ratio: 1 });
    for (const name of ['Approve', 'Cancel', 'Close']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    assert.equal(requests.length, 1, 'A failed approval is never retried automatically.');
    assert.equal(requests[0].input.hash, hash, 'Approval still names the exact reviewed code.');
    const code = dialog.locator('pre');
    await code.focus();
    for (let pageDown = 0; pageDown < 6; pageDown++) {
      const before = await code.evaluate(element => ({ top: element.scrollTop, end: element.scrollHeight - element.clientHeight }));
      if (before.top >= before.end - 1) break;
      await page.keyboard.press('PageDown');
      await expect.poll(() => code.evaluate(element => element.scrollTop)).toBeGreaterThan(before.top);
    }
    await expect(dialog.locator('pre').getByText("await page.getByText('Workflow saved').waitFor();", { exact: false })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(opener).toBeFocused();
  });
  await t.test('a draft read failure cannot be approved and can be closed with the keyboard', async t => {
    requests.length = 0; item = structuredClone(journey); reviewMode = 'unavailable';
    t.after(() => { reviewMode = 'none'; });
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } }); t.after(() => page.close());
    await page.goto(url);
    const opener = page.getByRole('button', { name: `Actions for ${journey.name}`, exact: true });
    await opener.click(); await page.getByRole('menuitem', { name: 'Approve code', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toHaveText('Could not read the draft. Try again.');
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    assert.equal(requests.length, 0);
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
