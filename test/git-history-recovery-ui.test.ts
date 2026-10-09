import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import { defaultPipeline } from '../src/pipeline.ts';

test('Git history recovery and automatic pagination preserve rows, scroll and focus', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-history-recovery-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const hash = (index: number) => index.toString(16).padStart(40, '0');
  const commits = Array.from({ length: 101 }, (_, index) => ({ hash: hash(index + 1), message: `Example commit ${index + 1}`, author: { name: 'Example author' }, date: '2026-01-01T00:00:00Z', parents: index < 100 ? [hash(index + 2)] : [] }));
  const errors: string[] = [];
  async function open(failed = false) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    let held: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let started: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let pageRequests = 0;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let reply: unknown = {};
      if (url.pathname === '/api/state') reply = { defaultRepo: '/acme/app', scan: { repo: { path: '/acme/app', name: 'app', branch: 'preview', sha: commits[0].hash }, delivery: { source: [], build: [], production: [] } }, pipeline: defaultPipeline('/acme/app'), environments: [], providers: [] };
      if (url.pathname === '/api/git-history') {
        const more = url.searchParams.has('cursor');
        if (more) { pageRequests++; assert.equal(url.searchParams.get('cursor'), 'next-page'); }
        started?.resolve(); if (held) await held.promise;
        if (failed) { await route.fulfill({ status: 503, json: { error: 'Could not read history. Try again.' } }); return; }
        reply = { commits: more ? commits.slice(100) : commits.slice(0, 100), hasMore: !more, nextCursor: more ? null : 'next-page', branch: 'preview', repository: 'acme/app', source: 'local' };
      }
      await route.fulfill({ json: reply });
    });
    await page.goto(`${app.url}#pipeline`); await page.getByRole('button', { name: 'Git graph', exact: true }).click();
    const body = page.getByLabel('Commit history', { exact: true });
    return { page, body, retry: page.getByRole('button', { name: 'Retry', exact: true }), closeButton: page.getByRole('button', { name: 'Close Git graph', exact: true }), entries: page.locator('[data-slot="commit-entry"]'),
      fail: () => { failed = true; }, recover: () => { failed = false; }, pageRequests: () => pageRequests,
      scrollToEnd: () => body.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; }),
      hold() { held = Promise.withResolvers<void>(); started = Promise.withResolvers<void>(); return started.promise; },
      release() { held?.resolve(); held = null; }, close: async () => { held?.resolve(); await page.close(); },
    };
  }
  await t.test('a failed read can retry without losing focus and reaches the recovered commit', async t => {
    const f = await open(true); t.after(f.close); await expect(f.retry).toBeVisible();
    const started = f.hold(); await f.retry.press('Enter'); await started;
    await expect(f.retry).toBeFocused(); await expect(f.retry).toHaveAttribute('aria-busy', 'true');
    f.release(); await expect(f.page.getByRole('dialog', { name: 'Git graph', exact: true }).getByRole('alert')).toHaveText('Could not read history. Try again.');
    await expect(f.retry).toHaveAttribute('aria-busy', 'false');
    await expect(f.retry).toBeFocused(); f.recover(); await f.retry.press('Enter');
    await expect(f.entries.first()).toBeFocused();
  });
  await t.test('scrolling appends the next page in place without a second branch selector or footer', async t => {
    const f = await open(); t.after(f.close); await expect(f.entries).toHaveCount(100);
    await expect(f.page.getByLabel('History branch: preview', { exact: true })).toHaveText('preview');
    await expect(f.page.getByRole('combobox', { name: 'History branches' })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
    const dialog = f.page.getByRole('dialog', { name: 'Git graph', exact: true });
    await expect(dialog.getByText('acme/app', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/history · \d+ commits/)).toHaveCount(0);
    const started = f.hold();
    await f.entries.nth(99).focus();
    const before = await f.scrollToEnd(); await started;
    await expect(f.entries).toHaveCount(100);
    f.release(); await expect(f.entries).toHaveCount(101);
    assert.equal(await f.body.evaluate(element => element.scrollTop), before);
    await expect(f.entries.nth(99)).toBeFocused();
    assert.equal(f.pageRequests(), 1);
  });
  await t.test('a late page does not take focus from Close', async t => {
    const f = await open(); t.after(f.close); await expect(f.entries).toHaveCount(100);
    const started = f.hold(); await f.scrollToEnd(); await started;
    await f.closeButton.focus(); f.release(); await expect(f.entries).toHaveCount(101); await expect(f.closeButton).toBeFocused();
  });
  await t.test('failed pagination retains the graph and waits for an explicit retry', async t => {
    const f = await open(); t.after(f.close); await expect(f.entries).toHaveCount(100);
    f.fail(); await f.scrollToEnd(); await expect(f.retry).toBeVisible();
    await expect(f.entries).toHaveCount(100);
    await f.body.evaluate(element => { element.scrollTop = 0; });
    await f.scrollToEnd(); await expect(f.retry).toBeVisible();
    assert.equal(f.pageRequests(), 1, 'Scrolling must not loop on a failed page.');
    f.recover(); await f.retry.press('Enter'); await expect(f.entries).toHaveCount(101); await expect(f.entries.nth(100)).toBeFocused();
    assert.equal(f.pageRequests(), 2);
  });
  assert.deepEqual(errors, []);
});
