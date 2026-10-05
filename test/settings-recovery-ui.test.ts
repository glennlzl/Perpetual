import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../src/server.ts';

test('Settings read and save recovery preserve the draft and keyboard position', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-settings-recovery-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'state') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const pageErrors: string[] = [];
  async function open(kind: 'settings' | 'catalog' | 'save') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000); page.on('pageerror', error => pageErrors.push(error.message));
    let success = false, requests = 0;
    let held: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let started: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    const models = { models: [{ id: 'acme/default', name: 'Acme: Default', provider: 'acme' }, { id: 'acme/strong', name: 'Acme: Strong', provider: 'acme' }], defaultModel: 'acme/default', defaultEscalationModel: 'acme/strong' };
    let model = 'acme/default';
    await page.route('**/api/settings/*', async route => {
      const path = new URL(route.request().url()).pathname, post = route.request().method() === 'POST';
      const target = kind === 'save' ? post : !post && path === (kind === 'settings' ? '/api/settings/model' : '/api/settings/models');
      if (target) {
        requests++; started?.resolve(); if (held) await held.promise;
        if (!success) { await route.fulfill({ status: 503, json: { error: 'Settings request failed. Try again.' } }); return; }
      }
      if (post) model = route.request().postDataJSON().model;
      await route.fulfill({ json: path.endsWith('/models') ? models : { capabilities: { provider: 'openrouter', model, escalationModel: 'acme/strong', keyConfigured: true, modelConfigured: true } } });
    });
    await page.goto(app.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const key = page.getByRole('textbox', { name: 'OpenRouter API Key', exact: true });
    const modelSelect = page.getByRole('combobox', { name: 'Model', exact: true });
    const retry = page.getByRole('button', { name: kind === 'settings' ? 'Try again' : kind === 'catalog' ? 'Reload models' : 'Save changes', exact: true });
    return { page, key, modelSelect, retry, succeed: () => { success = true; }, requests: () => requests,
      hold() { held = Promise.withResolvers<void>(); started = Promise.withResolvers<void>(); return started.promise; },
      release() { held?.resolve(); held = null; },
      close: async () => { held?.resolve(); await page.close(); },
    };
  }
  for (const kind of ['settings', 'catalog'] as const) {
    await t.test(`${kind} retry stays reachable and focuses recovered settings`, async t => {
      const f = await open(kind); t.after(f.close);
      await expect(f.retry).toBeVisible();
      const started = f.hold(), before = f.requests();
      await f.retry.press('Enter'); await started;
      await expect(f.retry).toBeFocused(); await expect(f.retry).toHaveAttribute('aria-busy', 'true');
      await f.retry.press('Enter'); f.release();
      await expect(f.page.getByRole('alert')).toHaveText('Settings request failed. Try again.');
      await expect(f.retry).toBeFocused(); assert.equal(f.requests(), before + 1);
      f.succeed(); await f.retry.press('Enter'); await expect(f.retry).toBeHidden();
      await expect(kind === 'settings' ? f.key : f.modelSelect).toBeFocused();
      await expect(f.modelSelect).toHaveText('Acme: Default');
      await expect(f.page.getByRole('combobox', { name: 'Escalation model', exact: true })).toHaveText('Acme: Strong');
      await expect(f.page.getByRole('button', { name: 'Discard changes', exact: true })).toBeHidden();
    });
  }
  await t.test('failed save retains the selected model and focus, then a retry saves it', async t => {
    const f = await open('save'); t.after(f.close);
    await f.modelSelect.click(); await f.page.getByRole('option', { name: 'Strong', exact: true }).click();
    await f.retry.press('Enter'); await expect(f.page.getByRole('alert')).toBeVisible();
    await expect(f.retry).toBeFocused(); await expect(f.modelSelect).toHaveText('Acme: Strong');
    f.succeed(); await f.retry.press('Enter'); await expect(f.page.getByRole('status')).toHaveText('Saved');
    await expect(f.key).toBeFocused(); await expect(f.modelSelect).toHaveText('Acme: Strong');
    await expect(f.page.getByRole('button', { name: 'Discard changes', exact: true })).toBeHidden();
  });
  await t.test('an in-flight model retry does not take focus from another control or navigation', async t => {
    const f = await open('catalog'); t.after(f.close); await expect(f.retry).toBeVisible();
    const started = f.hold(); f.succeed(); await f.retry.press('Enter'); await started;
    await f.key.focus(); f.release(); await expect(f.modelSelect).toBeEnabled(); await expect(f.key).toBeFocused();
    const leaving = await open('catalog'); t.after(leaving.close); await expect(leaving.retry).toBeVisible();
    const pending = leaving.hold(); leaving.succeed(); await leaving.retry.press('Enter'); await pending;
    const pipeline = leaving.page.getByRole('button', { name: 'Pipeline', exact: true });
    await pipeline.click(); const response = leaving.page.waitForResponse(r => new URL(r.url()).pathname === '/api/settings/models');
    leaving.release(); await response; await expect(pipeline).toBeFocused();
  });
  assert.deepEqual(pageErrors, []);
});
