import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateManager, type GateConnection, type GateGitHub, type GateStage, type GateSteps } from '../src/gate/manager.ts';
import type { BranchHead, BranchHeadInput, CommitStatusPost } from '../src/gate/github.ts';
import type { Gate, GateRef, RunRollup } from '../src/gate/rules.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const KEY = 'github:owner/app:/';
const STAGES: GateStage[] = [
  { id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' },
  { id: 'beta', name: 'Beta', kind: 'sandbox' }, { id: 'gamma', name: 'Gamma', kind: 'sandbox' }, { id: 'production', name: 'Production', kind: 'production' },
];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Context = { key: string; stageId: string; sha: string };
type HttpError = Error & { statusCode?: number };
type SavedState = { version: number; gates: Gate[]; heads: Record<string, { branch: string; login: string; sha: string; etag: string | null; checkedAt?: string }> };
type Options = {
  dataDir?: string; stages?: GateStage[]; sha?: string; repository?: string | null; connection?: GateConnection | null | (() => GateConnection | null);
  journeys?: number | ((context: Context) => number); runs?: Record<string, RunRollup>; heads?: (BranchHead | Error)[]; post?: (status: CommitStatusPost) => Promise<void>;
};
type Holds = { prepare?: (gate: GateRef) => Error | null; rebuild?: (context: Context) => Promise<unknown>; run?: (context: Context) => Promise<unknown> };

// Injected source, GitHub and steps record what the gate asked for; nothing reaches the network or Docker.
async function harness(t: TestContext, { dataDir, stages = STAGES, sha = A, repository = 'owner/app', connection = { login: 'glennlzl', repository: 'owner/app' }, journeys = 1, runs = {}, heads = [], post }: Options = {}) {
  dataDir ??= await mkdtemp(join(tmpdir(), 'perpetual-gate-'));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 23, 10, 0, 0, tick++)).toISOString();
  const current = { key: KEY, branch: 'main', sha, repository, stages };
  const log: string[] = [], posts: CommitStatusPost[] = [], headCalls: BranchHeadInput[] = [], holds: Holds = {}, seen: { rebuilding?: string; running?: string } = {};
  const github: GateGitHub = {
    build: async () => ({ status: 'passed' }),
    connection: async () => (typeof connection === 'function' ? connection() : connection),
    async head(input) { headCalls.push(input); const next = heads.shift() ?? { status: 304 as const }; if (next instanceof Error) throw next; return next; },
    async post(status) { if (post) await post(status); posts.push(status); },
  };
  const steps: GateSteps<Context, { id: string }> = {
    async prepare(gate) {
      if (holds.prepare) { const error = holds.prepare(gate); if (error) throw error; }
      log.push(`prepare ${gate.stageId} ${gate.sha[0]}`);
      current.sha = gate.sha;
      return { key: gate.key, stageId: gate.stageId, sha: gate.sha };
    },
    journeys: async context => (typeof journeys === 'function' ? journeys(context) : journeys),
    async rebuild(context) {
      seen.rebuilding = manager.view().stages[context.stageId]?.status;
      log.push(`rebuild ${context.stageId} ${context.sha[0]}`);
      if (holds.rebuild) await holds.rebuild(context);
      return { id: `twin-${context.stageId}` };
    },
    async run(context, twin) {
      seen.running = manager.view().stages[context.stageId]?.status;
      log.push(`run ${context.stageId} ${context.sha[0]} ${twin.id}`);
      if (holds.run) await holds.run(context);
      const result = runs[`${context.stageId} ${context.sha[0]}`] ?? runs[context.stageId] ?? { status: 'passed' };
      return { id: `run-${context.stageId}-${context.sha[0]}`, ...result };
    },
  };
  const manager = await createGateManager({ dataDir, source: () => current, github, steps, now, retryInterval: 5 });
  t.after(async () => { await manager.close(); });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const saved = async (): Promise<SavedState> => JSON.parse(await readFile(join(dataDir, 'gates', 'state.json'), 'utf8'));
  const gates = async (stageId?: string) => (await saved()).gates.filter(item => !stageId || item.stageId === stageId);
  return { manager, current, log, posts, headCalls, holds, seen, dataDir, saved, gates };
}

test('Run now takes a gate through rebuilding and running to passed, reporting one pending status then success', async t => {
  const h = await harness(t);
  const queued = await h.manager.run({ stageId: 'beta' });
  assert.equal(queued.stages.beta.status, 'queued');
  assert.equal(queued.stages.beta.sha, A);
  await h.manager.idle();
  assert.deepEqual(h.log.slice(0, 3), ['prepare beta a', 'rebuild beta a', 'run beta a twin-beta']);
  assert.equal(h.seen.rebuilding, 'rebuilding');
  assert.equal(h.seen.running, 'running');
  assert.equal(h.manager.view().stages.beta.status, 'passed');
  const beta = h.posts.filter(item => item.context === 'perpetual/Beta');
  assert.deepEqual(beta.map(item => [item.state, item.description]), [['pending', 'Running'], ['success', 'Passed']]);
  assert.ok(h.posts.every(item => item.repository === 'owner/app' && item.sha === A));
  const [saved] = await h.gates('beta');
  assert.equal(saved.runId, 'run-beta-a');
  assert.equal(saved.environmentId, 'twin-beta');
});

test('failed journeys fail the gate; blocked and unreviewed results need release', async t => {
  for (const [status, gate, commit] of [['failed', 'failed', ['failure', 'Failed']], ['blocked', 'needs-release', ['pending', 'Needs release']], ['needs_review', 'needs-release', ['pending', 'Needs release']]] as const) {
    await t.test(status, async t => {
      const h = await harness(t, { runs: { beta: { status, results: [{ caseId: 'journey', status }] } }, stages: STAGES.filter(stage => stage.id !== 'gamma') });
      await h.manager.run({ stageId: 'beta' });
      await h.manager.idle();
      assert.equal(h.manager.view().stages.beta.status, gate);
      assert.deepEqual([h.posts.at(-1)?.state, h.posts.at(-1)?.description], commit);
      assert.equal(h.manager.view().production, null);
    });
  }
});

test('a run that stopped on a runtime error without a failed journey needs release, never Failed', async t => {
  const h = await harness(t, { runs: { beta: { status: 'failed', error: 'Browser runtime did not return results.', results: [] } }, stages: STAGES.filter(stage => stage.id !== 'gamma') });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const view = h.manager.view().stages.beta;
  assert.deepEqual([view.status, view.reason], ['needs-release', 'Browser runtime did not return results.']);
  assert.deepEqual([h.posts.at(-1)?.state, h.posts.at(-1)?.description], ['pending', 'Needs release']);
  assert.equal((await h.manager.release({ stageId: 'beta', sha: A, login: 'glennlzl' })).stages.beta.status, 'released');
});

test('a stage without reviewed, selected journeys needs release without rebuilding or running', async t => {
  const h = await harness(t, { journeys: 0 });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const view = h.manager.view().stages.beta;
  assert.deepEqual([view.status, view.reason], ['needs-release', 'No reviewed journeys.']);
  assert.deepEqual(h.log, ['prepare beta a']);
  assert.deepEqual(h.posts.map(item => item.description), ['Needs release']);
});

test('a twin that cannot be rebuilt needs release with its error, never a pass', async t => {
  const h = await harness(t);
  h.holds.rebuild = async () => { throw new Error('The twin did not become ready.'); };
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const view = h.manager.view().stages.beta;
  assert.deepEqual([view.status, view.reason], ['needs-release', 'The twin did not become ready.']);
  assert.equal((await h.gates('gamma')).length, 0, 'Nothing is promoted.');
});

test('a newer commit supersedes queued ones; the running gate finishes and only the newest runs next', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), heads: [{ status: 200, sha: A, etag: '"1"' }, { status: 304 }, { status: 200, sha: B, etag: '"2"' }, { status: 200, sha: C, etag: '"3"' }] });
  await h.manager.watch();
  const release = deferred();
  h.holds.run = async context => { if (context.sha === A) await release.promise; };
  h.current.sha = A;
  await h.manager.run({ stageId: 'beta' }); // Run now reads the unchanged head A
  while (h.manager.view().stages.beta.status !== 'running') await new Promise(done => setTimeout(done, 1));
  await h.manager.watch(); // push B
  await h.manager.watch(); // push C
  const during = await h.gates('beta');
  assert.deepEqual(during.map(item => [item.sha[0], item.status]), [['c', 'queued'], ['b', 'superseded'], ['a', 'running']]);
  assert.equal(during.find(item => item.sha === B)?.reason, `Superseded by ${C.slice(0, 7)}.`);
  release.resolve();
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a twin-beta', 'run beta c twin-beta']);
  const after = await h.gates('beta');
  assert.deepEqual(after.map(item => [item.sha[0], item.status]), [['c', 'passed'], ['b', 'superseded'], ['a', 'passed']]);
  assert.equal(h.posts.some(item => item.sha === B), false, 'A superseded commit reports no status.');
});

test('only a gate that needs release can be released, by a GitHub login, and never a failed one', async t => {
  const h = await harness(t, { runs: { 'beta a': { status: 'blocked' }, 'beta b': { status: 'failed', results: [{ caseId: 'journey', status: 'failed' }] } }, stages: STAGES.filter(stage => stage.id !== 'gamma') });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: A }), /Connect GitHub/);
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: B, login: 'glennlzl' }), (error: HttpError) => error.statusCode === 404);
  const view = await h.manager.release({ stageId: 'beta', sha: A, login: 'glennlzl' });
  assert.deepEqual([view.stages.beta.status, view.stages.beta.releasedBy], ['released', 'glennlzl']);
  await h.manager.idle();
  assert.deepEqual([h.posts.at(-1)?.state, h.posts.at(-1)?.description], ['success', 'Released by glennlzl']);
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: A, login: 'glennlzl' }), (error: HttpError) => error.statusCode === 409 && /does not need release/.test(error.message));
  h.current.sha = B;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'failed');
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: B, login: 'glennlzl' }), (error: HttpError) => error.statusCode === 409 && /failed gate cannot be released/.test(error.message));
});

test('a passed or released gate starts the next Sandbox stage at the same commit, and Production is Ready once all pass', async t => {
  const h = await harness(t, { runs: { 'beta a': { status: 'needs_review' } } });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.gamma, undefined, 'A gate that needs release promotes nothing.');
  await h.manager.release({ stageId: 'beta', sha: A, login: 'glennlzl' });
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a twin-beta', 'run gamma a twin-gamma']);
  const view = h.manager.view();
  assert.deepEqual([view.stages.gamma.status, view.stages.gamma.sha], ['passed', A]);
  assert.deepEqual(view.production, { sha: A, status: 'ready' });
  assert.ok(h.posts.some(item => item.context === 'perpetual/Gamma' && item.state === 'success'));
});

test('a promoted commit runs before a newer push enters the first stage', async t => {
  const h = await harness(t, { heads: [{ status: 200, sha: A, etag: '"1"' }, { status: 304 }, { status: 200, sha: B, etag: '"2"' }] });
  await h.manager.watch();
  const release = deferred();
  h.holds.run = async context => { if (context.stageId === 'beta' && context.sha === A) await release.promise; };
  await h.manager.run({ stageId: 'beta' });
  while (h.manager.view().stages.beta.status !== 'running') await new Promise(done => setTimeout(done, 1));
  await h.manager.watch(); // push B while Beta tests A
  release.resolve();
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a twin-beta', 'run gamma a twin-gamma', 'run beta b twin-beta', 'run gamma b twin-gamma']);
  assert.deepEqual(h.manager.view().production, { sha: B, status: 'ready' });
});

test('an older commit released after a newer one reached the next stage is recorded as superseded there', async t => {
  const h = await harness(t, { runs: { 'beta a': { status: 'blocked' } }, heads: [{ status: 200, sha: A, etag: '"1"' }, { status: 304 }, { status: 200, sha: B, etag: '"2"' }] });
  await h.manager.watch();
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  await h.manager.watch(); // push B: Beta and Gamma pass B
  await h.manager.idle();
  await h.manager.release({ stageId: 'beta', sha: A, login: 'glennlzl' });
  await h.manager.idle();
  const gamma = await h.gates('gamma');
  assert.deepEqual(gamma.map(item => [item.sha[0], item.status]).sort(), [['a', 'superseded'], ['b', 'passed']]);
  assert.equal(gamma.find(item => item.sha === A)?.reason, 'A newer commit reached this stage.');
  assert.equal(h.log.includes('run gamma a twin-gamma'), false);
});

test('a busy stage keeps its gate queued and retries it', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma') });
  let busy = 2;
  h.holds.prepare = () => (busy-- > 0 ? Object.assign(new Error('This stage is busy.'), { statusCode: 409 }) : null);
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'queued');
  while (h.manager.view().stages.beta.status !== 'passed') await new Promise(done => setTimeout(done, 2));
  assert.equal(busy, -1);
});

test('a busy stage never holds back another stage; its newest commit runs once it is free', async t => {
  const h = await harness(t, { repository: null });
  let gammaBusy = true;
  h.holds.prepare = gate => (gate.stageId === 'gamma' && gammaBusy ? Object.assign(new Error('This stage is busy.'), { statusCode: 409 }) : null);
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.gamma.status, 'queued');
  h.current.sha = B;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a twin-beta', 'run beta b twin-beta']);
  gammaBusy = false;
  while (h.manager.view().stages.gamma.status !== 'passed') await new Promise(done => setTimeout(done, 2));
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run gamma')), ['run gamma b twin-gamma']);
  assert.deepEqual((await h.gates('gamma')).map(item => [item.sha[0], item.status]).sort(), [['a', 'superseded'], ['b', 'passed']]);
});

test('a failed status report is recorded and retried without blocking the gate or its promotion', async t => {
  let failing = true;
  const h = await harness(t, { post: async () => { if (failing) throw new Error('GitHub denied the commit status. Check write access to this repository.'); } });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const view = h.manager.view();
  assert.equal(view.stages.beta.status, 'passed');
  assert.equal(view.stages.gamma.status, 'passed', 'Promotion does not wait for GitHub.');
  assert.match(view.stages.beta.statusError ?? '', /denied the commit status/);
  failing = false;
  await h.manager.run({ stageId: 'beta' }); // any later sync retries the report
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.statusError, undefined);
});

test('a local checkout gate still runs without a GitHub connection and shows that no status was reported', async t => {
  const h = await harness(t, { repository: null, connection: null, stages: STAGES.filter(stage => stage.id !== 'gamma') });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const view = h.manager.view().stages.beta;
  assert.equal(view.status, 'passed');
  assert.equal(view.statusError, 'Connect GitHub to report commit status.');
  assert.deepEqual(h.headCalls, [], 'The branch head is read only for a connected account.');
});

test('a managed source without its GitHub connection cannot bypass Build admission', async t => {
  const h = await harness(t, { connection: null, stages: STAGES.filter(stage => stage.id !== 'gamma') });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'waiting-build');
  assert.match(h.manager.view().stages.beta.reason!, /Connect GitHub/);
  assert.deepEqual(h.log, []);
  assert.equal(h.manager.view().production, null);
});

test('a gate interrupted by a restart needs release with the interruption, and queued gates resume', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-'));
  await mkdir(join(dataDir, 'gates'));
  const at = '2026-09-23T09:00:00.000Z';
  const base = { key: KEY, branch: 'main', createdAt: at, updatedAt: at, detectedAt: at, posted: { state: 'pending', context: 'perpetual/Beta', description: 'Running' } };
  await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, heads: {}, gates: [
    { ...base, id: '1', stageId: 'beta', sha: A, status: 'running', context: 'perpetual/Beta' },
    { ...base, id: '2', stageId: 'gamma', sha: B, status: 'queued', context: 'perpetual/Gamma', posted: undefined },
  ] }));
  const h = await harness(t, { dataDir });
  const interrupted = (await h.gates('beta'))[0];
  assert.deepEqual([interrupted.status, interrupted.reason], ['needs-release', 'Interrupted by a controller restart.']);
  assert.deepEqual(h.log, [] as string[], 'Nothing runs before start.');
  h.manager.start();
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run gamma b twin-gamma']);
  const beta = h.posts.filter(item => item.context === 'perpetual/Beta');
  assert.deepEqual(beta.map(item => [item.sha, item.state, item.description]), [[A, 'pending', 'Needs release']]);
});

test('the watcher reads the branch head with its ETag; the first head is a baseline and a change queues the first Sandbox stage', async t => {
  const h = await harness(t, { heads: [{ status: 200, sha: A, etag: '"e1"' }, { status: 304 }, { status: 200, sha: B, etag: '"e2"' }] });
  await h.manager.watch();
  assert.deepEqual(h.headCalls[0], { repository: 'owner/app', branch: 'main', etag: null });
  assert.deepEqual(await h.gates(), [], 'The first head seen is not a push.');
  await h.manager.watch();
  assert.equal(h.headCalls[1].etag, '"e1"');
  assert.deepEqual(await h.gates(), [], 'An unchanged head (304) queues nothing.');
  const release = deferred();
  h.holds.prepare = () => null;
  h.holds.rebuild = () => release.promise;
  await h.manager.watch();
  assert.equal(h.headCalls[2].etag, '"e1"');
  const [queued] = await h.gates();
  assert.deepEqual([queued.stageId, queued.sha, queued.context], ['beta', B, 'perpetual/Beta']);
  release.resolve();
  await h.manager.idle();
  assert.deepEqual((await h.saved()).heads[KEY], { repository: 'owner/app', branch: 'main', login: 'glennlzl', sha: B, etag: '"e2"', checkedAt: (await h.saved()).heads[KEY].checkedAt });
});

test('the watcher keeps its ETag across restarts, drops it for another account, and skips unmanaged or unconnected sources', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-'));
  await mkdir(join(dataDir, 'gates'));
  await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, gates: [], heads: { [KEY]: { branch: 'main', login: 'glennlzl', sha: A, etag: '"e1"' } } }));
  let login = 'glennlzl';
  const h = await harness(t, { dataDir, connection: () => ({ login, repository: 'owner/app' }), heads: [{ status: 304 }, { status: 200, sha: A, etag: '"other"' }, { status: 200, sha: C, etag: '"e3"' }] });
  await h.manager.watch();
  assert.equal(h.headCalls[0].etag, '"e1"', 'The saved ETag survives a restart.');
  assert.deepEqual(h.manager.watchedHead({ key: KEY, repository: 'owner/app', branch: 'main', login }), { key: KEY, branch: 'main', sha: A }, 'A verified 304 makes a legacy baseline available for Build.');
  login = 'someone-else';
  await h.manager.watch();
  assert.equal(h.headCalls[1].etag, null, 'Another account never reuses a cached response.');
  assert.deepEqual(await h.gates(), [], 'The same head for another account is not a push.');
  h.current.repository = null;
  await h.manager.watch();
  assert.equal(h.headCalls.length, 2, 'A local checkout is never moved, so it is not watched.');
  h.current.repository = 'owner/app';
  h.current.branch = 'release';
  await h.manager.watch();
  assert.equal(h.headCalls[2].etag, null);
  assert.deepEqual(await h.gates(), [], 'The first head of another branch is a baseline.');
});

test('a gate queued again or released after fifty newer gates still reports its new status', async t => {
  const runs: Record<string, RunRollup> = {};
  let firstA = true;
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), repository: null, runs, journeys: context => context.sha === B && firstA ? 0 : 1 });
  const commit = async (sha: string) => { h.current.sha = sha; await h.manager.run({ stageId: 'beta' }); await h.manager.idle(); };
  const postsOf = (sha: string, from: number) => h.posts.slice(from).filter(item => item.sha === sha).map(item => `${item.state}/${item.description}`);
  await commit(A);
  await commit(B);
  firstA = false;
  assert.equal(h.manager.view().stages.beta.status, 'needs-release');
  for (let index = 1; index <= 55; index++) await commit(index.toString(16).padStart(40, '0'));
  // A passed commit run again that now fails reports the failure, so branch protection sees it.
  runs['beta a'] = { status: 'failed', results: [{ caseId: 'journey', status: 'failed', error: 'A journey failed.' }] };
  let from = h.posts.length;
  await commit(A);
  assert.deepEqual(postsOf(A, from), ['pending/Running', 'failure/Failed']);
  // Releasing an older gate that needs release reports it released.
  from = h.posts.length;
  await h.manager.release({ stageId: 'beta', sha: B, login: 'glennlzl' });
  await h.manager.idle();
  assert.deepEqual(postsOf(B, from), ['success/Released by glennlzl']);
});

test('the first head another account reads is a baseline, never a push', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-'));
  await mkdir(join(dataDir, 'gates'));
  await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, gates: [], heads: { [KEY]: { branch: 'main', login: 'glennlzl', sha: A, etag: '"e1"' } } }));
  const h = await harness(t, { dataDir, connection: { login: 'someone-else', repository: 'owner/app' }, heads: [{ status: 200, sha: C, etag: '"e3"' }, { status: 200, sha: D, etag: '"e4"' }] });
  await h.manager.watch();
  assert.deepEqual([await h.gates(), h.log], [[], []], 'Nothing moves the source or rebuilds.');
  assert.deepEqual((({ login, sha }) => ({ login, sha }))((await h.saved()).heads[KEY]), { login: 'someone-else', sha: C });
  // Its next change is a push.
  await h.manager.watch();
  await h.manager.idle();
  assert.deepEqual((await h.gates('beta')).map(gate => [gate.stageId, gate.sha]), [['beta', D]]);
});

test('a renamed stage reports a commit run again under its new name', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), repository: null });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  h.current.stages = h.current.stages.map(stage => stage.id === 'beta' ? { ...stage, name: 'Staging' } : stage);
  const from = h.posts.length;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.deepEqual(h.posts.slice(from).map(item => `${item.context} ${item.state}`), ['perpetual/Staging pending', 'perpetual/Staging success']);
});

test('a watch failure is kept for the view and never throws', async t => {
  const h = await harness(t, { heads: [new Error('Could not read main from GitHub.')] });
  await h.manager.watch();
  assert.equal(h.manager.view().watchError, 'Could not read main from GitHub.');
});

test('Run now uses the watched head of a managed source, and the scanned commit otherwise', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), heads: [{ status: 200, sha: D, etag: '"1"' }] });
  h.current.sha = A;
  const view = await h.manager.run({ stageId: 'beta' });
  assert.equal(view.stages.beta.sha, D);
  await h.manager.idle();
  h.current.repository = null;
  h.current.sha = C;
  assert.equal((await h.manager.run({ stageId: 'beta' })).stages.beta.sha, C);
  await h.manager.idle();
  await assert.rejects(h.manager.run({ stageId: 'production' }), /Sandbox stage/);
});

test('a saved gate that is not a complete gate record makes the state unsupported, never a later TypeError', async t => {
  for (const gates of [[null], [{ id: 'g', status: 'passed' }], [{ id: 'g', key: KEY, branch: 'main', stageId: 'beta', sha: A, context: 'perpetual/Beta', createdAt: 'x', detectedAt: 'x', updatedAt: 'x', status: 'shipped' }]]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
    await mkdir(join(dataDir, 'gates')); await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, gates, heads: {} }));
    await assert.rejects(harness(t, { dataDir }), /Unsupported gate state/);
  }
});
