import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';
import type { Environment } from '../contract/environment.ts';

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`testing setup creates one Beta and prepares its environment (${reducedMotion})`, { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-testing-entry-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1501, height: 1000 }, reducedMotion });
  page.setDefaultTimeout(5000);
  const repoPath = '/acme/app', sha = 'a'.repeat(40);
  let pipeline = defaultPipeline(repoPath), previouslyDeleted = false, rejectCreation = true;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const saving = Promise.withResolvers<void>();
  const preparing = Promise.withResolvers<void>();
  t.after(() => saving.resolve());
  t.after(() => preparing.resolve());
  let rejectEnvironment = true;
  let environments: Environment[] = [];
  const view = { cases: [], runs: [], accounts: [], specs: {}, preparation: null,
    config: { targetUrl: '', scope: '', requirements: '', maxSteps: 60 },
    capabilities: { modelConfigured: true, runtimeInstalled: true, browserInstalled: true, playwright: { browserInstalled: true } } };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST') writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    let result: unknown = {};
    if (path === '/api/state') result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [], production: [] } }, pipeline, environments, browserTests: {}, providers: [],
      stageRemovals: previouslyDeleted ? [{ stageId: 'deleted-stage', status: 'completed' }] : [] };
    else if (path === '/api/session') result = { token: 'test-session' };
    else if (path === '/api/gate') result = { repoPath, sha, stages: {}, production: null };
    else if (path === '/api/releases') result = { repoPath, sha, target: null, canDeploy: false, blockedReason: null, current: null, unresolved: null, recent: [] };
    else if (path === '/api/environments') result = { environments, plan: {} };
    else if (path === '/api/environments/create') {
      await preparing.promise;
      if (rejectEnvironment) return route.fulfill({ status: 409, json: { error: 'Start Docker, then retry environment setup.' } });
      environments = [{ id: 'test-environment', stageId: request.postDataJSON().stageId, repoPath, status: 'preparing', step: 'Installing dependencies', createdAt: new Date().toISOString() }];
      result = { environment: environments[0] };
    }
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
  await expect(setup).toBeInViewport({ ratio: 0.99 });
  await expect(page.getByText('Agents test your app like real users in a production-like sandbox.', { exact: true })).toBeVisible();
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
  const motion = page.evaluate(async () => {
    const positions: number[] = [];
    let revealed = false;
    const started = performance.now();
    while (performance.now() - started < 800) {
      const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="production"]');
      if (node) positions.push(new DOMMatrix(getComputedStyle(node).transform).m41);
      revealed ||= [...document.querySelectorAll('.pipeline-stage')].some(card => card.getAnimations().some(animation => (animation as CSSAnimation).animationName === 'stage-insert'));
      await new Promise(requestAnimationFrame);
    }
    return { positions, revealed };
  });
  saving.resolve();
  const sheet = page.getByRole('dialog', { name: 'Beta', exact: true });
  await expect(sheet.getByRole('tab', { name: 'Integration tests', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await expect(setup).toHaveCount(0);
  const beta = page.locator('[aria-roledescription="stage"]').filter({ has: page.getByRole('button', { name: 'Beta', exact: true }) });
  await expect(beta.getByRole('button', { name: 'Preparing environment…', exact: true })).toBeDisabled();
  await expect(beta.locator('.stage-status')).toHaveText('Preparing');
  await expect(page.getByRole('button', { name: 'Create Beta environment', exact: true })).toHaveCount(0);
  const animation = await motion;
  const from = animation.positions[0]!, to = animation.positions.at(-1)!;
  assert.ok(Math.abs(from - to) > 20, 'Replacing the invitation changes the measured layout.');
  assert.equal(animation.revealed, reducedMotion === 'no-preference');
  if (reducedMotion === 'no-preference') assert.ok(animation.positions.some(x => Math.abs(x - from) > 2 && Math.abs(x - to) > 2), 'Production travels through intermediate positions.');
  assert.equal(pipeline.stages.filter(stage => stage.kind === 'sandbox').length, 1);
  assert.equal(pipeline.stages.find(stage => stage.kind === 'sandbox')?.name, 'Beta');
  assert.deepEqual(writes.map(item => item.path), ['/api/pipeline/action', '/api/pipeline/action', '/api/environments/create']);
  for (const { body } of writes.slice(0, 2)) assert.deepEqual(body, { action: 'add-stage', afterStageId: 'build', name: 'Beta', repoPath, ...(pipeline.id ? { pipelineId: pipeline.id } : {}) });
  assert.deepEqual(writes[2]!.body, { repoPath, stageId: pipeline.stages.find(stage => stage.kind === 'sandbox')!.id });
  preparing.resolve();
  await expect(beta.getByRole('alert')).toHaveText('Start Docker, then retry environment setup.');
  await expect(beta.locator('.stage-status')).toHaveText('Setup failed');
  rejectEnvironment = false;
  await beta.getByRole('button', { name: 'Retry environment', exact: true }).click();
  await expect(sheet.getByText('Installing dependencies', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(beta.getByRole('button', { name: 'Retry environment', exact: true })).toHaveCount(0);
  await expect(beta.getByRole('alert')).toHaveCount(0);
  assert.equal(pipeline.stages.filter(stage => stage.kind === 'sandbox').length, 1, 'Retry creates an environment, never another stage.');
  assert.deepEqual(writes.map(item => item.path), ['/api/pipeline/action', '/api/pipeline/action', '/api/environments/create', '/api/environments/create']);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Beta', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add stage between Beta and Production', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
  assert.equal(writes.length, 4, 'Reloading a saved stage never retries creation or starts tests.');

  // Removing the last Sandbox restores the same full invitation, including after reload.
  pipeline = defaultPipeline(repoPath);
  environments = [];
  previouslyDeleted = true;
  await page.reload();
  await expect(setup).toBeInViewport({ ratio: 0.99 });
  await expect(page.getByRole('heading', { name: 'Test your app', exact: true })).toBeVisible();
  await expect(page.getByText('Agents test your app like real users in a production-like sandbox.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add testing stage', exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-roledescription="stage"]')).toHaveCount(3);
  assert.equal(writes.length, 4);
  assert.deepEqual(errors, []);
});
