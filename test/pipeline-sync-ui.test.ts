import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { defaultPipeline, applyPipelineAction } from '../src/pipeline.ts';

// Exercise the actual App, including independent gate and workspace polls. Only HTTP replies are fixtures.
test('a gate commit refresh preserves a pending optimistic stage collapse in Chromium', { timeout: 60000 }, async t => {
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
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
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  await page.goto(`${origin}/build/`);
  await expect(page.getByRole('button', { name: 'Collapse Build', exact: true })).toBeVisible();
  // The gate learns about the next commit and starts a source read. The user collapses Build before it returns.
  const before = stateRequests; holdState = true; gateSha = nextSha;
  await page.evaluate(async () => { const module = '/build/src/lib/stage-gate.ts'; (await import(module)).gateChanges.notify(); });
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
});
