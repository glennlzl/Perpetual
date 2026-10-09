import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { startServer } from '../src/server.ts';
import type { OpenRouterModelView } from '../contract/settings.ts';

const expect = baseExpect.configure({ timeout: 10_000 });
type ObservedWindow = Window & { styleViolations: string[] };

// Exercise the built application under the controller's actual CSP, rather than
// a Vite fixture without that policy. Catalog data is supplied at the HTTP boundary.
test('dialogs and model Selects apply authorized runtime CSS after loading and reloading the page', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-style-csp-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'data') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  const catalog: OpenRouterModelView = { models: [{ id: 'example/model', name: 'Example: Model', provider: 'example' }], defaultModel: 'example/model', defaultEscalationModel: 'example/model' };
  await page.route('**/api/settings/models', route => route.fulfill({ json: catalog }));
  await page.addInitScript(() => {
    const observed = window as unknown as ObservedWindow;
    observed.styleViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective.startsWith('style-src')) observed.styleViolations.push(event.effectiveDirective);
    });
  });
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const styles = () => page.evaluate(() => {
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')!.content;
    return { nonce, styles: [...document.querySelectorAll('style')].map(style => ({ authorized: style.nonce === nonce, applied: style.sheet !== null })) };
  });
  const dialogStyles = await styles();
  assert.ok(dialogStyles.styles.length > 0, 'The modal exercises scroll-lock CSS.');
  assert.ok(dialogStyles.styles.every(style => style.authorized && style.applied));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(`${app.url}/#settings`);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    const selection = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(selection).toBeEnabled();
    await selection.click();
    await expect(page.getByRole('option', { name: 'Example: Model', exact: true })).toBeVisible();
    const selectedStyles = await styles();
    if (reload) assert.notEqual(selectedStyles.nonce, dialogStyles.nonce, 'A reloaded document receives a fresh nonce.');
    else assert.equal(selectedStyles.nonce, dialogStyles.nonce, 'Navigation within a document keeps its nonce.');
    assert.ok(selectedStyles.styles.length >= 2, 'The Select exercises scroll-lock and viewport CSS.');
    assert.ok(selectedStyles.styles.every(style => style.authorized && style.applied));
    assert.deepEqual(await page.evaluate(() => (window as unknown as ObservedWindow).styleViolations), []);
    await page.keyboard.press('Escape');
  }
  // Preview annotation styles intentionally work without the runtime nonce.
  await page.evaluate(() => {
    const preview = document.createElement('style');
    preview.textContent = 'body { --preview-style: applied; }';
    document.head.appendChild(preview);
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--preview-style')), 'applied');
  assert.deepEqual(await page.evaluate(() => (window as unknown as ObservedWindow).styleViolations), []);
  // Allowing those blocks must not permit style attributes in the built app.
  const attributeStyle = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.setAttribute('style', '--unauthorized-style: applied;');
    return getComputedStyle(probe).getPropertyValue('--unauthorized-style');
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).styleViolations)).toEqual(['style-src-attr']);
  assert.equal(attributeStyle, '');
});
