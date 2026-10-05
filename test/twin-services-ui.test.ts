import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import type { TwinServicesReply } from '../contract/twin.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

// The stage card's Services list itself, updated through its public props as a rescan does.
test('a rescan keeps an open Connect dialog, and a failed services read says why and can be tried again', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import TwinServices from '/src/TwinServices.tsx';
    import '/src/index.css';
    const root = createRoot(document.getElementById('root'));
    window.addEventListener('fixture:services', event => root.render(React.createElement(TwinServices, event.detail)));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'twin-services-test', resolveId(id) { if (id.endsWith('/__services-ui.tsx')) return '\0services-ui.tsx'; }, load(id) { if (id === '\0services-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__services-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__services-ui', '<div id="root"></div><script type="module" src="/build/__services-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const services: TwinServicesReply = { generated: false, services: [{ id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: true, missing: [{ name: 'secretKey', label: 'Payments test secret key', secret: true }] }] };
  let failure = '', reads = 0;
  await page.route('**/api/twin/services?*', async route => {
    reads++;
    await route.fulfill(failure ? { status: 409, json: { error: failure } } : { json: services });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__services-ui`);
  const render = (scannedAt: string) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture:services', { detail })), { repoPath: '/acme/app', stageId: 'beta', scannedAt, environment: null });
  await render('2026-01-01T00:00:00Z');
  await page.getByRole('button', { name: /^Services/ }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Payments', exact: true }), key = dialog.getByLabel('Payments test secret key');
  await key.fill('sk_test_typed');
  // A gate moves the managed source: the scan changes and the services are read again.
  await render('2026-01-01T00:05:00Z');
  await expect.poll(() => reads).toBe(2);
  await expect(dialog).toBeVisible();
  await expect(key).toHaveValue('sk_test_typed');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  // A refused read shows its reason without expanding the list, and Try again reads again.
  failure = 'Finish or cancel GitHub sign-in first.';
  await render('2026-01-01T00:10:00Z');
  await expect(page.getByRole('alert')).toHaveText(failure);
  failure = '';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
});
