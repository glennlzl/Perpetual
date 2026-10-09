import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import { defaultPipeline, applyPipelineAction } from '../src/pipeline.ts';
import type { AutopilotView } from '../contract/autopilot.ts';
import type { BuildReply } from '../contract/github.ts';
import type { ReleaseReply } from '../contract/releases.ts';
import { startServer } from '../src/server.ts';

// Exercise the actual App, including independent gate and workspace polls. Only HTTP replies are fixtures.
test('a gate commit refresh preserves a pending optimistic stage collapse in Chromium', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-sync-'));
  const server = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const firstSha = 'a'.repeat(40), nextSha = 'b'.repeat(40), repoPath = '/acme/app';
  let pipeline = defaultPipeline(repoPath), gateSha = firstSha;
  const state = () => ({ defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha: gateSha }, delivery: { source: [], build: [], production: [] } }, pipeline, environments: [], browserTests: {}, providers: [] });
  let holdState = false, stateRequests = 0, writes = 0;
  let releaseState = () => {}, releaseWrite = () => {};
  const stateHeld = new Promise<void>(resolve => { releaseState = resolve; });
  const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  t.after(() => { releaseState(); releaseWrite(); });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {};
    if (path === '/api/state') {
      result = state(); stateRequests++;
      if (holdState) await stateHeld;
    } else if (path === '/api/gate') result = { repoPath, sha: gateSha, stages: {}, production: null };
    else if (path === '/api/session') result = { token: 'test-session' };
    else if (path === '/api/pipeline/action') {
      writes++;
      await writeHeld;
      pipeline = applyPipelineAction(pipeline, route.request().postDataJSON());
      result = { pipeline };
    }
    await route.fulfill({ json: result });
  });
  await page.goto(`${server.url}#pipeline`);
  await expect(page.getByRole('button', { name: 'Collapse Build', exact: true })).toBeVisible();
  // The gate learns about the next commit and starts a source read. The user collapses Build before it returns.
  const before = stateRequests; holdState = true; gateSha = nextSha;
  // Let the shipped app's gate poll notice the new head; no dev-only module import or notification.
  await expect.poll(() => stateRequests).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Collapse Build', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  releaseState(); holdState = false;
  await expect(page.getByText('bbbbbbb', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  assert.equal(writes, 1, 'The refresh never repeats the preference write.');
  releaseWrite();
  await expect.poll(() => pipeline.stages.find(stage => stage.id === 'build')?.collapsed).toBe(true);
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, [], 'The production pipeline renders without uncaught browser errors.');
});

test('rapid collapses stay interactive, isolate a failed save and can be retried in Chromium', { timeout: 60000 }, async t => {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  // Keep both controls in view across the full-width testing invitation; this exercises concurrent saves, not canvas panning.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }), repoPath = '/acme/app', first = Promise.withResolvers<void>();
  t.after(() => first.resolve());
  let pipeline = defaultPipeline(repoPath), writes = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {}, status = 200;
    if (path === '/api/state') result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main' }, delivery: { source: [], build: [], production: [] } }, pipeline, environments: [], browserTests: {} };
    else if (path === '/api/session') result = { token: 'test-session' };
    else if (path === '/api/pipeline/action') {
      if (++writes === 1) { await first.promise; result = { error: 'Build preference could not be saved' }; status = 503; }
      else { pipeline = applyPipelineAction(pipeline, route.request().postDataJSON()); result = { pipeline }; }
    }
    await route.fulfill({ json: result, status });
  });
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  await page.goto(`${origin}/build/#pipeline`);
  await page.getByRole('button', { name: 'Collapse Build', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse Production', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Production', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Switch branch: main', exact: true })).toBeEnabled();
  first.resolve();
  await expect(page.getByText('Build preference could not be saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Build', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Production', exact: true })).toBeVisible();
  await expect.poll(() => writes).toBe(2);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => writes).toBe(3);
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Production', exact: true })).toBeVisible();
  await expect(page.getByText('Build preference could not be saved', { exact: true })).toHaveCount(0);
});

test('a global repair cleanup failure is visible without changing Build or importing another source’s repairs', { timeout: 60000 }, async t => {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), repoPath = '/acme/beta', sha = 'b'.repeat(40);
  const reason = 'Repair cleanup must finish before another repair can start. Docker removal failed.';
  let watchError: string | undefined = reason, pipeline = defaultPipeline(repoPath), writes = 0, sourceFailure = false;
  const autopilot = (): AutopilotView => ({ repoPath, stages: { build: { mode: 'merge', changes: [], failed: { sha, runs: [] } } }, ...(watchError ? { watchError } : {}) });
  const build: BuildReply = { repoPath, repository: 'acme/beta', branch: 'main', scannedSha: sha, sha, source: 'watched', runs: [{ id: '1', workflowId: '2', name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'failure', attempt: 1, sha, branch: 'main', url: null, createdAt: null, startedAt: null, updatedAt: null, jobs: [] }] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {}, status = 200;
    if (path === '/api/state') {
      if (sourceFailure) { status = 503; result = { error: 'Workspace refresh failed' }; }
      else result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'beta', branch: 'main', sha }, delivery: { source: [], build: [{ id: 'github-actions', kind: 'github-actions', provider: 'github-actions', label: 'GitHub Actions' }], production: [] } }, pipeline, environments: [], browserTests: {}, autopilot: autopilot() };
    }
    else if (path === '/api/autopilot') result = autopilot();
    else if (path === '/api/github/build') result = build;
    else if (path === '/api/github/deployments') result = { repository: 'acme/beta', sha, deployments: [] };
    else if (path === '/api/github-actions') result = { workflows: [] };
    else if (path === '/api/gate') result = { repoPath, sha, stages: {}, production: null };
    else if (path === '/api/releases') result = { repoPath, sha, target: null, canDeploy: false, blockedReason: null, current: null, unresolved: null, recent: [] } satisfies ReleaseReply;
    else if (path === '/api/session') result = { token: 'fixture-token' };
    else if (path === '/api/pipeline/action') {
      if (++writes === 1) { status = 503; result = { error: 'Build preference could not be saved' }; }
      else { pipeline = applyPipelineAction(pipeline, route.request().postDataJSON()); result = { pipeline }; }
    }
    await route.fulfill({ json: result, status });
  });
  const refresh = async () => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/autopilot');
    await page.evaluate(async () => { const module = '/build/src/lib/pipeline-autopilot.ts'; (await import(module)).autopilotChanges.notify(); });
    await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  await page.goto(`${origin}/build/#pipeline`);
  const alert = page.getByRole('alert');
  const buildCard = page.getByRole('group', { name: 'Build', exact: true });
  await expect(buildCard.getByText('Failedbbbbbbb', { exact: true })).toBeVisible();
  await expect(alert).toContainText(reason);
  await expect(page.getByText('Fixing build', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  // An operation failure keeps its own retry ahead of the automatic poll error.
  await page.getByRole('button', { name: 'Collapse Build', exact: true }).click();
  await expect(alert).toContainText('Build preference could not be saved');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Build', exact: true })).toBeVisible();
  await expect(alert).toContainText(reason);
  // A clean poll clears the error; a later failure is shown and can be dismissed until it clears.
  watchError = undefined; await refresh();
  await expect(alert).toHaveCount(0);
  watchError = reason; await refresh();
  await expect(alert).toContainText(reason);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await refresh();
  await expect(alert).toHaveCount(0);
  watchError = undefined; await refresh();
  watchError = reason; await refresh();
  await expect(alert).toContainText(reason);
  await expect(buildCard.getByText('Failedbbbbbbb', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixing build', { exact: true })).toHaveCount(0);
  // Workspace and Autopilot polls own separate dismissals. Clearing either allows its next failure to show.
  sourceFailure = true;
  await expect(alert).toContainText('Workspace refresh failed');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(alert).toContainText(reason);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await (await page.waitForResponse(value => new URL(value.url()).pathname === '/api/state')).finished();
  await expect(alert).toHaveCount(0);
  sourceFailure = false;
  await (await page.waitForResponse(value => new URL(value.url()).pathname === '/api/state' && value.status() === 200)).finished();
  sourceFailure = true;
  await expect(alert).toContainText('Workspace refresh failed');
  await expect(buildCard.getByText('Failedbbbbbbb', { exact: true })).toBeVisible();
  assert.equal(writes, 2);
});
