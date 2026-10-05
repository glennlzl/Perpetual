import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect, type Request } from '@playwright/test';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';
import type { AutopilotChange, AutopilotView } from '../contract/autopilot.ts';
import type { Pipeline } from '../contract/pipeline.ts';
import type { ReleaseReply } from '../contract/releases.ts';

const repoPath = '/acme/app', sha = 'a'.repeat(40);
type Reply = { status?: number; json: unknown };
type Handler = (path: string, request: Request) => Reply | undefined | Promise<Reply | undefined>;

const withBeta = () => applyPipelineAction(defaultPipeline(repoPath), { action: 'add-stage', afterStageId: 'build', name: 'Beta' });
/** GET /api/state for a scanned checkout of acme/app. */
const pipelineState = (pipeline: Pipeline, extra: Record<string, unknown> = {}) => ({
  defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [], production: [] } },
  pipeline, environments: [], browserTests: {}, stageRemovals: [], ...extra,
});
const release: ReleaseReply = { repoPath, sha, target: null, canDeploy: false, blockedReason: null, current: null, recent: [] };

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
