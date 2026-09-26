import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_LABELS, MODE_LABELS, autopilotActive, autopilotBadge, autopilotChanges, changeActive, createAutopilotPoller, isAutopilotMode, saveAutopilotMode, shareAutopilot, stageActive } from '../client/src/lib/pipeline-autopilot.ts';
import type { AutopilotChange, AutopilotView, StageAutopilot } from '../client/src/lib/pipeline-autopilot.ts';

// Shapes GET /api/autopilot reports for a stage's changes.
const change = (id: string, status: AutopilotChange['status'], extra: Partial<AutopilotChange> = {}): AutopilotChange => ({
  id, stageId: 'build', kind: 'update', title: 'Updating dependencies', status,
  steps: [{ id: 'found', name: 'Found', status: 'done', detail: ['Dependabot alert ', { text: 'GHSA-9qxr', href: 'https://github.com/acme/app/security/dependabot/1' }] }, { id: 'merge', name: 'Merge', status: status === 'running' ? 'pending' : 'done' }],
  ...extra,
});
const stage = (mode: StageAutopilot['mode'], ...changes: AutopilotChange[]): StageAutopilot => ({ mode, changes });
const view = (stages: Record<string, StageAutopilot>): AutopilotView => ({ repoPath: '/repo', stages });
type TimerHandle = { callback: () => unknown; delay: number };
function harness() {
  const timers: { queue: TimerHandle[]; setTimeout(callback: () => unknown, delay: number): TimerHandle; clearTimeout(handle: unknown): void } = { queue: [], setTimeout(callback, delay) { const handle = { callback, delay }; this.queue.push(handle); return handle; }, clearTimeout(handle) { this.queue = this.queue.filter(item => item !== handle); } };
  const document = Object.assign(new EventTarget(), { hidden: false });
  return { timers, document, next: () => timers.queue.at(-1)!, fire: async () => { const handle = timers.queue.shift()!; await handle.callback(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the Badge reads the work under way, else the latest change, else the mode', () => {
  assert.equal(autopilotBadge(null), null);
  assert.deepEqual(autopilotBadge(stage('merge')), { text: 'Autopilot', tone: 'idle', change: null });
  assert.deepEqual(autopilotBadge(stage('ask')), { text: 'Ask first', tone: 'idle', change: null });
  const running = change('c2', 'running'), merged = change('c1', 'merged', { pullRequest: { number: 128, url: 'https://github.com/acme/app/pull/128' } });
  assert.deepEqual(autopilotBadge(stage('merge', running, merged)), { text: 'Updating dependencies', tone: 'working', change: running }, 'Work under way names itself.');
  assert.deepEqual(autopilotBadge(stage('merge', merged)), { text: 'Merged', tone: 'passed', change: merged });
  assert.equal(autopilotBadge(stage('ask', change('c3', 'needs-review')))!.tone, 'blocked');
  assert.equal(autopilotBadge(stage('merge', change('c4', 'not-merged')))!.tone, 'failed');
  assert.equal(autopilotBadge(stage('merge', change('c5', 'passed', { title: 'Rerunning build' })))!.tone, 'passed', 'A failure that cleared without a change.');
  const older = change('c6', 'not-merged', { sha: 'a'.repeat(40) });
  assert.deepEqual(autopilotBadge(stage('merge', older), 'b'.repeat(40)), { text: 'Autopilot', tone: 'idle', change: null }, 'An older commit\'s end no longer describes the stage.');
  assert.deepEqual(autopilotBadge(stage('merge', older), 'a'.repeat(40)), { text: 'Not merged', tone: 'failed', change: older }, 'The scanned commit\'s end does.');
  assert.deepEqual(autopilotBadge({ ...stage('merge', older), failed: { sha: 'a'.repeat(40), runs: [] } }, 'b'.repeat(40)), { text: 'Not merged', tone: 'failed', change: older }, 'So does the watched head\'s.');
  assert.deepEqual(autopilotBadge(stage('merge', change('c7', 'running', { sha: 'a'.repeat(40) })), 'b'.repeat(40))!.text, 'Updating dependencies', 'Work under way always names itself.');
  assert.deepEqual(Object.values(CHANGE_LABELS), ['Running', 'Merged', 'Passed', 'Needs review', 'Not merged']);
  assert.deepEqual(MODE_LABELS, { merge: 'Autopilot', ask: 'Ask first' });
});

test('only a running change is active, and a view is active while any stage has one', () => {
  assert.equal(changeActive(change('c', 'running')), true);
  assert.equal(changeActive(change('c', 'merged')), false);
  assert.equal(stageActive(stage('merge', change('c', 'needs-review'))), false);
  assert.equal(stageActive(null), false);
  assert.equal(autopilotActive(view({ build: stage('merge'), production: stage('ask', change('p', 'running')) })), true);
  assert.equal(autopilotActive(view({ build: stage('merge') })), false);
  assert.equal(autopilotActive(null), false);
  assert.deepEqual(['merge', 'ask', 'off', 1, null].map(isAutopilotMode), [true, true, false, false, false]);
});

test('unchanged stages keep their identity across polls', () => {
  const first = view({ build: stage('merge', change('c', 'running')), production: stage('ask') });
  const second = view({ build: stage('merge', change('c', 'merged')), production: stage('ask') });
  assert.equal(shareAutopilot(first, structuredClone(first)), first, 'An identical view is the previous one.');
  const shared = shareAutopilot(first, second)!;
  assert.equal(shared.stages!.production, first.stages!.production, 'A stage that did not change keeps its record.');
  assert.equal(shared.stages!.build, second.stages!.build);
  assert.equal(shareAutopilot(null, second), second);
  assert.equal(shareAutopilot(first, null), null);
});

test('saving a mode posts it and refreshes every open view; another value is refused', async () => {
  const requests: [string, unknown][] = [];
  let notified = 0;
  const stop = autopilotChanges.subscribe(() => { notified += 1; });
  await saveAutopilotMode(async (path, input) => { requests.push([path, input]); return {}; }, { repoPath: '/repo', stageId: 'build', mode: 'ask' });
  assert.deepEqual(requests, [['/api/autopilot/mode', { repoPath: '/repo', stageId: 'build', mode: 'ask' }]]);
  assert.equal(notified, 1);
  await assert.rejects(saveAutopilotMode(async () => ({}), { repoPath: '/repo', stageId: 'build', mode: 'off' as never }), /Merge changes or Ask before merging/);
  assert.equal(notified, 1, 'A refused mode refreshes nothing.');
  stop();
});

test('the poller reads every 2 seconds while a change is under way, otherwise every 15', async () => {
  const h = harness(), requests: string[] = [], changes: (AutopilotView | null)[] = [];
  let response = view({ build: stage('merge', change('c', 'running')) });
  const poller = createAutopilotPoller({ controller: async path => { requests.push(path); return structuredClone(response); }, repoPath: '/repo', onChange: value => changes.push(value), document: h.document, timers: h.timers });
  await flush();
  assert.deepEqual(requests, ['/api/autopilot?repoPath=%2Frepo']);
  assert.equal(h.next().delay, 2000);
  await h.fire();
  assert.equal(changes.length, 1, 'An unchanged view is not republished.');
  response = view({ build: stage('merge', change('c', 'merged')) });
  await h.fire();
  assert.equal(changes.length, 2);
  assert.equal(h.next().delay, 15000);
  poller.refresh();
  await flush();
  assert.equal(requests.length, 4, 'A refresh reads at once.');
  poller.stop();
  assert.equal(h.timers.queue.length, 0);
});
