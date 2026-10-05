// The OpenAI track's AI SDK arm: the product's own attempt loop (runAttempt in src/repair/agent.ts: an AI SDK tool loop
// on the host with the product's seven repair tools acting in the box), called exactly as the aisdk baseline calls it,
// with @ai-sdk/openai's Responses model in place of the product's OpenRouter factory. The model reaches the gateway's
// Responses route for provider openai, POST {baseUrl}/responses, with the attempt's token as its key; its fetch refuses
// anything else. The one setting this arm adds is store: false, as an AI SDK default setting on every call, so each
// turn resends the whole conversation and nothing is kept at OpenAI; previous_response_id is never used. For a model
// the provider knows reasons, the provider then asks for reasoning as encrypted content (include
// reasoning.encrypted_content) and sends those items back on the next turn. The product's tools go out unchanged: the
// provider sends a function tool that leaves strictness unset, as the product's do, with strict: false, so their
// optional parameters stay optional. OpenAI reports no dollar cost: the gateway prices each request's usage and
// enforces the cap, the loop's own cost stop (it reads OpenRouter's reported cost) never fires here, and no framework
// cost is reported. The loop's `ai` resolves from the root node_modules, as the product runs it.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { runAttempt } from '../../../../src/repair/agent.ts';
import type { Adapter, AttemptOutcome, GatewayAccess } from '../../harness.ts';

let loading: Promise<typeof import('@ai-sdk/openai')> | null = null;
/** @ai-sdk/openai on first use, so a bench installed without it still loads this adapter and says why it cannot run. */
const provider = () => loading ??= import('@ai-sdk/openai');
const STATELESS = defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } });

/** A fetch that allows only POST {baseUrl}/responses, the one call this arm makes, and refuses anything else. */
export function responsesOnly(baseUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const target = `${baseUrl.replace(/\/+$/, '')}/responses`;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null, url = request ? request.url : String(input), method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url !== target || method !== 'POST') { const { origin, pathname } = new URL(url); throw new Error(`The Responses arm reaches only POST ${target}, not ${method} ${origin}${pathname}.`); }
    return fetcher(input, init);
  }) as typeof fetch;
}

/** The attempt's model: @ai-sdk/openai's Responses model for id at the gateway, with the attempt's token as its key, stateless. */
export async function responsesModel(id: string, gateway: GatewayAccess, fetcher?: typeof fetch) {
  const { createOpenAI } = await provider();
  const model = createOpenAI({ apiKey: gateway.token, baseURL: gateway.baseUrl, fetch: responsesOnly(gateway.baseUrl, fetcher) }).responses(id);
  return wrapLanguageModel({ model, middleware: STATELESS });
}

/** A package's version as it resolves from a module. */
async function version(from: string | URL, name: string) {
  const parsed: unknown = JSON.parse(await readFile(createRequire(from).resolve(`${name}/package.json`), 'utf8'));
  return parsed !== null && typeof parsed === 'object' && 'version' in parsed ? String(parsed.version) : 'unknown';
}
/** The versions this arm runs: the loop's `ai`, as it resolves from src/repair, and this adapter's @ai-sdk/openai. */
const versions = async () => `ai@${await version(new URL('../../../../src/repair/agent.ts', import.meta.url), 'ai')} + @ai-sdk/openai@${await version(import.meta.url, '@ai-sdk/openai')}`;

export const adapter: Adapter = {
  key: 'aisdk-openai', version: await versions().catch(() => 'ai (product) + @ai-sdk/openai (not installed)'), inBox: false, providers: { openai: 'responses' },
  async available() { return provider().then(() => null, () => '@ai-sdk/openai is not installed; run npm ci in bench/repair.'); },
  async runAttempt({ box, system, prompt, failing, base, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    const result = await runAttempt({ model: await responsesModel(model.id, gateway), box, instructions: system, prompt, signal, failing, base, steps: limits.steps, timeoutMs: limits.timeMs, budget: limits.cost });
    log({ type: 'attempt', end: result.end, steps: result.steps, inputTokens: result.inputTokens, outputTokens: result.outputTokens, reproduced: result.reproduced, ...(result.refusal ? { refusal: result.refusal } : {}) });
    return { reason: result.end, steps: result.steps, summary: result.summary, reproduced: result.reproduced, ...(result.error ? { error: result.error } : {}) };
  },
};
