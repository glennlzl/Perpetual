import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwinInputs, createTwinRuntime, services as registry } from '../twin/index.ts';
import { createBrowserModelSettings } from '../browser/model.ts';
import { destroySandbox as destroyGuest } from '../sandbox/cua-local.ts';
import { privateWorkspace } from '../agents/opencode.ts';
import { authorTwinConfig, hiddenFromAuthor, selectedAuthorHarness, type AuthorHarness } from '../twin/authoring.ts';
import { HOST, LOOPBACK } from '../twin/compose.ts';
import { redactor } from '../twin/runtime.ts';
import { failureText, redact } from '../redaction.ts';
import { diagnosticText } from './diagnostics.ts';
import { ID } from '../twin/config.ts';
import { AUTHORING, LOG_LINES, checkWritten, feedbackText, generateTwinConfig, type AttemptOutcome } from './generation.ts';
import { evidenceText, repositoryFacts, unwiredSummary } from './evidence.ts';
import { snapshotSource } from './plans.ts';
import { requireSupportedApplications } from './applications.ts';
import type { EvidencePackage, RepositoryFacts } from './evidence.ts';
import type { EnvironmentAccount, EnvironmentApp, EnvironmentRecord, EnvironmentService, StepTiming } from './manager.ts';
import type { Diagnosis, GenerationDraft, PlanProvenance, StagedFailure } from './generation.ts';
import type { JsonObject, TwinConfig } from '../twin/config.ts';
import type { TwinRuntime, TwinServices } from '../twin/index.ts';
import type { ContainerStatus } from '../twin/runtime.ts';
import type { InputValues } from '../twin/registry.ts';
import type { ServiceSummary } from '../twin/compose.ts';

const MODEL_SERVICE = 'llm';
const SETTINGS_SOURCE = 'settings';
/** The llm service takes App Settings' model unless its `source` option names the app's own values. */
export const fromAppSettings = (id: string, options: { source?: unknown } | null | undefined) => id === MODEL_SERVICE && (options?.source ?? SETTINGS_SOURCE) === SETTINGS_SOURCE;

/** Stored test inputs by service; values go to the twin runtime only, never to a view. Reads never provision
 * a service or replace its account. Expired credentials are omitted, leaving the service blocked. */
export async function environmentInputs({ dataDir, config, services = registry, store }: {
  dataDir: string; config?: { services?: Record<string, JsonObject> } | null; services?: TwinServices;
  store?: { values(): Promise<Record<string, InputValues>> };
}) {
  if (!store) {
    // Storage follows the configured alias; runtime resource identity still uses dataDir unchanged.
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    store = createTwinInputs({ dataDir: await realpath(dataDir), services });
  }
  const declared = config?.services ?? {};
  const inputs = await store.values();
  if (Object.hasOwn(declared, MODEL_SERVICE) && fromAppSettings(MODEL_SERVICE, declared[MODEL_SERVICE])) {
    const model = (await createBrowserModelSettings({ dataDir })).configuration();
    inputs[MODEL_SERVICE] = model.modelConfigured ? { OPENAI_BASE_URL: model.baseUrl, OPENAI_API_KEY: model.apiKey, OPENAI_MODEL: model.model } : {};
  }
  return inputs;
}

type Container = Pick<ContainerStatus, 'name' | 'state' | 'health'> & { exitCode?: number | null };
const describe = (container: Container) => container.health === 'unhealthy' ? `${container.name} unhealthy`
  : `${container.name} ${container.state}${container.exitCode ? ` (${container.exitCode})` : ''}`;
const stopped = (container: Container) => container.state !== 'running' || container.health === 'unhealthy';
/** A container that is running but not healthy, such as one still starting when the twin's wait ended. */
const unready = (container: Container) => container.state === 'running' && container.health !== null && container.health !== 'healthy';
/**
 * Why a container is not up, the likeliest cause first: it stopped or keeps restarting, it runs but is unhealthy, it
 * runs but is not healthy yet, or it was created and never started, as a container that waits for a failed one is.
 */
const FAILED_FIRST: ((container: Container) => boolean)[] = [
  container => container.state !== 'running' && container.state !== 'created', container => container.state === 'running' && container.health === 'unhealthy',
  unready, container => container.state === 'created',
];
const code = (text: string) => `\`${text.replaceAll('`', "'")}\``;
/** An app as feedback names it: its directory and commands. */
const appSubject = (config: TwinConfig, id: string) => {
  const app = config.apps[id];
  return app ? `App ${code(id)} in ${code(app.directory)}: ${app.build ? `build ${code(app.build)}, ` : ''}start ${code(app.start)}` : `App ${code(id)}`;
};

/** What preparing an environment reports once its twin is ready; `generated` when an agent wrote its config. */
export interface PreparedEnvironment {
  status: 'ready'; step: string; timings: StepTiming[]; readyAt: string; apps: EnvironmentApp[]; services: EnvironmentService[]; accounts: EnvironmentAccount[];
  plan?: TwinConfig; generated?: PlanProvenance;
  logs?: string;
}
/** A health check: `final` says the twin will not recover by itself. */
export interface EnvironmentHealth { status: 'ready' | 'starting' | 'failed'; error?: string; final?: boolean }
/** An environment as its runtime reads it: the twin validates the plan. */
type Environment = Pick<EnvironmentRecord, 'id' | 'sandboxId'> & { plan?: { services?: Record<string, JsonObject> } };
type TwinCall = { dataDir: string; id: string };
/** What environments call on their twin runtime (../twin/runtime.ts). */
export interface EnvironmentTwin {
  prepare(options: Parameters<TwinRuntime['prepare']>[0]): Promise<{ services: ServiceSummary[]; apps: EnvironmentApp[]; accounts?: EnvironmentAccount[] }>;
  health(options: TwinCall): Promise<{ status: string; containers: Container[] }>;
  logs(options: TwinCall & { service?: string; tail?: number }): Promise<string>;
  destroy(options: TwinCall & { inputs?: Record<string, InputValues> }): Promise<unknown>;
}
/** The OpenRouter model an agent writes a twin config with; the key stays in memory. */
export interface AuthoringModel { apiKey: string; model: string; escalationModel?: string }
/**
 * Creation writes the twin config first: from the stage's draft, or the detected plan, and the feedback it failed with.
 * `packages` are the scan's, which the repository's evidence describes.
 */
export interface TwinGeneration { model: AuthoringModel; draft: string; feedback?: string | null; packages?: EvidencePackage[] }
/**
 * Creation from a saved config an agent wrote: when preparing its twin fails, the failure carries the config and staged
 * feedback as the stage's next draft. `packages` are the scan's.
 */
export interface GeneratedPlan { packages?: EvidencePackage[] }

// The controller reaches an app where the twin publishes it, on the host's loopback.
const APP_TIMEOUT_MS = 20000;
/** The HTTP status an app answers on its twin address with; a redirect is an answer. */
export async function appStatus(url: string, signal?: AbortSignal) {
  const target = new URL(url);
  if (target.hostname === HOST) target.hostname = LOOPBACK;
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(APP_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
  await response.body?.cancel().catch(() => {});
  return response.status;
}
const CANCEL_POLL_MS = 250;

// An environment's sandbox is its Compose twin, named by the environment's id. A different
// sandbox id is a Cua guest created before twins; it can only be deleted.
export function createEnvironmentRuntime({ services = registry, twin = createTwinRuntime({ services }), inputs = environmentInputs, destroyCuaGuest = destroyGuest, author = authorTwinConfig, authorHarness = selectedAuthorHarness(), answers = appStatus }: {
  services?: TwinServices; twin?: EnvironmentTwin; inputs?: typeof environmentInputs;
  destroyCuaGuest?: (options: { dataDir: string; id?: string }) => Promise<unknown>;
  /** One attempt of the twin config author; tests supply a harness. */
  author?: typeof authorTwinConfig;
  /** What runs the author: OpenCode, or the loop when PERPETUAL_TWIN_AUTHOR=loop. */
  authorHarness?: AuthorHarness;
  answers?: (url: string, signal?: AbortSignal) => Promise<number>;
} = {}) {
  const twinInputs = (dataDir: string, config: Environment['plan']) => inputs({ dataDir, config, services });
  const secretInputs = (values: Record<string, InputValues>) => Object.entries(values)
    .flatMap(([id, entries]) => (services[id]?.inputs ?? []).filter(input => input.secret).map(input => entries[input.name])).filter((value): value is string => Boolean(value));

  const twinContainers = (dataDir: string, id: string) => twin.health({ dataDir, id }).then(health => health.containers, (): Container[] => []);
  // The named containers' last lines, or every container's when none is named; empty before the twin has any.
  async function containerLogs(dataDir: string, id: string, names: string[]) {
    try {
      // Vendor-owned container names are outside Compose's service-ID grammar. Their verified logs
      // join the whole twin read; never feed those names to `docker compose logs`.
      const failed = names.some(name => !ID.test(name)) ? [] : names.slice(0, 3);
      const parts = failed.length ? await Promise.all(failed.map(service => twin.logs({ dataDir, id, service, tail: LOG_LINES }))) : [await twin.logs({ dataDir, id, tail: LOG_LINES })];
      return parts.join('\n').trim().split('\n').slice(-LOG_LINES).join('\n');
    } catch (error) { return `Environment logs unavailable: ${failureText(error, 600)}`; }
  }
  // The failed containers' last lines, or every container's when none has stopped.
  const failureLogs = async (dataDir: string, id: string) => containerLogs(dataDir, id, (await twinContainers(dataDir, id)).filter(stopped).map(item => item.name));

  /**
   * Where a failed preparation stopped: a service's setup or the test accounts, when the twin names that service as the
   * one that failed; the install or a fixture by its step; and otherwise the container most likely to have caused it,
   * which stopped (build) or never became healthy (healthy), with its app's or service's commands. A failure that names
   * none of these, such as Docker's own, has no subject.
   */
  async function diagnose({ dataDir, id, config, step, error }: { dataDir: string; id: string; config: TwinConfig; step: string; error: unknown }): Promise<Diagnosis> {
    const containers = await twinContainers(dataDir, id), message = String((error as Error)?.message ?? error);
    // The twin prefixes a service's own failure with its title; the step alone also covers the controller's work after it.
    const service = Object.keys(config.services).find(item => services[item] && message.startsWith(`${services[item].title}:`));
    const fixture = /^Loading fixture (\d+) of (\d+)$/.exec(step);
    let found: Pick<Diagnosis, 'stage' | 'subject'> = { stage: 'build' }, named: string[] = [];
    if (step.startsWith('Setting up ') || step === 'Creating test accounts') {
      found = { stage: step === 'Creating test accounts' ? 'account' : 'build', ...(service ? { subject: `Service ${code(service)}` } : {}) };
    } else if (step === 'Installing dependencies' && config.install) found = { stage: 'build', subject: `Install in ${code(config.install.directory)}: ${code(config.install.command)}` };
    else if (fixture) {
      // Fixtures of blocked services are skipped, so the step's numbers name the config's fixture only when none was.
      const item = Number(fixture[2]) === config.fixtures.length ? config.fixtures[Number(fixture[1]) - 1] : undefined;
      found = { stage: 'build', ...(item ? { subject: `Fixture ${fixture[1]} of ${fixture[2]} on ${code(item.service)}: ${item.sql ? `sql ${code(item.sql)}` : item.query ? `query ${code(item.query)}` : `command ${code(item.command ?? '')}`}` } : {}) };
    } else {
      // A container that stopped failed its build or start; one still running but not healthy never became healthy. One
      // that never started is only the cause when nothing else failed, and then every stopped container's logs are read.
      const failed = FAILED_FIRST.map(test => containers.find(test)).find(item => item !== undefined);
      if (failed) {
        if (failed.state !== 'created') named = [failed.name];
        const owner = Object.keys(config.services).find(item => failed.name === item || failed.name.startsWith(`${item}-`));
        found = { stage: failed.state !== 'running' ? 'build' : 'healthy',
          subject: Object.hasOwn(config.apps, failed.name) ? appSubject(config, failed.name) : owner ? `Service ${code(owner)}, container ${code(failed.name)}` : `Container ${code(failed.name)}` };
      }
    }
    return { ...found, step, logs: await containerLogs(dataDir, id, named.length ? named : containers.filter(stopped).map(item => item.name)) };
  }

  // A twin that is up counts as ready once every app answers below 500 on its address and, when a
  // ready service of the config can create test accounts, one exists.
  async function verify(config: TwinConfig, result: Awaited<ReturnType<EnvironmentTwin['prepare']>>, signal?: AbortSignal): Promise<Pick<StagedFailure, 'stage' | 'subject' | 'error'> | null> {
    for (const app of result.apps) {
      let status: number;
      try { status = await answers(app.url, signal); } catch (error) { return { stage: 'answers', subject: appSubject(config, app.id), error: `apps.${app.id} did not answer at ${app.url}: ${(error as Error).message}` }; }
      if (status >= 500) return { stage: 'answers', subject: appSubject(config, app.id), error: `apps.${app.id} answered ${status} at ${app.url}.` };
    }
    const offering = Object.keys(config.services).filter(id => services[id]?.accounts && result.services.some(item => item.id === id && item.status === 'ready'));
    if (offering.length && !result.accounts?.length) return { stage: 'account', subject: `Service ${offering.map(code).join(', ')}`, error: `${offering.map(id => services[id].title).join(' and ')} can create test accounts, but none was created: add one in its options.` };
    return null;
  }

  async function prepareEnvironment({ dataDir, environment, repoPath, directory, onUpdate, onDraft, cancelled, signal, generate, generated, selectionReviewed = false }: {
    dataDir: string; environment: Environment; repoPath: string; directory: string; onUpdate: (update: Partial<EnvironmentRecord>) => Promise<void>; cancelled: () => boolean;
    signal?: AbortSignal; generate?: TwinGeneration; generated?: GeneratedPlan; onDraft?: (draft: GenerationDraft) => Promise<void>;
    /** Only the manager's explicitly saved, non-generated plan establishes a person's application selection. */
    selectionReviewed?: boolean;
  }): Promise<PreparedEnvironment> {
    const check = () => { if (cancelled()) throw new Error('Environment creation cancelled.'); };
    // How long each step took, kept as it goes, so a slow or failed twin shows where its time went.
    const timings: StepTiming[] = [];
    let current = { step: 'Copying source', at: Date.now() };
    const next = (step: string) => { const at = Date.now(); timings.push({ step: current.step, ms: at - current.at }); current = { step, at }; return { step, timings: [...timings] }; };
    check();
    await onUpdate({ status: 'creating', step: current.step, timings: [] });
    // Apps run from this snapshot for the twin's whole life; the user's checkout is never mounted.
    const source = join(directory, 'source');
    const snapshot = await snapshotSource(repoPath, source);
    check();
    if (!selectionReviewed) {
      await onUpdate(next('Checking application runtimes'));
      await requireSupportedApplications(source);
    }
    check();
    // Record ownership before the twin allocates anything, so every later failure is cleaned up.
    const owned = { status: 'preparing', snapshot, sandboxId: environment.id } as const;
    let values: Record<string, InputValues> = {};
    const knownSecrets = new Set<string>();
    let facts: RepositoryFacts | undefined;
    const readInputs = async (config: Environment['plan']) => {
      const next = await twinInputs(dataDir, config);
      // Replacing inputs never makes an earlier value safe to disclose. New values invalidate already-clipped evidence.
      for (const value of secretInputs(next)) if (!knownSecrets.has(value)) { knownSecrets.add(value); facts = undefined; }
      return next;
    };
    const prepareTwin = async (config: Environment['plan']) => {
      values = await readInputs(config);
      check();
      return twin.prepare({ dataDir, id: environment.id, config, source, inputs: values, signal, onStep: async step => { check(); await onUpdate(next(step)); } });
    };
    const ready = (result: Awaited<ReturnType<EnvironmentTwin['prepare']>>): PreparedEnvironment => ({ status: 'ready', ...next('Ready'), readyAt: new Date().toISOString(), apps: result.apps,
      services: result.services.map(({ id, fidelity, status, missing = [] }) => ({ id, title: services[id]?.title ?? id, fidelity, status, missing })),
      accounts: result.accounts ?? [] });
    /**
     * A saved generated config and why preparing it failed, staged as a generation's attempt would be; null when the
     * failure names no part of the config, such as Docker being unavailable, which rewriting the config cannot fix.
     */
    async function failedDraft(error: Error, { packages }: GeneratedPlan, unready?: StagedFailure): Promise<GenerationDraft | null> {
      const text = `${JSON.stringify(environment.plan ?? {}, null, 2)}\n`, checked = checkWritten(text, services), step = current.step;
      const failure: StagedFailure = unready ?? (checked.error !== undefined ? { stage: 'valid', heading: 'twin.json is not a valid twin config', error: checked.error }
        : { ...await diagnose({ dataDir, id: environment.id, config: checked.config, step, error }), heading: `preparing the twin failed at "${step}"`, error: error.message });
      if (failure.stage !== 'valid' && !failure.subject) return null;
      // The next author reads this feedback: it hides what the author's copy of the source does.
      const secrets = hiddenFromAuthor(knownSecrets);
      const facts = await repositoryFacts({ source, checkout: repoPath, packages, draft: text, services, secrets }).catch(() => null);
      const hide = (value: string) => redact(redactor(secrets)(value));
      return { text, feedback: feedbackText({ title: 'The saved twin config', failure, unwired: facts ? unwiredSummary(facts, text) : [], hide }) };
    }
    if (!generate) {
      // A saved config is checked as a generation's attempt is before it is built: one its services refuse is never built,
      // so it can never count as ready.
      const checked = checkWritten(JSON.stringify(environment.plan ?? {}), services);
      if (checked.error !== undefined) {
        const error = new Error(checked.error);
        if (!generated || cancelled()) throw error;
        const draft = await failedDraft(error, generated);
        throw draft ? Object.assign(error, { draft }) : error;
      }
      await onUpdate({ ...owned, ...next('Preparing twin') });
      let result: Awaited<ReturnType<typeof prepareTwin>>;
      try { result = await prepareTwin(environment.plan); }
      catch (error) {
        // A generated config that fails to build leaves itself and its failure as the stage's next draft, when the failure
        // names a part of it.
        if (!generated || cancelled() || !(error instanceof Error)) throw error;
        const draft = await failedDraft(error, generated);
        throw draft ? Object.assign(error, { draft }) : error;
      }
      // A saved config's twin counts as ready as a generated one's does, on every rebuild: each app answers and, where a
      // service can create them, a test account exists. A gate's twin that is not ready gives no verdict.
      check(); await onUpdate(next('Checking apps'));
      const problem = await verify(checked.config, result, signal);
      if (problem === null) return ready(result);
      const error = new Error(problem.error);
      if (!generated || cancelled()) throw error;
      const draft = await failedDraft(error, generated, { ...problem, heading: 'the twin started, but does not count as ready', logs: await failureLogs(dataDir, environment.id) });
      throw draft ? Object.assign(error, { draft }) : error;
    }

    const { model } = generate, workspaces = join(directory, AUTHORING);
    await mkdir(workspaces, { recursive: true, mode: 0o700 });
    // Facts come from the execution snapshot, cached until supplied secrets change; example names come from the checkout.
    // Each attempt's evidence leads with the unwired variables of the twin.json it starts from.
    let authoredModel = model.model;
    let evidence = '';
    const attempts: AttemptOutcome[] = [];
    // The twin's logs hide every value seen; what the author reads, its evidence and feedback included, leaves a placeholder
    // too short to be a credential in place, as its copy of the source does.
    const knownValues = () => [model.apiKey, ...knownSecrets], authorSecrets = () => hiddenFromAuthor(knownValues());
    try {
      // Protect the first observation as well as build feedback. Reading stored inputs never provisions a service.
      values = await readInputs(environment.plan);
      check();
      const outcome = await generateTwinConfig({
        draft: generate.draft, feedback: generate.feedback, services, cancelled,
        step: async step => { check(); await onUpdate({ ...owned, ...next(step) }); },
        async author({ draft, feedback, attempt }) {
          facts ??= await repositoryFacts({ source, checkout: repoPath, packages: generate.packages, draft: generate.draft, services, secrets: authorSecrets() });
          check();
          const evidence = evidenceText(facts, draft), workspace = await privateWorkspace(workspaces);
          authoredModel = attempt > 2 ? model.escalationModel || model.model : model.model;
          const job = author({ workspace: workspace.path, source, draft, evidence, facts, feedback, apiKey: model.apiKey, secrets: authorSecrets(), model: authoredModel, harness: authorHarness.harness, services });
          // Controller shutdown cancels the agent as it would a twin between steps.
          const watch = setInterval(() => { if (cancelled()) job.cancel(); }, CANCEL_POLL_MS);
          try { return await job.promise; } finally { clearInterval(watch); await workspace.remove(); }
        },
        // The environment keeps the config it is building, so its cleanup sees the same services.
        prepare: async config => { check(); await onUpdate({ plan: config, ...next('Preparing twin') }); return prepareTwin(config); },
        verify: async (config, result) => { check(); await onUpdate(next('Checking apps')); return verify(config, result, signal); },
        diagnose: (config, error) => diagnose({ dataDir, id: environment.id, config, step: current.step, error }),
        logs: () => failureLogs(dataDir, environment.id),
        unwired: text => facts ? unwiredSummary(facts, text) : [],
        failed: async outcome => { attempts.push(outcome); await onUpdate({ attempts: [...attempts] }); },
        checkpoint: onDraft,
        teardown: async config => {
          // Generation retries also remove owned vendor containers. Save the bounded full evidence
          // through the manager before any teardown, even when feedback itself has fewer lines.
          let captured: string;
          try { captured = await twin.logs({ dataDir, id: environment.id }); }
          catch (error) { captured = `Environment logs unavailable: ${failureText(error, 600)}`; }
          evidence = diagnosticText(redactor(knownValues())([evidence, captured].filter(Boolean).join('\n\n')));
          try { await onUpdate({ logs: evidence }); }
          catch (error) { evidence = diagnosticText(`${evidence}\nEvidence could not be saved before cleanup: ${failureText(error, 600)}`); }
          await twin.destroy({ dataDir, id: environment.id, inputs: await readInputs(config) });
        },
        hide: text => redact(redactor(authorSecrets())(text)),
      });
      return { ...ready(outcome.result), plan: outcome.config, ...(evidence ? { logs: evidence } : {}), ...(outcome.logs ? { authoringLogs: outcome.logs } : {}),
        generated: { generatedAt: new Date().toISOString(), harness: authorHarness.name, model: `openrouter/${authoredModel}`, attempts: outcome.attempts } };
    } catch (error) {
      if (error instanceof Error && evidence) Object.assign(error, { logs: diagnosticText([evidence, 'logs' in error && typeof error.logs === 'string' ? error.logs : ''].filter(Boolean).join('\n\n')) });
      throw error;
    } finally { await rm(workspaces, { recursive: true, force: true }); }
  }

  async function environmentHealth({ dataDir, environment }: { dataDir: string; environment: Environment }): Promise<EnvironmentHealth> {
    const { status, containers } = await twin.health({ dataDir, id: environment.id });
    if (status === 'ready') return { status };
    if (status === 'starting') return { status, error: 'The twin is restarting.' };
    const down = containers.filter(stopped).map(describe);
    return { status: 'failed', final: true, error: down.length ? `Stopped: ${down.join(', ')}.` : 'The twin is not running.' };
  }

  async function environmentLogs({ dataDir, environment }: { dataDir: string; environment: Environment }) {
    return twin.logs({ dataDir, id: environment.id });
  }

  async function destroySandbox({ dataDir, environment }: { dataDir: string; environment: Environment }) {
    if (environment.sandboxId !== environment.id) return destroyCuaGuest({ dataDir, id: environment.sandboxId });
    return twin.destroy({ dataDir, id: environment.id, inputs: await twinInputs(dataDir, environment.plan) });
  }

  return { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
}
export type EnvironmentRuntime = ReturnType<typeof createEnvironmentRuntime>;

export const { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } = createEnvironmentRuntime();
