import { pruneStageDrafts } from './case-drafts.ts';
import { previewTargets, type PreviewNode, type PreviewTarget } from './journey-config.ts';
import type { ApiError, ApiOptions, Controller } from './api.ts';
import type { BrowserCapabilities, BrowserCase, BrowserRun, JourneySpecs, RunProgress } from './browser-test-ui.ts';
import type { TestAccount } from './test-accounts.ts';
import type { PageVisibility } from './utils.ts';
import type { PipelineView } from './pipeline-nodes.ts';
import type { Environment, StageRemoval as PublicStageRemoval } from '../../../contract/environment.ts';
import type { BrowserConfig as PublicBrowserConfig, BrowserAnalysis, BrowserViewReply } from '../../../contract/browser.ts';
export type { BrowserPreparation, BrowserAnalysis } from '../../../contract/browser.ts';
import type { PipelineActionReply } from '../../../contract/pipeline.ts';
export type { Environment, EnvironmentHealth, EnvironmentService } from '../../../contract/environment.ts';

export type Resource = 'browser' | 'environment';
/** The pipeline edits this workspace offers; collapsing is applied locally while its save is queued. */
export type PipelineAction =
  | { action: 'add-stage'; afterStageId: string; name: string }
  | { action: 'rename-stage'; stageId: string; name: string }
  | { action: 'set-transition'; sourceStageId?: string; targetStageId?: string; blocked: boolean }
  | { action: 'toggle-stage'; stageId: string };
/** Unsaved/loading settings may not have received all normalized controller defaults yet. */
export type BrowserConfig = Pick<PublicBrowserConfig, 'targetUrl' | 'scope' | 'requirements' | 'maxSteps'> & Partial<Omit<PublicBrowserConfig, 'targetUrl' | 'scope' | 'requirements' | 'maxSteps'>>;
/** The workspace starts from source summaries before the inspector has loaded its full view. */
export type BrowserView = Pick<BrowserViewReply, 'cases' | 'preparation'> & {
  runs: BrowserRun[]; capabilities: BrowserCapabilities | null; config: BrowserConfig;
  specs?: JourneySpecs; analysis?: BrowserAnalysis | null; accounts?: TestAccount[]; callbacks?: BrowserViewReply['callbacks'];
};
/** A stage's sandboxes and its twin config, which this UI passes through to the controller unread. */
export interface EnvironmentView { environments: Environment[]; plan: unknown }
/** A confirmed stage removal and the sandbox cleanup it owns. */
export type StageRemoval = Pick<PublicStageRemoval, 'stageId'> & Partial<Omit<PublicStageRemoval, 'stageId' | 'status'>> & { status: string };
/** A source's pipeline, as far as draft pruning reads it. */
export interface PipelineStages { repoPath?: string; stages?: { id: string }[] }
/** The source summary GET /api/state returns, as far as the workspace reads it; an activation seed has the same fields. */
export interface SourceState {
  scan?: { repo?: { path?: string; branch?: string | null } | null; nodes?: (PreviewNode | null)[] } | null; pipeline?: PipelineView | null;
  browserTests?: Record<string, Partial<BrowserView>>; environments?: Environment[]; stageRemovals?: StageRemoval[];
}
/** The fields of a stage action's reply that update the stage's views. */
export interface ActionReply { environment?: Environment; run?: BrowserRun; cases?: BrowserCase[]; specs?: JourneySpecs; config?: BrowserConfig; plan?: unknown; [field: string]: unknown }
/** A stage's unsaved edits by key, such as its test configuration. */
export interface StageDrafts { config?: BrowserConfig; [key: string]: unknown }
export type StageView = {
  browser: BrowserView; environment: EnvironmentView; drafts: StageDrafts; dirty: Record<string, boolean>; loading: Record<Resource, boolean>;
  pending: string; error: string; pollErrors: Record<Resource, string>; pollError: string;
};
/** The source-scoped state every view subscribes to. */
export type WorkspaceSnapshot = { pipeline: PipelineView | null; browserTests: Record<string, BrowserView>; environments: Environment[]; stageRemovals: StageRemoval[]; busyStages: string[]; previews: PreviewTarget[]; branch: string; error: string };
/** A stage action's requests: post sends one; save also clears the draft it saved unless it was edited meanwhile. */
export interface StageTransaction {
  post(action: string, input?: Record<string, unknown>, options?: ApiOptions): Promise<ActionReply>;
  save(key: string, input?: Record<string, unknown>): Promise<ActionReply>;
}
export interface StageHandle {
  getSnapshot(): StageView;
  subscribe(listener: () => void): () => void;
  isCurrent(): boolean;
  observe(resources: Resource[]): () => void;
  refresh(resource: Resource): Promise<void>;
  edit<K extends string>(key: K, value: StageDrafts[K]): void;
  perform<T>(resource: Resource, name: string, work: (tx: StageTransaction) => Promise<T>): Promise<T>;
  createEnvironment(): Promise<ActionReply>;
  saveBrowserCase(item: BrowserCase, original?: BrowserCase): Promise<ActionReply>;
}
interface StageEntry {
  id: string; generation: number; listeners: Set<() => void>; observers: Record<Resource, number>; revisions: Record<Resource, number>; reading: Record<Resource, number>;
  draftRevisions: Record<string, number>; view: StageView; handle?: StageHandle;
  /** When the stage's action error and each resource's poll error appeared, by the workspace's error clock. */
  errorAt: Record<'action' | Resource, number>;
}
export type TestWorkspace = ReturnType<typeof createTestWorkspace>;

const CONFIG = { targetUrl: '', scope: '', requirements: '', maxSteps: 60 };
const browserView = (value?: Partial<BrowserView> | null): BrowserView => ({ cases: [], runs: [], capabilities: null, preparation: null, ...value, config: { ...CONFIG, ...value?.config } });
const environmentView = (value?: Partial<EnvironmentView> | null): EnvironmentView => ({ environments: [], plan: null, ...value });
const endpoint = (resource: Resource) => resource === 'browser' ? '/api/browser' : '/api/environments';
const sourceKey = (source: { path?: string; branch?: string | null } | null | undefined) => JSON.stringify([source?.path || '', source?.branch || '']);
const active = (entry: StageEntry) => entry.view.environment.environments.some(item => ['queued', 'creating', 'preparing', 'destroying'].includes(item.status))
  || ['preparing', 'discovering'].includes(entry.view.browser.preparation?.status ?? '')
  || entry.view.browser.runs.some(run => ['queued', 'running'].includes(run.status))
  || Object.values(entry.view.browser.specs || {}).some(spec => spec?.generation?.status === 'running' || spec?.draft?.verification?.status === 'running');
// Browser progress with an unchanged revision and case states is reused whole;
// scheduler states, frame times and recordings stay part of the key, since pruning a
// run's recordings leaves its revision unchanged.
const progressKey = (value: unknown) => {
  // share calls this only for the controller's progress field; old saved progress could also carry status.
  const progress = value as (RunProgress & { status?: string }) | null | undefined;
  return typeof progress?.revision === 'number' ? JSON.stringify([progress.revision, progress.status, (progress.cases || []).map(item => [item.id, item.status, item.queueReason, item.startedAt, item.completedAt, item.frameUpdatedAt, item.frameCapturedAt, item.actionCount, Array.isArray('actions' in item ? item.actions : undefined), item.videos])]) : null;
};
// Structural sharing: unchanged records keep their identity across polls.
// A record reused in place of next has next's fields and values, so it stands for next's type.
function share<T>(previous: unknown, next: T, key?: string): T {
  if (previous === next || !previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  if (key === 'progress' && progressKey(next) && progressKey(next) === progressKey(previous)) return previous as T;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = Object.keys(next), result = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  let changed = keys.length !== Object.keys(previous).length;
  for (const name of keys) { result[name] = share(before[name], after[name], name); if (result[name] !== before[name] || !Object.hasOwn(previous, name)) changed = true; }
  return (changed ? result : previous) as T;
}
const sameItems = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((item, index) => item === right[index]);
const sameEntries = (left: Record<string, unknown>, right: Record<string, unknown>) => sameItems(Object.keys(left), Object.keys(right)) && Object.keys(left).every(key => left[key] === right[key]);

// The workspace owns controller ordering and drafts. Views subscribe to the same
// source-scoped state; observing never starts discovery or test execution.
export function createTestWorkspace({ controller, pollInterval = 3000, document = globalThis.document, pruneDrafts = pruneStageDrafts }: { controller: Controller; pollInterval?: number; document?: PageVisibility | null; pruneDrafts?: (repoPath: string, stageIds: string[]) => void }) {
  let source: { path?: string; branch?: string | null } | null = null, identity = '', generation = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, summaryRevision = 0, sourceError = '', polling = false;
  let stageRemovals: StageRemoval[] = [], previews: PreviewTarget[] = [], foreignReplies = 0;
  // Errors are ordered by this clock. The page shows none from before the viewer last dismissed them.
  let errorClock = 0, sourceErrorAt = 0, dismissedAt = 0;
  let pipeline: PipelineView | null = null, confirmedPipeline: PipelineView | null = null, pipelineRevision = 0;
  let pipelineChanges: { input: PipelineAction }[] = [], pipelineQueue: Promise<unknown> = Promise.resolve();
  // The source pipeline's stage ids once known. A stage it no longer lists was deleted: its reads are not made and
  // their failures, such as a poll that raced the deletion, are not the page's errors.
  let listed: Set<string> | null = null;
  const gone = (entry: StageEntry) => listed !== null && !listed.has(entry.id);
  const entries = new Map<string, StageEntry>(), listeners = new Set<() => void>();
  let snapshot: WorkspaceSnapshot = { pipeline: null, browserTests: {}, environments: [], stageRemovals: [], busyStages: [], previews: [], branch: '', error: '' };
  const current = (entry: StageEntry) => !disposed && entry.generation === generation;
  // Drafts of stages the source's pipeline no longer lists are dropped; an unknown pipeline prunes nothing.
  function prunePipeline(pipeline: PipelineStages | null | undefined) {
    if (!source?.path || !Array.isArray(pipeline?.stages) || (pipeline.repoPath && pipeline.repoPath !== source.path)) return;
    listed = new Set(pipeline.stages.map(stage => stage?.id));
    pruneDrafts(source.path, [...listed]);
  }
  // The latest stage error since the last dismissal, so an older action's failure never hides a later failure or poll
  // error of any stage, and a dismissed one does not return when a later one clears.
  function latestError() {
    let error = '', at = dismissedAt;
    for (const value of entries.values()) if (!gone(value)) {
      const { view, errorAt } = value;
      for (const [text, time] of [[view.error, errorAt.action], [view.pollErrors.browser, errorAt.browser], [view.pollErrors.environment, errorAt.environment]] as const) if (text && time > at) { error = text; at = time; }
    }
    return error;
  }
  // A changed source error is a new one, so an earlier dismissal does not hide it.
  function setSourceError(message: string) {
    if (message && message !== sourceError) sourceErrorAt = ++errorClock;
    sourceError = message;
  }
  function publish(entry?: StageEntry) {
    if (disposed) return;
    const next: WorkspaceSnapshot = {
      pipeline,
      browserTests: Object.fromEntries([...entries].map(([id, value]) => [id, value.view.browser])),
      environments: [...entries.values()].flatMap(value => value.view.environment.environments),
      stageRemovals,
      busyStages: [...entries].filter(([, value]) => value.view.pending).map(([id]) => id),
      previews,
      branch: source?.branch || '',
      error: sourceError && sourceErrorAt > dismissedAt ? sourceError : latestError(),
    };
    if (sameEntries(next.browserTests, snapshot.browserTests)) next.browserTests = snapshot.browserTests;
    const keep = <K extends 'environments' | 'busyStages'>(key: K) => { if (sameItems(next[key], snapshot[key])) next[key] = snapshot[key]; };
    for (const key of ['environments', 'busyStages'] as const) keep(key);
    const fields: Record<string, unknown> = next, shown: Record<string, unknown> = snapshot;
    if (!Object.keys(next).every(key => fields[key] === shown[key])) snapshot = next;
    entry?.listeners.forEach(listener => listener());
    listeners.forEach(listener => listener());
  }
  function update(entry: StageEntry, patch: Partial<StageView>) {
    if (!current(entry)) return;
    const fields: Record<string, unknown> = patch, view: Record<string, unknown> = entry.view;
    for (const key of ['browser', 'environment', 'loading', 'pollErrors'] as const) if (patch[key]) fields[key] = share(entry.view[key], patch[key]);
    if (Object.keys(patch).every(key => view[key] === fields[key])) return;
    const before = entry.view;
    entry.view = { ...entry.view, ...patch };
    entry.view.pollError = entry.view.pollErrors.browser || entry.view.pollErrors.environment;
    if (entry.view.error && entry.view.error !== before.error) entry.errorAt.action = ++errorClock;
    for (const resource of ['browser', 'environment'] as const) {
      if (entry.view.pollErrors[resource] && entry.view.pollErrors[resource] !== before.pollErrors[resource]) entry.errorAt[resource] = ++errorClock;
    }
    publish(entry);
  }
  // Only saved definitions prune stage drafts. Pending preferences overlay that definition, in click order.
  function projectPipeline() {
    let next = confirmedPipeline;
    for (const { input } of pipelineChanges) if (input.action === 'toggle-stage' && next) {
      next = { ...next, stages: next.stages.map(stage => stage.id === input.stageId ? { ...stage, collapsed: !stage.collapsed } : stage) };
    }
    pipeline = share(pipeline, next);
  }
  function changePipeline(input: PipelineAction): Promise<PipelineActionReply> {
    const ownGeneration = generation, repoPath = source?.path;
    const isCurrent = () => !disposed && generation === ownGeneration;
    const assertSource = () => { if (!isCurrent()) throw Object.assign(new Error('The source changed. Reopen this stage.'), { name: 'AbortError' }); };
    if (disposed || !repoPath || !confirmedPipeline) return Promise.reject(new Error('Connect a repository first.'));
    const change = { input: { ...input } };
    pipelineChanges.push(change); pipelineRevision++; projectPipeline(); publish();
    const operation = pipelineQueue.then(async () => {
      assertSource();
      try {
        const result = await controller('/api/pipeline/action', { ...change.input, repoPath }) as PipelineActionReply;
        assertSource();
        if (result.pipeline.repoPath !== repoPath) throw new Error('The saved pipeline belongs to another repository.');
        confirmedPipeline = result.pipeline;
        prunePipeline(confirmedPipeline);
        return result;
      } catch (failure) { assertSource(); throw failure; }
      finally {
        if (isCurrent()) {
          pipelineChanges = pipelineChanges.filter(item => item !== change);
          pipelineRevision++; projectPipeline(); publish();
        }
      }
    });
    // A rejected save is still reported to its caller; it does not discard later clicks.
    pipelineQueue = operation.catch(() => {});
    return operation;
  }
  function ensure(id: string): StageEntry {
    if (!entries.has(id)) entries.set(id, {
      id, generation, listeners: new Set(), observers: { browser: 0, environment: 0 }, revisions: { browser: 0, environment: 0 }, reading: { browser: 0, environment: 0 }, draftRevisions: {}, errorAt: { action: 0, browser: 0, environment: 0 },
      view: { browser: browserView(), environment: environmentView(), drafts: {}, dirty: {}, loading: { browser: true, environment: true }, pending: '', error: '', pollErrors: { browser: '', environment: '' }, pollError: '' },
    });
    return entries.get(id)!;
  }
  function assertCurrent(entry: StageEntry) {
    if (!current(entry)) throw new Error('The source changed. Reopen this stage.');
  }
  function accept(entry: StageEntry, resource: Resource, value: Partial<BrowserView & EnvironmentView>) {
    update(entry, { [resource]: resource === 'browser' ? browserView(value) : environmentView(value), loading: { ...entry.view.loading, [resource]: false }, pollErrors: { ...entry.view.pollErrors, [resource]: '' } });
  }
  async function refresh(entry: StageEntry, resource: Resource, force = false) {
    if (!current(entry) || gone(entry) || (entry.view.pending && !force)) return;
    const revision = ++entry.revisions[resource];
    entry.reading[resource]++;
    try {
      const value = await controller(`${endpoint(resource)}?${new URLSearchParams({ repoPath: String(source!.path), stageId: entry.id })}`) as Partial<BrowserView & EnvironmentView>;
      if (current(entry) && revision === entry.revisions[resource]) {
        entry.revisions[resource]++;
        accept(entry, resource, value);
      }
    } catch (failure) {
      if (current(entry) && !gone(entry) && revision === entry.revisions[resource]) update(entry, { pollErrors: { ...entry.view.pollErrors, [resource]: (failure as Error).message }, loading: { ...entry.view.loading, [resource]: false } });
    } finally { entry.reading[resource]--; }
  }
  // T is the full /api/state reply a caller reads beyond the fields the workspace reads.
  async function refreshSource<T extends SourceState = SourceState>(): Promise<T | undefined> {
    if (disposed || !source?.path) return;
    const ownGeneration = generation, request = ++summaryRevision, graphRevision = pipelineRevision, graphIdle = pipelineChanges.length === 0;
    const revisions = new Map([...entries].map(([id, entry]) => [id, { ...entry.revisions }]));
    try {
      const next = await controller('/api/state') as T;
      if (disposed || ownGeneration !== generation || request !== summaryRevision) return;
      // Another window can change the controller's source. One reply may race this window's own change, so a second
      // in a row that names another source says so instead of leaving the graph silently frozen.
      if (sourceKey(next.scan?.repo) !== identity) {
        if (++foreignReplies > 1) { setSourceError('The source changed. Reload the pipeline.'); publish(); }
        return;
      }
      foreignReplies = 0;
      sourceError = '';
      stageRemovals = share(stageRemovals, next.stageRemovals || []);
      previews = share(previews, previewTargets(next.scan));
      if (graphIdle && !pipelineChanges.length && graphRevision === pipelineRevision && next.pipeline?.repoPath === source?.path) {
        confirmedPipeline = next.pipeline;
        projectPipeline();
        prunePipeline(confirmedPipeline);
      }
      const ids = new Set([...entries.keys(), ...Object.keys(next.browserTests || {}), ...(next.environments || []).map(item => item.stageId).filter(Boolean)]);
      for (const id of ids) {
        const entry = ensure(id);
        if (entry.view.pending) continue;
        const patch: Partial<StageView> = {};
        if (!entry.reading.browser && entry.revisions.browser === (revisions.get(id)?.browser || 0)) patch.browser = browserView({ ...entry.view.browser, ...(next.browserTests?.[id] || { cases: [], runs: [], preparation: null }) });
        if (!entry.reading.environment && entry.revisions.environment === (revisions.get(id)?.environment || 0)) patch.environment = { ...entry.view.environment, environments: (next.environments || []).filter(item => item.stageId === id) };
        update(entry, patch);
      }
      publish();
      return next;
    } catch (failure) {
      if (!disposed && ownGeneration === generation && request === summaryRevision) { setSourceError((failure as Error).message); publish(); }
    }
  }
  // Polling pauses while the page is hidden and resumes as soon as it is visible.
  async function poll() {
    if (disposed || polling || document?.hidden) return;
    polling = true;
    try {
      await Promise.all([
        ...(listeners.size ? [refreshSource()] : []),
        ...[...entries.values()].flatMap(entry => (['browser', 'environment'] as const).filter(resource => entry.observers[resource] || active(entry)).map(resource => refresh(entry, resource))),
      ]);
    } finally { polling = false; }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || !pollInterval || document?.hidden) return;
    timer = setTimeout(poll, [...entries.values()].some(active) ? Math.min(pollInterval, 750) : pollInterval);
  }
  const visibility = () => { if (!document?.hidden && pollInterval) { clearTimeout(timer); void poll(); } };
  document?.addEventListener?.('visibilitychange', visibility);
  function stage(id: string): StageHandle {
    const entry = ensure(id);
    if (entry.handle) return entry.handle;
    async function perform<T>(resource: Resource, name: string, work: (tx: StageTransaction) => Promise<T>): Promise<T> {
      assertCurrent(entry);
      if (entry.view.pending) throw new Error('Wait for the current action.');
      entry.revisions.browser++; entry.revisions.environment++;
      update(entry, { pending: name, error: '' });
      const post = async (action: string, input: Record<string, unknown> = {}, options: ApiOptions = {}) => {
        assertCurrent(entry);
        const result = await controller(`${endpoint(resource)}/${action}`, { ...input, repoPath: source!.path, stageId: id }, options) as ActionReply;
        assertCurrent(entry);
        const environment = result.environment;
        if (environment) {
          const environments = entry.view.environment.environments.filter(item => item.id !== environment.id);
          accept(entry, 'environment', { ...entry.view.environment, environments: [...environments, environment] });
        }
        const run = result.run, view: Partial<BrowserView & EnvironmentView> = entry.view[resource];
        if (run) accept(entry, resource, { ...entry.view[resource], runs: [run, ...view.runs!.filter(item => item.id !== run.id)] });
        if (result.cases) accept(entry, resource, { ...entry.view[resource], cases: result.cases });
        if (result.specs) accept(entry, resource, { ...entry.view[resource], specs: result.specs });
        if (result.config) accept(entry, resource, { ...entry.view[resource], config: result.config });
        if (result.plan) accept(entry, resource, { ...entry.view[resource], plan: result.plan });
        return result;
      };
      const save = async (key: string, input?: Record<string, unknown>) => {
        const revision = entry.draftRevisions[key] || 0;
        const result = await post(key, input);
        if (revision === (entry.draftRevisions[key] || 0)) {
          const drafts = { ...entry.view.drafts }, dirty = { ...entry.view.dirty };
          delete drafts[key]; delete dirty[key]; update(entry, { drafts, dirty });
        }
        return result;
      };
      try {
        const result = await work({ post, save });
        assertCurrent(entry);
        await refresh(entry, resource, true);
        return result;
      } catch (failure) {
        const error = failure as ApiError;
        // A stale case list conflicts in a case save, and in the case writes a one-off run or a replacing Generate makes.
        if (resource === 'browser' && error.statusCode === 409) await refresh(entry, resource, true);
        if (error.name !== 'AbortError') update(entry, { error: error.message });
        throw failure;
      } finally { update(entry, { pending: '' }); }
    }
    entry.handle = {
      getSnapshot: () => entry.view,
      subscribe(listener) { entry.listeners.add(listener); return () => entry.listeners.delete(listener); },
      isCurrent: () => current(entry),
      observe(resources) {
        assertCurrent(entry);
        // Summaries carry no configuration, accounts or capabilities, so a view no one observed may be out of date:
        // it reads as loading until the read its first observer starts returns.
        const first = resources.filter(resource => ++entry.observers[resource] === 1);
        if (first.some(resource => !entry.view.loading[resource])) update(entry, { loading: { ...entry.view.loading, ...Object.fromEntries(first.map(resource => [resource, true])) } });
        for (const resource of first) void refresh(entry, resource);
        let stopped = false;
        return () => { if (!stopped) for (const resource of resources) entry.observers[resource]--; stopped = true; };
      },
      refresh: resource => refresh(entry, resource),
      edit(key, value) {
        assertCurrent(entry); entry.draftRevisions[key] = (entry.draftRevisions[key] || 0) + 1;
        update(entry, { drafts: { ...entry.view.drafts, [key]: value }, dirty: { ...entry.view.dirty, [key]: true } });
      },
      perform,
      createEnvironment() {
        return perform('environment', 'create', tx => tx.post('create'));
      },
      saveBrowserCase(item, original) {
        return perform('browser', 'cases', tx => {
          const cases = entry.view.browser.cases;
          const baseCases = original ? cases.map(value => value.id === original.id ? original : value) : cases;
          if (original && !cases.some(value => value.id === original.id)) baseCases.push(original);
          return tx.post('cases', { cases: cases.some(value => value.id === item.id) ? cases.map(value => value.id === item.id ? item : value) : [...cases, item], baseCases });
        });
      },
    };
    return entry.handle;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    stage,
    refreshSource,
    changePipeline,
    /** Hides the page's errors so far; a later failure, or one that recurs after it cleared, shows again. */
    dismissError() { dismissedAt = errorClock; publish(); },
    activate(nextSource: { path?: string; branch?: string | null } | null | undefined, seed: SourceState = {}) {
      if (disposed) throw new Error('The test workspace is closed.');
      const nextIdentity = sourceKey(nextSource);
      generation++; identity = nextIdentity; source = { ...nextSource }; sourceError = ''; foreignReplies = 0; listed = null;
      pipelineChanges = []; pipelineQueue = Promise.resolve(); pipelineRevision++;
      confirmedPipeline = seed.pipeline && seed.pipeline.repoPath === source.path ? seed.pipeline : null;
      projectPipeline();
      stageRemovals = seed.stageRemovals || [];
      previews = share(previews, previewTargets(seed.scan));
      prunePipeline(seed.pipeline);
      const previous = [...entries.values()]; entries.clear();
      for (const [id, value] of Object.entries(seed.browserTests || {})) ensure(id).view.browser = browserView(value);
      for (const item of seed.environments || []) if (item.stageId) ensure(item.stageId).view.environment.environments.push(item);
      publish(); previous.forEach(entry => entry.listeners.forEach(listener => listener())); schedule();
      if (!Object.hasOwn(seed, 'browserTests')) void refreshSource();
    },
    dispose() { disposed = true; generation++; clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); listeners.clear(); entries.forEach(entry => entry.listeners.clear()); },
  };
}
