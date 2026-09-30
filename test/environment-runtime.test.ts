import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentRuntime, environmentInputs } from '../src/environments/runtime.ts';
import { createTwinInputs } from '../src/twin/index.ts';
import { createBrowserModelSettings } from '../src/browser/model.ts';
import type { EnvironmentTwin } from '../src/environments/runtime.ts';
import type { PreparedTwin, TwinRuntime } from '../src/twin/index.ts';
import { services as fixtureServices } from './fixtures/twin/services.ts';

type Call = [operation: string, input: Partial<Parameters<TwinRuntime['prepare']>[0]>];
type Health = Awaited<ReturnType<EnvironmentTwin['health']>>;
// A twin runtime with only the calls a test expects; any other call fails as it would without it.
const only = (calls: Partial<EnvironmentTwin>) => calls as EnvironmentTwin;

const STRIPE_KEY = 'sk_test_environment_fixture';
const plan = { services: { mailpit: {}, stripe: {} }, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000, env: {} } }, fixtures: [] };
const twinResult = {
  status: 'blocked',
  services: [{ id: 'mailpit', fidelity: 'actual', status: 'ready' }, { id: 'stripe', fidelity: 'official-sandbox', status: 'blocked', missing: ['secretKey'] }],
  apps: [{ id: 'web', url: 'http://host.docker.internal:43100', directory: '.' }],
} satisfies PreparedTwin;

// Only the twin runtime (Docker Compose) and the Cua guest deletion are substituted.
// Source snapshots, stored inputs and App Settings are real files.
async function setup(t: TestContext, twin: Partial<EnvironmentTwin> = {}) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-environment-runtime-')));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repoPath = join(dataDir, 'repo'), directory = join(dataDir, 'environments', 'environment-1');
  await mkdir(repoPath); await mkdir(directory, { recursive: true });
  await writeFile(join(repoPath, 'app.mjs'), 'export const app = true;\n');
  await writeFile(join(repoPath, '.env'), 'STRIPE_SECRET_KEY=never-copied\n');
  const calls: Call[] = [];
  const fake: EnvironmentTwin = {
    prepare: async input => { calls.push(['prepare', input]); await input.onStep?.('Setting up Mailpit'); return structuredClone(twinResult); },
    health: async input => { calls.push(['health', input]); return { status: 'ready', containers: [] }; },
    logs: async input => { calls.push(['logs', input]); return 'web | listening\n'; },
    destroy: async input => { calls.push(['destroy', input]); return { status: 'destroyed' }; },
    ...twin,
  };
  // Every app answers on its twin address; nothing listens there in a test.
  const runtime = createEnvironmentRuntime({ twin: fake, destroyCuaGuest: async input => { calls.push(['guest', input]); }, answers: async () => 200 });
  const environment = { id: 'environment-1', plan };
  return { dataDir, repoPath, directory, calls, runtime, environment };
}

test('generation protects its first author observation with stored inputs before any service is provisioned', async t => {
  const f = await setup(t), secret = `fixture-private-${'q'.repeat(350)}`, key = 'sk-or-v1-fixture-generation-observation', refreshes: boolean[] = [];
  const draft = JSON.stringify({ services: { payments: {} }, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const manifest = JSON.stringify({ name: 'acme-app', packageManager: `npm@11 ${secret}`, scripts: { start: `echo ${secret}` } });
  await writeFile(join(f.repoPath, 'package.json'), manifest);
  let authored = false, ranSource = '';
  const runtime = createEnvironmentRuntime({ services: fixtureServices,
    inputs: async ({ refresh = true }) => { refreshes.push(refresh); return { payments: { PAYMENTS_KEY: secret } }; },
    author: options => {
      authored = true;
      assert.ok(!options.evidence.includes('fixture-private-'), 'A secret is hidden before package-manager or command text is clipped.');
      assert.deepEqual(refreshes, [false], 'Observation preparation reads inputs without renewing or creating a sandbox.');
      assert.ok('secrets' in options);
      assert.deepEqual([...options.secrets as Iterable<unknown>].sort(), [key, secret].sort());
      return { promise: Promise.resolve({ text: draft }), cancel() {} };
    },
    twin: only({ async prepare({ source, inputs }) {
      ranSource = await readFile(join(source, 'package.json'), 'utf8');
      assert.equal(inputs?.payments.PAYMENTS_KEY, secret, 'Execution still receives the actual service input.');
      return { services: [{ id: 'payments', fidelity: 'official-sandbox', status: 'ready' }], apps: [{ id: 'web', url: 'http://127.0.0.1:43000/' }] };
    } }), answers: async () => 200,
  });
  const result = await runtime.prepareEnvironment({ dataDir: f.dataDir, repoPath: f.repoPath, directory: f.directory,
    environment: { id: 'environment-1', plan: JSON.parse(draft) }, generate: { model: { apiKey: key, model: 'vendor/model' }, draft },
    onUpdate: async () => {}, cancelled: () => false });
  assert.equal(result.status, 'ready');
  assert.ok(authored);
  assert.equal(ranSource, manifest, 'The executed source snapshot is not the protected author copy.');
  assert.equal(await readFile(join(f.repoPath, 'package.json'), 'utf8'), manifest);
  assert.deepEqual(refreshes, [false, true]);
});

test('author retries keep retired input values private and rebuild evidence when supplied values change', async t => {
  const f = await setup(t), retired = 'fixture-retired-value-7310', renewed = `fixture-renewed-${'q'.repeat(350)}`;
  const draft = JSON.stringify({ services: { payments: {} }, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const source = `export const configured = ${JSON.stringify(retired)};\n`;
  await writeFile(join(f.repoPath, 'app.mjs'), source);
  await writeFile(join(f.repoPath, 'package.json'), JSON.stringify({ name: 'acme-app', packageManager: `npm@11 ${renewed}` }));
  let provisioned = false, preparations = 0;
  const observations: { source: string; evidence: string; feedback: string }[] = [];
  const runtime = createEnvironmentRuntime({ services: fixtureServices,
    inputs: async ({ refresh }) => { if (refresh) provisioned = true; return { payments: { PAYMENTS_KEY: provisioned ? renewed : retired } }; },
    authorHarness: { name: 'fixture', harness: ({ cwd }) => {
      observations.push({ source: readFileSync(join(cwd, 'repo/app.mjs'), 'utf8'), evidence: readFileSync(join(cwd, 'EVIDENCE.md'), 'utf8'),
        feedback: observations.length ? readFileSync(join(cwd, 'feedback.md'), 'utf8') : '' });
      return { command: process.execPath, args: ['-e', 'const fs=require("node:fs"); fs.writeFileSync("twin.json",fs.readFileSync("twin.json"));'] };
    } },
    twin: only({ async prepare({ source: path, inputs, onStep }) {
      assert.equal(await readFile(join(path, 'app.mjs'), 'utf8'), source);
      assert.equal(inputs?.payments.PAYMENTS_KEY, renewed);
      if (++preparations === 1) { await onStep?.('Starting twin'); throw new Error(`Payments: declined ${retired} and ${renewed}`); }
      return { services: [{ id: 'payments', fidelity: 'official-sandbox', status: 'ready' }], apps: [{ id: 'web', url: 'http://127.0.0.1:43000/' }] };
    }, health: async () => ({ status: 'failed', containers: [] }), logs: async () => '', destroy: async () => ({ status: 'destroyed' }) }),
    answers: async () => 200,
  });
  const result = await runtime.prepareEnvironment({ dataDir: f.dataDir, repoPath: f.repoPath, directory: f.directory,
    environment: { id: 'environment-1', plan: JSON.parse(draft) }, generate: { model: { apiKey: 'sk-or-v1-fixture-observation', model: 'vendor/model' }, draft },
    onUpdate: async () => {}, cancelled: () => false });
  assert.equal(result.status, 'ready');
  assert.equal(observations.length, 2);
  for (const observation of observations) assert.ok(!observation.source.includes(retired), 'A renewed input does not disclose its previous value.');
  assert.ok(!observations[1].evidence.includes('fixture-renewed-'), 'Evidence is recomputed from full input text before clipping a newly supplied secret.');
  assert.ok(!observations[1].feedback.includes(retired) && !observations[1].feedback.includes('fixture-renewed-'));
  assert.equal(await readFile(join(f.repoPath, 'app.mjs'), 'utf8'), source);
});

test('preparation records ownership before the twin allocates and reports its services and apps', async t => {
  const f = await setup(t), updates: { step?: string; sandboxId?: string; snapshot?: { files: number } }[] = [];
  await createTwinInputs({ dataDir: f.dataDir }).set('stripe', { secretKey: STRIPE_KEY });
  const prepared = await f.runtime.prepareEnvironment({ dataDir: f.dataDir, environment: f.environment, repoPath: f.repoPath, directory: f.directory,
    onUpdate: async update => { updates.push(update); }, cancelled: () => false });
  const [[operation, input]] = f.calls;
  assert.equal(operation, 'prepare');
  assert.deepEqual({ id: input.id, config: input.config, source: input.source }, { id: 'environment-1', config: plan, source: join(f.directory, 'source') });
  assert.equal(input.inputs?.stripe.secretKey, STRIPE_KEY);
  assert.deepEqual(await readdir(input.source!), ['app.mjs'], 'The twin runs a filtered snapshot, never the checkout.');
  assert.deepEqual(updates.map(update => update.step), ['Copying source', 'Preparing twin', 'Setting up Mailpit', 'Checking apps']);
  assert.equal(updates[1].sandboxId, 'environment-1', 'Ownership is recorded before twin setup starts.');
  assert.equal(updates[1].snapshot?.files, 1);
  assert.equal(prepared.status, 'ready', 'Blocked services leave the environment ready.');
  assert.deepEqual(prepared.services, [
    { id: 'mailpit', title: 'Mailpit', fidelity: 'actual', status: 'ready', missing: [] },
    { id: 'stripe', title: 'Stripe', fidelity: 'official-sandbox', status: 'blocked', missing: ['secretKey'] },
  ]);
  assert.deepEqual(prepared.apps, twinResult.apps);
  assert.ok(!JSON.stringify(prepared).includes(STRIPE_KEY));
});

test('controller shutdown cancels preparation between twin steps', async t => {
  let stop = false;
  const f = await setup(t, { prepare: async input => { stop = true; await input.onStep?.('Starting twin'); throw new Error('Unreachable'); } });
  await assert.rejects(f.runtime.prepareEnvironment({ dataDir: f.dataDir, environment: f.environment, repoPath: f.repoPath, directory: f.directory,
    onUpdate: async () => {}, cancelled: () => stop }), /cancelled/);
});

test('the llm service takes the App Settings model unless its source is the app', async t => {
  const f = await setup(t);
  await (await createBrowserModelSettings({ dataDir: f.dataDir })).saveOpenRouter({ apiKey: 'sk-or-settings-fixture', model: 'fixture/model' });
  await createTwinInputs({ dataDir: f.dataDir }).set('llm', { OPENAI_BASE_URL: 'http://model.test/v1', OPENAI_API_KEY: 'app-own-key', OPENAI_MODEL: 'app-model' });
  const settings = await environmentInputs({ dataDir: f.dataDir, config: { services: { llm: {} } } });
  assert.deepEqual(settings.llm, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_API_KEY: 'sk-or-settings-fixture', OPENAI_MODEL: 'fixture/model' });
  const app = await environmentInputs({ dataDir: f.dataDir, config: { services: { llm: { source: 'app' } } } });
  assert.deepEqual(app.llm, { OPENAI_BASE_URL: 'http://model.test/v1', OPENAI_API_KEY: 'app-own-key', OPENAI_MODEL: 'app-model' });
});

test('environment inputs read existing credentials through a data-directory alias and initialize a fresh directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-environment-input-alias-')), actual = join(dir, 'actual'), alias = join(dir, 'alias');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createTwinInputs({ dataDir: actual }).set('stripe', { secretKey: STRIPE_KEY });
  await symlink(actual, alias);
  assert.deepEqual((await environmentInputs({ dataDir: alias, config: plan, refresh: false })).stripe, { secretKey: STRIPE_KEY });
  const fresh = await environmentInputs({ dataDir: join(dir, 'fresh'), refresh: false });
  assert.ok(Object.values(fresh).every(values => Object.keys(values).length === 0), 'A fresh directory has no configured inputs.');
});

test('creating a twin first renews its services’ expiring provisions; a view or a teardown renews nothing', async t => {
  const f = await setup(t), calls: unknown[][] = [];
  const store = { refresh: async (ids: string[]) => { calls.push(['refresh', ids]); return [{ id: 'stripe', error: 'Renewal failed.' }]; }, values: async () => { calls.push(['values']); return { mailpit: {}, stripe: {} }; } };
  assert.deepEqual(await environmentInputs({ dataDir: f.dataDir, config: plan, store }), { mailpit: {}, stripe: {} }, 'A failed renewal is not thrown.');
  assert.deepEqual(calls, [['refresh', ['mailpit', 'stripe']], ['values']]);
  calls.length = 0;
  await environmentInputs({ dataDir: f.dataDir, config: plan, store, refresh: false });
  assert.deepEqual(calls, [['values']]);

  const refreshes: (boolean | undefined)[] = [];
  // Every app answers on its twin address; nothing listens there in a test, and whatever does on this computer is not the test's.
  const runtime = createEnvironmentRuntime({ inputs: async input => { refreshes.push(input.refresh); return {}; },
    twin: only({ prepare: async () => structuredClone(twinResult), destroy: async () => ({ status: 'destroyed' }) }), answers: async () => 200 });
  await runtime.prepareEnvironment({ dataDir: f.dataDir, environment: f.environment, repoPath: f.repoPath, directory: f.directory, onUpdate: async () => {}, cancelled: () => false });
  await runtime.destroySandbox({ dataDir: f.dataDir, environment: { ...f.environment, sandboxId: f.environment.id } });
  assert.deepEqual(refreshes, [true, false]);
});

test('health reports a ready twin, a restarting twin as transient and stopped containers as final', async t => {
  let reply: Health = { status: 'stopped', containers: [] };
  const f = await setup(t, { health: async () => reply });
  const environment = { ...f.environment, sandboxId: f.environment.id };
  const health = (value: Health) => { reply = value; return f.runtime.environmentHealth({ dataDir: f.dataDir, environment }); };
  assert.deepEqual(await health({ status: 'ready', containers: [] }), { status: 'ready' });
  assert.equal((await health({ status: 'starting', containers: [] })).final, undefined);
  assert.deepEqual(await health({ status: 'failed', containers: [
    { name: 'web', state: 'exited', health: null, exitCode: 1 }, { name: 'mailpit', state: 'running', health: 'unhealthy', exitCode: 0 }, { name: 'api', state: 'running', health: 'healthy' },
  ] }), { status: 'failed', final: true, error: 'Stopped: web exited (1), mailpit unhealthy.' });
  assert.deepEqual(await health({ status: 'stopped', containers: [] }), { status: 'failed', final: true, error: 'The twin is not running.' });
});

test('logs and deletion go through the twin, and deleting an older Cua guest removes that guest', async t => {
  const f = await setup(t);
  await createTwinInputs({ dataDir: f.dataDir }).set('stripe', { secretKey: STRIPE_KEY });
  const twin = { ...f.environment, sandboxId: f.environment.id };
  assert.equal(await f.runtime.environmentLogs({ dataDir: f.dataDir, environment: twin }), 'web | listening\n');
  await f.runtime.destroySandbox({ dataDir: f.dataDir, environment: twin });
  const destroy = f.calls.find(([operation]) => operation === 'destroy')![1];
  assert.equal(destroy.id, 'environment-1');
  assert.equal(destroy.inputs?.stripe.secretKey, STRIPE_KEY, 'Service teardown receives the stored inputs.');
  const guest = { id: 'environment-2', sandboxId: '6f1c2f56-8f52-4b0c-9d55-7a1c2f7b9e10' };
  await f.runtime.destroySandbox({ dataDir: f.dataDir, environment: guest });
  assert.deepEqual(f.calls.at(-1), ['guest', { dataDir: f.dataDir, id: guest.sandboxId }]);
  assert.equal(f.calls.filter(([operation]) => operation === 'destroy').length, 1);
});
