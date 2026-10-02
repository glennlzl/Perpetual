import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createUiServer } from './fixtures/ui-server.ts';
import { chromium, expect } from '@playwright/test';
import type { Environment } from '../contract/environment.ts';

test('the environment inspector exposes actual preparation, logs and a scoped Stop without adding tabs', { timeout: 60000 }, async t => {
  let environment: Environment = { id: 'environment-1', stageId: 'beta', status: 'preparing', step: 'Setting up Supabase', createdAt: '2026-01-01T00:00:00Z',
    timings: [{ step: 'Copying source', ms: 120 }], attempts: [{ attempt: 1, stage: 'build', summary: 'Install failed.' }] };
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const browserView = { cases: [], runs: [], accounts: [], specs: {}, preparation: null, config: { targetUrl: '', scope: '', requirements: '', maxSteps: 60 },
    capabilities: { modelConfigured: false, runtimeInstalled: true, browserInstalled: true, playwright: { browserInstalled: true } } };
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import EnvironmentSettings from '/src/EnvironmentSettings.tsx';
    import {TestWorkspaceContext} from '/src/lib/use-test-workspace.tsx';
    import {createTestWorkspace} from '/src/lib/test-workspace.ts';
    import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
    import {Sheet, SheetContent} from '/src/components/ui/sheet.tsx'; import '/src/index.css';
    const controller=async(path,input)=>(await fetch('/build/__controller'+path,input===undefined?{}:{method:'POST',body:JSON.stringify(input)})).json();
    const workspace=createTestWorkspace({controller,pollInterval:0});
    workspace.activate({path:'/acme/app',branch:'main'},{environments:(await controller('/api/environments')).environments,browserTests:{beta:await controller('/api/browser')}});
    createRoot(document.getElementById('root')).render(React.createElement(TestWorkspaceContext.Provider,{value:workspace},React.createElement(TooltipProvider,{},React.createElement(Sheet,{open:true},React.createElement(SheetContent,{},React.createElement(EnvironmentSettings,{repoPath:'/acme/app',stage:{id:'beta',name:'Beta',kind:'sandbox'},onClose:()=>{}}))))));
  `;
  const server = await createUiServer(t, { configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'environment-inspector-test', resolveId(id) { if (id.endsWith('/__environment-ui.tsx')) return '\0environment-ui.tsx'; },
    load(id) { if (id === '\0environment-ui.tsx') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url?.includes('/__controller') || req.url?.startsWith('/api/')) {
        const path = (req.url.includes('/__controller') ? req.url.split('/__controller')[1] : req.url).split('?')[0];
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk;
          const input = JSON.parse(body); requests.push({ path, input });
          if (path === '/api/environments/cancel') environment = { ...environment, step: 'Stopping', cancellationRequestedAt: '2026-01-01T00:01:00Z' };
        }
        const reply = path === '/api/session' ? { token: 'fixture-token' } : path.endsWith('/logs') ? { logs: 'Downloading packages\nAPI_KEY=[REDACTED]' }
          : path.endsWith('/cancel') ? { environment } : path === '/api/environments' ? { environments: [environment], plan: {} } : browserView;
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply)); return;
      }
      if (req.url === '/build/__environment-ui') {
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__environment-ui', '<div id="root"></div><script type="module" src="/build/__environment-ui.tsx"></script>')); return;
      }
      next();
    }); },
  }] });
  await server.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__environment-ui`);
  await expect(page.getByText('Setting up Supabase', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.getByText('Downloading packages', { exact: false })).toBeVisible();
  await expect(page.getByText('Install failed.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  assert.deepEqual(requests.find(item => item.path.endsWith('/cancel'))?.input, { id: 'environment-1', repoPath: '/acme/app', stageId: 'beta' });
  environment = { ...environment, status: 'failed', step: 'Stopped', failedStep: 'Stopping', cleanedAt: '2026-01-01T00:01:01Z', error: 'Environment creation cancelled.' };
  await page.reload();
  await expect(page.getByText('Stopped', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Stopping', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Failed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});
