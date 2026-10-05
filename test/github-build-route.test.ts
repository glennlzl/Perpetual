import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, startServer } from './fixtures/controller.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import type { WorkflowRun } from '../contract/github.ts';
import type { GitHubSession } from '../src/github-source.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), repository = 'acme/app';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const run = (id: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({ id, workflowId: '1', name: 'CI', path: '.github/workflows/ci.yml', event: 'push', attempt: 1, sha: B, branch: 'main', url: null, createdAt: null, startedAt: null, updatedAt: null, status: 'completed', conclusion: 'success', jobs: [], ...extra });

async function fixture(t: TestContext, { managed = true, baseline = true, branch = 'main' as string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-build-api-')), dataDir = join(dir, 'data');
  await mkdir(join(dataDir, 'gates'), { recursive: true });
  const key = managed ? 'github:acme/app:/' : dir;
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: A, branch, remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-23T10:00:00.000Z' };
  const stages = [{ id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' }, { id: 'beta', name: 'Beta', kind: 'sandbox' }, { id: 'production', name: 'Production', kind: 'production' }].map(stage => ({ ...stage, collapsed: false }));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, providers: [], pipelines: { [key]: { repoPath: dir, stages } }, githubConnection: { login: 'tester', connectedAt: '2026-09-23T09:00:00.000Z' }, ...(managed ? { source: { repository, branch, rootDirectory: '/', scanPath: dir, sha: A, connectedAccount: 'tester', savedAt: '2026-09-23T10:00:00.000Z' } } : {}) } }));
  await writeFile(join(dataDir, 'gates/state.json'), JSON.stringify({ version: 1, gates: [], heads: baseline ? { [key]: { repository, branch, login: 'tester', sha: B, etag: null } } : {} }));
  let login: string | null = 'tester', nextHead: string | null = null;
  let read: (input: { repository?: unknown; sha?: unknown; login?: unknown }) => Promise<{ repository: string; sha: string | null; runs: WorkflowRun[] }> = async input => ({ repository, sha: String(input.sha), runs: [run('10', { sha: String(input.sha) })] });
  const app = await startServer({ port: 0, repo: dir, dataDir, github: {
    auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: { session: async (): Promise<GitHubSession> => login ? { available: true, authenticated: true, account: { login, name: null } } : { available: true, authenticated: false, account: null }, read: input => read(input) },
    head: async () => nextHead ? { status: 200, sha: nextHead, etag: null } : { status: 304 },
    build: async () => ({ status: 'waiting', reason: 'No completed build.' }), status: async () => {},
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const get = async (route = 'build', repoPath = dir) => { const response = await fetch(`${app.url}/api/github/${route}?${new URLSearchParams({ repoPath })}`); return { status: response.status, body: await response.json() }; };
  const post = async (path: string, input: unknown) => { const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  return { dir, app, get, post, setRead(value: typeof read) { read = value; }, setLogin(value: typeof login) { login = value; }, setHead(value: string) { nextHead = value; } };
}

test('Build follows the verified watched head while raw runs stay on the scanned commit', async t => {
  const f = await fixture(t);
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.deepEqual({ ...result.body, runs: [] }, { repoPath: f.dir, repository, branch: 'main', sha: B, scannedSha: A, source: 'watched', runs: [] });
  assert.equal(result.body.runs[0].sha, B);
  assert.equal((await f.get('runs')).body.sha, A);
  assert.equal((await f.get('build', '/another/source')).status, 409);
  assert.equal((await fetch(`${f.app.url}/api/github/build?${new URLSearchParams({repoPath:f.dir,branch:'other'})}`)).status, 409);
});

test('Build keeps every eligible workflow path and only its latest exact-branch run and attempt', async t => {
  const f = await fixture(t);
  f.setRead(async () => ({ repository, sha: B, runs: [run('10'), run('20', { event: 'workflow_dispatch' }), run('20', { event: 'workflow_dispatch', attempt: 2, status: 'in_progress', conclusion: null }), run('40', { event: 'pull_request' }), run('50', { branch: 'other' }), run('60', { sha: C }), run('70', { event: 'schedule' }), run('80', { path: 'dynamic/pages', workflowId: '2' }), run('90', { path: '.github/workflows/new.yml', workflowId: '3' })] }));
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.runs.map((item: WorkflowRun) => [item.id, item.attempt]), [['20', 2], ['90', 1]]);
});

for (const managed of [false, true]) test(`Build uses the scanned SHA without a watched baseline (managed=${managed})`, async t => {
  const f = await fixture(t, { managed, baseline: false });
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.sha, A); assert.equal(result.body.source, 'scanned');
});

test('an unknown branch has no verified Build runs', async t => {
  const f = await fixture(t, { branch: null });
  assert.deepEqual((await f.get()).body.runs, []);
});

test('a failed current Build read does not return a previous successful reply', async t => {
  const f = await fixture(t);
  assert.equal((await f.get()).status, 200);
  f.setRead(async () => { throw Object.assign(new Error('GitHub returned incomplete Build evidence.'), { statusCode: 502 }); });
  const failed = await f.get();
  assert.equal(failed.status, 502); assert.equal(failed.body.runs, undefined);
});

test('a passing run cannot hide an eligible workflow with unreadable execution state', async t => {
  const f = await fixture(t);
  for (const state of [{ status: null, conclusion: null }, { status: 'completed', conclusion: null }]) {
    f.setRead(async () => ({ repository, sha: B, runs: [run('10'), run('20', { workflowId: '2', path: '.github/workflows/other.yml', ...state })] }));
    const result = await f.get();
    assert.equal(result.status, 502); assert.equal(result.body.runs, undefined);
  }
});

test('an account switch while Build is reading refuses that reply', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  assert.equal((await f.get()).status, 200);
  f.setRead(async () => { started.resolve(); await release.promise; return { repository, sha: B, runs: [run('10')] }; });
  const reading = f.get(); await started.promise; f.setLogin('other-account'); release.resolve();
  const result = await reading;
  assert.equal(result.status, 409); assert.equal(result.body.runs, undefined);
});

test('a watched head change while Build is reading refuses the older green reply', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  assert.equal((await f.get()).status, 200);
  f.setRead(async () => { started.resolve(); await release.promise; return { repository, sha: B, runs: [run('10')] }; });
  const reading = f.get(); await started.promise; f.setHead(C);
  assert.equal((await f.post('/api/gate/run', { repoPath: f.dir, stageId: 'beta' })).status, 202);
  release.resolve();
  const result = await reading;
  assert.equal(result.status, 409); assert.equal(result.body.runs, undefined);
});
