import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { APP_IMAGE } from '../src/twin/compose.ts';
import { PORT_BASE, PORT_BLOCK, allocatePorts, createTwinRuntime, portFree } from '../src/twin/runtime.ts';
import { services } from './fixtures/twin/services.ts';
import type { AddressInfo } from 'node:net';
import type { Exec } from '../src/twin/runtime.ts';
import type { CommandOutput, TwinService } from '../src/twin/registry.ts';

type Call = { file: string; args: string[]; env?: Record<string, string> };
type Respond = (args: string[]) => Partial<CommandOutput> | Promise<Partial<CommandOutput>>;

const KEY = 'pk_test_abcdef123';
const WEBHOOK_SECRET = 'whsec_generated_42';
const BUSY = PORT_BASE + 1;
const config = () => ({
  services: { jobs: { database: '{{database.DATABASE_URL}}' }, payments: { webhook: '{{apps.api.url}}/hook' }, database: {}, mail: {} },
  apps: { web: { directory: 'web', build: 'pnpm build', start: 'pnpm start', port: 3000, env: { API_URL: '{{apps.api.url}}' } }, api: { directory: 'api', start: 'node server.js', port: 8080 } },
  fixtures: [{ service: 'database', sql: 'seed/twin.sql' }, { service: 'jobs', command: 'pnpm seed' }],
});

async function setup(respond: Respond = () => ({})) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  await mkdir(source);
  const calls: Call[] = [], steps: string[] = [];
  const exec: Exec = async (file, args, options = {}) => {
    calls.push({ file, args, env: options.env });
    const reply = await respond(args);
    return { stdout: args.includes('--print-secret') ? `${WEBHOOK_SECRET}\n` : '', stderr: '', ...reply };
  };
  const runtime = createTwinRuntime({ exec, services, owner: 'owner-1', isFree: async port => port !== BUSY });
  const prepare = (overrides: Partial<Parameters<typeof runtime.prepare>[0]> = {}) => runtime.prepare({ dataDir, id: 'beta', config: config(), source, inputs: { payments: { PAYMENTS_KEY: KEY } }, onStep: step => steps.push(step), ...overrides });
  return { dataDir, source, calls, steps, runtime, prepare, dir: join(dataDir, 'environments', 'beta', 'twin') };
}

const compose = (call: Call | undefined) => call?.args[0] === 'compose' ? call.args.slice(call.args.indexOf('--env-file') + 2) : null;
const secretsIn = (text: string) => [KEY, WEBHOOK_SECRET, 'db-password-1'].filter(secret => text.includes(secret));
const INSTALL_RUN = ['--progress', 'quiet', '--profile', 'install', 'run', '--rm', '--no-TTY', 'install'];
const SOURCE_RUN = ['--progress', 'quiet', '--profile', 'source', 'run', '--rm', '--no-TTY', 'source'];

test('Prepare returns host-browser app URLs while container wiring keeps Docker host addresses', async t => {
  const { prepare, dir, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = await prepare();
  assert.deepEqual(result.apps.map(app => app.url), [`http://127.0.0.1:${PORT_BASE}`, `http://127.0.0.1:${PORT_BASE + 2}`]);
  const file = YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8'));
  assert.deepEqual(file.services['payments-listener'].command, ['listen', '--forward-to', `http://host.docker.internal:${PORT_BASE + 2}/hook`]);
  assert.match(await readFile(join(dir, '.env'), 'utf8'), new RegExp(`^WEB__API_URL="http://host.docker.internal:${PORT_BASE + 2}"$`, 'm'));
});

test('Prepare runs setup in placeholder order, then services, fixtures and the whole twin', async t => {
  const { calls, steps, prepare, dir, source, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = await prepare();
  assert.deepEqual(steps, ['Setting up Database', 'Setting up Jobs', 'Setting up Payments', 'Setting up Mail', 'Loading source', 'Starting services', 'Loading fixture 1 of 2', 'Loading fixture 2 of 2', 'Starting twin']);
  assert.deepEqual(result, {
    status: 'ready',
    services: [
      { id: 'jobs', fidelity: 'actual', status: 'ready' }, { id: 'payments', fidelity: 'official-sandbox', status: 'ready' },
      { id: 'database', fidelity: 'actual', status: 'ready' }, { id: 'mail', fidelity: 'actual', status: 'ready' },
    ],
    apps: [{ id: 'web', url: `http://127.0.0.1:${PORT_BASE}`, directory: 'web' }, { id: 'api', url: `http://127.0.0.1:${PORT_BASE + 2}`, directory: 'api' }],
  });

  // The machine-wide package cache exists before any container needs it.
  // Repository code then runs from the twin's workspace volume, filled once from the snapshot.
  const [listen, volume, copy, up, sql, seed, all] = calls;
  assert.equal(calls.length, 7);
  assert.deepEqual(compose(copy), SOURCE_RUN);
  assert.ok(seed.args.some(arg => /^perpetual-.+_workspace:\/workspace$/.test(arg)), 'A command fixture runs in the workspace volume.');
  assert.deepEqual(volume.args, ['volume', 'create', '--label', 'perpetual.shared=package-cache', 'perpetual-package-cache']);
  assert.deepEqual(listen.args.slice(0, 4), ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway']);
  assert.deepEqual(listen.args.slice(-7), ['--workdir', join(dir, 'services', 'payments'), '--env', 'PAYMENTS_KEY', 'payments/cli:1.0', 'listen', '--print-secret']);
  assert.ok(listen.args.includes('perpetual.owner=owner-1') && listen.args.includes('perpetual.environment=beta'));
  assert.ok(listen.args.includes(`${source}:${source}:ro`));
  assert.equal(listen.env?.PAYMENTS_KEY, KEY);
  assert.deepEqual(compose(up), ['up', '--wait', 'jobs-worker', 'payments-listener', 'database', 'mail']);
  assert.deepEqual(sql.args.slice(-6), ['postgres:17-alpine', 'sh', '-c', 'exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"', 'fixture', '/workspace/seed/twin.sql']);
  assert.match(sql.env!.DATABASE_URL, new RegExp(`^postgres://postgres:db-password-1@host\\.docker\\.internal:${PORT_BASE + 3}/postgres$`));
  assert.ok(sql.args.includes(`${source}:/workspace:ro`));
  assert.deepEqual(seed.args.slice(-4), [APP_IMAGE, 'sh', '-c', 'corepack enable && pnpm seed']);
  assert.deepEqual(Object.keys(seed.env!), ['COREPACK_HOME', 'npm_config_cache', 'npm_config_store_dir', 'XDG_CACHE_HOME', 'YARN_CACHE_FOLDER', 'BUN_INSTALL_CACHE_DIR', 'JOBS_API_URL', 'JOBS_PROJECT']);
  assert.ok(seed.args.includes('perpetual-package-cache:/perpetual-cache'));
  assert.deepEqual(compose(all), ['up', '--wait']);
  for (const call of calls) assert.deepEqual(secretsIn(call.args.join(' ')), [], call.args.join(' '));

  const file = YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8'));
  assert.equal(file.services['jobs-worker'].environment.JOBS_DATABASE, '${JOBS_WORKER__JOBS_DATABASE}');
  assert.deepEqual(secretsIn(await readFile(join(dir, 'compose.yaml'), 'utf8')), []);
  const dotenv = await readFile(join(dir, '.env'), 'utf8');
  assert.deepEqual(secretsIn(dotenv), [KEY, WEBHOOK_SECRET, 'db-password-1']);
  assert.match(dotenv, /^JOBS_WORKER__JOBS_DATABASE="postgres:\/\/postgres:db-password-1@/m);
  assert.match(dotenv, new RegExp(`^WEB__JOBS_PROJECT="perpetual-beta-\\d+"$`, 'm'));
  for (const name of ['.env', 'twin.json', 'compose.yaml']) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('A shared install runs once after services are ready, before fixtures and apps that need its dependencies', async t => {
  const { calls, steps, prepare, dir, dataDir, runtime, source } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare({ config: { ...config(), install: { directory: '.', command: 'npm ci' } } });
  assert.deepEqual(steps.slice(-5), ['Starting services', 'Installing dependencies', 'Loading fixture 1 of 2', 'Loading fixture 2 of 2', 'Starting twin']);
  assert.deepEqual(calls.slice(1).map(call => compose(call) ?? call.args.at(-1)), [
    'perpetual-package-cache', SOURCE_RUN, ['up', '--wait', 'jobs-worker', 'payments-listener', 'database', 'mail'], INSTALL_RUN, '/workspace/seed/twin.sql', 'corepack enable && pnpm seed', ['up', '--wait']]);
  const install = calls.find(call => compose(call)?.includes('install'));
  assert.equal(install?.env, undefined, 'The install gets no twin variables.');
  assert.deepEqual(YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8')).services.install.profiles, ['install']);

  // Services still start first without fixtures; a twin with no services installs, then starts its apps.
  calls.length = 0;
  await runtime.prepare({ dataDir, id: 'mail', config: { services: { mail: {} }, install: { command: 'npm ci' }, apps: { web: { start: 'node x', port: 3000 } } }, source });
  assert.deepEqual(calls.map(call => compose(call) ?? call.args.at(-1)), ['perpetual-package-cache', SOURCE_RUN, ['up', '--wait', 'mail'], INSTALL_RUN, ['up', '--wait']]);
  calls.length = 0;
  await runtime.prepare({ dataDir, id: 'bare', config: { install: { command: 'npm ci' }, apps: { web: { start: 'node x', port: 3000 } } }, source });
  assert.deepEqual(calls.map(call => compose(call) ?? call.args.at(-1)), ['perpetual-package-cache', SOURCE_RUN, INSTALL_RUN, ['up', '--wait']]);
});

test('Service containers that run repository code start with the apps, after the install that gives them dependencies', async t => {
  const { calls, dataDir, source } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = { id: 'worker', title: 'Worker', fidelity: 'actual', env: () => ({}),
    containers: () => [{ name: 'dev', image: 'node:22-bookworm-slim', directory: 'api', command: ['npx', 'worker', 'dev'] }] } satisfies TwinService;
  const exec: Exec = async (file, args, options = {}) => { calls.push({ file, args, env: options.env }); return { stdout: '', stderr: '' }; };
  const runtime = createTwinRuntime({ exec, services: { ...services, worker }, isFree: async () => true });
  const apps = { web: { start: 'node x', port: 3000 } };
  await runtime.prepare({ dataDir, id: 'repo', config: { services: { mail: {}, worker: {} }, install: { command: 'npm ci' }, apps }, source });
  assert.deepEqual(calls.map(call => compose(call) ?? call.args.at(-1)), ['perpetual-package-cache', SOURCE_RUN, ['up', '--wait', 'mail'], INSTALL_RUN, ['up', '--wait']]);
  const file = YAML.parse(await readFile(join(dataDir, 'environments', 'repo', 'twin', 'compose.yaml'), 'utf8'));
  assert.equal(file.services['worker-dev'].working_dir, '/workspace/api');
  assert.deepEqual(file.services.web.depends_on, { mail: { condition: 'service_healthy' }, 'worker-dev': { condition: 'service_started' } });

  // With only repository-code services, nothing starts before the install.
  calls.length = 0;
  await runtime.prepare({ dataDir, id: 'repo-only', config: { services: { worker: {} }, install: { command: 'npm ci' }, apps }, source });
  assert.deepEqual(calls.map(call => compose(call) ?? call.args.at(-1)), ['perpetual-package-cache', SOURCE_RUN, INSTALL_RUN, ['up', '--wait']]);
});

test('A failed install stops prepare with its command, exit code and the end of its output, redacted', async t => {
  const noise = Array.from({ length: 40 }, (_, index) => `progress ${index}`).join('\n');
  const { calls, prepare, dataDir } = await setup(args => {
    if (args.includes('run') && args.includes('install')) throw Object.assign(new Error('Command failed: docker compose run'), { code: 1, stdout: `${noise}\n`, stderr: `npm error lockfile mismatch for ${KEY}\n` });
    return {};
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(prepare({ config: { ...config(), install: { directory: 'apps', command: 'npm ci' } } }), (error: Error) => {
    assert.match(error.message, /^Install "npm ci" in apps failed with exit code 1: progress 11\n/);
    assert.match(error.message, /progress 39\nnpm error lockfile mismatch for \[redacted\]$/);
    assert.equal(error.message.includes('progress 10\n'), false);
    assert.deepEqual(secretsIn(error.message), []);
    return true;
  });
  assert.deepEqual(compose(calls.at(-1)), INSTALL_RUN, 'Neither fixtures nor apps run after a failed install.');
  assert.equal(calls.some(call => call.args.includes('/workspace/seed/twin.sql')), false);
});

test('Services with missing inputs are blocked, with the services that depend on them', async t => {
  const { calls, prepare, dir, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const input = config();
  input.services.jobs = { database: '{{payments.PAYMENTS_KEY}}' };
  const result = await prepare({ config: input, inputs: { payments: { PAYMENTS_KEY: 'pk_live_nope' } } });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.services.filter(service => service.status === 'blocked'), [
    { id: 'jobs', fidelity: 'actual', status: 'blocked', missing: ['PAYMENTS_KEY'] },
    { id: 'payments', fidelity: 'official-sandbox', status: 'blocked', missing: ['PAYMENTS_KEY'] },
  ]);
  assert.equal(calls.some(call => call.args.includes('payments/cli:1.0') || call.args.includes(APP_IMAGE)), false);
  assert.deepEqual(calls.map(compose).filter(Boolean), [SOURCE_RUN, ['up', '--wait', 'database', 'mail'], ['up', '--wait']]);
  const file = YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(file.services), ['database', 'mail', 'web', 'api', 'source']);
  assert.equal(Object.keys(file.services.web.environment).some(name => /PAYMENTS|JOBS/.test(name)), false);
});

test('Host ports come from a free block that skips busy ports and other twins', async t => {
  assert.deepEqual(await allocatePorts({ count: 3, start: 50000, reserved: new Set([50001]), isFree: async port => port !== 50002 }), [50000, 50003, 50004]);
  await assert.rejects(allocatePorts({ count: 2, start: 65535, isFree: async () => true }), /No free host ports/);
  const { runtime, source, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const only = { apps: { web: { start: 'node x', port: 3000 } } };
  const first = await runtime.prepare({ dataDir, id: 'one', config: only, source });
  const second = await runtime.prepare({ dataDir, id: 'two', config: only, source });
  assert.equal(first.apps[0].url, `http://127.0.0.1:${PORT_BASE}`);
  const one: { block: number[] } = JSON.parse(await readFile(join(dataDir, 'environments', 'one', 'twin', 'twin.json'), 'utf8'));
  const two: { block: number[] } = JSON.parse(await readFile(join(dataDir, 'environments', 'two', 'twin', 'twin.json'), 'utf8'));
  assert.equal(one.block.length, PORT_BLOCK);
  assert.equal(one.block.includes(BUSY), false);
  assert.equal(two.block.some(port => one.block.includes(port)), false);
  assert.equal(second.apps[0].url, `http://127.0.0.1:${two.block[0]}`);
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  assert.equal(await portFree((server.address() as AddressInfo).port), false);
  await new Promise(done => server.close(done));
});

test('Twins prepared at the same time get separate host port blocks', async t => {
  const { runtime, source, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const only = { apps: { web: { start: 'node x', port: 3000 } } };
  const results = await Promise.all(['one', 'two', 'three'].map(id => runtime.prepare({ dataDir, id, config: only, source })));
  const blocks = await Promise.all(['one', 'two', 'three'].map(async id => JSON.parse(await readFile(join(dataDir, 'environments', id, 'twin', 'twin.json'), 'utf8')).block));
  assert.equal(new Set(blocks.flat()).size, PORT_BLOCK * 3);
  assert.equal(new Set(results.map(result => result.apps[0].url)).size, 3);
});

test('A machine-wide instance keeps one host port that no twin block takes, even after its first twin is gone', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(source);
  const seen: number[] = [];
  const shared = { id: 'shared', title: 'Shared', fidelity: 'actual',
    setup: async ctx => { const port = await ctx.sharedPort('instance'); seen.push(port, await ctx.sharedPort('instance', 1)); return { port }; },
    env: ctx => ({ SHARED_URL: `http://${ctx.host}:${ctx.outputs.port}` }) } satisfies TwinService<{}, { port: number }>;
  const runtime = createTwinRuntime({ exec: async () => ({ stdout: '' }), services: { shared }, owner: 'o', isFree: async port => port !== BUSY });
  const twin = { config: { services: { shared: {} } }, source };
  const block = async (id: string): Promise<number[]> => JSON.parse(await readFile(join(dataDir, 'environments', id, 'twin', 'twin.json'), 'utf8')).block;

  await runtime.prepare({ dataDir, id: 'one', ...twin });
  const [port] = seen, one = await block('one');
  assert.deepEqual(seen, [port, port], 'A later reservation returns the same port, whatever the caller already uses.');
  assert.equal(port, Math.max(...one) + 1, 'The first free port outside every twin block.');
  const file = join(dataDir, 'twin-services', 'ports.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { 'shared.instance': port });
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  await Promise.all(['two', 'three'].map(id => runtime.prepare({ dataDir, id, ...twin })));
  await runtime.destroy({ dataDir, id: 'one' });
  await runtime.prepare({ dataDir, id: 'four', ...twin });
  const blocks = await Promise.all(['two', 'three', 'four'].map(block));
  assert.deepEqual(new Set(seen), new Set([port]));
  assert.equal(new Set(blocks.flat()).size, PORT_BLOCK * 3);
  assert.equal(blocks.flat().includes(port), false, 'No later twin takes the instance port.');
  assert.deepEqual(blocks[2].slice(0, 2), one.slice(0, 2), 'The first twin\'s other ports are free again.');
});

test('A machine-wide instance that already publishes a port keeps it, and twins allocate around it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(source);
  const existing = PORT_BASE + 5, seen: number[] = [];
  const shared = { id: 'shared', title: 'Shared', fidelity: 'actual',
    setup: async ctx => { seen.push(await ctx.sharedPort('instance', existing)); return {}; }, env: () => ({}) } satisfies TwinService;
  const runtime = createTwinRuntime({ exec: async () => ({ stdout: '' }), services: { shared }, owner: 'o', isFree: async () => true });
  await runtime.prepare({ dataDir, id: 'one', config: { services: { shared: {} } }, source });
  await runtime.destroy({ dataDir, id: 'one' });
  await runtime.prepare({ dataDir, id: 'two', config: { apps: { web: { start: 'node x', port: 3000 } } }, source });
  assert.deepEqual(seen, [existing]);
  const two: number[] = JSON.parse(await readFile(join(dataDir, 'environments', 'two', 'twin', 'twin.json'), 'utf8')).block;
  assert.equal(two[0], PORT_BASE);
  assert.equal(two.includes(existing), false);
});

test('Logs, health and command failures never reveal secret values', async t => {
  const leak = `key=${KEY} whsec=${WEBHOOK_SECRET} url=postgres://postgres:db-password-1@db`;
  let failUp = false;
  const { runtime, prepare, dataDir } = await setup(args => {
    if (args.includes('logs')) return { stdout: `web | ${leak}\n`, stderr: `payments | ${KEY}\n` };
    if (args[0] === 'compose' && args.includes('ps')) return { stdout: '{"Service":"web","State":"running","Health":"healthy","ExitCode":0}\n{"Service":"database","State":"running","Health":"starting"}\n' };
    if (failUp && args.includes('up')) throw Object.assign(new Error('Command failed'), { stderr: `listener exited: ${leak}` });
    return {};
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare();
  const text = await runtime.logs({ dataDir, id: 'beta', service: 'web', tail: 50 });
  assert.equal(text, 'web | key=[redacted] whsec=[redacted] url=postgres://[REDACTED]@db\npayments | [redacted]\n');
  assert.deepEqual(await runtime.health({ dataDir, id: 'beta' }), { status: 'starting', containers: [
    { name: 'web', state: 'running', health: 'healthy', exitCode: 0 }, { name: 'database', state: 'running', health: 'starting', exitCode: null }] });
  await assert.rejects(runtime.logs({ dataDir, id: 'beta', service: 'web; rm' }), /Choose a service/);
  failUp = true;
  await assert.rejects(prepare(), (error: Error) => { assert.deepEqual(secretsIn(error.message), []); assert.match(error.message, /listener exited: key=\[redacted\]/); return true; });
});

test('A failed command reports the end of its output, where the error is, not the progress before it', async t => {
  const progress = Array.from({ length: 200 }, (_, index) => `layer${index}: Pulling fs layer`).join('\n');
  const { prepare, dataDir } = await setup(args => {
    if (args.includes('up')) throw Object.assign(new Error('Command failed: docker compose up'), { stderr: `${progress}\nlistener: failed to start: ${KEY}\n` });
    return {};
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(prepare(), (error: Error) => {
    assert.match(error.message, /listener: failed to start: \[redacted\]$/);
    assert.equal(error.message.includes('layer0:'), false);
    assert.ok(error.message.split('\n').length <= 30);
    return true;
  });
});

test('A failed command that reports its error on stdout keeps it after the end of stderr', async t => {
  const { prepare, dataDir } = await setup(args => {
    if (args.includes('--print-secret')) throw Object.assign(new Error('Command failed: docker run'), { stdout: `{"error":"health check timed out for ${KEY}"}\n`, stderr: 'Starting database...\nStopping containers...\n' });
    return {};
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(prepare(), /^Error: Payments: Starting database\.\.\.\nStopping containers\.\.\.\n\{"error":"health check timed out for \[redacted\]"\}$/);
});

test('Health reads either Compose ps format and reports stopped twins', async t => {
  const { runtime, prepare, dataDir } = await setup(args => args.includes('ps') ? { stdout: '[{"Service":"web","State":"exited","ExitCode":1}]' } : {});
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual(await runtime.health({ dataDir, id: 'beta' }), { status: 'stopped', containers: [] });
  await prepare();
  assert.deepEqual(await runtime.health({ dataDir, id: 'beta' }), { status: 'failed', containers: [{ name: 'web', state: 'exited', health: null, exitCode: 1 }] });
});

test('Destroy takes Compose down with volumes, then tears services down in reverse setup order', async t => {
  let failDown = false;
  const { runtime, calls, prepare, dataDir, dir } = await setup(args => { if (failDown && args.includes('down')) throw Object.assign(new Error('x'), { stderr: `busy ${KEY}` }); return {}; });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare();
  calls.length = 0;
  failDown = true;
  await assert.rejects(runtime.destroy({ dataDir, id: 'beta', inputs: { payments: { PAYMENTS_KEY: KEY } } }), /Twin cleanup failed; its files are kept for another attempt\. Compose: busy \[redacted\]/);
  await access(join(dir, 'twin.json'));
  failDown = false;
  calls.length = 0;
  assert.deepEqual(await runtime.destroy({ dataDir, id: 'beta', inputs: { payments: { PAYMENTS_KEY: KEY } } }), { status: 'destroyed' });
  assert.deepEqual(compose(calls[0]), ['down', '--volumes', '--remove-orphans']);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].args.slice(-2), ['payments/cli:1.0', 'logout']);
  assert.deepEqual(calls[2].args.slice(-3, -1), ['jobs/cli:2.0', 'delete']);
  assert.match(calls[2].args.at(-1)!, /^perpetual-beta-\d+$/);
  await assert.rejects(access(dir));
});

test('Destroy removes detached one-shot containers and confirms none remain before dropping ownership', async t => {
  let orphan = true;
  const id = 'a'.repeat(64);
  const { runtime, prepare, calls, dataDir, dir } = await setup(args => {
    if (args[0] === 'ps') return { stdout: orphan ? id : '' };
    if (args[0] === 'rm') { assert.deepEqual(args, ['rm', '--force', id]); orphan = false; }
    return {};
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare(); await runtime.destroy({ dataDir, id: 'beta' });
  assert.equal(orphan, false, 'An interrupted docker run can leave its guest after the CLI exits.');
  const scans = calls.filter(call => call.args[0] === 'ps');
  assert.equal(scans.length, 2);
  assert.ok(scans.every(call => call.args.includes('label=perpetual.environment=beta') && call.args.includes('label=perpetual.owner=owner-1')));
  await assert.rejects(access(dir));
});

test('Prepare rebuilds an existing twin from scratch and requires a source snapshot', async t => {
  const { calls, prepare, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare();
  calls.length = 0;
  await prepare();
  assert.deepEqual(compose(calls[0]), ['down', '--volumes', '--remove-orphans']);
  await assert.rejects(prepare({ source: join(dataDir, 'missing') }), /source snapshot directory is required/);
  await assert.rejects(prepare({ id: '../escape' }), /twin id/);
});

test('Setup failures name the service, keep its record for teardown and cannot redirect the docker CLI', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(source);
  const calls: string[][] = [];
  const rogue = { id: 'rogue', title: 'Rogue', fidelity: 'actual', env: () => ({}),
    setup: ctx => ctx.run('tool:1', ['go'], { env: { DOCKER_HOST: 'tcp://elsewhere:2375' } }), teardown: async ctx => { await ctx.run('tool:1', ['clean']); } } satisfies TwinService<{}, {}>;
  const runtime = createTwinRuntime({ exec: async (file, args) => { calls.push(args); return { stdout: '' }; }, services: { rogue }, isFree: async () => true });
  await assert.rejects(runtime.prepare({ dataDir, id: 'r1', config: { services: { rogue: {} } }, source }), /^Error: Rogue: DOCKER_HOST cannot be passed to a container run\.$/);
  assert.equal(calls.length, 0);
  const state = JSON.parse(await readFile(join(dataDir, 'environments', 'r1', 'twin', 'twin.json'), 'utf8'));
  assert.deepEqual(state.services, [{ id: 'rogue', options: {}, outputs: {} }]);
  await runtime.destroy({ dataDir, id: 'r1' });
  assert.deepEqual(calls.filter(args => args[0] === 'run').map(args => args.slice(-2)), [['tool:1', 'clean']]);
});

test('Inline SQL fixtures pass the query to psql as an argument, never through the shell', async t => {
  const { calls, prepare, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const query = "update accounts set plan = 'free' where email = 'a@example.com'; -- $(touch /tmp/x)";
  await prepare({ config: { ...config(), fixtures: [{ service: 'database', query }] } });
  const run = calls.find(call => call.args.includes('postgres:17-alpine'))!;
  assert.deepEqual(run.args.slice(-6), ['postgres:17-alpine', 'sh', '-c', 'exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$1"', 'fixture', query]);
  assert.ok(!run.args.some(arg => arg.includes(':/workspace')), 'an inline query needs no source mount');
});

test('A service address is allocated before any setup, so a webhook can reach a service that needs its signing secret', async t => {
  const { steps, prepare, dir, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // payments forwards to the jobs address while jobs needs the payments signing secret.
  const input = { services: { jobs: { database: '{{payments.PAYMENTS_WEBHOOK_SECRET}}' }, payments: { webhook: '{{services.jobs.url.api}}/hook' }, database: {} },
    apps: { web: { start: 'node x', port: 3000, env: { JOBS: '{{services.jobs.url.api}}' } } } };
  await prepare({ config: input });
  assert.deepEqual(steps.slice(0, 3), ['Setting up Payments', 'Setting up Jobs', 'Setting up Database']);
  const port = JSON.parse(await readFile(join(dir, 'twin.json'), 'utf8')).ports['jobs.api'];
  const file = YAML.parse(await readFile(join(dir, 'compose.yaml'), 'utf8')), dotenv = await readFile(join(dir, '.env'), 'utf8');
  assert.deepEqual(file.services['jobs-worker'].ports, [`127.0.0.1:${port}:8030`]);
  assert.deepEqual(file.services['payments-listener'].command, ['listen', '--forward-to', `http://host.docker.internal:${port}/hook`]);
  assert.match(dotenv, new RegExp(`^JOBS_WORKER__JOBS_DATABASE="${WEBHOOK_SECRET}"$`, 'm'));
  assert.match(dotenv, new RegExp(`^WEB__JOBS="http://host.docker.internal:${port}"$`, 'm'));

  // A port the service never takes is reported, never left as an address nothing listens on.
  const typo = structuredClone(input);
  typo.services.payments.webhook = '{{services.jobs.url.http}}/hook';
  await assert.rejects(prepare({ config: typo }), /^Error: services\.payments\.webhook references \{\{services\.jobs\.url\.http\}\}, but Jobs has no port http\.$/);
});

test('Service options resolve explicit browser addresses using the same allocated ports as app env', async t => {
  const { prepare, dir, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await prepare({ config: { services: { jobs: { database: '{{services.mail.publicUrl.web}}/api?return={{apps.web.publicUrl}}' }, mail: {} },
    apps: { web: { start: 'node app.js', port: 3000, env: { MAIL_PUBLIC: '{{services.mail.publicUrl.web}}', MAIL_INTERNAL: '{{services.mail.url.web}}' } } } } });
  const saved = JSON.parse(await readFile(join(dir, 'twin.json'), 'utf8'));
  const address = `http://127.0.0.1:${saved.ports['mail.web']}`;
  assert.equal(saved.services.find((item: { id: string }) => item.id === 'jobs').options.database, `${address}/api?return=http://127.0.0.1:${PORT_BASE}`);
  const env = await readFile(join(dir, '.env'), 'utf8');
  assert.ok(env.includes(`WEB__MAIL_PUBLIC="${address}"`));
  assert.ok(env.includes(`WEB__MAIL_INTERNAL="http://host.docker.internal:${saved.ports['mail.web']}"`));
  await assert.rejects(prepare({ config: { services: { mail: {} }, apps: { web: { start: 'node app.js', port: 3000, env: { URL: '{{services.mail.publicUrl.missing}}' } } } } }),
    /\{\{services\.mail\.publicUrl\.missing\}\}.*Mail has no port missing/);
});

test('A blocked service leaves its variables out of env options, while other options that reference it block their service', async t => {
  const { prepare, dir, dataDir } = await setup();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const jobs = { database: '{{database.DATABASE_URL}}', env: { SIGNING: '{{payments.PAYMENTS_WEBHOOK_SECRET}}', DB: '{{database.DATABASE_URL}}' } };
  const result = await prepare({ config: { services: { payments: { webhook: 'http://host.docker.internal:1/hook' }, jobs, database: {} } }, inputs: {} });
  assert.deepEqual(result.services.map(({ id, status }) => [id, status]), [['payments', 'blocked'], ['jobs', 'ready'], ['database', 'ready']]);
  const state = JSON.parse(await readFile(join(dir, 'twin.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.services.find((record: { id: string }) => record.id === 'jobs').options.env), ['DB']);

  const blocking = await prepare({ config: { services: { payments: { webhook: 'http://host.docker.internal:1/hook' }, jobs: { ...jobs, database: '{{payments.PAYMENTS_KEY}}' }, database: {} } }, inputs: {} });
  assert.deepEqual(blocking.services.find(service => service.id === 'jobs'), { id: 'jobs', fidelity: 'actual', status: 'blocked', missing: ['PAYMENTS_KEY'] });
});
