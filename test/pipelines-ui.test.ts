import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { createUiServer } from './fixtures/ui-server.ts';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';

const expect = playwrightExpect.configure({ timeout: 10000 }), repoPath = '/acme/app';
const initial = () => ({
  defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha: 'a'.repeat(40), remote: 'https://github.com/acme/app.git' }, delivery: { source: [], build: [], production: [] } },
  source: { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: repoPath, checkoutPath: repoPath, connectedAccount: 'developer' },
  pipeline: applyPipelineAction(defaultPipeline(repoPath), { action: 'add-stage', name: 'Beta' }), pipelineId: 'github:acme/app:/',
  githubConnection: { login: 'developer', connectedAt: '2026-10-06T12:00:00Z' }, pipelineRemoval: null as null | { id: string; status: string; error?: string },
  environments: [], browserTests: {}, stageRemovals: [],
  autopilot: { repoPath, stages: {} },
});
type State = Omit<ReturnType<typeof initial>, 'pipeline' | 'githubConnection'> & { pipeline: ReturnType<typeof defaultPipeline> | null; githubConnection: ReturnType<typeof initial>['githubConnection'] | null };
async function fixture(t: TestContext, options: { disconnected?: boolean; deletion?: 'fail-once' | 'conflict'; staleObservation?: boolean } = {}) {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors: string[] = [], posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state: State = initial(); if (options.disconnected) state.githubConnection = null;
  let deletes = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; if (req.method() === 'POST') posts.push(path);
    let status = 200, json: unknown = {};
    if (path === '/api/session') json = { token: 'fixture-token' };
    if (path === '/api/state') {
      if (state.pipelineRemoval?.status === 'removing') {
        if (options.deletion === 'fail-once' && deletes === 1) state.pipelineRemoval = { id: 'removal', status: 'failed', error: 'Sandbox cleanup failed. Retry deletion.' };
        else { state.pipelineRemoval = { id: 'removal', status: 'completed' }; state.pipeline = null; }
      }
      json = state;
    }
    const connection = () => ({ available: true, authenticated: true, account: { login: 'developer', name: null }, connected: Boolean(state.githubConnection), source: state.source });
    if (path === '/api/github/connection') json = connection();
    if (path === '/api/github/repositories') json = { repositories: [{ fullName: 'acme/app', name: 'app', owner: 'acme', defaultBranch: 'main', private: true }], hasMore: false };
    if (path === '/api/github/branches') json = { branches: [{ name: 'main' }], hasMore: false };
    if (path === '/api/github/disconnect') { state.githubConnection = null; json = connection(); }
    if (path === '/api/github/connect') { state.githubConnection = { login: 'developer', connectedAt: '2026-10-06T12:00:00Z' }; json = connection(); }
    if (path === '/api/gate') json = { repoPath, sha: state.scan.repo.sha, stages: {}, production: null };
    if (path === '/api/releases') json = { repoPath, sha: state.scan.repo.sha, target: null, canDeploy: false, current: null, unresolved: null, recent: [] };
    if (path === '/api/autopilot') json = { repoPath, stages: {}, ...(options.staleObservation && !state.pipeline?.id ? { watchError: 'Earlier pipeline observation' } : {}) };
    if (path === '/api/twin/services') json = { services: [] };
    if (path === '/api/pipeline/remove') {
      assert.equal(req.postDataJSON().pipelineId, state.pipelineId);
      deletes++;
      if (options.deletion === 'conflict') { status = 409; json = { error: 'Stop the browser run before deleting the pipeline.' }; }
      else { status = 202; state.pipelineRemoval = { id: 'removal', status: 'removing' }; json = { removal: state.pipelineRemoval }; }
    }
    if (path === '/api/pipeline/create') { state.pipeline = defaultPipeline(repoPath); state.pipeline.id = 'pipeline:12345678-1234-1234-1234-123456789abc'; state.pipelineId = state.pipeline.id; json = { pipeline: state.pipeline }; }
    await route.fulfill({ status, json });
  });
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  await page.goto(`${origin}/build/`);
  return { page, state, errors, posts };
}

test('Project opens a Pipelines table without a sidebar submenu and the row opens the canvas', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pipelines', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pipelines', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Pipeline actions' })).toBeInViewport();
  assert.deepEqual(errors, []);
});

test('Disconnect closes Source and returns to the retained Disconnected pipeline; reconnect restores it', { timeout: 60000 }, async t => {
  const { page, state, errors } = await fixture(t);
  const original = structuredClone(state.pipeline);
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  await page.getByRole('button', { name: 'Configure source', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(page.locator('.pipeline-inspector')).toHaveCount(0); assert.deepEqual(state.pipeline, original);
  await page.getByRole('button', { name: 'Reconnect GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as developer', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Beta', exact: true })).toBeVisible(); assert.deepEqual(state.pipeline, original); assert.deepEqual(errors, []);
});

test('Delete pipeline confirms once, retains a failed row for Retry and recreates only explicitly', { timeout: 60000 }, async t => {
  const { page, posts, errors } = await fixture(t, { deletion: 'fail-once', staleObservation: true });
  const openRemoval = async () => { await page.getByRole('button', { name: 'Pipeline actions' }).click(); await page.getByRole('menuitem', { name: 'Delete pipeline' }).click(); };
  await page.getByRole('button', { name: 'Pipeline actions' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Delete pipeline' })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pipeline actions' })).toBeFocused(); assert.equal(posts.includes('/api/pipeline/remove'), false);
  await openRemoval(); await page.getByRole('alertdialog').getByRole('button', { name: 'Delete pipeline', exact: true }).click();
  await expect(page.getByText('Deletion failed', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Sandbox cleanup failed');
  await page.getByRole('button', { name: 'Retry deletion' }).click();
  await expect(page.getByText('No pipelines', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('No pipelines', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByRole('button', { name: 'Delivery', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toBeVisible();
  await expect(page.getByText('Earlier pipeline observation', { exact: true })).toHaveCount(0);
  assert.equal(posts.filter(path => path === '/api/pipeline/remove').length, 2); assert.deepEqual(errors, []);
});

test('a running-work refusal stays in the confirmation without hiding the pipeline', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t, { deletion: 'conflict' });
  await page.getByRole('button', { name: 'Pipeline actions' }).click(); await page.getByRole('menuitem', { name: 'Delete pipeline' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete pipeline', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('Stop the browser run');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('button', { name: 'Delivery', exact: true })).toBeVisible(); assert.deepEqual(errors, []);
});
