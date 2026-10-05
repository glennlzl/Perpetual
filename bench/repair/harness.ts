// The one interface every framework under test implements, and the registry the runner loads adapters from. An adapter
// runs ONE attempt of its framework in a bench box that is exactly the product's repair box, with the product's
// prompt and INSTRUCTIONS, against the model gateway (its only model endpoint, reached with the attempt's token). The
// runner owns everything else: the box, the gateway's caps and accounting, the time limit, the diff and the judge. An
// adapter declares the providers it runs against and the wire API it speaks to each; the runner runs it only there.
import type { BenchBox } from './box.ts';
import type { Provider, WireApi } from './gateway.ts';
import { priceFor, type PriceTable } from './prices.ts';

export type { Provider, WireApi } from './gateway.ts';

export type AdapterKey = 'aisdk' | 'pi' | 'opencode' | 'miniswe' | 'openai-agents' | 'aisdk-openai' | 'agents-openai' | 'codex';
export const ADAPTER_KEYS: readonly AdapterKey[] = ['aisdk', 'pi', 'opencode', 'miniswe', 'openai-agents', 'aisdk-openai', 'agents-openai', 'codex'];
export interface ModelInfo { id: string; contextWindow: number; maxOutput: number; reasoning: boolean }
/**
 * The gateway as a framework sees it: its base URL on the host, the one a box reaches once attached, the token, and
 * the run's provider with the wire API this adapter declared for it (absent: OpenRouter over chat completions).
 */
export interface GatewayAccess { baseUrl: string; boxUrl?: string; token: string; provider?: Provider; wire?: WireApi }
export interface AttemptLimits { steps: number; timeMs: number; cost: number }
export const LIMITS: AttemptLimits = { steps: 100, timeMs: 15 * 60_000, cost: 0.5 };
export interface AttemptEvent { type: string; [key: string]: unknown }
export interface AttemptInput {
  box: BenchBox;
  /** The product's INSTRUCTIONS, verbatim; frameworks with their own system prompt append it (see harnessNote). */
  system: string;
  /** The product's attemptPrompt for the case, byte for byte. */
  prompt: string;
  /** The failing steps' run scripts, for the product's reproduced rule. */
  failing: readonly string[];
  /** The case's commit the box holds, against which the product's loop reads a change made through a command. */
  base?: string;
  model: ModelInfo; gateway: GatewayAccess; limits: AttemptLimits; signal: AbortSignal;
  /** A private (0700) host folder of this attempt's own, removed after it. */
  scratch: string;
  /** Events for the attempt's log; the runner scrubs and stores them. */
  log(event: AttemptEvent): void;
}
/** How an attempt ended in the framework's own terms. */
export type AttemptEnd = 'done' | 'steps' | 'time' | 'cost' | 'idle' | 'context' | 'provider' | 'error';
export interface AttemptOutcome { reason: AttemptEnd; steps: number; summary?: string; error?: string; reproduced?: boolean | null; frameworkCost?: number }
export interface Adapter {
  key: AdapterKey;
  /** The framework and version under test, such as ai@7.0.114. */
  version: string;
  /** Whether the framework runs inside the box, so the runner attaches the gateway relay before the attempt. */
  inBox: boolean;
  /**
   * The providers it runs against and the wire API it speaks to each: chat completions, or OpenAI's Responses. The
   * runner refuses any other provider. Absent: DEFAULT_PROVIDERS.
   */
  providers?: Partial<Record<Provider, WireApi>>;
  /** Why it cannot run here, such as a missing binary; null when it can. */
  available(): Promise<string | null>;
  /** Untimed setup in the box before the attempt, such as copying a harness binary outside /workspace. */
  prepare?(box: BenchBox, signal: AbortSignal): Promise<void>;
  /** Paths under /workspace the harness itself writes; removed before the diff and reported. */
  harnessPaths?: readonly string[];
  runAttempt(input: AttemptInput): Promise<AttemptOutcome>;
}

/** What an adapter that declares no providers runs against: OpenRouter over chat completions. */
export const DEFAULT_PROVIDERS: Readonly<Partial<Record<Provider, WireApi>>> = { openrouter: 'chat' };
/** The wire API an adapter speaks to a provider, or null when it does not run against it. */
export const wireOf = (adapter: Pick<Adapter, 'providers'>, provider: Provider): WireApi | null => (adapter.providers ?? DEFAULT_PROVIDERS)[provider] ?? null;

/** What a framework with its own tuned system prompt is told after INSTRUCTIONS, so "done" means the same everywhere. */
const NOTES: Partial<Record<AdapterKey, string>> = {
  pi: 'In this harness your tools are read, bash, edit and write; call the done tool with the summary when you finish.',
  opencode: 'In this harness, "call done" means ending your turn with the summary as your final message.',
  miniswe: 'In this harness, "call done" means running `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` with the summary on the lines after it.',
  codex: 'In this harness, "call done" means ending your turn with the summary as your final message.',
};
export const harnessNote = (key: AdapterKey) => NOTES[key] ?? '';
/** INSTRUCTIONS as a framework with its own system prompt receives them: verbatim, then the harness note. */
export const appendedInstructions = (key: AdapterKey, system: string) => NOTES[key] ? `${system}\n\n${NOTES[key]}` : system;

/** Adapters load lazily, so a framework's dependencies load only when it is selected. */
export const ADAPTERS: Record<AdapterKey, () => Promise<Adapter>> = {
  aisdk: () => import('./adapters/aisdk/index.ts').then(module => module.adapter),
  pi: () => import('./adapters/pi/index.ts').then(module => module.adapter),
  opencode: () => import('./adapters/opencode/index.ts').then(module => module.adapter),
  miniswe: () => import('./adapters/miniswe/index.ts').then(module => module.adapter),
  'openai-agents': () => import('./adapters/openai-agents/index.ts').then(module => module.adapter),
  'aisdk-openai': () => import('./adapters/aisdk-openai/index.ts').then(module => module.adapter),
  'agents-openai': () => import('./adapters/agents-openai/index.ts').then(module => module.adapter),
  codex: () => import('./adapters/codex/index.ts').then(module => module.adapter),
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/**
 * Model metadata, validated as unknown: from an OpenRouter-shaped /models listing at a base URL (public; no key), or,
 * for bare OpenAI ids, from the OpenAI track's price table, since OpenAI's own listing needs a key and names no limits.
 */
export async function modelInfo(ids: readonly string[], source: string | PriceTable, fetcher: typeof fetch = fetch): Promise<Map<string, ModelInfo>> {
  const found = new Map<string, ModelInfo>();
  if (typeof source !== 'string') {
    for (const id of ids) {
      const price = priceFor(source, id);
      if (!price) throw new Error(`prices/openai.json lists no model ${id}; the OpenAI track runs only priced models.`);
      found.set(id, { id, contextWindow: price.contextWindow, maxOutput: price.maxOutput, reasoning: price.reasoning });
    }
    return found;
  }
  const response = await fetcher(`${source.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not read the model list (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const listed = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  for (const id of ids) {
    const model = listed.find(item => item.id === id);
    if (!model) throw new Error(`OpenRouter lists no model ${id}.`);
    const top = isRecord(model.top_provider) ? model.top_provider : {}, parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    const contextWindow = number(model.context_length, 128_000);
    found.set(id, { id, contextWindow, maxOutput: number(top.max_completion_tokens, Math.min(32_000, contextWindow)), reasoning: parameters.includes('reasoning') });
  }
  return found;
}
