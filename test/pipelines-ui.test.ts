import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { createUiServer } from './fixtures/ui-server.ts';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';
import type { ConnectorsReply } from '../contract/connectors.ts';

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
async function fixture(t: TestContext, options: { disconnected?: boolean; noPipeline?: boolean; deletion?: 'fail-once' | 'conflict'; staleObservation?: boolean; productionFailure?: boolean; creationFailure?: boolean; connectionReadFailure?: boolean; disconnectFailure?: boolean; unreachable?: boolean; connectorFailure?: boolean } = {}) {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors: string[] = [], posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state: State = initial(); if (options.disconnected) state.githubConnection = null;
  if (options.noPipeline) state.pipeline = null;
  let deletes = 0, connectionReads = 0, disconnects = 0;
  const reads: string[] = [];
  const connectors: ConnectorsReply = { apps: [{ provider: 'slack', name: 'Slack', configured: true, account: null }, { provider: 'linear', name: 'Linear', configured: true, account: null }, { provider: 'gmail', name: 'Gmail', configured: true, account: null }, { provider: 'jira', name: 'Jira', configured: true, account: null }] };
  await page.route('**/assets/**/*.svg', route => route.fulfill({ path: fileURLToPath(new URL(`../public${new URL(route.request().url()).pathname}`, import.meta.url)) }));
  // Protocol UI fixtures never contact an external provider or claim a real authorization.
  await page.context().route('https://authorization.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>OAuth UI fixture</title>' }));
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; if (req.method() === 'POST') posts.push(path);
    else reads.push(path);
    let status = 200, json: unknown = {};
    if (path === '/api/session') json = { token: 'fixture-token' };
    if (path === '/api/connectors') json = connectors;
    if (path === '/api/connectors/start') {
      const app = connectors.apps.find(app => app.provider === req.postDataJSON().provider)!;
      assert.equal(app.configured, true);
      assert.deepEqual(req.postDataJSON(), { provider: app.provider });
      app.account = { status: 'pending', redirectUrl: `https://authorization.example.test/${app.provider}` }; json = connectors;
    }
    if (path === '/api/connectors/remove') {
      const app = connectors.apps.find(app => app.provider === req.postDataJSON().provider)!;
      assert.deepEqual(req.postDataJSON(), { provider: app.provider, cancel: app.account?.status === 'pending' });
      if (options.connectorFailure) { status = 503; json = { error: 'Could not disconnect this account. Try again.' }; }
      else { connectors.apps.find(app => app.provider === req.postDataJSON().provider)!.account = null; json = connectors; }
    }
    if (path === '/api/state') {
      if (state.pipelineRemoval?.status === 'removing') {
        if (options.deletion === 'fail-once' && deletes === 1) state.pipelineRemoval = { id: 'removal', status: 'failed', error: 'Sandbox cleanup failed. Retry deletion.' };
        else { state.pipelineRemoval = { id: 'removal', status: 'completed' }; state.pipeline = null; }
      }
      json = state;
    }
    const connection = () => ({ available: true, authenticated: true, account: { login: 'developer', name: null }, connected: Boolean(state.githubConnection), source: state.source });
    if (path === '/api/github/connection') {
      connectionReads++;
      json = options.unreachable ? { available: true, authenticated: false, account: null, connected: false, unreachable: true, message: 'GitHub is unreachable. Try again.', source: state.source } : connection();
      if (options.connectionReadFailure && connectionReads === 2) { status = 503; json = { error: 'GitHub did not answer. Try again.' }; }
    }
    if (path === '/api/github/repositories') json = { repositories: ['app', 'other'].map(name => ({ fullName: `acme/${name}`, name, defaultBranch: 'main', private: true })), nextPage: null };
    if (path === '/api/github/branches') json = { branches: [{ name: 'main' }, { name: 'dev' }], nextPage: null, defaultBranch: 'main' };
    if (path === '/api/pipeline/action') {
      if (options.productionFailure) { status = 409; json = { error: 'Resolve the current deployment before changing the Production branch.' }; }
      else { state.pipeline = applyPipelineAction(state.pipeline, req.postDataJSON()); json = { pipeline: state.pipeline }; }
    }
    if (path === '/api/github/disconnect') {
      disconnects++;
      if (options.disconnectFailure && disconnects === 1) { status = 409; json = { error: 'Wait for the source change to finish.' }; }
      else { state.githubConnection = null; json = connection(); }
    }
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
  return { page, state, errors, posts, reads, connectors };
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
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toHaveText('Project');
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
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toHaveText('Projectapp');
  await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
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

test('Connectors manages the shared GitHub account without selecting a repository or creating a pipeline', { timeout: 60000 }, async t => {
  const { page, state, posts, errors } = await fixture(t);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Connectors', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toHaveText('Connectors');
  await expect(navigation.getByRole('button', { name: 'Project', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('button', { name: 'Connectors', exact: true })).toHaveAttribute('aria-current', 'page');
  const app = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem');
  await expect(app).toContainText('GitHubConnecteddeveloper');
  await page.getByRole('searchbox', { name: 'Search connected apps' }).fill('missing');
  await expect(page.getByText('No matching apps', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search connected apps' }).fill('developer');
  await expect(app.getByRole('button', { name: 'Refresh GitHub' })).toHaveCount(0);
  await app.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Check connection' }).click();
  await app.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect GitHub?' });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(posts, []);
  await app.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No apps connected', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#connectors$/);
  assert.ok(state.pipeline); assert.equal(state.source.repository, 'acme/app');
  assert.equal(state.githubConnection, null);
  await page.getByRole('button', { name: 'Connect app', exact: true }).first().click();
  const picker = page.getByRole('dialog', { name: 'Available apps', exact: true });
  await picker.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  const connect = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
  await connect.getByRole('button', { name: 'Continue as developer', exact: true }).click();
  await expect(connect).toHaveCount(0);
  await expect(app).toContainText('GitHubConnecteddeveloper');
  await expect(page.getByRole('dialog', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#connectors$/);
  assert.deepEqual(posts, ['/api/github/disconnect', '/api/github/connect']);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await navigation.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toContainText('Connected');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  await page.reload();
  await expect(app).toContainText('GitHubConnecteddeveloper');
  assert.deepEqual(errors, []);
});

test('Connectors preserves the account on read and disconnect failures, with explicit recovery', { timeout: 60000 }, async t => {
  const { page, state, errors } = await fixture(t, { connectionReadFailure: true, disconnectFailure: true });
  await page.goto(new URL('#connectors', page.url()).href);
  const app = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem');
  await expect(app).toContainText('Connected');
  await app.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Check connection' }).click();
  await expect(page.getByRole('alert')).toHaveText('GitHub did not answer. Try again.');
  await expect(app).toContainText('Unverified');
  assert.ok(state.githubConnection);
  await app.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(app).toContainText('Connected');
  await app.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect GitHub?' });
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(confirm.getByRole('alert')).toHaveText('Wait for the source change to finish.');
  assert.ok(state.githubConnection); assert.ok(state.pipeline);
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No apps connected' })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('Connectors keeps an unreachable account unverified instead of claiming it disconnected', { timeout: 60000 }, async t => {
  const { page, posts, errors } = await fixture(t, { unreachable: true });
  await page.goto(new URL('#connectors', page.url()).href);
  await expect(page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem')).toContainText('GitHubUnverified');
  await expect(page.getByRole('alert')).toHaveText('GitHub is unreachable. Try again.');
  await expect(page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No apps connected' })).toHaveCount(0);
  assert.deepEqual(posts, []); assert.deepEqual(errors, []);
});

test('direct connectors support provider sign-in, verification and confirmed account removal', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t);
  await page.goto(page.url() + '#connectors');
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Available apps' });
  for (const name of ['Slack', 'Linear', 'Gmail', 'Jira']) await expect(picker.getByRole('button', { name: `Connect ${name}`, exact: true })).toBeVisible();
  await expect.poll(() => picker.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  await picker.getByRole('searchbox', { name: 'Search available apps' }).fill('gmail');
  await expect(picker.getByRole('button', { name: 'Connect Slack' })).toHaveCount(0);
  const opened = page.waitForEvent('popup');
  await picker.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  const popup = await opened;
  await expect(popup).toHaveURL('https://authorization.example.test/gmail'); await popup.close();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Awaiting sign-in', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveAttribute('href', 'https://authorization.example.test/gmail');
  connectors.apps.find(app => app.provider === 'gmail')!.account = { status: 'connected', label: 'developer@example.test' };
  const refresh = page.waitForRequest('**/api/connectors?refresh=gmail');
  await page.getByRole('button', { name: 'Gmail actions' }).click(); await page.getByRole('menuitem', { name: 'Check connection' }).click(); await refresh;
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveCount(0);
  await page.reload(); await expect(page.getByText('developer@example.test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Gmail actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('alertdialog'); await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(connectors.apps.find(app => app.provider === 'gmail')!.account);
  await page.getByRole('button', { name: 'Gmail actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click(); await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => connectors.apps.find(app => app.provider === 'gmail')!.account).toBeNull(); await expect(page.getByRole('button', { name: 'Gmail actions' })).toHaveCount(0);
  assert.deepEqual(posts, ['/api/connectors/start', '/api/connectors/remove']); assert.deepEqual(errors, []);
});

test('missing provider configuration shows Setup required without asking for an API key', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t);
  const jira = connectors.apps.find(app => app.provider === 'jira')!;
  jira.configured = false; jira.setupError = 'Jira sign-in is not configured on this installation.';
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Available apps', exact: true });
  await expect(picker.getByText('Setup required', { exact: true })).toHaveCount(1);
  await expect(picker.getByRole('button', { name: 'Connect Linear', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: 'Connect Jira', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Jira', exact: true });
  await expect(dialog.getByText('Setup required', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(jira.setupError);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/API key/i)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect app', exact: true })).toBeFocused();
  assert.deepEqual(posts, []); assert.deepEqual(errors, []);
});

test('pending direct authorization can be cancelled without disconnecting another service', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  const opened = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Connect Linear', exact: true }).click();
  const popup = await opened; await expect(popup).toHaveURL('https://authorization.example.test/linear'); await popup.close();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  await page.getByRole('button', { name: 'Linear actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Linear actions', exact: true })).toHaveCount(0);
  assert.equal(connectors.apps.find(app => app.provider === 'linear')!.account, null);
  assert.equal(connectors.apps.find(app => app.provider === 'slack')!.account?.status, 'connected');
  assert.deepEqual(posts, ['/api/connectors/start', '/api/connectors/remove']); assert.deepEqual(errors, []);
});

test('failed direct disconnect preserves the saved account and offers retry', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t, { connectorFailure: true });
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Slack actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect Slack?', exact: true });
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(confirm.getByRole('alert')).toHaveText('Could not disconnect this account. Try again.');
  await expect(confirm.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
  assert.equal(connectors.apps.find(app => app.provider === 'slack')!.account?.status, 'connected');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Slack actions' })).toBeVisible(); assert.deepEqual(errors, []);
});

test('direct sign-in errors can retry provider authorization without extra configuration', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t);
  let starts = 0;
  await page.route('**/api/connectors/start', async route => {
    starts++;
    if (starts === 1) await route.fulfill({ status: 503, json: { error: 'Could not start Linear sign-in. Try again.' } });
    else await route.fallback();
  });
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Linear', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Linear', exact: true });
  await expect(auth.getByRole('alert')).toHaveText('Could not start Linear sign-in. Try again.');
  await expect(auth.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(auth.getByRole('textbox')).toHaveCount(0);
  assert.equal(connectors.apps.find(app => app.provider === 'linear')!.account, null);
  const opened = page.waitForEvent('popup'); await auth.getByRole('button', { name: 'Try again', exact: true }).click();
  const popup = await opened; await expect(popup).toHaveURL('https://authorization.example.test/linear'); await popup.close();
  await expect(auth).toHaveCount(0); await expect(page.getByText('Awaiting sign-in', { exact: true })).toBeVisible();
  assert.equal(starts, 2); assert.deepEqual(errors, []);
});

test('an expired account restarts direct provider sign-in in one action', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'gmail')!.account = { status: 'needs-auth' };
  await page.goto(page.url() + '#connectors');
  const opened = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
  const popup = await opened; await expect(popup).toHaveURL('https://authorization.example.test/gmail'); await popup.close();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  assert.deepEqual(posts, ['/api/connectors/start']); assert.deepEqual(errors, []);
});

test('Connectors first list waits for the local account snapshot and GitHub before revealing rows', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/api/connectors?cached=1', async route => { await held; await route.fulfill({ json: connectors }); });
  const githubFinished = page.waitForResponse('**/api/github/connection');
  await page.goto(page.url() + '#connectors');
  await (await githubFinished).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('status', { name: 'Loading connectors', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Connected apps', exact: true })).toHaveCount(0);
  release();
  const rows = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem');
  await expect(rows).toHaveCount(2); await expect(rows.nth(0)).toContainText('GitHub'); await expect(rows.nth(1)).toContainText('Slack');
});

test('Connectors does not repeatedly poll an unverified account', { timeout: 60000 }, async t => {
  const { page, connectors, reads } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'unverified', error: 'This connection was removed. Reconnect.' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'needs-auth' };
  await page.clock.install(); const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  const slack = page.getByRole('listitem').filter({ hasText: 'Slack' });
  await expect(slack.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(slack.getByRole('button', { name: 'Sign in again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  const retry = page.waitForRequest('**/api/connectors?refresh=slack');
  await slack.getByRole('button', { name: 'Try again', exact: true }).click(); await retry;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(reads.filter(path => path === '/api/connectors/start').length, 0, 'A verification retry must not start a new authorization');
  const before = reads.filter(path => path === '/api/connectors').length;
  await page.clock.runFor(15000);
  assert.equal(reads.filter(path => path === '/api/connectors').length, before, 'Unverified accounts require explicit recovery, not repeated polling');
});

test('Connectors keeps the first list loading when GitHub is the slower source', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/api/github/connection', async route => { await held; await route.fallback(); });
  const accountsFinished = page.waitForResponse('**/api/connectors?cached=1');
  await page.goto(page.url() + '#connectors'); await (await accountsFinished).finished();
  await expect(page.getByRole('status', { name: 'Loading connectors', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Connected apps', exact: true })).toHaveCount(0);
  release();
  const rows = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem');
  await expect(rows).toHaveCount(2); await expect(rows.nth(0)).toContainText('GitHub'); await expect(rows.nth(1)).toContainText('Slack');
});

test('Connectors checks GitHub quietly on focus and shares that read with manual refresh', { timeout: 60000 }, async t => {
  const { page } = await fixture(t);
  await page.goto(page.url() + '#connectors');
  const githubRow = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem').filter({ hasText: 'GitHub' });
  await expect(githubRow).toBeVisible();
  await expect(githubRow.getByRole('button', { name: 'Refresh GitHub', exact: true })).toHaveCount(0);
  let release!: () => void, received!: () => void, heldReads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/github/connection', async route => { heldReads++; received(); await held; await route.fallback(); });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await started;
  await expect(githubRow.getByRole('button', { name: 'GitHub actions' })).toBeEnabled();
  await githubRow.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Check connection' }).click();
  await expect(githubRow.getByRole('button', { name: 'GitHub actions' })).toBeDisabled();
  assert.equal(heldReads, 1, 'Focus, visibility and manual refresh should share a GitHub read');
  release(); await expect(githubRow.getByRole('button', { name: 'GitHub actions' })).toBeEnabled();
});

test('a manual GitHub check shows Checking when it joins a quiet read and confirms only after success', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.goto(page.url() + '#connectors');
  const githubRow = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem').filter({ hasText: 'GitHub' });
  await expect(githubRow).toBeVisible();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/github/connection', async route => { received(); await held; await route.fallback(); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started;
  await githubRow.getByRole('button', { name: 'GitHub actions' }).click();
  await page.getByRole('menuitem', { name: 'Check connection' }).click();
  await expect(githubRow.getByText('Checking', { exact: true })).toBeVisible();
  await expect(githubRow.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  release();
  await expect(githubRow.getByRole('status').filter({ hasText: 'Connection verified' })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('a manual Linear check marks only its row and confirms after the selected provider succeeds', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'connected' };
  const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  const apps = page.getByRole('list', { name: 'Connected apps', exact: true });
  const linear = apps.getByRole('listitem').filter({ hasText: 'Linear' }), slack = apps.getByRole('listitem').filter({ hasText: 'Slack' });
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/connectors?refresh=linear', async route => { received(); await held; await route.fallback(); });
  await linear.getByRole('button', { name: 'Linear actions' }).click();
  const response = page.waitForResponse('**/api/connectors?refresh=linear');
  await page.getByRole('menuitem', { name: 'Check connection' }).click(); await started;
  await expect(linear.getByText('Checking', { exact: true })).toBeVisible();
  await expect(slack.getByText('Checking', { exact: true })).toHaveCount(0);
  await expect(linear.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  await expect(slack.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  release(); await (await response).finished();
  await expect(linear.getByRole('status').filter({ hasText: 'Connection verified' })).toBeVisible();
  await expect(slack.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test('quiet focus and pending-sign-in checks never announce Connection verified', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'pending', redirectUrl: 'https://authorization.example.test/linear' };
  const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.clock.install();
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  await expect(page.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(5000);
  await expect(page.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
});

for (const status of ['unverified', 'needs-auth'] as const) test(`a successful HTTP response with ${status} account state never confirms the connection`, { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'connected' };
  const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  const linear = page.getByRole('list', { name: 'Connected apps', exact: true }).getByRole('listitem').filter({ hasText: 'Linear' });
  await page.route('**/api/connectors?refresh=linear', async route => {
    connectors.apps.find(app => app.provider === 'linear')!.account = { status, ...(status === 'unverified' ? { error: 'Provider verification failed.' } : {}) };
    await route.fulfill({ status: 200, json: connectors });
  });
  const reply = page.waitForResponse('**/api/connectors?refresh=linear');
  await linear.getByRole('button', { name: 'Linear actions' }).click();
  await page.getByRole('menuitem', { name: 'Check connection' }).click();
  assert.equal((await reply).status(), 200);
  await expect(linear.getByText(status === 'unverified' ? 'Unverified' : 'Sign-in required', { exact: true })).toBeVisible();
  await expect(linear.getByRole('status').filter({ hasText: 'Connection verified' })).toHaveCount(0);
  if (status === 'needs-auth') await expect(linear.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  else await expect(linear.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('Connectors polls pending sign-in quietly and disables duplicate checks while refreshing', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'pending', redirectUrl: 'https://authorization.example.test/slack' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'connected' };
  await page.clock.install(); const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  const slack = page.getByRole('button', { name: 'Slack actions', exact: true });
  const linear = page.getByRole('button', { name: 'Linear actions', exact: true });
  await expect(slack).toBeEnabled(); await expect(page.getByRole('button', { name: 'Refresh Slack', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  let heldReads = 0;
  await page.route('**/api/connectors?refresh=all', async route => { heldReads++; received(); await held; await route.fulfill({ json: connectors }); });
  await page.clock.runFor(5000); await started;
  await expect(slack).toBeEnabled(); await expect(linear).toBeEnabled();
  await slack.click(); await page.getByRole('menuitem', { name: 'Check connection' }).click();
  assert.equal(heldReads, 1, 'The manual connection check should share the held pending-sign-in poll');
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  release();
  await expect(slack).toBeEnabled(); await expect(linear).toBeEnabled(); await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected');
});

for (const operation of ['start', 'remove'] as const) test(`Connectors reconciles a failed ${operation} without animating row actions`, { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'connected' };
  const initialCheck = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  // The recovery dialog hides the background rows from the accessibility tree.
  const slack = page.locator('button[aria-label="Slack actions"]');
  const linear = page.locator('button[aria-label="Linear actions"]');
  await expect(slack).toBeEnabled();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/connectors', async route => { received(); await held; await route.fulfill({ json: connectors }); });
  await page.route(`**/api/connectors/${operation}`, route => route.fulfill({ status: 503, json: { error: 'Could not complete sign-in. Try again.' } }));
  if (operation === 'start') {
    await page.getByRole('button', { name: 'Connect app', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Slack actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Disconnect Slack?', exact: true }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  }
  await started;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await slack.isEnabled(), true); assert.equal(await linear.isEnabled(), true);
  await expect(slack.locator('.motion-safe\\:animate-spin')).toHaveCount(0);
  await expect(linear.locator('.motion-safe\\:animate-spin')).toHaveCount(0);
  release();
});

test('Connectors displays bound accounts while remote verification is still pending', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'unverified', checking: true };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/api/connectors?refresh=all', async route => { await held; await route.fulfill({ json: connectors }); });
  await page.goto(page.url() + '#connectors');
  const row = page.getByRole('listitem').filter({ hasText: 'Slack' });
  await expect(row).toBeVisible({ timeout: 1500 }); await expect(row).toContainText('Checking');
  await expect(page.getByRole('button', { name: 'Refresh Slack', exact: true })).toHaveCount(0);
  connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  release(); await expect(row).toContainText('Connected'); await expect(row).not.toContainText('Checking');
});


test('Connectors immediately restores recent rows while returning-page requests are pending', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t);
  connectors.apps[0].account = { status: 'connected' };
  const checked = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(new URL('#connectors', page.url()).href); await (await checked).finished();
  await expect(page.getByRole('button', { name: 'Slack actions', exact: true })).toBeVisible();
  await page.goto(new URL('#pipelines', page.url()).href);
  await expect(page.getByRole('table', { name: 'Pipelines', exact: true })).toBeVisible();
  const waiting = Promise.withResolvers<void>(); t.after(() => waiting.resolve());
  await page.route('**/api/connectors*', async route => { await waiting.promise; await route.fallback(); });
  await page.route('**/api/github/connection', async route => { await waiting.promise; await route.fallback(); });
  await page.goto(new URL('#connectors', page.url()).href);
  await expect(page.getByRole('button', { name: 'Slack actions', exact: true })).toBeVisible({ timeout: 500 });
  await expect(page.getByRole('button', { name: 'GitHub actions', exact: true })).toBeVisible({ timeout: 500 });
  await expect(page.getByRole('status', { name: 'Loading connectors', exact: true })).toHaveCount(0);
  const forced = page.waitForRequest('**/api/connectors?refresh=slack');
  await page.getByRole('button', { name: 'Slack actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Check connection' }).click(); await forced;
  connectors.apps[0].account = null; waiting.resolve();
  await expect(page.getByRole('button', { name: 'Slack actions', exact: true })).toHaveCount(0);
  await page.goto(new URL('#pipelines', page.url()).href); await page.goto(new URL('#connectors', page.url()).href);
  await expect(page.getByRole('button', { name: 'GitHub actions', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Slack actions', exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test('a manual provider refresh bypasses an ordinary read and ignores its late stale reply', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t);
  connectors.apps[0].account = { status: 'unverified', error: 'Check this connection.' };
  const checked = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(new URL('#connectors', page.url()).href); await (await checked).finished();
  const stale = structuredClone(connectors), waiting = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  t.after(() => waiting.resolve());
  await page.route('**/api/connectors', async route => { started.resolve(); await waiting.promise; await route.fulfill({ json: stale }); });
  const oldReply = page.waitForResponse('**/api/connectors');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await started.promise;
  connectors.apps[0].account = { status: 'needs-auth' };
  const forced = page.waitForRequest('**/api/connectors?refresh=slack');
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await forced;
  const row = page.getByRole('listitem').filter({ hasText: 'Slack' });
  await expect(row).toContainText('Sign-in required');
  waiting.resolve(); await (await oldReply).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(row).toContainText('Sign-in required'); assert.deepEqual(errors, []);
});

test('different manual provider refreshes escalate to a shared full check', { timeout: 60000 }, async t => {
  const { page, connectors, errors } = await fixture(t);
  connectors.apps[0].account = { status: 'connected' }; connectors.apps[1].account = { status: 'connected' };
  const checked = page.waitForResponse('**/api/connectors?refresh=all');
  await page.goto(new URL('#connectors', page.url()).href); await (await checked).finished();
  const waiting = Promise.withResolvers<void>(); t.after(() => waiting.resolve());
  await page.route('**/api/connectors?refresh=slack', async route => { await waiting.promise; await route.fallback(); });
  const slack = page.waitForRequest('**/api/connectors?refresh=slack');
  await page.getByRole('button', { name: 'Slack actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Check connection' }).click(); await slack;
  const full = page.waitForRequest('**/api/connectors?refresh=all');
  await page.getByRole('button', { name: 'Linear actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Check connection' }).click(); await full;
  await expect(page.getByRole('button', { name: 'Slack actions', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Linear actions', exact: true })).toBeEnabled();
  waiting.resolve(); assert.deepEqual(errors, []);
});
