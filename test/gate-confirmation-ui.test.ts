import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import type { StageGate } from '../contract/gate.ts';
import type { Stage } from '../contract/pipeline.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), repoPath = '/acme/app';
const stage: Stage = { id: 'beta', name: 'Beta', kind: 'sandbox', collapsed: false };
const gate = (extra: Partial<StageGate> = {}): StageGate => ({ id: 'gate-a', stageId: 'beta', sha: A, status: 'needs-release', reason: 'Review the blocked journey.', detectedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...extra });
type Props = { repoPath: string; stage: Stage; gate: StageGate | null };

// Mount the production controls and update only their public props, as the App's polls do.
test('a Sandbox release confirmation never follows a different gate, source or stage', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {GateActions} from '/src/StageGate.tsx'; import '/src/index.css';
    const root=createRoot(document.getElementById('root'));
    window.addEventListener('fixture:gate', event => root.render(React.createElement(GateActions,event.detail)));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'gate-confirmation-test', resolveId(id) { if (id.endsWith('/__gate-ui.tsx')) return '\0gate-ui.tsx'; },
    load(id) { if (id === '\0gate-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__gate-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__gate-ui', '<div id="root"></div><script type="module" src="/build/__gate-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const requests: unknown[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/gate/release') requests.push(route.request().postDataJSON());
    await route.fulfill({ status: path === '/api/session' || path === '/api/gate/release' ? 200 : 404, json: path === '/api/session' ? { token: 'fixture-token' } : {} });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__gate-ui`);
  const render = async (props: Props) => {
    await page.evaluate(input => window.dispatchEvent(new CustomEvent('fixture:gate', { detail: input })), props);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const dialog = page.getByRole('alertdialog');
  const original: Props = { repoPath, stage, gate: gate() };
  await render(original);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('Release aaaaaaa?');
  const changed: Props[] = [
    { ...original, gate: gate({ id: 'gate-b', sha: B }) },
    { ...original, gate: gate({ status: 'running' }) },
    { ...original, gate: null },
    { ...original, repoPath: '/acme/other' },
    { ...original, stage: { ...stage, id: 'gamma', name: 'Gamma' }, gate: gate({ stageId: 'gamma' }) },
    { ...original, gate: gate({ id: 'gate-new-at-same-commit' }) },
    { ...original, gate: gate({ detectedAt: '2026-01-01T00:02:00Z' }) },
  ];
  for (const props of changed) {
    await render(props);
    await expect(dialog.getByRole('heading')).toHaveText('Release aaaaaaa?');
    await expect(dialog.getByRole('button', { name: 'Release', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('changed');
  }
  assert.deepEqual(requests, [], 'Polling never grants consent for another release.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await render(changed[0]);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('Release bbbbbbb?');
  // A status-report timestamp change does not change the release being reviewed.
  await render({ ...changed[0], gate: gate({ id: 'gate-b', sha: B, updatedAt: '2026-01-01T00:01:00Z' }) });
  await dialog.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(requests, [{ repoPath: '/acme/app', stageId: 'beta', sha: B }]);
});
