import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';

// Exercise production controls with neutral GitHub responses at the HTTP boundary.
test('GitHub sign-in recovery keeps the next action reachable without stealing focus', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-connect-recovery-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const pageErrors: string[] = [];
  async function open(failure: 'start' | 'poll' | 'attach', holdStart = false) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => pageErrors.push(error.message));
    let started = Promise.withResolvers<void>(), startReply = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<void>(), statusReply = Promise.withResolvers<void>();
    let recovering = false, connected = false, cancelled = 0, starts = 0, attaches = 0;
    if (!holdStart && failure !== 'start') startReply.resolve();
    const connection = () => ({ authenticated: connected, connected, account: connected ? { login: 'acme' } : null, source: null });
    await page.route('**/api/github/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/github/auth/start') {
        starts++; started.resolve(); await startReply.promise;
        if (failure === 'start' && !recovering) { await route.fulfill({ status: 503, json: { error: 'Sign-in could not start. Try again.' } }); return; }
        await route.fulfill({ json: { id: `fixture-${starts}`, status: 'pending', userCode: 'ABCD-EFGH' } }); return;
      }
      if (path === '/api/github/auth/status') {
        polled.resolve(); await statusReply.promise;
        if (failure === 'poll' && !recovering) { await route.fulfill({ status: 503, json: { error: 'Could not check sign-in. Try again.' } }); return; }
        await route.fulfill({ json: { id: `fixture-${starts}`, status: 'complete', account: { login: 'acme' } } }); return;
      }
      if (path === '/api/github/connect') {
        attaches++;
        if (failure === 'attach' && !recovering) { await route.fulfill({ status: 503, json: { error: 'Could not connect the account. Try again.' } }); return; }
        connected = true;
      }
      if (path === '/api/github/auth/cancel') cancelled++;
      await route.fulfill({ json: path === '/api/github/repositories' ? { repositories: [{ fullName: 'acme/app' }] } : connection() });
    });
    await page.goto(app.launchUrl);
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
    const signIn = dialog.getByRole('button', { name: 'Sign in with GitHub', exact: true });
    const codeLink = dialog.getByRole('link', { name: 'Copy code and open GitHub', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    return { page, dialog, signIn, codeLink, cancel, started: started.promise, polled: polled.promise,
      releaseStart: () => startReply.resolve(), releaseStatus: () => statusReply.resolve(),
      holdNextStart: () => { started = Promise.withResolvers<void>(); startReply = Promise.withResolvers<void>(); return started.promise; },
      recover: () => { recovering = true; startReply.resolve(); statusReply.resolve(); },
      counts: () => ({ cancelled, starts, attaches }),
      close: async () => { startReply.resolve(); statusReply.resolve(); await page.close(); },
    };
  }
  for (const failure of ['start', 'poll', 'attach'] as const) {
    await t.test(`${failure} failure returns focus to its retry action and can recover`, async t => {
      const f = await open(failure); t.after(f.close);
      await f.signIn.press('Enter'); await f.started;
      if (failure === 'start') {
        await expect(f.dialog.getByRole('status')).toHaveText('Preparing sign-in…'); f.releaseStart();
      } else {
        await expect(f.codeLink).toBeFocused(); await f.polled; f.releaseStatus();
      }
      await expect(f.dialog.getByRole('alert')).toBeVisible();
      const retry = failure === 'attach' ? f.dialog.getByRole('button', { name: 'Continue as acme', exact: true }) : f.signIn;
      await expect(retry).toBeFocused();
      f.recover(); await retry.press('Enter');
      await expect(f.dialog).toBeHidden();
      await expect(f.page.getByRole('combobox', { name: 'Repository', exact: true })).toBeEnabled();
      assert.equal(f.counts().attaches, failure === 'attach' ? 2 : 1);
    });
  }
  await t.test('a code arriving while Cancel is focused does not take focus', async t => {
    const f = await open('poll', true); t.after(f.close);
    await f.signIn.press('Enter'); await f.started;
    await f.cancel.focus(); f.releaseStart();
    await expect(f.codeLink).toBeVisible();
    await expect(f.cancel).toBeFocused();
    await f.cancel.press('Enter'); await expect(f.dialog).toBeHidden();
    await expect(f.page.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();
    assert.equal(f.counts().attaches, 0);
    await expect.poll(() => f.counts().cancelled).toBe(1);
  });
  await t.test('a polling failure preserves Cancel focus and closing cancels the pending sign-in', async t => {
    const f = await open('poll'); t.after(f.close);
    await f.signIn.press('Enter'); await expect(f.codeLink).toBeFocused();
    await f.polled; await f.cancel.focus(); f.releaseStatus();
    await expect(f.dialog.getByRole('alert')).toBeVisible();
    await expect(f.cancel).toBeFocused();
    await f.cancel.press('Enter'); await expect(f.dialog).toBeHidden();
    await expect(f.page.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();
    assert.equal(f.counts().attaches, 0);
  });
  await t.test('starting again clears the expired device code while the new request is pending', async t => {
    const f = await open('poll'); t.after(f.close);
    await f.signIn.press('Enter'); await expect(f.codeLink).toBeFocused();
    await f.polled; f.releaseStatus(); await expect(f.signIn).toBeFocused();
    const started = f.holdNextStart();
    await f.signIn.press('Enter'); await started;
    await expect(f.dialog.getByRole('status')).toHaveText('Preparing sign-in…');
    await expect(f.codeLink).toBeHidden();
    await expect(f.dialog.getByRole('textbox', { name: 'Enter this code on GitHub', exact: true })).toBeHidden();
  });
  assert.deepEqual(pageErrors, []);
});
