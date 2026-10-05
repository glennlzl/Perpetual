import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import supabase, { CLI_VERSION as SUPABASE_VERSION, cliEntry, setToml } from '../src/twin/services/supabase.ts';
import { APP_IMAGE } from '../src/twin/compose.ts';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import stripe, { CLI as STRIPE_CLI, EVENTS, SANDBOX_FAILED } from '../src/twin/services/stripe.ts';
import { detectTwinConfig } from '../src/twin/detect.ts';
import { missingInputs } from '../src/twin/inputs.ts';
import type { CommandOutput, DockerCommand, EnvInput, ServiceContext } from '../src/twin/registry.ts';
import { serviceOptionErrors, type Json, type JsonObject } from '../src/twin/config.ts';

const HOST = 'host.docker.internal';
const SOCKET = /docker\.sock/;

type SupabaseContext = Parameters<typeof supabase.setup>[0];
type StripeContext = Parameters<typeof stripe.setup>[0];
type Call = { image?: string; command?: string; args: string[]; options?: { env?: EnvInput; cwd?: string; mounts?: 'service-only' } };
type Respond = (call: Call) => string | undefined | Promise<string | undefined>;
type Fake<C> = C & { calls: Call[] };

// A service context whose CLI runs return canned output; nothing touches Docker or the network. Supabase and Stripe
// never ask it for a shared port or an app.
const context = async <C extends ServiceContext<object, object>>({ respond = () => '', ...values }: { respond?: Respond } & Partial<C> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'twin-official-'));
  const ports = new Map<string, number>(), calls: Call[] = [];
  const port = (name: string) => { if (!ports.has(name)) ports.set(name, 43100 + ports.size); return ports.get(name)!; };
  const call = async (entry: Call): Promise<CommandOutput> => { calls.push(entry); return { stdout: await respond(entry) ?? '' }; };
  return {
    project: 'perpetual-beta1', dir: join(root, 'twin'), source: join(root, 'source'), shared: join(root, 'shared', 'trigger-dev'),
    options: {}, inputs: {}, outputs: {}, host: HOST, port, url: (name: string, path = '') => `http://${HOST}:${port(name)}${path}`,
    run: (image: string, args: string[], options?: Call['options']) => call({ image, args, options }), exec: (command: string, args: string[], options?: Call['options']) => call({ command, args, options }),
    calls, ...values,
  } as Fake<C>;
};
const mode = async (file: string) => (await stat(file)).mode & 0o777;
const section = (toml: string, name: string) => toml.split(/^(?=\[)/m).find(part => part.startsWith(`[${name}]\n`)) ?? '';

const CONFIG = `project_id = "shop-api"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]

[db]
port = 54322
shadow_port = 54320
major_version = 17

[db.migrations]
enabled = false

[inbucket]
enabled = true
port = 54324
`;
const STATUS = [
  'API_URL="http://127.0.0.1:43100"', 'ANON_KEY="anon.jwt"', 'SERVICE_ROLE_KEY="service.jwt"', 'JWT_SECRET="jwt-secret"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:43101/postgres"', '',
].join('\n');
const supabaseSource = async (ctx: SupabaseContext) => {
  await mkdir(ctx.dir, { recursive: true });
  const dir = join(ctx.source, 'services/api/supabase');
  await mkdir(join(dir, 'migrations'), { recursive: true }); await mkdir(join(dir, '.temp'), { recursive: true });
  await writeFile(join(dir, 'config.toml'), CONFIG);
  await writeFile(join(dir, 'migrations/0001_init.sql'), 'create table items (id int);');
  await writeFile(join(dir, '.temp/project-ref'), 'remote-project');
  ctx.options = { directory: 'services/api/supabase' };
};

test('Supabase runs the pinned CLI on the host, never in a container with the Docker socket', async () => {
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  ctx.outputs = await supabase.setup(ctx);
  const workdir = join(ctx.dir, 'supabase'), entry = await cliEntry();
  // The installed release's own launcher, run with the controller's Node.
  assert.deepEqual(ctx.calls.filter(call => call.command).map(({ command, args }) => [command, ...args]), [
    [process.execPath, entry, 'stop', '--no-backup', '--project-id', 'perpetual-beta1'],
    [process.execPath, entry, 'start', '--workdir', workdir],
    [process.execPath, entry, 'status', '--output', 'env', '--workdir', workdir],
  ]);
  assert.match(SUPABASE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(ctx.calls.every(({ args }) => !args.some(arg => SOCKET.test(arg))));
  assert.equal(ctx.calls[1].image, APP_IMAGE);
  assert.deepEqual(ctx.calls[1].options, { mounts: 'service-only' });
  assert.deepEqual(supabase.containers(), []); // the CLI owns the stack's containers
});

test('Supabase starts its stack with every env() name of its config.toml and SUPABASE_ setting unset, whatever the controller exports', async t => {
  // The controller's environment, as a developer's shell exports it: stack settings and a credential the CLI would take
  // over the config, and the CLI's own image mirror and telemetry choice, which stay.
  const host = { SUPABASE_DB_PORT: '5999', SUPABASE_PROJECT_ID: 'host-project', SUPABASE_ACCESS_TOKEN: 'host-access-value', SUPABASE_INTERNAL_IMAGE_REGISTRY: 'registry.example.test', SUPABASE_TELEMETRY_DISABLED: '1',
    SUPABASE_CLI_BINARY_OVERRIDE: '/opt/acme/bin/supabase' };
  const exported = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('SUPABASE_')));
  for (const name of Object.keys(exported)) delete process.env[name];
  Object.assign(process.env, host);
  t.after(() => { for (const name of Object.keys(host)) delete process.env[name]; Object.assign(process.env, exported); });
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await writeFile(join(ctx.source, 'services/api/supabase/config.toml'), `${CONFIG}
[studio]
openai_api_key = "env(OPENAI_API_KEY)"

[auth]
additional_redirect_urls = ["env(REDIRECT_URL)", "http://127.0.0.1:3000"]

[edge_runtime.secrets]
token = "env(GH_TOKEN)"
`);
  await supabase.setup(ctx);
  // The CLI reads an empty variable as unset, so the stack gets each reference and setting as written. The launcher's
  // binary override is always cleared, so the locked release runs.
  const unset = { OPENAI_API_KEY: '', REDIRECT_URL: '', GH_TOKEN: '', SUPABASE_DB_PORT: '', SUPABASE_PROJECT_ID: '', SUPABASE_ACCESS_TOKEN: '', SUPABASE_CLI_BINARY_OVERRIDE: '' };
  const cli = (name: string) => ctx.calls.find(call => call.command === process.execPath && call.args.includes(name));
  assert.deepEqual([cli('start')?.options?.env, cli('status')?.options?.env, cli('stop')?.options?.env], [unset, unset, { SUPABASE_CLI_BINARY_OVERRIDE: '' }]);
});

test('Supabase names its project directory before running the CLI when the repository has no project there', async () => {
  for (const options of [{}, { directory: 'services/api/supabase' }]) {
    const ctx = await context<SupabaseContext>({ options });
    await mkdir(join(ctx.source, 'services/api/supabase'), { recursive: true }); // a folder without config.toml
    await assert.rejects(supabase.setup(ctx), { message: `The repository has no Supabase project at ${options.directory ?? 'supabase'}: set supabase.directory to the folder that holds its config.toml.` });
    assert.deepEqual(ctx.calls, []);
  }
});

test('Supabase does not start its stack when the private mount is unavailable to Docker', async () => {
  const ctx = await context<SupabaseContext>({ respond: ({ image, args }) => {
    if (image) throw new Error('Private mount unavailable');
    return args.includes('status') ? STATUS : '';
  } });
  await supabaseSource(ctx);
  await assert.rejects(supabase.setup(ctx), /Private mount unavailable/);
  assert.ok(ctx.calls.every(call => !call.args.includes('start')));
});

test('Supabase copies the project with twin ports, id and a host.docker.internal issuer', async () => {
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await supabase.setup(ctx);
  const target = join(ctx.dir, 'supabase/supabase'), config = await readFile(join(target, 'config.toml'), 'utf8');
  assert.match(config, /^project_id = "perpetual-beta1"$/m);
  // The CLI health-checks its stack from the host through api.external_url, where host.docker.internal does not
  // resolve, so only the token issuer takes the address containers verify against.
  assert.doesNotMatch(section(config, 'api'), /^external_url =/m);
  assert.match(section(config, 'auth'), new RegExp(`^jwt_issuer = "http://${HOST}:${ctx.port('api')}/auth/v1"$`, 'm'));
  for (const [name, key, port] of [['api', 'port', 'api'], ['db', 'port', 'db'], ['db', 'shadow_port', 'shadow'], ['inbucket', 'port', 'mail'],
    ['db.pooler', 'port', 'pooler'], ['studio', 'port', 'studio'], ['analytics', 'port', 'analytics'], ['edge_runtime', 'inspector_port', 'inspector']]) {
    assert.match(section(config, name), new RegExp(`^${key} = ${ctx.port(port)}$`, 'm'), `${name}.${key}`);
  }
  assert.doesNotMatch(config, /5432\d|shop-api|\[local_smtp\]/);
  assert.match(config, /schemas = \["public", "graphql_public"\]/);
  assert.equal(await readFile(join(target, 'migrations/0001_init.sql'), 'utf8'), 'create table items (id int);');
  await assert.rejects(stat(join(target, '.temp')));
});

test('Supabase provides its standard variables from supabase status', async () => {
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  ctx.outputs = await supabase.setup(ctx);
  const url = `http://${HOST}:${ctx.port('api')}`;
  assert.deepEqual(supabase.env(ctx), {
    SUPABASE_URL: url, SUPABASE_ANON_KEY: 'anon.jwt', SUPABASE_SERVICE_ROLE_KEY: 'service.jwt', SUPABASE_JWT_SECRET: 'jwt-secret',
    // The CLI fixes the local password; the URL carries what status reports.
    DATABASE_URL: `postgresql://postgres:postgres@${HOST}:${ctx.port('db')}/postgres?sslmode=disable`,
    NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon.jwt',
  });
});

test('Supabase setup fails when status reports no keys', async () => {
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? 'API_URL="http://127.0.0.1:1"\n' : '' });
  await supabaseSource(ctx);
  await assert.rejects(supabase.setup(ctx), /did not report its keys/);
});

test('Supabase is detected from its config.toml, which gives its directory', () => {
  assert.deepEqual(detectTwinConfig({ files: ['backend/api/supabase/config.toml'] }).services, { supabase: { directory: 'backend/api/supabase' } });
});

test('Supabase supersedes PostgreSQL, which its local stack includes', () => {
  const postgresEvidence = { packages: ['pg', 'postgres'], env: ['POSTGRES_HOST', 'PGUSER'] };
  assert.deepEqual(detectTwinConfig({ ...postgresEvidence, packages: [...postgresEvidence.packages, '@supabase/supabase-js'] }).services, { supabase: {} });
  assert.deepEqual(detectTwinConfig(postgresEvidence).services, { postgres: {} });
});

test('Supabase teardown stops the twin project without a backup', async () => {
  const ctx = await context<SupabaseContext>();
  await supabase.teardown(ctx);
  assert.deepEqual(ctx.calls.map(({ command, args }) => [command, ...args]),
    [[process.execPath, await cliEntry(), 'stop', '--no-backup', '--project-id', 'perpetual-beta1']]);
});

test('The Supabase CLI is an exact dependency that package-lock.json locks with its platform binaries and dependencies', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  assert.equal(manifest.dependencies.supabase, SUPABASE_VERSION, 'An exact version, never a range.');
  const cli = lock.packages['node_modules/supabase'];
  assert.equal(cli.version, SUPABASE_VERSION);
  const binaries = Object.keys(cli.optionalDependencies ?? {});
  assert.ok(binaries.length && binaries.every(name => name.startsWith('@supabase/cli-') && lock.packages[`node_modules/${name}`].version === SUPABASE_VERSION), 'The platform binaries are packages of the same release.');
  // Every package the release installs, its own dependencies' dependencies included, is locked with an integrity hash.
  const located = (from: string, name: string) => lock.packages[`${from}/node_modules/${name}`] ? `${from}/node_modules/${name}` : `node_modules/${name}`;
  const seen = new Set<string>(), queue = ['node_modules/supabase'];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = lock.packages[path];
    assert.match(entry?.integrity ?? '', /^sha512-/, path);
    queue.push(...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }).map(name => located(path!, name)));
  }
  assert.ok(seen.size > binaries.length + 1, 'The release\'s JavaScript dependencies are locked too.');
  // The installed launcher runs, with no download.
  const entry = await cliEntry();
  assert.equal(entry, fileURLToPath(new URL('node_modules/supabase/dist/supabase.js', root)));
  await stat(entry);
});

test('A long twin project gets a Supabase project id the CLI keeps whole, used by start and stop alike', async () => {
  // The CLI cuts project ids to 40 characters and `stop --project-id` matches the cut id, so a longer id would leak the stack.
  const project = 'perpetual-0a24d90e-fa7c-4399-88ad-48d9a2836afa', other = 'perpetual-0a24d90e-fa7c-4399-88ad-48d9a2836afb';
  const ctx = await context<SupabaseContext>({ project, respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await supabase.setup(ctx);
  const id = (await readFile(join(ctx.dir, 'supabase/supabase/config.toml'), 'utf8')).match(/^project_id = "([^"]+)"$/m)![1];
  assert.ok(id.length <= 40, id);
  assert.match(id, /^perpetual-0a24d90e-/);
  const stops = [...ctx.calls];
  const fresh = await context<SupabaseContext>({ project });
  await supabase.teardown(fresh);
  for (const call of [stops[0], fresh.calls[0]]) assert.deepEqual(call.args.slice(-3), ['--no-backup', '--project-id', id]);
  const sibling = await context<SupabaseContext>({ project: other });
  await supabase.teardown(sibling);
  assert.notEqual(sibling.calls[0].args.at(-1), id, 'twins that share a long prefix keep separate stacks');
});

test('TOML rewrite adds missing keys and sections and uses [local_smtp] for current configs', async () => {
  assert.equal(setToml('[api]\nport = 1\n', '', 'project_id', 'x'), 'project_id = "x"\n[api]\nport = 1\n');
  assert.equal(setToml('[api]\nenabled = true\n\n[db]\nport = 2\n', 'api', 'port', 3), '[api]\nenabled = true\nport = 3\n\n[db]\nport = 2\n');
  assert.equal(setToml('[api] # gateway\nport = 1\n', 'api', 'port', 5), '[api] # gateway\nport = 5\n');
  assert.equal(setToml('[db]\nport = 2\n', 'db.pooler', 'port', 4), '[db]\nport = 2\n\n[db.pooler]\nport = 4\n');
  const ctx = await context<SupabaseContext>({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await writeFile(join(ctx.source, 'services/api/supabase/config.toml'), '[api]\nport = 54321\n');
  await supabase.setup(ctx);
  assert.match(await readFile(join(ctx.dir, 'supabase/supabase/config.toml'), 'utf8'), new RegExp(`\\[local_smtp\\]\\nport = ${ctx.port('mail')}\\nsmtp_port = ${ctx.port('smtp')}\\n`));
});

test('Stripe accepts only test keys', () => {
  const [secret, publishable] = stripe.inputs;
  assert.deepEqual({ name: secret.name, secret: secret.secret }, { name: 'secretKey', secret: true });
  for (const key of ['sk_test_123', 'rk_test_123', 'rkcs_test_123']) assert.ok(secret.pattern.test(key), key);
  for (const key of ['sk_live_123', 'rk_live_123', 'rkcs_live_123', 'pk_test_123', 'whsec_123', ' sk_test_123']) assert.ok(!secret.pattern.test(key), key);
  assert.ok(publishable.pattern.test('pk_test_1') && !publishable.pattern.test('pk_live_1'));
  // Required, like the secret key: a Stripe service that is not blocked always provides STRIPE_PUBLISHABLE_KEY.
  assert.deepEqual(missingInputs(stripe, { secretKey: 'sk_test_123' }), ['publishableKey']);
  assert.deepEqual(missingInputs(stripe, { secretKey: 'sk_test_123', publishableKey: 'pk_test_123' }), []);
});

// What `stripe sandbox create --non-interactive` prints; the keys are fixtures, never real ones.
const SANDBOX = { secret_key: 'rkcs_test_fixture_secret_1', publishable_key: 'pk_test_fixture_public_1', claim_url: 'https://dashboard.stripe.com/onboard_sandbox/fixture',
  account_id: 'acct_fixture1', expires_at: '2026-10-01' };
const sandboxOutput = (sandbox: Record<string, unknown> = SANDBOX) => `Setting up your sandbox... done.\n${JSON.stringify(sandbox, null, 2)}\nClaim this sandbox to keep it {beyond 7 days}.\n`;
const provisionContext = async (respond: (args: string[]) => CommandOutput) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'stripe-provision-')), calls: { args: string[]; options?: { timeoutMs?: number } }[] = [];
  const docker: DockerCommand = async (args, options) => { calls.push({ args, options }); return respond(args); };
  return { tempDir, calls, inputs: { email: 'dev@example.test' }, docker };
};

test('Stripe creates a sandbox with the pinned CLI in an empty mounted config and returns its keys and details', async () => {
  const ctx = await provisionContext(() => ({ stdout: sandboxOutput(), stderr: '' }));
  assert.deepEqual(stripe.provision.inputs, [{ name: 'email', label: 'Email', default: 'git-email' }]);
  assert.deepEqual(await stripe.provision.run(ctx), {
    values: { secretKey: SANDBOX.secret_key, publishableKey: SANDBOX.publishable_key },
    details: { expiresAt: '2026-10-01', claimUrl: SANDBOX.claim_url, account: 'acct_fixture1' },
  });
  const [{ args, options }] = ctx.calls;
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(args, ['run', '--rm', '--env', 'STRIPE_CLI_TELEMETRY_OPTOUT=1', '--volume', `${ctx.tempDir}:/cfg`,
    STRIPE_CLI, '--config', '/cfg/config.toml', 'sandbox', 'create', '--email', 'dev@example.test', '--non-interactive']);
  assert.deepEqual(options, { timeoutMs: 90000 });
  assert.ok(!args.some(arg => SOCKET.test(arg)));
  // The returned values pass the service's own input patterns.
  for (const input of stripe.inputs) assert.ok(input.pattern.test(((await stripe.provision.run(ctx)).values as Record<string, string>)[input.name]), input.name);
});

test('Stripe sandbox creation reports one fixed message and never the CLI output', async () => {
  const pairing = 'Your pairing code is: fixture-words\nTo authenticate with Stripe, please go to: https://dashboard.stripe.com/stripecli/confirm_auth?t=fixture\n';
  const cases: { stdout?: string; reject?: Error }[] = [
    { stdout: pairing },
    { stdout: `Setting up your sandbox... done.\n{ "secret_key": "rkcs_test_fixture_secret_1", "publishable_key": \n` },
    { stdout: '{"secret_key": "rkcs_test_fixture_secret_1", oops}' },
    { stdout: sandboxOutput({ ...SANDBOX, secret_key: ['sk', 'live', 'fixture_secret_1'].join('_') }) },
    { stdout: sandboxOutput({ ...SANDBOX, publishable_key: 'pk_live_fixture_public_1' }) },
    { stdout: sandboxOutput({ ...SANDBOX, claim_url: 'https://example.test/claim' }) },
    { stdout: sandboxOutput({ ...SANDBOX, account_id: 'fixture1' }) },
    { stdout: sandboxOutput({ ...SANDBOX, expires_at: 'in 7 days' }) },
    { stdout: sandboxOutput({ ...SANDBOX, secret_key: 42 }) },
    { stdout: '' },
    { reject: Object.assign(new Error(`Command failed: docker run\n${sandboxOutput()}`), { stdout: sandboxOutput(), stderr: 'rkcs_test_fixture_secret_1' }) },
  ];
  for (const { stdout, reject } of cases) {
    const ctx = await provisionContext(() => { if (reject) throw reject; return { stdout: stdout!, stderr: 'rkcs_test_fixture_secret_1' }; });
    await assert.rejects(stripe.provision.run(ctx), (error: Error) => {
      assert.equal(error.message, SANDBOX_FAILED);
      assert.ok(!/rkcs_|sk_live|pk_test|pk_live|acct_|pairing|dashboard/.test(error.message + (error.stack ?? '')), String(stdout));
      return true;
    });
  }
  assert.equal(SANDBOX_FAILED, 'Stripe could not create a sandbox. Try again later, or enter test keys.');
});

test('Stripe refuses an invalid email before running anything', async () => {
  for (const email of ['', 'dev', 'dev@example', 'dev @example.test', '@example.test', '--help@example.test', `${'a'.repeat(250)}@example.test`, 42, undefined]) {
    const ctx = await provisionContext(() => ({ stdout: sandboxOutput() }));
    // @ts-expect-error an email input may be missing or not text
    ctx.inputs = { email };
    await assert.rejects(stripe.provision.run(ctx), /Email does not have the expected format/, String(email));
    assert.deepEqual(ctx.calls, [], String(email));
  }
});

test('Stripe setup runs fixtures and prints the webhook secret through the pinned CLI image', async () => {
  let ctx: Fake<StripeContext>;
  const respond: Respond = async ({ args }) => {
    if (args[0] === 'fixtures') await writeFile(join(ctx.dir, '.env'), 'STRIPE_PRICE_PRO_MONTHLY="price_month"\nSTRIPE_PRODUCT_PRO="prod_pro"\n');
    return args.includes('--print-secret') ? 'whsec_abc123\n' : '';
  };
  ctx = await context<StripeContext>({ respond, inputs: { secretKey: 'sk_test_key' }, options: { fixtures: 'billing/stripe.json', webhook: 'http://host.docker.internal:43150/stripe/webhook' } });
  await mkdir(join(ctx.source, 'billing'), { recursive: true }); await mkdir(ctx.dir, { recursive: true });
  await writeFile(join(ctx.source, 'billing/stripe.json'), '{"_meta":{"template_version":0},"fixtures":[]}');
  ctx.outputs = await stripe.setup(ctx);
  const env = { STRIPE_API_KEY: 'sk_test_key', STRIPE_DEVICE_NAME: 'perpetual-beta1', STRIPE_CLI_TELEMETRY_OPTOUT: '1' };
  const dir = ctx.dir;
  assert.deepEqual(ctx.calls, [
    { image: STRIPE_CLI, args: ['fixtures', 'fixtures.json'], options: { env } },
    { image: STRIPE_CLI, args: ['listen', '--print-secret'], options: { env } },
  ]);
  assert.match(STRIPE_CLI, /^stripe\/stripe-cli:v\d+\.\d+\.\d+$/);
  assert.ok(ctx.calls.every(({ args }) => !args.some(arg => /sk_test/.test(arg))));
  assert.equal(await readFile(join(dir, 'fixtures.json'), 'utf8'), '{"_meta":{"template_version":0},"fixtures":[]}');
  assert.equal(await mode(join(dir, '.env')), 0o600);
  assert.deepEqual(stripe.env(ctx), {
    STRIPE_PRICE_PRO_MONTHLY: 'price_month', STRIPE_PRODUCT_PRO: 'prod_pro', STRIPE_SECRET_KEY: 'sk_test_key', STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
  });
  ctx.inputs.publishableKey = 'pk_test_pub';
  assert.equal(stripe.env(ctx).STRIPE_PUBLISHABLE_KEY, 'pk_test_pub');
});

test('Stripe names a fixtures file the repository does not have before running its CLI', async () => {
  const ctx = await context<StripeContext>({ inputs: { secretKey: 'sk_test_key' }, options: { fixtures: 'billing/stripe.json' } });
  await mkdir(ctx.dir, { recursive: true });
  await assert.rejects(stripe.setup(ctx), { message: 'stripe.fixtures billing/stripe.json is not a file in the repository.' });
  assert.deepEqual(ctx.calls, []);
});

test('Stripe runs an inline fixtures document when the repository has none, and provides its env names', async () => {
  let ctx: Fake<StripeContext>;
  const respond: Respond = async ({ args }) => { if (args[0] === 'fixtures') await writeFile(join(ctx.dir, '.env'), 'STRIPE_PRICE_PRO_MONTHLY="price_month"\n'); return ''; };
  const document: JsonObject = { fixtures: [
    { name: 'pro', path: '/v1/products', method: 'post', params: { name: 'Pro' } },
    { name: 'pro_monthly', path: '/v1/prices', method: 'post', params: { product: '${pro:id}', unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } } },
  ], env: { STRIPE_PRICE_PRO_MONTHLY: '${pro_monthly:id}' } };
  ctx = await context<StripeContext>({ respond, inputs: { secretKey: 'sk_test_key' }, options: { fixtures: document } });
  await mkdir(ctx.dir, { recursive: true });
  stripe.validate(ctx.options);
  ctx.outputs = await stripe.setup(ctx);
  assert.deepEqual(ctx.calls.map(call => call.args), [['fixtures', 'fixtures.json']]);
  assert.deepEqual(JSON.parse(await readFile(join(ctx.dir, 'fixtures.json'), 'utf8')), { ...document, _meta: { template_version: 0 } });
  assert.equal(await mode(join(ctx.dir, 'fixtures.json')), 0o600);
  assert.equal((stripe.env(ctx) as Record<string, string | undefined>).STRIPE_PRICE_PRO_MONTHLY, 'price_month');
  assert.deepEqual(stripe.describe.optionProvides?.({ fixtures: document }), ['STRIPE_PRICE_PRO_MONTHLY'], 'The work list counts them as provided.');
  assert.deepEqual(stripe.describe.optionProvides?.({ fixtures: 'billing/stripe.json', webhook: 'http://web/hooks' }), ['STRIPE_WEBHOOK_SECRET']);
  assert.equal(stripe.describe.setupProvides?.({ fixtures: 'billing/stripe.json' }, 'STRIPE_PRICE_PRO_MONTHLY'), true, 'A repository file\'s names are known only at setup.');
  assert.equal(stripe.describe.setupProvides?.({ fixtures: 'billing/stripe.json' }, 'STRIPE_WEBHOOK_SECRET'), false, 'Only a webhook gives its secret.');
  assert.equal(stripe.describe.setupProvides?.({ fixtures: document }, 'STRIPE_PRICE_PRO_YEARLY'), false);
  // Only named requests to the Stripe API's /v1/ paths, and upper-case exported names.
  const refused: [Json, RegExp][] = [
    [{ fixtures: [] }, /must list 1 to 50 requests/],
    [{ fixtures: [{ name: 'x', path: 'https://evil.example/v1/x' }] }, /Stripe API path under \/v1\//],
    [{ fixtures: [{ name: 'x', path: '/v1/x', method: 'delete' }] }, /method must be get or post/],
    [{ fixtures: [{ name: 'Bad Name', path: '/v1/x' }] }, /needs a name/],
    [{ fixtures: [{ name: 'x', path: '/v1/x' }], env: { lower: '${x:id}' } }, /upper-case variable names/],
    [{ fixtures: [{ name: 'x', path: '/v1/x' }], run: 'rm -rf /' }, /unsupported field run/],
  ];
  for (const [fixtures, error] of refused) assert.throws(() => stripe.validate({ fixtures }), error);
});

for (const [name, events] of [
  ['an empty subscription', []],
  ['an empty event name', ['']],
  ['a wildcard subscription', ['*']],
  ['snapshot and thin events at one webhook', ['checkout.session.completed', 'v1.billing.meter.no_meter_found']],
] as const) test(`Stripe configuration rejects ${name} before setup`, () => {
  const errors = serviceOptionErrors({ services: { stripe: { webhook: 'http://host.docker.internal:43150/hooks/stripe', events: [...events] } } });
  assert.match(errors.join('\n'), /stripe\.events/);
});

test('Stripe configuration accepts default events or one webhook payload style', () => {
  const subscriptions: JsonObject[] = [{}, { events: ['invoice.paid'] }, { events: ['v1.billing.meter.no_meter_found', 'v2.core.account.created'] }];
  for (const options of subscriptions) {
    assert.deepEqual(serviceOptionErrors({ services: { stripe: { ...options, webhook: 'http://host.docker.internal:43150/hooks/stripe' } } }), []);
  }
});

test('Stripe listen forwards explicit events to the configured webhook', async () => {
  const ctx = await context<StripeContext>({ inputs: { secretKey: 'rk_test_key' }, options: { webhook: 'http://host.docker.internal:43150/hooks/stripe' } });
  const [listen] = stripe.containers(ctx);
  assert.equal(listen.image, STRIPE_CLI);
  assert.deepEqual(listen.command, ['listen', '--skip-update', '--events', EVENTS.join(','), '--forward-to', 'http://host.docker.internal:43150/hooks/stripe']);
  assert.equal(listen.env.STRIPE_API_KEY, 'rk_test_key');
  assert.ok(!EVENTS.includes('*'));
  ctx.options.events = ['invoice.paid'];
  assert.deepEqual(stripe.containers(ctx)[0].command.slice(2, 4), ['--events', 'invoice.paid']);
  assert.deepEqual(stripe.containers(await context<StripeContext>({ inputs: { secretKey: 'sk_test_key' } })), []);
  // A twin config checks options only as JSON; the events are checked where the listener uses them.
  for (const events of ['invoice.paid', ['invoice.paid', 1], { name: 'invoice.paid' }]) {
    ctx.options.events = events;
    assert.throws(() => stripe.containers(ctx), /stripe\.events must list webhook event names/);
  }
});

test('Stripe without a webhook or fixtures only provides the keys', async () => {
  const ctx = await context<StripeContext>({ inputs: { secretKey: 'sk_test_key', publishableKey: 'pk_test_key' } });
  ctx.outputs = await stripe.setup(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(stripe.env(ctx), { STRIPE_SECRET_KEY: 'sk_test_key', STRIPE_PUBLISHABLE_KEY: 'pk_test_key' });
});

test('Stripe without its publishable key is blocked on it, so an app that maps the key leaves it out instead of failing', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(source);
  const runtime = createTwinRuntime({ exec: async () => ({ stdout: '', stderr: '' }), owner: 'owner-1', isFree: async () => true });
  const config = { services: { stripe: {} }, apps: { web: { start: 'npm start', port: 3000, env: { NEXT_PUBLIC_STRIPE_KEY: '{{stripe.STRIPE_PUBLISHABLE_KEY}}' } } } };
  const prepare = (stripe: Record<string, string>) => runtime.prepare({ dataDir, id: 'beta', config, source, inputs: { stripe } });
  const dotenv = () => readFile(join(dataDir, 'environments', 'beta', 'twin', '.env'), 'utf8');
  const blocked = await prepare({ secretKey: 'sk_test_own_key' });
  assert.deepEqual(blocked.services, [{ id: 'stripe', fidelity: 'official-sandbox', status: 'blocked', missing: ['publishableKey'] }]);
  assert.doesNotMatch(await dotenv(), /STRIPE/);
  const ready = await prepare({ secretKey: 'sk_test_own_key', publishableKey: 'pk_test_own_key' });
  assert.equal(ready.status, 'ready');
  assert.match(await dotenv(), /^WEB__NEXT_PUBLIC_STRIPE_KEY="pk_test_own_key"$/m);
  assert.match(await dotenv(), /^WEB__STRIPE_PUBLISHABLE_KEY="pk_test_own_key"$/m);
});

test('Stripe setup fails when the CLI prints no signing secret', async () => {
  const ctx = await context<StripeContext>({ respond: () => 'Your API key is invalid', inputs: { secretKey: 'sk_test_key' }, options: { webhook: 'http://host.docker.internal:1/w' } });
  await assert.rejects(stripe.setup(ctx), /webhook signing secret/);
});
