import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { failureText, redact } from '../redaction.ts';
import { OUTAGE, untilReachable } from '../github-cli.ts';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { SHA, short } from '../gate/rules.ts';
import type { BranchHead, BranchHeadInput } from '../gate/github.ts';
import { latestBranchBuildRuns, type WorkflowRun } from '../github-runs.ts';
import type { FailedJob, GitHubFailure, PullRequestRead } from './github.ts';
import { branchRuns, completedRuns, failedRun, passedRun, triage } from './triage.ts';
import type { BuildRecovery } from '../../contract/build-recovery.ts';
import { recoveryFor, validRecovery } from './recovery.ts';
import type { CredentialInput, CredentialSnapshot } from './credentials.ts';

// New observed heads wait in FIFO order without interrupting active work. Finished fixes can still be retired
// when a newer head passes. Restarted queues require an explicit Resume before starting paid work.
export type RepairStatus = 'queued' | 'passed' | 'triaging' | 'rerunning' | 'repairing' | 'verifying-ci' | 'verifying-gates' | 'ready' | 'merged' | 'flaky' | 'needs-person' | 'failed' | 'superseded' | 'cancelled';
/** A failed workflow run of the repaired commit, at the attempt the repair saw. */
export interface RepairRun { id: string; name: string | null; path: string | null; attempt: number; url: string | null }
/**
 * The repair's pull request, once the agent step opened one: closing while Perpetual closes it as superseded, closed once
 * a person or Perpetual closed it on GitHub. Repairs of one commit share it.
 */
export interface RepairPullRequest { number: number; url: string; branch: string; draft?: boolean; closing?: true; closed?: true }
/**
 * One agent attempt as the agent step records it: its model, whether it ran the failing step's command and saw it fail
 * before changing code, its failure and OpenRouter's reported usage.
 */
export interface RepairAttempt { number: number; model: string; startedAt: string; completedAt?: string; failure?: string; reproduced?: boolean; inputTokens?: number; outputTokens?: number; cost?: number }
/** A journey gate a repair ran at its pull request head, as the merge step records it. */
export interface RepairGate { gateId: string; stageId: string; sha: string; status: string }
/** One repair of one failed head (source key, branch, sha), persisted under <dataDir>/repairs/state.json. */
export interface Repair {
  id: string; key: string; repository: string; branch: string; sha: string;
  /** The connected account that saw the failure; checkoutPath and rootDirectory name the managed source copy. */
  login: string; checkoutPath: string; rootDirectory: string;
  trigger: 'push' | 'person'; status: RepairStatus; reason?: string;
  /** A queue restored after restart waits for a person's Resume. */
  paused?: true;
  runs: RepairRun[]; failures?: GitHubFailure[]; category?: string; reruns?: { id: string; attempt: number }[];
  recovery?: BuildRecovery;
  pullRequest?: RepairPullRequest; attempts?: RepairAttempt[]; diffHash?: string; ciRuns?: string[]; closeError?: string;
  /** The last commit Perpetual pushed to this commit's repair branch; a person's next Repair of the commit leases it. */
  pushed?: string;
  /** The pull request head that passed CI and every journey gate, as the agent and merge steps record it. */
  verified?: string;
  /** Why a person must merge the pull request: change rules that hold it, such as a change to tests. */
  holds?: string[];
  /** The journey gates at the pull request head, and the merge commit once the pull request merged. */
  gates?: RepairGate[]; merged?: string;
  /** Resource ownership survives every business outcome until cleanup confirms absence. */
  cleanup?: { status: 'pending' | 'failed'; reason?: string };
  /** startedAt: when triage handed the failure to the agent step, whether or not the agent could start. */
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
}
/** The active pipeline; repository, checkoutPath and rootDirectory are set only for a managed GitHub source, the only one repaired. */
export interface RepairSource { key: string; branch: string | null; repository?: string | null; checkoutPath?: string | null; rootDirectory?: string | null }
export interface RepairGitHub {
  /** The connected, verified account, or null; it throws as unreachable while GitHub cannot verify it. */
  connection(): Promise<{ login: string; repository: string } | null>;
  head(input: BranchHeadInput): Promise<BranchHead>;
  runs(input: { repository: string; sha: string; login: string }): Promise<{ runs: WorkflowRun[] }>;
  failure(input: { repository: string; runId: string }): Promise<GitHubFailure>;
  rerun(input: { repository: string; runId: string }): Promise<void>;
  credentials?(input: CredentialInput): Promise<CredentialSnapshot>;
  workflow?(input: { repository: string; sha: string; path: string }): Promise<string>;
}
/** What the agent step may record while it works; each report is persisted before it resolves. */
export interface RepairProgress { status?: 'repairing' | 'verifying-ci' | 'verifying-gates'; pullRequest?: RepairPullRequest; pushed?: string; attempts?: RepairAttempt[]; diffHash?: string; ciRuns?: string[]; holds?: string[]; gates?: RepairGate[]; verified?: string; merged?: string }
/** merged names the merge commit of a merged outcome. */
export interface RepairOutcome { status: 'ready' | 'merged' | 'failed' | 'needs-person'; reason?: string; merged?: string }
/**
 * The agent step's input. repair is a copy as stored when the step starts: the failing sha, its failed runs with the
 * triage failures (jobs, failed steps, redacted log and diagnosis), the account and the managed source copy.
 * directory is <dataDir>/repairs/<id> (0700), owned until resource cleanup succeeds. report()
 * rejects once the repair stopped; a push or pull request it names is still recorded first, and the pull request stays
 * open, and so is a merge, and its attempts with what they cost. repair.pushed is what an earlier repair of the same
 * commit last pushed. autoMerge() reads the pipeline's auto-merge switch, the Build stage's Autopilot mode, when it is
 * called. spendable, for a repair Autopilot started by itself, is the dollars left of its pipeline's daily cost cap,
 * which bounds it below its own cap.
 */
export interface RepairContext { repair: Repair; directory: string; report(progress: RepairProgress): Promise<void>; autoMerge(): boolean; spendable?: number }
export interface RepairSteps {
  /** Why the agent cannot start, such as a missing OpenRouter API key; empty when it can. */
  unavailable?(): string | null | undefined | Promise<string | null | undefined>;
  /** The agent step: fix the failure through a pull request. signal aborts on Stop, a change of source or shutdown. */
  repair?(context: RepairContext, signal: AbortSignal): Promise<RepairOutcome>;
  /**
   * Closes a superseded repair's pull request. One a person had merged is left as it is, and the read that found it merged
   * is returned, naming its merge commit. A rejection with refused: true is GitHub refusing the close, which is not tried
   * again; any other is tried at the next check.
   */
  close?(repair: Repair): Promise<PullRequestRead | void>;
  /**
   * One read of a finished repair's pull request as GitHub has it: merged or closed when a person did so, else open; a
   * merged one names its merge commit, which the loop guard knows the merge by.
   */
  state?(repair: Repair): Promise<PullRequestRead>;
  /** Confirms this repair's resources are gone before releasing its host workspace. Never resumes repair work. */
  cleanup?(input: { repair: Repair; directory: string }): Promise<void>;
  /** Confirms old controller resources are gone, before any new repair starts. */
  recover?(): Promise<void>;
}
/** outage: how often a repair asks GitHub again while it is unreachable, and how long it waits before needing a person. */
export interface RepairManagerOptions { dataDir: string; source: () => RepairSource | null; github: RepairGitHub; steps?: RepairSteps; now?: () => string; pollInterval?: number; outage?: Partial<typeof OUTAGE> }
/** A workflow run as Build shows it. */
export type PublicRun = Pick<RepairRun, 'id' | 'name' | 'path' | 'url'>;
/**
 * A repair as the pipeline's Autopilot shows it (src/repair/view.ts): its record without the logs, redacted. verified:
 * the pull request's head, as Perpetual last pushed it, passed CI and every journey gate.
 */
export type PublicRepair = Pick<Repair, 'id' | 'branch' | 'sha' | 'status' | 'reason' | 'trigger' | 'category' | 'merged' | 'holds' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'cleanup' | 'paused' | 'recovery'>
  & { runs: PublicRun[]; pullRequest?: Pick<RepairPullRequest, 'number' | 'url' | 'draft' | 'closed'>; attempts?: Pick<RepairAttempt, 'number' | 'model' | 'reproduced' | 'failure' | 'cost'>[]; gates?: Pick<RepairGate, 'stageId' | 'sha' | 'status'>[]; verified?: true };
/**
 * head is the watched head of a connected, managed source's target branch, with the branch's own failed workflow runs
 * there as the connected account last read them; a person's Repair names one of them. Without a head no Repair can start.
 * autoMerge is the pipeline's auto-merge switch, the Build stage's Autopilot mode, for a managed source only.
 */
export interface RepairView { repairs: PublicRepair[]; head?: { sha: string; branch: string; failed: PublicRun[] }; autoMerge?: boolean; watchError?: string }
type Managed = RepairSource & { repository: string; branch: string; checkoutPath: string; rootDirectory: string };
type Connection = { login: string; repository: string };
type Followed = { branch: string; login: string; sha: string; read: Set<string>; waits: number };
/**
 * autoMerge holds the auto-merge switch per pipeline key; a pipeline without an entry merges. passed holds, per pipeline
 * key, when a watched head last passed, which ends a run of failed repairs.
 */
interface RepairState { version: 1; repairs: Repair[]; autoMerge?: Record<string, boolean>; passed?: Record<string, string> }

export const ACTIVE: readonly RepairStatus[] = Object.freeze(['triaging', 'rerunning', 'repairing', 'verifying-ci', 'verifying-gates']);
const STATUSES: Record<RepairStatus, true> = { queued: true, passed: true, triaging: true, rerunning: true, repairing: true, 'verifying-ci': true, 'verifying-gates': true, ready: true, merged: true, flaky: true, 'needs-person': true, failed: true, superseded: true, cancelled: true };
const OUTCOMES = new Set(['ready', 'merged', 'failed', 'needs-person']);
const PROGRESS = new Set(['repairing', 'verifying-ci', 'verifying-gates']);
/**
 * A finished repair a person may start again: one with no fix waiting with its pull request. A merged one has its fix,
 * and a ready one waits with its pull request until a person closes it.
 */
export const retryable = (repair: { status: RepairStatus; pullRequest?: { closed?: true } }) => !ACTIVE.includes(repair.status) && repair.status !== 'queued' && repair.status !== 'merged'
  && (repair.status !== 'ready' || Boolean(repair.pullRequest?.closed));
// Finished repairs left for a person with their pull request: a failed or stopped repair keeps its draft, and a restart
// leaves an interrupted one's open. A newer passing head supersedes each of them.
const KEPT: readonly RepairStatus[] = ['ready', 'failed', 'needs-person', 'cancelled'];
const kept = (repair: Repair) => Boolean(repair.pullRequest) && KEPT.includes(repair.status);
// A repair whose agent step may have made a box: one at work or holding cleanup, or one that recorded an attempt, a
// push, a pull request or a merge. One that ended at triage, or whose agent step could not start, made none.
const mayOwn = (repair: Repair) => PROGRESS.has(repair.status) || Boolean(repair.cleanup || repair.attempts?.length || repair.pushed || repair.pullRequest || repair.merged);
const MERGED = 'Merged on GitHub.';
const NO_AGENT = 'Automatic repair is unavailable. Fix the failure in a pull request.';
const CLEANUP_HOLD = 'Repair cleanup must finish before another repair can start.';
const LIMIT = 100;
/**
 * Bytes of state a start reads back, which covers what earlier controllers wrote without a bound, and the bound each
 * save keeps; the first save at a start trims an older, larger file.
 */
const READ_LIMIT = 128 * 1024 * 1024, SAVE_LIMIT = 8 * 1024 * 1024;
/** Checks a failing head waits for the loop guard to judge it before it needs a person. */
const GUARD = 10;
/**
 * Repairs of one failure that failed in a row before Autopilot opens the next for a person, without the agent, and
 * the dollars a pipeline's repairs may cost in a day before Autopilot starts no more of them by itself.
 */
export const BREAKER = 3, DAILY_COST = 10;
const DAY = 24 * 60 * 60_000;
const RUN_ID = /^\d{1,20}$/;
const unresolvedRecovery = (repair: Repair) => repair.recovery?.requests.some(request => ['requested', 'accepted', 'uncertain'].includes(request.status));
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value === undefined || isText(value);
const nullableText = (value: unknown) => value === null || isText(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const amount = (value: unknown) => value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validRun = (value: unknown): value is RepairRun => isRecord(value) && isText(value.id) && RUN_ID.test(value.id) && nullableText(value.name) && nullableText(value.path) && count(value.attempt) && nullableText(value.url);
const validJob = (value: unknown): value is FailedJob => isRecord(value) && isText(value.id) && isText(value.name) && nullableText(value.conclusion) && Array.isArray(value.failedSteps) && value.failedSteps.every(isText);
const validFailure = (value: unknown): value is GitHubFailure => isRecord(value) && isText(value.runId) && Array.isArray(value.jobs) && value.jobs.every(validJob)
  && isText(value.log) && isText(value.tail) && isText(value.observedAt) && isRecord(value.diagnosis) && value.diagnosis.method === 'rule-based' && isText(value.diagnosis.category) && isText(value.diagnosis.summary);
const validPullRequest = (value: unknown): value is RepairPullRequest => isRecord(value) && count(value.number) && isText(value.url) && value.url.startsWith('https://github.com/') && value.url.length <= 500
  && isText(value.branch) && value.branch.length <= 255 && (value.draft === undefined || typeof value.draft === 'boolean') && (value.closing === undefined || value.closing === true) && (value.closed === undefined || value.closed === true);
const validAttempt = (value: unknown): value is RepairAttempt => isRecord(value) && count(value.number) && isText(value.model) && isText(value.startedAt)
  && optionalText(value.completedAt) && optionalText(value.failure) && (value.reproduced === undefined || typeof value.reproduced === 'boolean') && [value.inputTokens, value.outputTokens, value.cost].every(amount);
const validHolds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10 && value.every(item => isText(item) && item.length <= 300);
const validCiRuns = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => isText(item) && RUN_ID.test(item));
const validDiffHash = (value: unknown): value is string => isText(value) && /^[a-f\d]{16,128}$/i.test(value);
const validSha = (value: unknown): value is string => isText(value) && SHA.test(value);
const validGates = (value: unknown): value is RepairGate[] => Array.isArray(value) && value.length <= 24 && value.every(item => isRecord(item)
  && isText(item.gateId) && item.gateId.length <= 64 && isText(item.stageId) && item.stageId.length <= 200 && validSha(item.sha) && isText(item.status) && /^[a-z-]{1,20}$/.test(item.status));
const validAutoMerge = (value: unknown): value is Record<string, boolean> => isRecord(value) && Object.values(value).every(item => typeof item === 'boolean');
const validPassed = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(isText);
/** A stored repair with every field detection, triage and the view read. */
const validRepair = (value: unknown): value is Repair => isRecord(value)
  && (['id', 'key', 'repository', 'branch', 'sha', 'login', 'checkoutPath', 'rootDirectory', 'createdAt', 'updatedAt'] as const).every(field => isText(value[field]))
  && /^[\w-]{1,64}$/.test(value.id as string) && SHA.test(value.sha as string) && (value.trigger === 'push' || value.trigger === 'person') && isText(value.status) && Object.hasOwn(STATUSES, value.status)
  && Array.isArray(value.runs) && value.runs.every(validRun)
  && (value.paused === undefined || value.paused === true)
  && (value.recovery === undefined || validRecovery(value.recovery))
  && (['reason', 'category', 'closeError', 'startedAt', 'completedAt'] as const).every(field => optionalText(value[field]))
  && (value.failures === undefined || Array.isArray(value.failures) && value.failures.every(validFailure))
  && (value.reruns === undefined || Array.isArray(value.reruns) && value.reruns.every(item => isRecord(item) && isText(item.id) && count(item.attempt)))
  && (value.cleanup === undefined || isRecord(value.cleanup) && (value.cleanup.status === 'pending' || value.cleanup.status === 'failed') && optionalText(value.cleanup.reason))
  && (value.pullRequest === undefined || validPullRequest(value.pullRequest))
  && (value.attempts === undefined || Array.isArray(value.attempts) && value.attempts.every(validAttempt))
  && (value.diffHash === undefined || validDiffHash(value.diffHash)) && (value.ciRuns === undefined || validCiRuns(value.ciRuns)) && (value.holds === undefined || validHolds(value.holds))
  && (value.pushed === undefined || validSha(value.pushed)) && (value.verified === undefined || validSha(value.verified)) && (value.merged === undefined || validSha(value.merged)) && (value.gates === undefined || validGates(value.gates));
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const text = (error: unknown, limit = 500) => failureText(error, limit);
const runOf = ({ id, name, path, attempt, url }: WorkflowRun): RepairRun => ({ id, name, path, attempt, url });
const publicRun = ({ id, name, path, url }: RepairRun): PublicRun => ({ id, name, path, url });
/** A pull request read the steps return, checked as unknown: merged carries the merge commit when the read named one. */
function pullRead(value: unknown): { state: PullRequestRead['state']; merged?: string } | null {
  if (!isRecord(value) || value.state !== 'open' && value.state !== 'closed' && value.state !== 'merged') return null;
  return { state: value.state, ...(value.state === 'merged' && validSha(value.mergeCommit) ? { merged: value.mergeCommit.toLowerCase() } : {}) };
}
// Stored logs are scrubbed again, whatever the reader did.
const scrubbed = (failure: GitHubFailure): GitHubFailure => ({ ...failure, log: redact(failure.log), tail: redact(failure.tail), diagnosis: { ...failure.diagnosis } });
// What a finished repair keeps of a failure, since only the agent step reads the whole of it: its first jobs and their
// failed steps, its diagnosis, the start of its error lines and the end of its log.
const brief = (failure: GitHubFailure): GitHubFailure => ({ ...failure, jobs: failure.jobs.slice(0, 5).map(job => ({ ...job, failedSteps: job.failedSteps.slice(0, 5) })), log: failure.log.slice(0, 2000), tail: failure.tail.slice(-2000) });
const publicRepair = ({ id, branch, sha, status, reason, paused, cleanup, trigger, category, runs, pullRequest, attempts, holds, gates, pushed, verified, merged, createdAt, updatedAt, startedAt, completedAt, recovery }: Repair): PublicRepair => ({
  id, branch, sha, status, ...(paused ? { paused } : {}), ...(reason ? { reason: redact(reason) } : {}), trigger, ...(category ? { category } : {}), ...(merged ? { merged } : {}),
  ...(recovery ? { recovery: structuredClone(recovery) } : category === 'configuration' && !pullRequest && !attempts?.length && status === 'needs-person' ? { recovery: { status: 'required' as const, runs: [], requests: [] } } : {}),
  // A head verified before GitHub's update of the branch is not the pull request's head any more.
  ...(verified && verified === pushed ? { verified: true as const } : {}),
  ...(cleanup ? { cleanup: { status: cleanup.status, ...(cleanup.reason ? { reason: text(cleanup.reason) } : {}) } } : {}),
  runs: runs.map(publicRun),
  ...(pullRequest ? { pullRequest: { number: pullRequest.number, url: pullRequest.url, ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }), ...(pullRequest.closed ? { closed: true as const } : {}) } } : {}),
  ...(attempts?.length ? { attempts: attempts.map(({ number, model, reproduced, failure, cost }) => ({ number, model, ...(reproduced === undefined ? {} : { reproduced }), ...(failure ? { failure: redact(failure) } : {}), ...(cost === undefined ? {} : { cost }) })) } : {}),
  ...(holds?.length ? { holds } : {}), ...(gates?.length ? { gates: gates.map(({ stageId, sha: head, status: verdict }) => ({ stageId, sha: head, status: verdict })) } : {}),
  createdAt, updatedAt, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
});

/**
 * Build repairs of the active managed GitHub source's target branch, persisted under <dataDir>/repairs. One repair is
 * active at a time; observed heads queue in order, and a controller start never starts paid work by itself.
 * source() -> { key, branch, repository|null, checkoutPath|null, rootDirectory|null } | null.
 * github: connection(), head({ repository, branch, etag }), runs({ repository, sha, login }), failure({ repository, runId }),
 *   rerun({ repository, runId }).
 * steps: unavailable() -> reason, repair(context, signal) -> outcome, close(repair), state(repair), cleanup({ repair, directory }), recover(): see RepairSteps.
 */
export async function createRepairManager({ dataDir, source, github, steps = {}, now = () => new Date().toISOString(), pollInterval = 60_000, outage = {} }: RepairManagerOptions) {
  const unreachable = { ...OUTAGE, ...outage };
  const root = await privateDirectory(resolve(dataDir, 'repairs'), 'Repair storage must not be a symbolic link.');
  const file = join(root, 'state.json');
  let state: RepairState = { version: 1, repairs: [] };
  const saved = await readStateFile(file, { limit: READ_LIMIT, invalid: 'Unsupported repair state.' });
  if (saved !== undefined) {
    if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.repairs) || !saved.repairs.every(validRepair) || saved.autoMerge !== undefined && !validAutoMerge(saved.autoMerge)
      || saved.passed !== undefined && !validPassed(saved.passed)) throw new Error('Unsupported repair state.');
    state = { version: 1, repairs: saved.repairs, ...(saved.autoMerge ? { autoMerge: saved.autoMerge } : {}), ...(saved.passed ? { passed: saved.passed } : {}) };
  }
  // Work the controller stopped during is never resumed: a restart starts no paid work, and its pull request stays open.
  // One whose pull request merged before the restart is merged.
  const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  // Older controllers could lose a terminal repair's host directory before confirming its Docker cleanup. History that
  // never made a box needs no sweep, so a controller without Docker is not held by it.
  let recovering = Boolean(steps.recover && (state.repairs.some(mayOwn) || directories.length));
  if (steps.cleanup) for (const repair of state.repairs) {
    if (ACTIVE.includes(repair.status) && mayOwn(repair) || directories.includes(repair.id)) repair.cleanup ??= { status: 'pending' };
  }
  for (const repair of state.repairs) {
    if (repair.status === 'queued') repair.paused = true;
    if (!ACTIVE.includes(repair.status)) continue;
    if (repair.recovery?.status === 'verifying') repair.recovery.status = 'unconfirmed';
    if (repair.merged) Object.assign(repair, { status: 'merged', completedAt: now(), updatedAt: now() } satisfies Partial<Repair>);
    else Object.assign(repair, { status: 'needs-person', reason: 'Interrupted by a controller restart.', completedAt: now(), updatedAt: now() } satisfies Partial<Repair>);
  }
  // Adapters with no external resources retain their original directory-only recovery. Real boxes must confirm deletion first.
  if (!steps.cleanup && !steps.recover) for (const name of directories) await rm(join(root, name), { recursive: true, force: true });
  const saves = createSaveQueue();
  let closed = false, checking: Promise<void> | null = null, timer: NodeJS.Timeout | undefined, watchError: string | null = null, recoveryError: string | null = null, reads = 0;
  const tasks = new Set<Promise<unknown>>(), controllers = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  const recoveryOperations = new Set<string>();
  // The head each source was last read at with its ETag (reads counts the reads that succeeded), the branch's own failed
  // runs of that head as last read, the first head seen since start (a baseline that opens nothing by itself), a head
  // whose runs all passed, which is not read again, the head the loop guard judges with the repairs whose pull requests
  // were read there and the checks that could not judge it, the repairs the guard gave up on, and the pull requests
  // being closed now.
  const heads = new Map<string, { branch: string; login: string; sha: string; etag: string | null }>();
  const failing = new Map<string, { branch: string; login: string; sha: string; runs: RepairRun[] }>();
  const baselines = new Map<string, { branch: string; sha: string }>(), passing = new Map<string, string>();
  const followed = new Map<string, Followed>(), queueFollowed = new Map<string, Followed>(), unjudged = new Set<string>(), inFlight = new Set<string>();
  // Each save keeps finished repairs' failures in brief and stays within SAVE_LIMIT, the oldest finished repairs that
  // hold no cleanup giving way first, so a start always reads the file back. A merge and a pull request that may still
  // be open, which the loop guard reads, give way last.
  function persist() {
    return saves.run(() => {
      for (const repair of state.repairs) if (repair.failures && !ACTIVE.includes(repair.status)) repair.failures = repair.failures.slice(0, 5).map(brief);
      let content = JSON.stringify(state);
      for (const spare of [(repair: Repair) => !repair.merged && (!repair.pullRequest || repair.pullRequest.closed), () => true]) {
        for (let index = state.repairs.length - 1; index >= 0 && Buffer.byteLength(content) > SAVE_LIMIT; index -= 1) {
          const repair = state.repairs[index];
          if (repair.status === 'queued' || ACTIVE.includes(repair.status) || repair.cleanup || unresolvedRecovery(repair) || !spare(repair)) continue;
          state.repairs.splice(index, 1);
          content = JSON.stringify(state);
        }
      }
      return writeStateFile(file, content);
    });
  }
  await persist();

  const managed = (): Managed | null => {
    const current = source();
    return current?.key && current.repository && current.branch && current.checkoutPath ? { ...current, repository: current.repository, branch: current.branch, checkoutPath: current.checkoutPath, rootDirectory: current.rootDirectory || '/' } : null;
  };
  const recoverySource = (repair: Repair, current: Managed | null) => Boolean(current && repair.key === current.key && repair.branch === current.branch && repair.repository === current.repository && repair.checkoutPath === current.checkoutPath && repair.rootDirectory === current.rootDirectory);
  // One repair at a time: an active repair, or a stopped or superseded one whose aborted step has not settled yet. A
  // startup sweep still owed holds only agent work, which needs Docker as the sweep does; triage and reruns go ahead.
  const running = () => state.repairs.some(repair => ACTIVE.includes(repair.status));
  const busy = () => running() || controllers.size > 0 || recoveryOperations.size > 0 || state.repairs.some(repair => repair.cleanup);
  const recoveryHold = () => `${CLEANUP_HOLD}${recoveryError ? ` ${recoveryError}` : ''}`;
  const scoped = (current: Managed) => state.repairs.filter(repair => repair.key === current.key && repair.branch === current.branch);
  const queued = (current: Managed) => scoped(current).filter(repair => repair.status === 'queued').reverse();
  // Why work of another branch or root directory of the managed source's repository stops: nothing watches, shows or
  // verifies it any more, while a check of the connection, which names only the repository, still passes for it. Work
  // of another repository ends at its next GitHub call instead.
  const left = (repair: Repair, current: Managed | null) => !current || repair.repository.toLowerCase() !== current.repository.toLowerCase() || repair.key === current.key && repair.branch === current.branch ? null
    : repair.key === current.key ? `Interrupted when the pipeline switched to ${current.branch}.` : 'Interrupted when the pipeline switched to another source.';
  const track = <T>(promise: Promise<T>) => { tasks.add(promise); void promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; };
  // A repair's pull request open on GitHub as far as Perpetual knows: not merged, closed, closing, or refused a close.
  const unclosed = (repair: Repair) => Boolean(repair.pullRequest) && !repair.pullRequest!.closed && !repair.pullRequest!.closing && !repair.closeError && repair.status !== 'merged';
  // A finished repair whose pull request is still open: one left for a person, or superseded work that may hold a fix.
  const lingering = (repair: Repair) => unclosed(repair) && (KEPT.includes(repair.status) || repair.status === 'superseded');
  // A pull request a person may still merge as far as Perpetual knows, once its repair's own work ended.
  const mergeable = (repair: Repair) => Boolean(repair.pullRequest) && !repair.pullRequest!.closed && repair.status !== 'merged' && !ACTIVE.includes(repair.status);
  // A verified fix: a ready repair whose pull request passed CI and is ready for review.
  const verified = (repair: Repair) => repair.status === 'ready' && repair.pullRequest?.draft === false;
  // The auto-merge switch of a pipeline, on until a person chooses Ask first.
  const autoMerge = (key: string) => !state.autoMerge || !Object.hasOwn(state.autoMerge, key) || state.autoMerge[key];
  // The failure a repair is of, as triage read it and a finished repair keeps it in brief: each failed workflow with the
  // steps its jobs failed at and its diagnosis.
  const failureOf = (repair: Repair) => JSON.stringify((repair.failures ?? []).slice(0, 5).map(brief).map(failure => [
    repair.runs.find(run => run.id === failure.runId)?.path ?? '', failure.diagnosis.category,
    failure.jobs.filter(job => job.failedSteps.length).map(job => [job.name, ...job.failedSteps].join('\n')).sort(),
  ]).sort());
  // Why a repair Autopilot opened by itself goes to a person: the repairs of the same failure before it, of its pipeline
  // and branch since a head last passed, failed BREAKER times in a row, every attempt of each failing. A repair the agent
  // never tried, one a person or a newer head stopped and one a restart or an error cut short neither count nor end the
  // run; a fix, or a repair of another failure, ends it.
  function breaker(repair: Repair) {
    const failure = failureOf(repair), since = state.passed?.[repair.key] ?? '';
    let count = 0;
    for (const item of state.repairs) {
      if (item === repair || item.key !== repair.key || item.branch !== repair.branch) continue;
      if (item.createdAt <= since || item.status === 'ready' || item.status === 'merged') break;
      if (item.status !== 'failed' && item.status !== 'needs-person' || !item.attempts?.length || !item.attempts.every(attempt => attempt.failure)) continue;
      if (failureOf(item) !== failure) break;
      if (++count < BREAKER) continue;
      return `The last ${BREAKER} repairs of ${[...new Set(repair.runs.map(run => run.name || run.path || run.id))].slice(0, 3).join(', ')} failed. Start Repair to try again.`;
    }
    return null;
  }
  // What a pipeline's repairs cost in the last day, from their attempts, one cut short included.
  const spentToday = (key: string) => {
    const since = Date.parse(now()) - DAY;
    return state.repairs.filter(repair => repair.key === key).flatMap(repair => repair.attempts ?? [])
      .filter(attempt => !(Date.parse(attempt.startedAt) < since)).reduce((total, attempt) => total + (attempt.cost ?? 0), 0);
  };

  // A repair of a commit an earlier repair pushed for continues its branch from that push.
  function open(current: Managed, login: string, sha: string, runs: readonly WorkflowRun[], trigger: Repair['trigger'], status: RepairStatus = 'triaging') {
    const time = now(), pushed = scoped(current).find(repair => repair.sha === sha && repair.pushed)?.pushed;
    const repair: Repair = { id: randomUUID(), key: current.key, repository: current.repository, branch: current.branch, sha, login, checkoutPath: current.checkoutPath, rootDirectory: current.rootDirectory,
      trigger, status, runs: runs.slice(0, 20).map(runOf), ...(pushed ? { pushed } : {}), createdAt: time, updatedAt: time };
    state.repairs.unshift(repair);
    // The newest LIMIT repairs of each pipeline are kept, so one busy pipeline never drops another's merges and pushes.
    const counts = new Map<string, number>();
    state.repairs = state.repairs.filter(item => {
      const count = (counts.get(item.key) ?? 0) + 1;
      counts.set(item.key, count);
      return count <= LIMIT || item.status === 'queued' || ACTIVE.includes(item.status) || item.cleanup || unresolvedRecovery(item);
    });
    return repair;
  }
  async function transition(repair: Repair, status: RepairStatus, fields: Partial<Repair> = {}) {
    Object.assign(repair, fields, { status, updatedAt: now() });
    await persist();
  }
  async function settle(repair: Repair, status: RepairStatus, reason?: string) {
    const time = now();
    if (repair.merged) status = 'merged';
    Object.assign(repair, { status, updatedAt: time, completedAt: time } satisfies Partial<Repair>);
    if (status !== 'queued') delete repair.paused;
    if (reason) repair.reason = text(reason); else if (status !== 'merged') delete repair.reason;
    await persist();
  }
  async function cleanup(repair: Repair) {
    if (!repair.cleanup || !steps.cleanup) return;
    try {
      await steps.cleanup({ repair: structuredClone(repair), directory: join(root, repair.id) });
      delete repair.cleanup;
    } catch (error) { repair.cleanup = { status: 'failed', reason: text(error) }; }
    repair.updatedAt = now();
    await persist();
  }
  async function cleanupOutstanding() {
    // A global legacy sweep must finish before admission, and must never race any still-unwinding agent.
    if (controllers.size) return;
    if (recovering) {
      try {
        await steps.recover!();
        for (const name of directories) {
          if (steps.cleanup && state.repairs.some(repair => repair.id === name && repair.cleanup)) continue;
          await rm(join(root, name), { recursive: true, force: true });
        }
        recovering = false;
      } catch (error) {
        // The sweep's own failure holds new repairs; only repairs that hold cleanup record it.
        if (steps.cleanup) for (const repair of state.repairs) if (repair.cleanup) repair.cleanup = { status: 'failed', reason: text(error) };
        await persist();
        throw error;
      }
    }
    for (const repair of state.repairs) if (repair.cleanup) await cleanup(repair);
  }
  // One close for every repair that shares the pull request. One a person merged on GitHub is the fix itself, never a
  // superseded one, and records the merge commit the close's read named. A close GitHub refused is recorded and not tried
  // again; any other failure, such as a network error, leaves it closing for the next check.
  async function closePullRequest(repair: Repair) {
    const { url } = repair.pullRequest!, sharing = () => state.repairs.filter(item => item.pullRequest?.url === url);
    inFlight.add(url);
    try {
      const read = pullRead(await steps.close!(structuredClone(repair)));
      for (const item of sharing()) {
        const pullRequest = { ...item.pullRequest! };
        delete pullRequest.closing;
        delete item.closeError;
        if (read?.state === 'merged') Object.assign(item, { status: 'merged', reason: MERGED, pullRequest, ...(read.merged ? { merged: read.merged } : {}), updatedAt: now() } satisfies Partial<Repair>);
        else item.pullRequest = { ...pullRequest, closed: true };
      }
    } catch (error) {
      if (!isRecord(error) || error.refused !== true) return;
      for (const item of sharing()) item.closeError = text(error);
    } finally { inFlight.delete(url); }
    await persist();
  }
  // Each closing pull request is closed as the account that opened it: at once, and again at each check while a close
  // failed. connection limits a check's retries to the connected account's repository.
  function closeQueued(connection?: { login: string; repository: string }) {
    if (closed || !steps.close) return;
    for (const repair of state.repairs) {
      const pullRequest = repair.pullRequest;
      if (!pullRequest?.closing || pullRequest.closed || repair.closeError || repair.status === 'merged' || inFlight.has(pullRequest.url)) continue;
      if (!connection || repair.login === connection.login && repair.repository === connection.repository) track(closePullRequest(repair));
    }
  }
  // Retire finished work; active work is never superseded by a newer head.
  function supersede(repair: Repair, sha: string) {
    const time = now();
    Object.assign(repair, { status: 'superseded', reason: `Superseded by ${short(sha)}.`, updatedAt: time, completedAt: time } satisfies Partial<Repair>);
    controllers.get(repair.id)?.controller.abort();
  }
  // A newer passing head, or a newer repair's own pull request, supersedes a finished repair; its open pull request is
  // marked closing, and closeQueued() closes it.
  function retire(repair: Repair, sha: string) {
    supersede(repair, sha);
    if (unclosed(repair) && steps.close) repair.pullRequest = { ...repair.pullRequest!, closing: true };
  }
  // Repair pull requests are not left open side by side: once a repair records a new one, the newest repair's open pull
  // request stays, and each other finished repair's closes as superseded by it, except a verified fix, which stays until
  // the newest is verified too. Repairs of one commit share its branch, and so its pull request.
  function prune(repair: Repair) {
    const [newest, ...older] = state.repairs.filter(item => item.key === repair.key && item.branch === repair.branch && unclosed(item));
    if (!newest) return;
    for (const item of older) {
      if (lingering(item) && item.sha !== newest.sha && item.pullRequest!.url !== newest.pullRequest!.url && (!verified(item) || verified(newest))) retire(item, newest.sha);
    }
    closeQueued();
  }
  const workspace = (id: string) => privateDirectory(join(root, id), 'Repair storage must not be a symbolic link.', { resolveAliases: false });
  // The agent step's reports are checked like any input, since they carry model output.
  async function report(repair: Repair, signal: AbortSignal, progress: unknown) {
    const invalid = () => new Error('Invalid repair progress.');
    if (!isRecord(progress)) throw invalid();
    const fields: Partial<Repair> = {};
    if (progress.status !== undefined) { if (!isText(progress.status) || !PROGRESS.has(progress.status)) throw invalid(); fields.status = progress.status as RepairStatus; }
    if (progress.pullRequest !== undefined) { if (!validPullRequest(progress.pullRequest)) throw invalid(); const { number, url, branch, draft } = progress.pullRequest; fields.pullRequest = { number, url, branch, ...(draft === undefined ? {} : { draft }) }; }
    if (progress.pushed !== undefined) { if (!isText(progress.pushed) || !SHA.test(progress.pushed)) throw invalid(); fields.pushed = progress.pushed.toLowerCase(); }
    if (progress.attempts !== undefined) {
      if (!Array.isArray(progress.attempts) || !progress.attempts.every(validAttempt)) throw invalid();
      fields.attempts = progress.attempts.slice(0, 20).map(attempt => ({ ...attempt, model: attempt.model.slice(0, 200), ...(attempt.failure ? { failure: text(attempt.failure, 2000) } : {}) }));
    }
    if (progress.diffHash !== undefined) { if (!validDiffHash(progress.diffHash)) throw invalid(); fields.diffHash = progress.diffHash; }
    if (progress.ciRuns !== undefined) { if (!validCiRuns(progress.ciRuns)) throw invalid(); fields.ciRuns = progress.ciRuns.slice(0, 100); }
    if (progress.holds !== undefined) { if (!validHolds(progress.holds)) throw invalid(); fields.holds = progress.holds.map(hold => text(hold, 300)); }
    if (progress.gates !== undefined) { if (!validGates(progress.gates)) throw invalid(); fields.gates = progress.gates.map(({ gateId, stageId, sha, status }) => ({ gateId, stageId, sha: sha.toLowerCase(), status })); }
    if (progress.verified !== undefined) { if (!validSha(progress.verified)) throw invalid(); fields.verified = progress.verified.toLowerCase(); }
    if (progress.merged !== undefined) { if (!validSha(progress.merged)) throw invalid(); fields.merged = progress.merged.toLowerCase(); }
    const opened = fields.pullRequest && fields.pullRequest.url !== repair.pullRequest?.url ? fields.pullRequest : null;
    if (closed || signal.aborted || !ACTIVE.includes(repair.status)) {
      // A push, pull request or merge the step made while it unwinds is still recorded, never left unseen: a pull request
      // stays open, and a merged one makes the repair merged, whatever stopped it. So are its attempts, with what one cut
      // short cost, which the pipeline's daily cost cap counts.
      const { pushed, merged, attempts } = fields;
      if (opened || pushed || merged || attempts) {
        Object.assign(repair, opened ? { pullRequest: opened } : {}, pushed ? { pushed } : {}, attempts ? { attempts } : {}, merged ? { merged, status: 'merged', completedAt: repair.completedAt ?? now() } : {}, { updatedAt: now() });
        if (merged) delete repair.reason;
        if (opened) prune(repair);
        await persist();
      }
      throw conflict('This repair is no longer running.');
    }
    Object.assign(repair, fields, { updatedAt: now() });
    if (opened) prune(repair);
    await persist();
  }
  // Triage reads each failed run; configuration needs a person, availability reruns once, anything else goes to the agent.
  async function execute(repair: Repair, signal: AbortSignal) {
    const live = () => !closed && !signal.aborted && ACTIVE.includes(repair.status);
    // GitHub is read and written only as the account that opened the repair, for its repository: a disconnect, another
    // signed-in account or another source ends the repair before the next call. GitHub unreachable is waited out first,
    // and needs a person only once it outlasts the outage window.
    const connected = async () => {
      const connection = await untilReachable(() => github.connection(), { signal, pollMs: unreachable.pollMs, waitMs: unreachable.waitMs });
      if (!live()) return false;
      if (connection?.login === repair.login && connection.repository === repair.repository) return true;
      await settle(repair, 'needs-person', connection ? 'The GitHub connection changed. Start the repair again.' : 'Connect GitHub to repair builds.');
      return false;
    };
    try {
      if (!live() || !await connected()) return;
      const failures = await Promise.all(repair.runs.map(run => github.failure({ repository: repair.repository, runId: run.id })));
      if (!live()) return;
      const decision = triage(failures, Boolean(repair.reruns));
      Object.assign(repair, { failures: failures.slice(0, 20).map(scrubbed), category: decision.category });
      if (decision.next === 'needs-person') {
        repair.recovery = await recoveryFor({ ...repair, failures }, github.workflow);
        if (github.credentials) await credentialSnapshot(repair);
        if (!live()) return;
        return await settle(repair, 'needs-person', 'Authorization failed in GitHub Actions. Recovery continues automatically after credentials change.');
      }
      if (decision.next === 'rerun') {
        await transition(repair, 'rerunning', { reruns: repair.runs.map(({ id, attempt }) => ({ id, attempt })) });
        for (const run of repair.runs) { if (!live() || !await connected()) return; await github.rerun({ repository: repair.repository, runId: run.id }); }
        return;
      }
      // From here the failure is the agent step's, so a reason such as a missing key or Docker is the Change step's. No
      // agent starts before the startup sweep removed what an earlier controller's boxes left.
      repair.startedAt = now();
      if (recovering) return await settle(repair, 'needs-person', recoveryHold());
      const agent = steps.repair, blocked = await steps.unavailable?.() || (agent ? null : NO_AGENT);
      if (!live()) return;
      if (blocked || !agent) return await settle(repair, 'needs-person', text(blocked || NO_AGENT));
      // A repair Autopilot opened by itself waits for a person, without the agent, after its failure's breaker or once
      // its pipeline's repairs cost the daily cap; a person's Repair still starts. One that starts spends no more than
      // what is left of that cap.
      let spendable: number | undefined;
      if (repair.trigger === 'push') {
        const held = breaker(repair);
        if (held) return await settle(repair, 'needs-person', held);
        spendable = DAILY_COST - spentToday(repair.key);
        if (spendable <= 0) return await settle(repair, 'needs-person', `Repairs reached this pipeline's $${DAILY_COST.toFixed(2)} daily cost cap. Start Repair to try again.`);
      }
      if (steps.cleanup) { repair.cleanup = { status: 'pending' }; await persist(); }
      const directory = await workspace(repair.id);
      if (!live() || !await connected()) return;
      await transition(repair, 'repairing');
      const outcome: unknown = await agent({ repair: structuredClone(repair), directory, report: progress => report(repair, signal, progress), autoMerge: () => autoMerge(repair.key), ...(spendable === undefined ? {} : { spendable }) }, signal);
      if (isRecord(outcome) && outcome.status === 'merged' && validSha(outcome.merged)) repair.merged = outcome.merged.toLowerCase();
      if (!live()) return;
      if (!isRecord(outcome) || !isText(outcome.status) || !OUTCOMES.has(outcome.status) || outcome.status === 'merged' && !validSha(outcome.merged)) return await settle(repair, 'needs-person', 'The repair ended without a result.');
      await settle(repair, outcome.status as RepairStatus, isText(outcome.reason) ? outcome.reason : undefined);
      // A verified fix supersedes the verified fixes of older commits.
      if (verified(repair)) { prune(repair); await persist(); }
    } catch (error) {
      // Stopped or superseded work keeps the status that ended it; shutdown is recorded at the next start.
      if (live()) await settle(repair, 'needs-person', text(error));
    } finally {
      if (repair.merged && repair.status !== 'merged') await settle(repair, 'merged');
      await cleanup(repair);
    }
  }
  function begin(repair: Repair) {
    // Nothing starts once shutdown began: the repair stays active, and the next start records it as interrupted.
    if (closed || !ACTIVE.includes(repair.status)) return;
    const controller = new AbortController();
    const finished = Promise.resolve().then(() => execute(repair, controller.signal)).catch(error => { process.stderr.write(`Repair: ${text(error)}\n`); })
      .finally(() => {
        if (controllers.get(repair.id)?.controller === controller) controllers.delete(repair.id);
        // Wake the next queued item only after execution and cleanup settled. Do not wait on this check from the task itself.
        if (!closed && state.repairs.some(item => item.status === 'queued')) track(Promise.resolve().then(async () => { if (checking) await checking; await check(); }));
      });
    controllers.set(repair.id, { controller, finished });
    track(finished);
  }
  async function readHead(current: Managed, login: string) {
    const previous = heads.get(current.key);
    const known = previous?.branch === current.branch && previous.login === login;
    const head = await github.head({ repository: current.repository, branch: current.branch, etag: known ? previous.etag : null });
    reads += 1;
    if (head.status === 304) return known ? previous.sha : null;
    heads.set(current.key, { branch: current.branch, login, sha: head.sha, etag: head.etag });
    return head.sha;
  }
  // What the loop guard waits for before a failing head opens a repair by itself, since the head may be a person's merge
  // of it: each pull request an older commit's finished repair may still have open, even one being closed or whose close
  // GitHub refused, until a read at this head found it, and each merged repair's merge commit until a read names it. It
  // waits only for what the connected account opened for its repository, which it reads as, and no longer for what it
  // gave up on. Active work holds every head until it ends, and its pull request is read then.
  const holding = (current: Managed, connection: Connection, seen: Followed) => scoped(current).filter(repair => repair.login === connection.login && repair.repository === connection.repository
    && repair.pullRequest && !unjudged.has(repair.id) && (repair.status === 'merged' ? !repair.merged : repair.sha !== seen.sha && mergeable(repair) && !seen.read.has(repair.id)));
  // A ready repair's fix waits with its pull request, which a person may merge or close on GitHub at any time, at the
  // watched head too: it is read at every check, once a minute, as long as it is open as far as Perpetual knows, unless
  // the loop guard gave up on reading it.
  const waiting = (current: Managed, connection: Connection) => scoped(current).filter(repair => repair.status === 'ready' && unclosed(repair)
    && repair.login === connection.login && repair.repository === connection.repository && !unjudged.has(repair.id));
  // What a read found a person did to a finished repair's pull request: merged makes the repair merged, with the merge
  // commit that read names, and closed is recorded and not read again.
  function recordRead(repair: Repair, state: 'closed' | 'merged', merged?: string) {
    const pullRequest = { ...repair.pullRequest! };
    delete pullRequest.closing;
    if (state === 'merged') Object.assign(repair, { status: 'merged', reason: MERGED, pullRequest, ...(merged ? { merged } : {}) } satisfies Partial<Repair>);
    else repair.pullRequest = { ...pullRequest, closed: true };
    repair.updatedAt = now();
  }
  // A head that moved may be a person's merge of an older repair's pull request, whatever its runs do next. What the loop
  // guard waits for is read, as the account that opened it, and so is each ready repair's pull request. A read that
  // failed, or a merge commit still unknown, is read again at the next check. Returns what the guard has read at this
  // head.
  async function follow(current: Managed, connection: Connection, sha: string, following = followed) {
    if (!steps.state) return null;
    let seen = following.get(current.key);
    if (seen?.branch !== current.branch || seen.login !== connection.login || seen.sha !== sha) following.set(current.key, seen = { branch: current.branch, login: connection.login, sha, read: new Set(), waits: 0 });
    const reading = new Set<string>();
    for (const repair of holding(current, connection, seen)) {
      reading.add(repair.id);
      const read = await steps.state(structuredClone(repair)).then(pullRead, () => null);
      if (closed) return null;
      if (!read) continue;
      if (repair.status === 'merged') {
        if (!read.merged || repair.merged) continue;
        Object.assign(repair, { merged: read.merged, updatedAt: now() } satisfies Partial<Repair>);
        await persist();
        continue;
      }
      seen.read.add(repair.id);
      if (!mergeable(repair) || read.state === 'open') continue;
      recordRead(repair, read.state, read.merged);
      await persist();
    }
    for (const repair of waiting(current, connection)) {
      if (reading.has(repair.id)) continue;
      const read = await steps.state(structuredClone(repair)).then(pullRead, () => null);
      if (closed) return null;
      if (!read || read.state === 'open' || repair.status !== 'ready' || !unclosed(repair)) continue;
      recordRead(repair, read.state, read.merged);
      await persist();
    }
    return seen;
  }
  // Read the watched head even while busy. New observed commits wait; none interrupts the active repair.
  async function watchHead(current: Managed, connection: Connection) {
    const { login } = connection, sha = await readHead(current, login);
    watchError = null;
    if (!sha || closed) return;
    if (baselines.get(current.key)?.branch !== current.branch) baselines.set(current.key, { branch: current.branch, sha });
    const older = () => scoped(current).filter(repair => repair.sha !== sha);
    const seen = await follow(current, connection, sha);
    if (closed) return;
    const stale = () => older().filter(repair => kept(repair) || lingering(repair));
    const eligible = () => !closed && baselines.get(current.key)?.sha !== sha && !scoped(current).some(repair => repair.sha === sha);
    if (!stale().length && passing.get(current.key) === sha) return;
    const { runs } = await github.runs({ repository: current.repository, sha, login });
    if (closed) return;
    // The latest run of each workflow is the build to judge, as Build admission reads it: an older failure of a
    // workflow does not defeat its newer run that passed.
    const latest = latestBranchBuildRuns(runs, sha, current.branch);
    failing.set(current.key, { branch: current.branch, login, sha, runs: latest.filter(failedRun).slice(0, 20).map(runOf) });
    const completed = completedRuns(latest, current.branch);
    if (eligible() && (busy() || queued(current).length)) {
      open(current, login, sha, latest.filter(failedRun), 'push', 'queued');
      await persist();
    }
    if (!completed) return;
    if (completed.passed) {
      // A head that passed ends a run of failed repairs, which the breaker counts.
      const fresh = passing.get(current.key) !== sha;
      if (fresh) state.passed = { ...state.passed, [current.key]: now() };
      passing.set(current.key, sha);
      // A repair is retired only once each workflow whose failure it fixes passed at this head; one that did not run
      // here, such as one its paths filter skipped, has not shown the branch fixed, so the fix stays open.
      const retired = stale().filter(repair => repair.runs.every(item => !item.path || latest.some(run => run.path === item.path && passedRun(run))));
      for (const repair of retired) retire(repair, sha);
      if (retired.length || fresh) await persist();
      closeQueued();
      return;
    }
    // Runs that were cancelled or wait for approval neither pass nor fail: the head is read again at the next check.
    if (!completed.failed.length || !eligible()) return;
    // Loop guard: the merge of a repair's pull request that fails again needs a person, who may still start a Repair. A
    // head it cannot judge yet is read again at the next check, and after GUARD checks it gives up on what it waited for:
    // the head needs a person, and no later head waits for it.
    const merged = scoped(current).find(item => item.merged === sha), held = merged || !seen ? [] : holding(current, connection, seen);
    if (seen && held.length && ++seen.waits < GUARD) return;
    const repair = open(current, login, sha, completed.failed, 'push');
    if (merged) return await settle(repair, 'needs-person', `The merge of repair #${merged.pullRequest?.number ?? short(merged.sha)} failed again.`);
    if (held.length) {
      for (const item of held) unjudged.add(item.id);
      return await settle(repair, 'needs-person', `Could not tell whether this is the merge of repair ${[...new Set(held.map(item => `#${item.pullRequest!.number}`))].join(' or ')}.`);
    }
    await persist();
    begin(repair);
  }
  // The oldest observed commit owns the next slot, including while its CI is pending. Re-read its own runs,
  // not the latest head's. GitHub can still cancel CI independently of this queue.
  async function drain(current: Managed, connection: Connection) {
    if (closed || busy()) return;
    const repair = queued(current)[0];
    if (!repair || repair.paused) return;
    if (connection.login !== repair.login || connection.repository !== repair.repository) {
      await settle(repair, 'needs-person', 'The GitHub connection changed. Start the repair again.');
      return;
    }
    const { runs } = await github.runs({ repository: repair.repository, sha: repair.sha, login: repair.login });
    if (closed || busy() || repair.status !== 'queued' || repair.paused) return;
    const currentSource = managed();
    if (!currentSource || (['key', 'repository', 'branch', 'checkoutPath', 'rootDirectory'] as const).some(field => currentSource[field] !== current[field])) return;
    const latest = latestBranchBuildRuns(runs, repair.sha, repair.branch), completed = completedRuns(latest, repair.branch);
    if (!completed) return;
    if (completed.passed) { await settle(repair, 'passed', 'Build passed while queued.'); return; }
    if (!completed.failed.length) { await settle(repair, 'needs-person', 'The queued build did not complete successfully. Re-run its workflow on GitHub.'); return; }
    const seen = await follow(current, connection, repair.sha, queueFollowed);
    if (closed || busy() || repair.status !== 'queued') return;
    const merged = scoped(current).find(item => item.merged === repair.sha), held = merged || !seen ? [] : holding(current, connection, seen);
    if (merged) { await settle(repair, 'needs-person', `The merge of repair #${merged.pullRequest?.number ?? short(merged.sha)} failed again.`); return; }
    if (seen && held.length && ++seen.waits < GUARD) return;
    if (held.length) {
      for (const item of held) unjudged.add(item.id);
      await settle(repair, 'needs-person', 'Could not determine whether the queued commit is a repair merge.'); return;
    }
    const account = await github.connection(), activeSource = managed();
    if (closed || busy() || repair.status !== 'queued' || repair.paused || !activeSource || (['key', 'repository', 'branch', 'checkoutPath', 'rootDirectory'] as const).some(field => activeSource[field] !== current[field])) return;
    if (account?.login !== repair.login || account.repository !== repair.repository) { await settle(repair, 'needs-person', 'The GitHub connection changed. Start the repair again.'); return; }
    await transition(repair, 'triaging', { runs: completed.failed.map(runOf) });
    begin(repair);
  }
  // A rerun follows its own repository even after the active source changed. A failed attempt goes to repair, unless
  // the pipeline left its branch or root directory, every attempt passing is flaky, and an attempt that was cancelled
  // or waits for approval needs a person.
  async function followRerun(repair: Repair, login: string) {
    if (repair.recovery) {
      if (login !== repair.login || recoveryOperations.has(repair.id)) return;
      return observeRecovery(repair);
    }
    const { runs } = await github.runs({ repository: repair.repository, sha: repair.sha, login });
    if (closed || repair.status !== 'rerunning') return;
    const found = (repair.reruns || []).map(rerun => runs.find(run => run.id === rerun.id && run.attempt > rerun.attempt && run.status === 'completed'));
    if (!found.length || found.some(run => !run)) return;
    const attempts = found as WorkflowRun[], failed = attempts.filter(failedRun), other = attempts.find(run => !passedRun(run));
    const reason = failed.length ? left(repair, managed()) : null;
    if (reason) { repair.runs = failed.map(runOf); return await settle(repair, 'needs-person', reason); }
    if (failed.length) { await transition(repair, 'triaging', { runs: failed.map(runOf) }); return begin(repair); }
    if (!other) return await settle(repair, 'flaky');
    await settle(repair, 'needs-person', `The rerun ended as ${String(other.conclusion ?? 'unknown').replaceAll('_', ' ')}.`);
  }

  // A connection is not evidence that CI recovered. Only a new execution of its original runs can clear it.
  async function observeRecovery(repair: Repair) {
    const recovery = repair.recovery!;
    const { runs } = await github.runs({ repository: repair.repository, sha: repair.sha, login: repair.login });
    if (closed || repair.status === 'cancelled') return;
    const account = await github.connection();
    if (closed || (repair as Repair).status === 'cancelled') return;
    if (account?.login !== repair.login || account.repository !== repair.repository) throw conflict('Connect the GitHub account that observed this failure.');
    const own = branchRuns(runs.filter(run => run.sha === repair.sha), repair.branch);
    recovery.checkedAt = now();
    const found = recovery.runs.map(ref => own.find(run => run.id === ref.id && run.path?.split('@')[0] === ref.workflow));
    if (!found.length || found.some(run => !run)) {
      recovery.status = 'unconfirmed';
      return settle(repair, 'needs-person', 'The original workflow runs could not be verified. Open the failed run on GitHub.');
    }
    for (const request of recovery.requests) {
      if (own.some(run => run.id === request.runId && run.attempt > request.attempt)) request.status = 'observed';
    }
    const unresolved = recovery.requests.filter(request => ['requested', 'accepted', 'uncertain'].includes(request.status));
    if (unresolved.length) {
      const uncertain = unresolved.some(request => request.status !== 'accepted' || Date.parse(now()) - Date.parse(request.requestedAt) > 15 * 60_000);
      recovery.status = uncertain ? 'unconfirmed' : 'verifying';
      if (uncertain) return settle(repair, 'needs-person', 'The rerun has not been confirmed. Recheck its status before trying again.');
      delete repair.reason; delete repair.completedAt; await transition(repair, 'rerunning'); return;
    }
    const observed = found as WorkflowRun[];
    if (observed.some(run => run.status !== 'completed')) {
      recovery.status = 'verifying';
      delete repair.reason; delete repair.completedAt; await transition(repair, 'rerunning'); return;
    }
    const allPassed = observed.every((run, index) => passedRun(run) && run.attempt > recovery.runs[index].attempt);
    if (!allPassed) {
      recovery.status = 'required';
      const attempted = recovery.requests.length > 0 || observed.some((run, index) => run.attempt > recovery.runs[index].attempt);
      return settle(repair, 'needs-person', attempted ? 'The workflow has not recovered. Review the latest failure before retrying.' : 'Waiting for workflow credentials. Recovery continues automatically after they change.');
    }
    const latest = latestBranchBuildRuns(runs, repair.sha, repair.branch), completed = completedRuns(latest, repair.branch);
    if (!completed) {
      recovery.status = 'verifying'; delete repair.reason; delete repair.completedAt; await transition(repair, 'rerunning'); return;
    }
    recovery.status = 'passed';
    if (!completed.passed) return settle(repair, 'needs-person', 'Authorization recovery passed; another workflow still needs attention.');
    await settle(repair, 'passed', 'The original workflows passed at this commit after recovery.');
    // The ordinary gate watcher independently observes CI; this never promotes a commit or marks Production ready.
  }

  async function recoverBuild({ id, action }: { id: unknown; action: unknown }, credentialRevision?: string) {
    guard();
    if (action !== 'recheck' && action !== 'rerun') throw new Error('Choose Recheck or Rerun failed jobs.');
    const repair = state.repairs.find(item => item.id === id);
    if (!repair) throw Object.assign(new Error('Repair not found.'), { statusCode: 404 });
    if (repair.pullRequest || repair.attempts?.length || repair.category !== 'configuration') throw conflict('This record is not an authorization recovery.');
    if (recoveryOperations.has(repair.id)) throw conflict('Recovery is already being checked.');
    if (repair.status === 'cancelled' || repair.status === 'superseded' || repair.status === 'queued' || ACTIVE.includes(repair.status) && repair.status !== 'rerunning') throw conflict('This recovery is not available.');
    if (action === 'rerun' && busy()) throw conflict('Build is busy. Wait for its current work to finish.');
    const current = managed();
    const sameSource = () => {
      guard();
      const active = managed();
      if (!current || !recoverySource(repair, active) || repair.status === 'cancelled') throw conflict('The active source changed or recovery stopped. Reload the pipeline.');
    };
    const connection = async () => {
      const account = await github.connection(); sameSource();
      if (account?.login !== repair.login || account.repository !== repair.repository) throw conflict('Connect the GitHub account that observed this failure.');
    };
    recoveryOperations.add(repair.id);
    try {
      await connection();
      if (!repair.recovery) {
        const failures = repair.failures?.length ? repair.failures : await Promise.all(repair.runs.map(run => github.failure({ repository: repair.repository, runId: run.id })));
        await connection();
        repair.recovery = await recoveryFor({ ...repair, failures }, github.workflow);
        sameSource(); await persist();
      }
      await observeRecovery(repair); sameSource();
      if (action === 'recheck') {
        if (repair.status === 'needs-person' && repair.recovery.status !== 'passed' && github.credentials) await credentialSnapshot(repair);
        return view();
      }
      if (repair.recovery.status === 'passed' || repair.recovery.status === 'verifying') return view();
      const recovery = repair.recovery;
      if (recovery.requests.some(request => ['requested', 'accepted', 'uncertain'].includes(request.status))) throw conflict('A prior rerun is unconfirmed. Recheck or open the workflow on GitHub; it will not be sent twice.');
      if (recovery.requests.length + recovery.runs.length > 100) throw conflict('This recovery reached its rerun limit. Open the workflow on GitHub.');
      // Prevent replaying an older deployment after the branch advanced. The user explicitly reruns only its current commit.
      const head = await github.head({ repository: repair.repository, branch: repair.branch });
      sameSource();
      if (head.status !== 200 || head.sha !== repair.sha) throw conflict('The branch has moved. Open its current failed build instead.');
      const { runs } = await github.runs({ repository: repair.repository, sha: repair.sha, login: repair.login });
      const own = branchRuns(runs.filter(run => run.sha === repair.sha), repair.branch);
      const failed = recovery.runs.map(ref => own.find(run => run.id === ref.id && run.path?.split('@')[0] === ref.workflow)).filter((run): run is WorkflowRun => Boolean(run && failedRun(run)));
      if (!failed.length) throw conflict('No original failed jobs are available to rerun. Recheck their status.');
      await connection();
      const latestHead = await github.head({ repository: repair.repository, branch: repair.branch });
      sameSource();
      if (latestHead.status !== 200 || latestHead.sha !== repair.sha) throw conflict('The branch has moved. Reload the pipeline.');
      if (credentialRevision) {
        const snapshot = await github.credentials!({ repository: repair.repository, runs: recovery.runs });
        await connection();
        if (!('revision' in snapshot) || snapshot.ready === false || snapshot.revision !== credentialRevision) throw conflict('Workflow credentials changed during recovery. The next check will verify them again.');
        if (recovery.requests.some(request => request.credentialRevision === credentialRevision)) return view();
      }
      recovery.status = 'verifying';
      delete repair.completedAt;
      delete repair.reason;
      await transition(repair, 'rerunning');
      for (const run of failed) {
        await connection();
        const head = await github.head({ repository: repair.repository, branch: repair.branch }); sameSource();
        if (head.status !== 200 || head.sha !== repair.sha) {
          recovery.status = 'unconfirmed';
          await settle(repair, 'needs-person', 'The branch moved before all reruns were requested. Recheck the original runs.');
          return view();
        }
        const request: BuildRecovery['requests'][number] = { runId: run.id, attempt: run.attempt, requestedAt: now(), status: 'requested', ...(credentialRevision ? { credentialRevision } : {}) };
        recovery.requests.push(request);
        await persist(); // Persist intent before the external write; an uncertain outcome is never resent automatically.
        sameSource();
        try { await github.rerun({ repository: repair.repository, runId: run.id }); request.status = 'accepted'; }
        catch (error) {
          request.status = isRecord(error) && error.refused === true ? 'refused' : 'uncertain';
          recovery.status = request.status === 'refused' ? 'required' : 'unconfirmed';
          if ((repair as Repair).status !== 'cancelled') await settle(repair, 'needs-person', text(error));
          else await persist();
          return view();
        }
        await persist(); sameSource();
      }
      return view();
    } finally { recoveryOperations.delete(repair.id); }
  }
  const credentialBindingsRead = new Set<string>();
  async function credentialSnapshot(repair: Repair) {
    const recovery = repair.recovery!;
    // Older recovery records predate provider bindings; retrace only the immutable failed workflow once per session.
    if (!credentialBindingsRead.has(repair.id) && github.workflow && repair.failures?.length) {
      credentialBindingsRead.add(repair.id);
      const fresh = await recoveryFor({ repository: repair.repository, sha: repair.sha, runs: repair.runs, failures: repair.failures }, github.workflow);
      for (const run of recovery.runs) { const updated = fresh.runs.find(item => item.id === run.id); if (updated?.vercelSecret) run.vercelSecret = updated.vercelSecret; }
    }
    const snapshot = await github.credentials!({ repository: repair.repository, runs: recovery.runs });
    if (closed || repair.status === 'cancelled') return null;
    if (!('revision' in snapshot)) {
      recovery.automation = { status: 'unavailable', reason: text(snapshot.reason) };
      await persist(); return null;
    }
    recovery.automation = snapshot.ready === false ? { status: 'unavailable', reason: text(snapshot.reason || 'Waiting for workflow credentials.') } : { status: 'watching' };
    // Old records establish a baseline on their first observation; a restart never invents a credential change.
    recovery.credentialRevision ??= snapshot.revision;
    await persist(); return snapshot.ready === false ? null : snapshot.revision;
  }

  async function followAuthorization(current: Managed, account: { login: string; repository: string }) {
    // Only the newest recovery of a commit is eligible; historical retries cannot each launch the same workflow.
    const seen = new Set<string>();
    for (const repair of scoped(current)) {
      if (seen.has(repair.sha)) continue;
      seen.add(repair.sha);
      if (repair.category !== 'configuration' || repair.pullRequest || repair.attempts?.length || repair.login !== account.login || repair.repository !== account.repository || !recoverySource(repair, current) || repair.status !== 'needs-person' || recoveryOperations.has(repair.id)) continue;
      if (!repair.recovery) await recoverBuild({ id: repair.id, action: 'recheck' });
      if (!repair.recovery) continue;
      recoveryOperations.add(repair.id);
      let revision: string | null = null;
      try {
        await observeRecovery(repair);
        if (repair.status === 'needs-person' && repair.recovery.status !== 'passed' && github.credentials) revision = await credentialSnapshot(repair);
      } finally { recoveryOperations.delete(repair.id); }
      if (repair.status === 'needs-person' && repair.recovery.status !== 'passed' && new Set(repair.recovery.requests.flatMap(request=>request.credentialRevision?[request.credentialRevision]:[])).size >= 3) {
        repair.recovery.automation={status:'unavailable',reason:'Three credential updates did not recover the workflow. Review its latest failure.'};await persist();continue;
      }
      if (closed || repair.status !== 'needs-person' || !revision || busy() || queued(current).length || unresolvedRecovery(repair) || revision === repair.recovery.credentialRevision || repair.recovery.requests.some(request => request.credentialRevision === revision)) continue;
      // The same admission checks as a manual rerun recheck account, source, current head and original run identity.
      await recoverBuild({ id: repair.id, action: 'rerun' }, revision);
    }
  }

  function check() {
    if (closed) return Promise.resolve();
    checking ??= Promise.resolve().then(async () => {
      // Cleanup can recover without a connected source; only it clears its earlier failure, and a sweep it put off while
      // a repair ran clears nothing. A sweep that failed holds agent work, while heads, triage, reruns and pull requests
      // are still followed.
      try { await cleanupOutstanding(); if (!recovering) recoveryError = null; }
      catch (error) { recoveryError = text(error); }
      if (closed) return;
      const current = managed();
      // Work under way for another branch or root directory of this repository stops, its pull request kept. A rerun
      // follows its own repository, as after any change of source.
      if (current) for (const repair of state.repairs) {
        const reason = (repair.status === 'queued' || ACTIVE.includes(repair.status)) && repair.status !== 'rerunning' ? left(repair, current) : null;
        if (!reason) continue;
        controllers.get(repair.id)?.controller.abort();
        await settle(repair, 'needs-person', reason);
      }
      if (!current && !state.repairs.some(repair => repair.status === 'rerunning')) return;
      const connection = await github.connection();
      if (closed) return;
      // Without a connected account no head is watched, so no Repair is offered.
      if (!connection) { if (current) heads.delete(current.key); return; }
      // A close that failed at an earlier check is tried again.
      closeQueued(connection);
      const failure = (error: unknown) => { watchError = text(error); };
      // A rerun's result is followed even while the head cannot be read.
      if (current) await watchHead(current, connection).catch(failure);
      const rerunning = state.repairs.find(repair => repair.status === 'rerunning');
      if (rerunning && !closed && (!rerunning.recovery || connection.login === rerunning.login && connection.repository === rerunning.repository)) await followRerun(rerunning, connection.login).catch(failure);
      if (current && !closed) await followAuthorization(current, connection).catch(failure);
      if (current && !closed) {
        let first: string | undefined;
        do {
          first = queued(current)[0]?.id;
          await drain(current, connection).catch(failure);
        } while (!closed && !busy() && first && queued(current)[0] && queued(current)[0].id !== first);
      }
    }).catch(error => { watchError = text(error); }).finally(() => { checking = null; });
    return checking;
  }
  function view(): RepairView {
    const current = source(), watched = managed(), head = watched && heads.get(watched.key), read = watched && failing.get(watched.key);
    const repairs = current?.key ? state.repairs.filter(repair => repair.key === current.key && repair.branch === current.branch).filter((repair, index) => index < 20 || repair.status === 'queued' || ACTIVE.includes(repair.status)).map(publicRepair) : [];
    // Resource ownership holds the whole controller, even when its repair belongs to another source or is outside the visible history.
    const cleanup = state.repairs.find(repair => repair.cleanup?.status === 'failed')?.cleanup ?? state.repairs.find(repair => repair.cleanup)?.cleanup;
    const held = recovering || Boolean(cleanup);
    const cleanupReason = cleanup?.status === 'failed' ? cleanup.reason ? text(cleanup.reason) : 'Resource deletion could not be confirmed.' : recoveryError;
    const cleanupError = cleanupReason ? `${CLEANUP_HOLD} ${cleanupReason}` : null;
    const error = [cleanupError, watchError].filter(Boolean).join(' ');
    const failed = !held && head && read?.branch === head.branch && read.login === head.login && read.sha === head.sha ? read.runs.map(publicRun) : [];
    return { repairs, ...(head && head.branch === watched.branch ? { head: { sha: head.sha, branch: head.branch, failed } } : {}), ...(watched ? { autoMerge: autoMerge(watched.key) } : {}), ...(error ? { watchError: error } : {}) };
  }
  const guard = () => { if (closed) throw conflict('The controller is shutting down.'); };
  return {
    view,
    credentialContext(id: unknown) {
      const current=managed(),repair=current?scoped(current).find(item=>item.id===id):undefined;
      return repair?.recovery&&repair.category==='configuration'&&!repair.pullRequest&&!repair.attempts?.length
        ?{key:repair.key,repository:repair.repository,login:repair.login,runs:structuredClone(repair.recovery.runs)}:null;
    },
    recover(input: { id: unknown; action: unknown }) { return track(recoverBuild(input)); },
    hasWork(key: string) { return state.repairs.some(item=>item.key===key&&(controllers.has(item.id)||item.status==='queued'||ACTIVE.includes(item.status)||Boolean(item.cleanup))); },
    check,
    /**
     * Repair: a person starts one for a failed run of the branch at its current watched head, even a baseline, whichever
     * commit the source was scanned at; a finished one may start again. The request names only the run, never a commit,
     * and the head and its runs are read again as the connected account: a head that cannot be read, or moves meanwhile,
     * refuses it.
     */
    async repair({ runId }: { runId: unknown }) {
      guard();
      if (!isText(runId) && typeof runId !== 'number' || !RUN_ID.test(String(runId))) throw new Error('Choose a failed workflow run.');
      if (!source()?.key) throw new Error('Scan a repository first.');
      const current = managed();
      if (!current) throw new Error('Connect a GitHub repository to repair its builds.');
      const unchanged = () => {
        guard();
        const latest = managed();
        if (!latest || (['key', 'repository', 'branch', 'checkoutPath', 'rootDirectory'] as const).some(field => latest[field] !== current[field])) throw conflict('The active source changed. Reload the pipeline.');
      };
      const verified = await github.connection();
      unchanged();
      if (!verified) throw new Error('Connect GitHub to repair builds.');
      const connection = { ...verified };
      if (connection.repository !== current.repository) throw conflict('The GitHub connection changed. Start the repair again.');
      for (;;) {
        // A check under way may have read the head before this request, so a check of its own follows it.
        if (checking) await checking;
        unchanged();
        const read = reads;
        await check();
        unchanged();
        const head = heads.get(current.key);
        if (reads === read || head?.branch !== current.branch) throw conflict(recoveryError || watchError || `Could not read the head of ${current.branch}. Try again.`);
        if (head.login !== connection.login) throw conflict('The GitHub connection changed. Start the repair again.');
        // True when this commit's repair is already running; a held or other active repair refuses.
        const started = () => {
          const existing = scoped(current).find(repair => repair.sha === head.sha);
          if (existing && ACTIVE.includes(existing.status)) return true;
          if (existing && !retryable(existing)) throw conflict('This commit already has a repair.');
          if (running() || queued(current).length) throw conflict('Another repair is running or queued.');
          // A person's Repair is not offered while the startup sweep is owed, and says why.
          if (recovering) throw conflict(recoveryHold());
          if (busy()) throw conflict('The previous repair is still ending. Try again.');
          return false;
        };
        // The named run is a failed build of the branch at its head, even when that head's repair already runs.
        const { runs } = await github.runs({ repository: current.repository, sha: head.sha, login: connection.login });
        unchanged();
        const connected = await github.connection();
        unchanged();
        if (connected?.login !== connection.login || connected.repository !== connection.repository) throw conflict('The GitHub connection changed. Start the repair again.');
        // A manual request still targets the failed run the person selected at the current head.
        const latestHead = heads.get(current.key);
        if (latestHead?.branch !== head.branch || latestHead.login !== head.login || latestHead.sha !== head.sha) throw conflict(`The head of ${current.branch} moved. Reload the pipeline.`);
        const id = String(runId), own = branchRuns(runs, current.branch), failed = latestBranchBuildRuns(runs, head.sha, current.branch).filter(failedRun);
        if (!failed.some(run => run.id === id)) {
          throw conflict(!runs.some(run => run.id === id) ? `This run is not at the head of ${current.branch}.` : own.some(run => run.id === id) ? 'Choose a failed workflow run.' : `This run is not a build of ${current.branch}.`);
        }
        // A normal terminal outcome is visible before its save has finished. Wait for that execution,
        // then read admission evidence again; stopped work and owned resources keep their existing hold.
        const previous = scoped(current).find(repair => controllers.has(repair.id));
        const ending = previous && controllers.get(previous.id);
        if (previous && retryable(previous) && !previous.cleanup && ending && !ending.controller.signal.aborted) {
          await ending.finished;
          unchanged();
          continue;
        }
        if (started()) return view();
        const repair = open(current, connection.login, head.sha, failed, 'person');
        await persist();
        try { unchanged(); } catch (error) { await settle(repair, 'needs-person', text(error)); throw error; }
        begin(repair);
        return view();
      }
    },
    /**
     * The auto-merge switch, per pipeline, which the Build stage's Autopilot mode sets: off, a repair stops at ready once CI and its gates ran, and a repair already
     * verifying reads it before it merges.
     */
    async setAutoMerge({ enabled }: { enabled: unknown }) {
      guard();
      if (typeof enabled !== 'boolean') throw new Error('Choose on or off.');
      if (!source()?.key) throw new Error('Scan a repository first.');
      const current = managed();
      if (!current) throw new Error('Connect a GitHub repository to repair its builds.');
      state.autoMerge = { ...state.autoMerge, [current.key]: enabled };
      await persist();
      return view();
    },
    /** Resume the persisted queue for the current source after a restart; existing order and cost limits remain. */
    async resume() {
      guard();
      const current = managed();
      if (!current) throw conflict('Connect a GitHub repository first.');
      const connection = await github.connection();
      guard();
      const active = managed();
      if (!connection || connection.repository !== current.repository || !active || (['key', 'repository', 'branch', 'checkoutPath', 'rootDirectory'] as const).some(field => active[field] !== current[field])) throw conflict('The GitHub connection changed.');
      const waiting = queued(current);
      if (waiting.some(repair => repair.login !== connection.login)) throw conflict('Connect the GitHub account that queued these commits.');
      for (const repair of waiting) delete repair.paused;
      await persist();
      await check();
      return view();
    },
    /** Stop: an active repair ends as cancelled and its work is aborted; its pull request stays open. */
    async stop({ id }: { id: unknown }) {
      guard();
      const repair = state.repairs.find(item => item.id === id);
      if (!repair) throw Object.assign(new Error('Repair not found.'), { statusCode: 404 });
      if (repair.status !== 'queued' && !ACTIVE.includes(repair.status) && !(repair.recovery && repair.status === 'needs-person' && repair.recovery.status !== 'passed')) throw conflict('This repair is not running or queued.');
      controllers.get(repair.id)?.controller.abort();
      await settle(repair, 'cancelled');
      return view();
    },
    start() {
      if (closed || timer) return;
      timer = setInterval(() => { void check(); }, pollInterval);
      timer.unref?.();
      void check();
    },
    /** Resolves once checks, repairs and reports have settled. */
    async idle() { while (checking || tasks.size) await Promise.allSettled([checking, ...tasks]); await saves.idle(); },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const { controller } of controllers.values()) controller.abort();
      while (checking || tasks.size) await Promise.allSettled([checking, ...tasks]);
      await saves.idle();
    },
  };
}
export type RepairManager = Awaited<ReturnType<typeof createRepairManager>>;
