import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import type { BranchHeadInput, CommitStatusPost } from '../src/gate/github.ts';
import type { GateView } from '../src/gate/manager.ts';
import type { GitHubSession } from '../src/github-source.ts';
import type { BuildInput, BuildVerdict } from '../src/gate/manager.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
type GateResponse = GateView & { repoPath: string; sha: string | null; error?: string };
const session = (login: string): GitHubSession => ({ available: true, authenticated: true, account: { login, name: null } });

// Injected GitHub seams record commit statuses and head reads instead of spawning gh.
function github({ login = 'developer' } = {}) {
  const calls: { statuses: CommitStatusPost[]; heads: BranchHeadInput[] } = { statuses: [], heads: [] };
  return {
    calls,
    auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: { async session() { return session(login); }, async read(input: {repository?: unknown; sha?: unknown}) { return { repository: String(input.repository), sha: String(input.sha), runs: [] }; } },
    async status(input: CommitStatusPost) { calls.statuses.push(input); },
    async head(input: BranchHeadInput) { calls.heads.push(input); return { status: 200 as const, sha: SHA, etag: null }; },
    async build(_input: BuildInput): Promise<BuildVerdict> { return { status: 'passed' }; },
  };
}

async function start(t: TestContext, { connection = { login: 'developer', connectedAt: '2026-09-23T09:00:00.000Z' }, seams = github(), managed = false }: { connection?: { login: string; connectedAt: string } | null; seams?: ReturnType<typeof github>; managed?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-gate-api-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: SHA, branch: 'main', remote: 'https://github.com/owner/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-23T10:00:00.000Z' };
  const stages = [{ id: 'source', name: 'Source', kind: 'source', collapsed: false }, { id: 'build', name: 'Build', kind: 'build', collapsed: false }, { id: 'beta', name: 'Beta', kind: 'sandbox', collapsed: false }, { id: 'production', name: 'Production', kind: 'production', collapsed: false }];
  const state = { scan, providers: [], pipelines: { [managed ? 'github:owner/app:/' : dir]: { repoPath: dir, stages } }, githubConnection: connection,
    ...(managed ? { source: { repository: 'owner/app', branch: 'main', rootDirectory: '/', scanPath: dir, sha: SHA, connectedAccount: 'developer', savedAt: '2026-09-23T10:00:00.000Z' } } : {}) };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state }));
  const app = await startServer({ port: 0, repo: dir, dataDir, github: seams });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const post = async (path: string, input: unknown): Promise<{ status: number; body: GateResponse }> => { const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  const view = async (): Promise<GateResponse> => (await fetch(`${app.url}/api/gate`)).json();
  async function until(check: (view: GateResponse) => unknown) {
    for (let attempt = 0; attempt < 400; attempt++) { const current = await view(); if (check(current)) return current; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('The gate did not settle.');
  }
  return { dir, dataDir, post, view, until, calls: seams.calls };
}

test('the gate view names the active source and starts empty', async t => {
  const f = await start(t);
  assert.deepEqual(await f.view(), { repoPath: f.dir, sha: SHA, stages: {}, production: null });
});

test('managed Run now waits on the connected Build reader before reaching journey admission', async t => {
  const seams = github(), builds: BuildInput[] = [];
  seams.build = async input => { builds.push(input); return { status: 'waiting', reason: 'CI is still running.' }; };
  const f = await start(t, { seams, managed: true });
  assert.equal((await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' })).status, 202);
  const waiting = await f.until(view => view.stages.beta?.status === 'waiting-build');
  assert.equal(waiting.stages.beta.reason, 'CI is still running.');
  assert.deepEqual(builds, [{ repository: 'owner/app', branch: 'main', sha: SHA, login: 'developer' }]);
  assert.equal((await f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA })).status, 409);
  assert.equal(waiting.production, null);
});

test('managed failed Build cannot be manually released into Production', async t => {
  const seams = github();
  seams.build = async () => ({ status: 'blocked', reason: 'CI failed.' });
  const f = await start(t, { seams, managed: true });
  await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' });
  const blocked = await f.until(view => view.stages.beta?.status === 'build-failed');
  assert.equal(blocked.stages.beta.reason, 'CI failed.');
  assert.equal((await f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA })).status, 409);
  assert.equal((await f.view()).production, null);
});

test('Run now on a stage without reviewed journeys needs release and reports it; a person releases it', async t => {
  const f = await start(t);
  const queued = await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.stages.beta.sha, SHA);
  const settled = await f.until(view => view.stages.beta?.status === 'needs-release' && f.calls.statuses.length);
  assert.equal(settled.stages.beta.reason, 'No reviewed journeys.');
  assert.deepEqual(f.calls.statuses, [{ repository: 'owner/app', sha: SHA, state: 'pending', context: 'perpetual/Beta', description: 'Needs release' }]);
  assert.deepEqual(f.calls.heads, [], 'A local checkout is not watched.');

  const released = await f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA });
  assert.equal(released.status, 200);
  assert.deepEqual([released.body.stages.beta.status, released.body.stages.beta.releasedBy], ['released', 'developer']);
  assert.deepEqual(released.body.production, { sha: SHA, status: 'ready' });
  await f.until(() => f.calls.statuses.length === 2);
  assert.deepEqual(f.calls.statuses[1], { repository: 'owner/app', sha: SHA, state: 'success', context: 'perpetual/Beta', description: 'Released by developer' });
  const again = await f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA });
  assert.equal(again.status, 409);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'gates', 'state.json'), 'utf8'));
  assert.equal(saved.gates[0].status, 'released');
});

test('gate writes refuse another source, a non-Sandbox stage and a release without GitHub', async t => {
  const f = await start(t, { connection: null });
  assert.equal((await f.post('/api/gate/run', { repoPath: '/another/checkout', stageId: 'beta' })).status, 409);
  const production = await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'production' });
  assert.deepEqual([production.status, production.body.error], [400, 'Choose a Sandbox stage.']);
  await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' });
  const settled = await f.until(view => view.stages.beta?.status === 'needs-release' && view.stages.beta.statusError);
  assert.equal(settled.stages.beta.statusError, 'Connect GitHub to report commit status.');
  assert.deepEqual(f.calls.statuses, [], 'A disconnected account reports nothing.');
  const release = await f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA });
  assert.deepEqual([release.status, release.body.error], [400, 'Connect GitHub to release.']);
});

test('release refuses a source change while verifying the account, before releasing any gate', async t => {
  const seams = github();
  const f = await start(t, { seams });
  await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' });
  await f.until(view => view.stages.beta?.status === 'needs-release' && f.calls.statuses.length);
  let verified!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { verified = resolve; });
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  seams.runs.session = async () => { verified(); await waiting; return session('developer'); };
  const releasing = f.post('/api/gate/release', { repoPath: f.dir, stageId: 'beta', sha: SHA });
  await reading;
  // The source action is a read-only scan of a disposable local directory, never a real repository selection.
  const another = join(f.dir, 'other-repository');
  await mkdir(another);
  await writeFile(join(another, 'package.json'), '{"name":"other-app"}');
  const switched = await f.post('/api/scan', { path: another });
  resume();
  assert.equal(switched.status, 200);
  const result = await releasing;
  assert.equal(result.status, 409);
  assert.match(result.body.error || '', /source changed|repository changed/i);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'gates', 'state.json'), 'utf8'));
  assert.equal(saved.gates[0].status, 'needs-release');
  assert.equal(f.calls.statuses.some(status => status.state === 'success'), false);
});
