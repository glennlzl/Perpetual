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

test('generation protects its first author observation with stored inputs', async t => {
  const f = await setup(t), secret = `fixture-private-${'q'.repeat(350)}`, key = 'sk-or-v1-fixture-generation-observation';
  const draft = JSON.stringify({ services: { payments: {} }, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const manifest = JSON.stringify({ name: 'acme-app', packageManager: `npm@11 ${secret}`, scripts: { start: `echo ${secret}` } });
  await writeFile(join(f.repoPath, 'package.json'), manifest);
  let authored = false, ranSource = '';
  const runtime = createEnvironmentRuntime({ services: fixtureServices,
    inputs: async () => ({ payments: { PAYMENTS_KEY: secret } }),
    author: options => {
      authored = true;
      assert.ok(!options.evidence.includes('fixture-private-'), 'A secret is hidden before package-manager or command text is clipped.');
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
});

test('author retries keep retired input values private and rebuild evidence when supplied values change', async t => {
  const f = await setup(t), retired = 'fixture-retired-value-7310', replacement = `fixture-replacement-${'q'.repeat(350)}`;
  const draft = JSON.stringify({ services: { payments: {} }, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const source = `export const configured = ${JSON.stringify(retired)};\n`;
  await writeFile(join(f.repoPath, 'app.mjs'), source);
  await writeFile(join(f.repoPath, 'package.json'), JSON.stringify({ name: 'acme-app', packageManager: `npm@11 ${replacement}` }));
  let supplied = retired, preparations = 0;
  const observations: { source: string; evidence: string; feedback: string }[] = [];
  const runtime = createEnvironmentRuntime({ services: fixtureServices,
    inputs: async () => ({ payments: { PAYMENTS_KEY: supplied } }),
    authorHarness: { name: 'fixture', harness: ({ cwd }) => {
      observations.push({ source: readFileSync(join(cwd, 'repo/app.mjs'), 'utf8'), evidence: readFileSync(join(cwd, 'EVIDENCE.md'), 'utf8'),
        feedback: observations.length ? readFileSync(join(cwd, 'feedback.md'), 'utf8') : '' });
      supplied = replacement; // A user can replace saved inputs while an author works.
      return { command: process.execPath, args: ['-e', 'const fs=require("node:fs"); fs.writeFileSync("twin.json",fs.readFileSync("twin.json"));'] };
    } },
    twin: only({ async prepare({ source: path, inputs, onStep }) {
      assert.equal(await readFile(join(path, 'app.mjs'), 'utf8'), source);
      assert.equal(inputs?.payments.PAYMENTS_KEY, replacement);
      if (++preparations === 1) { await onStep?.('Starting twin'); throw new Error(`Payments: declined ${retired} and ${replacement}`); }
      return { services: [{ id: 'payments', fidelity: 'official-sandbox', status: 'ready' }], apps: [{ id: 'web', url: 'http://127.0.0.1:43000/' }] };
    }, health: async () => ({ status: 'failed', containers: [] }), logs: async () => '', destroy: async () => ({ status: 'destroyed' }) }),
    answers: async () => 200,
  });
  const result = await runtime.prepareEnvironment({ dataDir: f.dataDir, repoPath: f.repoPath, directory: f.directory,
    environment: { id: 'environment-1', plan: JSON.parse(draft) }, generate: { model: { apiKey: 'sk-or-v1-fixture-observation', model: 'vendor/model' }, draft },
    onUpdate: async () => {}, cancelled: () => false });
  assert.equal(result.status, 'ready');
  assert.equal(observations.length, 2);
  for (const observation of observations) assert.ok(!observation.source.includes(retired), 'A replaced input does not disclose its previous value.');
  assert.ok(!observations[1].evidence.includes('fixture-replacement-'), 'Evidence is recomputed from full input text before clipping a newly supplied secret.');
  assert.ok(!observations[1].feedback.includes(retired) && !observations[1].feedback.includes('fixture-replacement-'));
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
  assert.deepEqual(updates.map(update => update.step), ['Copying source', 'Checking application runtimes', 'Preparing twin', 'Setting up Mailpit', 'Checking apps']);
  const preparing = updates.find(update => update.step === 'Preparing twin');
  assert.equal(preparing?.sandboxId, 'environment-1', 'Ownership is recorded before twin setup starts.');
  assert.equal(preparing?.snapshot?.files, 1);
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
  assert.deepEqual((await environmentInputs({ dataDir: alias, config: plan })).stripe, { secretKey: STRIPE_KEY });
  const fresh = await environmentInputs({ dataDir: join(dir, 'fresh') });
  assert.ok(Object.values(fresh).every(values => Object.keys(values).length === 0), 'A fresh directory has no configured inputs.');
});

test('environment creation and rebuilds keep the chosen Stripe sandbox until expiry without creating another account', async t => {
  const f = await setup(t);
  let at = new Date('2026-09-24T12:00:00Z'), creations = 0;
  const store = createTwinInputs({ dataDir: f.dataDir, now: () => at, gitEmail: async () => '', docker: async () => {
    creations += 1;
    return { stdout: JSON.stringify({ secret_key: `rkcs_test_environment_fixture_${creations}`, publishable_key: `pk_test_environment_fixture_${creations}`,
      account_id: `acct_environment${creations}`, claim_url: 'https://dashboard.stripe.com/onboard_sandbox/environment-fixture', expires_at: '2026-10-01' }) };
  } });
  await store.provision('stripe', { email: 'owner@example.test' });
  const saved = await readFile(join(f.dataDir, 'twin-provisions.json'), 'utf8');
  for (const date of ['2026-09-24T12:00:00Z', '2026-09-30T23:59:59Z', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z']) {
    at = new Date(date);
    const inputs = await environmentInputs({ dataDir: f.dataDir, config: plan, store });
    assert.equal(creations, 1, `${date}: reading environment inputs must never send the saved email to Stripe.`);
    assert.deepEqual(inputs.stripe, date < '2026-10-01' ? { secretKey: 'rkcs_test_environment_fixture_1', publishableKey: 'pk_test_environment_fixture_1' } : {}, date);
    assert.equal(await readFile(join(f.dataDir, 'twin-provisions.json'), 'utf8'), saved, 'Environment reads preserve the selected account record.');
  }
  const expired = (await store.view()).find(service => service.id === 'stripe')!;
  assert.ok(expired.inputs.every(input => !input.set));
  assert.ok(expired.provision, 'An expired service still offers explicit sandbox creation.');
  assert.equal(expired.provisioned, undefined);
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

test('A generated attempt checkpoints service diagnostics before tearing its twin down', async t => {
  const f = await setup(t), draft = JSON.stringify({ apps: { web: { start: 'node app.mjs', port: 3000 } } });
  const updates: { logs?: string }[] = [];
  let attempts = 0, destroyed = false;
  const runtime = createEnvironmentRuntime({
    author: () => ({ promise: Promise.resolve({ text: draft }), cancel() {} }),
    twin: only({
      prepare: async () => { if (++attempts === 1) throw new Error('Auth request deadline'); return { services: [], apps: [] }; },
      health: async () => ({ status: 'failed', containers: [{ name: 'supabase_auth_perpetual-beta', state: 'exited', health: null, exitCode: 1 }] }),
      logs: async () => 'database waiting\nAuth request interrupted\npassword=fixture-private-value\n',
      destroy: async () => {
        destroyed = true;
        assert.ok(updates.some(update => update.logs?.includes('database waiting')), 'checkpoint must finish before teardown starts');
      },
    }),
  });
  const result = await runtime.prepareEnvironment({ dataDir: f.dataDir, repoPath: f.repoPath, directory: f.directory, environment: { id: 'environment-1' },
    generate: { draft, model: { apiKey: 'fixture-key', model: 'vendor/model' } }, onUpdate: async update => { updates.push(update); }, cancelled: () => false });
  assert.equal(result.status, 'ready'); assert.equal(destroyed, true);
  assert.ok(updates.some(update => update.logs?.includes('Auth request interrupted')));
  assert.doesNotMatch(JSON.stringify(updates), /fixture-private-value/);
});
