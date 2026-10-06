// A repair's merge step (docs/repair.md, ADR 0002). Once its pull request passed CI and is ready for review, each Sandbox
// stage's journey gate runs at the pull request head, in pipeline order, through the gate manager's one-at-a-time queue
// over a checkout Perpetual owns; the managed source copy, the scan and the watched head never move. The pull request is
// squash-merged, naming the verified head so GitHub refuses one that moved, only when every gate passed at that head, no
// change rule held it, auto-merge is on, its head is still the verified one, every check on that head succeeded and the
// target branch has not moved since its base. A target branch that moved is merged into the repair branch through
// GitHub, and GitHub's merge commit goes through CI and the gates again, a bounded number of times. Anything else leaves
// the repair ready for a person, with the reason. A pull request the agent step could not mark ready for review still
// goes through the gates, and is marked ready once they were judged.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchHead, BranchHeadInput } from '../gate/github.ts';
import type { RepairGateRequest, RepairGateView } from '../gate/manager.ts';
import { SHA, short } from '../gate/rules.ts';
import { untilReachable } from '../github-cli.ts';
import { failureText } from '../redaction.ts';
import type { RepairHost } from './clone.ts';
import type { CommitChecks, RepairPullRequests } from './github.ts';
import type { Repair, RepairGate, RepairOutcome, RepairProgress, RepairPullRequest } from './manager.ts';

/**
 * Updates of the pull request branch per repair, how long its head's checks may stay pending, how often they, the
 * updated head and an unreachable GitHub are read, how long GitHub may take to update the branch, the longest wait for
 * the journey gates, and how long GitHub may stay unreachable, at each read and in all right before a write.
 */
export const MERGE = { updates: 2, checksMs: 10 * 60_000, pollMs: 15_000, headMs: 2 * 60_000, gatesMs: 6 * 60 * 60_000, outageMs: 15 * 60_000 };
export const AUTO_MERGE_OFF = 'Auto-merge is off.';
export const HEAD_CHANGED = 'The pull request changed after verification.';
export const UNREADY = 'Mark the pull request ready for review on GitHub.';
/** What the merge step reads and writes on GitHub, as the connected account, which throws as unreachable while GitHub cannot verify it. */
export type MergeGitHub = Pick<RepairPullRequests, 'pull' | 'checks' | 'compare' | 'updateBranch' | 'parents' | 'merge' | 'ready'> & {
  connection(): Promise<{ login: string; repository: string } | null>;
  head(input: BranchHeadInput): Promise<BranchHead>;
};
/** The gate manager's repair gates, and the Sandbox stages they run for a pipeline (null when it is not the active one). */
export interface RepairGates { runRepair(request: RepairGateRequest, signal?: AbortSignal): Promise<{ gates: RepairGateView[] }>; repairStages?(key: string): readonly string[] | null }
export type CiVerdict = { status: 'passed' } | { status: 'failed'; reason: string };
/**
 * The merge step's input, from the agent step: the repair, its pull request (a draft when the agent step could not mark
 * it ready for review), the verified head, the change rules' holds, the repair's own directory and its host copy (which
 * holds the pushed head), the pull request's title, whether auto-merge is on (read live), its report, and ci(sha), the
 * pull request's CI at a head this step made by updating it.
 */
export interface MergeInput {
  repair: Repair; pullRequest: RepairPullRequest; sha: string; holds: readonly string[]; directory: string; clone: string; title: string;
  autoMerge(): boolean;
  report(progress: RepairProgress): Promise<void>;
  ci(sha: string, signal: AbortSignal): Promise<CiVerdict>;
}
export type ChecksVerdict = { status: 'passed' } | { status: 'pending' | 'failed'; check: string; missing?: true };

const PASSED_RUNS = new Set(['success', 'neutral', 'skipped']);
const PENDING_RUNS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const DISCONNECTED = 'Connect GitHub to repair builds.', CHANGED = 'The GitHub connection changed. Start the repair again.';
const text = (error: unknown) => failureText(error, 500);
const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * A head's checks as GitHub reports them. A check run passes once completed as success, neutral or skipped, and is
 * pending while queued, in progress, waiting or requested; a commit status passes only as success and is pending while
 * pending. Anything else fails, and a required context without a status, such as a journey gate's, is pending.
 */
export function checksVerdict({ runs, statuses }: Pick<CommitChecks, 'runs' | 'statuses'>, required: readonly string[] = []): ChecksVerdict {
  const failedRun = runs.find(run => run.status === 'completed' ? !PASSED_RUNS.has(run.conclusion ?? '') : !PENDING_RUNS.has(run.status));
  const failedStatus = statuses.find(status => status.state !== 'success' && status.state !== 'pending');
  if (failedRun || failedStatus) return { status: 'failed', check: failedRun?.name || failedStatus!.context };
  const pendingRun = runs.find(run => run.status !== 'completed'), pendingStatus = statuses.find(status => status.state === 'pending');
  if (pendingRun || pendingStatus) return { status: 'pending', check: pendingRun?.name || pendingStatus!.context };
  const missing = required.find(context => !statuses.some(status => status.context === context));
  return missing ? { status: 'pending', check: missing, missing: true } : { status: 'passed' };
}

/** The merge step for the agent. */
export function createRepairMerge({ github, gates, host, timing, clock = Date.now }: { github: MergeGitHub; gates: RepairGates; host: Pick<RepairHost, 'checkout'>; timing?: Partial<typeof MERGE>; clock?: () => number }) {
  const bounds = { ...MERGE, ...timing };
  // GitHub is read and written only as the account that opened the repair, for its repository. GitHub unreachable is
  // waited out, for up to waitMs (outageMs unless less is left); true when it was, so a write never follows reads made
  // before the wait.
  async function connected(repair: Repair, signal: AbortSignal, waitMs = bounds.outageMs) {
    let reads = 0;
    const connection = await untilReachable(() => { reads += 1; return github.connection(); }, { signal, pollMs: bounds.pollMs, waitMs, clock });
    signal.throwIfAborted();
    if (!connection) throw new Error(DISCONNECTED);
    if (connection.login !== repair.login || connection.repository !== repair.repository) throw new Error(CHANGED);
    return reads > 1;
  }

  async function merge(input: MergeInput, signal: AbortSignal): Promise<RepairOutcome> {
    const { repair, pullRequest, holds } = input, { repository } = repair, number = pullRequest.number;
    const ready = (reason: string): RepairOutcome => ({ status: 'ready', reason });
    let sha = input.sha.toLowerCase(), updates = 0, recorded: RepairGate[] = [], draft = pullRequest.draft === true;
    // The journey gates have gatesMs in all, however many heads an update makes them verify.
    const budget = AbortSignal.timeout(bounds.gatesMs);
    // Each Sandbox gate at the head, over a checkout of it that is removed once the gates no longer read it. A pipeline
    // without a Sandbox stage needs no checkout, and one that is no longer active runs no gate.
    async function gatesAt(head: string) {
      const stages = gates.repairStages?.(repair.key);
      if (stages === null) throw new Error('The active source changed.');
      if (stages?.length === 0) return [];
      const directory = join(input.directory, `gate-${short(head)}`);
      try {
        const snapshot = await host.checkout({ directory, clone: input.clone, repository, branch: pullRequest.branch, sha: head, rootDirectory: repair.rootDirectory });
        signal.throwIfAborted();
        return (await gates.runRepair({ key: repair.key, repair: repair.id, branch: pullRequest.branch, sha: head, snapshot }, AbortSignal.any([signal, budget]))).gates;
      } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
    }
    // The head's checks, read until none is pending or checksMs passed.
    async function checksAt(head: string, required: readonly string[]) {
      const started = clock();
      for (;;) {
        await connected(repair, signal);
        const checks = await github.checks({ repository, sha: head });
        signal.throwIfAborted();
        if (!checks.complete) return 'The pull request has more checks than Perpetual reads.';
        const verdict = checksVerdict(checks, required);
        if (verdict.status === 'passed') return null;
        if (verdict.status === 'failed') return `The check ${verdict.check} did not succeed.`;
        if (clock() - started >= bounds.checksMs) return verdict.missing ? `GitHub has no ${verdict.check} status for the pull request's head.` : `The check ${verdict.check} did not finish in ${minutes(bounds.checksMs)}.`;
        await pause(bounds.pollMs, signal);
      }
    }
    // The pull request's head once GitHub updated its branch, read as the connected account, or null within headMs.
    async function updatedHead(previous: string) {
      const started = clock();
      for (;;) {
        await pause(bounds.pollMs, signal);
        await connected(repair, signal);
        const pull = await github.pull({ repository, number });
        signal.throwIfAborted();
        if (pull.head.sha !== previous) return pull.head.sha;
        if (clock() - started >= bounds.headMs) return null;
      }
    }
    // A merge is recorded at once, even when the repair stopped meanwhile.
    async function merged(commit: string): Promise<RepairOutcome> {
      await input.report({ merged: commit }).catch(() => {});
      return { status: 'merged', merged: commit };
    }
    // A pull request CI passed but the agent step could not mark ready for review is marked ready once its gates were
    // judged, whatever they found, as the account that opened it; the reason when GitHub still refuses, else null. One a
    // person turns back into a draft afterwards stays one.
    async function readied() {
      if (!draft) return null;
      await connected(repair, signal);
      try { await github.ready({ repository, number }); }
      catch { signal.throwIfAborted(); return UNREADY; }
      draft = false;
      await input.report({ pullRequest: { ...pullRequest, draft: false } });
      return null;
    }
    // Why the pull request, as GitHub has it now, is no longer the verified head of the repair branch waiting to merge
    // into the target branch, or null; a person may merge, close, retarget or push to it at any time.
    async function moved(): Promise<RepairOutcome | null> {
      const pull = await github.pull({ repository, number });
      signal.throwIfAborted();
      if (pull.merged) return pull.mergeCommit ? await merged(pull.mergeCommit) : ready('The pull request was merged on GitHub.');
      if (pull.state === 'closed') return ready('The pull request was closed.');
      if (pull.head.sha !== sha) return ready(HEAD_CHANGED);
      if (pull.draft) return ready('The pull request is a draft.');
      if (pull.head.ref !== pullRequest.branch || pull.head.repository?.toLowerCase() !== repository.toLowerCase() || pull.base.ref !== repair.branch) return ready(`The pull request no longer merges ${pullRequest.branch} into ${repair.branch}.`);
      return null;
    }
    try {
      for (;;) {
        await input.report({ status: 'verifying-gates' });
        const judged = await gatesAt(sha);
        signal.throwIfAborted();
        recorded = [...recorded, ...judged.map(({ id, stageId, sha: head, status }) => ({ gateId: id, stageId, sha: head, status }))].slice(-24);
        // Only a pass merges: a gate that needs release, a released one and a stage without reviewed journeys wait for a person.
        const open = judged.find(gate => gate.status !== 'passed');
        // CI and every gate passed at the head, which verifies it; whatever stops the merge from here is the merge's.
        await input.report({ gates: recorded, ...(open ? {} : { verified: sha }) });
        const unready = await readied();
        if (open) {
          const stage = open.context.replace(/^perpetual\//, '');
          if (open.status === 'superseded') return ready(`The journey gates did not finish in ${Math.round(bounds.gatesMs / 3_600_000)} hours.`);
          return ready(open.status === 'failed' ? `${stage} failed: ${open.reason || 'A journey failed.'}` : open.status === 'released' ? `${stage} was released by ${open.releasedBy}.` : `${stage} needs release: ${open.reason || 'Journeys did not all pass.'}`);
        }
        if (unready) return ready(unready);
        if (holds.length) return ready(`Held for a person: ${holds.join(' ')}`);
        if (!input.autoMerge()) return ready(AUTO_MERGE_OFF);
        await connected(repair, signal);
        const before = await moved();
        if (before) return before;
        // Every check on the head, then the pull request again after the checks' wait and the target branch, just before
        // GitHub is written: GitHub's sha guard protects only the head. The account is read last, right before the write;
        // a wait there for GitHub to answer reads all of them again, the checks included, and such waits have outageMs in
        // all, so the write never rests on a read made before a wait.
        const required = judged.map(gate => gate.context);
        let target: Extract<BranchHead, { status: 200 }>, behindBy: number, waited = 0;
        for (;;) {
          const failing = await checksAt(sha, required);
          if (failing) return ready(failing);
          const after = await moved();
          if (after) return after;
          // The target branch is read last, so it can move only in the moment between this read and the write, which no
          // GitHub API guards; a merge onto a target head that moved then is named in its reason.
          const head = await github.head({ repository, branch: repair.branch, etag: null });
          if (head.status !== 200) throw new Error(`Could not read ${repair.branch} from GitHub.`);
          target = head;
          ({ behindBy } = await github.compare({ repository, base: target.sha, head: sha }));
          signal.throwIfAborted();
          const started = clock();
          if (!(await connected(repair, signal, bounds.outageMs - waited))) break;
          waited += clock() - started;
        }
        if (behindBy > 0) {
          // The target branch moved since the pull request's base: GitHub merges it into the repair branch while its
          // head is still the verified one, and the new head is verified again.
          if (updates >= bounds.updates) return ready('The target branch kept moving.');
          updates += 1;
          // The switch is read last, with nothing awaited between it and the write.
          if (!input.autoMerge()) return ready(AUTO_MERGE_OFF);
          await github.updateBranch({ repository, number, sha });
          const head = await updatedHead(sha);
          if (!head || !SHA.test(head)) return ready(`GitHub did not update the pull request branch in ${minutes(bounds.headMs)}.`);
          // Only GitHub's merge of the compared target head into the verified head is taken; anyone else's commit is
          // never recorded as Perpetual's, verified in place of a person or merged.
          const parents = await github.parents({ repository, sha: head });
          signal.throwIfAborted();
          if (parents.length !== 2 || parents[0] !== sha || parents[1] !== target.sha.toLowerCase()) return ready(HEAD_CHANGED);
          // A later Repair of the same commit leases the branch as GitHub left it.
          await input.report({ pushed: head });
          const ci = await input.ci(head, signal);
          if (ci.status !== 'passed') return ready(ci.reason);
          sha = head;
          continue;
        }
        // The switch is read last, with nothing awaited between it and the write.
        if (!input.autoMerge()) return ready(AUTO_MERGE_OFF);
        const result = await github.merge({ repository, number, sha, title: `${input.title} (#${number})` });
        const outcome = await merged(result.sha);
        // The squash commit's parent is the target head GitHub merged onto; its push gate judges the commit either way.
        const [base] = await github.parents({ repository, sha: result.sha }).catch(() => [] as string[]);
        return base && base !== target.sha.toLowerCase() ? { ...outcome, reason: `${repair.branch} moved to ${short(base)} during the merge.` } : outcome;
      }
    } catch (error) {
      // A stopped repair keeps the status that ended it. The fix itself passed CI, so anything else leaves it ready.
      signal.throwIfAborted();
      return ready(text(error));
    }
  }

  return { merge };
}
export type RepairMerge = ReturnType<typeof createRepairMerge>;
