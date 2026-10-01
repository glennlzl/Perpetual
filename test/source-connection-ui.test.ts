import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';

test('GitHub connection returns keyboard focus to its source controls', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-source-ui-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  let connected = false, releaseRepositories: (() => void) | undefined;
  const connectionRead = Promise.withResolvers<void>();
  const repositories = new Promise<void>(resolve => { releaseRepositories = resolve; });
  t.after(() => { connectionRead.resolve(); releaseRepositories?.(); });
  await page.route('**/api/github/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/github/connection') await connectionRead.promise;
    if (path === '/api/github/connect') connected = true;
    if (path === '/api/github/repositories') {
      await repositories;
      await route.fulfill({ json: { repositories: [{ fullName: 'acme/app' }] } }); return;
    }
    await route.fulfill({ json: { authenticated: true, connected, account: { login: 'acme' }, source: null } });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
  await expect(dialog.getByRole('status')).toHaveText('Checking GitHub…');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="sheet-content"]')).toBeFocused();
  connectionRead.resolve();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Continue as acme', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Continue as acme', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeFocused();
  releaseRepositories!();
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toBeFocused();
  assert.equal(connected, true);
  await page.reload();
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue as acme', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toBeFocused();
});
