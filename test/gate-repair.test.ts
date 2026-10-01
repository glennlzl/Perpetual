import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateManager, type GateGitHub, type GateStage, type GateSteps } from '../src/gate/manager.ts';
import type { BranchHead, CommitStatusPost } from '../src/gate/github.ts';
import type { Gate, GateRef, RunRollup } from '../src/gate/rules.ts';

// Repair gates beside the target branch's: an injected source, GitHub and steps record what each gate asked for and
// which commit the source is at. Nothing reaches the network or Docker.
const A = 'a'.repeat(40), B = 'b'.repeat(40), P = 'f'.repeat(40);
const KEY = 'github:owner/app:/', BRANCH = 'perpetual/repair/bbbbbbb', SNAPSHOT = '/data/repairs/r1/gate-fffffff';
const STAGES: GateStage[] = [
  { id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' },
  { id: 'beta', name: 'Beta', kind: 'sandbox' }, { id: 'gamma', name: 'Gamma', kind: 'sandbox' }, { id: 'production', name: 'Production', kind: 'production' },
];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const request = (extra: Record<string, unknown> = {}) => ({ key: KEY, repair: 'r1', branch: BRANCH, sha: P, snapshot: SNAPSHOT, ...extra });
type Context = { key: string; stageId: string; sha: string; repair?: string };
type HttpError = Error & { statusCode?: number };

async function harness(t: TestContext, { dataDir, stages = STAGES, runs = {}, heads = [] }: { dataDir?: string; stages?: GateStage[]; runs?: Record<string, RunRollup>; heads?: BranchHead[] } = {}) {
  dataDir ??= await mkdtemp(join(tmpdir(), 'perpetual-gate-repair-'));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, 0, tick++)).toISOString();
  const current = { key: KEY, branch: 'main' as string | null, sha: A, repository: 'owner/app' as string | null, stages };
  const log: string[] = [], refs: GateRef[] = [], posts: CommitStatusPost[] = [];
  const holds: { prepare?: (gate: GateRef) => Promise<void>; run?: (context: Context) => Promise<void> } = {};
  const github: GateGitHub = {
    build: async () => ({ status: 'passed' }),
    connection: async () => ({ login: 'developer', repository: 'owner/app' }),
    async head() { return heads.shift() ?? { status: 200, sha: current.sha, etag: null }; },
    async post(status) { posts.push(status); },
  };
  const steps: GateSteps<Context, { id: string }> = {
    async prepare(gate) {
      refs.push(gate);
      log.push(`prepare ${gate.stageId} ${gate.sha[0]}`);
      if (holds.prepare) await holds.prepare(gate);
      // Only a target-branch gate moves the source; a repair gate reads its snapshot.
      if (!gate.repair) current.sha = gate.sha;
      return { key: gate.key, stageId: gate.stageId, sha: gate.sha, ...(gate.repair ? { repair: gate.repair } : {}) };
    },
    journeys: () => 1,
    async rebuild(context) { log.push(`rebuild ${context.stageId} ${context.sha[0]}`); return { id: `twin-${context.stageId}` }; },
    async run(context) {
      log.push(`run ${context.stageId} ${context.sha[0]}`);
      if (holds.run) await holds.run(context);
      return { id: `run-${context.stageId}-${context.sha[0]}`, ...(runs[`${context.stageId} ${context.sha[0]}`] ?? { status: 'passed' }) };
    },
  };
  const manager = await createGateManager({ dataDir, source: () => current, github, steps, now, retryInterval: 5 });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const gates = async (): Promise<Gate[]> => JSON.parse(await readFile(join(dataDir, 'gates', 'state.json'), 'utf8')).gates;
  const posted = (sha: string) => posts.filter(item => item.sha === sha).map(item => [item.context, item.state, item.description]);
  return { manager, current, log, refs, posts, holds, dataDir, gates, posted };
}

test('a repair gate runs each Sandbox stage in pipeline order at the pull request head, over its snapshot, reporting on that head', async t => {
  const h = await harness(t);
  const result = await h.manager.runRepair(request());
  assert.deepEqual(result.gates.map(gate => [gate.stageId, gate.sha, gate.status, gate.context]), [['beta', P, 'passed', 'perpetual/Beta'], ['gamma', P, 'passed', 'perpetual/Gamma']]);
  assert.deepEqual(h.log, ['prepare beta f', 'rebuild beta f', 'run beta f', 'prepare gamma f', 'rebuild gamma f', 'run gamma f']);
  assert.deepEqual(h.manager.repairStages(KEY), ['beta', 'gamma']);
  assert.deepEqual(h.refs.map(ref => [ref.branch, ref.repair, ref.snapshot]), [[BRANCH, 'r1', SNAPSHOT], [BRANCH, 'r1', SNAPSHOT]], 'The steps get the repair and its snapshot.');
  await h.manager.idle();
  assert.deepEqual(h.posted(P), [['perpetual/Beta', 'pending', 'Running'], ['perpetual/Beta', 'success', 'Passed'], ['perpetual/Gamma', 'pending', 'Running'], ['perpetual/Gamma', 'success', 'Passed']]);
  assert.ok(h.posts.every(item => item.repository === 'owner/app'));
  assert.deepEqual(h.manager.view(), { stages: {}, production: null }, 'A repair gate is not the stage\'s gate and never makes Production Ready.');
  assert.equal(h.current.sha, A, 'The source never moves to the pull request head.');
});

test('a repair\'s gates stop at the first stage that does not pass, and a pipeline without a Sandbox stage has none', async t => {
  for (const [status, gate] of [['blocked', 'needs-release'], ['failed', 'failed']] as const) {
    await t.test(status, async t => {
      const h = await harness(t, { runs: { 'beta f': { status, results: [{ caseId: 'journey', status }] } } });
      const result = await h.manager.runRepair(request());
      assert.deepEqual(result.gates.map(item => [item.stageId, item.status]), [['beta', gate]]);
      assert.equal(h.log.some(line => line.includes('gamma')), false, 'Gamma is never queued.');
    });
  }
  const none = await harness(t, { stages: STAGES.filter(stage => stage.kind !== 'sandbox') });
  assert.deepEqual([none.manager.repairStages(KEY), none.manager.repairStages('github:owner/other:/')], [[], null], 'Only the active pipeline answers which stages its repair gates run.');
  assert.deepEqual(await none.manager.runRepair(request()), { gates: [] });
  assert.deepEqual(await none.gates(), []);
});

test('a repair gate neither supersedes nor is superseded by target-branch gates, which run first and alone promote', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), heads: [{ status: 200, sha: A, etag: '"1"' }, { status: 304 }, { status: 200, sha: B, etag: '"2"' }] });
  await h.manager.watch();
  const release = deferred();
  h.holds.run = async context => { if (!context.repair && context.sha === A) await release.promise; };
  await h.manager.run({ stageId: 'beta' });
  while (h.manager.view().stages.beta?.status !== 'running') await new Promise(done => setTimeout(done, 1));
  const repaired = h.manager.runRepair(request());
  while (!(await h.gates()).some(gate => gate.repair)) await new Promise(done => setTimeout(done, 1));
  await h.manager.watch(); // push B while Beta tests A and the repair gate waits
  const during = await h.gates();
  assert.deepEqual(during.map(gate => [gate.sha[0], gate.status, gate.repair ?? null]), [['b', 'queued', null], ['f', 'queued', 'r1'], ['a', 'running', null]]);
  release.resolve();
  const result = await repaired;
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a', 'run beta b', 'run beta f'], 'A queued target-branch gate runs before the repair gate.');
  assert.deepEqual(result.gates.map(gate => [gate.sha, gate.status]), [[P, 'passed']]);
  assert.deepEqual((await h.gates()).map(gate => [gate.sha[0], gate.status]), [['b', 'passed'], ['f', 'passed'], ['a', 'passed']], 'Nothing is superseded.');
  assert.deepEqual([h.manager.view().stages.beta.sha, h.manager.view().production], [B, { sha: B, status: 'ready' }], 'The stage shows the target branch\'s gate, and Production follows it.');
});

test('a passed repair gate enqueues no target-branch gate, and a repair gate a person releases reports on the head and promotes nothing', async t => {
  const h = await harness(t, { runs: { 'beta f': { status: 'blocked' } } });
  const result = await h.manager.runRepair(request());
  assert.deepEqual(result.gates.map(gate => [gate.stageId, gate.status, gate.reason]), [['beta', 'needs-release', 'A journey is blocked.']]);
  const view = await h.manager.release({ stageId: 'beta', sha: P, login: 'developer' });
  await h.manager.idle();
  assert.deepEqual(view, { stages: {}, production: null });
  assert.deepEqual((await h.gates()).map(gate => [gate.stageId, gate.status, gate.releasedBy]), [['beta', 'released', 'developer']], 'No Gamma gate is queued.');
  assert.deepEqual(h.posted(P).at(-1), ['perpetual/Beta', 'success', 'Released by developer']);
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: P, login: 'developer' }), (error: HttpError) => error.statusCode === 409);
});

test('a repair that stops ends its queued gate as superseded with nothing reported, and a gate at work still reaches its verdict', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma') });
  const release = deferred();
  h.holds.run = async context => { if (!context.repair) await release.promise; };
  await h.manager.run({ stageId: 'beta' });
  while (h.manager.view().stages.beta?.status !== 'running') await new Promise(done => setTimeout(done, 1));
  const queued = new AbortController();
  const stopped = h.manager.runRepair(request(), queued.signal);
  while (!(await h.gates()).some(gate => gate.repair)) await new Promise(done => setTimeout(done, 1));
  queued.abort();
  assert.deepEqual((await stopped).gates.map(gate => [gate.status, gate.reason]), [['superseded', 'The repair stopped.']]);
  release.resolve();
  await h.manager.idle();
  assert.deepEqual([h.log.filter(line => line.startsWith('run')), h.posted(P)], [['run beta a'], []]);
  const working = deferred(), running = new AbortController();
  h.holds.run = async context => { if (context.repair) await working.promise; };
  const judged = h.manager.runRepair(request(), running.signal);
  while (!(await h.gates()).some(gate => gate.repair && gate.status === 'running')) await new Promise(done => setTimeout(done, 1));
  running.abort();
  working.resolve();
  assert.deepEqual((await judged).gates.map(gate => gate.status), ['passed'], 'A gate at work cannot be cancelled, so its verdict is recorded.');
});

test('a repair that stops while a gate is at work records its next stage as superseded, so its gates never read as complete', async t => {
  const h = await harness(t);
  const working = deferred(), stop = new AbortController();
  h.holds.run = async () => { await working.promise; };
  const judged = h.manager.runRepair(request(), stop.signal);
  while (!(await h.gates()).some(gate => gate.status === 'running')) await new Promise(done => setTimeout(done, 1));
  stop.abort();
  working.resolve();
  assert.deepEqual((await judged).gates.map(gate => [gate.stageId, gate.status, gate.reason ?? null]), [['beta', 'passed', null], ['gamma', 'superseded', 'The repair stopped.']]);
  await h.manager.idle();
  assert.deepEqual([h.log.filter(line => line.includes('gamma')), h.posted(P).map(([context]) => context)], [[], ['perpetual/Beta', 'perpetual/Beta']], 'Gamma never runs or reports.');
});

test('a queued target-branch gate that cannot start yet still runs before a repair gate', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma'), heads: [{ status: 200, sha: A, etag: '"1"' }, { status: 304 }, { status: 200, sha: B, etag: '"2"' }] });
  await h.manager.watch();
  const release = deferred();
  h.holds.run = async context => { if (!context.repair && context.sha === A) await release.promise; };
  await h.manager.run({ stageId: 'beta' });
  while (h.manager.view().stages.beta?.status !== 'running') await new Promise(done => setTimeout(done, 1));
  const repaired = h.manager.runRepair(request());
  while (!(await h.gates()).some(gate => gate.repair)) await new Promise(done => setTimeout(done, 1));
  await h.manager.watch(); // push B while Beta tests A and the repair gate waits
  let busy = true;
  h.holds.prepare = async gate => { if (!gate.repair && gate.sha === B && busy) { busy = false; throw Object.assign(new Error('Finish adding this test before changing the source.'), { statusCode: 409 }); } };
  release.resolve();
  await repaired;
  await h.manager.idle();
  assert.deepEqual(h.log.filter(line => line.startsWith('prepare')), ['prepare beta a', 'prepare beta b', 'prepare beta b', 'prepare beta f'], 'The repair gate waits for the target-branch gate\'s retry.');
  assert.deepEqual(h.log.filter(line => line.startsWith('run')), ['run beta a', 'run beta b', 'run beta f']);
});

test('a queued repair gate whose source is no longer active ends without a verdict, and another source is refused', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma') });
  const release = deferred();
  h.holds.run = async context => { if (!context.repair) await release.promise; };
  await h.manager.run({ stageId: 'beta' });
  while (h.manager.view().stages.beta?.status !== 'running') await new Promise(done => setTimeout(done, 1));
  const repaired = h.manager.runRepair(request());
  while (!(await h.gates()).some(gate => gate.repair)) await new Promise(done => setTimeout(done, 1));
  h.current.key = 'github:owner/other:/';
  release.resolve();
  assert.deepEqual((await repaired).gates.map(gate => [gate.status, gate.reason]), [['needs-release', 'The active source changed.']]);
  await assert.rejects(h.manager.runRepair(request()), (error: HttpError) => error.statusCode === 409 && error.message === 'The active source changed.');
  h.current.key = KEY;
  for (const [field, value] of [['repair', ''], ['branch', 'main'], ['sha', 'main'], ['snapshot', 'relative/path'], ['snapshot', null]] as const) {
    await assert.rejects(h.manager.runRepair(request({ [field]: value })), /Name the repair|Choose the pull request/, `${field}: ${String(value)}`);
  }
});

test('a controller restart ends a repair gate at work or still queued without a verdict, and reports it on the head', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-repair-'));
  await mkdir(join(dataDir, 'gates'));
  const at = '2026-09-25T09:00:00.000Z';
  const base = { key: KEY, branch: BRANCH, sha: P, repair: 'r1', snapshot: SNAPSHOT, createdAt: at, updatedAt: at, detectedAt: at };
  await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, heads: {}, gates: [
    { ...base, id: '1', stageId: 'beta', status: 'running', context: 'perpetual/Beta', posted: { state: 'pending', context: 'perpetual/Beta', description: 'Running' } },
    { ...base, id: '2', stageId: 'gamma', status: 'queued', context: 'perpetual/Gamma' },
  ] }));
  const h = await harness(t, { dataDir });
  assert.deepEqual((await h.gates()).map(gate => [gate.stageId, gate.status, gate.reason]), [['beta', 'needs-release', 'Interrupted by a controller restart.'], ['gamma', 'needs-release', 'Interrupted by a controller restart.']]);
  h.manager.start();
  await h.manager.idle();
  assert.deepEqual(h.log, [], 'Nothing runs again.');
  // Statuses are reported most recently updated first; both gates end together, so only the set is fixed.
  assert.deepEqual([...h.posted(P)].sort(), [['perpetual/Beta', 'pending', 'Needs release'], ['perpetual/Gamma', 'pending', 'Needs release']]);
  assert.deepEqual(h.manager.view(), { stages: {}, production: null });
});

test('shutdown ends a repair\'s wait for its gate', async t => {
  const h = await harness(t, { stages: STAGES.filter(stage => stage.id !== 'gamma') });
  const release = deferred();
  h.holds.run = async () => { await release.promise; };
  const waiting = h.manager.runRepair(request());
  while (!(await h.gates()).some(gate => gate.status === 'running')) await new Promise(done => setTimeout(done, 1));
  const closing = h.manager.close();
  await assert.rejects(waiting, (error: HttpError) => error.statusCode === 409 && /shutting down/.test(error.message));
  release.resolve();
  await closing;
});

test('a repair that stops after the queue chose its gate, before the gate starts, never runs or reports it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-repair-')), file = join(dataDir, 'gates', 'state.json');
  const stop = new AbortController(), stages = STAGES.filter(stage => stage.id !== 'gamma'), prepared: string[] = [], posts: CommitStatusPost[] = [];
  let stopped = false;
  // The queue reads the stages as it chooses the next gate. Once the repair gate is queued, the repair stops in the
  // moment after that choice and before the gate starts.
  const current = { key: KEY, branch: 'main', sha: A, repository: 'owner/app', get stages() {
    if (!stopped && existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')).gates as Gate[]).some(gate => gate.repair && gate.status === 'queued')) { stopped = true; queueMicrotask(() => stop.abort()); }
    return stages;
  } };
  const manager = await createGateManager({ dataDir, source: () => current, retryInterval: 5,
    github: { connection: async () => ({ login: 'developer', repository: 'owner/app' }), head: async () => ({ status: 304 }), async post(status) { posts.push(status); } },
    steps: { async prepare(gate) { prepared.push(gate.stageId); return gate; }, journeys: () => 1, async rebuild() { return { id: 'twin' }; }, async run() { return { status: 'passed' }; } },
  });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const result = await manager.runRepair(request(), stop.signal);
  await manager.idle();
  assert.equal(stopped, true);
  assert.deepEqual(result.gates.map(gate => [gate.stageId, gate.status, gate.reason]), [['beta', 'superseded', 'The repair stopped.']]);
  assert.deepEqual([prepared, posts], [[], []], 'The gate is never prepared, rebuilt, run or reported.');
  assert.deepEqual((JSON.parse(await readFile(file, 'utf8')).gates as Gate[]).map(gate => gate.status), ['superseded']);
});
