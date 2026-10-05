import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateManager, type GateStage, type RepairGateRequest, type RepairGateView } from '../src/gate/manager.ts';
import type { CheckRun, CommitChecks, PullRequestState, StatusCheck } from '../src/repair/github.ts';
import type { Repair, RepairProgress } from '../src/repair/manager.ts';
import { AUTO_MERGE_OFF, HEAD_CHANGED, UNREADY, checksVerdict, createRepairMerge, type CiVerdict, type MERGE, type MergeGitHub } from '../src/repair/merge.ts';
import { HELD } from '../src/repair/changes.ts';

// The merge step through its interface: a fake GitHub (pull request, checks, statuses, target head, comparison, branch
// update and merge), fake repair gates and a host double that makes each checkout a folder. Nothing reaches GitHub,
// Docker or a model.
const B = 'b'.repeat(40), P = 'f'.repeat(40), U = 'e'.repeat(40), T = 'c'.repeat(40), M = 'd'.repeat(40);
const KEY = 'github:owner/app:/', BRANCH = 'perpetual/repair/bbbbbbb';
const at = '2026-09-25T10:00:00.000Z';
const REPAIR = { id: 'r1', key: KEY, repository: 'owner/app', branch: 'main', sha: B, login: 'developer', checkoutPath: '/data/sources/github-1/app', rootDirectory: '/', trigger: 'push', status: 'verifying-ci', runs: [], createdAt: at, updatedAt: at } as Repair;
const PULL = { number: 7, url: 'https://github.com/owner/app/pull/7', branch: BRANCH, draft: false };
const passed = (run = 'CI'): CheckRun => ({ name: run, status: 'completed', conclusion: 'success' });
const status = (context: string, state = 'success'): StatusCheck => ({ context, state });
const gate = (stage: string, sha: string, state = 'passed', extra: Partial<RepairGateView> = {}): RepairGateView => ({ id: `gate-${stage}-${sha[0]}`, stageId: stage.toLowerCase(), sha, status: state as RepairGateView['status'], context: `perpetual/${stage}`, detectedAt: at, updatedAt: at, ...extra });
type HttpError = Error & { refused?: true };

/**
 * GitHub keeps the pull request's head, the target branch's head and how far the head is behind it; checks answers a
 * head's checks, by default CI and every gate status passing, and parents a commit's parents, by default those of
 * GitHub's merge of the target branch into the head it updated. connectionRead runs at each read of the connection.
 * gates answers each head's repair gates, Beta passing by default. draft hands over a pull request the agent step could
 * not mark ready, which stays a draft on GitHub until ready succeeds; ready answers each attempt. order names GitHub's
 * reads and writes in turn.
 */
async function harness(t: TestContext, { holds = [] as string[], behind = [] as number[], gates, stages, checks, ci, merge, update, parents, connectionRead, timing, draft = false, ready }: {
  holds?: string[]; behind?: number[]; gates?: (request: RepairGateRequest, signal?: AbortSignal) => Promise<RepairGateView[]>; stages?: readonly string[] | null;
  checks?: (sha: string, read: number) => CommitChecks; ci?: (sha: string) => CiVerdict; merge?: () => Error | null; update?: () => Error | null;
  parents?: (sha: string) => string[]; connectionRead?: () => void; timing?: Partial<typeof MERGE>; draft?: boolean; ready?: () => Error | null;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-repair-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pull: PullRequestState = { state: 'open', merged: false, mergeCommit: null, draft, head: { sha: P, ref: BRANCH, repository: 'owner/app' }, base: { sha: T, ref: 'main' } };
  const calls = { checkouts: [] as { directory: string; sha: string; branch: string; clone: string }[], gates: [] as RepairGateRequest[], checks: [] as string[], compares: [] as { base: string; head: string }[], updates: [] as { number: number; sha: string }[], merges: [] as { number: number; sha: string; title: string }[], ci: [] as string[], snapshots: [] as string[][], readied: [] as number[], order: [] as string[] };
  const merges = new Map<string, string[]>();
  const reports: RepairProgress[] = [];
  let connection: { login: string; repository: string } | null = { login: 'developer', repository: 'owner/app' }, reads = 0, autoMerge = true;
  const github: MergeGitHub = {
    async connection() { connectionRead?.(); return connection; },
    async head() { calls.order.push('head'); return { status: 200, sha: T, etag: null }; },
    async pull() { calls.order.push('pull'); return structuredClone(pull); },
    async ready({ number }) {
      calls.readied.push(number as number);
      const error = ready?.();
      if (error) throw error;
      pull.draft = false;
    },
    async checks({ sha }) { calls.checks.push(sha as string); reads += 1; return checks?.(sha as string, reads) ?? { runs: [passed()], statuses: calls.gates.filter(item => item.sha === sha).length ? [status('perpetual/Beta')] : [], complete: true }; },
    async compare({ base, head }) { calls.order.push('compare'); calls.compares.push({ base: base as string, head: head as string }); return { status: 'behind', behindBy: behind.shift() ?? 0, aheadBy: 1 }; },
    async updateBranch({ number, sha }) {
      calls.updates.push({ number: number as number, sha: sha as string });
      const error = update?.();
      if (error) throw error;
      // Each update merges the target branch into the repair branch as a new head.
      const head = [U, '9'.repeat(40), '8'.repeat(40)][calls.updates.length - 1];
      merges.set(head, [sha as string, T]);
      pull.head.sha = head;
    },
    async parents({ sha }) { return parents?.(sha as string) ?? merges.get(sha as string) ?? []; },
    async merge({ number, sha, title }) {
      calls.order.push('merge');
      calls.merges.push({ number: number as number, sha: sha as string, title });
      const error = merge?.();
      if (error) throw error;
      return { sha: M };
    },
  };
  // Each read of the clock moves it on 1 ms, so the checks' and the update's waits end after as many reads, however busy
  // the machine running the test is.
  let now = 0;
  const merger = createRepairMerge({
    github, timing: { pollMs: 1, checksMs: 20, headMs: 20, ...timing }, clock: () => now++,
    host: { async checkout(input) { calls.checkouts.push(input); await mkdir(input.directory, { recursive: true }); return input.directory; } },
    gates: {
      ...(stages === undefined ? {} : { repairStages: () => stages }),
      async runRepair(request, signal) {
        calls.gates.push(request);
        calls.snapshots.push(await readdir(directory));
        return { gates: gates ? await gates(request, signal) : [gate('Beta', request.sha as string)] };
      },
    },
  });
  const input = {
    repair: REPAIR, pullRequest: { ...PULL, draft }, sha: P, holds, directory, clone: join(directory, 'clone'), title: 'Fix the failed CI build at bbbbbbb',
    autoMerge: () => autoMerge, report: async (progress: RepairProgress) => { reports.push(structuredClone(progress)); },
    ci: async (sha: string) => { calls.ci.push(sha); return ci?.(sha) ?? { status: 'passed' as const }; },
  };
  const run = (signal = new AbortController().signal) => merger.merge(input, signal);
  return { run, merger, calls, reports, pull, directory, setAutoMerge: (value: boolean) => { autoMerge = value; }, setConnection: (value: typeof connection) => { connection = value; } };
}

test('a pull request whose gates passed at its head, with every check green and an unmoved base, is squash-merged at that head', async t => {
  const h = await harness(t);
  assert.deepEqual(await h.run(), { status: 'merged', merged: M });
  assert.deepEqual(h.calls.gates, [{ key: KEY, repair: 'r1', branch: BRANCH, sha: P, snapshot: join(h.directory, 'gate-fffffff') }], 'The gates run at the pull request head over its own checkout.');
  assert.deepEqual(h.calls.checkouts.map(item => [item.sha, item.branch, item.clone]), [[P, BRANCH, join(h.directory, 'clone')]]);
  assert.deepEqual(h.calls.snapshots, [['gate-fffffff']]);
  assert.deepEqual(await readdir(h.directory), [], 'The checkout is removed once the gates are judged.');
  assert.deepEqual(h.calls.compares, [{ base: T, head: P }], 'The head is compared with the target branch as GitHub has it now.');
  assert.deepEqual(h.calls.merges, [{ number: 7, sha: P, title: 'Fix the failed CI build at bbbbbbb (#7)' }], 'The merge names the verified head.');
  assert.deepEqual(h.reports, [{ status: 'verifying-gates' }, { gates: [{ gateId: 'gate-Beta-f', stageId: 'beta', sha: P, status: 'passed' }], verified: P }, { merged: M }]);
});

// The view's Verify step reads what was verified, never a guess from the gates or the draft.
test('a head is recorded verified only once every gate passed there, and a head the update made is verified again', async t => {
  const verified = (h: Awaited<ReturnType<typeof harness>>) => h.reports.flatMap(report => report.verified ? [report.verified] : []);
  const failing = await harness(t, { gates: async request => [gate('Beta', request.sha as string, 'failed', { reason: 'A journey failed.' })] });
  await failing.run();
  assert.deepEqual(verified(failing), [], 'A gate that did not pass verifies nothing.');
  const stopped = await harness(t, { stages: null });
  assert.deepEqual([(await stopped.run()).reason, verified(stopped)], ['The active source changed.', []], 'Nor does a merge step that stopped before any gate ran.');
  const unready = await harness(t, { stages: [], draft: true, ready: () => new Error('GitHub denied the pull request. Check write access to this repository.') });
  assert.deepEqual([(await unready.run()).reason, verified(unready)], [UNREADY, [P]], 'Without a Sandbox stage CI verified the head, though GitHub keeps it a draft.');
  const updated = await harness(t, { behind: [1], ci: sha => sha === U ? { status: 'failed', reason: 'The updated pull request failed CI: CI.' } : { status: 'passed' } });
  await updated.run();
  assert.deepEqual([verified(updated), updated.reports.at(-1)], [[P], { pushed: U }], 'The updated head that failed CI is pushed but never verified.');
  const merged = await harness(t, { behind: [1, 0] });
  await merged.run();
  assert.deepEqual(verified(merged), [P, U]);
});

test('a repository without a Sandbox stage merges on CI alone, and a repair of a pipeline no longer active never does', async t => {
  const h = await harness(t, { stages: [] });
  assert.deepEqual(await h.run(), { status: 'merged', merged: M });
  assert.deepEqual([h.calls.merges.map(item => item.sha), h.calls.checkouts, h.calls.gates], [[P], [], []], 'No checkout is made without a gate to read it.');
  const other = await harness(t, { stages: null });
  assert.deepEqual(await other.run(), { status: 'ready', reason: 'The active source changed.' });
  assert.deepEqual([other.calls.checkouts, other.calls.gates, other.calls.merges], [[], [], []]);
  const refused = await harness(t, { gates: async () => { throw Object.assign(new Error('The active source changed.'), { statusCode: 409 }); } });
  assert.deepEqual(await refused.run(), { status: 'ready', reason: 'The active source changed.' }, 'The gate manager refuses a pipeline that changed meanwhile.');
  assert.deepEqual([await readdir(refused.directory), refused.calls.merges], [[], []]);
});

test('only a pass merges: a gate that failed, needs release or was released leaves the fix ready for a person', async t => {
  for (const [name, judged, reason] of [
    ['failed', gate('Beta', P, 'failed', { reason: 'Saving the workflow did not keep it.' }), 'Beta failed: Saving the workflow did not keep it.'],
    ['no reviewed journeys', gate('Beta', P, 'needs-release', { reason: 'No reviewed journeys.' }), 'Beta needs release: No reviewed journeys.'],
    ['released', gate('Beta', P, 'released', { releasedBy: 'developer' }), 'Beta was released by developer.'],
  ] as const) {
    await t.test(name, async t => {
      const h = await harness(t, { gates: async () => [gate('Alpha', P), judged] });
      const outcome = await h.run();
      assert.deepEqual([outcome.status, outcome.reason], ['ready', reason]);
      assert.deepEqual([h.calls.merges, h.calls.checks], [[], []], 'Nothing is read or merged after a gate that did not pass.');
    });
  }
});

test('a change rule\'s hold, a closed or draft pull request and a head that moved after verification never merge', async t => {
  const cases: [string, (h: Awaited<ReturnType<typeof harness>>) => void, string, string[]?][] = [
    ['holds', () => {}, `Held for a person: ${HELD.tests}`, [HELD.tests]],
    ['draft', h => { h.pull.draft = true; }, 'The pull request is a draft.'],
    ['closed', h => { h.pull.state = 'closed'; }, 'The pull request was closed.'],
    ['head changed', h => { h.pull.head.sha = U; }, HEAD_CHANGED],
    ['another base', h => { h.pull.base.ref = 'release'; }, `The pull request no longer merges ${BRANCH} into main.`],
    ['another account', h => { h.setConnection({ login: 'someone-else', repository: 'owner/app' }); }, 'The GitHub connection changed. Start the repair again.'],
  ];
  for (const [name, change, reason, holds] of cases) {
    await t.test(name, async t => {
      const h = await harness(t, { holds });
      change(h);
      const outcome = await h.run();
      assert.deepEqual([outcome.status, outcome.reason, h.calls.merges], ['ready', reason, []]);
      assert.equal(h.calls.gates.length, 1, 'The gates still ran, for the person who merges.');
    });
  }
});

test('the pull request is read again right before the merge, so one retargeted or pushed to while its checks run never merges', async t => {
  for (const [name, change, reason] of [
    ['retargeted', (pull: PullRequestState) => { pull.base.ref = 'release'; }, `The pull request no longer merges ${BRANCH} into main.`],
    ['pushed to', (pull: PullRequestState) => { pull.head.sha = U; }, HEAD_CHANGED],
    ['closed', (pull: PullRequestState) => { pull.state = 'closed'; }, 'The pull request was closed.'],
  ] as const) {
    await t.test(name, async t => {
      let h: Awaited<ReturnType<typeof harness>> | undefined;
      h = await harness(t, { checks: (_sha, read) => { if (read === 1) change(h!.pull); return { runs: [read === 1 ? { name: 'CI', status: 'queued', conclusion: null } : passed()], statuses: [status('perpetual/Beta')], complete: true }; } });
      const outcome = await h.run();
      assert.deepEqual([outcome.status, outcome.reason, h.calls.merges, h.calls.updates], ['ready', reason, [], []]);
    });
  }
});

test('auto-merge turned off while the connection is read before a write prevents that write', async t => {
  for (const behind of [[], [1]]) {
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    h = await harness(t, { behind, connectionRead: () => { if (h?.calls.compares.length) h.setAutoMerge(false); } });
    assert.deepEqual(await h.run(), { status: 'ready', reason: AUTO_MERGE_OFF });
    assert.deepEqual([h.calls.merges, h.calls.updates], [[], []], behind.length ? 'No branch update.' : 'No merge.');
  }
});

test('every check on the head must succeed: a failed or cancelled run, a failed or missing gate status and checks that stay pending never merge', async t => {
  const cases: [string, (sha: string, read: number) => CommitChecks, string][] = [
    ['failed run', () => ({ runs: [passed('lint'), { name: 'CI', status: 'completed', conclusion: 'failure' }], statuses: [status('perpetual/Beta')], complete: true }), 'The check CI did not succeed.'],
    ['cancelled run', () => ({ runs: [{ name: 'CI', status: 'completed', conclusion: 'cancelled' }], statuses: [status('perpetual/Beta')], complete: true }), 'The check CI did not succeed.'],
    ['failed gate status', () => ({ runs: [passed()], statuses: [status('perpetual/Beta', 'failure')], complete: true }), 'The check perpetual/Beta did not succeed.'],
    ['missing gate status', () => ({ runs: [passed()], statuses: [], complete: true }), 'GitHub has no perpetual/Beta status for the pull request\'s head.'],
    ['pending past the bound', () => ({ runs: [{ name: 'Vercel', status: 'in_progress', conclusion: null }], statuses: [status('perpetual/Beta')], complete: true }), 'The check Vercel did not finish in 0 minutes.'],
    ['too many checks', () => ({ runs: [passed()], statuses: [status('perpetual/Beta')], complete: false }), 'The pull request has more checks than Perpetual reads.'],
  ];
  for (const [name, checks, reason] of cases) {
    await t.test(name, async t => {
      const h = await harness(t, { checks });
      const outcome = await h.run();
      assert.deepEqual([outcome.status, outcome.reason, h.calls.merges], ['ready', reason, []]);
    });
  }
  const waited = await harness(t, { checks: (_sha, read) => ({ runs: [read < 3 ? { name: 'CI', status: 'queued', conclusion: null } : passed()], statuses: [status('perpetual/Beta', read < 2 ? 'pending' : 'success')], complete: true }) });
  assert.deepEqual(await waited.run(), { status: 'merged', merged: M }, 'Checks still running are read again until they pass.');
  assert.equal(waited.calls.checks.length, 3);
});

test('auto-merge off stops at ready after the gates ran, even when turned off while they run', async t => {
  const off = await harness(t);
  off.setAutoMerge(false);
  assert.deepEqual(await off.run(), { status: 'ready', reason: AUTO_MERGE_OFF });
  assert.deepEqual([off.calls.gates.length, off.calls.merges], [1, []]);
  let turnOff = () => {};
  const during = await harness(t, { gates: async request => { turnOff(); return [gate('Beta', request.sha as string)]; } });
  turnOff = () => during.setAutoMerge(false);
  assert.deepEqual(await during.run(), { status: 'ready', reason: AUTO_MERGE_OFF });
  assert.deepEqual(during.calls.merges, []);
});

test('a target branch that moved is merged into the repair branch at the verified head, and the new head passes CI and the gates before it merges', async t => {
  const h = await harness(t, { behind: [2, 0] });
  assert.deepEqual(await h.run(), { status: 'merged', merged: M });
  assert.deepEqual(h.calls.updates, [{ number: 7, sha: P }], 'The update names the verified head.');
  assert.deepEqual(h.calls.ci, [U], 'The updated head goes through CI.');
  assert.deepEqual(h.calls.gates.map(item => item.sha), [P, U], 'And through the gates again.');
  assert.deepEqual(h.calls.compares, [{ base: T, head: P }, { base: T, head: U }]);
  assert.deepEqual(h.calls.merges.map(item => item.sha), [U]);
  assert.ok(h.reports.some(report => report.pushed === U), 'A later Repair of the commit leases the branch as GitHub left it.');
  assert.deepEqual(h.reports.find(report => report.gates?.length === 2)?.gates?.map(item => item.sha), [P, U]);
});

test('only GitHub\'s merge of the target branch into the verified head is taken after an update; any other head is not recorded, verified or merged', async t => {
  for (const [name, parents] of [['a commit pushed on the head', [P]], ['a merge of another commit', [P, 'a'.repeat(40)]], ['a merge onto another head', ['a'.repeat(40), T]]] as const) {
    await t.test(name, async t => {
      const h = await harness(t, { behind: [1], parents: () => [...parents] });
      assert.deepEqual(await h.run(), { status: 'ready', reason: HEAD_CHANGED });
      assert.deepEqual([h.calls.updates.length, h.calls.ci, h.calls.gates.map(item => item.sha), h.calls.merges], [1, [], [P], []]);
      assert.equal(h.reports.some(report => report.pushed), false, 'A later Repair of the commit never leases a head Perpetual did not make.');
    });
  }
});

test('an update is bounded, and one GitHub refuses or whose CI fails leaves the fix ready', async t => {
  const moving = await harness(t, { behind: [1, 1, 1] });
  const outcome = await moving.run();
  assert.deepEqual([outcome.status, outcome.reason], ['ready', 'The target branch kept moving.']);
  assert.deepEqual([moving.calls.updates.length, moving.calls.merges], [2, []]);
  const conflicted = await harness(t, { behind: [1], update: () => Object.assign(new Error('GitHub could not update the pull request branch. Resolve its conflicts on GitHub.'), { refused: true }) });
  assert.deepEqual(await conflicted.run(), { status: 'ready', reason: 'GitHub could not update the pull request branch. Resolve its conflicts on GitHub.' });
  const failing = await harness(t, { behind: [1], ci: () => ({ status: 'failed', reason: 'The updated pull request failed CI: CI.' }) });
  assert.deepEqual(await failing.run(), { status: 'ready', reason: 'The updated pull request failed CI: CI.' });
  assert.deepEqual([failing.calls.gates.length, failing.calls.merges], [1, []]);
});

test('GitHub refusing the merge leaves the fix ready with a fixed message, and a person\'s merge meanwhile is recorded as merged', async t => {
  for (const message of ['The pull request changed after verification.', 'GitHub refused the merge. Check the pull request\'s required reviews and checks.']) {
    const h = await harness(t, { merge: () => Object.assign(new Error(message), { refused: true }) as HttpError });
    assert.deepEqual(await h.run(), { status: 'ready', reason: message });
  }
  const person = await harness(t);
  Object.assign(person.pull, { state: 'closed', merged: true, mergeCommit: U });
  assert.deepEqual(await person.run(), { status: 'merged', merged: U });
  assert.deepEqual(person.calls.merges, []);
});

test('a gate budget that runs out while a gate is at work never merges without the remaining Sandbox gates', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-merge-gates-'));
  const stages: GateStage[] = [{ id: 'beta', name: 'Beta', kind: 'sandbox' }, { id: 'gamma', name: 'Gamma', kind: 'sandbox' }];
  const log: string[] = [];
  let budget: AbortSignal | undefined;
  // Beta's run ends only once the budget ran out, so it passes after that.
  const manager = await createGateManager({ dataDir, retryInterval: 5,
    source: () => ({ key: KEY, branch: 'main', sha: B, repository: 'owner/app', stages }),
    github: { connection: async () => ({ login: 'developer', repository: 'owner/app' }), head: async () => ({ status: 304 }), post: async () => {} },
    steps: {
      async prepare(gate) { log.push(`prepare ${gate.stageId}`); return gate.stageId; },
      journeys: () => 1,
      async rebuild() { return null; },
      async run(stageId) { log.push(`run ${stageId}`); await new Promise(done => budget?.aborted ? done(null) : budget?.addEventListener('abort', done, { once: true })); return { status: 'passed' }; },
    },
  });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  // The budget outlasts admitting Beta's gate on a busy machine; Beta's run then waits for it to run out.
  const h = await harness(t, { timing: { gatesMs: 2000 }, stages: manager.repairStages(KEY), gates: async (request, signal) => { budget = signal; return (await manager.runRepair(request, signal)).gates; } });
  assert.deepEqual(await h.run(), { status: 'ready', reason: 'The journey gates did not finish in 0 hours.' });
  assert.deepEqual([log, h.calls.checks, h.calls.merges], [['prepare beta', 'run beta'], [], []], 'Gamma never runs, and nothing is read or merged.');
  assert.deepEqual(h.reports.find(report => report.gates)?.gates?.map(item => [item.stageId, item.status]), [['beta', 'passed'], ['gamma', 'superseded']]);
});

test('the journey gates have one budget for every head an update makes them verify', async t => {
  // The first head's gates run until the budget runs out and pass; the updated head's then start with none left.
  const h = await harness(t, { behind: [1], timing: { gatesMs: 200 }, gates: async (request, signal) => {
    if (request.sha === P) await new Promise(done => signal?.aborted ? done(null) : signal?.addEventListener('abort', done, { once: true }));
    return [gate('Beta', request.sha as string, request.sha === P || !signal?.aborted ? 'passed' : 'superseded')];
  } });
  assert.deepEqual(await h.run(), { status: 'ready', reason: 'The journey gates did not finish in 0 hours.' });
  assert.deepEqual([h.calls.gates.map(item => item.sha), h.calls.merges], [[P, U], []]);
});

test('a repair that stops while its gates run rejects, and its checkout is removed', async t => {
  const controller = new AbortController();
  const h = await harness(t, { gates: async (request, signal) => { controller.abort(new Error('stopped')); assert.equal(signal?.aborted, true); return [gate('Beta', request.sha as string, 'superseded', { reason: 'The repair stopped.' })]; } });
  await assert.rejects(h.run(controller.signal), /stopped/);
  assert.deepEqual([await readdir(h.directory), h.calls.merges], [[], []]);
});

test('a pull request the agent step could not mark ready still goes through its gates, is marked ready once they were judged, and merges', async t => {
  const h = await harness(t, { draft: true });
  assert.deepEqual(await h.run(), { status: 'merged', merged: M });
  assert.deepEqual([h.calls.gates.length, h.calls.readied], [1, [7]]);
  assert.deepEqual(h.reports.slice(0, 3), [{ status: 'verifying-gates' }, { gates: [{ gateId: 'gate-Beta-f', stageId: 'beta', sha: P, status: 'passed' }], verified: P }, { pullRequest: { ...PULL, draft: false } }]);
  const refused = await harness(t, { draft: true, ready: () => new Error('GitHub denied the pull request. Check write access to this repository.') });
  assert.deepEqual(await refused.run(), { status: 'ready', reason: UNREADY });
  assert.deepEqual([refused.calls.gates.length, refused.calls.readied, refused.calls.checks, refused.calls.merges], [1, [7], [], []], 'Its gates ran and reported on the head, and a draft never merges.');
  const failing = await harness(t, { draft: true, gates: async request => [gate('Beta', request.sha as string, 'failed', { reason: 'A journey failed.' })] });
  assert.deepEqual(await failing.run(), { status: 'ready', reason: 'Beta failed: A journey failed.' });
  assert.deepEqual(failing.calls.readied, [7], 'CI passed, so it is ready for review whatever its gates found.');
  const readied = await harness(t);
  await readied.run();
  assert.deepEqual(readied.calls.readied, [], 'One the agent step readied is not marked again.');
});

test('the target branch is read last before the merge, and a merge GitHub made onto a target head that moved meanwhile says so', async t => {
  const h = await harness(t);
  await h.run();
  assert.deepEqual(h.calls.order.slice(-4), ['pull', 'head', 'compare', 'merge'], 'Only the target read and the comparison lie between the pull request\'s last read and the merge.');
  const moved = await harness(t, { parents: sha => sha === M ? ['a'.repeat(40)] : [] });
  assert.deepEqual(await moved.run(), { status: 'merged', merged: M, reason: 'main moved to aaaaaaa during the merge.' });
  assert.deepEqual(moved.reports.at(-1), { merged: M }, 'The merge is recorded first.');
  const onto = await harness(t, { parents: sha => sha === M ? [T] : [] });
  assert.deepEqual(await onto.run(), { status: 'merged', merged: M }, 'A merge onto the compared target head needs no reason.');
});

test('a head\'s checks pass once every run completed as success, neutral or skipped and every status and required gate succeeded', () => {
  const run = (state: string, conclusion: string | null = null): CheckRun => ({ name: `${state}:${conclusion}`, status: state, conclusion });
  assert.deepEqual(checksVerdict({ runs: [run('completed', 'success'), run('completed', 'neutral'), run('completed', 'skipped')], statuses: [status('perpetual/Beta')] }, ['perpetual/Beta']), { status: 'passed' });
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', null]) {
    assert.equal(checksVerdict({ runs: [run('completed', conclusion)], statuses: [] }).status, 'failed', String(conclusion));
  }
  for (const state of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) assert.equal(checksVerdict({ runs: [run(state)], statuses: [] }).status, 'pending', state);
  assert.equal(checksVerdict({ runs: [run('mystery')], statuses: [] }).status, 'failed');
  assert.deepEqual(checksVerdict({ runs: [], statuses: [status('vercel', 'pending')] }), { status: 'pending', check: 'vercel' });
  for (const state of ['failure', 'error']) assert.deepEqual(checksVerdict({ runs: [], statuses: [status('vercel', state)] }), { status: 'failed', check: 'vercel' });
  assert.deepEqual(checksVerdict({ runs: [run('queued')], statuses: [status('vercel', 'error')] }).status, 'failed', 'A failure outranks a pending check.');
  assert.deepEqual(checksVerdict({ runs: [], statuses: [] }, ['perpetual/Beta']), { status: 'pending', check: 'perpetual/Beta', missing: true });
});
