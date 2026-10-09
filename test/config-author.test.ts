import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from 'ai';
import { authorStructuredConfig } from '../src/twin/config-author.ts';
import { decisionSchema } from '../src/twin/config-decisions.ts';
import { services as registry } from '../src/twin/registry.ts';
import type { AuthoringOptions } from '../src/twin/authoring.ts';
import { scriptedModel } from './fixtures/scripted-model.ts';

const KEY = 'sk-or-v1-fixture-config-author-key-7294';
const config = { services: {}, apps: { web: { directory: '.', start: 'node app.js', port: 3000, env: {} } }, fixtures: [] };
const draft = JSON.stringify(config);
const change = (path: string[], value: unknown) => ({ path, value: JSON.stringify(value) });
const response = (changes: ReturnType<typeof change>[], blockers: string[] = []) => ({ text: JSON.stringify({ changes, blockers }) });
const textOf = (value: unknown) => JSON.stringify(value);

async function options(t: TestContext, extra: Partial<AuthoringOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-config-author-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), workspace = join(root, 'workspace');
  await mkdir(source); await mkdir(workspace);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@acme/web', scripts: { start: 'node app.js' } }));
  await writeFile(join(source, 'app.js'), 'const endpoint = process.env.API_URL;\nfetch(endpoint);\n');
  return { workspace, source, draft, evidence: '## Runtime usage\n`app.js:1`\n', model: 'vendor/model', apiKey: KEY, services: {}, ...extra } satisfies AuthoringOptions;
}

test('one structured request yields a locally validated candidate without tools or source writes', async t => {
  const input = await options(t);
  const model = scriptedModel([response([change(['apps', 'web', 'env'], { API_URL: '{{apps.web.publicUrl}}' })])]);
  const result = await authorStructuredConfig(input, model).promise;
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.text!), { ...config, apps: { web: { ...config.apps.web, env: { API_URL: '{{apps.web.publicUrl}}' } } } });
  assert.equal(model.doGenerateCalls.length, 1);
  const [call] = model.doGenerateCalls;
  assert.equal(call.tools?.length ?? 0, 0);
  assert.equal(call.responseFormat?.type, 'json');
  assert.match(textOf(call.prompt), /process\.env\.API_URL/);
  assert.ok(!textOf(call).includes(KEY));
  assert.equal(await readFile(join(input.source, 'app.js'), 'utf8'), 'const endpoint = process.env.API_URL;\nfetch(endpoint);\n');
  assert.deepEqual(await readdir(input.workspace), []);
  assert.deepEqual(result.timings?.map(entry => [entry.phase, entry.outcome]), [['context', 'completed'], ['model', 'completed'], ['validation', 'completed']]);
  const measurement = result.timings?.find(entry => entry.phase === 'model');
  assert.equal(measurement?.inputTokens, 100);
  assert.equal(measurement?.outputTokens, 20);
  for (const entry of result.timings ?? []) assert.ok(Number.isFinite(entry.ms) && entry.ms >= 0);
});

test('bounded evidence and missing catalog credentials still produce valid placeholder wiring', async t => {
  const initial = { ...config, services: { stripe: {} } };
  const input = await options(t, {
    draft: JSON.stringify(initial), services: registry,
    requiredInputAvailability: [{ service: 'stripe', inputs: [{ name: 'secretKey', availability: 'missing' }] }],
  });
  const model = scriptedModel([response([change(['apps', 'web', 'env'], { STRIPE_SECRET_KEY: '{{stripe.STRIPE_SECRET_KEY}}' })])]);
  const result = await authorStructuredConfig(input, model).promise;
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.text!), { ...initial, apps: { web: { ...config.apps.web, env: { STRIPE_SECRET_KEY: '{{stripe.STRIPE_SECRET_KEY}}' } } } });
  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0];
  assert.match(textOf(call), /existing startup config/);
  assert.match(textOf(call), /bounded repository/);
  assert.match(textOf(call), /do not claim to have exhausted the repository/i);
  assert.match(textOf(call), /missing required.*preparation blocker/i);
  assert.match(textOf(call.prompt), /secretKey=missing/);
  assert.match(JSON.stringify(decisionSchema), /preparation blockers/);
  assert.match(JSON.stringify(decisionSchema), /placeholder wiring/);
});

test('one correction is validated against the original draft instead of retaining edits from the rejected reply', async t => {
  const input = await options(t);
  const first = response([change(['apps', 'web', 'env'], { SHOULD_NOT_SURVIVE: 'ordinary-value' }), change(['apps', 'web', 'port'], -1)]);
  const second = response([change(['apps', 'web', 'port'], 3100)]);
  const model = scriptedModel([first, second]);
  const result = await authorStructuredConfig(input, model).promise;
  assert.equal(result.error, undefined);
  assert.equal(model.doGenerateCalls.length, 2);
  const written = JSON.parse(result.text!);
  assert.equal(written.apps.web.port, 3100);
  assert.deepEqual(written.apps.web.env, {});
  assert.deepEqual(result.timings?.filter(item => item.phase === 'validation').map(item => item.outcome), ['failed', 'completed']);
  assert.match(textOf(model.doGenerateCalls[1].prompt), /local validation/);
  for (const call of model.doGenerateCalls) assert.equal(call.tools?.length ?? 0, 0);
});

test('two locally invalid decisions stop without creating a candidate or a third model request', async t => {
  const model = scriptedModel([response([change(['apps', 'web', 'port'], -1)]), response([change(['apps', 'web', 'port'], 'unknown')])]);
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(result.terminal, true);
  assert.equal(model.doGenerateCalls.length, 2);
});

test('unresolved evidence is a blocker, not an invitation to drop the blocker on a second attempt', async t => {
  const model = scriptedModel([response([], ['The callback origin cannot be determined from the supplied source.']), response([])]);
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.match(result.error ?? '', /callback origin/);
  assert.equal(result.text, undefined);
  assert.equal(result.terminal, true);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('provider failures are redacted and never retried, even if the provider marks them retryable', async t => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => { throw new APICallError({ message: `Temporarily unavailable ${KEY}`, url: 'https://provider.example.test/chat', requestBodyValues: {}, statusCode: 503, isRetryable: true }); },
  });
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.ok(result.error);
  assert.ok(!textOf(result).includes(KEY));
  assert.equal(result.text, undefined);
  assert.equal(result.terminal, true);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(result.timings?.find(entry => entry.phase === 'model')?.outcome, 'failed');
});

test('credential literals in the original draft are refused before source or model work', async t => {
  const secret = 'opaque-config-secret-719244';
  const input = await options(t, { draft: JSON.stringify({ ...config, apps: { web: { ...config.apps.web, env: { SESSION_SECRET: secret } } } }), secrets: [secret] });
  const model = scriptedModel([response([])]);
  const result = await authorStructuredConfig(input, model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.ok(!textOf(result).includes(secret));
});

test('credential literals returned by the model are refused without echoing or retrying them', async t => {
  const secret = 'ghp_generated_config_secret_936144';
  const model = scriptedModel([response([change(['apps', 'web', 'env'], { SESSION_SECRET: secret })]), response([])]);
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(result.terminal, true);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.ok(!textOf(result).includes(secret));
});

test('scoped repair receives its redacted failure evidence and preserves unrelated config', async t => {
  const secret = 'opaque-logged-secret-64412';
  const input = await options(t, {
    feedback: `Application exited: missing entry app.js; actual script is server.js. Supplied value: ${secret}`,
    secrets: [secret], repair: { stage: 'build', subject: 'App `web` exited' },
  });
  await writeFile(join(input.source, 'server.js'), 'console.log("fixture server");');
  const model = scriptedModel([response([change(['apps', 'web', 'start'], 'node server.js')])]);
  const result = await authorStructuredConfig(input, model).promise;
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(result.text!).apps.web.start, 'node server.js');
  assert.match(textOf(model.doGenerateCalls[0].prompt), /missing entry app\.js/);
  assert.ok(!textOf(model.doGenerateCalls[0]).includes(secret));
});

test('a cancelled request has an actual cancellation measurement and no candidate', async t => {
  let requested!: () => void;
  const inModel = new Promise<void>(resolve => { requested = resolve; });
  const model = scriptedModel([{ hang: true }], { onCall: requested });
  const job = authorStructuredConfig(await options(t), model);
  await inModel;
  job.cancel();
  const result = await job.promise;
  assert.equal(result.text, undefined);
  assert.match(result.error ?? '', /cancelled/i);
  assert.equal(result.timedOut, undefined);
  assert.equal(model.doGenerateCalls.length, 1);
  const measurement = result.timings?.find(entry => entry.phase === 'model');
  assert.equal(measurement?.outcome, 'cancelled');
  assert.ok(typeof measurement?.ms === 'number' && measurement.ms >= 0);
});

test('an exhausted budget starts no model request', async t => {
  const model = scriptedModel([response([])]);
  const result = await authorStructuredConfig(await options(t, { timeoutMs: 0 }), model).promise;
  assert.equal(result.text, undefined);
  assert.equal(result.timedOut, true);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.deepEqual(result.timings, []);
});

test('a request that exceeds the shared time budget stops and records its elapsed model time', async t => {
  const model = scriptedModel([{ hang: true }]);
  const result = await authorStructuredConfig(await options(t, { timeoutMs: 300 }), model).promise;
  assert.equal(result.text, undefined);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminal, true);
  assert.equal(model.doGenerateCalls.length, 1);
  const measurement = result.timings?.find(entry => entry.phase === 'model');
  assert.equal(measurement?.outcome, 'timed-out');
  assert.ok(typeof measurement?.ms === 'number' && measurement.ms > 0);
  assert.equal(result.timings?.some(entry => entry.phase === 'validation'), false);
});

test('truncated structured output is refused even if its partial text happens to parse as a valid decision', async t => {
  const delegate = scriptedModel([response([])]);
  const model = new MockLanguageModelV4({ doGenerate: async request => ({ ...await delegate.doGenerate(request), finishReason: { unified: 'length', raw: undefined } }) });
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(result.terminal, true);
});

test('a malformed model response cannot start a tool loop or a broad fallback investigation', async t => {
  const model = scriptedModel([{ text: 'I need to inspect the repository further.' }, response([])]);
  const result = await authorStructuredConfig(await options(t), model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(result.terminal, true);
});

test('cancellation before the source packet completes starts no model request', async t => {
  const model = scriptedModel([response([])]);
  const job = authorStructuredConfig(await options(t), model);
  job.cancel();
  const result = await job.promise;
  assert.equal(result.text, undefined);
  assert.match(result.error ?? '', /cancelled/i);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('a supplied secret encoded inside a decision JSON value is refused before a correction request', async t => {
  const secret = 'opaque-supplied-config-value-62317';
  const escaped = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const decision = { changes: [{ path: ['apps', 'web', 'env'], value: `{"CUSTOM":"${escaped}"}` }], blockers: [] };
  const model = scriptedModel([{ text: JSON.stringify(decision) }, response([])]);
  const result = await authorStructuredConfig(await options(t, { secrets: [secret] }), model).promise;
  assert.ok(result.error);
  assert.equal(result.text, undefined);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(result.terminal, true);
  assert.ok(!textOf(result).includes(secret));
  assert.ok(!textOf(model.doGenerateCalls).includes(secret));
  assert.ok(!textOf(model.doGenerateCalls).includes(escaped));
});

test('a correction cannot alter another app or service when the failed decision concerned only one app', async t => {
  const initial = { ...config, apps: { ...config.apps, api: { ...config.apps.web, port: 3100 } } };
  for (const unrelated of [change(['apps', 'api', 'start'], 'node unrelated.js'), change(['services'], {})]) {
    const model = scriptedModel([response([change(['apps', 'web', 'port'], -1)]), response([change(['apps', 'web', 'port'], 3200), unrelated])]);
    const result = await authorStructuredConfig(await options(t, { draft: JSON.stringify(initial) }), model).promise;
    assert.match(result.error ?? '', /unrelated/i);
    assert.equal(result.text, undefined);
    assert.equal(result.terminal, true);
    assert.equal(model.doGenerateCalls.length, 2);
  }
});

test('runtime failures without a supported app repair scope stop before invoking the model', async t => {
  for (const repair of [
    { stage: 'build', subject: 'Service `database` failed' },
    { stage: 'build', subject: 'App `missing` exited' },
    { stage: 'account', subject: 'App `web` has no login fixture' },
    { stage: 'healthy' },
  ]) {
    const model = scriptedModel([response([])]);
    const result = await authorStructuredConfig(await options(t, { repair }), model).promise;
    assert.ok(result.error);
    assert.equal(result.text, undefined);
    assert.equal(result.terminal, true);
    assert.equal(model.doGenerateCalls.length, 0);
  }
});
