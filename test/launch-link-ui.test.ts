import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { startServer } from '../src/server.ts';

// Test files run concurrently, so each wait allows 10 seconds.
const expect = baseExpect.configure({ timeout: 10_000 });

// The real controller and page: without the session cookie the launch link sets, or with a stale one, the page shows one
// message; the link signs the browser in and leaves the secret out of the address.
test('the page asks for the printed link until it is opened, then loads without the secret in its address', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-ui-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const signedOut = page.getByRole('heading', { name: 'Open the link perpetual serve printed', exact: true });
  await page.goto(app.url);
  await expect(signedOut).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  // A cookie from another secret, such as another data directory's, is no session either.
  await context.addCookies([{ name: `perpetual-secret-${new URL(app.url).port}`, value: '0'.repeat(64), domain: '127.0.0.1', path: '/api' }]);
  await page.reload();
  await expect(signedOut).toBeVisible();
  await page.goto(app.launchUrl);
  await expect(page.getByRole('heading', { name: 'Connect your GitHub', exact: true })).toBeVisible();
  assert.equal(page.url(), `${app.url}/`);
  // A session that ends while the page is open ends the page the same way.
  await context.clearCookies();
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(signedOut).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});
