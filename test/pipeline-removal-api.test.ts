import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetch, startServer } from './fixtures/controller.ts';
import { scopeId } from '../src/environments/usage.ts';
import type { ManagedRuntime } from '../src/environments/manager.ts';

async function fixture(t: TestContext, runtime?: ManagedRuntime) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-api-')), repo = join(dir, 'repo'), dataDir = join(dir, 'data');
  await mkdir(repo); await writeFile(join(repo, 'package.json'), '{}');
  let app: Awaited<ReturnType<typeof startServer>>, token: string;
  async function start() { app = await startServer({ port: 0, repo, dataDir, environments: { runtime }, browser: { runtime: { capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: false }), start() { throw new Error('Deletion must not start a browser or model.'); } } } }); token = (await (await fetch(app.url + '/api/session')).json()).token; }
  async function request(path: string, input?: Record<string, unknown>, authenticated = true) {
    const res = await fetch(app.url + path, { method: input ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Perpetual-Token': token } : {}) }, body: input ? JSON.stringify(input) : undefined });
    return { status: res.status, body: await res.json() };
  }
  async function settled() {
    for (let n = 0; n < 200; n++) { const { body } = await request('/api/state'); if (body.pipelineRemoval?.status === 'completed' || body.pipelineRemoval?.status === 'failed') return body; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Pipeline removal did not settle');
  }
  await start(); await request('/api/scan', { path: repo });
  const added = await request('/api/pipeline/action', { repoPath: repo, action: 'add-stage', name: 'Beta' });
  const beta: string = added.body.pipeline.stages.find((stage: { kind: string }) => stage.kind === 'sandbox').id;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { repo, dataDir, beta, request, settled, start, close: () => app.close() };
}

test('pipeline deletion clears its test workspace, retains the project, and survives rescan and restart', async t => {
  const f = await fixture(t), input = { repoPath: f.repo, pipelineId: f.repo }, context = { repoPath: f.repo, stageId: f.beta };
  const item = { id: 'purchase', name: 'Complete purchase', goal: 'Buy an item', expectedOutcomes: ['Order saved'], needsReview: true, selected: false };
  assert.equal((await f.request('/api/browser/cases', { ...context, cases: [item] })).status, 200);
  assert.equal((await f.request('/api/browser/config', { ...context, config: { targetUrl: 'http://localhost:3000' } })).status, 200);
  assert.equal((await f.request('/api/pipeline/remove', input, false)).status, 403);
  assert.equal((await f.request('/api/pipeline/remove', { ...input, pipelineId: 'another-pipeline' })).status, 409);
  assert.equal((await f.request('/api/pipeline/remove', input)).status, 202);
  const state = await f.settled(); assert.equal(state.pipelineRemoval.status, 'completed'); assert.equal(state.pipeline, null); assert.equal(state.scan.repo.path, f.repo);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'browser', 'state.json'), 'utf8'));
  const key = scopeId({ key: f.repo, stageId: f.beta });
  assert.equal(saved.cases[key], undefined); assert.equal(saved.configs[key], undefined);
  assert.equal((await f.request('/api/pipeline/action', { repoPath: f.repo, action: 'add-stage', name: 'Gamma' })).status, 409);
  await f.request('/api/scan', { path: f.repo }); assert.equal((await f.request('/api/state')).body.pipeline, null);
  await f.close(); await f.start(); assert.equal((await f.request('/api/state')).body.pipeline, null);
  assert.equal(await readFile(join(f.repo, 'package.json'), 'utf8'), '{}');
});

test('explicit recreation uses a fresh resource identity and deletes Sandbox stages in that identity', async t => {
  const f = await fixture(t);
  await f.request('/api/pipeline/remove', { repoPath: f.repo, pipelineId: f.repo }); await f.settled();
  const created = await f.request('/api/pipeline/create', { repoPath: f.repo }); assert.equal(created.status, 200);
  const id: string = created.body.pipeline.id; assert.match(id, /^pipeline:/); assert.notEqual(id, f.repo);
  assert.equal((await f.request('/api/pipeline/create', { repoPath: f.repo })).status, 409);
  assert.equal((await f.request('/api/pipeline/remove', { repoPath: f.repo, pipelineId: f.repo })).status, 409);
  assert.equal((await f.request('/api/pipeline/action', { repoPath: f.repo, action: 'toggle-stage', stageId: 'build' })).status, 409);
  const added = await f.request('/api/pipeline/action', { repoPath: f.repo, pipelineId: id, action: 'add-stage', name: 'Gamma' }); assert.equal(added.status, 200);
  assert.equal((await f.request('/api/state')).body.pipelineId, id);
  assert.equal((await f.request('/api/pipeline/remove', { repoPath: f.repo, pipelineId: id })).status, 202);
  const state = await f.settled(); assert.equal(state.pipelineRemoval.status, 'completed'); assert.equal(state.pipeline, null);
});

test('failed owned sandbox cleanup retains the pipeline and blocks edits until explicit retry', async t => {
  let fail = true;
  const destroyed: string[] = [];
  const runtime: ManagedRuntime = {
    async prepareEnvironment({ environment, onUpdate }) { await onUpdate({ sandboxId: environment.id }); return { status: 'ready', services: [], apps: [] }; },
    environmentHealth: async () => ({ status: 'ready' }), environmentLogs: async () => '',
    async destroySandbox({ environment }) { destroyed.push(environment.id); if (fail) throw new Error('Sandbox cleanup failed'); },
  };
  const f = await fixture(t, runtime), context = { repoPath: f.repo, stageId: f.beta };
  const plan = await f.request('/api/environments/plan', { ...context, plan: { services: {}, apps: { web: { start: 'node server.mjs', port: 3000 } }, fixtures: [] } }); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const created = await f.request('/api/environments/create', context); assert.equal(created.status, 202, JSON.stringify(created.body));
  let ready = false;
  for (let n = 0; n < 200; n++) { const view = (await f.request('/api/state')).body; if (view.environments[0]?.status === 'ready') { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(ready, 'The owned environment must be ready before testing cleanup failure.');
  // Ready precedes the browser preparation hook's final save and lease release.
  // Shutdown joins that admitted work; restart keeps the ready twin without replaying discovery.
  await f.close(); await f.start();
  assert.equal((await f.request('/api/state')).body.environments[0]?.status, 'ready');
  assert.equal(destroyed.length, 0, 'Settling creation must preserve the ready environment.');
  const input = { repoPath: f.repo, pipelineId: f.repo };
  assert.equal((await f.request('/api/pipeline/remove', input)).status, 202);
  const failed = await f.settled(); assert.equal(failed.pipelineRemoval.status, 'failed'); assert.ok(failed.pipeline);
  assert.match(failed.pipelineRemoval.error, /cleanup failed/i);
  assert.equal(destroyed.length, 1, 'Deletion must attempt the owned sandbox cleanup exactly once.');
  assert.equal((await f.request('/api/pipeline/action', { repoPath: f.repo, action: 'add-stage', name: 'Gamma' })).status, 409);
  await f.close(); await f.start();
  assert.equal((await f.request('/api/state')).body.pipelineRemoval.status, 'failed'); assert.equal(destroyed.length, 1);
  fail = false;
  assert.equal((await f.request('/api/pipeline/remove', input)).status, 202);
  const done = await f.settled(); assert.equal(done.pipelineRemoval.status, 'completed'); assert.equal(done.pipeline, null); assert.equal(destroyed.length, 2);
});

test('restart completes the deletion commit without deleting another selected project', async t => {
  const f = await fixture(t);
  await f.request('/api/pipeline/remove', { repoPath: f.repo, pipelineId: f.repo }); await f.settled();
  const other = join(f.dataDir, 'another-repo'); await mkdir(other); await writeFile(join(other, 'package.json'), '{}');
  await f.request('/api/scan', { path: other }); await f.close();
  const file = join(f.dataDir, 'pipeline-removals', 'state.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.removals[0].status = 'removing'; await writeFile(file, JSON.stringify(saved));
  await f.start();
  for (let n = 0; n < 200; n++) { const record = JSON.parse(await readFile(file, 'utf8')); if (record.removals[0].status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  const state = (await f.request('/api/state')).body;
  assert.equal(state.scan.repo.path, other); assert.ok(state.pipeline); assert.equal(state.pipeline.repoPath, other);
  await f.request('/api/scan', { path: f.repo }); assert.equal((await f.request('/api/state')).body.pipeline, null);
});
