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
async function fixture(t: TestContext, options: { disconnected?: boolean; noPipeline?: boolean; deletion?: 'fail-once' | 'conflict'; staleObservation?: boolean; productionFailure?: boolean; creationFailure?: boolean; connectionReadFailure?: boolean; disconnectFailure?: boolean; unreachable?: boolean; connectorFailure?: boolean; emptyConnectorConfigs?: boolean; browserConnector?: boolean; multipleAccounts?: boolean; browserOptionsFailure?: boolean } = {}) {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors: string[] = [], posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state: State = initial(); if (options.disconnected) state.githubConnection = null;
  if (options.noPipeline) state.pipeline = null;
  let deletes = 0, connectionReads = 0, disconnects = 0;
  const reads: string[] = [];
  const connectors: ConnectorsReply = { configured: false, ...(options.browserConnector ? { method: 'browser' as const } : {}), apps: [{ provider: 'slack', name: 'Slack' }, { provider: 'linear', name: 'Linear' }, { provider: 'gmail', name: 'Gmail' }, { provider: 'jira', name: 'Jira' }].map(app => ({ ...app, account: null })) as ConnectorsReply['apps'] };
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; if (req.method() === 'POST') posts.push(path);
    else reads.push(path);
    let status = 200, json: unknown = {};
    if (path === '/api/session') json = { token: 'fixture-token' };
    if (path === '/api/connectors') json = connectors;
    if (path === '/api/connectors/setup') {
      assert.equal(req.postDataJSON().apiKey, 'fixture-key'); connectors.configured = true; json = connectors;
    }
    if (path === '/api/connectors/options') json = { configs: options.emptyConnectorConfigs ? [] : [{ id: 'ac_example', name: 'Example OAuth' }], accounts: options.multipleAccounts ? [{ id: 'ca_work', name: 'Work' }, { id: 'ca_personal', name: 'Personal' }] : [] };
    if (path === '/api/connectors/options' && options.browserOptionsFailure) { status = 503; json = { error: 'Could not read Composio connections. Sign in again or try Refresh.' }; }
    if (path === '/api/connectors/start') {
      if (options.emptyConnectorConfigs) assert.equal(req.postDataJSON().configId, undefined);
      const app = connectors.apps.find(app => app.provider === req.postDataJSON().provider)!;
      if (options.multipleAccounts) assert.equal(req.postDataJSON().accountId, 'ca_work');
      if (options.browserConnector || app.account?.method === 'browser') assert.equal(req.postDataJSON().configId, undefined);
      app.account = { ...(options.browserConnector ? { method: 'browser' as const } : {}), status: 'pending', redirectUrl: 'https://connect.composio.dev/link/ln_example' }; json = connectors;
    }
    if (path === '/api/connectors/remove') {
      if (options.connectorFailure) { status = 503; json = { error: 'Composio could not complete the request. Try again.' }; }
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
  await app.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(app.getByRole('button', { name: 'Refresh GitHub' })).toBeEnabled();
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
  await app.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(page.getByRole('alert')).toHaveText('GitHub did not answer. Try again.');
  await expect(app).toContainText('Unverified');
  assert.ok(state.githubConnection);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
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
  await expect(page.getByRole('heading', { name: 'No apps connected' })).toHaveCount(0);
  assert.deepEqual(posts, []); assert.deepEqual(errors, []);
});

test('four app connectors offer real setup, pending authorization, refresh and confirmed account removal', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t);
  await page.goto(page.url() + '#connectors');
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Available apps' });
  for (const name of ['Slack', 'Linear', 'Gmail', 'Jira']) await expect(picker.getByRole('button', { name: `Connect ${name}`, exact: true })).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search available apps' }).fill('gmail');
  await expect(picker.getByRole('button', { name: 'Connect Slack' })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Project API Key', exact: true });
  await expect(setup).toBeVisible(); await expect(setup.getByLabel('Composio Project API Key')).toHaveAttribute('type', 'password');
  await expect(setup.getByText('Platform → your project → API Keys', { exact: true })).toBeVisible();
  await setup.getByLabel('Composio Project API Key').fill('fixture-key'); await setup.getByRole('button', { name: 'Save', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Gmail', exact: true });
  await expect(auth.getByRole('button', { name: 'Sign in with Gmail' })).toBeEnabled();
  const popup = page.waitForEvent('popup'); await auth.getByRole('button', { name: 'Sign in with Gmail' }).click(); await (await popup).close();
  await expect(auth).toHaveCount(0); await expect(page.getByText('Awaiting sign-in', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveAttribute('href', 'https://connect.composio.dev/link/ln_example');
  connectors.apps.find(app => app.provider === 'gmail')!.account = { status: 'connected' };
  await page.getByRole('button', { name: 'Refresh Gmail' }).click();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('button', { name: 'Gmail actions' })).toBeVisible();
  await page.getByRole('button', { name: 'Gmail actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('alertdialog'); await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(connectors.apps.find(app => app.provider === 'gmail')!.account);
  await page.getByRole('button', { name: 'Gmail actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click(); await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => connectors.apps.find(app => app.provider === 'gmail')!.account).toBeNull(); await expect(page.getByRole('button', { name: 'Gmail actions' })).toHaveCount(0);
  assert.ok(!posts.includes('/api/source/github')); assert.deepEqual(errors, []);
});

test('connector authorization cancellation and failed disconnect preserve their actual account state', { timeout: 60000 }, async t => {
  const { page, connectors, errors, posts } = await fixture(t, { connectorFailure: true });
  connectors.configured = true; connectors.apps.find(app => app.provider === 'slack')!.account = { status: 'connected' };
  await page.goto(page.url() + '#connectors'); await expect(page.getByRole('button', { name: 'Slack actions' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect app', exact: true }).click(); await page.getByRole('button', { name: 'Connect Jira', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Jira' })).toBeVisible(); await page.getByRole('dialog', { name: 'Connect Jira' }).getByRole('button', { name: 'Close' }).click();
  assert.equal(connectors.apps.find(app => app.provider === 'jira')!.account, null); assert.ok(!posts.includes('/api/connectors/start'));
  await page.getByRole('button', { name: 'Slack actions' }).click(); await page.getByRole('menuitem', { name: 'Disconnect' }).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toHaveText('Composio could not complete the request. Try again.');
  assert.equal(connectors.apps.find(app => app.provider === 'slack')!.account?.status, 'connected');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click(); await expect(page.getByRole('button', { name: 'Slack actions' })).toBeVisible(); assert.deepEqual(errors, []);
});

test('a configured fresh project can sign in to Linear without manual OAuth setup', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t, { emptyConnectorConfigs: true });
  connectors.configured = true;
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Linear', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Linear', exact: true });
  await expect(auth.getByRole('button', { name: 'Sign in with Linear' })).toBeEnabled();
  await expect(auth.getByRole('alert')).toHaveCount(0);
  assert.ok(!posts.includes('/api/connectors/start'));
  const popup = page.waitForEvent('popup');
  await auth.getByRole('button', { name: 'Sign in with Linear' }).click(); await (await popup).close();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  assert.equal(posts.filter(path => path === '/api/connectors/start').length, 1);
  assert.deepEqual(errors, []);
});


test('browser connection opens authorization from Connect with no project key setup', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t, { browserConnector: true });
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Slack', exact: true }).click();
  const popup = await opened;
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  await popup.close();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Composio Project API Key')).toHaveCount(0);
  assert.equal(connectors.configured, false);
  assert.equal(posts.filter(path => path === '/api/connectors/start').length, 1);
  assert.ok(!posts.includes('/api/connectors/setup')); assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Project API Key…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Project API Key', exact: true })).toBeVisible();
});

test('browser connection asks only when several actual accounts need a choice', { timeout: 60000 }, async t => {
  const { page, posts, errors } = await fixture(t, { browserConnector: true, multipleAccounts: true });
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Gmail', exact: true });
  await expect(auth.getByLabel('Account')).toBeVisible();
  assert.ok(!posts.includes('/api/connectors/start'));
  await auth.getByLabel('Account').click(); await page.getByRole('option', { name: 'Work', exact: true }).click();
  const opened = page.waitForEvent('popup'); await auth.getByRole('button', { name: 'Sign in with Gmail', exact: true }).click(); await (await opened).close();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  assert.equal(posts.filter(path => path === '/api/connectors/start').length, 1); assert.deepEqual(errors, []);
});


test('browser-owned recovery keeps account selection and consumer help after a project-mode switch', { timeout: 60000 }, async t => {
  const { page, connectors, posts, errors } = await fixture(t, { multipleAccounts: true });
  connectors.method = 'project'; connectors.configured = true;
  connectors.apps.find(app => app.provider === 'gmail')!.account = { method: 'browser', status: 'needs-auth' };
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Gmail', exact: true });
  await expect(auth.getByLabel('Account')).toBeVisible();
  await auth.getByLabel('Account').click(); await page.getByRole('option', { name: 'Work', exact: true }).click();
  const opened = page.waitForEvent('popup'); await auth.getByRole('button', { name: 'Sign in with Gmail', exact: true }).click(); await (await opened).close();
  await expect(page.getByRole('link', { name: 'Continue sign-in' })).toBeVisible();
  assert.ok(!posts.includes('/api/connectors/setup')); assert.deepEqual(errors, []);
});

test('browser errors recover through consumer help without directing users to project configuration', { timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t, { browserConnector: true, browserOptionsFailure: true });
  await page.goto(page.url() + '#connectors');
  await page.getByRole('button', { name: 'Connect app', exact: true }).click(); await page.getByRole('button', { name: 'Connect Jira', exact: true }).click();
  const auth = page.getByRole('dialog', { name: 'Connect Jira', exact: true });
  await expect(auth.getByRole('alert')).toHaveText('Could not read Composio connections. Sign in again or try Refresh.');
  await expect(auth.getByRole('link', { name: 'Open Composio' })).toHaveAttribute('href', 'https://connect.composio.dev');
  assert.deepEqual(errors, []);
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
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'unverified', error: 'This connection was removed. Reconnect.' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'needs-auth' };
  await page.clock.install(); const initialCheck = page.waitForResponse('**/api/connectors');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  await expect(page.getByRole('button', { name: 'Refresh Slack', exact: true })).toBeEnabled();
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
  const github = page.getByRole('button', { name: 'Refresh GitHub', exact: true });
  await expect(github).toBeEnabled();
  let release!: () => void, received!: () => void, heldReads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/github/connection', async route => { heldReads++; received(); await held; await route.fallback(); });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await started;
  await expect(github).toBeEnabled(); await expect(github.locator('.motion-safe\\:animate-spin')).toHaveCount(0);
  await github.click(); await expect(github).toBeDisabled();
  await expect(github.locator('.motion-safe\\:animate-spin')).toHaveCount(1);
  assert.equal(heldReads, 1, 'Focus, visibility and manual refresh should share a GitHub read');
  release(); await expect(github).toBeEnabled();
});

test('Connectors polls pending sign-in quietly and coalesces a manual refresh', { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t);
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'pending', redirectUrl: 'https://example.com/sign-in' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { status: 'connected' };
  await page.clock.install(); const initialCheck = page.waitForResponse('**/api/connectors');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  const slack = page.getByRole('button', { name: 'Refresh Slack', exact: true });
  const linear = page.getByRole('button', { name: 'Refresh Linear', exact: true });
  await expect(slack).toBeEnabled();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const started = new Promise<void>(resolve => { received = resolve; });
  let heldReads = 0;
  await page.route('**/api/connectors', async route => { heldReads++; received(); await held; await route.fulfill({ json: connectors }); });
  await page.clock.runFor(5000); await started;
  await expect(slack).toBeEnabled(); await expect(linear).toBeEnabled();
  await expect(slack.locator('.animate-spin, .motion-safe\\:animate-spin')).toHaveCount(0);
  await slack.click();
  await expect(slack).toBeDisabled(); await expect(linear).toBeEnabled();
  await expect(slack.locator('.motion-safe\\:animate-spin')).toHaveCount(1);
  await linear.click();
  await expect(slack).toBeDisabled(); await expect(linear).toBeDisabled();
  assert.equal(heldReads, 1, 'The held background read should serve the manual refresh');
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'connected' };
  release();
  await expect(slack).toBeEnabled(); await expect(linear).toBeEnabled(); await expect(page.getByRole('link', { name: 'Continue sign-in' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected');
});

for (const operation of ['start', 'remove'] as const) test(`Connectors reconciles a failed ${operation} without animating Refresh buttons`, { timeout: 60000 }, async t => {
  const { page, connectors } = await fixture(t, { browserConnector: true });
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'connected' };
  connectors.apps.find(app => app.provider === 'linear')!.account = { method: 'browser', status: 'connected' };
  const initialCheck = page.waitForResponse('**/api/connectors');
  await page.goto(page.url() + '#connectors'); await (await initialCheck).finished();
  // The recovery dialog hides the background rows from the accessibility tree.
  const slack = page.locator('button[aria-label="Refresh Slack"]');
  const linear = page.locator('button[aria-label="Refresh Linear"]');
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
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'unverified', checking: true };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/api/connectors', async route => { await held; await route.fulfill({ json: connectors }); });
  await page.goto(page.url() + '#connectors');
  const row = page.getByRole('listitem').filter({ hasText: 'Slack' });
  await expect(row).toBeVisible({ timeout: 1500 }); await expect(row).toContainText('Checking');
  await expect(page.getByRole('button', { name: 'Refresh Slack', exact: true })).toBeEnabled();
  connectors.apps.find(app => app.provider === 'slack')!.account = { method: 'browser', status: 'connected' };
  release(); await expect(row).toContainText('Connected'); await expect(row).not.toContainText('Checking');
});
