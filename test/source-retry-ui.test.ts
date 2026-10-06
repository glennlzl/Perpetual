import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';

// Real production controls, with failed GitHub reads supplied only at the HTTP boundary.
test('Source read recovery keeps keyboard focus and the user’s draft', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-source-retry-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const pageErrors: string[] = [];
  async function openSource(kind: 'repositories' | 'branches' | 'connection') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => pageErrors.push(error.message));
    let success = false, reads = 0;
    let held: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let started: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    const connection = { authenticated: true, connected: true, account: { login: 'acme' }, source: { repository: 'acme/app', branch: 'main', rootDirectory: '/' } };
    await page.route('**/api/github/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/github/${kind}`) {
        reads++; started?.resolve();
        if (held) await held.promise;
        if (!success) { await route.fulfill({ status: 503, json: { error: `Could not load ${kind}.` } }); return; }
      }
      const reply = path === '/api/github/repositories' ? { repositories: [{ fullName: 'acme/app' }] }
        : path === '/api/github/branches' ? { branches: [{ name: 'main' }, { name: 'feature/preview' }], defaultBranch: 'main' } : connection;
      await route.fulfill({ json: reply });
    });
    await page.goto(app.launchUrl);
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
    if (kind === 'connection') {
      await expect(dialog.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();
    } else await expect(dialog).toBeHidden();
    const retry = page.getByRole('button', { name: kind === 'connection' ? 'Try again' : `Retry ${kind}`, exact: true });
    const recovered = kind === 'connection' ? page.getByRole('button', { name: 'Disconnect', exact: true })
      : page.getByRole('combobox', { name: kind === 'repositories' ? 'Repository' : 'Branch', exact: true });
    await expect(retry).toBeVisible();
    return { page, retry, recovered, reads: () => reads, succeed: () => { success = true; },
      hold() { held = Promise.withResolvers<void>(); started = Promise.withResolvers<void>(); return started.promise; },
      release() { held?.resolve(); held = null; },
    };
  }
  for (const kind of ['repositories', 'branches', 'connection'] as const) {
    await t.test(`${kind}: pending and failed retry keep focus; success focuses the recovered control`, async t => {
      const fixture = await openSource(kind), { page, retry, recovered } = fixture;
      t.after(async () => { fixture.release(); await page.close(); });
      const root = page.getByRole('textbox', { name: 'Root directory', exact: true });
      if (kind !== 'connection') await root.fill('web');
      const started = fixture.hold(), before = fixture.reads();
      await retry.press('Enter'); await started;
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute('aria-busy', 'true');
      await retry.press('Enter');
      fixture.release();
      await expect(page.getByRole('alert')).toHaveText(`Could not load ${kind}.`);
      await expect(retry).toBeFocused();
      assert.equal(fixture.reads(), before + 1, 'A repeated activation during the same read must not start another request.');
      fixture.succeed();
      await retry.press('Enter');
      await expect(retry).toBeHidden();
      await expect(recovered).toBeFocused();
      if (kind !== 'connection') {
        await expect(root).toHaveValue('web');
        await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toHaveText('acme/app');
        await expect(page.getByRole('combobox', { name: 'Branch', exact: true })).toHaveText('main');
      }
    });
  }
  await t.test('a completed retry does not steal focus from another field or a closed inspector', async t => {
    const fixture = await openSource('repositories'), { page, retry, recovered } = fixture;
    t.after(async () => { fixture.release(); await page.close(); });
    const started = fixture.hold(); fixture.succeed();
    await retry.press('Enter'); await started;
    const root = page.getByRole('textbox', { name: 'Root directory', exact: true });
    await root.fill('web-edited'); fixture.release();
    await expect(recovered).toBeEnabled();
    await expect(root).toBeFocused();
    await expect(root).toHaveValue('web-edited');
    const closing = await openSource('branches');
    t.after(async () => { closing.release(); await closing.page.close(); });
    const pending = closing.hold(); closing.succeed();
    await closing.retry.press('Enter'); await pending;
    await closing.page.getByRole('button', { name: 'Close', exact: true }).click();
    const opener = closing.page.getByRole('button', { name: 'Connect GitHub', exact: true });
    await expect(opener).toBeFocused();
    const reply = closing.page.waitForResponse(response => new URL(response.url()).pathname === '/api/github/branches');
    closing.release(); await reply;
    await expect(opener).toBeFocused();
  });
  assert.deepEqual(pageErrors, []);
});
