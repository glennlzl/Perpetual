import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import type { ReleaseReply } from '../contract/releases.ts';

// CI runs test files concurrently, so every wait allows ten seconds.
const expect = playwrightExpect.configure({ timeout: 10_000 });

const A = 'a'.repeat(40), B = 'b'.repeat(40), repoPath = '/acme/app';
const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
const release = (extra: Partial<ReleaseReply> = {}): ReleaseReply => ({ repoPath, sha: A, target, canDeploy: true, blockedReason: null, current: null, recent: [], ...extra });

// Mount the Production controls and update only their public props, as the App's release poll does.
test('Production asks for a target without explanatory copy and deploys only the confirmed commit and target', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ProductionRelease} from '/src/ProductionRelease.tsx'; import '/src/index.css';
    const root=createRoot(document.getElementById('root'));
    window.addEventListener('fixture:release', event => root.render(React.createElement(ProductionRelease, event.detail)));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'production-release-test', resolveId(id) { if (id.endsWith('/__release-ui.tsx')) return '\0release-ui.tsx'; }, load(id) { if (id === '\0release-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__release-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__release-ui', '<div id="root"></div><script type="module" src="/build/__release-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [], posts: { path: string; body: unknown }[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && path !== '/api/session') posts.push({ path, body: route.request().postDataJSON() });
    await route.fulfill({ json: path === '/api/session' ? { token: 'fixture-token' } : {} });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__release-ui`);
  const render = async (view: ReleaseReply) => {
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture:release', { detail })), { repoPath, view });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };

  // Without a target, Configure deployment is the next step; neither the card nor the dialog explains it.
  await render(release({ target: null, canDeploy: false, blockedReason: 'Configure a deployment target.' }));
  await expect(page.getByRole('button', { name: 'Configure deployment', exact: true })).toBeVisible();
  await expect(page.getByText('Configure a deployment target.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Configure deployment', exact: true }).click();
  const targetDialog = page.getByRole('dialog', { name: 'Deployment target', exact: true });
  await expect(targetDialog).not.toHaveAttribute('aria-describedby');
  await targetDialog.getByLabel('Deployment workflow').fill(target.workflowPath);
  await targetDialog.getByRole('button', { name: 'Save target', exact: true }).click();
  await expect(targetDialog).toHaveCount(0);
  assert.deepEqual(posts, [{ path: '/api/releases/configure', body: { repoPath, target } }]);

  // A configured target that the gates do not allow yet says why beside its disabled Deploy.
  const reason = 'Every Sandbox gate must pass or be explicitly released for this commit.';
  await render(release({ canDeploy: false, blockedReason: reason }));
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeDisabled();

  // The confirmation stays bound to the commit and target it showed while polls change them.
  await render(release());
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('heading')).toHaveText('Deploy aaaaaaa?');
  for (const changed of [release({ sha: B }), release({ target: { ...target, environment: 'staging' } }), release({ canDeploy: false, blockedReason: reason })]) {
    await render(changed);
    await expect(confirm.getByRole('heading')).toHaveText('Deploy aaaaaaa?');
    await expect(confirm.getByRole('button', { name: 'Deploy', exact: true })).toBeDisabled();
    await expect(confirm.getByRole('alert')).toBeVisible();
  }
  assert.equal(posts.length, 1, 'Polling never grants consent for another deployment.');
  await render(release({ recent: [] }));
  await confirm.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  assert.deepEqual(posts.at(-1), { path: '/api/releases/deploy', body: { repoPath, sha: A, target } });
  assert.deepEqual(pageErrors, []);
});
