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
async function fixture(t: TestContext, options: { disconnected?: boolean; noPipeline?: boolean; deletion?: 'fail-once' | 'conflict'; staleObservation?: boolean; productionFailure?: boolean; creationFailure?: boolean } = {}) {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors: string[] = [], posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state: State = initial(); if (options.disconnected) state.githubConnection = null;
  if (options.noPipeline) state.pipeline = null;
  let deletes = 0;
  const reads: string[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; if (req.method() === 'POST') posts.push(path);
    else reads.push(path);
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
    if (path === '/api/github/repositories') json = { repositories: ['app', 'other'].map(name => ({ fullName: `acme/${name}`, name, defaultBranch: 'main', private: true })), nextPage: null };
    if (path === '/api/github/branches') json = { branches: [{ name: 'main' }, { name: 'dev' }], nextPage: null, defaultBranch: 'main' };
    if (path === '/api/pipeline/action') {
      if (options.productionFailure) { status = 409; json = { error: 'Resolve the current deployment before changing the Production branch.' }; }
      else { state.pipeline = applyPipelineAction(state.pipeline, req.postDataJSON()); json = { pipeline: state.pipeline }; }
    }
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
    if (path === '/api/source/github') {
      const selection = req.postDataJSON(); assert.equal(selection.createPipeline, true);
      if (options.creationFailure) { status = 400; json = { error: 'Could not read this repository. Choose another repository or try again.' }; }
      else {
        state.source = { ...state.source, ...selection };
        state.scan.repo = { ...state.scan.repo, name: selection.repository.split('/')[1], remote: `https://github.com/${selection.repository}.git`, branch: selection.branch };
        state.pipeline = { ...defaultPipeline(repoPath), id: 'pipeline:12345678-1234-1234-1234-123456789abc', productionBranch: selection.branch };
        state.pipelineId = state.pipeline.id!; state.pipelineRemoval = null;
        json = { scan: state.scan, source: state.source, pipeline: state.pipeline, pipelineId: state.pipelineId };
      }
    }
    await route.fulfill({ status, json });
  });
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  await page.goto(`${origin}/build/`);
  return { page, state, errors, posts, reads };
}

test('Create pipeline asks a connected account to select its repository before creating', { timeout: 60000 }, async t => {
  const { page, state, posts, errors } = await fixture(t, { noPipeline: true });
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create pipeline', exact: true });
  await expect(form).toBeVisible(); await expect(page.getByRole('dialog', { name: 'Connect GitHub', exact: true })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Repository', exact: true })).toHaveText('Select repository');
  await expect(form.getByRole('button', { name: 'Create pipeline', exact: true })).toBeDisabled();
  assert.deepEqual(posts, []); assert.equal(structuredClone(state).pipeline, null);
  await form.getByRole('combobox', { name: 'Repository', exact: true }).click(); await page.getByRole('option', { name: 'acme/other' }).click();
  const productionBranch = form.getByRole('combobox', { name: 'Production branch', exact: true });
  await expect(productionBranch).toHaveText('main');
  await productionBranch.click(); await page.getByRole('option', { name: 'dev', exact: true }).click();
  await form.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(page.getByRole('link', { name: 'acme/other', exact: true })).toHaveAttribute('href', 'https://github.com/acme/other');
  assert.equal(state.source.repository, 'acme/other'); assert.equal(state.source.branch, 'dev'); assert.equal(state.pipeline?.productionBranch, 'dev');
  await expect(page.getByRole('combobox', { name: 'Production branch', exact: true })).toHaveText('dev');
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Production branch', exact: true })).toHaveText('dev');
  assert.deepEqual(posts, ['/api/source/github']); assert.deepEqual(errors, []);
});

test('Create pipeline connects GitHub first, continues to repository selection, and cancellation creates nothing', { timeout: 60000 }, async t => {
  const { page, state, posts, errors } = await fixture(t, { disconnected: true, noPipeline: true });
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Connect GitHub', exact: true })).toBeVisible();
  assert.deepEqual(posts, []);
  await page.getByRole('button', { name: 'Continue as developer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Connect GitHub', exact: true })).toHaveCount(0);
  const form = page.getByRole('dialog', { name: 'Create pipeline', exact: true });
  await expect(form).toBeVisible(); await expect(form.getByRole('combobox', { name: 'Repository', exact: true })).toHaveText('Select repository');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('No pipelines', { exact: true })).toBeVisible();
  assert.equal(structuredClone(state).pipeline, null); assert.deepEqual(posts, ['/api/github/connect']);
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await form.getByRole('combobox', { name: 'Repository', exact: true }).click(); await page.getByRole('option', { name: 'acme/app' }).click();
  await form.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open pipeline', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Production branch', exact: true })).toHaveText('main');
  assert.deepEqual(posts, ['/api/github/connect', '/api/source/github']); assert.deepEqual(errors, []);
});

test('failed creation retains repository selection and never leaves a partial pipeline', { timeout: 60000 }, async t => {
  const { page, state, errors } = await fixture(t, { noPipeline: true, creationFailure: true });
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create pipeline', exact: true });
  await form.getByRole('combobox', { name: 'Repository', exact: true }).click(); await page.getByRole('option', { name: 'acme/other' }).click();
  await form.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Could not read this repository');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(form.getByRole('combobox', { name: 'Repository', exact: true })).toHaveText('acme/other');
  assert.equal(structuredClone(state).pipeline, null); assert.equal(state.source.repository, 'acme/app');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('No pipelines', { exact: true })).toBeVisible(); assert.deepEqual(errors, []);
});

test('repository links to GitHub and the Production branch persists without switching the viewed branch', { timeout: 60000 }, async t => {
  const { page, state, errors, posts } = await fixture(t);
  const repository = page.getByRole('link', { name: 'acme/app', exact: true });
  await expect(repository).toHaveAttribute('href', 'https://github.com/acme/app');
  await expect(repository).toHaveAttribute('target', '_blank');
  const branch = page.getByRole('combobox', { name: 'Production branch', exact: true });
  await expect(branch).toHaveText('Not set');
  await branch.click();
  await page.getByRole('option', { name: 'dev', exact: true }).click();
  await expect(branch).toHaveText('dev');
  assert.equal(state.pipeline?.productionBranch, 'dev');
  assert.equal(state.scan.repo.branch, 'main'); assert.equal(state.source.branch, 'main');
  assert.deepEqual(posts, ['/api/pipeline/action']);
  await page.reload();
  await expect(branch).toHaveText('dev');
  assert.deepEqual(errors, []);
});

test('a failed Production branch save keeps its confirmed value and a disconnected source cannot change it', { timeout: 60000 }, async t => {
  const { page, state, errors } = await fixture(t, { productionFailure: true });
  const branch = page.getByRole('combobox', { name: 'Production branch', exact: true });
  await branch.click(); await page.getByRole('option', { name: 'dev', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Resolve the current deployment before changing the Production branch.');
  await expect(branch).toHaveText('Not set');
  assert.equal(state.pipeline?.productionBranch, undefined);
  state.githubConnection = null; await page.reload();
  await expect(branch).toBeDisabled();
  await expect(branch).toHaveText('Not set');
  assert.deepEqual(errors, []);
});

test('Project opens a Pipelines table without a sidebar submenu and the row opens the canvas', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toHaveText('Project');
  const table = page.getByRole('table', { name: 'Pipelines', exact: true });
  const heading = await table.getByRole('columnheader', { name: 'Repository', exact: true }).evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  const content = await table.getByRole('link', { name: 'acme/app', exact: true }).evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(Math.abs(heading - content) <= 1, 'Repository aligns with its column heading.');
  await expect(table.getByRole('columnheader', { name: 'Pipeline', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pipelines', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open pipeline', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toHaveText('ProjectPipeline');
  await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table.getByRole('link', { name: 'acme/app', exact: true })).toBeInViewport();
  await expect(table.getByRole('combobox', { name: 'Production branch', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Pipeline actions' })).toBeInViewport();
  const open = table.getByRole('button', { name: 'Open pipeline', exact: true });
  await expect(open).toBeInViewport(); await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('Disconnect closes Source and returns to the retained Disconnected pipeline; reconnect restores it', { timeout: 60000 }, async t => {
  const { page, state, errors } = await fixture(t);
  const original = structuredClone(state.pipeline);
  await page.getByRole('button', { name: 'Open pipeline', exact: true }).click();
  await page.getByRole('button', { name: 'Configure source', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  await expect(page.getByText('Disconnected', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.locator('.pipeline-inspector')).toHaveCount(0); assert.deepEqual(state.pipeline, original);
  await page.getByRole('button', { name: 'Reconnect GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as developer', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open pipeline', exact: true }).click();
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
  await expect(page.getByText('Deletion failed', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Sandbox cleanup failed');
  await page.getByRole('button', { name: 'Retry deletion' }).click();
  await expect(page.getByText('No pipelines', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('No pipelines', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  const creation = page.getByRole('dialog', { name: 'Create pipeline', exact: true });
  await creation.getByRole('combobox', { name: 'Repository', exact: true }).click(); await page.getByRole('option', { name: 'acme/app' }).click();
  await creation.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open pipeline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open pipeline', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Build', exact: true })).toBeVisible();
  await expect(page.getByText('Earlier pipeline observation', { exact: true })).toHaveCount(0);
  assert.equal(posts.filter(path => path === '/api/pipeline/remove').length, 2); assert.deepEqual(errors, []);
});

test('a running-work refusal stays in the confirmation without hiding the pipeline', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t, { deletion: 'conflict' });
  await page.getByRole('button', { name: 'Pipeline actions' }).click(); await page.getByRole('menuitem', { name: 'Delete pipeline' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete pipeline', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('Stop the browser run');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open pipeline', exact: true })).toBeVisible(); assert.deepEqual(errors, []);
});
