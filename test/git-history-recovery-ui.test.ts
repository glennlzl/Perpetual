import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import { defaultPipeline } from '../src/pipeline.ts';

test('Git history recovery and pagination respect the user’s current focus', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-history-recovery-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const commits = ['a', 'b'].map((char, index) => ({ hash: char.repeat(40), message: `Example commit ${index + 1}`, author: { name: 'Example author' }, date: '2026-01-01T00:00:00Z', parents: index ? [] : ['b'.repeat(40)] }));
  const errors: string[] = [];
  async function open(failed = false) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    let held: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let started: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let reply: unknown = {};
      if (url.pathname === '/api/state') reply = { defaultRepo: '/acme/app', scan: { repo: { path: '/acme/app', name: 'app', branch: 'main', sha: commits[0].hash }, delivery: { source: [], build: [], production: [] } }, pipeline: defaultPipeline('/acme/app'), environments: [], providers: [] };
      if (url.pathname === '/api/git-history') {
        started?.resolve(); if (held) await held.promise;
        if (failed) { await route.fulfill({ status: 503, json: { error: 'Could not read history. Try again.' } }); return; }
        const more = Number(url.searchParams.get('limit')) > 100;
        reply = { commits: more ? commits : [commits[0]], hasMore: !more, branch: 'main', repository: 'acme/app', source: 'local' };
      }
      await route.fulfill({ json: reply });
    });
    await page.goto(app.url); await page.getByRole('button', { name: 'Git graph', exact: true }).click();
    return { page, retry: page.getByRole('button', { name: 'Retry', exact: true }), more: page.getByRole('button', { name: 'Load more', exact: true }), closeButton: page.getByRole('button', { name: 'Close Git graph', exact: true }), entries: page.locator('[data-slot="commit-entry"]'),
      fail: () => { failed = true; }, recover: () => { failed = false; },
      hold() { held = Promise.withResolvers<void>(); started = Promise.withResolvers<void>(); return started.promise; },
      release() { held?.resolve(); held = null; }, close: async () => { held?.resolve(); await page.close(); },
    };
  }
  await t.test('a failed read can retry without losing focus and reaches the recovered commit', async t => {
    const f = await open(true); t.after(f.close); await expect(f.retry).toBeVisible();
    const started = f.hold(); await f.retry.press('Enter'); await started;
    await expect(f.retry).toBeFocused(); await expect(f.retry).toHaveAttribute('aria-busy', 'true');
    f.release(); await expect(f.page.getByRole('dialog', { name: 'Git graph', exact: true }).getByRole('alert')).toHaveText('Could not read history. Try again.');
    await expect(f.retry).toBeFocused(); f.recover(); await f.retry.press('Enter');
    await expect(f.entries.first()).toBeFocused();
  });
  await t.test('Load more resumes on the first new commit when it still owns focus', async t => {
    const f = await open(); t.after(f.close); await expect(f.more).toBeVisible();
    await f.more.press('Enter'); await expect(f.entries).toHaveCount(2); await expect(f.entries.nth(1)).toBeFocused();
  });
  await t.test('a late page does not take focus from Close', async t => {
    const f = await open(); t.after(f.close); await expect(f.more).toBeVisible();
    const started = f.hold(); await f.more.press('Enter'); await started;
    await f.closeButton.focus(); f.release(); await expect(f.entries).toHaveCount(2); await expect(f.closeButton).toBeFocused();
  });
  await t.test('failed pagination moves to Retry and keeps the pending page on recovery', async t => {
    const f = await open(); t.after(f.close); await expect(f.more).toBeVisible();
    f.fail(); await f.more.press('Enter'); await expect(f.retry).toBeFocused();
    f.recover(); await f.retry.press('Enter'); await expect(f.entries).toHaveCount(2); await expect(f.entries.nth(1)).toBeFocused();
  });
  assert.deepEqual(errors, []);
});
