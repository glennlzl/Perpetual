import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTwinInputs, globalGitEmail, missingInputs } from '../src/twin/inputs.ts';
import { services as registry } from '../src/twin/registry.ts';
import { services } from './fixtures/twin/services.ts';
import type { ServiceProvision, TwinService } from '../src/twin/registry.ts';

type Failure = Error & { statusCode?: number };
type RunOptions = Parameters<ServiceProvision['run']>[0];
type Scripted = (ctx: RunOptions, n: number) => ReturnType<ServiceProvision['run']>;

const KEY = 'pk_test_stored_987';

test('Inputs are validated, stored privately and shown only as set or not', async t => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'perpetual-inputs-')), 'data');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createTwinInputs({ dataDir, services });
  const empty = [{ id: 'payments', title: 'Payments', inputs: [{ name: 'PAYMENTS_KEY', label: 'Payments test key', secret: true, help: 'A test-mode key.', set: false }] }];
  assert.deepEqual(await store.view(), empty);
  assert.deepEqual(await store.values(), { payments: {} });

  await assert.rejects(store.set('payments', { PAYMENTS_KEY: 'pk_live_real_key' }), (error: Failure) => !error.message.includes('pk_live') && /Payments test key does not have the expected format/.test(error.message));
  await assert.rejects(store.set('payments', { OTHER: 'x' }), /payments has no input named OTHER/);
  await assert.rejects(store.set('storage', { KEY: 'x' }), /Unknown service "storage"/);

  const view = await store.set('payments', { PAYMENTS_KEY: KEY });
  assert.equal(view[0].inputs[0].set, true);
  assert.equal(JSON.stringify(view).includes(KEY), false);
  assert.equal(JSON.stringify(await store.view()).includes(KEY), false);
  assert.deepEqual(await store.values(), { payments: { PAYMENTS_KEY: KEY } });
  const file = join(dataDir, 'twin-inputs.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { payments: { PAYMENTS_KEY: KEY } });

  await store.set('payments', { PAYMENTS_KEY: '' });
  assert.deepEqual(await store.view(), empty);
});

test('Missing inputs lists absent and malformed values', () => {
  assert.deepEqual(missingInputs(services.payments), ['PAYMENTS_KEY']);
  assert.deepEqual(missingInputs(services.payments, { PAYMENTS_KEY: 'sk_other' }), ['PAYMENTS_KEY']);
  assert.deepEqual(missingInputs(services.payments, { PAYMENTS_KEY: KEY }), []);
  assert.deepEqual(missingInputs(services.mail, {}), []);
});

test('Input storage refuses linked state, non-files and oversized files before using credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['twin-inputs.json', 'twin-provisions.json']) for (const kind of ['link', 'directory', 'oversized']) await t.test(`${name}: ${kind}`, async () => {
    const dataDir = join(root, `${name}-${kind}`);
    await mkdir(dataDir);
    const file = join(dataDir, name);
    if (kind === 'link') {
      const target = join(root, `${name}-outside.json`);
      await writeFile(target, JSON.stringify({ payments: { PAYMENTS_KEY: KEY } }));
      await symlink(target, file);
    } else if (kind === 'directory') await mkdir(file);
    else await writeFile(file, JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }));
    const store = createTwinInputs({ dataDir, services });
    await assert.rejects(store.values(), /Invalid twin input storage/);
  });
});

test('Input storage refuses a linked directory and makes an existing directory private', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), alias = join(root, 'linked');
  await mkdir(dataDir);
  await chmod(dataDir, 0o755);
  await symlink(dataDir, alias);
  await t.test('a link is rejected', async () => {
    await assert.rejects(createTwinInputs({ dataDir: alias, services }).view(), /storage must not be a symbolic link/);
  });
  await t.test('existing permissions are tightened', async () => {
    await createTwinInputs({ dataDir, services }).set('payments', { PAYMENTS_KEY: KEY });
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  });
});

test('An oversized credential save preserves the stored values and does not block later saves', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-inputs-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createTwinInputs({ dataDir, services });
  await store.set('payments', { PAYMENTS_KEY: KEY });
  await assert.rejects(store.set('payments', { PAYMENTS_KEY: `pk_test_${'x'.repeat(1024 * 1024)}` }), /Twin input storage is full/);
  assert.deepEqual(await store.values(), { payments: { PAYMENTS_KEY: KEY } });
  await store.set('payments', { PAYMENTS_KEY: 'pk_test_replaced_fixture' });
  assert.deepEqual(await store.values(), { payments: { PAYMENTS_KEY: 'pk_test_replaced_fixture' } });
  assert.deepEqual(await readdir(dataDir), ['twin-inputs.json']);
});

test('The default provisioning email ignores ambient Git configuration overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configured = process.env.GIT_CONFIG_GLOBAL;
  try {
    delete process.env.GIT_CONFIG_GLOBAL;
    const baseline = await globalGitEmail();
    const file = join(root, 'config');
    const injected = baseline === 'injected@example.test' ? 'other@example.test' : 'injected@example.test';
    await writeFile(file, `[user]\nemail = ${injected}\n`);
    process.env.GIT_CONFIG_GLOBAL = file;
    assert.ok(await globalGitEmail() === baseline, 'The provisioning default comes from the ordinary global configuration, not an ambient override.');
  } finally {
    if (configured === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = configured;
  }
});

// A service that provisions its own test keys, in the shape of the Stripe adapter; `run` is scripted per test.
const SECRET = 'rkcs_test_provisioned_fixture', PUBLIC = 'pk_test_provisioned_fixture', CLAIM = 'https://dashboard.example.test/claim/fixture';
const DAY = 86_400_000;
const day = (at: Date, days = 0) => new Date(at.getTime() + days * DAY).toISOString().slice(0, 10);
async function provisionStore(t: TestContext, { run, at = new Date('2026-09-24T12:00:00Z') }: { run: Scripted; at?: Date }) {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'perpetual-provision-')), 'data');
  t.after(() => rm(dirname(dataDir), { recursive: true, force: true }));
  const calls: RunOptions[] = [];
  const sandbox = {
    id: 'sandbox', title: 'Sandbox payments', fidelity: 'official-sandbox',
    inputs: [{ name: 'KEY', label: 'Sandbox key', secret: true, pattern: /^(sk|rkcs)_test_/ }, { name: 'PUBLIC', label: 'Sandbox public key', pattern: /^pk_test_/, optional: true }],
    provision: { inputs: [{ name: 'email', label: 'Email', default: 'git-email' }], run: async ctx => { calls.push(ctx); return run(ctx, calls.length); } },
    env: () => ({}),
  } satisfies TwinService;
  const clock = { at }, docker = async () => ({ stdout: '' });
  const options = { dataDir, services: { ...services, sandbox }, docker, gitEmail: async () => 'dev@example.test', now: () => clock.at };
  return { dataDir, sandbox, calls, clock, docker, options, store: createTwinInputs(options) };
}
const issued = (expiresAt: string, n = 1) => ({ values: { KEY: `${SECRET}_${n}`, PUBLIC }, details: { expiresAt, claimUrl: CLAIM, account: `acct_fixture${n}` } });
const records = async (dataDir: string) => JSON.parse(await readFile(join(dataDir, 'twin-provisions.json'), 'utf8'));

test('A provision runs in a private empty directory, stores its values and record privately and is viewed without keys', async t => {
  const f = await provisionStore(t, { run: async ctx => {
    assert.deepEqual(await readdir(ctx.tempDir), []);
    assert.equal((await stat(ctx.tempDir)).mode & 0o777, 0o700);
    await writeFile(join(ctx.tempDir, 'config.toml'), `key = "${SECRET}"\n`);
    return issued('2026-10-01');
  } });
  const before = (await f.store.view()).find(item => item.id === 'sandbox')!;
  assert.deepEqual(before.provision, { inputs: [{ name: 'email', label: 'Email', value: 'dev@example.test' }] });
  assert.equal(before.provisioned, undefined);
  assert.equal((await f.store.view()).find(item => item.id === 'payments')!.provision, undefined);

  const view = await f.store.provision('sandbox', { email: 'owner@example.test' });
  const [ctx] = f.calls;
  assert.deepEqual(ctx.inputs, { email: 'owner@example.test' });
  assert.equal(ctx.docker, f.docker);
  await assert.rejects(stat(ctx.tempDir), { code: 'ENOENT' }, 'The directory that may hold keys is removed.');
  const entry = view.find(item => item.id === 'sandbox')!;
  assert.deepEqual(entry.provisioned, { expiresAt: '2026-10-01', claimUrl: CLAIM });
  assert.deepEqual(entry.inputs.map(input => [input.name, input.set]), [['KEY', true], ['PUBLIC', true]]);
  assert.ok(!JSON.stringify(view).includes(SECRET) && !JSON.stringify(await f.store.view()).includes(SECRET));
  assert.deepEqual((await f.store.values()).sandbox, { KEY: `${SECRET}_1`, PUBLIC });
  for (const file of ['twin-inputs.json', 'twin-provisions.json']) assert.equal((await stat(join(f.dataDir, file))).mode & 0o777, 0o600, file);
  assert.deepEqual(await records(f.dataDir), { sandbox: { inputs: { email: 'owner@example.test' }, expiresAt: '2026-10-01', claimUrl: CLAIM, account: 'acct_fixture1', provisionedAt: '2026-09-24T12:00:00.000Z' } });
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['twin-inputs.json', 'twin-provisions.json']);

  // The user's own keys, e.g. a claimed sandbox's full key, end the provision and never pair with its public key.
  const own = await f.store.set('sandbox', { KEY: 'sk_test_own_fixture' });
  assert.equal(own.find(item => item.id === 'sandbox')!.provisioned, undefined);
  assert.deepEqual(await records(f.dataDir), {});
  assert.deepEqual((await f.store.values()).sandbox, { KEY: 'sk_test_own_fixture' });
});

test('Oversized provision metadata cannot replace the credentials without their expiry record', async t => {
  const f = await provisionStore(t, { run: async (_ctx, n) => issued('2026-10-01', n) });
  await f.store.provision('sandbox', { email: 'owner@example.test' });
  const saved = await records(f.dataDir);
  await assert.rejects(f.store.provision('sandbox', { email: 'x'.repeat(1024 * 1024) }), /Twin input storage is full/);
  assert.deepEqual((await f.store.values()).sandbox, { KEY: `${SECRET}_1`, PUBLIC });
  assert.deepEqual(await records(f.dataDir), saved);
  await f.store.provision('sandbox', { email: 'owner@example.test' });
  assert.deepEqual((await f.store.values()).sandbox, { KEY: `${SECRET}_3`, PUBLIC });
});

test('A save that ends a provision keeps none of its values, which would never be renewed or expire', async t => {
  const f = await provisionStore(t, { run: async (ctx, n) => issued('2026-10-01', n) });
  await f.store.provision('sandbox', { email: 'dev@example.test' });
  await f.store.set('sandbox', { PUBLIC: 'pk_test_own_fixture' });
  assert.deepEqual(await records(f.dataDir), {});
  f.clock.at = new Date('2026-10-20T00:00:00Z');
  assert.deepEqual((await f.store.values()).sandbox, { PUBLIC: 'pk_test_own_fixture' }, 'The sandbox key is gone after its expiry too.');
  assert.deepEqual(missingInputs(f.sandbox, (await f.store.values()).sandbox), ['KEY']);
  assert.deepEqual(await f.store.refresh(), []);
  // Without a provision, a save keeps the user's other values.
  await f.store.set('sandbox', { KEY: 'sk_test_own_fixture' });
  assert.deepEqual((await f.store.values()).sandbox, { KEY: 'sk_test_own_fixture', PUBLIC: 'pk_test_own_fixture' });
});

test('A provision is refused for unknown inputs or services and stores nothing when its values do not validate', async t => {
  const f = await provisionStore(t, { run: async (ctx, n) => n === 1 ? { values: { KEY: 'sk_live_fixture' }, details: { expiresAt: '2026-10-01' } }
    : n === 2 ? { values: { PUBLIC }, details: { expiresAt: '2026-10-01' } } : { values: { KEY: `${SECRET}_3` }, details: { expiresAt: 'soon' } } });
  await assert.rejects(f.store.provision('sandbox', { email: 'a@example.test', other: 'x' }), /sandbox has no input named other/);
  await assert.rejects(f.store.provision('payments', { email: 'a@example.test' }), /Payments cannot be set up automatically/);
  await assert.rejects(f.store.provision('storage', {}), /Unknown service "storage"/);
  await assert.rejects(f.store.provision('sandbox', { email: 'a@example.test' }), (error: Failure) => error.message === 'Sandbox key does not have the expected format.');
  await assert.rejects(f.store.provision('sandbox', { email: 'a@example.test' }), /Sandbox payments provided no KEY/);
  await assert.rejects(f.store.provision('sandbox', { email: 'a@example.test' }), (error: Failure) => /provided no expiry date/.test(error.message) && !error.message.includes(SECRET));
  assert.deepEqual(await readdir(f.dataDir), [], 'Nothing is stored, and each private directory is removed.');
});

test('An expired provision leaves its service blocked, and keys set afterwards start afresh', async t => {
  const f = await provisionStore(t, { run: async () => issued('2026-10-01') });
  await f.store.provision('sandbox', { email: 'dev@example.test' });
  f.clock.at = new Date('2026-09-30T23:59:59Z');
  assert.deepEqual(missingInputs(f.sandbox, (await f.store.values()).sandbox), []);
  f.clock.at = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual((await f.store.values()).sandbox, {});
  assert.deepEqual(missingInputs(f.sandbox, (await f.store.values()).sandbox), ['KEY']);
  const entry = (await f.store.view()).find(item => item.id === 'sandbox')!;
  assert.equal(entry.provisioned, undefined);
  assert.deepEqual(entry.inputs.map(input => input.set), [false, false]);
  // Keys entered after expiry never inherit the expired sandbox's public key.
  await f.store.set('sandbox', { KEY: 'sk_test_own_fixture' });
  assert.deepEqual((await f.store.values()).sandbox, { KEY: 'sk_test_own_fixture' });
});

test('Refresh renews a provision that expires by tomorrow from its stored inputs and reports a failure without throwing', async t => {
  let failing = false, f: Awaited<ReturnType<typeof provisionStore>>;
  f = await provisionStore(t, { run: async (ctx, n) => { if (failing) throw new Error('Could not create a sandbox.'); return issued(day(f.clock.at, 7), n); } });
  await f.store.provision('sandbox', { email: 'owner@example.test' });
  assert.deepEqual(await f.store.refresh(), [], 'A week from expiry nothing is renewed.');
  f.clock.at = new Date(f.clock.at.getTime() + 5 * DAY);
  assert.deepEqual(await f.store.refresh(), [], 'Two days from expiry nothing is renewed.');
  f.clock.at = new Date(f.clock.at.getTime() + DAY);
  assert.deepEqual(await f.store.refresh(['database']), [], 'Only the named services are renewed.');
  assert.deepEqual(await f.store.refresh(['database', 'sandbox', 'sandbox']), [{ id: 'sandbox' }]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].inputs, { email: 'owner@example.test' });
  assert.deepEqual((await f.store.values()).sandbox, { KEY: `${SECRET}_2`, PUBLIC });
  assert.equal((await records(f.dataDir)).sandbox.expiresAt, day(f.clock.at, 7));

  failing = true;
  f.clock.at = new Date(f.clock.at.getTime() + 7 * DAY);
  const expired = await records(f.dataDir);
  assert.deepEqual(await f.store.refresh(), [{ id: 'sandbox', error: 'Could not create a sandbox.' }]);
  assert.deepEqual(await records(f.dataDir), expired, 'A failed renewal keeps the expired record.');
  assert.deepEqual(missingInputs(f.sandbox, (await f.store.values()).sandbox), ['KEY']);
});

test('A manual save made as a renewal starts wins, and the renewal stores nothing', async t => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await provisionStore(t, { run: async (ctx, n) => { if (n > 1) await held; return issued(n > 1 ? '2026-10-07' : '2026-10-01', n); } });
  await f.store.provision('sandbox', { email: 'dev@example.test' });
  f.clock.at = new Date('2026-09-30T12:00:00Z');
  // The save is not refused: the renewal has not started its provisioning yet.
  const renewal = f.store.refresh(['sandbox']);
  await f.store.set('sandbox', { KEY: 'sk_test_claimed_fixture' });
  release();
  assert.deepEqual(await renewal, [{ id: 'sandbox' }]);
  assert.deepEqual((await f.store.values()).sandbox, { KEY: 'sk_test_claimed_fixture' });
  assert.deepEqual(await records(f.dataDir), {});
  assert.equal((await f.store.view()).find(item => item.id === 'sandbox')!.provisioned, undefined);
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['twin-inputs.json', 'twin-provisions.json']);
});

test('One provision runs per service at a time, across stores; a refresh waits for it and a manual save is refused', async t => {
  const gates = new Map<number, Promise<void>>(), hold = (n: number) => { let release = () => {}; gates.set(n, new Promise<void>(resolve => { release = resolve; })); return () => release(); };
  // Each sandbox expires tomorrow, so it is always due for renewal.
  const f = await provisionStore(t, { run: async (ctx, n) => { await gates.get(n); return issued('2026-09-25', n); } });
  const other = createTwinInputs(f.options);
  const release = hold(1), first = f.store.provision('sandbox', { email: 'dev@example.test' });
  await assert.rejects(other.provision('sandbox', { email: 'dev@example.test' }), (error: Failure) => error.statusCode === 409 && error.message === 'Sandbox payments setup is already running.');
  await assert.rejects(other.set('sandbox', { KEY: 'sk_test_own_fixture' }), (error: Failure) => error.statusCode === 409);
  release();
  await first;
  assert.equal(f.calls.length, 1);
  // Two refreshes at once make one renewal.
  const [renewed, waited] = await Promise.all([f.store.refresh(), other.refresh()]);
  assert.deepEqual([renewed, waited], [[{ id: 'sandbox' }], [{ id: 'sandbox' }]]);
  assert.equal(f.calls.length, 2);
  // A refresh while the user's provisioning runs waits for it instead of starting another.
  const again = hold(3), user = f.store.provision('sandbox', { email: 'owner@example.test' }), waiting = other.refresh();
  await new Promise(resolve => setTimeout(resolve, 200));
  again();
  await user;
  assert.deepEqual(await waiting, [{ id: 'sandbox' }]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual((await records(f.dataDir)).sandbox.inputs, { email: 'owner@example.test' });
  // Stores of different data directories never block each other.
  const elsewhere = await provisionStore(t, { run: async () => issued('2026-10-01') });
  const busy = f.store.provision('sandbox', { email: 'dev@example.test' });
  await elsewhere.store.provision('sandbox', { email: 'dev@example.test' });
  await busy;
});

test('Claimable sandbox keys pass the Stripe input patterns', async t => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'perpetual-inputs-')), 'data');
  t.after(() => rm(dirname(dataDir), { recursive: true, force: true }));
  const store = createTwinInputs({ dataDir, gitEmail: async () => 'dev@example.test' });
  await store.set('stripe', { secretKey: 'rkcs_test_claimable_fixture', publishableKey: 'pk_test_claimable_fixture' });
  assert.deepEqual(missingInputs(registry.stripe, (await store.values()).stripe), []);
  const stripe = (await store.view()).find(item => item.id === 'stripe')!;
  assert.deepEqual(stripe.inputs.map(input => input.set), [true, true]);
  assert.deepEqual(stripe.provision, { inputs: [{ name: 'email', label: 'Email', value: 'dev@example.test' }] });
  assert.equal(stripe.provisioned, undefined);
});
