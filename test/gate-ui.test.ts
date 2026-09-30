import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canRelease, createGatePoller, gateActive, gateBadge, gateChanges, gatePending, productionStatus, shareGates, sourceMoved, type GateStatus, type GateView, type StageGate } from '../client/src/lib/stage-gate.ts';
import type { Timers } from '../client/src/lib/utils.ts';
import { transitionFlow } from '../client/src/lib/pipeline-flow.ts';
import { stageNodeData } from '../client/src/lib/pipeline-nodes.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
// Shapes as GET /api/gate replies with them (contract/gate.ts); a status the contract does not name still reaches the badge as data.
const gate = (status: string, extra: Partial<StageGate> = {}): StageGate => ({ id: `gate-${status}`, stageId: 'beta', sha: SHA, status: status as GateStatus, detectedAt: '2026-09-23T10:00:00.000Z', updatedAt: '2026-09-23T10:00:00.000Z', ...extra });
const view = (stages: Record<string, StageGate>, production: GateView['production'] = null): GateView => ({ repoPath: '/r', sha: SHA, stages, production });
const stages = [{ id: 'source', kind: 'source', name: 'Source' }, { id: 'build', kind: 'build', name: 'Build' }, { id: 'beta', kind: 'sandbox', name: 'Beta' }, { id: 'gamma', kind: 'sandbox', name: 'Gamma' }, { id: 'production', kind: 'production', name: 'Production' }];
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, blocked: false });

test('the stage Badge shows the gate state with its short commit', () => {
  const labels = ['queued', 'rebuilding', 'running', 'passed', 'failed', 'needs-release', 'released'].map(status => [gateBadge(gate(status))?.label, gateBadge(gate(status))?.tone]);
  assert.deepEqual(labels, [['Queued', 'idle'], ['Running', 'working'], ['Running', 'working'], ['Passed', 'passed'], ['Failed', 'failed'], ['Needs release', 'blocked'], ['Released', 'passed']]);
  assert.equal(gateBadge(gate('passed'))?.sha, 'cb9292c');
  assert.equal(gateBadge(gate('superseded')), null);
  assert.equal(gateBadge(null), null);
  assert.equal(gateBadge(gate('needs-release', { reason: 'A journey is blocked.', statusError: 'Connect GitHub to report commit status.' }))?.hint, 'A journey is blocked. Connect GitHub to report commit status.');
});

test('Release is offered only for a gate that needs release, never a failed one; Run now waits for pending gates', () => {
  assert.deepEqual(['needs-release', 'failed', 'passed', 'released', 'running', 'queued'].map(status => canRelease(gate(status))), [true, false, false, false, false, false]);
  assert.equal(canRelease(null), false);
  assert.deepEqual(['queued', 'rebuilding', 'running', 'passed', 'failed', 'needs-release'].map(status => gatePending(gate(status))), [true, true, true, false, false, false]);
  assert.deepEqual(['queued', 'rebuilding', 'running', 'passed'].map(status => gateActive(gate(status))), [false, true, true, false]);
});

test('waiting for Build keeps the same commit pending without offering a second run or test motion', () => {
  const waiting = gate('waiting-build', { reason: 'GitHub Actions is still running for this commit.' });
  assert.deepEqual(gateBadge(waiting), { label: 'Waiting for Build', tone: 'idle', sha: 'cb9292c', hint: 'GitHub Actions is still running for this commit.' });
  assert.equal(gatePending(waiting), true, 'Run now cannot queue another gate while Build is pending.');
  assert.equal(gateActive(waiting), false, 'Waiting for Build does not imply a test or rebuild is running.');
  assert.equal(canRelease(waiting), false, 'A user cannot release an unverified Build.');
});

test('a Build failure exposes the reason and commit, allows a recheck, and cannot be released', () => {
  const failed = gate('build-failed', { reason: 'GitHub Actions failed for this commit.', statusError: 'Connect GitHub to report commit status.' });
  assert.deepEqual(gateBadge(failed), { label: 'Build failed', tone: 'failed', sha: 'cb9292c', hint: 'GitHub Actions failed for this commit. Connect GitHub to report commit status.' });
  assert.equal(gatePending(failed), false, 'Run now can recheck the same commit after its workflow is rerun.');
  assert.equal(gateActive(failed), false);
  assert.equal(canRelease(failed), false, 'Build failure must be fixed rather than manually released.');
});

test('Production shows Ready only from a gate readiness record', () => {
  assert.deepEqual(productionStatus({ sha: SHA, status: 'ready' }), { kind: 'passed', text: 'Ready', sha: 'cb9292c' });
  assert.equal(productionStatus(null), null);
});

test('a gate view on another commit of the same checkout names the commit the source moved to', async () => {
  const repo = { path: '/sources/app', sha: 'a'.repeat(40) };
  assert.equal(sourceMoved({ repoPath: '/sources/app', sha: SHA }, repo), SHA);
  assert.equal(sourceMoved({ repoPath: '/sources/app', sha: repo.sha }, repo), null);
  assert.equal(sourceMoved({ repoPath: '/another', sha: SHA }, repo), null, 'Another source is not this source moving.');
  assert.equal(sourceMoved(null, repo), null);
  assert.equal(sourceMoved({ repoPath: '/sources/app', sha: null }, repo), null);
  // The page reloads once per reported commit, never again for a new callback while the next poll is pending.
  const source = await readFile(new URL('../client/src/StageGate.tsx', import.meta.url), 'utf8');
  assert.match(source, /const moved = sourceMoved\(view, repo\);/);
  assert.match(source, /useEffect\(\(\) => \{ if \(moved\) void reload\.current\(\); \}, \[moved\]\);/);
});

test('unchanged gates keep their identity across polls', () => {
  const first = { repoPath: '/r', sha: SHA, stages: { beta: gate('running'), gamma: gate('queued', { stageId: 'gamma' }) }, production: null };
  assert.equal(shareGates(first, structuredClone(first)), first);
  const next = structuredClone(first);
  next.stages.beta.status = 'passed';
  const shared = shareGates(first, next);
  assert.notEqual(shared?.stages?.beta, first.stages.beta);
  assert.equal(shared?.stages?.gamma, first.stages.gamma);
  assert.equal(shareGates(null, next), next);
  assert.equal(shareGates(first, null), null);
});

test('gate motion: an edge flows into a Sandbox stage only while its gate rebuilds or runs', () => {
  const gates = (status: string) => view({ gamma: gate(status, { stageId: 'gamma' }) });
  const context = (extra: { gates: GateView }) => ({ stages, sha: SHA, snapshot: { environments: [], browserTests: {} }, latest: {}, ...extra });
  for (const status of ['rebuilding', 'running']) assert.equal(transitionFlow(edge('beta', 'gamma'), context({ gates: gates(status) })), 'active', status);
  for (const status of ['queued', 'waiting-build', 'build-failed', 'passed', 'failed', 'needs-release', 'released']) assert.equal(transitionFlow(edge('beta', 'gamma'), context({ gates: gates(status) })), null, status);
  assert.equal(transitionFlow(edge('build', 'beta'), context({ gates: view({ beta: gate('running') }) })), 'active');
  assert.equal(transitionFlow({ ...edge('beta', 'gamma'), blocked: true }, context({ gates: gates('running') })), null, 'A paused edge never flows.');
  assert.equal(transitionFlow(edge('gamma', 'production'), context({ gates: view({}, { sha: SHA, status: 'ready' }) })), null);
});

test('stage data carries the Sandbox gate and Production readiness only', () => {
  const beta = gate('needs-release'), production = { sha: SHA, status: 'ready' as const };
  const context = { scan: { repo: { path: '/r', sha: SHA } }, pipeline: { stages, transitions: [] }, gates: view({ beta }, production) };
  assert.equal(stageNodeData(stages[2], context).gate, beta);
  assert.equal(stageNodeData(stages[3], context).gate, null);
  assert.equal(stageNodeData(stages[4], context).gate, production);
  assert.equal(stageNodeData(stages[0], context).gate, null);
  assert.equal(stageNodeData(stages[2], { ...context, gates: null }).gate, null);
});

test('the gate poller reads while visible, refreshes on demand and shows nothing after a failed read', async () => {
  const timers: Timers & { pending: (() => void)[] } = { pending: [], setTimeout(fn) { this.pending.push(fn); return this.pending.length; }, clearTimeout() {} };
  const document: { hidden: boolean; listeners: Record<string, () => void>; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string): void } = { hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; } };
  const views: (GateView | null)[] = [], replies: (GateView | Error)[] = [view({ beta: gate('running') }), new Error('Scan a repository first.')];
  let reads = 0;
  const controller = async (path: string) => { reads++; assert.equal(path, '/api/gate'); const next = replies.shift(); if (next instanceof Error) throw next; return next; };
  const poller = createGatePoller({ controller, onChange: view => views.push(view), document, timers });
  await new Promise(done => setImmediate(done));
  assert.equal(views[0]?.stages?.beta?.status, 'running');
  poller.refresh();
  await new Promise(done => setImmediate(done));
  assert.equal(views[1], null);
  document.hidden = true;
  timers.pending.at(-1)?.();
  await new Promise(done => setImmediate(done));
  assert.equal(reads, 2, 'A hidden page is not polled.');
  poller.stop();
  assert.equal(document.listeners.visibilitychange, undefined);
});

test('Run now and Release refresh every gate view', () => {
  let calls = 0;
  const stop = gateChanges.subscribe(() => calls++);
  gateChanges.notify();
  stop();
  gateChanges.notify();
  assert.equal(calls, 1);
});

test('the stage card uses native shadcn Badge and AlertDialog, and offers Release only through canRelease', async () => {
  const source = await readFile(new URL('../client/src/StageGate.tsx', import.meta.url), 'utf8');
  assert.match(source, /from '@\/components\/ui\/alert-dialog'/);
  assert.match(source, /from '@\/components\/ui\/badge'/);
  assert.match(source, /\{canRelease\(gate\) && <AlertDialog/);
  assert.match(source, />Run now</);
  const app = await readFile(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const sandbox = stage\.kind === 'sandbox';/);
  assert.match(app, /\{sandbox && <GateBadge gate=\{isStageGate\(gate\) \? gate : null\} \/>\}/);
  assert.match(app, /<GateActions repoPath=\{repoPath\} stage=\{stage\} gate=\{isStageGate\(gate\) \? gate : null\}/);
  assert.match(app, /transitionFlow\(edge, \{[^}]*gates \}\)/);
});
