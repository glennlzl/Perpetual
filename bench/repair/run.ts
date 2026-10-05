// The bake-off runner and its CLI:
//   node run.ts run [--dry-run] [--provider openrouter|openai] [--frameworks all|aisdk,…] [--models id,…|settings] [--cases all|name,…]
//                   [--seeds N] [--concurrency N] [--budget $] [--attempt-cap $] [--steps N] [--minutes N]
//                   [--reasoning default|native|low|medium|high] [--provider-only slug] [--key-file path] [--gateway-host ip] [--out dir]
//   node run.ts report --out dir
//   node run.ts corpus-check [--cases …] [--concurrency N]
//   node run.ts setup
//   node run.ts cleanup [--out dir | --all]
// For each (framework, model, case, seed) the runner starts a fresh bench box from the case's snapshot, runs ONE attempt
// with the framework against the gateway (the product's prompt and INSTRUCTIONS, 100 steps, 15 minutes, a $0.50 cap by
// default), takes the box's diff, and judges it in a brand-new box. The real key lives only in the gateway's process;
// --dry-run uses the fake upstream and its scripted solver instead, at no cost. A run has one provider: OpenRouter, or
// OpenAI (--provider openai, whose key comes only from --key-file), and runs only the frameworks that declare it.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { TOO_LARGE } from '../../src/repair/box.ts';
import { writeStateFile } from '../../src/store.ts';
import { checkChanges } from '../../src/repair/changes.ts';
import { EGRESS } from '../../src/repair/egress.ts';
import { BENCH, createBenchBox, docker, dockerAvailable, removeBenchResources, useBenchDocker } from './box.ts';
import { imageFor, prepareCase, type CaseContext } from './context.ts';
import { loadCases, type Case } from './corpus.ts';
import { createFakeOpenAI } from './fake-openai.ts';
import { FAKE_MODELS, corpusSolutions, createFakeUpstream, solver } from './fake-upstream.ts';
import { PROVIDERS, REASONING, UPSTREAMS, WIRES, forkGateway, keyFileModels, type GatewayControl, type Provider, type ReasoningPolicy } from './gateway.ts';
import { ADAPTERS, ADAPTER_KEYS, DEFAULT_PROVIDERS, LIMITS, modelInfo, wireOf, type Adapter, type AdapterKey, type AttemptEvent, type AttemptLimits, type AttemptOutcome, type ModelInfo } from './harness.ts';
import { judge } from './judge.ts';
import { loadPrices, priceFor, type PriceTable } from './prices.ts';
import { renderReport } from './report.ts';
import { appendRecord, cellFolder, readRecords, resultPaths, writeArtifact, type AttemptRecord, type FinalReason } from './results.ts';
import { safeJson } from './safe.ts';
import { matrix, pool, remaining, type Cell } from './schedule.ts';
import { checkCorpus } from './selfcheck.ts';

export interface RunOptions {
  frameworks: readonly AdapterKey[] | 'all'; models: readonly string[]; cases: readonly string[] | 'all'; seeds: number; concurrency: number; budget: number;
  limits: AttemptLimits; reasoning: ReasoningPolicy; providerOnly?: string; out: string; dryRun: boolean;
  /** The run's one upstream provider; OpenRouter when absent. */
  provider?: Provider;
  /** The OpenAI track's prices; prices/openai.json when absent. */
  prices?: PriceTable;
  /** The address the gateway listens on: 127.0.0.1, or a Linux engine's bridge gateway so in-box harnesses reach it. */
  gatewayHost?: string;
  /** The real key's source for a paid run: a key file (read by the gateway process) or a value (sent to it). */
  key?: { file?: string; value?: string };
  /** The upstream for a paid run; the provider's API unless a test names another. */
  upstream?: string;
  signal?: AbortSignal; log?(line: string): void;
}
/** Time an adapter gets past its limit to stop by itself before the runner aborts it. */
const GRACE_MS = 30_000;
/** Runner errors in a row after which a run starts no more attempts, since something such as Docker fails every one. */
export const RUNNER_ERRORS = 5;
/** Counts the runner errors in a row that a judged attempt ends; true once there are limit of them. */
export function errorStreak(limit = RUNNER_ERRORS) {
  let streak = 0;
  return (record: Pick<AttemptRecord, 'status'>) => (streak = record.status === 'error' ? streak + 1 : record.status === 'judged' ? 0 : streak) >= limit;
}

/** Why an adapter cannot run against a provider: it declares no wire API for it, or one the gateway does not serve there. */
export function unsupported(adapter: Pick<Adapter, 'providers'>, provider: Provider): string | null {
  const wire = wireOf(adapter, provider);
  if (!wire) return `it does not support ${provider}`;
  return WIRES[provider].includes(wire) ? null : `the gateway serves no ${wire} API for ${provider}`;
}

async function chooseAdapters(keys: RunOptions['frameworks'], provider: Provider, log: (line: string) => void) {
  const wanted = keys === 'all' ? ADAPTER_KEYS : keys, chosen = new Map<AdapterKey, Adapter>();
  for (const key of wanted) {
    const adapter = await ADAPTERS[key]();
    const why = unsupported(adapter, provider) ?? await adapter.available();
    if (why && keys !== 'all') throw new Error(`${key} cannot run: ${why}`);
    if (why) { log(`skipping ${key}: ${why}`); continue; }
    chosen.set(key, adapter);
  }
  if (!chosen.size) throw new Error('No framework can run.');
  return chosen;
}

const diffStats = (diff: Buffer) => {
  const check = checkChanges(diff.toString('utf8'));
  return { bytes: diff.length, files: check.paths.length, added: check.added, removed: check.removed, sha256: createHash('sha256').update(diff).digest('hex') };
};
const refusalReason: Partial<Record<string, FinalReason>> = { cost: 'cost', budget: 'budget', requests: 'steps', deadline: 'time' };
/** The attempt's final reason: a gateway refusal first, then the runner's deadline, then the adapter's own. */
export const finalReason = (refusal: string | null, timedOut: boolean, adapter: AttemptOutcome['reason']): FinalReason => (refusal && refusalReason[refusal]) || (timedOut ? 'time' : adapter);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The data hashes of a run's boxes, which cleanup removes by; a file a killed run tore keeps those it still names. */
export async function readScopes(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => '[]');
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : []; }
  catch { return [...text.matchAll(/"([\da-f]{16})"/g)].map(match => match[1]); }
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});
/**
 * Whether an attempt with this cap can start: true once the budget has room beside the open attempts' reserved caps,
 * waiting while they hold it; false once spending alone leaves no room, so the rest of the run is skipped.
 */
async function room(gateway: GatewayControl, cap: number, signal: AbortSignal) {
  for (;;) {
    const status = await gateway.status();
    if (status.spent + cap > status.budget + 1e-9) return false;
    if (status.spent + status.reserved + cap <= status.budget + 1e-9) return true;
    await pause(500, signal);
  }
}

/** Runs the matrix and returns every record of the run, earlier ones included. */
export async function runBench(options: RunOptions) {
  const log = options.log ?? (line => console.log(line)), out = resolve(options.out), paths = resultPaths(out), provider = options.provider ?? 'openrouter';
  if (!PROVIDERS.includes(provider)) throw new Error(`The provider is one of ${PROVIDERS.join(', ')}.`);
  if (!options.dryRun && !options.key?.file && !options.key?.value) throw new Error(provider === 'openai' ? 'A paid OpenAI run needs --key-file.' : 'A paid run needs --key-file or OPENROUTER_API_KEY.');
  await mkdir(out, { recursive: true, mode: 0o700 });
  // One folder holds one provider's attempts, whose dollars are OpenRouter's reported ones or priced from OpenAI's usage.
  const earlier: unknown = await readFile(paths.run, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null);
  const before = isRecord(earlier) ? earlier.provider ?? 'openrouter' : provider;
  if (before !== provider) throw new Error(`${out} holds a ${String(before)} run; name another --out for ${provider}.`);
  const prices = provider === 'openai' ? options.prices ?? await loadPrices() : undefined;
  // A resumed folder keeps the settings its judged attempts ran under, so a dry run, other limits, another reasoning
  // policy, route or prices never pass for the same run in its report.
  if (isRecord(earlier)) {
    const settings: Record<string, unknown> = JSON.parse(JSON.stringify({ dryRun: options.dryRun, limits: options.limits, reasoning: options.reasoning, providerOnly: options.providerOnly ?? null }));
    const changed = Object.keys(settings).filter(name => name in earlier && !isDeepStrictEqual(earlier[name], settings[name]));
    const rates = isRecord(earlier.prices) && isRecord(earlier.prices.models) ? earlier.prices.models : {};
    if (prices && options.models.some(id => id in rates && !isDeepStrictEqual(rates[id], JSON.parse(JSON.stringify(priceFor(prices, id)))))) changed.push('prices');
    if (changed.length) throw new Error(`${out} holds a run with other ${changed.join(', ')}; resume it with the same settings, or name another --out.`);
  }
  await useBenchDocker();
  const unavailable = await dockerAvailable();
  if (unavailable) throw new Error(unavailable);
  const adapters = await chooseAdapters(options.frameworks, provider, log);
  // Read before the gateway starts, which only the run's finally stops; each write replaces the file whole.
  const scopes = new Set(await readScopes(paths.boxes));
  const cases = await loadCases(options.cases);
  const script = options.dryRun ? solver(await corpusSolutions(cases)) : null;
  const fake = !script ? null : provider === 'openai' ? await createFakeOpenAI({ script }) : await createFakeUpstream({ script });
  const upstream = fake?.url ?? options.upstream ?? UPSTREAMS[provider];
  const gateway: GatewayControl = await forkGateway({ ...(fake ? { key: fake.key } : options.key?.file ? { keyFile: options.key.file } : { key: options.key?.value }), provider, ...(prices ? { prices } : {}),
    budget: options.budget, upstream, reasoning: options.reasoning, ...(options.providerOnly ? { providerOnly: options.providerOnly } : {}), ...(options.gatewayHost ? { host: options.gatewayHost } : {}) });
  let saving = Promise.resolve();
  const onScope = (scope: string) => { scopes.add(scope); saving = saving.then(() => writeStateFile(paths.boxes, JSON.stringify([...scopes], null, 2), { prefix: '.boxes-', removeTemporary: true })); return saving; };
  const stop = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  try {
    const models: Map<string, ModelInfo> = await modelInfo(options.models, prices ?? upstream);
    const contexts = new Map<string, { c: Case; context: CaseContext }>();
    // A case whose captured failure is not its stated one is left out before any paid attempt.
    await pool(cases, options.concurrency, async c => {
      const context = await prepareCase(c, { directory: join(paths.cases, c.name), root: paths.boxRoot, signal, onScope, scrub: gateway.scrub, strict: true }).catch((error: unknown) => {
        if (signal.aborted) throw error;
        log(`left out ${c.name}: ${String((error as Error)?.message ?? error).slice(0, 500)}`);
        return null;
      });
      if (!context) return;
      contexts.set(c.name, { c, context });
      log(`prepared ${c.name}: ${context.failure.diagnosis.category} at ${context.capture.find(step => step.exit !== 0)?.name ?? 'no failure'}`);
    }, signal);
    const prepared = cases.filter(c => contexts.has(c.name)).map(c => c.name);
    if (!prepared.length) throw new Error('No case could be prepared.');
    const run = randomUUID(), cells = matrix({ frameworks: [...adapters.keys()], models: [...models.keys()], cases: prepared, seeds: options.seeds });
    const done = new Set((await readRecords(paths.results)).filter(record => record.status === 'judged').map(record => record.key));
    const todo = remaining(cells, done);
    // The rates the run's models are priced at, so its dollars stay reproducible after the table changes.
    const priced = prices ? { source: prices.source, checked: prices.checked, tiers: prices.tiers, models: Object.fromEntries([...models.keys()].map(id => [id, priceFor(prices, id)])) } : null;
    await writeFile(paths.run, await safeJson({ run, startedAt: new Date().toISOString(), dryRun: options.dryRun, provider, prices: priced,
      frameworks: [...adapters.values()].map(adapter => ({ key: adapter.key, version: adapter.version, wire: wireOf(adapter, provider) })),
      models: [...models.values()], cases: prepared, seeds: options.seeds, budget: options.budget, limits: options.limits, reasoning: options.reasoning, providerOnly: options.providerOnly ?? null,
      cells: cells.length, resumed: cells.length - todo.length }, gateway.scrub, 2), { mode: 0o600 });
    log(`${todo.length} of ${cells.length} attempts to run (${cells.length - todo.length} already done); budget $${options.budget}, cap $${options.limits.cost} each`);
    // Once RUNNER_ERRORS attempts in a row failed in the runner, each of which may have paid for model calls first, the
    // run starts no more; the rest is left for a resumed run.
    const stopping = errorStreak();
    let exhausted = false, halted: string | null = null;
    const skip = (cell: Cell, adapter: Adapter, why: 'budget'): AttemptRecord => ({
      run, key: cell.key, framework: cell.framework, frameworkVersion: adapter.version, model: cell.model, case: cell.case, seed: cell.seed, startedAt: new Date().toISOString(), status: 'skipped', skipped: why,
      reason: null, adapterReason: null, summary: '', error: '', adapterSteps: 0, reproduced: null, frameworkCost: null, gateway: null, wallMs: 0, setupMs: 0, harnessPaths: [], diff: null,
      rules: { rejected: [], holds: [] }, guards: [], scriptsChanged: [], judge: null, success: false, passedWithoutDone: false,
    });
    await pool(todo, options.concurrency, async cell => {
      if (halted !== null) return;
      const adapter = adapters.get(cell.framework as AdapterKey)!, { c, context } = contexts.get(cell.case)!, model = models.get(cell.model)!;
      if (exhausted || !await room(gateway, options.limits.cost, signal)) {
        exhausted = true;
        return appendRecord(paths.results, skip(cell, adapter, 'budget'), gateway.scrub);
      }
      // A failure of the runner itself (a box, Docker) is recorded and the run goes on; a resumed run retries it. What
      // the attempt already spent, and its change, are kept once the model ran.
      const partial: { record?: AttemptRecord } = {};
      const record = await attempt({ cell, adapter, c, context, model, gateway, options, paths, run, signal, onScope, partial }).catch((error: unknown): AttemptRecord => {
        if (signal.aborted) throw error;
        const ran = partial.record?.gateway ? partial.record : skip(cell, adapter, 'budget');
        return { ...ran, status: 'error', skipped: undefined, reason: 'error', error: String((error as Error)?.message ?? error).slice(0, 1000), judge: null, success: false, passedWithoutDone: false };
      });
      if (record.status === 'skipped') exhausted = true;
      if (stopping(record) && halted === null) halted = record.error;
      await appendRecord(paths.results, record, gateway.scrub);
      log(`${cell.key}: ${record.status === 'skipped' ? 'skipped (budget)' : record.status === 'error' ? `runner error: ${record.error}` : `${record.success ? 'solved' : 'not solved'} · ${record.reason} · ${record.judge?.reason ?? '–'} · $${(record.gateway?.cost ?? 0).toFixed(4)} · ${Math.round(record.wallMs / 1000)}s`}`);
    }, signal);
    const records = await readRecords(paths.results), report = renderReport(records);
    await writeFile(paths.report, report);
    const final = await gateway.status();
    log(`spent $${final.spent.toFixed(4)} of $${final.budget}; report: ${paths.report}`);
    if (halted !== null) throw new Error(`The run stopped after ${RUNNER_ERRORS} runner errors in a row, the last: ${halted} Resume it with the same --out once the cause is fixed.`);
    return { records, report, out };
  } finally {
    stop.abort();
    await saving.catch(() => {});
    await gateway.stop();
    await fake?.stop();
  }
}

async function attempt({ cell, adapter, c, context, model, gateway, options, paths, run, signal, onScope, partial = {} }: {
  cell: Cell; adapter: Adapter; c: Case; context: CaseContext; model: ModelInfo; gateway: GatewayControl; options: RunOptions; paths: ReturnType<typeof resultPaths>; run: string;
  signal: AbortSignal; onScope(scope: string): Promise<void>;
  /** The record as far as it got, for the runner to keep when the attempt fails after the model ran. */
  partial?: { record?: AttemptRecord };
}): Promise<AttemptRecord> {
  const folder = join(paths.attempts, cellFolder(cell)), events: AttemptEvent[] = [], scrub = gateway.scrub, provider = options.provider ?? 'openrouter';
  const record: AttemptRecord = {
    run, key: cell.key, framework: cell.framework, frameworkVersion: adapter.version, model: cell.model, case: cell.case, seed: cell.seed, startedAt: new Date().toISOString(), status: 'judged',
    reason: null, adapterReason: null, summary: '', error: '', adapterSteps: 0, reproduced: null, frameworkCost: null, gateway: null, wallMs: 0, setupMs: 0, harnessPaths: [...adapter.harnessPaths ?? []], diff: null,
    rules: { rejected: [], holds: [] }, guards: [], scriptsChanged: [], judge: null, success: false, passedWithoutDone: false,
  };
  partial.record = record;
  const setup = Date.now(), scratch = await mkdtemp(join(tmpdir(), 'bench-attempt-'));
  const box = await createBenchBox({ image: context.image, source: context.snapshot, root: paths.boxRoot, signal, onScope });
  let diff: Buffer | null = null, tooLarge = false, outcome: AttemptOutcome = { reason: 'error', steps: 0 }, timedOut = false;
  try {
    await adapter.prepare?.(box, signal);
    const boxUrl = adapter.inBox ? `${await box.attachGateway(gateway.port)}/api/v1` : undefined;
    record.setupMs = Date.now() - setup;
    let opened = null;
    while (!opened) {
      opened = await gateway.open({ attempt: `${cell.key}#${randomUUID().slice(0, 8)}`, model: model.id, cap: options.limits.cost, deadline: Date.now() + options.limits.timeMs, maxRequests: Math.ceil(options.limits.steps * 1.2) });
      if (!opened && !await room(gateway, options.limits.cost, signal)) return { ...record, status: 'skipped', skipped: 'budget' };
    }
    const timeout = AbortSignal.timeout(options.limits.timeMs + GRACE_MS), stop = AbortSignal.any([timeout, signal]), started = Date.now();
    try {
      outcome = await adapter.runAttempt({ box, system: context.system, prompt: context.prompt, failing: context.failing, base: context.sha, model, limits: options.limits, signal: stop, scratch,
        gateway: { baseUrl: gateway.url, ...(boxUrl ? { boxUrl } : {}), token: opened.token, provider, wire: wireOf(adapter, provider) ?? 'chat' }, log: event => { events.push({ ...event, at: Date.now() - started }); } });
    } catch (error) {
      if (signal.aborted) throw error;
      outcome = { reason: timeout.aborted ? 'time' : 'error', steps: 0, error: String((error as Error)?.message ?? error).slice(0, 1000) };
    }
    record.wallMs = Date.now() - started;
    timedOut = timeout.aborted || record.wallMs >= options.limits.timeMs;
    // From here the attempt has spent what the gateway counted: kept on the record and written out before anything
    // else can fail, as its change is once read.
    const { log: requests, attempt: _attempt, model: _model, cap: _cap, ...stats } = await gateway.close(opened.token);
    Object.assign(record, {
      gateway: stats, reason: finalReason(stats.firstRefusal, timedOut, outcome.reason), adapterReason: outcome.reason, summary: (outcome.summary ?? '').slice(0, 4000), error: (outcome.error ?? '').slice(0, 1000),
      adapterSteps: outcome.steps, reproduced: outcome.reproduced ?? null, frameworkCost: outcome.frameworkCost ?? null,
    });
    await writeArtifact(folder, 'gateway.json', { json: requests }, scrub);
    await writeArtifact(folder, 'events.json', { json: events }, scrub);
    if (record.harnessPaths.length) await box.exec(['rm', '-rf', '--', ...record.harnessPaths.map(path => `${box.root}/${path}`)], { timeoutMs: 60_000 });
    diff = await box.diff(context.sha).catch(error => { if ((error as { rejected?: unknown }).rejected) { tooLarge = true; return null; } throw error; });
    if (diff) { record.diff = diffStats(diff); await writeArtifact(folder, 'change.diff', diff, scrub); }
  } finally {
    await box.remove();
    await rm(scratch, { recursive: true, force: true });
  }
  const judged = tooLarge ? null : await judge({ c, snapshot: context.snapshot, sha: context.sha, diff: diff ?? Buffer.alloc(0), image: context.image, steps: context.job.steps, root: paths.boxRoot, signal, onScope });
  if (judged) {
    Object.assign(record, { rules: judged.rules, guards: judged.guards, scriptsChanged: judged.scriptsChanged,
      judge: { reason: judged.reason, detail: judged.detail, passed: judged.passed, ciPassed: judged.ciPassed, steps: judged.steps, ms: judged.ms } });
  } else record.judge = { reason: 'rule', detail: TOO_LARGE, passed: false, ciPassed: false, steps: [], ms: 0 };
  if (tooLarge) record.rules = { rejected: [TOO_LARGE], holds: [] };
  record.success = Boolean(judged?.passed) && record.reason === 'done';
  record.passedWithoutDone = Boolean(judged?.passed) && record.reason !== 'done';
  if (judged) await writeArtifact(folder, 'judge.json', { json: judged }, scrub);
  return record;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const list = (value: string | undefined) => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
function number(value: string | undefined, fallback: number, name: string, { min = 0, integer = false } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || integer && !Number.isInteger(parsed)) throw new Error(`--${name} must be ${integer ? 'a whole number' : 'a number'} of at least ${min}.`);
  return parsed;
}

async function main(argv: string[]) {
  const [command = 'help', ...rest] = argv;
  const { values } = parseArgs({ args: rest, allowPositionals: false, options: {
    frameworks: { type: 'string' }, models: { type: 'string' }, cases: { type: 'string' }, seeds: { type: 'string' }, concurrency: { type: 'string' }, budget: { type: 'string' },
    'attempt-cap': { type: 'string' }, steps: { type: 'string' }, minutes: { type: 'string' }, reasoning: { type: 'string' }, 'provider-only': { type: 'string' },
    'key-file': { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' }, all: { type: 'boolean' }, 'gateway-host': { type: 'string' }, provider: { type: 'string' },
  } });
  const cases = values.cases && values.cases !== 'all' ? list(values.cases) : 'all' as const;
  if (command === 'run') {
    // No key stays in this process's environment, where in-process frameworks could read it. OpenAI's comes only from
    // --key-file.
    const envKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const provider = (values.provider ?? 'openrouter') as Provider;
    if (!PROVIDERS.includes(provider)) throw new Error(`--provider is one of ${PROVIDERS.join(', ')}.`);
    if (provider === 'openai' && values['provider-only']) throw new Error('--provider-only routes OpenRouter; it does not apply to --provider openai.');
    const dryRun = Boolean(values['dry-run']), keyFile = values['key-file'] ? resolve(values['key-file']) : undefined;
    let models = values.models && values.models !== 'settings' ? list(values.models) : [];
    // A dry run on the OpenAI track uses the table's first model, so its dollars are what its fake usage would cost.
    if (!models.length) models = dryRun ? [provider === 'openai' ? Object.keys((await loadPrices()).models)[0] : FAKE_MODELS[0].id] : keyFile ? await keyFileModels(keyFile, provider) : [];
    if (!models.length) throw new Error('Name --models, or pass --key-file whose settings name a model.');
    const reasoning = (values.reasoning ?? 'default') as ReasoningPolicy;
    if (!REASONING.includes(reasoning)) throw new Error(`--reasoning is one of ${REASONING.join(', ')}.`);
    const frameworks = !values.frameworks || values.frameworks === 'all' ? 'all' as const : list(values.frameworks).map(key => {
      if (!ADAPTER_KEYS.includes(key as AdapterKey)) throw new Error(`Unknown framework ${key}. Frameworks: ${ADAPTER_KEYS.join(', ')}.`);
      return key as AdapterKey;
    });
    const stop = new AbortController();
    process.once('SIGINT', () => { console.error('Stopping: removing boxes…'); stop.abort(new Error('Stopped.')); process.once('SIGINT', () => process.exit(130)); });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await runBench({
      frameworks, models, cases, dryRun, reasoning, provider, signal: stop.signal,
      seeds: number(values.seeds, 1, 'seeds', { min: 1, integer: true }), concurrency: number(values.concurrency, 2, 'concurrency', { min: 1, integer: true }), budget: number(values.budget, 30, 'budget'),
      limits: { cost: number(values['attempt-cap'], LIMITS.cost, 'attempt-cap', { min: 0.01 }), steps: number(values.steps, LIMITS.steps, 'steps', { min: 1, integer: true }), timeMs: number(values.minutes, LIMITS.timeMs / 60_000, 'minutes', { min: 1 }) * 60_000 },
      out: values.out ?? join(BENCH, 'results', `${stamp}${dryRun ? '-dry' : ''}`), ...(values['provider-only'] ? { providerOnly: values['provider-only'] } : {}),
      ...(values['gateway-host'] ? { gatewayHost: values['gateway-host'] } : {}),
      ...(dryRun ? {} : { key: keyFile ? { file: keyFile } : envKey && provider === 'openrouter' ? { value: envKey } : undefined }),
    });
    return 0;
  }
  if (command === 'report') {
    if (!values.out) throw new Error('Name the run with --out.');
    const paths = resultPaths(resolve(values.out)), report = renderReport(await readRecords(paths.results));
    await writeFile(paths.report, report);
    console.log(report);
    return 0;
  }
  if (command === 'corpus-check') {
    await useBenchDocker();
    const unavailable = await dockerAvailable();
    if (unavailable) throw new Error(unavailable);
    const directory = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'bench-corpus-')), scopes: string[] = [];
    try {
      const checks = await checkCorpus(await loadCases(cases), { directory, root: join(directory, '.boxes'), concurrency: number(values.concurrency, 3, 'concurrency', { min: 1, integer: true }),
        onScope: scope => { scopes.push(scope); }, log: check => console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.case}: failed at ${check.failedAt} (${check.diagnosis}); reference ${check.reference.reason}; decoys ${check.decoys.map(decoy => `${decoy.patch.replace('decoys/', '')}=${decoy.reason}`).join(', ') || 'none'}${check.ok ? '' : `\n     ${check.problems.join('\n     ')}`}`) });
      return checks.every(check => check.ok) ? 0 : 1;
    } finally {
      await removeBenchResources(scopes).catch(() => {});
      if (!values.out) await rm(directory, { recursive: true, force: true });
    }
  }
  if (command === 'setup') {
    await useBenchDocker();
    const unavailable = await dockerAvailable();
    if (unavailable) throw new Error(unavailable);
    // The proxy's and relay's image, build-vendor's, and the box image each case's workflow picks.
    const images = new Set([EGRESS.image, 'node:22-bookworm', ...await Promise.all((await loadCases()).map(c => imageFor(c.repo)))]);
    for (const image of images) {
      if ((await docker(['image', 'inspect', image], 20_000)).exitCode === 0) { console.log(`${image}: present`); continue; }
      const pulled = await docker(['pull', image], 15 * 60_000);
      if (pulled.exitCode !== 0) throw new Error(`Could not pull ${image}: ${pulled.stderr.trim().split('\n')[0]}`);
      console.log(`${image}: pulled`);
    }
    for (const key of ADAPTER_KEYS) {
      const adapter = await ADAPTERS[key](), runs = Object.entries(adapter.providers ?? DEFAULT_PROVIDERS).map(([name, wire]) => `${name} over ${wire}`).join(', ');
      console.log(`${key}: ${await adapter.available() ?? `ready (${adapter.version})`}; ${runs}`);
    }
    return 0;
  }
  if (command === 'cleanup') {
    await useBenchDocker();
    if (!values.all && !values.out) throw new Error('Name the run with --out, or pass --all for every repair-bench container and network.');
    const scopes = values.all ? 'all' as const : await readScopes(resultPaths(resolve(values.out!)).boxes);
    const removed = await removeBenchResources(scopes);
    console.log(`removed ${removed.containers} containers and ${removed.networks} networks`);
    return 0;
  }
  console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then(text => text.split('\n').filter(line => line.startsWith('//   ')).map(line => line.slice(3)).join('\n')));
  return command === 'help' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`error: ${(error as Error).message}`); process.exitCode = 1; });
}
