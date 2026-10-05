// The baseline: the product's own attempt loop (runAttempt in src/repair/agent.ts: an AI SDK tool loop on the host
// with the product's seven repair tools acting in the box) and its own OpenRouter model factory, unchanged. Only the
// transport differs: the factory's fetch sends OpenRouter's URL to the gateway instead, with the attempt's token as the
// key. The product's `ai` and `@openrouter/ai-sdk-provider` resolve from the root node_modules, as the product runs.
import { readFile } from 'node:fs/promises';
import { openrouterModels, runAttempt } from '../../../../src/repair/agent.ts';
import type { Adapter, AttemptOutcome } from '../../harness.ts';

const OPENROUTER = 'https://openrouter.ai/api/v1';

/** A fetch that sends requests for OpenRouter's API to baseUrl, and refuses anything else. */
export function gatewayFetch(baseUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const base = baseUrl.replace(/\/+$/, '');
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null, url = request ? request.url : String(input);
    if (!url.startsWith(`${OPENROUTER}/`)) throw new Error(`The baseline reaches only OpenRouter's API through the gateway, not ${new URL(url).origin}.`);
    const target = `${base}${url.slice(OPENROUTER.length)}`;
    return request ? fetcher(new Request(target, request), init) : fetcher(target, init);
  }) as typeof fetch;
}

/** The versions the baseline runs: the product's `ai` and OpenRouter provider, as they resolve from src/repair. */
async function versions() {
  const version = async (name: string) => {
    const parsed: unknown = JSON.parse(await readFile(new URL(`../../../../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && 'version' in parsed ? String(parsed.version) : 'unknown';
  };
  return `ai@${await version('ai')} + @openrouter/ai-sdk-provider@${await version('@openrouter/ai-sdk-provider')}`;
}

export const adapter: Adapter = {
  key: 'aisdk', version: await versions().catch(() => 'ai (product)'), inBox: false,
  async available() { return null; },
  async runAttempt({ box, system, prompt, failing, base, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    const factory = openrouterModels({ fetch: gatewayFetch(gateway.baseUrl) });
    // base: as in the product, a change made through run counts when the model stops without calling done.
    const result = await runAttempt({ model: factory(model.id, gateway.token), box, instructions: system, prompt, signal, failing, base, steps: limits.steps, timeoutMs: limits.timeMs, budget: limits.cost });
    log({ type: 'attempt', end: result.end, steps: result.steps, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost, reproduced: result.reproduced, ...(result.refusal ? { refusal: result.refusal } : {}) });
    return { reason: result.end, steps: result.steps, summary: result.summary, reproduced: result.reproduced, frameworkCost: result.cost, ...(result.error ? { error: result.error } : {}) };
  },
};
