import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import supabase, { cliEntry } from '../src/twin/services/supabase.ts';
import { CLI as STRIPE_CLI } from '../src/twin/services/stripe.ts';
import type { Json } from '../src/twin/config.ts';
import type { InputValues } from '../src/twin/registry.ts';
import { supabaseEdgeFiles } from './fixtures/twin/supabase-edge.ts';

type SupabaseContext = Parameters<typeof supabase.setup>[0];
type Fake = SupabaseContext & { root: string; calls: string[][] };

const HOST = 'host.docker.internal';
const STATUS = ['ANON_KEY="anon.jwt"', 'SERVICE_ROLE_KEY="service.jwt"', 'JWT_SECRET="jwt-secret"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"', ''].join('\n');
const CONFIG = 'project_id = "shop"\n\n[api]\nport = 54321\n\n[edge_runtime]\nenabled = false\npolicy = "per_worker"\n';
const HANDLER = 'Deno.serve(() => new Response("ok"));\n';
const section = (toml: string, name: string) => toml.split(/^(?=\[)/m).find(part => part.startsWith(`[${name}]\n`)) ?? '';
const mode = async (file: string) => (await stat(file)).mode & 0o777;
const files = async (root: string, entries: Record<string, string>) => {
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

// A Supabase service context whose CLI runs return canned output; nothing touches Docker, and setup asks for nothing else.
async function context(options: { directory?: string; functions?: Json }): Promise<Fake> {
  const root = await mkdtemp(join(tmpdir(), 'twin-functions-')), ports = new Map<string, number>(), calls: string[][] = [];
  const port = (name: string) => { if (!ports.has(name)) ports.set(name, 43100 + ports.size); return ports.get(name)!; };
  await files(join(root, 'source'), {
    'supabase/config.toml': CONFIG, 'supabase/functions/hello/index.ts': HANDLER, 'supabase/functions/private/index.ts': HANDLER,
    'supabase/functions/.env': 'STRIPE_WEBHOOK_SECRET=whsec_production\n',
  });
  await mkdir(join(root, 'twin'), { recursive: true });
  return {
    root, calls, project: 'perpetual-beta1', dir: join(root, 'twin'), shared: join(root, 'shared'), source: join(root, 'source'), options, inputs: {},
    outputs: { url: '', anonKey: '', serviceRoleKey: '', jwtSecret: '', dbUrl: '' },
    host: HOST, port, url: (name: string, path = '') => `http://${HOST}:${port(name)}${path}`,
    sharedPort: async () => { throw new Error('Unexpected shared port'); }, apps: [], app: () => { throw new Error('Unexpected app'); },
    run: async () => ({ stdout: '' }),
    exec: async (command: string, args: string[]) => { calls.push(args); return { stdout: args.includes('status') ? STATUS : '' }; },
  };
}
const project = (ctx: Fake) => join(ctx.dir, 'supabase', 'supabase');
const starts = (ctx: Fake) => ctx.calls.filter(args => args.includes('start')).length;

test('Supabase serves edge functions with the twin env file, and only the listed functions skip the JWT check', async t => {
  const ctx = await context({ functions: { env: { STRIPE_WEBHOOK_SECRET: 'whsec_twin', RETRIES: 3, NOTE: 'a "b" $HOME #c \\n' }, noVerifyJwt: ['hello', 'hello'] } });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  await supabase.setup(ctx);
  const toml = await readFile(join(project(ctx), 'config.toml'), 'utf8');
  assert.match(section(toml, 'edge_runtime'), /^enabled = true$/m);
  assert.match(section(toml, 'edge_runtime'), /^policy = "per_worker"$/m);
  assert.match(section(toml, 'edge_runtime'), new RegExp(`^inspector_port = ${ctx.port('inspector')}$`, 'm'));
  assert.equal(section(toml, 'functions.hello'), '[functions.hello]\nverify_jwt = false\n');
  assert.equal(section(toml, 'functions.private'), '');
  assert.equal(await readFile(join(project(ctx), 'functions/hello/index.ts'), 'utf8'), HANDLER);
  // The CLI reads supabase/functions/.env and takes single-quoted values literally; the repository's own file never reaches the twin.
  const env = join(project(ctx), 'functions/.env');
  assert.equal(await readFile(env, 'utf8'), "STRIPE_WEBHOOK_SECRET='whsec_twin'\nRETRIES='3'\nNOTE='a \"b\" $HOME #c \\n'\n");
  assert.equal(await mode(env), 0o600);
  assert.deepEqual(ctx.calls.map(args => args.slice(0, 2)), [[await cliEntry(), 'stop'], [await cliEntry(), 'start'], [await cliEntry(), 'status']]);
  assert.equal(ctx.calls[1].at(-1), join(ctx.dir, 'supabase'));
});

test('Supabase takes functions from their own repository directory in place of the project copy', async t => {
  const ctx = await context({ functions: { directory: './edge/', noVerifyJwt: ['stripe-webhook'] } });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  await files(ctx.source, { 'edge/stripe-webhook/index.ts': HANDLER, 'edge/_shared/stripe.ts': 'export {};\n' });
  await supabase.setup(ctx);
  assert.equal(await readFile(join(project(ctx), 'functions/stripe-webhook/index.ts'), 'utf8'), HANDLER);
  assert.equal(await readFile(join(project(ctx), 'functions/_shared/stripe.ts'), 'utf8'), 'export {};\n');
  await assert.rejects(stat(join(project(ctx), 'functions/hello')));
  assert.equal(await readFile(join(project(ctx), 'functions/.env'), 'utf8'), '');
  assert.match(section(await readFile(join(project(ctx), 'config.toml'), 'utf8'), 'functions.stripe-webhook'), /^verify_jwt = false$/m);
});

test('Supabase preserves an edge function import-map directory and its local package files in the isolated project', async t => {
  const ctx = await context({ functions: { noVerifyJwt: ['hello'] } });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  await files(ctx.source, supabaseEdgeFiles);
  await supabase.setup(ctx);
  for (const path of ['functions/hello/deno.json', 'functions/hello/index.ts', 'packages/shared/index.ts', 'packages/shared/detail.ts']) {
    assert.equal(await readFile(join(project(ctx), path), 'utf8'), supabaseEdgeFiles[`supabase/${path}`]);
  }
  assert.match(section(await readFile(join(project(ctx), 'config.toml'), 'utf8'), 'edge_runtime'), /^enabled = true$/m);
});

test('Supabase makes an explicit legacy import map discoverable beside its entrypoint in the isolated project', async t => {
  const ctx = await context({ functions: {} });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  const config = `${CONFIG}\n[functions."hello"]\nimport_map = "./functions/import_map.json"\nentrypoint = "./functions/hello/handlers/run.ts"\n`;
  const map = '{\n  "imports": {"shared/": "../packages/shared/"},\n  "scopes": {"./hello/": {"shared/": "../packages/override/"}}\n}\n';
  await files(ctx.source, {
    'supabase/config.toml': config,
    'supabase/functions/import_map.json': map,
    'supabase/functions/hello/handlers/run.ts': HANDLER,
  });
  await supabase.setup(ctx);
  assert.deepEqual(JSON.parse(await readFile(join(project(ctx), 'functions/hello/handlers/deno.json'), 'utf8')), { importMap: '../../import_map.json' });
  assert.equal(await readFile(join(project(ctx), 'functions/import_map.json'), 'utf8'), map);
  assert.match(await readFile(join(project(ctx), 'config.toml'), 'utf8'), /import_map = "\.\/functions\/import_map.json"/);
  assert.equal(await readFile(join(ctx.source, 'supabase/config.toml'), 'utf8'), config);
  await assert.rejects(stat(join(ctx.source, 'supabase/functions/hello/handlers/deno.json')), { code: 'ENOENT' });
});

test('Supabase uses the official function-local and global legacy map fallbacks without overwriting Deno configs', async t => {
  const ctx = await context({ functions: {} });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  const deno = '{"imports":{"chosen":"./chosen.ts"}}\n', denoc = '{\n// chosen by the repository\n"imports": {"chosen": "./chosen.ts"}\n}\n';
  await files(ctx.source, {
    'supabase/config.toml': `${CONFIG}\n[functions.existing]\nimport_map = "./functions/import_map.json"\n[functions.comments]\nimport_map = "./functions/import_map.json"\n[functions.hello]\nentrypoint = ""\n`,
    'supabase/functions/import_map.json': '{"imports": {"shared/": "../packages/shared/"}}',
    'supabase/functions/private/import_map.json': '{"imports": {"shared/": "../../packages/private/"}}',
    'supabase/functions/existing/index.ts': HANDLER, 'supabase/functions/existing/deno.json': deno,
    'supabase/functions/comments/index.ts': HANDLER, 'supabase/functions/comments/deno.jsonc': denoc,
    'supabase/functions/_shared/index.ts': HANDLER,
    'supabase/functions/.cache/metadata.json': '{}', 'supabase/functions/test.fixtures/note.txt': 'fixture data',
    'supabase/functions/9fixture/index.ts': HANDLER,
  });
  await supabase.setup(ctx);
  assert.deepEqual(JSON.parse(await readFile(join(project(ctx), 'functions/hello/deno.json'), 'utf8')), { importMap: '../import_map.json' });
  assert.deepEqual(JSON.parse(await readFile(join(project(ctx), 'functions/private/deno.json'), 'utf8')), { importMap: './import_map.json' });
  assert.equal(await readFile(join(project(ctx), 'functions/existing/deno.json'), 'utf8'), deno);
  assert.equal(await readFile(join(project(ctx), 'functions/comments/deno.jsonc'), 'utf8'), denoc);
  await assert.rejects(stat(join(project(ctx), 'functions/comments/deno.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(project(ctx), 'functions/_shared/deno.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(project(ctx), 'functions/9fixture/deno.json')), { code: 'ENOENT' });
});

test('Supabase rejects malformed legacy map settings and paths outside its copy before starting the stack', async t => {
  const cases = [
    ['[functions.hello', /valid TOML/],
    ['functions = 3', /functions must be a table/],
    ['[functions]\nhello = []', /function names to tables/],
    ['[functions.hello]\nimport_map = 42', /import_map must be text/],
    ['[functions.hello]\nentrypoint = false', /entrypoint must be a relative path/],
    ['[functions.hello]\nentrypoint = 0', /entrypoint must be a relative path/],
    ['[functions.hello]\nenabled = "true"', /enabled must be a boolean/],
    ['[functions.hello]\nimport_map = "../outside.json"', /inside the copied project/],
    ['[functions.hello]\nimport_map = "/tmp/outside.json"', /inside the copied project/],
    ['[functions.hello]\nimport_map = "file:///tmp/outside.json"', /inside the copied project/],
    ['[functions.hello]\nimport_map = "https://example.test/map.json"', /inside the copied project/],
    ['[functions.hello]\nentrypoint = "../outside.ts"', /inside the copied project/],
    ['[functions."../outside"]\nimport_map = "./functions/import_map.json"', /function names to tables/],
  ] as const;
  for (const [settings, expected] of cases) {
    const ctx = await context({ functions: {} });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    await files(ctx.source, { 'supabase/config.toml': settings, 'supabase/functions/import_map.json': '{"imports":{}}' });
    await assert.rejects(supabase.setup(ctx), expected, settings);
    assert.equal(starts(ctx), 0, settings);
  }
});

test('Supabase refuses legacy map, entrypoint and Deno config symlinks instead of writing outside its copy', async t => {
  for (const linked of ['functions/import_map.json', 'functions/maps', 'functions/hello/handlers', 'functions/hello/deno.json']) {
    const ctx = await context({ functions: {} });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    const outside = join(ctx.root, 'outside');
    await files(outside, { 'map.json': '{"imports":{}}', 'index.ts': HANDLER });
    const settings = linked === 'functions/hello/handlers'
      ? 'entrypoint = "./functions/hello/handlers/index.ts"'
      : `import_map = "./${linked === 'functions/maps' ? 'functions/maps/map.json' : 'functions/import_map.json'}"`;
    await files(ctx.source, { 'supabase/config.toml': `${CONFIG}\n[functions.hello]\n${settings}\n` });
    await symlink(linked.endsWith('.json') ? join(outside, 'map.json') : outside, join(ctx.source, 'supabase', linked));
    await assert.rejects(supabase.setup(ctx), /cannot follow a symbolic link/, linked);
    assert.equal(starts(ctx), 0);
    assert.equal(await readFile(join(outside, 'map.json'), 'utf8'), '{"imports":{}}');
    await assert.rejects(stat(join(outside, 'deno.json')), { code: 'ENOENT' });
  }
});

test('Supabase keeps ancestor Deno configuration active for nested function entrypoints', async t => {
  for (const path of ['functions/hello/deno.json', 'functions/deno.jsonc']) {
    const ctx = await context({ functions: {} });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    const deno = '{"compilerOptions":{"strict":true},"imports":{"chosen":"./chosen.ts"}}\n';
    await files(ctx.source, {
      'supabase/config.toml': `${CONFIG}\n[functions.hello]\nentrypoint = "./functions/hello/handlers/run.ts"\nimport_map = "./functions/import_map.json"\n`,
      'supabase/functions/hello/handlers/run.ts': HANDLER,
      'supabase/functions/import_map.json': '{"imports":{}}', [`supabase/${path}`]: deno,
    });
    await supabase.setup(ctx);
    assert.equal(await readFile(join(project(ctx), path), 'utf8'), deno);
    await assert.rejects(stat(join(project(ctx), 'functions/hello/handlers/deno.json')), { code: 'ENOENT' });
  }
});

test('Supabase does not treat an unmounted project-level Deno file as the function config', async t => {
  const ctx = await context({ functions: {} });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  const deno = '{"imports":{"chosen":"./chosen.ts"}}';
  await files(ctx.source, {
    'supabase/deno.json': deno,
    'supabase/functions/import_map.json': '{"imports":{}}',
  });
  await supabase.setup(ctx);
  assert.deepEqual(JSON.parse(await readFile(join(project(ctx), 'functions/hello/deno.json'), 'utf8')), { importMap: '../import_map.json' });
  assert.equal(await readFile(join(project(ctx), 'deno.json'), 'utf8'), deno);
});

test('Supabase cannot bridge conflicting import maps for entrypoints in the same directory', async t => {
  for (const sameMap of [false, true]) {
    const ctx = await context({ functions: {} });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    await files(ctx.source, {
      'supabase/config.toml': `${CONFIG}\n[functions.one]\nentrypoint = "./functions/shared/one.ts"\nimport_map = "./functions/first.json"\n[functions.two]\nentrypoint = "./functions/shared/two.ts"\nimport_map = "./functions/${sameMap ? 'first' : 'second'}.json"\n`,
      'supabase/functions/shared/one.ts': HANDLER, 'supabase/functions/shared/two.ts': HANDLER,
      'supabase/functions/first.json': '{"imports":{"chosen":"./first.ts"}}', 'supabase/functions/second.json': '{"imports":{"chosen":"./second.ts"}}',
    });
    if (sameMap) {
      await supabase.setup(ctx);
      assert.deepEqual(JSON.parse(await readFile(join(project(ctx), 'functions/shared/deno.json'), 'utf8')), { importMap: '../first.json' });
    } else {
      await assert.rejects(supabase.setup(ctx), /share an entrypoint directory but use different import maps/);
      assert.equal(starts(ctx), 0);
      await assert.rejects(stat(join(project(ctx), 'functions/shared/deno.json')), { code: 'ENOENT' });
    }
  }
});

test('Supabase does not introduce an ancestor map for a function that had no legacy map', async t => {
  const ctx = await context({ functions: {} });
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  await files(ctx.source, {
    'supabase/config.toml': `${CONFIG}\n[functions.one]\nentrypoint = "./functions/shared/one.ts"\nimport_map = "./functions/first.json"\n[functions.two]\nentrypoint = "./functions/shared/nested/two.ts"\n`,
    'supabase/functions/shared/one.ts': HANDLER, 'supabase/functions/shared/nested/two.ts': HANDLER,
    'supabase/functions/first.json': '{"imports":{"chosen":"./first.ts"}}',
  });
  await assert.rejects(supabase.setup(ctx), /would change another function without a legacy import map/);
  assert.equal(starts(ctx), 0);
  await assert.rejects(stat(join(project(ctx), 'functions/shared/deno.json')), { code: 'ENOENT' });
});

test('Supabase only bridges a legacy map beside an entrypoint in the mounted functions tree', async t => {
  for (const mode of ['legacy', 'native', 'no-map']) {
    const ctx = await context({ functions: {} });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    await files(ctx.source, {
      'supabase/config.toml': `${CONFIG}\n[functions.hello]\nentrypoint = "./edge/index.ts"\n${mode === 'no-map' ? '' : 'import_map = "./functions/import_map.json"\n'}`,
      'supabase/edge/index.ts': HANDLER,
      ...(mode === 'no-map' ? {} : { 'supabase/functions/import_map.json': '{"imports":{}}' }),
      ...(mode === 'native' ? { 'supabase/edge/deno.json': '{"imports":{}}' } : {}),
    });
    if (mode === 'legacy') {
      await assert.rejects(supabase.setup(ctx), /cannot be bridged for an entrypoint outside functions/);
      assert.equal(starts(ctx), 0);
      await assert.rejects(stat(join(project(ctx), 'edge/deno.json')), { code: 'ENOENT' });
    } else {
      await supabase.setup(ctx);
      if (mode === 'native') assert.equal(await readFile(join(project(ctx), 'edge/deno.json'), 'utf8'), '{"imports":{}}');
      else await assert.rejects(stat(join(project(ctx), 'edge/deno.json')), { code: 'ENOENT' });
    }
  }
});

test('Without the functions option the project config and its functions are copied as they are', async t => {
  const ctx = await context({});
  t.after(() => rm(ctx.root, { recursive: true, force: true }));
  await supabase.setup(ctx);
  const toml = await readFile(join(project(ctx), 'config.toml'), 'utf8');
  assert.match(section(toml, 'edge_runtime'), /^enabled = false$/m);
  assert.doesNotMatch(toml, /\[functions\./);
  assert.equal(await readFile(join(project(ctx), 'functions/.env'), 'utf8'), 'STRIPE_WEBHOOK_SECRET=whsec_production\n');
});

test('Functions options are checked before the stack starts', async t => {
  const cases: [Json, RegExp][] = [
    [[], /supabase\.functions must be an object with directory, env, noVerifyJwt\./],
    [{ verifyJwt: false }, /supabase\.functions has unsupported field verifyJwt; use directory, env, noVerifyJwt\./],
    [{ env: ['A'] }, /supabase\.functions\.env must map variable names to values\./],
    [{ env: { 'BAD-NAME': 'x' } }, /supabase\.functions\.env\.BAD-NAME is not a valid variable name\./],
    [{ env: { SUPABASE_URL: 'http://elsewhere' } }, /supabase\.functions\.env\.SUPABASE_URL: the local stack provides SUPABASE_ variables itself\./],
    [{ env: { A: { nested: true } } }, /supabase\.functions\.env\.A must be text\./],
    [{ env: { A: "it's" } }, /supabase\.functions\.env\.A cannot contain a single quote or end with a backslash\./],
    [{ env: { A: 'path\\' } }, /cannot contain a single quote or end with a backslash/],
    [{ noVerifyJwt: 'hello' }, /supabase\.functions\.noVerifyJwt must list function names\./],
    [{ noVerifyJwt: ['../hello'] }, /noVerifyJwt must list function names/],
    [{ noVerifyJwt: ['helo'] }, /supabase\.functions\.noVerifyJwt names helo, but supabase\/functions has no function helo\./],
    [{ directory: 'edge' }, /supabase\.functions\.directory edge is not a directory in the repository\./],
    [{ directory: '../outside' }, /supabase\.functions\.directory must stay inside the repository\./],
  ];
  for (const [functions, error] of cases) {
    const ctx = await context({ functions });
    t.after(() => rm(ctx.root, { recursive: true, force: true }));
    await assert.rejects(supabase.setup(ctx), error, JSON.stringify(functions));
    assert.equal(starts(ctx), 0, JSON.stringify(functions));
  }
});

// The twin runtime with the real Supabase and Stripe services and canned command output.
async function twin(respond: (file: string, args: string[]) => string | undefined | Promise<string | undefined> = () => undefined) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source'), calls: { file: string; args: string[] }[] = [], steps: string[] = [];
  await files(source, { 'supabase/config.toml': CONFIG, 'supabase/functions/stripe-webhook/index.ts': HANDLER });
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args });
    const stdout = await respond(file, args);
    if (stdout !== undefined) return { stdout, stderr: '' };
    if (args.includes('--print-secret')) return { stdout: 'whsec_twin_1\n', stderr: '' };
    return { stdout: file === process.execPath && args.includes('status') ? STATUS : '', stderr: '' };
  };
  const runtime = createTwinRuntime({ exec, owner: 'o', isFree: async () => true });
  const config = {
    services: {
      supabase: { functions: { env: { STRIPE_WEBHOOK_SECRET: '{{stripe.STRIPE_WEBHOOK_SECRET}}', STRIPE_SECRET_KEY: '{{stripe.STRIPE_SECRET_KEY}}', SITE: 'twin' }, noVerifyJwt: ['stripe-webhook'] } },
      stripe: { webhook: '{{services.supabase.url.api}}/functions/v1/stripe-webhook' },
    },
  };
  const dir = join(dataDir, 'environments', 'beta', 'twin');
  const prepare = (inputs: Record<string, InputValues>) => runtime.prepare({ dataDir, id: 'beta', config, source, inputs, onStep: step => steps.push(step) });
  return { dataDir, calls, steps, prepare, dir, functionsEnv: join(dir, 'services/supabase/supabase/supabase/functions/.env'), toml: join(dir, 'services/supabase/supabase/supabase/config.toml') };
}
const KEYS = { stripe: { secretKey: 'sk_test_twin_key', publishableKey: 'pk_test_twin_key' } };

test('A Stripe webhook targets the Supabase functions URL while the functions get the signing secret Stripe setup prints', async t => {
  const { dataDir, calls, steps, prepare, dir, functionsEnv, toml } = await twin();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = await prepare(KEYS);
  assert.equal(result.status, 'ready');
  assert.deepEqual(steps.slice(0, 2), ['Setting up services', 'Starting services']);
  const stripeSetup = calls.findIndex(({ args }) => args.includes('--print-secret'));
  const functionsSetup = calls.findIndex(({ file, args }) => file === process.execPath && args.includes('start'));
  assert.ok(stripeSetup >= 0 && functionsSetup > stripeSetup, 'Functions wait for the webhook signing secret even when independent services prepare concurrently.');
  const api = Number(section(await readFile(toml, 'utf8'), 'api').match(/^port = (\d+)$/m)![1]);
  const listen = YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8')).services['stripe-listen'];
  assert.equal(listen.command.at(-1), `http://${HOST}:${api}/functions/v1/stripe-webhook`);
  assert.equal(listen.image, STRIPE_CLI);
  assert.equal(await readFile(functionsEnv, 'utf8'), "STRIPE_WEBHOOK_SECRET='whsec_twin_1'\nSTRIPE_SECRET_KEY='sk_test_twin_key'\nSITE='twin'\n");
  assert.equal(await mode(functionsEnv), 0o600);
  assert.ok(calls.every(({ args }) => !args.some(arg => /whsec_twin_1|sk_test_twin_key/.test(arg))), 'secrets never travel as arguments');
});

test('Supabase failures never reveal the secrets its functions receive', async t => {
  const { dataDir, prepare } = await twin((file, args) => {
    if (file === process.execPath && args.includes('start')) throw Object.assign(new Error('Command failed'), { stderr: 'edge runtime exited: STRIPE_WEBHOOK_SECRET=whsec_twin_1 STRIPE_SECRET_KEY=sk_test_twin_key\n' });
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(prepare(KEYS), (error: Error) => error.message === 'Supabase: edge runtime exited: STRIPE_WEBHOOK_SECRET=[REDACTED] STRIPE_SECRET_KEY=[REDACTED]');
});

test('Without a Stripe key Stripe is blocked, while Supabase still serves its functions without the Stripe variables', async t => {
  const { dataDir, calls, prepare, dir, functionsEnv } = await twin();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = await prepare({});
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.services, [
    { id: 'supabase', fidelity: 'official-sandbox', status: 'ready' },
    { id: 'stripe', fidelity: 'official-sandbox', status: 'blocked', missing: ['secretKey', 'publishableKey'] },
  ]);
  assert.equal(await readFile(functionsEnv, 'utf8'), "SITE='twin'\n");
  assert.equal(YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8')).services?.['stripe-listen'], undefined);
  assert.ok(!calls.some(({ args }) => args.includes(STRIPE_CLI)));
});
