import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import type { ModelSettingsView, OpenRouterModelView } from '../contract/settings.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

const catalog: OpenRouterModelView = { models: ['a', 'b', 'c'].map(id => ({ id: `example/${id}`, name: `Example: Model ${id.toUpperCase()}`, provider: 'example' })), defaultModel: 'example/b', defaultEscalationModel: 'example/c' };
const capabilities = (model: string): ModelSettingsView => ({ provider: 'openrouter', model, escalationModel: 'example/c', baseUrl: 'https://openrouter.ai/api/v1', keyConfigured: true, modelConfigured: true });

// The real App owns navigation and mounts/unmounts the real Settings form; only HTTP is controlled.
test('Settings save completion survives leaving and reopening the page', { timeout: 60000 }, async t => {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  const warning = 'OpenRouter could not check this key.';
  for (const outcome of ['success', 'unchecked key', 'failure'] as const) await t.test(outcome, async t => {
    const saved = Promise.withResolvers<void>(), submitted: Record<string, unknown>[] = [];
    t.after(() => saved.resolve());
    let model = 'example/b';
    const page = await browser.newPage(); t.after(() => page.close());
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let result: unknown, status = 200;
      if (path === '/api/state') result = { scan: null, defaultRepo: '', pipeline: null };
      else if (path === '/api/session') result = { token: 'fixture-token' };
      else if (path === '/api/settings/models') result = catalog;
      else if (path === '/api/settings/model') {
        if (route.request().method() === 'POST') {
          const input: Record<string, unknown> = route.request().postDataJSON(); submitted.push(input);
          await saved.promise;
          if (outcome === 'failure') { status = 503; result = { error: 'Settings could not be saved. Try again.' }; }
          else { model = String(input.model); result = { capabilities: capabilities(model), ...(outcome === 'unchecked key' ? { warning } : {}) }; }
        } else result = { capabilities: capabilities(model) };
      } else { status = 404; result = { error: 'Unexpected fixture route.' }; }
      await route.fulfill({ status, json: result });
    });
    await page.goto(`${origin}/build/#settings`);
    const selection = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(selection).toContainText('Model B');
    await selection.click();
    await page.getByRole('option', { name: 'Model A', exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => submitted.length).toBe(1);
    await page.getByRole('button', { name: 'Pipeline', exact: true }).click();
    await expect(selection).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(selection).toContainText('Model A');
    await expect(selection).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    saved.resolve();
    if (outcome !== 'failure') {
      await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toHaveCount(0);
      await expect(selection).toContainText('Model A');
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
      // A key saved without OpenRouter's answer says so beside the saved settings.
      await expect(page.getByRole('status').filter({ hasText: warning })).toHaveCount(outcome === 'unchecked key' ? 1 : 0);
      assert.equal(model, 'example/a');
    } else {
      await expect(page.getByRole('alert')).toContainText('Settings could not be saved. Try again.');
      await expect(selection).toContainText('Model A');
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(selection).toContainText('Model B');
      assert.equal(model, 'example/b');
    }
    assert.deepEqual(submitted, [{ model: 'example/a', escalationModel: 'example/c' }]);
  });
});

test('Settings names a preselected model the controller does not use beside its Select, until it is saved', { timeout: 60000 }, async t => {
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), pageErrors: string[] = [], submitted: Record<string, unknown>[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // The saved model left the catalog, and no escalation model was ever saved.
  let saved: ModelSettingsView = { ...capabilities('example/retired'), escalationModel: '' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown, status = 200;
    if (path === '/api/state') result = { scan: null, defaultRepo: '', pipeline: null };
    else if (path === '/api/session') result = { token: 'fixture-token' };
    else if (path === '/api/settings/models') result = catalog;
    else if (path === '/api/settings/model') {
      if (route.request().method() === 'POST') {
        const input: Record<string, unknown> = route.request().postDataJSON(); submitted.push(input);
        saved = { ...saved, model: String(input.model), escalationModel: String(input.escalationModel) };
      }
      result = { capabilities: saved };
    } else { status = 404; result = { error: 'Unexpected fixture route.' }; }
    await route.fulfill({ status, json: result });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/#settings`);
  const model = page.getByRole('combobox', { name: 'Model', exact: true }), escalation = page.getByRole('combobox', { name: 'Escalation model', exact: true });
  await expect(model).toContainText('Model B');
  await expect(model).toHaveAccessibleDescription('Saved model unavailable');
  await expect(escalation).toContainText('Model C');
  await expect(escalation).toHaveAccessibleDescription('Not saved');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => submitted).toEqual([{ model: 'example/b', escalationModel: 'example/c' }]);
  await expect(page.getByText('Saved model unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Not saved', { exact: true })).toHaveCount(0);
  for (const select of [model, escalation]) await expect(select).not.toHaveAttribute('aria-describedby');
  await expect(model).toContainText('Model B');
  assert.deepEqual(pageErrors, []);
});
