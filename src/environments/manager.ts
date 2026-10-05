import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectEnvironmentConfig } from './plans.ts';
import { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } from './runtime.ts';
import { AUTHORING, isGenerationFailure, type AttemptOutcome } from './generation.ts';
import { redact } from '../redaction.ts';
import { diagnosticText, retainDiagnostics } from './diagnostics.ts';
import { IN_PROGRESS, applicationOrigin, createEnvironmentUsage, holdsResources, scopeId } from './usage.ts';
import { serviceOptionErrors, validateTwinConfig } from '../twin/index.ts';
import { HOST } from '../twin/compose.ts';
import { createBrowserModelSettings } from '../browser/model.ts';
import { isOpenRouterEndpoint } from '../browser/openrouter-models.ts';
import type { DetectionScan } from './plans.ts';
import type { GenerationDraft, PlanProvenance } from './generation.ts';
import type { AuthoringModel, GeneratedPlan, TwinGeneration } from './runtime.ts';
import type { EnvironmentUsage, StageRef } from './usage.ts';
import type { TwinConfig } from '../twin/config.ts';
import type { DetectedConfig } from '../twin/detect.ts';
import type { Fidelity } from '../twin/registry.ts';
import type { Environment as EnvironmentReply, EnvironmentAccount, EnvironmentHealth as HealthBeat, EnvironmentLogs, StepTiming } from '../../contract/environment.ts';
export type { EnvironmentAccount, StepTiming } from '../../contract/environment.ts';

export type EnvironmentStatus = 'queued' | 'creating' | 'preparing' | 'ready' | 'failed' | 'cleanup_failed' | 'destroying' | 'destroyed';
/** A twin service as its environment shows it. */
export interface EnvironmentService { id: string; title: string; fidelity: Fidelity; status: 'ready' | 'blocked'; missing: string[] }
/** A running app: its browser URL and, for a twin, its directory in the repository. */
export interface EnvironmentApp { id: string; url: string; directory?: string }
/** A twin test account without its password, which only the twin's private state keeps. */
/** A saved twin config: a person's, or one an agent wrote, which carries its provenance. */
export type SavedPlan = TwinConfig & { provenance?: PlanProvenance };
/** A stage's twin plan: detected from the repository, or saved. */
export type EnvironmentPlan = DetectedConfig | SavedPlan;
/** One environment as the controller keeps it; `plan` is the validated config it was created from. */
export interface EnvironmentRecord extends EnvironmentReply {
  id: string; scope: string; pipelineKey: string; stageId: string; repoPath: string; sourceBranch: string | null; sourceRevision: string | null;
  plan?: TwinConfig; status: EnvironmentStatus; step: string; services: EnvironmentService[]; apps: EnvironmentApp[]; createdAt: string; updatedAt?: string;
  error?: string | null; sandboxId?: string; snapshot?: { hash: string; files: number; bytes: number }; timings?: StepTiming[]; readyAt?: string;
  accounts?: EnvironmentAccount[]; origins?: string[]; logs?: string; logsAt?: string; cleanedAt?: string; cleanupError?: string; destroyedAt?: string; browserPreparationError?: string;
  /** Set while its preparation reads the checkout it was created from, as generating a twin config does. */
  readsCheckout?: true;
  /** Each failed attempt of the twin config's generation, in order. */
  attempts?: AttemptOutcome[];
  /** A successful generation's log: every attempt's output and each failed attempt's feedback, redacted. */
  authoringLogs?: string;
  /** The repair whose journey gate built this twin from its pull request checkout, which repoPath names. */
  repair?: string;
}
export type PublicEnvironment = EnvironmentReply & Omit<EnvironmentRecord, 'scope' | 'plan' | 'logs' | 'logsAt' | 'origins' | 'authoringLogs'>;
/** The monitor's last check, kept in memory only: when it ran, whether it passed and its consecutive failures, or when a due check was skipped as in use. */
export type { EnvironmentHealth as HealthBeat } from '../../contract/environment.ts';
/** An environment as stage views list it. */
export type EnvironmentSummary = PublicEnvironment & { health?: HealthBeat };
/**
 * The stage an environment operation is for, with the scan its plan is detected from; a repair gate's names its repair,
 * and its scan is of the pull request checkout, whose detection the stage never keeps.
 */
export type EnvironmentContext = StageRef & { scan: DetectionScan & { repo: { branch?: string | null; sha?: string | null }; scannedAt?: string }; controllerOrigin?: string; repair?: string };
type RuntimeCall = { dataDir: string; environment: EnvironmentRecord };
/** What the manager calls on its runtime (./runtime.ts): a ready result is merged into its environment as it is, but
 * for `generated`, the provenance of a config an agent wrote, which becomes the stage's plan. */
export interface ManagedRuntime {
  prepareEnvironment(options: RuntimeCall & { repoPath: string; directory: string; cancelled: () => boolean; signal?: AbortSignal; onUpdate: (update: Partial<EnvironmentRecord>) => Promise<void>; onDraft?: (draft: GenerationDraft) => Promise<void>; generate?: TwinGeneration; generated?: GeneratedPlan; selectionReviewed?: boolean }): Promise<Partial<EnvironmentRecord> & { generated?: PlanProvenance }>;
  environmentHealth(options: RuntimeCall): Promise<{ status: string; error?: string; final?: boolean }>;
  environmentLogs(options: RuntimeCall): Promise<string>;
  destroySandbox(options: RuntimeCall): Promise<unknown>;
}
/** Saved state may hold keys of removed features, and a Cua guest's services had URLs. */
type SavedEnvironment = Omit<EnvironmentRecord, 'services'> & {
  services: (EnvironmentService & { url?: string })[]; twinsToken?: unknown; activeOperation?: unknown; desktopUrl?: unknown; serviceOrigins?: string[];
};

const now = () => new Date().toISOString();
const FAILURE_TEXT = 1500, FAILURE_HEAD = 300, OMITTED = '\n…\n';
// A long failure keeps its start, which names the step, and its end, where a command reports its error.
const failure = (error: unknown) => {
  const text = redact(String((error as Error).message || error));
  return text.length <= FAILURE_TEXT ? text : `${text.slice(0, FAILURE_HEAD)}${OMITTED}${text.slice(-(FAILURE_TEXT - FAILURE_HEAD - OMITTED.length))}`;
};
function publicEnvironment({ scope, plan, logs, logsAt, origins, authoringLogs, ...item }: EnvironmentRecord): PublicEnvironment {
  // Older twins saved their container address as the app link. Convert only the owned twin's public view.
  if (item.sandboxId !== item.id) return item;
  return { ...item, apps: item.apps.map(app => {
    try {
      const url = new URL(app.url);
      if (url.protocol !== 'http:' || url.hostname !== HOST || url.username || url.password) return app;
      url.hostname = '127.0.0.1';
      return { ...app, url: url.href };
    } catch { return app; }
  }) };
}
/** A failure's own logs, such as a generation's author output (GenerationFailure's logs), redacted; '' without any. */
const errorLogs = (error: unknown) => error instanceof Error && 'logs' in error && typeof error.logs === 'string' ? redact(error.logs) : '';
/** Whether a failure says an owned process may remain (WorkerError's cleanupIncomplete). */
const cleanupIncomplete = (error: unknown) => error instanceof Error && 'cleanupIncomplete' in error && error.cleanupIncomplete === true;
const UNCONFIRMED = 'Owned processes could not be confirmed stopped.';
// A twin's test accounts as environments keep and show them; passwords stay in the twin's private state.
const publicAccounts = (accounts: EnvironmentAccount[] | undefined) => (Array.isArray(accounts) ? accounts : []).map(({ id, label, username }) => ({ id, label, username }));
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const UUID = /^[a-f0-9-]{36}$/;
const HEALTH_FAILURES = 3;
const defaultRuntime: ManagedRuntime = { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
const canRecoverHealth = (environment: EnvironmentRecord) => environment.status === 'failed' && environment.step === 'Unhealthy'
  && environment.sandboxId && environment.plan && !environment.cleanedAt;
// A plan saved before twins listed services with install and start commands; a fresh detection replaces it.
const legacyPlan = (plan: { services?: unknown } | null | undefined) => Array.isArray(plan?.services);
/** Whether a stored plan is a config an agent wrote. */
const isGenerated = (plan: EnvironmentPlan | undefined): plan is SavedPlan & { provenance: PlanProvenance } => plan !== undefined && 'provenance' in plan && plan.provenance !== undefined;
/** A stored plan's twin config, without the provenance a generated one carries. */
function configOf(plan: EnvironmentPlan): DetectedConfig | TwinConfig {
  if (!('provenance' in plan)) return plan;
  const { provenance, ...config } = plan;
  return config;
}
/** Saved drafts are the controller's own; one of any other shape is left out. */
const savedDraft = (value: unknown): value is GenerationDraft => value !== null && typeof value === 'object'
  && typeof (value as Partial<GenerationDraft>).text === 'string' && typeof (value as Partial<GenerationDraft>).feedback === 'string';
/** The App Settings model when it is an OpenRouter one, which the twin config author runs on; null without one. */
async function appSettingsModel(dataDir: string): Promise<AuthoringModel | null> {
  const settings = await createBrowserModelSettings({ dataDir }), configuration = settings.configuration();
  return configuration.modelConfigured && isOpenRouterEndpoint(configuration.baseUrl)
    ? { apiKey: configuration.apiKey, model: configuration.model, escalationModel: settings.escalationModel() ?? undefined } : null;
}
// Saved state may hold keys of removed features: top-level cases, analyses, runs and
// schedules, and environment twinsToken, activeOperation and desktopUrl. Loading drops them.
// A twin's sandbox id is its environment's id. Any other sandbox is a Cua guest from
// before twins, which only awaits deletion.
function loadedEnvironment({ twinsToken, activeOperation, desktopUrl, serviceOrigins, ...environment }: SavedEnvironment): EnvironmentRecord {
  environment.origins ??= serviceOrigins ?? (environment.services || []).map(service => applicationOrigin(service.url)).filter(origin => origin !== null);
  if (legacyPlan(environment.plan)) delete environment.plan;
  if (!environment.sandboxId || environment.sandboxId === environment.id) return environment;
  environment.services = [];
  if (['ready', 'failed'].includes(environment.status) && !environment.cleanedAt) Object.assign(environment, { status: 'failed', step: 'Retired', error: 'Delete this environment to remove its Cua guest.' });
  return environment;
}

/**
 * Context is the caller's stage context, which the manager hands back to onReady as it was given. authoringModel is
 * the model that writes a detected stage's twin config when a person creates its environment; null leaves the detected
 * plan as it is.
 */
export async function createEnvironmentManager<Context extends EnvironmentContext = EnvironmentContext>({ dataDir, onReady, usage = createEnvironmentUsage(), runtime = defaultRuntime, interruptedEnvironmentIds = [], authoringModel = () => appSettingsModel(dataDir) }: {
  dataDir: string; onReady?: (context: Context, environment: PublicEnvironment) => unknown; usage?: EnvironmentUsage;
  runtime?: ManagedRuntime; interruptedEnvironmentIds?: string[]; authoringModel?: () => Promise<AuthoringModel | null>;
}) {
  // Resolved to its real path, so system aliases such as /tmp and /var never reach owned snapshot
  // destinations; snapshotSource still rejects an explicitly linked destination.
  const root = await privateDirectory(resolve(dataDir, 'environments'), 'Environment storage must not be a symbolic link.');
  const file = join(root, 'state.json');
  // detected: the scan each detected plan came from. A plan detected from an earlier scan is detected again, so a
  // repository change or a better detector reaches it; a saved plan, a person's or a generated one, is never detected again.
  // drafts: the last twin.json of a detected stage whose generation failed, or a generated config that failed to build
  // since, and why: its next generation starts from it.
  let state: { version: 1; plans: Record<string, EnvironmentPlan>; detected: Record<string, string>; drafts: Record<string, GenerationDraft>; environments: EnvironmentRecord[] } = { version: 1, plans: {}, detected: {}, drafts: {}, environments: [] };
  const saved = await readStateFile(file, { limit: 32 * 1024 * 1024, invalid: 'Invalid environment state.' });
  if (saved !== undefined) {
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 || !('environments' in saved) || !Array.isArray(saved.environments)
      || !('plans' in saved) || !saved.plans || typeof saved.plans !== 'object') throw new Error('Unsupported environment state.');
    const plans = Object.fromEntries(Object.entries(saved.plans as Record<string, EnvironmentPlan>).filter(([, plan]) => !legacyPlan(plan)));
    const detected = 'detected' in saved && saved.detected && typeof saved.detected === 'object' && !Array.isArray(saved.detected) ? Object.fromEntries(Object.entries(saved.detected).filter(([scope, key]) => Object.hasOwn(plans, scope) && typeof key === 'string')) as Record<string, string> : {};
    // A draft belongs to a detected stage, or to a generated config that failed since.
    const drafts = 'drafts' in saved && saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? Object.fromEntries(Object.entries(saved.drafts).filter((entry): entry is [string, GenerationDraft] => (Object.hasOwn(detected, entry[0]) || isGenerated(plans[entry[0]])) && savedDraft(entry[1]))) : {};
    // Records the controller saved; loadedEnvironment drops the fields of removed features.
    state = { version: 1, plans, detected, drafts, environments: (saved.environments as SavedEnvironment[]).map(loadedEnvironment) };
  }
  const saves = createSaveQueue();
  let closed = false, closing: Promise<void> | undefined, ticking = false;
  // admitted: creates per pipeline key between their admission and their environment's record.
  const admitted = new Map<string, number>();
  const creations = new Map<string, AbortController>();
  const jobs = new Map<string, Promise<void>>(), pending = new Set<Promise<unknown>>(), scopesBusy = new Set<string>(), healthChecks = new Map<string, number>(), healthFailures = new Map<string, number>(), healthResults = new Map<string, { at: number; ok: boolean }>(), healthSkips = new Map<string, number>();
  // The monitor heartbeat is in-memory observation only; it is never persisted.
  const iso = (time: number) => new Date(time).toISOString();
  function withHealth(item: EnvironmentRecord): EnvironmentSummary {
    const value = publicEnvironment(item), checked = healthResults.get(item.id), skipped = healthSkips.get(item.id);
    if (!checked && !skipped) return value;
    return { ...value, health: { ...(checked ? { checkedAt: iso(checked.at), ok: checked.ok, consecutiveFailures: healthFailures.get(item.id) || 0 } : {}), ...(skipped ? { skippedInUseAt: iso(skipped) } : {}) } };
  }
  // A skip is recorded when none is, the environment's first due check included, or the last one is older than the last check.
  function skipHealth(id: string) { const last = healthSkips.get(id); if (last === undefined || last < (healthChecks.get(id) || 0)) healthSkips.set(id, Date.now()); }
  const serialized = () => JSON.stringify(state);
  function budget() { if (Buffer.byteLength(serialized()) > 30 * 1024 * 1024) throw new Error('Local metadata storage is full. Export your history and choose a new data directory.'); }
  function persist() { return saves.run(async () => { retainDiagnostics(state.environments); budget(); await writeStateFile(file, serialized()); }); }
  function quarantine(environment: EnvironmentRecord | undefined, error: string, step = 'Interrupted operation') {
    if (!environment?.sandboxId || environment.status === 'destroyed' || environment.cleanedAt) return;
    Object.assign(environment, { status: 'cleanup_failed', step, updatedAt: now(), error });
  }
  const interrupted = new Set(interruptedEnvironmentIds);
  for (const item of state.environments) {
    if (IN_PROGRESS.includes(item.status)) Object.assign(item, { status: item.sandboxId ? 'cleanup_failed' : 'failed', step: 'Interrupted', updatedAt: now(), error: 'The controller stopped during this operation. Delete the remaining sandbox before retrying.' });
  }
  // Controller death does not stop application work that an interrupted browser
  // run started. Keep ownership, and require cleanup before accepting reuse.
  for (const environment of state.environments) if (interrupted.has(environment.id)) {
    quarantine(environment, 'The controller stopped while using this environment. Guest work may still be running. Delete the sandbox before retrying.');
  }
  await persist();

  // A twin's apps run from its source snapshot, so the snapshot stays until the twin is gone.
  // The environment's directory goes with it unless a twin that failed cleanup is still there.
  async function removeSnapshot(environment: EnvironmentRecord) {
    if (!UUID.test(environment.id)) throw new Error('Invalid environment storage ID.');
    const directory = join(root, environment.id);
    await rm(join(directory, 'source'), { recursive: true, force: true });
    await rm(join(directory, AUTHORING), { recursive: true, force: true });
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error; });
  }
  function setPlan(scope: string, value: EnvironmentPlan) {
    const previous = state.plans[scope];
    state.plans[scope] = value;
    try { budget(); } catch (error) { if (previous === undefined) delete state.plans[scope]; else state.plans[scope] = previous; throw error; }
  }
  // A config an agent wrote becomes the stage's plan, and a failed one its draft, only while no person saved one meanwhile:
  // the stage's plan is still detected, or still one an agent wrote.
  function keepGenerated(scope: string, { plan, provenance, draft }: { plan?: TwinConfig; provenance?: PlanProvenance; draft?: GenerationDraft }) {
    if (!Object.hasOwn(state.detected, scope) && !isGenerated(state.plans[scope])) return;
    if (plan && provenance) {
      setPlan(scope, { ...plan, provenance });
      delete state.detected[scope];
      delete state.drafts[scope];
    } else if (draft) {
      const previous = state.drafts[scope];
      state.drafts[scope] = draft;
      try { budget(); } catch (error) { if (previous === undefined) delete state.drafts[scope]; else state.drafts[scope] = previous; throw error; }
    }
  }

  const scanKey = (scan: EnvironmentContext['scan'] | undefined) => JSON.stringify([scan?.repo?.sha || '', scan?.scannedAt || '']);
  async function planFor(context: Context) {
    const scope = scopeId(context), key = scanKey(context.scan);
    if (!state.plans[scope] || Object.hasOwn(state.detected, scope) && state.detected[scope] !== key) {
      const detected = await detectEnvironmentConfig(context.scan);
      // A plan a person saved, or an agent wrote, while detection ran is kept.
      if (!state.plans[scope] || Object.hasOwn(state.detected, scope)) {
        setPlan(scope, detected);
        state.detected[scope] = key;
        await persist();
      }
    }
    return state.plans[scope];
  }
  // A repair gate builds at a pull request head that may never merge: the stage's saved config, a person's or a generated
  // one, which is never detected again on any branch, else the plan detected from the pull request's checkout, as the
  // target branch's gate would detect it once the pull request merged. That plan is held in memory only.
  async function repairPlan(context: Context): Promise<EnvironmentPlan> {
    const scope = scopeId(context), saved = state.plans[scope];
    return saved && !Object.hasOwn(state.detected, scope) ? saved : detectEnvironmentConfig(context.scan);
  }
  function findEnvironment(context: StageRef, id: string, { idle = false } = {}) {
    const environment = state.environments.find(item => item.id === id && item.scope === scopeId(context));
    if (!environment) throw new Error('Environment not found in this stage.');
    if (idle && jobs.has(id)) throw conflict('This environment has an operation in progress.');
    return environment;
  }
  function track<T>(task: Promise<T>) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function enqueue(id: string, work: (release: () => void) => Promise<void>, { release = () => {}, onSettled }: { release?: () => void; onSettled?: () => Promise<void> } = {}) {
    if (jobs.has(id)) throw conflict('This environment has an operation in progress.');
    let released = false;
    // A job may release the environment before it finishes; never release a later job's reservation.
    const releaseJob = () => {
      if (released) return;
      released = true;
      if (jobs.get(id) === task) jobs.delete(id);
      release();
    };
    const task = Promise.resolve().then(() => work(releaseJob)).catch(error => {
      process.stderr.write(`Environment operation: ${failure(error)}\n`);
    }).finally(releaseJob);
    jobs.set(id, task);
    // Readiness hands ownership to browser discovery only after the allocation
    // lease is released. Still join that follow-up when the controller closes.
    track(task.then(async () => { if (!closed && onSettled) await onSettled(); }));
  }
  const manager = {
    summaries(key: string) { return state.environments.filter(item => item.pipelineKey === key).map(withHealth); },
    /** Whether a create for the pipeline was admitted and has yet to record its environment. */
    admitting: (key: string) => (admitted.get(key) ?? 0) > 0,
    resolveTarget(url: unknown) {
      const origin = applicationOrigin(url);
      if (!origin) return null;
      // A deleted twin keeps its origins, but a twin that still holds resources owns them, as when it reuses freed ports.
      const at = (item: EnvironmentRecord) => (item.origins || []).includes(origin);
      const environment = state.environments.find(item => holdsResources(item) && at(item)) ?? state.environments.find(at);
      return environment ? structuredClone(publicEnvironment(environment)) : null;
    },
    markUsageUncertain(id: string, error: unknown) {
      const environment = state.environments.find(item => item.id === id);
      if (!environment) return Promise.reject(new Error('Environment not found.'));
      quarantine(environment, `Environment use did not confirm completion. Delete the sandbox before retrying. ${failure(error)}`, 'Uncertain environment operation');
      // This settles already admitted work, including browser cleanup during
      // shutdown. A failed save must leave the in-memory quarantine in place.
      return track(persist());
    },
    async awaitIdle(id: string) {
      while (jobs.has(id)) await jobs.get(id);
      const environment = state.environments.find(item => item.id === id);
      if (!environment) throw new Error('Environment not found.');
      return structuredClone(publicEnvironment(environment));
    },
    async view(context: Context) {
      const scope = scopeId(context), plan = await planFor(context);
      return { environments: state.environments.filter(item => item.scope === scope).map(withHealth), plan };
    },
    async savePlan(context: Context, plan: unknown) {
      // A config its services refuse is not saved: the twin would never build it.
      const config = validateTwinConfig(plan), errors = serviceOptionErrors(config);
      if (errors.length) throw new Error(errors.join('\n'));
      setPlan(scopeId(context), config);
      delete state.detected[scopeId(context)];
      delete state.drafts[scopeId(context)];
      await persist();
      return { plan: config };
    },
    /**
     * Creates the stage's environment from its plan. With `generate`, a person's request, a stage whose plan is still
     * detected has its twin config written by an agent first, when authoringModel gives a model; so does a stage whose
     * generated config failed to build since, starting from that config and its failure. A gate never generates: it
     * builds the saved config, and when a generated one fails, its failure becomes the stage's draft. A repair gate's
     * creation (context.repair) builds repairPlan and writes no plan, draft or provenance to the stage, whatever its twin
     * does, so a person's pending draft stays. A stage has one twin: its earlier twins that still hold resources are deleted
     * first, as a gate's rebuild does, and one that cannot be deleted stops the creation with its cleanup error.
     */
    async create(context: Context, { generate = false }: { generate?: boolean } = {}) {
      context = structuredClone(context);
      // Only a creation for the stage's own source owns its plan and draft.
      const scope = scopeId(context), owns = context.repair === undefined;
      if (scopesBusy.has(scope) || state.environments.some(item => item.scope === scope && IN_PROGRESS.includes(item.status))) throw conflict('This stage already has an environment operation in progress.');
      const previous = state.environments.filter(item => item.scope === scope && holdsResources(item));
      if (state.environments.filter(item => holdsResources(item) && !previous.includes(item)).length >= 8) throw new Error('Delete an environment before creating another (local limit: eight).');
      const id = randomUUID(), release = usage.acquire(context, { environmentId: id, operation: 'create' });
      // Set before any closure uses it; admission failures before that only compare against it.
      let queued = false, environment!: EnvironmentRecord, directoryCreated = false, recorded = false;
      scopesBusy.add(scope);
      admitted.set(context.key, (admitted.get(context.key) ?? 0) + 1);
      const record = () => { if (recorded) return; recorded = true; const left = (admitted.get(context.key) ?? 1) - 1; if (left) admitted.set(context.key, left); else admitted.delete(context.key); };
      try {
        for (const item of previous) {
          await manager.destroy(context, item.id);
          const result = await manager.awaitIdle(item.id);
          if (result.status !== 'destroyed') throw new Error(result.error || 'The previous twin could not be deleted.');
        }
        const saved = owns ? await planFor(context) : await repairPlan(context), stored = configOf(saved), generated = isGenerated(saved);
        // Only a person's saved config selects the app explicitly. A detected or agent-generated plan must still
        // establish runtime coverage, including when a gate or a restart reuses it.
        const selectionReviewed = state.plans[scope] === saved && !Object.hasOwn(state.detected, scope) && !generated;
        const packages = (context.scan.services ?? []).map(({ path, framework }) => ({ path, ...(framework ? { framework } : {}) }));
        const model = owns && generate && (Object.hasOwn(state.detected, scope) || generated && Object.hasOwn(state.drafts, scope)) ? await authoringModel() : null;
        // The agent starts from the stage's draft, else the detected plan, and may add the apps detection missed; it
        // builds each config it writes, so the environment holds one only once an attempt has one.
        const generation: TwinGeneration | undefined = model ? { model, draft: state.drafts[scope]?.text ?? `${JSON.stringify(stored, null, 2)}\n`, feedback: state.drafts[scope]?.feedback ?? null, packages } : undefined;
        const plan = generation ? undefined : validateTwinConfig(stored);
        // A generated config built as it is, whose failure would become the stage's draft.
        const builtGenerated: GeneratedPlan | undefined = owns && !generation && generated ? { packages } : undefined;
        // A person's saved config is theirs to fix. When detection found no app, an agent writes the config on a person's
        // Create with an OpenRouter model, which is what the person can do.
        if (plan && !Object.keys(plan.apps).length) throw new Error(selectionReviewed ? 'Add an app before creating this environment.'
          : `No app was detected. ${generate || !await authoringModel() ? 'Add an OpenRouter API key in Settings' : 'Create the environment'} so Perpetual can write the twin config.`);
        // Generating a twin config, or building a generated one, reads the checkout while it prepares, for its evidence
        // and its failure's draft, so a gate does not move the source meanwhile. A repair gate reads its own checkout.
        environment = { id, scope, pipelineKey: context.key, stageId: context.stageId, repoPath: context.scan.repo.path, sourceBranch: context.scan.repo.branch || null, sourceRevision: context.scan.repo.sha || null, ...(context.repair ? { repair: context.repair } : {}), ...(plan ? { plan } : {}), status: 'queued', step: 'Queued', services: [], apps: [], createdAt: now(), ...(generation || builtGenerated ? { readsCheckout: true } : {}) };
        const directory = join(root, environment.id);
        await mkdir(directory, { mode: 0o700 });
        directoryCreated = true;
        state.environments.unshift(environment);
        record();
        try { budget(); } catch (error) { state.environments.shift(); throw error; }
        await persist();
        const controller = new AbortController();
        creations.set(environment.id, controller);
        if (closed) controller.abort(new Error('Environment creation cancelled.'));
        enqueue(environment.id, async release => {
          let ready: Awaited<ReturnType<ManagedRuntime['prepareEnvironment']>> | undefined;
          try {
            ready = await runtime.prepareEnvironment({ dataDir, environment, repoPath: environment.repoPath, directory, selectionReviewed, signal: controller.signal, cancelled: () => closed || controller.signal.aborted, onUpdate: async update => {
              Object.assign(environment, update, { updatedAt: now() });
              if (typeof update.logs === 'string') Object.assign(environment, { logs: diagnosticText(update.logs), logsAt: now() });
              if (environment.cancellationRequestedAt) Object.assign(environment, { status: 'preparing', step: 'Stopping' });
              await persist();
            },
              ...(generation ? { generate: generation, onDraft: async (draft: GenerationDraft) => { keepGenerated(scope, { draft }); await persist(); } } : {}), ...(builtGenerated ? { generated: builtGenerated } : {}) });
            if (controller.signal.aborted) { ready = undefined; throw controller.signal.reason; }
          } catch (error) {
            // A failed generation leaves its last config and feedback as the stage's draft, and so does a generated config
            // that failed to build, while it is still the stage's plan; cancellation keeps the last completed attempt.
            if (isGenerationFailure(error) && (generation || builtGenerated && state.plans[scope] === saved)) { try { keepGenerated(scope, { draft: error.draft }); } catch { /* Storage is full: the draft is not kept. */ } }
            // A process the preparation owned, such as the twin config author's, that could not be confirmed stopped.
            const uncertain = cleanupIncomplete(error);
            const stopping = Boolean(environment.cancellationRequestedAt);
            if (!stopping) environment.failedStep = environment.step;
            Object.assign(environment, { status: 'preparing', step: stopping ? 'Stopping' : 'Cleaning up', updatedAt: now(), error: failure(error) });
            let storageFailure = '';
            try { await persist(); }
            catch (storage) { storageFailure = `Evidence could not be saved before cleanup: ${failure(storage)}`; }
            // The logs keep what the error leaves out, such as the end of the twin config author's output.
            const logs = [environment.logs ?? '', errorLogs(error), storageFailure];
            if (environment.sandboxId) {
              try { logs.push(await runtime.environmentLogs({ dataDir, environment })); }
              catch (collection) { logs.push(`Environment logs unavailable: ${failure(collection)}`); }
              environment.logs = diagnosticText(logs.filter(Boolean).join('\n\n')); environment.logsAt = now();
              // Durable evidence precedes teardown. A failed evidence write must not strand resources
              // or replace the original error; the final state save tries again after cleanup.
              try { await persist(); }
              catch (storage) { environment.logs = diagnosticText(`${environment.logs}\nEvidence could not be saved before cleanup: ${failure(storage)}`); }
              try { await runtime.destroySandbox({ dataDir, environment }); if (!uncertain) environment.cleanedAt = now(); }
              catch (cleanup) { environment.status = 'cleanup_failed'; environment.cleanupError = failure(cleanup); }
            }
            else if (logs.some(Boolean)) Object.assign(environment, { logs: diagnosticText(logs.filter(Boolean).join('\n\n')), logsAt: now() });
            if (!uncertain && environment.status !== 'cleanup_failed') {
              try { await removeSnapshot(environment); }
              catch (error) { environment.status = 'cleanup_failed'; environment.cleanupError = failure(error); }
            }
            // Its cleanup stays unfinished, as a browser run's does, until a person deletes the environment.
            if (uncertain) Object.assign(environment, { status: 'cleanup_failed', cleanupError: environment.cleanupError ?? UNCONFIRMED });
            if (environment.status !== 'cleanup_failed') Object.assign(environment, { status: 'failed', step: stopping ? 'Stopped' : 'Failed' });
          }
          // Report "ready" and release together, so the first action on a ready environment is not refused.
          // Environment state holds a twin's test accounts without passwords; the twin's own state keeps those.
          if (ready) {
            const { generated: provenance, ...prepared } = ready;
            if (provenance) { try { keepGenerated(scope, { plan: prepared.plan, provenance }); } catch { /* Storage is full: the stage keeps its detected plan. */ } }
            // A generated config that built again no longer carries the failure it had.
            else if (builtGenerated && state.plans[scope] === saved) delete state.drafts[scope];
            Object.assign(environment, prepared, { accounts: publicAccounts(prepared.accounts), origins: (prepared.apps || []).map(app => applicationOrigin(app.url)).filter(Boolean), updatedAt: now() });
            release();
          }
          if (environment.status === 'failed') delete environment.plan;
          delete environment.readsCheckout;
          await persist();
          creations.delete(environment.id);
        }, { release, onSettled: async () => {
          if (environment.status === 'ready' && onReady) {
            try { await onReady(context, structuredClone(publicEnvironment(environment))); }
            catch (error) { environment.browserPreparationError = failure(error); await persist(); }
          }
        } });
        queued = true;
        return { environment: publicEnvironment(environment) };
      } catch (error) {
        if (!queued) {
          // Admission failed before runtime allocation. Do not leave a queued
          // record that permanently blocks both creation and Stage removal.
          state.environments = state.environments.filter(item => item !== environment);
          if (directoryCreated) await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      } finally { scopesBusy.delete(scope); record(); if (!queued) release(); }
    },
    async cancel(context: StageRef, id: string) {
      const environment = findEnvironment(context, id), controller = creations.get(id);
      if (environment.cancellationRequestedAt) return { environment: publicEnvironment(environment) };
      if (!controller || !['queued', 'creating', 'preparing'].includes(environment.status)) throw conflict('This environment is no longer being created.');
      environment.cancellationRequestedAt = now(); environment.step = 'Stopping'; environment.updatedAt = now();
      controller.abort(new Error('Environment creation cancelled.'));
      await persist();
      return { environment: publicEnvironment(environment) };
    },
    async destroy(context: StageRef, id: string, { removalToken = null }: { removalToken?: symbol | null } = {}) {
      const environment = findEnvironment(context, id, { idle: true });
      const release = usage.acquire(context, { environmentId: id, operation: 'destroy', removalToken });
      let queued = false;
      try {
      if (environment.status === 'destroyed') return { environment: publicEnvironment(environment) };
      environment.status = 'destroying'; environment.step = 'Deleting'; environment.updatedAt = now();
      enqueue(id, async () => {
        try {
          if (environment.sandboxId) await runtime.destroySandbox({ dataDir, environment });
          Object.assign(environment, { status: 'destroyed', step: 'Deleted', services: [], apps: [], destroyedAt: now(), updatedAt: now(), error: null });
          delete environment.accounts;
          await removeSnapshot(environment);
          // A successful deletion removes the evidence, a generated twin's log of how its config was written included.
          delete environment.logs; delete environment.logsAt; delete environment.authoringLogs;
          delete environment.plan;
        } catch (error) { Object.assign(environment, { status: 'cleanup_failed', step: 'Deletion failed', updatedAt: now(), error: failure(error) }); }
        await persist();
      }, { release });
      queued = true;
      await persist();
      return { environment: publicEnvironment(environment) };
      } finally { if (!queued) release(); }
    },
    async logs(context: StageRef, id: string): Promise<EnvironmentLogs> {
      const environment = findEnvironment(context, id);
      if (retainDiagnostics(state.environments)) await persist();
      if (environment.status !== 'ready') {
        if (environment.logs) return { logs: environment.logs };
        if (environment.logsAt) return { logs: 'Failure evidence expired.' };
      }
      // A generated twin's log leads with how its config was written.
      const live = await runtime.environmentLogs({ dataDir, environment });
      return { logs: [environment.authoringLogs, environment.logs, live].filter(Boolean).join('\n\n') };
    },
    async tick() {
      if (closed || ticking) return;
      ticking = true;
      try {
      for (const environment of state.environments) {
        if (closed) break;
        if ((environment.status !== 'ready' && !canRecoverHealth(environment)) || Date.now() - (healthChecks.get(environment.id) || 0) < 30000) continue;
        if (jobs.has(environment.id) || usage.isBusy(environment.id)) { skipHealth(environment.id); continue; }
        let release: () => boolean;
        try { release = usage.acquire({ key: environment.pipelineKey, stageId: environment.stageId }, { environmentId: environment.id, operation: 'health' }); }
        catch (error) { if ((error as { statusCode?: number }).statusCode === 409) { skipHealth(environment.id); continue; } throw error; }
        healthChecks.set(environment.id, Date.now());
        try {
          let healthError: string | null = null;
          try {
            const health = await runtime.environmentHealth({ dataDir, environment });
            if (health.final) healthFailures.set(environment.id, HEALTH_FAILURES - 1);
            if (health.status !== 'ready') throw new Error(health.error || 'The environment is no longer ready.');
            healthFailures.delete(environment.id);
          } catch (error) { healthError = failure(error); }
          healthResults.set(environment.id, { at: Date.now(), ok: !healthError });
          // A late health response cannot clear quarantine or deletion. Only
          // this monitor's own readiness failure is eligible for recovery.
          if ((environment.status !== 'ready' && !canRecoverHealth(environment)) || jobs.has(environment.id)) continue;
          if (healthError) {
            const failures = (healthFailures.get(environment.id) || 0) + 1;
            healthFailures.set(environment.id, failures);
            if (environment.status === 'ready' && failures < HEALTH_FAILURES) continue;
            healthFailures.delete(environment.id);
            Object.assign(environment, { status: 'failed', error: healthError, step: 'Unhealthy', updatedAt: now() });
            await persist();
          } else if (canRecoverHealth(environment)) {
            const previous = { status: environment.status, error: environment.error, step: environment.step, updatedAt: environment.updatedAt };
            Object.assign(environment, { status: 'ready', error: null, step: 'Ready', updatedAt: now() });
            // The shared lease prevents reuse until readiness is durable. A
            // failed save must not release an apparently ready environment.
            try { await persist(); }
            catch (error) { if (environment.status === 'ready') Object.assign(environment, previous); throw error; }
          }
        }
        finally { release(); }
      }
      } finally { ticking = false; }
    },
    close() {
      if (!closing) {
        closed = true;
        for (const controller of creations.values()) controller.abort(new Error('Environment creation cancelled.'));
        closing = (async () => {
          // Do not kill a Docker client and pretend its guest work stopped.
          // Accepted operations retain responsibility through their bounded
          // runtime call, cleanup, and final durable ownership/result record.
          while (pending.size || jobs.size) await Promise.allSettled([...pending, ...jobs.values()]);
          await saves.idle();
          await persist();
        })();
      }
      return closing;
    },
  };
  type Guarded = 'view' | 'logs' | 'savePlan' | 'create' | 'destroy' | 'tick';
  const reads = new Set<Guarded>(['view', 'logs']);
  const stageWrites = new Set<Guarded>(['savePlan']);
  // Each guarded method keeps its signature: the wrapper only admits, tracks or refuses the call.
  const guarded = manager as Record<Guarded, (...args: unknown[]) => Promise<unknown>>;
  for (const name of [...reads, ...stageWrites, 'create', 'destroy', 'tick'] as const) {
    const operation = guarded[name];
    guarded[name] = (...args) => {
      if (closed) return name === 'tick' ? Promise.resolve() : Promise.reject(conflict('The controller is shutting down.'));
      let release: (() => boolean) | undefined;
      try {
        if (stageWrites.has(name)) release = usage.acquire(args[0] as StageRef, { operation: name });
        return track(Promise.resolve(operation(...args)).finally(() => release?.()));
      } catch (error) { release?.(); return Promise.reject(error); }
    };
  }
  return manager;
}
export type EnvironmentManager = Awaited<ReturnType<typeof createEnvironmentManager>>;
