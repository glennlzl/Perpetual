import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { failureText } from '../redaction.ts';
import { isEnvironmentBusy } from '../environments/usage.ts';
import type { GateView, ReleaseEvidence, StageGate } from '../../contract/gate.ts';
import type { BranchHead, BranchHeadInput, CommitStatusPost } from './github.ts';
import { ACTIVE, PENDING, SHA, commitStatus, nextGate, productionReady, sameStatus, short, stageGate, verdict, type CommitState, type CommitStatus, type Gate, type GateRef, type GateStatus, type RunRollup } from './rules.ts';

export interface GateStage { id: string; name: string; kind: string }
/** The active pipeline; repository is set only for a managed GitHub source, the only one the watcher may move. */
export interface GateSource { key: string; branch: string | null; sha: string | null; repository?: string | null; stages: readonly GateStage[] }
export interface GateConnection { login: string; repository: string }
export interface BuildInput { repository: string; branch: string | null; sha: string; login: string }
export type BuildVerdict = { status: 'passed' } | { status: 'waiting' | 'blocked'; reason: string };
export interface GateGitHub {
  connection(): Promise<GateConnection | null>;
  head(input: BranchHeadInput): Promise<BranchHead>;
  post(status: CommitStatusPost): Promise<void>;
  /** Only Actions build evidence, never the journey's own commit statuses. Missing evidence fails closed. */
  build?(input: BuildInput): Promise<BuildVerdict>;
}
/** A gate's work: prepare(gate) -> context (409: not now), journeys(context) -> count, rebuild(context) -> twin, run(context, twin) -> finished run. */
export interface GateSteps<Context, Twin, Run = RunRollup | null | undefined> {
  prepare(gate: GateRef): Promise<Context>;
  journeys(context: Context): number | Promise<number>;
  rebuild(context: Context): Promise<Twin>;
  run(context: Context, twin: Twin): Promise<Run>;
}
/** The watched head of a pipeline's branch, which a managed source without a Sandbox stage follows. */
export interface SourceHead { key: string; branch: string | null; sha: string }
export interface GateManagerOptions<Context, Twin> {
  dataDir: string; source: () => GateSource | null; github: GateGitHub; steps: GateSteps<Context, Twin>;
  /** Moves the managed source copy to its branch's head and rescans it (409: not now). */
  follow?: (head: SourceHead) => Promise<void>;
  now?: () => string; pollInterval?: number; retryInterval?: number;
}
/** A gate as the pipeline shows it. */
/** A gate as GET /api/gate replies with it: the contract's StageGate, picked from the persisted record. */
export type PublicGate = Pick<Gate, 'id' | 'stageId' | 'sha' | 'status' | 'reason' | 'releasedBy' | 'releasedAt' | 'statusError' | 'detectedAt' | 'updatedAt'> & StageGate;
export type { GateView };
/**
 * A repair's gates at its pull request head: key is the active pipeline, branch the repair branch, sha the head and
 * snapshot the absolute scan path of a checkout Perpetual owns at it. Each field is checked as unknown.
 */
export interface RepairGateRequest { key: unknown; repair: unknown; branch: unknown; sha: unknown; snapshot: unknown }
/** A repair gate as its repair records it, with the commit status context it reports. */
export type RepairGateView = PublicGate & { context: string };
/** The last branch head the watcher saw for a pipeline, and the account that read it; checkedAt is only a record. */
interface Head { repository?: string; branch: string | null; login: string; sha: string; etag: string | null; checkedAt?: string }
type WatchResult = { identity: string; login: string; sha: string } | { identity: string | null; error: string } | null;
interface GateState { version: 1; gates: Gate[]; heads: Partial<Record<string, Head>> }

// Every gate status and commit state, so a stored gate is checked against the whole set.
const GATE_STATUSES: Record<GateStatus, true> = { queued: true, 'waiting-build': true, 'build-failed': true, rebuilding: true, running: true, passed: true, failed: true, 'needs-release': true, released: true, superseded: true };
const COMMIT_STATES: Record<CommitState, true> = { pending: true, success: true, failure: true, error: true };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value === undefined || isText(value);
const isPosted = (value: unknown): value is CommitStatus => isRecord(value) && isText(value.state) && Object.hasOwn(COMMIT_STATES, value.state) && isText(value.context) && isText(value.description);
/** A stored gate with every field its commit status and schedule read. */
const validGate = (value: unknown): value is Gate => isRecord(value)
  && (['id', 'key', 'stageId', 'sha', 'context', 'createdAt', 'detectedAt', 'updatedAt'] as const).every(field => isText(value[field]))
  && (value.branch === null || isText(value.branch)) && isText(value.status) && Object.hasOwn(GATE_STATUSES, value.status)
  && (['reason', 'startedAt', 'completedAt', 'runId', 'environmentId', 'releasedBy', 'releasedAt', 'statusError', 'repair', 'snapshot'] as const).every(field => optionalText(value[field]))
  && (value.posted === undefined || isPosted(value.posted));
const validHead = (value: unknown): value is Head => isRecord(value) && (value.branch === null || isText(value.branch))
  && isText(value.login) && isText(value.sha) && (value.etag === null || isText(value.etag)) && optionalText(value.checkedAt) && optionalText(value.repository);
const validHeads = (value: unknown): value is GateState['heads'] => isRecord(value) && Object.values(value).every(validHead);
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const text = (error: unknown) => failureText(error, 500);
const LIMIT = 300;
const STOPPED = 'The repair stopped.', CHANGED = 'The active source changed.', RESTARTED = 'Interrupted by a controller restart.';
// Only the most recently updated gates are reported again after a failed report.
const REPORTED = 50;
const publicGate = ({ id, stageId, sha, status, reason, releasedBy, releasedAt, statusError, detectedAt, updatedAt }: Gate): PublicGate =>
  ({ id, stageId, sha, status, ...(reason ? { reason } : {}), ...(releasedBy ? { releasedBy, releasedAt } : {}), ...(statusError ? { statusError } : {}), detectedAt, updatedAt });

/**
 * Journey gates per (stage, commit), persisted under <dataDir>/gates. One gate runs at a time.
 * source() -> { key, branch, sha, repository|null, stages: [{ id, name, kind }] } | null: the active pipeline;
 *   repository is set only for a managed GitHub source, the only one the watcher may move.
 * github: connection() -> { login, repository } | null, head({ repository, branch, etag }), post(status).
 * steps: prepare(gate) -> context (409: not now), journeys(context) -> count, rebuild(context) -> twin,
 *   run(context, twin) -> finished run.
 * follow({ key, branch, sha }): moves a managed source without a Sandbox stage to its watched head (409: not now).
 */
export async function createGateManager<Context, Twin extends { id?: string | null } | null | undefined>({ dataDir, source, github, steps, follow, now = () => new Date().toISOString(), pollInterval = 60_000, retryInterval = 10_000 }: GateManagerOptions<Context, Twin>) {
  const root = await privateDirectory(resolve(dataDir, 'gates'), 'Gate storage must not be a symbolic link.');
  const file = join(root, 'state.json');
  let state: GateState = { version: 1, gates: [], heads: {} };
  const saved = await readStateFile(file, { limit: 16 * 1024 * 1024, invalid: 'Unsupported gate state.' });
  if (saved !== undefined) {
    if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.gates) || !saved.gates.every(validGate) || !validHeads(saved.heads)) throw new Error('Unsupported gate state.');
    state = { version: 1, gates: saved.gates, heads: saved.heads };
  }
  // A twin or run the controller stopped during has no verdict; a person decides. So does a repair gate still queued: its
  // repair ended with the restart.
  for (const gate of state.gates) if (ACTIVE.includes(gate.status) || gate.repair && gate.status === 'queued') Object.assign(gate, { status: 'needs-release', reason: RESTARTED, completedAt: now(), updatedAt: now() } satisfies Partial<Gate>);
  const saves = createSaveQueue();
  let closed = false, draining: Promise<void> | null = null, watching: Promise<WatchResult> | null = null, syncing: Promise<void> | null = null, syncAgain = false;
  let timer: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined, watchError: string | null = null;
  let watchErrorScope: { identity: string | null; login: string | null } | null = null;
  // A repair's wait for each of its gates, the gate being executed, and repair gates stopped while it was prepared.
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }[]>(), abandoned = new Set<string>();
  let executing: Gate | null = null;
  function persist() { return saves.run(() => writeStateFile(file, JSON.stringify(state))); }
  await persist();

  const active = () => { const current = source(); return current?.key ? current : null; };
  const sourceIdentity = (current: GateSource | null) => current ? JSON.stringify([current.key, current.branch, current.repository ?? null]) : null;
  const sandboxes = (current: GateSource) => current.stages.filter(stage => stage.kind === 'sandbox');
  // The target branch's gates; repair gates are never among them.
  const scoped = (current: GateSource) => state.gates.filter(gate => gate.key === current.key && gate.branch === current.branch && !gate.repair);
  // The most recently updated gates are kept, with every gate still pending or at work, so a gate that just reached its
  // verdict stays however long it waited.
  function prune() {
    const recent = new Set(state.gates.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, LIMIT));
    state.gates = state.gates.filter(item => recent.has(item) || [...PENDING, ...ACTIVE].includes(item.status));
  }

  function enqueue(current: GateSource, stage: GateStage, sha: string, detectedAt: string) {
    const time = now();
    let gate = state.gates.find(item => item.key === current.key && item.branch === current.branch && !item.repair && item.stageId === stage.id && item.sha === sha);
    if (gate && [...PENDING, ...ACTIVE].includes(gate.status)) return gate;
    // Only the newest pending commit of a stage runs; an older one arriving later is recorded as superseded.
    const newer = scoped(current).some(item => item.stageId === stage.id && item.sha !== sha && item.status !== 'superseded' && item.detectedAt > detectedAt);
    if (!gate) { gate = { id: randomUUID(), key: current.key, branch: current.branch, stageId: stage.id, sha, context: `perpetual/${stage.name}`, createdAt: time, status: 'queued', detectedAt, updatedAt: time }; state.gates.unshift(gate); }
    // A commit run again reports under the stage's current name, as branch protection names it now.
    gate.context = `perpetual/${stage.name}`;
    for (const field of ['reason', 'startedAt', 'completedAt', 'runId', 'environmentId', 'releasedBy', 'releasedAt'] as const) delete gate[field];
    Object.assign(gate, { status: newer ? 'superseded' : 'queued', detectedAt, updatedAt: time } satisfies Partial<Gate>, newer ? { reason: 'A newer commit reached this stage.' } : {});
    if (!newer) for (const other of scoped(current)) if (other !== gate && other.stageId === stage.id && PENDING.includes(other.status)) Object.assign(other, { status: 'superseded', reason: `Superseded by ${short(sha)}.`, updatedAt: time } satisfies Partial<Gate>);
    prune();
    return gate;
  }
  // A passed or released commit moves to the next Sandbox stage; Production is only shown Ready. A repair gate's commit
  // is a pull request head, which never moves on.
  function promote(gate: Gate) {
    if (gate.repair) return;
    const current = active();
    if (!current || current.key !== gate.key || current.branch !== gate.branch) return;
    const following = current.stages[current.stages.findIndex(stage => stage.id === gate.stageId) + 1];
    if (following?.kind === 'sandbox') enqueue(current, following, gate.sha, gate.detectedAt);
  }
  async function settle(gate: Gate, status: GateStatus, reason?: string) {
    const time = now();
    Object.assign(gate, { status, updatedAt: time, completedAt: time } satisfies Partial<Gate>);
    if (reason) gate.reason = reason; else delete gate.reason;
    if (status === 'passed') promote(gate);
    // A verdict stands when its save fails: the next save writes it, and a repair waiting for it still learns it.
    await persist().catch(error => { process.stderr.write(`Journey gate: ${text(error)}\n`); });
    void sync();
    for (const waiter of waiters.get(gate.id) ?? []) waiter.resolve();
    waiters.delete(gate.id);
  }
  async function transition(gate: Gate, status: GateStatus, fields: Partial<Gate> = {}) {
    Object.assign(gate, fields, { status, updatedAt: now() });
    await persist();
    void sync();
  }
  // Returns false when the stage cannot start now; the gate stays queued for a later attempt. A repair gate its repair
  // stopped while it was prepared is not started, and neither is one that stopped after the queue chose it.
  async function execute(gate: Gate) {
    if (!PENDING.includes(gate.status)) return true;
    executing = gate;
    try { return await work(gate); } finally { executing = null; abandoned.delete(gate.id); }
  }
  async function readBuild(current: GateSource, gate: Gate): Promise<BuildVerdict> {
    if (!current.repository || gate.repair) return { status: 'passed' };
    if (!github.build) return { status: 'waiting', reason: 'Build verification is unavailable.' };
    const identity = sourceIdentity(current);
    try {
      const connection = await github.connection();
      if (sourceIdentity(active()) !== identity) return { status: 'waiting', reason: CHANGED };
      if (!connection || connection.repository.toLowerCase() !== current.repository.toLowerCase()) return { status: 'waiting', reason: 'Connect GitHub to verify Build.' };
      return await github.build({ repository: current.repository, branch: gate.branch, sha: gate.sha, login: connection.login });
    } catch (error) { return { status: 'waiting', reason: text(error) }; }
  }
  async function admitBuild(gate: Gate): Promise<boolean> {
    if (gate.repair) return true;
    const current = active(), identity = sourceIdentity(current);
    if (!current || current.key !== gate.key || current.branch !== gate.branch) return false;
    const build = await readBuild(current, gate);
    // CI can finish after a source switch, stage removal or newer push. Its result belongs only to this queued commit.
    if (closed || sourceIdentity(active()) !== identity || !PENDING.includes(gate.status)
      || !sandboxes(active()!).some(stage => stage.id === gate.stageId)) return false;
    if (build.status !== 'passed') {
      const status = build.status === 'blocked' ? 'build-failed' : 'waiting-build';
      if (gate.status !== status || gate.reason !== build.reason) await transition(gate, status, { reason: build.reason });
      return false;
    }
    if (gate.status !== 'queued') { delete gate.reason; await transition(gate, 'queued'); }
    return true;
  }
  async function work(gate: Gate) {
    if (!(await admitBuild(gate))) return false;
    let context: Context;
    const stopped = async () => { if (!abandoned.has(gate.id)) return false; await settle(gate, 'superseded', STOPPED); return true; };
    try { context = await steps.prepare({ key: gate.key, branch: gate.branch, stageId: gate.stageId, sha: gate.sha, ...(gate.repair ? { repair: gate.repair, snapshot: gate.snapshot } : {}) }); }
    catch (error) {
      if (closed) return false;
      if (await stopped()) return true;
      if ((error as { statusCode?: unknown }).statusCode === 409) return false;
      await settle(gate, 'needs-release', text(error));
      return true;
    }
    if (await stopped()) return true;
    try {
      if (!(await steps.journeys(context))) { await settle(gate, 'needs-release', 'No reviewed journeys.'); return true; }
      await transition(gate, 'rebuilding', { startedAt: now() });
      const twin = await steps.rebuild(context);
      if (closed) return false;
      await transition(gate, 'running', twin?.id ? { environmentId: twin.id } : {});
      const run = await steps.run(context, twin);
      if (closed) return false;
      if (run?.id) gate.runId = run.id;
      const result = verdict(run);
      await settle(gate, result.status, result.reason);
    } catch (error) {
      // Interrupted work is recorded at the next start, never as a verdict.
      if (closed) return false;
      // Health checks and finishing browser work can take an old twin after prepare admitted the gate.
      // No journey has started during rebuilding: retry admission, never a journey execution or its result.
      if (gate.status === 'rebuilding' && isEnvironmentBusy(error)) {
        delete gate.startedAt;
        await transition(gate, 'queued');
        return false;
      }
      await settle(gate, 'needs-release', text(error));
    }
    return true;
  }
  function kick() {
    if (closed || draining) return draining;
    // A busy stage is skipped for this pass and retried later, so it never holds back another stage.
    // The task settles after its assignment, so a pass with nothing to run leaves no stale task.
    draining = Promise.resolve().then(async () => {
      const waiting = new Set<Gate>();
      for (;;) {
        const current = active();
        const gate = current && nextGate(scoped(current).filter(item => !waiting.has(item)), sandboxes(current).map(stage => stage.id)) || await nextRepairGate(current, waiting);
        if (!gate || closed) break;
        if (!(await execute(gate))) waiting.add(gate);
      }
      if (waiting.size && !closed) { clearTimeout(retry); retry = setTimeout(kick, retryInterval); retry.unref?.(); }
    }).catch(error => { process.stderr.write(`Journey gate: ${text(error)}\n`); }).finally(() => { draining = null; });
    return draining;
  }
  // Target-branch gates run first; a repair gate of the active source runs once none is queued, even one that cannot
  // start yet and waits for its retry, oldest first. A queued repair gate whose source is no longer active, or whose
  // stage is gone, ends without a verdict.
  async function nextRepairGate(current: GateSource | null, waiting: ReadonlySet<Gate>) {
    for (const gate of state.gates.filter(item => item.repair && item.status === 'queued' && item !== executing)) {
      if (closed) return null;
      if (!current || gate.key !== current.key) await settle(gate, 'needs-release', CHANGED);
      else if (!sandboxes(current).some(stage => stage.id === gate.stageId)) await settle(gate, 'needs-release', 'The stage was removed.');
    }
    // A failing target build must not prevent the repair PR's already-verified CI from reaching its journey gates.
    if (!current || nextGate(scoped(current).filter(gate => gate.status === 'queued'), sandboxes(current).map(stage => stage.id))) return null;
    return state.gates.filter(item => item.repair && item.status === 'queued' && item.key === current.key && !waiting.has(item)).at(-1) || null;
  }
  // Resolves once the gate settles. A queued gate stops at once as superseded when signal aborts, and one being prepared
  // once its preparation ends; a gate at work reaches its verdict first. The queue is kicked meanwhile, so a gate whose
  // source changed ends even when nothing else runs.
  function settled(gate: Gate, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      // The queue may have judged it while its record was saved.
      if (!['queued', ...ACTIVE].includes(gate.status)) return resolve();
      const timer = setInterval(() => { void kick(); }, retryInterval);
      timer.unref?.();
      const stop = () => {
        if (gate.status !== 'queued') return;
        if (executing === gate) abandoned.add(gate.id);
        else void settle(gate, 'superseded', STOPPED);
      };
      const done = (error?: Error) => { clearInterval(timer); signal?.removeEventListener('abort', stop); if (error) reject(error); else resolve(); };
      waiters.set(gate.id, [...waiters.get(gate.id) ?? [], { resolve: () => done(), reject: done }]);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }
  // Commit statuses follow gate states; a failed report is recorded and retried, never blocking the gate.
  function sync() {
    if (syncing) { syncAgain = true; return syncing; }
    syncing = Promise.resolve().then(async () => {
      do {
        syncAgain = false;
        const current = active();
        if (!current || closed) break;
        const identity = sourceIdentity(current);
        // Every gate whose status changed since it was reported, wherever it is stored: a commit run again or released
        // keeps its place. The most recently updated go first, and only the latest are retried after a failed report.
        const due = state.gates.filter(gate => gate.key === current.key && commitStatus(gate) && !sameStatus(commitStatus(gate), gate.posted))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, REPORTED);
        if (!due.length) continue;
        let connection: GateConnection | null = null;
        try { connection = await github.connection(); } catch { connection = null; }
        for (const gate of due) {
          // Account verification and every preceding post may outlive a source switch. Leave these reports pending
          // for their own source instead of applying a newly connected repository to the old commits.
          if (closed || sourceIdentity(active()) !== identity) break;
          if (connection && current.repository && connection.repository.toLowerCase() !== current.repository.toLowerCase()) break;
          const status = commitStatus(gate);
          // A gate queued again while the connection was read reports nothing.
          if (!status) continue;
          if (!connection) { gate.statusError = 'Connect GitHub to report commit status.'; continue; }
          try { await github.post({ repository: connection.repository, sha: gate.sha, ...status }); gate.posted = status; delete gate.statusError; }
          catch (error) { gate.statusError = text(error); }
        }
        await persist();
      } while (syncAgain && !closed);
    }).catch(error => { process.stderr.write(`Journey gate status: ${text(error)}\n`); }).finally(() => { syncing = null; });
    return syncing;
  }
  // Polls the target branch of a managed GitHub source. The first head seen for a branch or account is a
  // baseline, not a push; every later change queues the first Sandbox stage. Without a Sandbox stage no gate moves the
  // source, so it follows the head whenever that differs from the scanned commit, a head saved before a restart and
  // answered with 304 included. A follow that cannot start now waits for the next poll; one that fails stays the watch
  // error until a watch succeeds.
  function watch(): Promise<WatchResult> {
    if (closed) return Promise.resolve(null);
    let scope: typeof watchErrorScope = null;
    watching ??= Promise.resolve().then(async (): Promise<WatchResult> => {
      const selected = active();
      if (!selected?.repository) return null;
      // Keep the response under the source it was requested for, even if the selection changes meanwhile.
      const current = { ...selected, repository: selected.repository };
      const identity = sourceIdentity(current)!;
      scope = { identity, login: null };
      const connection = await github.connection();
      if (closed || sourceIdentity(active()) !== identity) return null;
      if (!connection || connection.repository.toLowerCase() !== current.repository.toLowerCase()) return { identity, error: 'Connect GitHub to read the branch head.' };
      const login = connection.login;
      scope = { identity, login: login.toLowerCase() };
      const previous = state.heads[current.key];
      const known = previous?.branch === current.branch && previous.login === login;
      const head = await github.head({ repository: current.repository, branch: current.branch, etag: known ? previous.etag : null });
      if (closed) return null;
      if (head.status !== 304) {
        state.heads[current.key] = { repository: current.repository, branch: current.branch, login, sha: head.sha, etag: head.etag, checkedAt: now() };
        const first = sandboxes(current)[0];
        if (first && known && previous.sha !== head.sha) enqueue(current, first, head.sha, now());
        await persist();
        kick();
      } else if (known && !previous.repository) {
        // A conditional response verifies the repository for a legacy persisted baseline.
        previous.repository = current.repository;
        await persist();
      }
      // The source read again, since a source change or a new Sandbox stage may have come meanwhile.
      const sha = head.status === 200 ? head.sha : known ? previous.sha : null, latest = active();
      if (follow && sha && !closed && latest?.repository && latest.key === current.key && latest.branch === current.branch && !sandboxes(latest).length && latest.sha !== sha) {
        await follow({ key: latest.key, branch: latest.branch, sha }).catch(error => { if ((error as { statusCode?: unknown }).statusCode !== 409) throw error; });
      }
      watchError = null;
      watchErrorScope = null;
      return sha ? { identity, login, sha } : { identity, error: 'Could not read the branch head. Try again.' };
    }).catch(error => { watchError = text(error); watchErrorScope = scope; return { identity: scope?.identity ?? null, error: watchError }; }).finally(() => { watching = null; });
    return watching;
  }
  /** Display evidence and manual admission share the same account, source and failed-watch constraints. */
  function watchedHead({ key, repository, branch, login }: { key: string; repository: string; branch: string | null; login: string }): SourceHead | null {
    const current = active();
    if (!current?.repository || !branch || current.key !== key || current.branch !== branch || current.repository.toLowerCase() !== repository.toLowerCase()) return null;
    if (watchError && watchErrorScope?.identity === sourceIdentity(current) && (watchErrorScope.login === null || watchErrorScope.login === login.toLowerCase())) throw Object.assign(new Error(watchError), { statusCode: 502 });
    const head = state.heads[key];
    if (!head || head.repository?.toLowerCase() !== repository.toLowerCase() || head.branch !== branch || head.login.toLowerCase() !== login.toLowerCase() || !SHA.test(head.sha)) return null;
    return { key, branch, sha: head.sha.toLowerCase() };
  }
  /** A saved head is a push baseline, not permission to start new work after its refresh failed. */
  async function manualCommit(current: GateSource): Promise<string | null> {
    const identity = sourceIdentity(current), observed = await watch();
    guard();
    if (sourceIdentity(active()) !== identity) throw conflict('The active source changed. Reload the pipeline.');
    if (!current.repository) return current.sha;
    if (observed && observed.identity !== identity) throw conflict('The active source changed. Reload the pipeline.');
    if (!observed || 'error' in observed) throw Object.assign(new Error(observed?.error ?? 'Could not read the branch head. Try again.'), { statusCode: 502 });
    const connection = await github.connection();
    guard();
    if (sourceIdentity(active()) !== identity) throw conflict('The active source changed. Reload the pipeline.');
    if (!connection || connection.login.toLowerCase() !== observed.login.toLowerCase() || connection.repository.toLowerCase() !== current.repository.toLowerCase()) throw conflict('The GitHub connection changed. Run the gate again.');
    const head = watchedHead({ key: current.key, repository: current.repository, branch: current.branch, login: connection.login });
    if (!head || head.sha !== observed.sha.toLowerCase()) throw conflict('The branch head changed. Run the gate again.');
    return head.sha;
  }
  function view(): GateView {
    const current = active();
    if (!current) return { stages: {}, production: null };
    const gates = scoped(current), ids = sandboxes(current).map(stage => stage.id);
    const stages = Object.fromEntries(ids.map(id => [id, stageGate(gates.filter(gate => gate.stageId === id))] as const).filter((entry): entry is readonly [string, Gate] => Boolean(entry[1])).map(([id, gate]) => [id, publicGate(gate)]));
    return { stages, production: productionReady(gates, ids), ...(watchError ? { watchError } : {}) };
  }
  const guard = () => { if (closed) throw conflict('The controller is shutting down.'); };
  return {
    view,
    async watch() { await watch(); },
    /** Read only: a verified caller can display this source's watched head without advancing a gate. */
    watchedHead,
    /** A fresh copy lets release callers compare evidence again after asynchronous checks, before deployment. */
    releaseEvidence(sha: unknown): ReleaseEvidence | null {
      const current = active();
      if (!current?.repository || !current.branch || typeof sha !== 'string' || !SHA.test(sha)) return null;
      const head = state.heads[current.key];
      if (sha.toLowerCase() !== current.sha?.toLowerCase() || head?.branch === current.branch && head.sha.toLowerCase() !== sha.toLowerCase()) return null;
      const stages = sandboxes(current), gates = scoped(current), evidence: ReleaseEvidence['stages'] = [];
      if (!stages.length) return null;
      for (const stage of stages) {
        const gate = stageGate(gates.filter(gate => gate.stageId === stage.id));
        if (!gate || gate.sha !== sha.toLowerCase() || gate.status !== 'passed' && gate.status !== 'released' || gate.statusError || !sameStatus(commitStatus(gate), gate.posted)) return null;
        evidence.push({ id: stage.id, name: stage.name, gateId: gate.id, context: gate.context, status: gate.status, updatedAt: gate.updatedAt,
          ...(gate.releasedBy ? { releasedBy: gate.releasedBy, releasedAt: gate.releasedAt } : {}) });
      }
      return { key: current.key, repository: current.repository, branch: current.branch, sha: sha.toLowerCase(), stages: evidence };
    },
    /** Run now: the stage's gate at the branch head (or the scanned commit), re-running a finished one. */
    async run({ stageId }: { stageId: unknown }) {
      guard();
      let current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (!sandboxes(current).some(stage => stage.id === stageId)) throw new Error('Choose a Sandbox stage.');
      const identity = sourceIdentity(current);
      const sha = await manualCommit(current);
      current = active();
      const stage = current && sandboxes(current).find(item => item.id === stageId);
      if (!current || !stage || sourceIdentity(current) !== identity) throw conflict('The active source changed. Reload the pipeline.');
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('Scan a repository with a commit first.');
      enqueue(current, stage, sha.toLowerCase(), now());
      await persist();
      kick();
      return view();
    },
    /**
     * Release: a person accepts a gate that needs release; a failed gate is never released. A commit without a gate of
     * the target branch may be a repair's pull request head: its newest repair gate is released, which reports success
     * on that head and promotes nothing.
     */
    async release({ stageId, sha, login }: { stageId: unknown; sha: unknown; login?: unknown }) {
      guard();
      const current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (typeof login !== 'string' || !login) throw new Error('Connect GitHub to release.');
      const gate = scoped(current).find(item => item.stageId === stageId && item.sha === sha)
        ?? state.gates.find(item => item.repair && item.key === current.key && item.stageId === stageId && item.sha === sha);
      if (!gate) throw Object.assign(new Error('Gate not found.'), { statusCode: 404 });
      if (gate.status !== 'needs-release') throw conflict(gate.status === 'failed' ? 'A failed gate cannot be released.' : 'This gate does not need release.');
      const identity = sourceIdentity(current), build = await readBuild(current, gate);
      if (closed || sourceIdentity(active()) !== identity || gate.status !== 'needs-release') throw conflict('The gate changed. Reload the pipeline.');
      if (build.status !== 'passed') throw conflict(build.reason);
      Object.assign(gate, { status: 'released', releasedBy: login, releasedAt: now(), updatedAt: now() } satisfies Partial<Gate>);
      promote(gate);
      await persist();
      void sync();
      kick();
      return view();
    },
    /** The Sandbox stages a repair gate of this pipeline runs, in pipeline order; null when it is not the active pipeline. */
    repairStages(key: unknown): string[] | null {
      const current = active();
      return current && key === current.key ? sandboxes(current).map(stage => stage.id) : null;
    },
    /**
     * A repair's gates at its pull request head: each Sandbox stage of the active source, in pipeline order, is queued as
     * a repair gate over the snapshot, runs through the one-at-a-time queue after every waiting target-branch gate, and
     * reports its commit status on that head. It stops at the first gate that does not pass; without a Sandbox stage
     * there are none. A repair gate never promotes, never supersedes a target-branch gate or is superseded by one, and
     * never makes Production Ready. signal stops a queued gate at once as superseded ("The repair stopped."), while a
     * gate at work reaches its verdict first, so the snapshot is no longer read once this settles; the next stage's gate
     * then ends at once as superseded, so the gates of a stopped repair never read as all passed.
     */
    async runRepair(request: RepairGateRequest, signal?: AbortSignal): Promise<{ gates: RepairGateView[] }> {
      guard();
      const { key, repair, branch, sha, snapshot } = request, current = active();
      if (!current || key !== current.key) throw conflict(CHANGED);
      if (!isText(repair) || !repair || repair.length > 64) throw new Error('Name the repair.');
      if (!isText(branch) || !branch || branch.length > 255 || branch === current.branch) throw new Error('Name the repair branch.');
      if (!isText(sha) || !SHA.test(sha)) throw new Error('Choose the pull request head.');
      if (!isText(snapshot) || !isAbsolute(snapshot) || snapshot.includes('\0')) throw new Error('Choose the pull request checkout.');
      const judged: Gate[] = [];
      for (;;) {
        guard();
        const latest = active();
        if (!latest || latest.key !== key) throw conflict(CHANGED);
        // Stages are read again before each gate, in pipeline order.
        const stage = sandboxes(latest).find(item => !judged.some(gate => gate.stageId === item.id));
        if (!stage) break;
        // Once signal aborted, the next stage's gate ends at once and is never queued.
        const time = now(), stopped = Boolean(signal?.aborted);
        const gate: Gate = { id: randomUUID(), key, branch, stageId: stage.id, sha: sha.toLowerCase(), context: `perpetual/${stage.name}`, repair, snapshot, createdAt: time, status: stopped ? 'superseded' : 'queued', ...(stopped ? { reason: STOPPED, completedAt: time } : {}), detectedAt: time, updatedAt: time };
        state.gates.unshift(gate);
        prune();
        await persist();
        if (!stopped) { void kick(); await settled(gate, signal); }
        judged.push(gate);
        if (gate.status !== 'passed') break;
      }
      return { gates: judged.map(gate => ({ ...publicGate(gate), context: gate.context })) };
    },
    start() {
      if (closed || timer) return;
      timer = setInterval(() => { void watch().then(sync); }, pollInterval);
      timer.unref?.();
      void sync();
      kick();
    },
    /** Resolves once scheduled gates, reports and watches have settled. */
    async idle() { while (draining || syncing || watching) await Promise.allSettled([draining, syncing, watching]); await saves.idle(); },
    async close() {
      closed = true;
      clearInterval(timer); clearTimeout(retry);
      for (const waiter of [...waiters.values()].flat()) waiter.reject(conflict('The controller is shutting down.'));
      waiters.clear();
      await Promise.allSettled([draining, syncing, watching]);
      await saves.idle();
    },
  };
}
export type GateManager = Awaited<ReturnType<typeof createGateManager>>;
