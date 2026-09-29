import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import type { ManagedRuntime } from '../src/environments/manager.ts';

test('browser API exposes an owned legacy target as a host-browser link after restart without rewriting saved config', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-browser-owned-url-')), repo = join(dataDir, 'repo');
  await mkdir(repo); await writeFile(join(repo, 'package.json'), '{}');
  const runtime: ManagedRuntime = {
    async prepareEnvironment({ environment, onUpdate }) {
      await onUpdate({ sandboxId: environment.id });
      return { status: 'ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:50397' }] };
    },
    environmentHealth: async () => ({ status: 'ready' }), environmentLogs: async () => '', destroySandbox: async () => {},
  };
  const start = () => startServer({ port: 0, repo, dataDir, environments: { runtime }, browser: { runtime: {
    capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: false }),
    start() { throw new Error('Reading app links must not start a browser or model.'); },
  } } });
  let app = await start(), token = (await (await fetch(app.url + '/api/session')).json()).token;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function post(path: string, body: unknown) {
    const response = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  await post('/api/scan', { path: repo });
  const pipeline = await post('/api/pipeline/action', { repoPath: repo, action: 'add-stage', name: 'Beta' });
  const stageId = pipeline.pipeline.stages.find((stage: { name: string }) => stage.name === 'Beta').id, context = { repoPath: repo, stageId }, query = new URLSearchParams(context);
  const view = async () => (await fetch(`${app.url}/api/browser?${query}`)).json();
  await post('/api/environments/plan', { ...context, plan: { services: {}, apps: { app: { start: 'node server.mjs', port: 3000 } }, fixtures: [] } });
  await post('/api/environments/create', context);
  let prepared = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await view()).preparation?.status === 'needs_setup') { prepared = true; break; }
    await delay(5);
  }
  assert.equal(prepared, true, 'The owned environment settles without starting discovery.');
  const legacy = 'http://host.docker.internal:50397/workspace?mode=uat', signIn = 'http://host.docker.internal:50397/login?next=%2Fworkspace#form';
  await post('/api/browser/config', { ...context, config: { targetUrl: legacy, signInUrl: signIn } });
  await app.close(); app = await start(); token = (await (await fetch(app.url + '/api/session')).json()).token;
  const current = await view();
  assert.equal(current.config.targetUrl, 'http://127.0.0.1:50397/workspace?mode=uat');
  assert.equal(current.config.signInUrl, 'http://127.0.0.1:50397/login?next=%2Fworkspace#form');
  const stored = JSON.parse(await readFile(join(dataDir, 'browser', 'state.json'), 'utf8'));
  const saved = Object.values(stored.configs) as { targetUrl: string; signInUrl: string }[];
  assert.deepEqual(saved.map(config => [config.targetUrl, config.signInUrl]), [[legacy, signIn]]);
  for (const targetUrl of ['https://preview.example/workspace', 'http://host.docker.internal:50398/workspace']) {
    await post('/api/browser/config', { ...context, config: { targetUrl } });
    assert.equal((await view()).config.targetUrl, targetUrl, 'External and unowned targets keep their own addresses.');
  }
});
