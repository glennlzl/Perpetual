import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { createUiServer } from './fixtures/ui-server.ts';
import { defaultPipeline } from '../src/pipeline.ts';
import { repairChange } from '../src/repair/view.ts';
import type { PublicRepair } from '../src/repair/manager.ts';

test('desktop recovery follows controller progress without Recheck or Rerun buttons', { timeout: 60000 }, async t => {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const repoPath = '/acme/app', sha = 'a'.repeat(40), writes: unknown[] = [];
  const record: PublicRepair = { id: 'recovery-1', branch: 'main', sha, status: 'needs-person', category: 'configuration', trigger: 'person', reason: 'Authorization failed in GitHub Actions.', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', runs: [{ id: '12', name: 'Preview aliases', path: '.github/workflows/aliases.yml', url: 'https://github.com/acme/app/actions/runs/12' }], recovery: { status: 'required', automation: { status: 'watching' }, requests: [], runs: [{ id: '12', attempt: 1, name: 'Preview aliases', workflow: '.github/workflows/aliases.yml', observedAt: '2026-10-07T00:00:00Z', url: 'https://github.com/acme/app/actions/runs/12', secrets: ['CLOUD_ACCESS'], environment: null, binding: 'references', settingsUrl: 'https://github.com/acme/app/settings/secrets/actions' }] } };
  const autopilot = () => ({ repoPath, stages: { build: { mode: 'merge', changes: [repairChange(record, 'build')] } } });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {};
    if (path === '/api/state') result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha }, delivery: { source: [], build: [{ id: 'github-actions', kind: 'github-actions', provider: 'github-actions', label: 'GitHub Actions' }], production: [] } }, pipeline: defaultPipeline(repoPath), environments: [], browserTests: {}, autopilot: autopilot() };
    else if (path === '/api/session') result = { token: 'fixture-session' };
    else if (path === '/api/autopilot') result = autopilot();
    else if (path === '/api/autopilot/disconnect-vercel') { writes.push(route.request().postDataJSON()); delete record.recovery!.credential; result = autopilot(); }
    else if (path === '/api/autopilot/recover') {
      const input = route.request().postDataJSON(); writes.push(input);
      if (input.action === 'rerun') { record.status = 'rerunning'; record.recovery!.status = 'verifying'; record.recovery!.requests.push({ runId: '12', attempt: 1, status: 'accepted', requestedAt: '2026-10-07T00:01:00Z' }); delete record.reason; }
      result = autopilot();
    } else if (path === '/api/github/build') result = { repoPath, repository: 'acme/app', branch: 'main', scannedSha: sha, sha, source: 'watched', runs: [] };
    else if (path === '/api/github/deployments') result = { repository: 'acme/app', sha, deployments: [] };
    else if (path === '/api/gate') result = { repoPath, sha, stages: {}, production: null };
    else if (path === '/api/releases') result = { repoPath, sha, target: null, canDeploy: false, current: null, unresolved: null, recent: [] };
    await route.fulfill({ json: result });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/#pipeline`);
  await expect(page.getByRole('link', { name: 'Update credentials' })).toHaveAttribute('href', 'https://github.com/acme/app/settings/secrets/actions');
  assert.deepEqual(writes, [], 'Opening the page neither authorizes an account nor reruns CI.');
  await page.getByRole('button', { name: 'Waiting for access, Needs attention' }).click();
  await expect(page.getByText('CLOUD_ACCESS', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovery continues automatically.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recheck', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rerun failed jobs', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  record.recovery!.runs[0].vercelSecret = 'CLOUD_ACCESS';
  record.recovery!.credential = { provider: 'vercel', status: 'not-connected', canConnect: true, destination: { repository: 'acme/app', name: 'CLOUD_ACCESS', environment: null } };
  await expect(page.getByRole('button', { name: 'Connect Vercel', exact: true })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Connect Vercel', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('acme/app');
  await expect(page.getByRole('dialog')).toContainText('CLOUD_ACCESS');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(writes, [], 'Opening or cancelling consent never grants access or writes credentials.');
  record.recovery!.credential = { provider: 'vercel', status: 'ready', canConnect: false, canDisconnect: true, account: 'Developer' };
  // The controller advances independently of the page; polling alone follows its real state.
  record.status = 'rerunning'; record.recovery!.status = 'verifying';
  record.recovery!.requests.push({ runId: '12', attempt: 1, status: 'accepted', requestedAt: '2026-10-07T00:01:00Z' });
  delete record.reason;
  await expect(page.getByRole('button', { name: 'Verifying recovery, Running' })).toBeVisible({ timeout: 15000 });
  record.status = 'passed'; record.recovery!.status = 'passed'; record.recovery!.requests[0].status = 'observed';
  await expect(page.getByRole('button', { name: 'Build recovered, Passed' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('link', { name: 'Update credentials' })).toHaveCount(0);
  assert.deepEqual(writes, [], 'Viewing the recovery never has to drive its execution.');
  await expect(page.getByRole('button', { name: 'Stop managing access', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop managing access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop managing access', exact: true })).toHaveCount(0);
  assert.equal(writes.length, 1, 'The completed recovery retains an explicit way to stop credential maintenance.');
  assert.deepEqual(errors, []);
});
