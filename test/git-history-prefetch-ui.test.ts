import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import { defaultPipeline } from '../src/pipeline.ts';

test('Git graph preloads before opening and shares ready or pending history', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-history-prefetch-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const repoPath = '/acme/app';
  const commit = { hash: 'a'.repeat(40), message: 'Initial change', author: { name: 'Example author' }, date: '2026-01-01T00:00:00Z', parents: [] };
  for (const pending of [false, true]) await t.test(pending ? 'opening joins the pending preload' : 'opening and reopening use the ready preload', async t => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const held = Promise.withResolvers<void>();
    t.after(async () => { held.resolve(); await page.close(); });
    const requests: URL[] = [];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let result: unknown = {};
      if (url.pathname === '/api/state') result = { defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch: 'main', sha: commit.hash }, delivery: { source: [], build: [], production: [] } }, pipeline: defaultPipeline(repoPath), environments: [], providers: [] };
      if (url.pathname === '/api/git-history') {
        requests.push(url);
        if (pending && requests.length === 1) await held.promise;
        result = { commits: [{ ...commit, message: requests.length > 1 ? 'Refreshed change' : commit.message }], branch: 'main', repository: 'acme/app', source: 'local', hasMore: false };
      }
      await route.fulfill({ json: result });
    });
    await page.goto(`${app.url}#pipeline`);
    await expect(page.getByRole('button', { name: 'Git graph', exact: true })).toBeVisible();
    await expect.poll(() => requests.length, { timeout: 3000, message: 'History must start loading before the viewer opens Git graph.' }).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Git graph', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Git graph', exact: true }).click();
    if (pending) { await expect(page.getByText('Loading history…', { exact: true })).toBeAttached(); held.resolve(); }
    await expect(page.getByText('Initial change', { exact: true })).toBeVisible();
    assert.equal(requests.length, 1, 'Opening must not duplicate a ready or pending preload.');
    await page.getByRole('button', { name: 'Close Git graph', exact: true }).click();
    // A cached reopen must still work while further reads are unavailable.
    await page.route('**/api/git-history?**', async route => { requests.push(new URL(route.request().url())); await route.abort(); });
    await page.getByRole('button', { name: 'Git graph', exact: true }).click();
    await expect(page.getByText('Initial change', { exact: true })).toBeVisible();
    assert.equal(requests.length, 1);
    await page.unroute('**/api/git-history?**');
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await expect(page.getByText('Refreshed change', { exact: true })).toBeVisible();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get('refresh'), '1');
  });
  await t.test('switching branches discards a late preload even when the checkout path stays the same', async t => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const old = Promise.withResolvers<void>();
    t.after(async () => { old.resolve(); await page.close(); });
    let branch = 'main';
    const requests: string[] = [];
    const source = () => ({ repository: 'acme/app', branch, rootDirectory: '/', scanPath: repoPath });
    const state = () => ({ defaultRepo: repoPath, scan: { repo: { path: repoPath, name: 'app', branch, sha: (branch === 'main' ? 'a' : 'b').repeat(40) }, delivery: { source: [], build: [], production: [] } }, source: source(), pipeline: defaultPipeline(repoPath), environments: [], providers: [] });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let result: unknown = {};
      if (url.pathname === '/api/state') result = state();
      if (url.pathname === '/api/session') result = { token: 'test-session' };
      if (url.pathname === '/api/github/connection') result = { connected: true, authenticated: true, available: true, account: { login: 'example', name: null }, source: source() };
      if (url.pathname === '/api/github/branches') result = { branches: [{ name: 'main' }, { name: 'preview' }], defaultBranch: 'main', nextPage: null };
      if (url.pathname === '/api/source/github') { branch = route.request().postDataJSON().branch; result = state(); }
      if (url.pathname === '/api/git-history') {
        const requestedBranch = branch;
        requests.push(requestedBranch);
        if (requestedBranch === 'main') await old.promise;
        result = { commits: [{ ...commit, message: `${requestedBranch} change` }], branch: requestedBranch, repository: 'acme/app', source: 'github', hasMore: false };
      }
      await route.fulfill({ json: result });
    });
    await page.goto(`${app.url}#pipeline`);
    await expect.poll(() => requests).toEqual(['main']);
    await page.getByRole('combobox', { name: 'Switch branch: main', exact: true }).click();
    await page.getByRole('option', { name: 'preview', exact: true }).click();
    await expect.poll(() => requests).toEqual(['main', 'preview']);
    old.resolve();
    await page.getByRole('button', { name: 'Git graph', exact: true }).click();
    await expect(page.getByText('preview change', { exact: true })).toBeVisible();
    await expect(page.getByText('main change', { exact: true })).toBeHidden();
    assert.equal(requests.length, 2);
  });
});
