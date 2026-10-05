import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { startServer } from '../src/server.ts';

// Test files run concurrently, so each wait allows 10 seconds.
const expect = baseExpect.configure({ timeout: 10_000 });
const SIGNED_OUT = 'Open the link perpetual serve printed', SIGNED_IN = 'Connect your GitHub';

// The real controller and page: without the browser secret the launch link gives the page, or with another launch
// secret's, the page shows one message; the link signs the browser in and leaves the address without its secret.
test('the page asks for the printed link until it is opened, then loads without the secret in its address', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-ui-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const signedOut = page.getByRole('heading', { name: SIGNED_OUT, exact: true });
  await page.goto(app.url);
  await expect(signedOut).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  // A link from another launch secret, such as another data directory's, signs nothing in, and leaves the address too.
  await page.goto('about:blank');
  await page.goto(`${app.url}/#secret=${'0'.repeat(64)}`);
  await expect(signedOut).toBeVisible();
  assert.equal(page.url(), `${app.url}/`);
  // The printed link, opened over the signed-out page, signs it in.
  await page.goto(app.launchUrl);
  await expect(page.getByRole('heading', { name: SIGNED_IN, exact: true })).toBeVisible();
  assert.equal(page.url(), `${app.url}/`);
  // The browser stays signed in, in this tab and in another one.
  await page.reload();
  await expect(page.getByRole('heading', { name: SIGNED_IN, exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(app.url);
  await expect(other.getByRole('heading', { name: SIGNED_IN, exact: true })).toBeVisible();
  await other.close();
  // A secret the controller stops accepting while the page is open, as after the file is removed, ends the page the same way.
  await page.route('**/api/**', route => route.continue({ headers: { ...route.request().headers(), 'x-perpetual-browser-secret': '0'.repeat(64) } }));
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(signedOut).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});

// A twin's app runs the repository's code on another port of the same host, and its container reaches the controller
// through the host. With the interface signed in, opening that app in the same browser hands it nothing it could replay.
test('an app on another port of this host gets no credential from the signed-in browser that the controller accepts', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-launch-ports-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const sent: IncomingHttpHeaders[] = [];
  const twin = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) { sent.push(req.headers); res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Acme</title><img src="/api/logo" alt=""><script>fetch("/api/items").then(() => { document.title = "Loaded"; });</script>');
  });
  await new Promise<void>(resolve => twin.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await new Promise<void>(resolve => twin.close(() => resolve()));
    await app.close(); await rm(dir, { recursive: true, force: true });
  });
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(app.launchUrl);
  await expect(page.getByRole('heading', { name: SIGNED_IN, exact: true })).toBeVisible();
  // The secret the page keeps opens the API, so a request that carried it would be caught below.
  const kept = await page.evaluate(() => localStorage.getItem('perpetual-browser-secret'));
  assert.equal((await fetch(`${app.url}/api/session`, { headers: { 'X-Perpetual-Browser-Secret': kept ?? '' } })).status, 200);
  const acme = await context.newPage();
  await acme.goto(`http://127.0.0.1:${(twin.address() as AddressInfo).port}/`);
  await expect(acme).toHaveTitle('Loaded');
  await expect.poll(() => sent.length).toBeGreaterThanOrEqual(2);
  for (const headers of sent) {
    assert.equal(headers.cookie, undefined, 'The browser sends the app no cookie.');
    assert.equal(JSON.stringify(headers).includes(kept!), false);
    // Every value the app received, replayed from its container in either header, is refused.
    for (const value of Object.values(headers).flat()) for (const name of ['X-Perpetual-Secret', 'X-Perpetual-Browser-Secret']) {
      assert.equal((await fetch(`${app.url}/api/session`, { headers: { [name]: value ?? '' } })).status, 401, `${name}: ${value}`);
    }
  }
});
