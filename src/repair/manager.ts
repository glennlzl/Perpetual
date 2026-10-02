import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { failureText, redact } from '../redaction.ts';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { SHA, short } from '../gate/rules.ts';
import type { BranchHead, BranchHeadInput } from '../gate/github.ts';
import type { WorkflowRun } from '../github-runs.ts';
import type { FailedJob, GitHubFailure, PullRequestRead } from './github.ts';
import { branchRuns, completedRuns, failedRun, passedRun, triage } from './triage.ts';

// triaging -> rerunning -> repairing -> verifying-ci -> verifying-gates -> merged | ready | flaky | needs-person | failed;
// superseded and cancelled end active work and keep its pull request open. A finished repair whose pull request a person
// merged on GitHub is merged, and one whose pull request is still open is superseded, and the pull request closed, once a
// newer head passes or a newer repair opens its own; a verified fix stays open until a newer fix is verified too. A newer
// head never supersedes verifying-gates at once, since the merge step verifies a moved target branch again; it retires
// it once the newer head passes.
export type RepairStatus = 'triaging' | 'rerunning' | 'repairing' | 'verifying-ci' | 'verifying-gates' | 'ready' | 'merged' | 'flaky' | 'needs-person' | 'failed' | 'superseded' | 'cancelled';
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
  runs: RepairRun[]; failures?: GitHubFailure[]; category?: string; reruns?: { id: string; attempt: number }[];
  pullRequest?: RepairPullRequest; attempts?: RepairAttempt[]; diffHash?: string; ciRuns?: string[]; closeError?: string;
  /** The last commit Perpetual pushed to this commit's repair branch; a person's next Repair of the commit leases it. */
  pushed?: string;
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
  /** The connected, verified account, or null. */
  connection(): Promise<{ login: string; repository: string } | null>;
  head(input: BranchHeadInput): Promise<BranchHead>;
  runs(input: { repository: string; sha: string; login: string }): Promise<{ runs: WorkflowRun[] }>;
  failure(input: { repository: string; runId: string }): Promise<GitHubFailure>;
  rerun(input: { repository: string; runId: string }): Promise<void>;
}
/** What the agent step may record while it works; each report is persisted before it resolves. */
export interface RepairProgress { status?: 'repairing' | 'verifying-ci' | 'verifying-gates'; pullRequest?: RepairPullRequest; pushed?: string; attempts?: RepairAttempt[]; diffHash?: string; ciRuns?: string[]; holds?: string[]; gates?: RepairGate[]; merged?: string }
/** merged names the merge commit of a merged outcome. */
export interface RepairOutcome { status: 'ready' | 'merged' | 'failed' | 'needs-person'; reason?: string; merged?: string }
/**
 * The agent step's input. repair is a copy as stored when the step starts: the failing sha, its failed runs with the
 * triage failures (jobs, failed steps, redacted log and diagnosis), the account and the managed source copy.
 * directory is <dataDir>/repairs/<id> (0700), owned until resource cleanup succeeds. report()
 * rejects once the repair stopped; a push or pull request it names is still recorded first, and the pull request stays
 * open, and so is a merge. repair.pushed is what an earlier repair of the same commit last pushed. autoMerge() reads the
 * pipeline's auto-merge switch, the Build stage's Autopilot mode, when it is called.
 */
export interface RepairContext { repair: Repair; directory: string; report(progress: RepairProgress): Promise<void>; autoMerge(): boolean }
export interface RepairSteps {
  /** Why the agent cannot start, such as a missing OpenRouter API key; empty when it can. */
  unavailable?(): string | null | undefined | Promise<string | null | undefined>;
  /** The agent step: fix the failure through a pull request. signal aborts on Stop, a newer head or shutdown. */
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
export interface RepairManagerOptions { dataDir: string; source: () => RepairSource | null; github: RepairGitHub; steps?: RepairSteps; now?: () => string; pollInterval?: number }
/** A workflow run as Build shows it. */
export type PublicRun = Pick<RepairRun, 'id' | 'name' | 'path' | 'url'>;
/** A repair as the pipeline's Autopilot shows it (src/repair/view.ts): its record without the logs, redacted. */
export type PublicRepair = Pick<Repair, 'id' | 'branch' | 'sha' | 'status' | 'reason' | 'trigger' | 'category' | 'merged' | 'holds' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'cleanup'>
  & { runs: PublicRun[]; pullRequest?: Pick<RepairPullRequest, 'number' | 'url' | 'draft' | 'closed'>; attempts?: Pick<RepairAttempt, 'number' | 'model' | 'reproduced' | 'failure' | 'cost'>[]; gates?: Pick<RepairGate, 'stageId' | 'sha' | 'status'>[] };
/**
 * head is the watched head of a connected, managed source's target branch, with the branch's own failed workflow runs
 * there as the connected account last read them; a person's Repair names one of them. Without a head no Repair can start.
 * autoMerge is the pipeline's auto-merge switch, the Build stage's Autopilot mode, for a managed source only.
 */
export interface RepairView { repairs: PublicRepair[]; head?: { sha: string; branch: string; failed: PublicRun[] }; autoMerge?: boolean; watchError?: string }
type Managed = RepairSource & { repository: string; branch: string; checkoutPath: string; rootDirectory: string };
type Connection = { login: string; repository: string };
type Followed = { branch: string; login: string; sha: string; read: Set<string>; waits: number };
/** autoMerge holds the auto-merge switch per pipeline key; a pipeline without an entry merges. */
interface RepairState { version: 1; repairs: Repair[]; autoMerge?: Record<string, boolean> }

export const ACTIVE: readonly RepairStatus[] = Object.freeze(['triaging', 'rerunning', 'repairing', 'verifying-ci', 'verifying-gates']);
const STATUSES: Record<RepairStatus, true> = { triaging: true, rerunning: true, repairing: true, 'verifying-ci': true, 'verifying-gates': true, ready: true, merged: true, flaky: true, 'needs-person': true, failed: true, superseded: true, cancelled: true };
const OUTCOMES = new Set(['ready', 'merged', 'failed', 'needs-person']);
const PROGRESS = new Set(['repairing', 'verifying-ci', 'verifying-gates']);
/** A finished repair a person may start again; a ready or merged one already has its pull request. */
export const retryable = (status: RepairStatus) => !ACTIVE.includes(status) && status !== 'ready' && status !== 'merged';
// Finished repairs left for a person with their pull request: a failed or stopped repair keeps its draft, and a restart
// leaves an interrupted one's open. A newer passing head supersedes each of them.
const KEPT: readonly RepairStatus[] = ['ready', 'failed', 'needs-person', 'cancelled'];
const kept = (repair: Repair) => Boolean(repair.pullRequest) && KEPT.includes(repair.status);
const MERGED = 'Merged on GitHub.';
const NO_AGENT = 'Automatic repair is unavailable. Fix the failure in a pull request.';
const LIMIT = 100;
/** Checks a failing head waits for the loop guard to judge it before it needs a person. */
const GUARD = 10;
const RUN_ID = /^\d{1,20}$/;
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
/** A stored repair with every field detection, triage and the view read. */
const validRepair = (value: unknown): value is Repair => isRecord(value)
  && (['id', 'key', 'repository', 'branch', 'sha', 'login', 'checkoutPath', 'rootDirectory', 'createdAt', 'updatedAt'] as const).every(field => isText(value[field]))
  && /^[\w-]{1,64}$/.test(value.id as string) && SHA.test(value.sha as string) && (value.trigger === 'push' || value.trigger === 'person') && isText(value.status) && Object.hasOwn(STATUSES, value.status)
  && Array.isArray(value.runs) && value.runs.every(validRun)
  && (['reason', 'category', 'closeError', 'startedAt', 'completedAt'] as const).every(field => optionalText(value[field]))
  && (value.failures === undefined || Array.isArray(value.failures) && value.failures.every(validFailure))
  && (value.reruns === undefined || Array.isArray(value.reruns) && value.reruns.every(item => isRecord(item) && isText(item.id) && count(item.attempt)))
  && (value.cleanup === undefined || isRecord(value.cleanup) && (value.cleanup.status === 'pending' || value.cleanup.status === 'failed') && optionalText(value.cleanup.reason))
  && (value.pullRequest === undefined || validPullRequest(value.pullRequest))
  && (value.attempts === undefined || Array.isArray(value.attempts) && value.attempts.every(validAttempt))
  && (value.diffHash === undefined || validDiffHash(value.diffHash)) && (value.ciRuns === undefined || validCiRuns(value.ciRuns)) && (value.holds === undefined || validHolds(value.holds))
  && (value.pushed === undefined || validSha(value.pushed)) && (value.merged === undefined || validSha(value.merged)) && (value.gates === undefined || validGates(value.gates));
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
const publicRepair = ({ id, branch, sha, status, reason, cleanup, trigger, category, runs, pullRequest, attempts, holds, gates, merged, createdAt, updatedAt, startedAt, completedAt }: Repair): PublicRepair => ({
  id, branch, sha, status, ...(reason ? { reason: redact(reason) } : {}), trigger, ...(category ? { category } : {}), ...(merged ? { merged } : {}),
  ...(cleanup ? { cleanup: { status: cleanup.status, ...(cleanup.reason ? { reason: text(cleanup.reason) } : {}) } } : {}),
  runs: runs.map(publicRun),
  ...(pullRequest ? { pullRequest: { number: pullRequest.number, url: pullRequest.url, ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }), ...(pullRequest.closed ? { closed: true as const } : {}) } } : {}),
  ...(attempts?.length ? { attempts: attempts.map(({ number, model, reproduced, failure, cost }) => ({ number, model, ...(reproduced === undefined ? {} : { reproduced }), ...(failure ? { failure: redact(failure) } : {}), ...(cost === undefined ? {} : { cost }) })) } : {}),
  ...(holds?.length ? { holds } : {}), ...(gates?.length ? { gates: gates.map(({ stageId, sha: head, status: verdict }) => ({ stageId, sha: head, status: verdict })) } : {}),
  createdAt, updatedAt, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
});

/**
 * Build repairs of the active managed GitHub source's target branch, persisted under <dataDir>/repairs. One repair is
 * active at a time, only the newest head is repaired, and a controller start never starts one by itself.
 * source() -> { key, branch, repository|null, checkoutPath|null, rootDirectory|null } | null.
 * github: connection(), head({ repository, branch, etag }), runs({ repository, sha, login }), failure({ repository, runId }),
 *   rerun({ repository, runId }).
 * steps: unavailable() -> reason, repair(context, signal) -> outcome, close(repair), state(repair), cleanup({ repair, directory }), recover(): see RepairSteps.
 */
export async function createRepairManager({ dataDir, source, github, steps = {}, now = () => new Date().toISOString(), pollInterval = 60_000 }: RepairManagerOptions) {
  const root = await privateDirectory(resolve(dataDir, 'repairs'), 'Repair storage must not be a symbolic link.');
  const file = join(root, 'state.json');
  let state: RepairState = { version: 1, repairs: [] };
  const saved = await readStateFile(file, { limit: 16 * 1024 * 1024, invalid: 'Unsupported repair state.' });
  if (saved !== undefined) {
    if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.repairs) || !saved.repairs.every(validRepair) || saved.autoMerge !== undefined && !validAutoMerge(saved.autoMerge)) throw new Error('Unsupported repair state.');
    state = { version: 1, repairs: saved.repairs, ...(saved.autoMerge ? { autoMerge: saved.autoMerge } : {}) };
  }
  // Work the controller stopped during is never resumed: a restart starts no paid work, and its pull request stays open.
  // One whose pull request merged before the restart is merged.
  const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  // Older controllers could lose a terminal repair's host directory before confirming its Docker cleanup.
  let recovering = Boolean(steps.recover && (state.repairs.length || directories.length));
  if (steps.cleanup) for (const repair of state.repairs) {
    if (ACTIVE.includes(repair.status) || directories.includes(repair.id)) repair.cleanup ??= { status: 'pending' };
  }
  for (const repair of state.repairs) {
    if (!ACTIVE.includes(repair.status)) continue;
    if (repair.merged) Object.assign(repair, { status: 'merged', completedAt: now(), updatedAt: now() } satisfies Partial<Repair>);
    else Object.assign(repair, { status: 'needs-person', reason: 'Interrupted by a controller restart.', completedAt: now(), updatedAt: now() } satisfies Partial<Repair>);
  }
  // Adapters with no external resources retain their original directory-only recovery. Real boxes must confirm deletion first.
  if (!steps.cleanup && !steps.recover) for (const name of directories) await rm(join(root, name), { recursive: true, force: true });
  const saves = createSaveQueue();
  let closed = false, checking: Promise<void> | null = null, timer: NodeJS.Timeout | undefined, watchError: string | null = null, recoveryError: string | null = null, reads = 0;
  const tasks = new Set<Promise<unknown>>(), controllers = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  // The head each source was last read at with its ETag (reads counts the reads that succeeded), the branch's own failed
  // runs of that head as last read, the first head seen since start (a baseline that opens nothing by itself), a head
  // whose runs all passed, which is not read again, the head the loop guard judges with the repairs whose pull requests
  // were read there and the checks that could not judge it, the repairs the guard gave up on, and the pull requests
  // being closed now.
  const heads = new Map<string, { branch: string; login: string; sha: string; etag: string | null }>();
  const failing = new Map<string, { branch: string; login: string; sha: string; runs: RepairRun[] }>();
  const baselines = new Map<string, { branch: string; sha: string }>(), passing = new Map<string, string>();
  const followed = new Map<string, Followed>(), unjudged = new Set<string>(), inFlight = new Set<string>();
  function persist() { return saves.run(() => writeStateFile(file, JSON.stringify(state))); }
  await persist();

  const managed = (): Managed | null => {
    const current = source();
    return current?.key && current.repository && current.branch && current.checkoutPath ? { ...current, repository: current.repository, branch: current.branch, checkoutPath: current.checkoutPath, rootDirectory: current.rootDirectory || '/' } : null;
  };
  // One repair at a time: an active repair, or a stopped or superseded one whose aborted step has not settled yet.
  const running = () => state.repairs.some(repair => ACTIVE.includes(repair.status));
  const busy = () => running() || controllers.size > 0 || recovering || state.repairs.some(repair => repair.cleanup);
  const scoped = (current: Managed) => state.repairs.filter(repair => repair.key === current.key && repair.branch === current.branch);
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

  // A repair of a commit an earlier repair pushed for continues its branch from that push.
  function open(current: Managed, login: string, sha: string, runs: readonly WorkflowRun[], trigger: Repair['trigger']) {
    const time = now(), pushed = scoped(current).find(repair => repair.sha === sha && repair.pushed)?.pushed;
    const repair: Repair = { id: randomUUID(), key: current.key, repository: current.repository, branch: current.branch, sha, login, checkoutPath: current.checkoutPath, rootDirectory: current.rootDirectory,
      trigger, status: 'triaging', runs: runs.slice(0, 20).map(runOf), ...(pushed ? { pushed } : {}), createdAt: time, updatedAt: time };
    state.repairs.unshift(repair);
    state.repairs = state.repairs.filter((item, index) => index < LIMIT || ACTIVE.includes(item.status) || item.cleanup);
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
        if (steps.cleanup) for (const repair of state.repairs) repair.cleanup = { status: 'failed', reason: text(error) };
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
  // A newer head stops active work at once, and its pull request, which may hold a valid fix, stays open.
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
    if (progress.merged !== undefined) { if (!validSha(progress.merged)) throw invalid(); fields.merged = progress.merged.toLowerCase(); }
    const opened = fields.pullRequest && fields.pullRequest.url !== repair.pullRequest?.url ? fields.pullRequest : null;
    if (closed || signal.aborted || !ACTIVE.includes(repair.status)) {
      // A push, pull request or merge the step made while it unwinds is still recorded, never left unseen: a pull request
      // stays open, and a merged one makes the repair merged, whatever stopped it.
      const { pushed, merged } = fields;
      if (opened || pushed || merged) {
        Object.assign(repair, opened ? { pullRequest: opened } : {}, pushed ? { pushed } : {}, merged ? { merged, status: 'merged', completedAt: repair.completedAt ?? now() } : {}, { updatedAt: now() });
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
    // signed-in account or another source ends the repair before the next call.
    const connected = async () => {
      const connection = await github.connection();
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
      if (decision.next === 'needs-person') return await settle(repair, 'needs-person', decision.reason);
      if (decision.next === 'rerun') {
        await transition(repair, 'rerunning', { reruns: repair.runs.map(({ id, attempt }) => ({ id, attempt })) });
        for (const run of repair.runs) { if (!live() || !await connected()) return; await github.rerun({ repository: repair.repository, runId: run.id }); }
        return;
      }
      // From here the failure is the agent step's, so a reason such as a missing key or Docker is the Change step's.
      repair.startedAt = now();
      const agent = steps.repair, blocked = await steps.unavailable?.() || (agent ? null : NO_AGENT);
      if (!live()) return;
      if (blocked || !agent) return await settle(repair, 'needs-person', text(blocked || NO_AGENT));
      if (steps.cleanup) { repair.cleanup = { status: 'pending' }; await persist(); }
      const directory = await workspace(repair.id);
      if (!live() || !await connected()) return;
      await transition(repair, 'repairing');
      const outcome: unknown = await agent({ repair: structuredClone(repair), directory, report: progress => report(repair, signal, progress), autoMerge: () => autoMerge(repair.key) }, signal);
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
      .finally(() => { if (controllers.get(repair.id)?.controller === controller) controllers.delete(repair.id); });
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
  // A head that moved may be a person's merge of an older repair's pull request, whatever its runs do next. What the loop
  // guard waits for is read, as the account that opened it: merged makes the repair merged, with the merge commit that
  // read names, and closed is recorded and not read again. A read that failed, or a merge commit still unknown, is read
  // again at the next check. Returns what the guard has read at this head.
  async function follow(current: Managed, connection: Connection, sha: string) {
    if (!steps.state) return null;
    let seen = followed.get(current.key);
    if (seen?.branch !== current.branch || seen.login !== connection.login || seen.sha !== sha) followed.set(current.key, seen = { branch: current.branch, login: connection.login, sha, read: new Set(), waits: 0 });
    for (const repair of holding(current, connection, seen)) {
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
      const pullRequest = { ...repair.pullRequest! };
      delete pullRequest.closing;
      if (read.state === 'merged') Object.assign(repair, { status: 'merged', reason: MERGED, pullRequest, ...(read.merged ? { merged: read.merged } : {}) } satisfies Partial<Repair>);
      else repair.pullRequest = { ...pullRequest, closed: true };
      repair.updatedAt = now();
      await persist();
    }
    return seen;
  }
  // Only the newest head is repaired: a new head supersedes active work at once, except a fix whose gates or merge are
  // under way, which verifies a moved target branch again itself; that one, and finished repairs whose pull request is
  // still open, are superseded once the new head passes. The head's runs are read, even at a baseline, for a person's
  // Repair.
  async function watchHead(current: Managed, connection: Connection) {
    const { login } = connection, sha = await readHead(current, login);
    watchError = null;
    if (!sha || closed) return;
    if (baselines.get(current.key)?.branch !== current.branch) baselines.set(current.key, { branch: current.branch, sha });
    const older = () => scoped(current).filter(repair => repair.sha !== sha);
    const superseded = older().filter(repair => ACTIVE.includes(repair.status) && repair.status !== 'verifying-gates');
    for (const repair of superseded) supersede(repair, sha);
    if (superseded.length) await persist();
    const seen = await follow(current, connection, sha);
    if (closed) return;
    const stale = () => older().filter(repair => kept(repair) || lingering(repair) || repair.status === 'verifying-gates');
    const eligible = () => !closed && baselines.get(current.key)?.sha !== sha && !busy() && !scoped(current).some(repair => repair.sha === sha);
    if (!stale().length && passing.get(current.key) === sha) return;
    const { runs } = await github.runs({ repository: current.repository, sha, login });
    if (closed) return;
    failing.set(current.key, { branch: current.branch, login, sha, runs: branchRuns(runs, current.branch).filter(failedRun).slice(0, 20).map(runOf) });
    const completed = completedRuns(runs, current.branch);
    if (!completed) return;
    if (completed.passed) {
      passing.set(current.key, sha);
      const retired = stale();
      for (const repair of retired) retire(repair, sha);
      if (retired.length) await persist();
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
  // A rerun follows its own repository even after the active source changed. A failed attempt goes to repair, every
  // attempt passing is flaky, and an attempt that was cancelled or waits for approval needs a person.
  async function followRerun(repair: Repair, login: string) {
    const { runs } = await github.runs({ repository: repair.repository, sha: repair.sha, login });
    if (closed || repair.status !== 'rerunning') return;
    const found = (repair.reruns || []).map(rerun => runs.find(run => run.id === rerun.id && run.attempt > rerun.attempt && run.status === 'completed'));
    if (!found.length || found.some(run => !run)) return;
    const attempts = found as WorkflowRun[], failed = attempts.filter(failedRun), other = attempts.find(run => !passedRun(run));
    if (failed.length) { await transition(repair, 'triaging', { runs: failed.map(runOf) }); return begin(repair); }
    if (!other) return await settle(repair, 'flaky');
    await settle(repair, 'needs-person', `The rerun ended as ${String(other.conclusion ?? 'unknown').replaceAll('_', ' ')}.`);
  }
  function check() {
    if (closed) return Promise.resolve();
    checking ??= Promise.resolve().then(async () => {
      // Cleanup can recover without a connected source; only it clears its earlier failure.
      try { await cleanupOutstanding(); recoveryError = null; }
      catch (error) { recoveryError = text(error); return; }
      if (closed) return;
      const current = managed();
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
      if (rerunning && !closed) await followRerun(rerunning, connection.login).catch(failure);
    }).catch(error => { watchError = text(error); }).finally(() => { checking = null; });
    return checking;
  }
  function view(): RepairView {
    const current = source(), watched = managed(), head = watched && heads.get(watched.key), read = watched && failing.get(watched.key);
    const repairs = current?.key ? state.repairs.filter(repair => repair.key === current.key && repair.branch === current.branch).slice(0, 20).map(publicRepair) : [];
    // Resource ownership holds the whole controller, even when its repair belongs to another source or is outside the visible history.
    const cleanup = state.repairs.find(repair => repair.cleanup?.status === 'failed')?.cleanup ?? state.repairs.find(repair => repair.cleanup)?.cleanup;
    const held = recovering || Boolean(cleanup);
    const cleanupReason = cleanup?.status === 'failed' ? cleanup.reason ? text(cleanup.reason) : 'Resource deletion could not be confirmed.' : recoveryError;
    const cleanupError = cleanupReason ? `Repair cleanup must finish before another repair can start. ${cleanupReason}` : null;
    const error = [cleanupError, watchError].filter(Boolean).join(' ');
    const failed = !held && head && read?.branch === head.branch && read.login === head.login && read.sha === head.sha ? read.runs.map(publicRun) : [];
    return { repairs, ...(head && head.branch === watched.branch ? { head: { sha: head.sha, branch: head.branch, failed } } : {}), ...(watched ? { autoMerge: autoMerge(watched.key) } : {}), ...(error ? { watchError: error } : {}) };
  }
  const guard = () => { if (closed) throw conflict('The controller is shutting down.'); };
  return {
    view,
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
          if (existing && !retryable(existing.status)) throw conflict('This commit already has a repair.');
          if (running()) throw conflict('Another repair is running.');
          if (busy()) throw conflict('The previous repair is still ending. Try again.');
          return false;
        };
        // The named run is a failed build of the branch at its head, even when that head's repair already runs.
        const { runs } = await github.runs({ repository: current.repository, sha: head.sha, login: connection.login });
        unchanged();
        const connected = await github.connection();
        unchanged();
        if (connected?.login !== connection.login || connected.repository !== connection.repository) throw conflict('The GitHub connection changed. Start the repair again.');
        // A repair of a commit the head moved past while its runs were read would be superseded at once.
        const latestHead = heads.get(current.key);
        if (latestHead?.branch !== head.branch || latestHead.login !== head.login || latestHead.sha !== head.sha) throw conflict(`The head of ${current.branch} moved. Reload the pipeline.`);
        const id = String(runId), own = branchRuns(runs, current.branch), failed = own.filter(failedRun);
        if (!failed.some(run => run.id === id)) {
          throw conflict(!runs.some(run => run.id === id) ? `This run is not at the head of ${current.branch}.` : own.some(run => run.id === id) ? 'Choose a failed workflow run.' : `This run is not a build of ${current.branch}.`);
        }
        // A normal terminal outcome is visible before its save has finished. Wait for that execution,
        // then read admission evidence again; stopped work and owned resources keep their existing hold.
        const previous = scoped(current).find(repair => controllers.has(repair.id));
        const ending = previous && controllers.get(previous.id);
        if (previous && retryable(previous.status) && !previous.cleanup && ending && !ending.controller.signal.aborted) {
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
    /** Stop: an active repair ends as cancelled and its work is aborted; its pull request stays open. */
    async stop({ id }: { id: unknown }) {
      guard();
      const repair = state.repairs.find(item => item.id === id);
      if (!repair) throw Object.assign(new Error('Repair not found.'), { statusCode: 404 });
      if (!ACTIVE.includes(repair.status)) throw conflict('This repair is not running.');
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
