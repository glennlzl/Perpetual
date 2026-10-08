import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, startServer } from './fixtures/controller.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import { diagnoseFailure } from '../src/providers.ts';
import type { BranchHeadInput } from '../src/gate/github.ts';
import type { GitHubSession } from '../src/github-source.ts';
import type { WorkflowRun } from '../src/github-runs.ts';
import type { RunInput } from '../src/repair/github.ts';
import type { AutopilotChange, AutopilotView } from '../contract/autopilot.ts';
import { defaultPipeline } from '../src/pipeline.ts';
import type { ServerOptions } from '../src/server.ts';
import type { Repair } from '../src/repair/manager.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281', NEWER = 'd'.repeat(40);
type AutopilotResponse = AutopilotView & { error?: string };
const session = (login: string): GitHubSession => ({ available: true, authenticated: true, account: { login, name: null } });
const run = (id: string, conclusion: string | null, sha = SHA): WorkflowRun => ({ id, workflowId: '7', name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: conclusion ? 'completed' : 'in_progress', conclusion, attempt: 1, sha, branch: 'main', url: null, createdAt: null, startedAt: null, updatedAt: null, jobs: [] });
const shown = (id: string) => ({ id, name: 'CI', path: '.github/workflows/ci.yml', url: null });
// The Build stage's record, its newest change and the change's steps as [name, status].
const build = (view: AutopilotResponse) => view.stages?.build;
const change = (view: AutopilotResponse) => build(view)?.changes[0];
const marks = (item: AutopilotChange | undefined) => item?.steps.map(step => [step.name, step.status]);

// Injected GitHub seams answer head, runs, failed logs and reruns from fixtures and record the calls; no gh runs.
function github() {
  const calls = { heads: [] as BranchHeadInput[], reads: [] as unknown[], failures: [] as RunInput[], reruns: [] as RunInput[] };
  const commits: Record<string, WorkflowRun[]> = {}, logs: Record<string, string> = {}, branch = { head: SHA };
  return {
    calls, commits, logs, branch,
    auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: {
      async session() { return session('developer'); },
      async read(input: { repository?: unknown; sha?: unknown; login?: unknown }) { calls.reads.push(input); return { repository: String(input.repository), sha: String(input.sha), runs: structuredClone(commits[String(input.sha)] ?? []) }; },
    },
    async head(input: BranchHeadInput) { calls.heads.push(input); const etag = `"${branch.head.slice(0, 7)}"`; return input.etag === etag ? { status: 304 as const } : { status: 200 as const, sha: branch.head, etag }; },
    async status() {},
    async recoveryWorkflow() { return ''; },
    async failure(input: RunInput) {
      calls.failures.push(input);
      const log = logs[String(input.runId)] ?? "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
      return { runId: String(input.runId), jobs: [], log, tail: log, diagnosis: diagnoseFailure(log), observedAt: '2026-09-25T10:00:00.000Z' };
    },
    async rerun(input: RunInput) { calls.reruns.push(input); },
  };
}

const MODEL = { apiKey: 'sk-or-v1-0123456789abcdef', model: 'openai/gpt-6-luna', baseUrl: 'https://openrouter.ai/api/v1' };

// before() sets GitHub up as the controller will first read it.
async function start(t: TestContext, { connection = { login: 'developer', connectedAt: '2026-09-25T09:00:00.000Z' }, managed = true, model = {} as Record<string, string>, docker = 'Start Docker to repair builds.' as string | null, before = () => {}, beforeStart = async () => {}, credentials }: { credentials?: ServerOptions['credentials']; connection?: { login: string; connectedAt: string } | null; managed?: boolean; model?: Record<string, string>; docker?: string | null; before?: (seams: ReturnType<typeof github>) => void; beforeStart?: (dataDir: string, repoPath: string) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-repair-api-')), dataDir = join(dir, 'data');
  let close = async () => {};
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(dataDir);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: SHA, branch: 'main', remote: 'https://github.com/owner/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-25T10:00:00.000Z' };
  const source = { scanPath: dir, checkoutPath: dir, repository: 'owner/app', branch: 'main', rootDirectory: '/', sha: SHA, connectedAccount: 'developer', savedAt: '2026-09-25T09:00:00.000Z' };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, providers: [], pipelines: {}, githubConnection: connection, ...(managed ? { source } : {}) } }));
  // App Settings as saved: an empty record configures no model, whatever this machine's environment holds.
  await writeFile(join(dataDir, 'browser-model.json'), JSON.stringify(model));
  const seams = github();
  before(seams);
  await beforeStart(dataDir, dir);
  // The repair box answers from a fixture: no Docker runs, and no repair reaches a model.
  const boxes = { async available() { return docker; }, async create(): Promise<never> { throw new Error('unused'); }, async removeLeftovers() {}, async remove() {} };
  const app = await startServer({ port: 0, repo: dir, dataDir, github: seams, repair: { boxes }, credentials });
  close = () => app.close();
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const post = async (path: string, input: unknown): Promise<{ status: number; body: AutopilotResponse }> => {
    const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const get = async (path: string) => { const response = await fetch(`${app.url}${path}`); return { status: response.status, body: await response.json() }; };
  const view = async (repoPath = dir): Promise<AutopilotResponse> => (await get(`/api/autopilot?${new URLSearchParams({ repoPath })}`)).body;
  const repair = (runId: string, extra: Record<string, unknown> = {}) => post('/api/autopilot/repair', { repoPath: dir, stageId: 'build', runId, ...extra });
  async function until(check: (view: AutopilotResponse) => unknown) {
    for (let attempt = 0; attempt < 400; attempt++) { const current = await view(); if (check(current)) return current; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('The repair did not settle.');
  }
  const ended = (view: AutopilotResponse) => change(view) && change(view)!.status !== 'running' ? change(view) : null;
  // The start reads the head once, a baseline.
  for (let attempt = 0; managed && connection && !seams.calls.heads.length && attempt < 400; attempt++) await new Promise(done => setTimeout(done, 5));
  return { dir, dataDir, url: app.url, post, get, view, repair, until, ended, seams, close: () => app.close() };
}

test('the Autopilot view names the active source, carries Build alone, starts empty at the baseline head, and refuses another source', async t => {
  const f = await start(t);
  await f.until(() => f.seams.calls.reads.length);
  assert.deepEqual(await f.view(), { repoPath: f.dir, stages: { build: { mode: 'merge', changes: [], failed: { sha: SHA, runs: [] } } } });
  assert.deepEqual(f.seams.calls.heads, [{ repository: 'owner/app', branch: 'main', etag: null }]);
  assert.deepEqual(f.seams.calls.reads, [{ repository: 'owner/app', sha: SHA, login: 'developer' }], 'A baseline head\'s runs are read as the connected account, only to offer a Repair.');
  const other = await f.get(`/api/autopilot?${new URLSearchParams({ repoPath: '/another/checkout' })}`);
  assert.equal(other.status, 409);
  assert.deepEqual((await f.get('/api/state')).body.autopilot, await f.view(), 'The state carries the same view.');
});

test('the Autopilot APIs show actual Sandbox names for repair gates, follow renames and retain unknown stage IDs', async t => {
  const stageId = 'cb8898f6-2d0a-4d47-8f7a-d910035fe318', missingId = '0115e590-cc2e-4f39-b4d2-476775e2095a';
  const f = await start(t, { connection: null, async beforeStart(dataDir, repoPath) {
    const pipeline = defaultPipeline(repoPath);
    pipeline.stages.splice(2, 0, { id: stageId, name: 'Acceptance', kind: 'sandbox', collapsed: false });
    const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    saved.state.pipelines['github:owner/app:/'] = pipeline;
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(saved));
    const repair: Repair = { id: 'finished-repair', key: 'github:owner/app:/', repository: 'owner/app', branch: 'main', sha: SHA, login: 'developer', checkoutPath: repoPath, rootDirectory: '/', trigger: 'person', status: 'ready', runs: [],
      gates: [{ gateId: 'known-gate', stageId, sha: NEWER, status: 'passed' }, { gateId: 'unknown-gate', stageId: missingId, sha: NEWER, status: 'passed' }], createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:01:00.000Z' };
    await mkdir(join(dataDir, 'repairs'));
    await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [repair] }));
  } });
  const expected = (name: string) => [{ text: name }, ' passed at ', { text: 'ddddddd' }, ', ', { text: missingId }, ' passed at ', { text: 'ddddddd' }];
  assert.deepEqual(change(await f.view())?.steps[3].detail, expected('Acceptance'));
  assert.deepEqual(change((await f.get('/api/state')).body.autopilot)?.steps[3].detail, expected('Acceptance'));
  const renamed = await f.post('/api/pipeline/action', { repoPath: f.dir, action: 'rename-stage', stageId, name: 'Release check' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(change(await f.view())?.steps[3].detail, expected('Release check'));
  assert.deepEqual(change((await f.get('/api/state')).body.autopilot)?.steps[3].detail, expected('Release check'));
});

test('a person\'s Repair triages the failed head and, without an OpenRouter API key, stops at Change waiting for a person', async t => {
  const f = await start(t);
  f.seams.commits[SHA] = [run('41', 'failure')];
  const started = await f.repair('41');
  assert.equal(started.status, 202);
  assert.deepEqual([change(started.body)?.status, change(started.body)?.title, change(started.body)?.kind, marks(change(started.body))], ['running', 'Diagnosing build', 'fix', [['Read the failure', 'active'], ['Diagnose', 'pending'], ['Change', 'pending'], ['Verify', 'pending'], ['Merge', 'pending']]]);
  assert.deepEqual(change(started.body)?.steps[0].detail, [{ text: 'CI' }, ' failed at ', { text: 'cb9292c' }]);
  const settled = await f.until(f.ended);
  assert.deepEqual([change(settled)?.status, change(settled)?.reason, marks(change(settled))], ['needs-attention', 'Add an OpenRouter API key in Settings.', [['Read the failure', 'done'], ['Diagnose', 'done'], ['Change', 'waiting'], ['Verify', 'pending'], ['Merge', 'pending']]]);
  assert.deepEqual([change(settled)?.steps[1].detail, change(settled)?.steps[2].detail], [['The build does not compile.'], ['Add an OpenRouter API key in Settings.']]);
  assert.deepEqual(f.seams.calls.failures, [{ repository: 'owner/app', runId: '41' }]);
  // A view observes the terminal state before the background job's final atomic save settles.
  // Shutdown joins that save, so the durable-state assertion does not race the writer.
  await f.close();
  const saved = JSON.parse(await readFile(join(f.dataDir, 'repairs', 'state.json'), 'utf8'));
  assert.deepEqual([saved.repairs[0].login, saved.repairs[0].trigger, saved.repairs[0].status, saved.repairs[0].category], ['developer', 'person', 'needs-person', 'build']);
  assert.deepEqual(build(settled)?.failed, { sha: SHA, runs: [shown('41')] }, 'A repair that needed a person may start again.');
});

test('a failed head pushed after the scanned commit is repaired and named on Build, and a Repair on the scanned commit\'s run is refused', async t => {
  const f = await start(t);
  f.seams.commits[SHA] = [run('40', 'failure')];
  f.seams.commits[NEWER] = [run('41', 'failure', NEWER)];
  f.seams.branch.head = NEWER;
  const refused = await f.repair('40');
  assert.deepEqual([refused.status, refused.body.error], [409, 'This run is not at the head of main.']);
  const settled = await f.until(f.ended);
  assert.deepEqual([build(settled)?.failed, change(settled)?.steps[0].detail, build(settled)?.changes.length], [{ sha: NEWER, runs: [shown('41')] }, [{ text: 'CI' }, ' failed at ', { text: 'ddddddd' }], 1]);
  assert.deepEqual(f.seams.calls.failures, [{ repository: 'owner/app', runId: '41' }]);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'repairs', 'state.json'), 'utf8')).repairs[0].trigger, 'push');
});

test('a failed head newer than the scanned commit, first seen at start, offers its own failed run, and a person repairs it again once it needed a person', async t => {
  const f = await start(t, { before(seams) { seams.branch.head = NEWER; seams.commits[SHA] = [run('40', 'failure')]; seams.commits[NEWER] = [run('41', 'failure', NEWER)]; } });
  const offered = await f.until(view => build(view)?.failed?.runs.length);
  assert.deepEqual(build(offered), { mode: 'merge', changes: [], failed: { sha: NEWER, runs: [shown('41')] } }, 'A head first seen at start opens nothing by itself.');
  const refused = await f.repair('40');
  assert.deepEqual([refused.status, refused.body.error], [409, 'This run is not at the head of main.'], 'The scanned commit\'s run is not the head\'s.');
  const started = await f.repair('41', { sha: SHA });
  assert.deepEqual([started.status, change(started.body)?.status, build(started.body)?.failed?.runs], [202, 'running', []], 'A request names a run of the watched head, never a commit; a head under repair offers none.');
  const first = await f.until(f.ended);
  assert.equal(change(first)?.reason, 'Add an OpenRouter API key in Settings.');
  await writeFile(join(f.dataDir, 'browser-model.json'), JSON.stringify(MODEL));
  const again = await f.repair('41');
  assert.deepEqual([again.status, build(again.body)?.changes.length], [202, 2]);
  const second = await f.until(view => build(view)?.changes.length === 2 && f.ended(view));
  assert.equal(change(second)?.reason, 'Start Docker to repair builds.', 'The key added in Settings reaches the retry.');
});

test('with an OpenRouter API key but Docker not running, a repair needs a person to start it', async t => {
  const f = await start(t, { model: MODEL });
  f.seams.commits[SHA] = [run('41', 'failure')];
  await f.repair('41');
  const settled = await f.until(f.ended);
  assert.equal(change(settled)?.reason, 'Start Docker to repair builds.');
  assert.ok(!JSON.stringify(settled).includes('sk-or-v1'), 'The key never enters a repair.');
});

test('an availability failure reruns its failed jobs once as Rerunning build, and Stop ends the change', async t => {
  const f = await start(t);
  f.seams.commits[SHA] = [run('41', 'failure')];
  f.seams.logs['41'] = 'Error: connect ECONNREFUSED 127.0.0.1:5432';
  await f.repair('41');
  const rerunning = await f.until(view => change(view)?.steps[1].status === 'active' && f.seams.calls.reruns.length);
  assert.deepEqual([change(rerunning)?.title, change(rerunning)?.kind, change(rerunning)?.steps[1].detail, f.seams.calls.reruns], ['Rerunning build', 'rerun', ['A network or deadline error: rerunning the failed jobs.'], [{ repository: 'owner/app', runId: '41' }]]);
  const stopped = await f.post('/api/autopilot/stop', { repoPath: f.dir, stageId: 'build', id: change(rerunning)!.id });
  assert.deepEqual([stopped.status, change(stopped.body)?.status, change(stopped.body)?.reason, change(stopped.body)?.steps[1].status], [200, 'not-merged', 'Stopped.', 'waiting']);
  const again = await f.post('/api/autopilot/stop', { repoPath: f.dir, stageId: 'build', id: change(rerunning)!.id });
  assert.deepEqual([again.status, again.body.error], [409, 'This repair is not running or queued.']);
  assert.equal((await f.post('/api/autopilot/stop', { repoPath: f.dir, stageId: 'build', id: 'missing' })).status, 404);
});

test('the Build stage\'s mode is saved as merge or ask; another value, another stage or another source is refused', async t => {
  const f = await start(t);
  assert.deepEqual(await f.post('/api/autopilot/mode', { repoPath: f.dir, stageId: 'build', mode: 'off' }), { status: 400, body: { error: 'Choose Merge changes or Ask before merging.' } });
  assert.deepEqual(await f.post('/api/autopilot/mode', { repoPath: f.dir, stageId: 'production', mode: 'ask' }), { status: 400, body: { error: 'Autopilot is available for Build.' } });
  assert.equal((await f.post('/api/autopilot/mode', { repoPath: '/another/checkout', stageId: 'build', mode: 'ask' })).status, 409);
  const ask = await f.post('/api/autopilot/mode', { repoPath: f.dir, stageId: 'build', mode: 'ask' });
  assert.deepEqual([ask.status, build(ask.body)?.mode, build(await f.view())?.mode], [200, 'ask', 'ask']);
  assert.equal(build((await f.post('/api/autopilot/mode', { repoPath: f.dir, stageId: 'build', mode: 'merge' })).body)?.mode, 'merge');
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'repairs', 'state.json'), 'utf8')).autoMerge, { 'github:owner/app:/': true }, 'The mode is the pipeline\'s auto-merge switch.');
});

test('Autopilot writes refuse another source, a bad run, an unknown operation and an unmanaged source', async t => {
  const f = await start(t);
  f.seams.commits[SHA] = [run('41', 'failure'), run('42', null)];
  assert.equal((await f.post('/api/autopilot/repair', { repoPath: '/another/checkout', stageId: 'build', runId: '41' })).status, 409);
  assert.deepEqual(await f.repair('latest'), { status: 400, body: { error: 'Choose a failed workflow run.' } });
  assert.equal((await f.repair('42')).status, 409, 'A running workflow is not failed.');
  assert.equal((await f.post('/api/autopilot/merge', { repoPath: f.dir })).status, 404);
  assert.equal((await f.get(`/api/autopilot/mode?${new URLSearchParams({ repoPath: f.dir })}`)).status, 404, 'A mode is posted.');
  const local = await start(t, { managed: false });
  assert.deepEqual(await local.view(), { repoPath: local.dir, stages: {} }, 'A local checkout carries no Autopilot.');
  assert.deepEqual(await local.repair('41'), { status: 400, body: { error: 'Connect a GitHub repository to repair its builds.' } });
  assert.deepEqual(local.seams.calls.heads, [], 'A local checkout is never watched.');
});

test('without a connected account no head is read and a Repair asks to connect GitHub', async t => {
  const f = await start(t, { connection: null });
  f.seams.commits[SHA] = [run('41', 'failure')];
  assert.deepEqual(await f.repair('41'), { status: 400, body: { error: 'Connect GitHub to repair builds.' } });
  assert.deepEqual(f.seams.calls.heads, []);
  assert.deepEqual(await f.view(), { repoPath: f.dir, stages: { build: { mode: 'merge', changes: [] } } }, 'No head is watched, so no Repair is offered.');
});

test('the failed-run endpoint reads as the connected account, for its repository', async t => {
  const f = await start(t);
  const result = await f.get('/api/providers/github/runs/123/failure');
  assert.equal(result.status, 200);
  assert.equal(result.body.diagnosis.category, 'build');
  assert.deepEqual(f.seams.calls.failures, [{ repository: 'owner/app', runId: '123' }]);
  const disconnected = await start(t, { connection: null });
  const refused = await disconnected.get('/api/providers/github/runs/123/failure');
  assert.deepEqual([refused.status, refused.body.error], [400, 'Connect your GitHub account to read workflow runs.']);
  assert.deepEqual(disconnected.seams.calls.failures, []);
});

test('a restored queue is visible and Resume is scoped to the active Build stage', async t => {
  const f = await start(t, { async beforeStart(dataDir) {
    await mkdir(join(dataDir, 'repairs'));
    const time = '2026-09-25T10:00:00.000Z';
    await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'queued-test', key: 'github:owner/app:/', repository: 'owner/app', branch: 'main', sha: SHA, login: 'developer', checkoutPath: '/data/app', rootDirectory: '/', trigger: 'push', status: 'queued', runs: [], createdAt: time, updatedAt: time }] }));
  } });
  const queued = change(await f.view());
  assert.deepEqual([queued?.status, queued?.paused, queued?.queuePosition], ['queued', true, 1]);
  f.seams.commits[SHA] = [run('41', 'failure')];
  const wrong = await f.post('/api/autopilot/resume', { repoPath: f.dir, stageId: 'production' });
  assert.equal(wrong.status, 400);
  const other = await f.post('/api/autopilot/resume', { repoPath: '/other', stageId: 'build' });
  assert.equal(other.status, 409);
  const resumed = await f.post('/api/autopilot/resume', { repoPath: f.dir, stageId: 'build' });
  assert.equal(resumed.status, 200);
  const result = change(await f.until(v => change(v)?.status === 'needs-attention'));
  assert.equal(result?.reason, 'Add an OpenRouter API key in Settings.');
  assert.equal(result?.paused, undefined);
});

test('authorization recovery is scoped to the active Build and follows actual rerun attempts through HTTP', async t => {
  const f = await start(t, { before(seams) { seams.commits[SHA] = [run('41', 'failure')]; seams.logs['41'] = 'Error: CLOUD_TOKEN is required'; } });
  await f.repair('41');
  const blocked = await f.until(view => f.ended(view));
  const id = change(blocked)!.id;
  assert.equal(change(blocked)?.title, 'Waiting for access');
  const recover = (action: string, extra: Record<string, unknown> = {}) => f.post('/api/autopilot/recover', { repoPath: f.dir, stageId: 'build', id, action, ...extra });
  assert.equal((await recover('recheck', { repoPath: '/another/project' })).status, 409);
  assert.equal((await recover('recheck', { stageId: 'production' })).status, 400);
  assert.equal((await recover('write-secret')).status, 400);
  const read = await recover('recheck');
  assert.equal(read.status, 200);
  assert.deepEqual(f.seams.calls.reruns, []);
  const retry = await recover('rerun');
  assert.equal(retry.status, 200);
  assert.equal(change(retry.body)?.title, 'Verifying recovery');
  assert.deepEqual(f.seams.calls.reruns, [{ repository: 'owner/app', runId: '41' }]);
  f.seams.commits[SHA] = [{ ...run('41', 'success'), attempt: 2 }];
  const passed = await recover('recheck');
  assert.equal(change(passed.body)?.status, 'passed');
  assert.equal(change(passed.body)?.title, 'Build recovered');
  assert.equal(change(passed.body)?.pullRequest, undefined);
});

test('one consent callback synchronizes the exact CI credential and starts original-run verification without UI polling', async t => {
  let writes = 0, exchanges = 0, revision = 'a'.repeat(64);
  const access = 'vca_' + 'x'.repeat(30);
  const time = '2026-10-07T00:00:00.000Z';
  const recoveryRun = { id: '41', attempt: 1, name: 'Preview', url: 'https://github.com/owner/app/actions/runs/41', workflow: '.github/workflows/ci.yml', observedAt: time, secrets: ['DEPLOY_ACCESS'], vercelSecret: 'DEPLOY_ACCESS', environment: null, binding: 'references', settingsUrl: 'https://github.com/owner/app/settings/secrets/actions' };
  const f = await start(t, {
    credentials: { clientId: 'oac_app', provider: {
      url: ({ state }) => `https://vercel.com/integrations/acme-recovery/new?state=${state}`,
      exchange: async () => { exchanges++; return { access, installation: { id: 'icfg_one', userId: 'user_one', teamId: null } }; },
      refresh: async () => { throw new Error('A long-lived installation does not refresh.'); },
      identity: async () => ({ id: 'icfg_one', name: 'Developer' }),
    }, write: async (destination, value) => {
      assert.deepEqual(destination, { repository: 'owner/app', name: 'DEPLOY_ACCESS', environment: null });
      assert.equal(value, access); writes++; revision = 'b'.repeat(64);
    } },
    before(seams) {
      seams.commits[SHA] = [run('41', 'failure')];
      Object.assign(seams, { recoveryCredentials: async () => ({ revision, bindings: [{ runId: '41', name: 'DEPLOY_ACCESS', environment: null, scope: 'repository', updatedAt: writes ? '2026-10-07T00:01:00Z' : time }] }) });
    },
    async beforeStart(dataDir, repoPath) {
      await mkdir(join(dataDir, 'repairs'));
      await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'access-test', key: 'github:owner/app:/', repository: 'owner/app', branch: 'main', sha: SHA, login: 'developer', checkoutPath: repoPath, rootDirectory: '/', trigger: 'push', status: 'needs-person', category: 'configuration', runs: [{ ...shown('41'), attempt: 1 }], createdAt: time, updatedAt: time, recovery: { status: 'required', credentialRevision: revision, runs: [recoveryRun], requests: [] } }] }));
    },
  });
  const input = { repoPath: f.dir, stageId: 'build', id: 'access-test' };
  const unauthenticated = await globalThis.fetch(`${f.url}/api/autopilot/connect-vercel`, { method: 'POST', body: JSON.stringify(input) });
  assert.equal(unauthenticated.status, 401); assert.equal(writes, 0);
  const wrong = await f.post('/api/autopilot/connect-vercel', { ...input, repoPath: '/another/project' }); assert.equal(wrong.status, 409);
  const connected = await f.post('/api/autopilot/connect-vercel', input);
  assert.equal(connected.status, 200);
  const consent = new URL((connected.body as unknown as { url: string }).url);
  const callback = `${f.url}/authorization/vercel/callback?${new URLSearchParams({ state: consent.searchParams.get('state')!, code: 'issuer-code' })}`;
  const invalid = await globalThis.fetch(callback.replace(consent.searchParams.get('state')!, 'wrong-state'), { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(invalid.status, 303); assert.equal(writes, 0);
  await globalThis.fetch(callback + '&state=duplicate', { redirect: 'manual' }); assert.equal(writes, 0);
  const completed = await globalThis.fetch(callback, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(completed.status, 303); assert.equal(completed.headers.get('location'), '/#pipeline');
  assert.equal(completed.headers.get('referrer-policy'), 'no-referrer'); assert.equal(writes, 1);
  await f.until(() => f.seams.calls.reruns.length === 1);
  assert.deepEqual(f.seams.calls.reruns, [{ repository: 'owner/app', runId: '41' }]);
  const view = await f.view(); assert.equal(change(view)?.title, 'Verifying recovery');
  assert.equal(JSON.stringify(view).includes(access), false);
  await globalThis.fetch(callback, { redirect: 'manual' }); assert.equal(exchanges, 1); assert.equal(writes, 1);
  const csrf = await globalThis.fetch(`${f.url}/api/autopilot`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(csrf.status, 403);
  assert.equal((await f.post('/api/autopilot/disconnect-vercel', input)).status, 200);
  assert.equal((await readFile(join(f.dataDir, 'credentials', 'state.json'), 'utf8')).includes(access), false);
});
