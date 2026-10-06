import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect, type Request } from '@playwright/test';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';
import type { AutopilotChange, AutopilotView } from '../contract/autopilot.ts';
import type { StageRemoval } from '../contract/environment.ts';
import type { BuildReply } from '../contract/github.ts';
import type { GateReply } from '../contract/gate.ts';
import type { Pipeline } from '../contract/pipeline.ts';
import type { ReleaseReply } from '../contract/releases.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

const repoPath = '/acme/app', sha = 'a'.repeat(40);
type Reply = { status?: number; json: unknown };
type Handler = (path: string, request: Request) => Reply | undefined | Promise<Reply | undefined>;

const withBeta = () => applyPipelineAction(defaultPipeline(repoPath), { action: 'add-stage', afterStageId: 'build', name: 'Beta' });
/** GET /api/state for a scanned checkout of acme/app. */
const pipelineState = (pipeline: Pipeline, extra: Record<string, unknown> = {}) => ({
  defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [], production: [] } },
  pipeline, environments: [], browserTests: {}, stageRemovals: [], ...extra,
});
const release: ReleaseReply = { repoPath, sha, target: null, canDeploy: false, blockedReason: null, current: null, unresolved: null, recent: [] };

// The actual App on Vite, with its own polls. Only HTTP replies are fixtures; a handler answers first.
async function openApp(t: TestContext, handle: Handler) {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors: string[] = [], posts: { path: string; body: unknown }[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push({ path, body: request.postDataJSON() });
    const reply = await handle(path, request) ?? (path === '/api/session' ? { json: { token: 'fixture-token' } }
      : path === '/api/gate' ? { json: { repoPath, sha, stages: {}, production: null } }
      : path === '/api/releases' ? { json: release } : path === '/api/twin/services' ? { json: { services: [] } } : { json: {} });
    await route.fulfill({ status: reply.status ?? 200, json: reply.json });
  });
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  // Reads a poll at once, as a saved change does, and waits for its reply to render.
  const refresh = async (route: string, module: string, notifier: string) => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === route);
    await page.evaluate(async ([file, name]) => { (await import(file))[name].notify(); }, [module, notifier]);
    await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  return { page, posts, pageErrors, refresh, open: () => page.goto(`${origin}/build/`) };
}

test('pausing a transition names the transition and leaves the stage status in its Badge', { timeout: 60000 }, async t => {
  let pipeline = withBeta();
  const beta = pipeline.stages.find(stage => stage.kind === 'sandbox')!.id;
  const { page, posts, pageErrors, open } = await openApp(t, (path, request) => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    if (path === '/api/pipeline/action') { pipeline = applyPipelineAction(pipeline, request.postDataJSON()); return { json: { pipeline } }; }
  });
  await open();
  const production = page.getByRole('group', { name: 'Production', exact: true }), dialog = page.getByRole('alertdialog');
  await expect(production.getByRole('button', { name: 'Not connected', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause transition from Beta to Production', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('Pause transition?');
  await expect(dialog.getByText('Beta → Production', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pause transition', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(posts.filter(item => item.path === '/api/pipeline/action').map(item => item.body), [{ action: 'set-transition', sourceStageId: beta, targetStageId: 'production', blocked: true, repoPath }]);
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  // The pause blocks no deployment or gate, so the stage it leads to keeps reporting its own state.
  await expect(production.getByRole('button', { name: 'Not connected', exact: true })).toBeVisible();
  await expect(page.getByText('Transition paused')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume transition from Beta to Production', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('Resume transition?');
  await dialog.getByRole('button', { name: 'Resume transition', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause transition from Beta to Production', exact: true })).toBeVisible();
  assert.equal(pipeline.transitions.find(edge => edge.target === 'production')?.blocked, false);
  assert.deepEqual(pageErrors, []);
});

test('a failed Autopilot read never brings back the change the page loaded with', { timeout: 60000 }, async t => {
  const running: AutopilotChange = { id: 'repair-1', stageId: 'build', kind: 'repair', title: 'Fixing build', status: 'running', sha, steps: [{ id: 'read', name: 'Read the failure', status: 'active' }] };
  const view = (change: AutopilotChange): AutopilotView => ({ repoPath, stages: { build: { mode: 'merge', changes: [change] } } });
  let autopilot: Reply = { json: view({ ...running, status: 'needs-review', steps: [{ id: 'read', name: 'Read the failure', status: 'done' }] }) };
  const { page, pageErrors, refresh, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(defaultPipeline(repoPath), { autopilot: view(running) }) };
    if (path === '/api/autopilot') return autopilot;
  });
  await open();
  const build = page.getByRole('group', { name: 'Build', exact: true });
  await expect(build.getByRole('button', { name: 'Autopilot for Build: Needs review', exact: true })).toBeVisible();
  // The controller cannot be read: the page shows nothing about Autopilot rather than the view it loaded with.
  autopilot = { status: 503, json: { error: 'Autopilot unavailable.' } };
  await refresh('/api/autopilot', '/build/src/lib/pipeline-autopilot.ts', 'autopilotChanges');
  await expect(build.getByRole('button', { name: /^Autopilot for Build/ })).toHaveCount(0);
  await expect(build.getByText('Fixing build')).toHaveCount(0);
  await expect(build.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  autopilot = { json: view({ ...running, status: 'merged' }) };
  await refresh('/api/autopilot', '/build/src/lib/pipeline-autopilot.ts', 'autopilotChanges');
  await expect(build.getByRole('button', { name: 'Autopilot for Build: Merged', exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
});

test('a failed Load more branches keeps the branch chosen from a later page, and Save', { timeout: 60000 }, async t => {
  const source = { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: repoPath };
  const connection = { available: true, authenticated: true, connected: true, account: { login: 'acme', name: null }, source, localCheckout: null };
  const pages = [['main', 'feature/a'], ['zz-feature'], ['zz-last']], failure = 'GitHub returned an unreadable branch page. Try again.';
  let failPage = 0;
  const { page, pageErrors, open } = await openApp(t, (path, request) => {
    if (path === '/api/state') return { json: pipelineState(defaultPipeline(repoPath), { source }) };
    if (path === '/api/github/connection') return { json: connection };
    if (path === '/api/github/repositories') return { json: { repositories: [{ fullName: 'acme/app' }], nextPage: null } };
    if (path === '/api/github/branches') {
      const number = Number(new URL(request.url()).searchParams.get('page'));
      if (number === failPage) return { status: 502, json: { error: failure } };
      return { json: { branches: pages[number - 1].map(name => ({ name })), nextPage: number < pages.length ? number + 1 : null, defaultBranch: 'main' } };
    }
  });
  await open();
  await page.getByRole('button', { name: 'Configure source', exact: true }).click();
  const sheet = page.getByRole('dialog'), branch = sheet.getByRole('combobox', { name: 'Branch', exact: true });
  const more = sheet.getByRole('button', { name: 'Load more branches', exact: true }), save = sheet.getByRole('button', { name: 'Save source', exact: true });
  await expect(branch).toHaveText('main');
  await more.click();
  await branch.click();
  await page.getByRole('option', { name: 'zz-feature', exact: true }).click();
  await expect(branch).toHaveText('zz-feature');
  failPage = 3;
  await more.click();
  await expect(sheet.getByRole('alert')).toHaveText(failure);
  await expect(branch).toHaveText('zz-feature');
  await expect(save).toBeEnabled();
  // Load more branches repeats the failed page, keeping the pages already listed.
  failPage = 0;
  await more.click();
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  await expect(branch).toHaveText('zz-feature');
  await branch.click();
  await expect(page.getByRole('option', { name: 'zz-last', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'feature/a', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(save).toBeEnabled();
  assert.deepEqual(pageErrors, []);
});

test('a changed gate verdict reads the release at once, so Deploy follows it between slow reads', { timeout: 60000 }, async t => {
  const pipeline = withBeta(), beta = pipeline.stages.find(stage => stage.kind === 'sandbox')!.id;
  const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
  let passed = false;
  const gate = (): GateReply => ({ repoPath, sha, stages: { [beta]: { id: 'gate-1', stageId: beta, sha, status: passed ? 'passed' : 'running', detectedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }, production: passed ? { status: 'ready', sha } : null });
  const { page, pageErrors, refresh, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    if (path === '/api/gate') return { json: gate() };
    if (path === '/api/releases') return { json: { ...release, target, canDeploy: passed, blockedReason: passed ? null : 'Every Sandbox gate must pass or be explicitly released for this commit.' } satisfies ReleaseReply };
  });
  await open();
  const deploy = page.getByRole('button', { name: 'Deploy', exact: true });
  await expect(deploy).toBeDisabled();
  passed = true;
  await refresh('/api/gate', '/build/src/lib/stage-gate.ts', 'gateChanges');
  await expect(deploy).toBeEnabled();
  assert.deepEqual(pageErrors, []);
});

test('Deploy follows the passed gates\' commit statuses reaching GitHub, which change no gate verdict', { timeout: 60000 }, async t => {
  const pipeline = withBeta(), beta = pipeline.stages.find(stage => stage.kind === 'sandbox')!.id;
  const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
  let reported = false, releaseReads = 0;
  const { page, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    if (path === '/api/gate') return { json: { repoPath, sha, stages: { [beta]: { id: 'gate-1', stageId: beta, sha, status: 'passed', detectedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }, production: { status: 'ready', sha } } satisfies GateReply };
    if (path === '/api/releases') { releaseReads++; return { json: { ...release, target, canDeploy: reported, blockedReason: reported ? null : 'Every Sandbox gate must pass or be explicitly released and reported for this commit.' } satisfies ReleaseReply }; }
  });
  await open();
  const deploy = page.getByRole('button', { name: 'Deploy', exact: true });
  await expect(deploy).toBeDisabled();
  const before = releaseReads;
  reported = true;
  await expect(deploy).toBeEnabled();
  assert.ok(releaseReads > before);
  assert.deepEqual(pageErrors, []);
});

test('a source reload a gate asks for runs after a pipeline or source change saves, also when Try again is pressed meanwhile', { timeout: 60000 }, async t => {
  let pipeline = withBeta(), scanned = sha, failState = false;
  const write = Promise.withResolvers<void>(), save = Promise.withResolvers<void>(); t.after(() => { write.resolve(); save.resolve(); });
  const github = { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: repoPath };
  const { page, refresh, open } = await openApp(t, async (path, request) => {
    if (path === '/api/state') return failState ? { status: 503, json: { error: 'The controller is restarting.' } } : { json: { ...pipelineState(pipeline), scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha: scanned }, delivery: { source: [], build: [], production: [] } } } };
    if (path === '/api/gate') return { json: { repoPath, sha: scanned, stages: {}, production: null } };
    if (path === '/api/pipeline/action') { await write.promise; pipeline = applyPipelineAction(pipeline, request.postDataJSON()); return { json: { pipeline } }; }
    if (path === '/api/github/connection') return { json: { available: true, authenticated: true, connected: true, account: { login: 'acme', name: null }, source: github, localCheckout: null } };
    if (path === '/api/github/branches') return { json: { branches: [{ name: 'main' }, { name: 'feature' }], nextPage: null, defaultBranch: 'main' } };
    if (path === '/api/source/github') { await save.promise; return { status: 409, json: { error: 'Wait for the journey gate to finish.' } }; }
  });
  await open();
  // The Source card by its node, since a confirmation in progress hides the canvas from role queries.
  const source = page.locator('.react-flow__node[data-id="source"]');
  await expect(source.getByText('aaaaaaa', { exact: true })).toBeVisible();
  // A pause is saving when the gate reports that it moved the managed source to the next commit.
  await page.getByRole('button', { name: 'Pause transition from Beta to Production', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pause transition', exact: true }).click();
  scanned = 'b'.repeat(40);
  await refresh('/api/gate', '/build/src/lib/stage-gate.ts', 'gateChanges');
  await expect(source.getByText('aaaaaaa', { exact: true })).toBeVisible();
  write.resolve();
  await expect(source.getByText('bbbbbbb', { exact: true })).toBeVisible();
  // A reload that fails says so with Try again. Pressed while a branch switch saves, it reads the moved source once the
  // switch ends, here refused.
  failState = true; scanned = 'c'.repeat(40);
  await refresh('/api/gate', '/build/src/lib/stage-gate.ts', 'gateChanges');
  await expect(page.getByRole('alert')).toContainText('The controller is restarting.');
  failState = false;
  await page.getByRole('combobox', { name: 'Switch branch: main', exact: true }).click();
  await page.getByRole('option', { name: 'feature', exact: true }).click();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(source.getByText('bbbbbbb', { exact: true })).toBeVisible();
  save.resolve();
  await expect(page.getByRole('alert')).toContainText('Wait for the journey gate to finish.');
  await expect(source.getByText('ccccccc', { exact: true })).toBeVisible();
});

test('a failed first connection keeps Connect GitHub, while a failed pipeline read offers Try again', { timeout: 60000 }, async t => {
  const account = { login: 'acme', name: null };
  let connected = false, stateFails = false;
  const { page, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return stateFails ? { status: 503, json: { error: 'The local server is unavailable. Try reconnecting.' } } : { json: { defaultRepo: '/work/app', scan: null, pipeline: null, environments: [], browserTests: {}, stageRemovals: [] } };
    if (path === '/api/github/connection' || path === '/api/github/connect') { connected ||= path === '/api/github/connect'; return { json: { available: true, authenticated: true, account, connected, source: null, localCheckout: null } }; }
    if (path === '/api/github/repositories') return { json: { repositories: [{ fullName: 'acme/app' }], nextPage: null } };
    if (path === '/api/github/branches') return { json: { branches: [{ name: 'main' }], nextPage: null, defaultBranch: 'main' } };
    if (path === '/api/source/github') return { status: 500, json: { error: 'Could not create the private source checkout.' } };
  });
  await open();
  const empty = page.getByRole('main');
  await expect(empty.getByRole('heading', { name: 'Connect your GitHub', exact: true })).toBeVisible();
  await expect(empty.getByRole('button')).toHaveCount(1);
  await expect(empty.getByRole('button', { name: 'Connect GitHub', exact: true }).locator('.brand-mark')).toHaveCount(1);
  await empty.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect GitHub', exact: true }).getByRole('button', { name: 'Continue as acme', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Source', exact: true });
  await sheet.getByRole('combobox', { name: 'Repository', exact: true }).click();
  await page.getByRole('option', { name: 'acme/app', exact: true }).click();
  await expect(sheet.getByRole('combobox', { name: 'Branch', exact: true })).toHaveText('main');
  await sheet.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Could not create the private source checkout.');
  // The sheet reports the failed save; the page behind it still offers the connection rather than a reload.
  await expect(empty.getByRole('heading', { name: 'Connect your GitHub', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(empty.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible();
  await expect(page.getByText('Could not load pipeline')).toHaveCount(0);
  // A pipeline that cannot be read is the one failure the page reads again.
  stateFails = true;
  await page.reload();
  await expect(empty.getByRole('heading', { name: 'Could not load pipeline', exact: true })).toBeVisible();
  stateFails = false;
  await empty.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(empty.getByRole('heading', { name: 'Connect your GitHub', exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
});

test('a refused Create environment is one canvas error that one Dismiss clears', { timeout: 60000 }, async t => {
  const pipeline = withBeta(), refusal = 'Add an app before creating this environment.';
  const { page, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    if (path === '/api/environments/create') return { status: 409, json: { error: refusal } };
    if (path === '/api/browser') return { json: { cases: [], runs: [], accounts: [], specs: {}, preparation: null, config: { targetUrl: '', scope: '', requirements: '', maxSteps: 60 }, capabilities: null } };
    if (path === '/api/environments') return { json: { environments: [], plan: null } };
  });
  await open();
  await page.getByRole('button', { name: 'Create Beta environment', exact: true }).click();
  const alert = page.locator('.canvas-alert');
  await expect(alert).toContainText(refusal);
  await alert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(alert).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});

test('a view that failed for one stage does not stand in for the next stage opened in the same sheet', { timeout: 60000 }, async t => {
  const beta = withBeta(), betaId = beta.stages.find(stage => stage.kind === 'sandbox')!.id;
  const pipeline = applyPipelineAction(beta, { action: 'add-stage', afterStageId: betaId, name: 'Gamma' });
  const view = { cases: [], runs: [], accounts: [], specs: {}, preparation: null, config: { targetUrl: '', scope: '', requirements: '', maxSteps: 60 }, capabilities: null };
  const { page, open } = await openApp(t, (path, request) => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    // A malformed view makes Beta's inspector throw while rendering.
    if (path === '/api/browser') return { json: new URL(request.url()).searchParams.get('stageId') === betaId ? { ...view, cases: null } : view };
    if (path === '/api/environments') return { json: { environments: [], plan: null } };
  });
  await open();
  const sheet = page.locator('.pipeline-inspector');
  await page.getByRole('group', { name: 'Beta', exact: true }).getByRole('button', { name: 'Integration tests, 0', exact: true }).click();
  await expect(sheet.getByText('Could not load this view.', { exact: true })).toBeVisible();
  // The open sheet covers the canvas's right side, so Gamma's entry is reached from the keyboard.
  await page.getByRole('group', { name: 'Gamma', exact: true }).getByRole('button', { name: 'Integration tests, 0', exact: true }).press('Enter');
  await expect(sheet.getByRole('tab', { name: 'Integration tests', exact: true })).toBeVisible();
  await expect(sheet.getByText('Could not load this view.', { exact: true })).toHaveCount(0);
});

test('the Source sheet shows the GitHub mark only for a repository with a GitHub remote', { timeout: 60000 }, async t => {
  let provider = 'Git';
  const { page, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: { ...pipelineState(defaultPipeline(repoPath)), scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, nodes: [{ id: 'repository', label: 'app', kind: 'repository', provider }], delivery: { source: [], build: [], production: [] } } } };
    if (path === '/api/github/connection') return { json: { available: true, authenticated: false, account: null, connected: false, source: null, localCheckout: null } };
  });
  for (const [scanned, mark] of [['Git', null], ['GitHub', 'GitHub']] as const) {
    provider = scanned;
    await open();
    await page.getByRole('button', { name: 'Configure source', exact: true }).click();
    const header = page.locator('.pipeline-inspector [data-slot="sheet-header"]');
    await expect(header.getByRole('heading', { name: 'app', exact: true })).toBeVisible();
    if (mark) await expect(header.locator('img')).toHaveAttribute('alt', mark);
    else await expect(header.locator('img')).toHaveCount(0);
  }
  assert.deepEqual(pageErrors, []);
});

test('deleting a stage asks first, follows the controller until it is removed, then refreshes the pipeline', { timeout: 60000 }, async t => {
  let pipeline = withBeta(), status: StageRemoval['status'] | null = null;
  const beta = pipeline.stages.find(stage => stage.kind === 'sandbox')!.id;
  const removal = (): StageRemoval | null => status && { id: 'removal-1', stageId: beta, status, environmentIds: [], completedEnvironmentIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const { page, posts, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(pipeline, { stageRemovals: status ? [removal()] : [] }) };
    if (path === '/api/stages/remove') { status = 'removing'; return { json: { removal: removal() } }; }
    if (path === '/api/stages/removal') return { json: { removal: removal() } };
  });
  await open();
  await page.getByRole('button', { name: 'Delete Beta', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete Beta?', exact: true });
  await expect(dialog.getByText('No sandboxes or tests.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(posts.filter(item => item.path === '/api/stages/remove'), [], 'Cancel deletes nothing.');
  await page.getByRole('button', { name: 'Delete Beta', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete stage', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Deleting stage…', exact: true })).toBeDisabled();
  assert.deepEqual(posts.filter(item => item.path === '/api/stages/remove').map(item => item.body), [{ repoPath, stageId: beta }]);
  // The controller finishes removing the stage; the dialog closes and the pipeline no longer lists it.
  status = 'completed'; pipeline = defaultPipeline(repoPath);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Beta', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Production', exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
});

test('the Pipeline opens with its navigation collapsed, zoom and Fit view only, and Production reporting a release before readiness', { timeout: 60000 }, async t => {
  const pipeline = withBeta(), beta = pipeline.stages.find(stage => stage.kind === 'sandbox')!.id;
  const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
  let releaseView: ReleaseReply = { ...release, target, canDeploy: true };
  const { page, pageErrors, refresh, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: pipelineState(pipeline) };
    if (path === '/api/gate') return { json: { repoPath, sha, stages: { [beta]: { id: 'gate-1', stageId: beta, sha, status: 'passed', detectedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }, production: { status: 'ready', sha } } satisfies GateReply };
    if (path === '/api/releases') return { json: releaseView };
  });
  await open();
  await expect(page.locator('[data-slot="sidebar"][data-state]')).toHaveAttribute('data-state', 'collapsed');
  await expect(page.locator('.canvas-toolbar').getByRole('button')).toHaveText(['', '', '']);
  assert.deepEqual(await page.locator('.canvas-toolbar').getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Zoom out', 'Zoom in', 'Fit view']);
  // Production reads the gates' readiness until a requested deployment reports its own state for the commit.
  const production = page.getByRole('group', { name: 'Production', exact: true });
  await expect(production.getByText('Readyaaaaaaa', { exact: true })).toBeVisible();
  releaseView = { ...releaseView, current: { id: 'release-1', sha, ...target, status: 'deploying', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } };
  await refresh('/api/releases', '/build/src/lib/production-release.ts', 'releaseChanges');
  await expect(production.getByText('Deployingaaaaaaa', { exact: true })).toBeVisible();
  await expect(production.getByText('Readyaaaaaaa', { exact: true })).toHaveCount(0);
  // An earlier commit's deployment still unresolved after the source moved on keeps the Badge, with its own commit and logs.
  const earlier = 'b'.repeat(40);
  releaseView = { ...releaseView, canDeploy: false, current: null, unresolved: { id: 'release-0', sha: earlier, ...target, status: 'deploying', logUrl: 'https://ci.example.test/runs/7', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } };
  await refresh('/api/releases', '/build/src/lib/production-release.ts', 'releaseChanges');
  await expect(production.getByText('Deployingbbbbbbb', { exact: true })).toBeVisible();
  await expect(production.getByRole('link', { name: 'Logs', exact: true })).toHaveAttribute('href', 'https://ci.example.test/runs/7');
  // Once it ends, Production reads the gates' readiness again.
  releaseView = { ...releaseView, canDeploy: true, unresolved: null };
  await refresh('/api/releases', '/build/src/lib/production-release.ts', 'releaseChanges');
  await expect(production.getByText('Readyaaaaaaa', { exact: true })).toBeVisible();
  await expect(production.getByRole('link', { name: 'Logs', exact: true })).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});

test('connecting GitHub reads Build, the recorded deployments and the release again at once', { timeout: 60000 }, async t => {
  const account = { login: 'acme', name: null };
  let connected = false, deploymentReads = 0, releaseReads = 0;
  const build: BuildReply = { repoPath, repository: 'acme/app', branch: 'main', scannedSha: sha, sha, source: 'watched', runs: [{ id: '1', workflowId: '2', name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success', attempt: 1, sha, branch: 'main', url: null, createdAt: null, startedAt: null, updatedAt: null, jobs: [] }] };
  const { page, pageErrors, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: { ...pipelineState(defaultPipeline(repoPath)), scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [{ id: 'github-actions', kind: 'github-actions', provider: 'github-actions', label: 'GitHub Actions' }], production: [] } } } };
    if (path === '/api/github/connection' || path === '/api/github/connect') { connected ||= path === '/api/github/connect'; return { json: { available: true, authenticated: true, account, connected, source: null, localCheckout: null } }; }
    if (path === '/api/github/build') return connected ? { json: build } : { status: 400, json: { error: 'Connect your GitHub account to read Build.' } };
    if (path === '/api/github/deployments') { deploymentReads++; return connected ? { json: { repository: 'acme/app', sha, deployments: [] } } : { status: 400, json: { error: 'Connect your GitHub account to read deployments.' } }; }
    if (path === '/api/releases') { releaseReads++; return { json: release }; }
    if (path === '/api/github-actions') return { json: { workflows: [] } };
    if (path === '/api/github/repositories') return { json: { repositories: [{ fullName: 'acme/app' }], nextPage: null } };
  });
  await open();
  const buildCard = page.getByRole('group', { name: 'Build', exact: true });
  await expect(buildCard.getByText('Unverified', { exact: true })).toBeVisible();
  await expect.poll(() => deploymentReads).toBe(1);
  await expect.poll(() => releaseReads).toBe(1);
  await page.getByRole('button', { name: 'Configure source', exact: true }).click();
  await page.locator('.pipeline-inspector').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect GitHub', exact: true }).getByRole('button', { name: 'Continue as acme', exact: true }).click();
  // These evidence reads wait a minute after a failure or while idle; the connection change reads them again at once.
  await expect(buildCard.getByText('Passedaaaaaaa', { exact: true })).toBeVisible();
  await expect.poll(() => deploymentReads).toBe(2);
  await expect.poll(() => releaseReads).toBe(2);
  assert.deepEqual(pageErrors, []);
});

test('a GitHub sign-in that ends without connecting reads Build, the recorded deployments and the release again at once', { timeout: 60000 }, async t => {
  // The controller refuses these reads while a device sign-in is pending.
  const refused = { status: 409, json: { error: 'Finish or cancel GitHub sign-in first.' } };
  const signIn = { id: 'sign-in-1', status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: null, expiresAt: '2026-01-01T00:15:00Z', account: null, error: null };
  const reads = { build: 0, deployments: 0, releases: 0 };
  let pending = false;
  const { page, pageErrors, refresh, open } = await openApp(t, path => {
    if (path === '/api/state') return { json: { ...pipelineState(defaultPipeline(repoPath)), scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [{ id: 'github-actions', kind: 'github-actions', provider: 'github-actions', label: 'GitHub Actions' }], production: [] } } } };
    if (path === '/api/github/connection') return { json: { available: true, authenticated: false, account: null, connected: false, source: null, localCheckout: null } };
    if (path === '/api/github/auth/start') { pending = true; return { json: signIn }; }
    if (path === '/api/github/auth/status') return { json: signIn };
    if (path === '/api/github/auth/cancel') { pending = false; return { json: { ...signIn, status: 'cancelled' } }; }
    if (path === '/api/github/build') { reads.build++; return pending ? refused : { status: 400, json: { error: 'Connect your GitHub account to read Build.' } }; }
    if (path === '/api/github/deployments') { reads.deployments++; return pending ? refused : { status: 400, json: { error: 'Connect your GitHub account to read deployments.' } }; }
    if (path === '/api/releases') { reads.releases++; return pending ? refused : { json: release }; }
    if (path === '/api/github-actions') return { json: { workflows: [] } };
  });
  await open();
  await expect.poll(() => Object.values(reads)).toEqual([1, 1, 1]);
  await page.getByRole('button', { name: 'Configure source', exact: true }).click();
  await page.locator('.pipeline-inspector').getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
  await dialog.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Enter this code on GitHub', exact: true })).toHaveValue('ABCD-EFGH');
  // Coming back from GitHub's tab reads Build while the sign-in is still pending.
  await refresh('/api/github/build', '/build/src/lib/pipeline-github.ts', 'buildChanges');
  const before = { ...reads };
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => [reads.build - before.build, reads.deployments - before.deployments, reads.releases - before.releases]).toEqual([1, 1, 1]);
  assert.deepEqual(pageErrors, []);
});
