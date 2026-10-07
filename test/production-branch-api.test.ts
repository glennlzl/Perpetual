import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, startServer } from './fixtures/controller.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import { applyPipelineAction, defaultPipeline, normalizedPipeline } from '../src/pipeline.ts';
import type { Controller } from '../src/server.ts';

const sha = 'a'.repeat(40), time = '2026-10-06T12:00:00Z';
const pipelineId = 'pipeline:12345678-1234-1234-1234-123456789abc', key = 'github:acme/app:/';

async function fixture(t: TestContext, { disconnected = false, productionBranch, unresolved = false }: { disconnected?: boolean; productionBranch?: string; unresolved?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-production-branch-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const stateFile = join(dataDir, 'state.json');
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha, branch: 'dev', remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: time };
  const source = { repository: 'acme/app', branch: 'dev', rootDirectory: '/', scanPath: dir, checkoutPath: dir, sha, connectedAccount: 'tester', savedAt: time };
  const pipeline = { ...defaultPipeline(dir), id: pipelineId, ...(productionBranch ? { productionBranch } : {}) };
  await writeFile(stateFile, JSON.stringify({ schema: 1, state: { scan, source, pipelines: { [key]: pipeline }, githubConnection: disconnected ? null : { login: 'tester', connectedAt: time } } }));
  if (unresolved) {
    const releaseDir = join(dataDir, 'releases'); await mkdir(releaseDir);
    const target = { environment: 'production', productionEnvironment: true, workflowPath: '.github/workflows/deploy.yml' };
    await writeFile(join(releaseDir, 'state.json'), JSON.stringify({ version: 1, targets: {}, releases: [{
      id: 'prior-release', source: { key: pipelineId, repository: 'acme/app', branch: 'main', sha, login: 'tester' }, target,
      workflow: { defaultBranch: 'main', defaultSha: sha, workflowSha: sha, defaultWorkflowSha: sha },
      gates: [{ id: 'gate-1', stageId: 'beta', sha, context: 'perpetual/Beta', status: 'passed', updatedAt: time }],
      record: { id: 'prior-release', sha, ...target, status: 'unknown', createdAt: time, updatedAt: time },
    }] }));
  }
  let app: Controller;
  const verified: string[] = [], deploymentCalls: string[] = [];
  async function start() {
    app = await startServer({ port: 0, repo: dir, dataDir, github: {
      auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
      runs: { async session() { return { available: true, authenticated: true as const, account: { login: 'tester', name: null } }; }, async read(input) { return { repository: String(input.repository), sha: String(input.sha), runs: [] }; } },
      async head(input) {
        verified.push(String(input.branch));
        if (!['dev', 'main', 'release'].includes(String(input.branch))) throw new Error('GitHub returned no commit for this branch.');
        return { status: 200 as const, sha, etag: null };
      },
      async build() { return { status: 'waiting' as const, reason: 'CI pending.' }; }, async status() {},
    }, releases: { github: {
      async verifyTarget() { deploymentCalls.push('target'); throw new Error('unexpected deployment call'); },
      async verifyCommit() { deploymentCalls.push('commit'); throw new Error('unexpected deployment call'); },
      async create() { deploymentCalls.push('create'); throw new Error('unexpected deployment call'); },
      async read() { deploymentCalls.push('read'); return null; },
    } } });
    const { token } = await (await fetch(`${app.url}/api/session`)).json();
    return {
      async post(input: unknown, authorized = true, path = '/api/pipeline/action') {
        const response = await fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-perpetual-token': token } : {}) }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
      },
      async state() { return await (await fetch(app.url + '/api/state')).json(); },
      async releases() { return await (await fetch(`${app.url}/api/releases?${new URLSearchParams({ repoPath: dir })}`)).json(); },
    };
  }
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, source, stateFile, start, close: () => app.close(), verified, deploymentCalls, input: (branch: unknown) => ({ repoPath: dir, pipelineId, action: 'set-production-branch', branch }) };
}

test('Production branch is verified, saved independently, retained across browsing and restart, and remains gated', async t => {
  const f = await fixture(t), api = await f.start();
  assert.match((await api.releases()).blockedReason, /Choose a Production branch/);
  const saved = await api.post(f.input('release'));
  assert.equal(saved.status, 200); assert.equal(saved.body.pipeline.productionBranch, 'release');
  const snapshot = await api.state();
  assert.deepEqual(snapshot.source, f.source); assert.equal(snapshot.scan.repo.branch, 'dev');
  assert.match((await api.releases()).blockedReason, /Switch to the Production branch \(release\)/);
  const refused = await api.post({ repoPath: f.dir, sha }, true, '/api/releases/deploy');
  assert.equal(refused.status, 409); assert.match(refused.body.error, /Production branch/);
  assert.deepEqual(f.deploymentCalls, []);
  await f.close();
  // Browsing a different managed branch preserves the project's independent release policy.
  const disk = JSON.parse(await readFile(f.stateFile, 'utf8'));
  disk.state.source.branch = 'main'; disk.state.scan.repo.branch = 'main';
  await writeFile(f.stateFile, JSON.stringify(disk));
  const restarted = await f.start();
  assert.equal((await restarted.state()).pipeline.productionBranch, 'release');
  assert.match((await restarted.releases()).blockedReason, /Switch to the Production branch \(release\)/);
  assert.equal((await restarted.post(f.input('main'))).status, 200);
  const view = await restarted.releases();
  assert.equal(view.canDeploy, false); assert.match(view.blockedReason, /Sandbox gate/);
});

test('Production branch rejects stale identities, malformed refs, missing refs and unauthorized writes without saving', async t => {
  const f = await fixture(t, { productionBranch: 'main' }), api = await f.start();
  assert.equal((await api.post(f.input('release'), false)).status, 403);
  assert.equal((await api.post({ ...f.input('release'), repoPath: '/another/source' })).status, 409);
  assert.equal((await api.post({ ...f.input('release'), pipelineId: 'pipeline:87654321-4321-4321-4321-abcdefabcdef' })).status, 409);
  for (const branch of [null, 42, '../main', 'main.lock', 'dev:main', 'main\n']) assert.equal((await api.post(f.input(branch))).status, 400);
  assert.equal((await api.post(f.input('missing'))).status, 400);
  assert.equal((await api.state()).pipeline.productionBranch, 'main');
  assert.ok(!f.verified.includes('release'));
});

test('an explicitly disconnected account cannot set Production branch even if its CLI session is authenticated', async t => {
  const f = await fixture(t, { disconnected: true }), api = await f.start();
  assert.equal((await api.post(f.input('release'))).status, 400);
  assert.ok(!f.verified.includes('release'));
  assert.equal((await api.state()).pipeline.productionBranch, undefined);
});

test('an unresolved deployment holds Production branch changes across every viewed branch of the pipeline', async t => {
  const f = await fixture(t, { productionBranch: 'main', unresolved: true }), api = await f.start();
  const response = await api.post(f.input('release'));
  assert.equal(response.status, 409); assert.match(response.body.error, /Resolve the current deployment/);
  assert.equal((await api.state()).pipeline.productionBranch, 'main');
  assert.ok(!f.verified.includes('release'));
});

test('pipeline normalization preserves an explicit Production branch and never derives it from a viewed branch', () => {
  const original = defaultPipeline('/acme/app');
  const configured = applyPipelineAction(original, { action: 'set-production-branch', branch: 'release/production' });
  assert.equal(original.productionBranch, undefined);
  assert.equal(normalizedPipeline({ ...configured, repoPath: '/acme/another-copy' }).productionBranch, 'release/production');
  assert.throws(() => normalizedPipeline({ ...configured, productionBranch: '../invalid' }), /production branch/i);
});
