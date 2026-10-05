// The baseline adapter without Docker or a model: the product's own attempt loop, pointed at the gateway through its
// OpenRouter factory's fetch, drives the product's tools in a host-folder box double (the product's test fixture) from
// scripted fake-upstream replies, and the gateway accounts for every step.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { adapter, gatewayFetch } from '../adapters/aisdk/index.ts';
import type { BenchBox } from '../box.ts';
import { FAKE_KEY, createFakeUpstream, type FakeReply } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS } from '../harness.ts';
import { finalReason } from '../run.ts';

const MODEL = { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
async function setup(t: TestContext, replies: FakeReply[], { cap = 0.5 } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'bench-aisdk-'));
  const sha = await brokenRepository(source);
  const made = await hostBox(source);
  const upstream = await createFakeUpstream({ script: (_body, index) => replies[index] ?? { text: 'Finished.' } });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 5, upstream: upstream.url });
  t.after(async () => { await made.box.remove(); await gateway.stop(); await upstream.stop(); await rm(source, { recursive: true, force: true }); });
  const opened = await gateway.open({ attempt: 'aisdk', model: MODEL.id, cap, deadline: Date.now() + 60_000 });
  // The runner names the case's commit, as the product names the failing one.
  const run = (limits = LIMITS) => adapter.runAttempt({ box: made.box as unknown as BenchBox, system: 'Fix it.', prompt: 'Repository acme/app. Fix the build.', failing: ['node check.js'], base: sha, model: MODEL,
    gateway: { baseUrl: gateway.url, token: opened!.token }, limits, signal: new AbortController().signal, scratch: source, log: () => {} });
  return { made, upstream, gateway, token: opened!.token, run };
}

test('the fetch sends OpenRouter\'s API to the gateway and nothing else anywhere', async () => {
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request) => { seen.push(input instanceof Request ? input.url : String(input)); return new Response('{}'); }) as typeof fetch;
  const routed = gatewayFetch('http://127.0.0.1:1234/api/v1/', fetcher);
  await routed('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
  await routed(new Request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }));
  assert.deepEqual(seen, ['http://127.0.0.1:1234/api/v1/chat/completions', 'http://127.0.0.1:1234/api/v1/chat/completions']);
  await assert.rejects(routed('https://example.com/steal'), /only OpenRouter's API/);
});

test('the product\'s loop reproduces, edits, verifies and ends at done through the gateway, which counts every step', async t => {
  const f = await setup(t, [
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'edit', arguments: { path: 'add.js', old: 'a - b', new: 'a + b' } }], cost: 0.01 },
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'done', arguments: { summary: 'add() subtracted; node check.js passes.' } }], cost: 0.01 },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary], ['done', 4, true, 'add() subtracted; node check.js passes.']);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.toolCalls], [4, 4]);
  assert.ok(Math.abs(usage.cost - 0.04) < 1e-9 && Math.abs((outcome.frameworkCost ?? 0) - 0.04) < 1e-9, 'The product and the gateway read the same cost.');
  const bodies = f.upstream.received.filter(item => item.path === '/api/v1/chat/completions');
  assert.ok(bodies.every(item => item.authorization === `Bearer ${FAKE_KEY}`));
  const first = bodies[0].body as { provider: unknown; usage: unknown; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };
  assert.deepEqual([first.provider, first.usage], [{ data_collection: 'deny' }, { include: true }]);
  assert.deepEqual(first.tools.map(tool => tool.function.name).sort(), ['done', 'edit', 'grep', 'list', 'read', 'run', 'write']);
  assert.equal(first.messages[0].role, 'system');
});

// The arm measures the product's ending: a model that fixes the build through a command and stops with a message ends
// done once the failing step passes in the box, as the product's attempt does.
test('the product\'s loop counts a change made through run, and ends done once the failing step passes', async t => {
  const f = await setup(t, [{ calls: [{ name: 'run', arguments: { command: 'sed -i.bak "s/a - b/a + b/" add.js && rm add.js.bak' } }], cost: 0.01 }]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.summary], ['done', 'The model stopped without calling done; the failing step\'s own command then passed in the box.']);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
});

test('the product\'s own cost stop ends the attempt at its cap, and a gateway refusal outranks the loop\'s own reason', async t => {
  const f = await setup(t, Array.from({ length: 5 }, () => ({ calls: [{ name: 'run', arguments: { command: 'true' } }], cost: 0.3 })));
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps], ['cost', 2]);
  const refused = await setup(t, [{ calls: [{ name: 'run', arguments: { command: 'true' } }], cost: 0.3 }, { calls: [{ name: 'run', arguments: { command: 'true' } }], cost: 0.3 }], { cap: 0.2 });
  const cut = await refused.run({ ...LIMITS, cost: 5 });
  const usage = await refused.gateway.close(refused.token);
  assert.equal(cut.reason, 'provider');
  assert.match(cut.error ?? '', /402|Bench limit/);
  assert.deepEqual([usage.firstRefusal, finalReason(usage.firstRefusal, false, cut.reason)], ['cost', 'cost']);
  assert.equal(finalReason(null, true, 'done'), 'time');
  assert.equal(finalReason('requests', false, 'provider'), 'steps');
  assert.equal(finalReason(null, false, 'idle'), 'idle');
});
