import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';

test('testing invitation creates one Beta, opens setup, and respects prior deletion without starting work', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-testing-entry-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1501, height: 1000 } });
  page.setDefaultTimeout(5000);
  const repoPath = '/acme/app', sha = 'a'.repeat(40);
  let pipeline = defaultPipeline(repoPath), previouslyDeleted = false, rejectCreation = true;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const saving = Promise.withResolvers<void>();
  t.after(() => saving.resolve());
  const view = { cases: [], runs: [], accounts: [], specs: {}, preparation: null,
    config: { targetUrl: '', scope: '', requirements: '', maxSteps: 60 },
    capabilities: { modelConfigured: true, runtimeInstalled: true, browserInstalled: true, playwright: { browserInstalled: true } } };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST') writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    let result: unknown = {};
    if (path === '/api/state') result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [], production: [] } }, pipeline, environments: [], browserTests: {}, providers: [],
      stageRemovals: previouslyDeleted ? [{ stageId: 'deleted-stage', status: 'completed' }] : [] };
    else if (path === '/api/session') result = { token: 'test-session' };
    else if (path === '/api/gate') result = { repoPath, sha, stages: {}, production: null };
    else if (path === '/api/releases') result = { repoPath, sha, target: null, canDeploy: false, blockedReason: null, current: null, unresolved: null, recent: [] };
    else if (path === '/api/environments') result = { environments: [], plan: {} };
    else if (path === '/api/browser') result = view;
    else if (path === '/api/twin/services') result = { services: [] };
    else if (path === '/api/git-history') result = { commits: [], branch: 'main', repository: 'acme/app', source: 'local' };
    else if (path === '/api/pipeline/action') {
      if (rejectCreation) return route.fulfill({ status: 409, json: { error: 'Finish the current change, then try again.' } });
      await saving.promise;
      pipeline = applyPipelineAction(pipeline, request.postDataJSON());
      result = { pipeline };
    }
    await route.fulfill({ json: result });
  });

  await page.goto(`${app.url}#pipeline`);
  const setup = page.getByRole('button', { name: 'Set up testing', exact: true });
  await expect(setup).toBeInViewport({ ratio: 1 });
  await expect(page.getByText('Generate end-to-end tests for your app with AI.', { exact: true })).toBeVisible();
  await expect(page.locator('[aria-roledescription="stage"]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Add stage between Build and Production', exact: true })).toHaveCount(0);
  assert.equal(writes.length, 0, 'Displaying the invitation starts no work.');

  await setup.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Finish the current change' })).toContainText('Finish the current change, then try again.');
  await expect(setup).toBeEnabled();
  assert.equal(pipeline.stages.length, 3, 'Failed setup leaves the invitation intact.');
  rejectCreation = false;
  await setup.click();
  await expect(page.getByRole('button', { name: 'Setting up…', exact: true })).toBeDisabled();
  saving.resolve();
  const sheet = page.getByRole('dialog', { name: 'Beta', exact: true });
  await expect(sheet.getByRole('tab', { name: 'Integration tests', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await expect(setup).toHaveCount(0);
  assert.equal(pipeline.stages.filter(stage => stage.kind === 'sandbox').length, 1);
  assert.equal(pipeline.stages.find(stage => stage.kind === 'sandbox')?.name, 'Beta');
  assert.deepEqual(writes.map(item => item.path), ['/api/pipeline/action', '/api/pipeline/action']);
  for (const { body } of writes) assert.deepEqual(body, { action: 'add-stage', afterStageId: 'build', name: 'Beta', repoPath, ...(pipeline.id ? { pipelineId: pipeline.id } : {}) });
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Beta', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add stage between Beta and Production', exact: true })).toBeVisible();

  // Reloading a source whose last Sandbox was deliberately removed quiets the invitation.
  pipeline = defaultPipeline(repoPath);
  previouslyDeleted = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add testing stage', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByText('Generate end-to-end tests for your app with AI.', { exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-roledescription="stage"]')).toHaveCount(3);
  assert.equal(writes.length, 2);
  assert.deepEqual(errors, []);
});
