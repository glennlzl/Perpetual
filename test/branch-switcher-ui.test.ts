import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import type { GitHubConnection } from '../contract/github.ts';

// The canvas branch Select itself, with GitHub replies supplied only at the HTTP boundary.
test('the canvas branch Select lists, pages, refreshes and switches the repository branches', { timeout: 60000 }, async t => {
  const entry = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import BranchSwitcher from '/src/BranchSwitcher.tsx';
    import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
    import '/src/index.css';
    const root = createRoot(document.getElementById('root'));
    window.calls = []; window.failSwitch = '';
    const onSourceSave = async selection => { window.calls.push(['save', selection]); if (window.failSwitch) throw new Error(window.failSwitch); };
    const onLocalScan = async path => { window.calls.push(['local', path]); };
    window.addEventListener('fixture:scan', event => root.render(React.createElement(TooltipProvider, {}, React.createElement(BranchSwitcher, { scan: event.detail, onSourceSave, onLocalScan }))));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'branch-switcher-test', resolveId(id) { if (id.endsWith('/__branches-ui.tsx')) return '\0branches-ui.tsx'; }, load(id) { if (id === '\0branches-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/build/__branches-ui') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__branches-ui', '<div id="root"></div><script type="module" src="/build/__branches-ui.tsx"></script>'));
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const managed = '/data/sources/github-a/app';
  const connection: GitHubConnection = { available: true, authenticated: true, connected: true, account: { login: 'acme', name: null }, source: { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: managed }, localCheckout: { path: '/work/app', branch: 'main' } };
  let pages = [['main', 'feature/a', 'feature/b'], ['release']], readFailure = '';
  const reads: number[] = [];
  await page.route('**/api/github/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/github/connection') return route.fulfill({ json: connection });
    const number = Number(url.searchParams.get('page'));
    reads.push(number);
    if (readFailure) return route.fulfill({ status: 403, json: { error: readFailure } });
    await route.fulfill({ json: { branches: pages[number - 1].map(name => ({ name })), nextPage: number < pages.length ? number + 1 : null, defaultBranch: 'main' } });
  });
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__branches-ui`);
  await page.evaluate(path => window.dispatchEvent(new CustomEvent('fixture:scan', { detail: { repo: { path, name: 'app', branch: 'main', remote: 'https://github.com/acme/app.git' } } })), managed);
  const trigger = page.getByRole('combobox', { name: 'Switch branch: main', exact: true }), list = page.getByRole('listbox');
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);

  // Branches group by prefix after the current branch; Load more appends the next page and reopens the list.
  await trigger.click();
  await expect(list.getByRole('option', { name: 'b', exact: true })).toBeVisible();
  await expect(list.getByText('feature/', { exact: true })).toBeVisible();
  await list.getByRole('option', { name: 'Load more…', exact: true }).click();
  await expect(list.getByRole('option', { name: 'release', exact: true })).toBeVisible();
  assert.deepEqual(reads, [1, 2]);
  await page.keyboard.press('Escape');
  // A list read moments ago opens at once; a newer push shows once that list is older than half a minute.
  pages = [['main', 'feature/a', 'feature/b', 'hotfix'], ['release']];
  await trigger.click();
  await expect(list.getByRole('option', { name: 'release', exact: true })).toBeVisible();
  assert.deepEqual(reads, [1, 2], 'Reopening at once reuses the list it read.');
  await page.keyboard.press('Escape');
  await page.clock.fastForward(31_000);
  await trigger.click();
  await expect(list.getByRole('option', { name: 'hotfix', exact: true })).toBeVisible();
  assert.deepEqual(reads, [1, 2, 1]);
  await page.keyboard.press('Escape');

  // A failed read says why, and Try again reads again.
  readFailure = 'GitHub denied access. Check repository permissions and any organization SSO authorization for GitHub CLI.';
  await page.clock.fastForward(31_000);
  await trigger.click();
  await expect(list.getByRole('alert')).toHaveText(readFailure);
  readFailure = '';
  await list.getByRole('option', { name: 'Try again', exact: true }).click();
  await expect(list.getByRole('option', { name: 'hotfix', exact: true })).toBeVisible();

  // Choosing a branch saves the connected source at that branch; a failed switch reads the list again on the next open.
  await page.evaluate(() => { (window as unknown as { failSwitch: string }).failSwitch = 'The selected branch is no longer available. Refresh the branch list.'; });
  await list.getByRole('option', { name: 'hotfix', exact: true }).click();
  await expect.poll(calls).toEqual([['save', { repository: 'acme/app', branch: 'hotfix', rootDirectory: '/' }]]);
  pages = [['main', 'feature/a', 'feature/b'], ['release']];
  const before = reads.length;
  await trigger.click();
  await expect(list.getByRole('option', { name: 'release', exact: true })).toHaveCount(0);
  await expect(list.getByRole('option', { name: 'hotfix', exact: true })).toHaveCount(0);
  assert.equal(reads.length, before + 1, 'The list a failed switch relied on is read again.');

  // The original checkout stays reachable and is rescanned, never switched through GitHub.
  await list.getByRole('option', { name: 'main Local', exact: true }).click();
  await expect.poll(async () => (await calls()).at(-1)).toEqual(['local', '/work/app']);
  assert.deepEqual(pageErrors, []);
});
