import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTwinRuntime, PORT_BASE } from '../src/twin/runtime.ts';
import type { Exec } from '../src/twin/runtime.ts';
import type { TwinService } from '../src/twin/registry.ts';

const STATE_LIMIT = 32 * 1024 * 1024, PORTS_LIMIT = 1024 * 1024;
const app = { apps: { web: { start: 'node app.js', port: 3000 } } };
const invalid = /Invalid twin state|Invalid shared port state/;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-twin-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), source = join(root, 'source'), dir = join(dataDir, 'environments', 'beta', 'twin');
  await mkdir(source); await mkdir(dir, { recursive: true });
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: '' }; };
  const runtime = createTwinRuntime({ exec, services: {}, isFree: async () => true });
  const state = { id: 'beta', project: 'perpetual-beta', owner: 'owner', source, block: [PORT_BASE], ports: {}, services: [], secrets: [] };
  const file = join(dir, 'twin.json');
  return { root, dataDir, source, dir, file, calls, exec, runtime, state };
}

test('Invalid persisted twin state never reports cleanup success or drops ownership', async t => {
  for (const saved of [null, [], true, {}, { services: {} }, { secrets: [false] }, { ports: { 'web.http': 0 } }, { block: ['43100'] },
    { services: [{ id: '../outside', options: {}, outputs: {} }] }, { services: [{ id: 'probe', options: [], outputs: {} }] },
    { services: [{ id: 'probe', options: {}, outputs: [] }] }, { accounts: {} },
    { accounts: [{ service: 'probe', id: 'owner', label: 'Owner', username: 'owner@example.test', password: false }] }]) {
    await t.test(JSON.stringify(saved), async t => {
      const f = await fixture(t);
      await writeFile(f.file, JSON.stringify(saved && !Array.isArray(saved) && typeof saved === 'object' && Object.keys(saved).length ? { ...f.state, ...saved } : saved));
      await assert.rejects(f.runtime.destroy({ dataDir: f.dataDir, id: 'beta' }), invalid);
      await access(f.file);
      assert.equal(f.calls.length, 0);
    });
  }
});

test('Twin and shared-port reads refuse links, non-files and oversized files', async t => {
  for (const kind of ['twin', 'shared'] as const) for (const shape of ['link', 'directory', 'oversized'] as const) {
    await t.test(`${kind}: ${shape}`, async t => {
      const f = await fixture(t), file = kind === 'twin' ? f.file : join(f.dataDir, 'twin-services', 'ports.json');
      await mkdir(join(f.dataDir, 'twin-services'), { recursive: true });
      if (shape === 'link') {
        const outside = join(f.root, 'outside.json');
        await writeFile(outside, JSON.stringify(kind === 'twin' ? f.state : { 'shared.http': PORT_BASE }));
        await symlink(outside, file);
      } else if (shape === 'directory') await mkdir(file);
      else await writeFile(file, JSON.stringify(kind === 'twin' ? { ...f.state, padding: 'x'.repeat(STATE_LIMIT) } : { ['x'.repeat(PORTS_LIMIT)]: PORT_BASE }));
      const operation = kind === 'twin' ? f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'owner' })
        : f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app });
      await assert.rejects(operation, invalid);
      await access(file);
      assert.equal(f.calls.length, 0);
    });
  }
});

test('Malformed sibling reservations block allocation, and a failed reservation leaves the queue usable', async t => {
  const f = await fixture(t), older = join(f.dataDir, 'environments', 'older', 'twin');
  await mkdir(older, { recursive: true });
  await writeFile(join(older, 'twin.json'), '{"block":[' + PORT_BASE + ']');
  await assert.rejects(f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app }), invalid);
  assert.equal(f.calls.length, 0);
  await writeFile(join(older, 'twin.json'), JSON.stringify({ ...f.state, id: 'older', project: 'perpetual-older' }));
  const result = await f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app });
  assert.equal(result.apps[0].url, `http://127.0.0.1:${PORT_BASE + 1}`);
});

test('Controller metadata beside environment directories is not a twin reservation', async t => {
  const f = await fixture(t), environments = join(f.dataDir, 'environments');
  const files = ['state.json', '.state-pending.tmp'];
  for (const name of files) await writeFile(join(environments, name), 'controller metadata');
  const result = await f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app });
  assert.equal(result.apps[0].url, `http://127.0.0.1:${PORT_BASE}`);
  for (const name of files) assert.equal(await readFile(join(environments, name), 'utf8'), 'controller metadata');
});

test('Invalid shared-port values never become an empty reservation map', async t => {
  for (const ports of [null, [], { 'shared.http': '43100' }, { 'shared.http': 65536 }]) await t.test(JSON.stringify(ports), async t => {
    const f = await fixture(t), directory = join(f.dataDir, 'twin-services');
    await mkdir(directory);
    const file = join(directory, 'ports.json'), original = JSON.stringify(ports);
    await writeFile(file, original);
    await assert.rejects(f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app }), invalid);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(f.calls.length, 0);
  });
});

test('Runtime repairs private directory modes and refuses linked owned directories', async t => {
  const f = await fixture(t), sharedDir = join(f.dataDir, 'twin-services');
  await chmod(f.dir, 0o755); await mkdir(sharedDir); await chmod(sharedDir, 0o755);
  const shared = { id: 'shared', title: 'Shared', fidelity: 'actual', setup: async ctx => ({ port: await ctx.sharedPort('http') }), env: () => ({}) } satisfies TwinService;
  const runtime = createTwinRuntime({ exec: f.exec, services: { shared }, isFree: async () => true });
  await runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: { services: { shared: {} } } });
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  assert.equal((await stat(sharedDir)).mode & 0o777, 0o700);
  await runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, f.dir);
  await assert.rejects(runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app }), /storage must not be a symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});

test('A failed private-file rename leaves no temporary credential file', async t => {
  const f = await fixture(t);
  await mkdir(join(f.dir, '.env'));
  await assert.rejects(f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: {
    apps: { web: { ...app.apps.web, env: { SESSION_SECRET: 'fixture-secret-value' } } },
  } }));
  assert.deepEqual((await readdir(f.dir)).sort(), ['.env', 'setup.log', 'twin.json']);
});

test('A dangling state link cannot be overwritten by a new preparation', async t => {
  const f = await fixture(t), missing = join(f.root, 'missing-state.json');
  await symlink(missing, f.file);
  await assert.rejects(f.runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: app }), invalid);
  assert.equal(await readlink(f.file), missing);
  await assert.rejects(access(missing));
  assert.equal(f.calls.length, 0);
});

test('A shared-port map that exceeds its write budget keeps all previous reservations', async t => {
  const f = await fixture(t), sharedDir = join(f.dataDir, 'twin-services'), file = join(sharedDir, 'ports.json');
  await mkdir(sharedDir);
  const original = JSON.stringify({ 'kept.http': PORT_BASE + 100 });
  await writeFile(file, original);
  let overflow = true;
  const shared = { id: 'shared', title: 'Shared', fidelity: 'actual',
    setup: async ctx => ({ port: await ctx.sharedPort(overflow ? 'x'.repeat(PORTS_LIMIT) : 'http') }), env: () => ({}) } satisfies TwinService;
  const runtime = createTwinRuntime({ exec: f.exec, services: { shared }, isFree: async () => true });
  const prepare = () => runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: { services: { shared: {} } } });
  await assert.rejects(prepare(), /Shared port state exceeds 1 MiB/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(f.calls.length, 0);
  overflow = false;
  await prepare();
  const ports = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(ports['kept.http'], PORT_BASE + 100);
  assert.ok(Number.isInteger(ports['shared.http']));
});

test('Separate runtime instances reserve distinct blocks and one nested shared port', { timeout: 10000 }, async t => {
  const f = await fixture(t), sharedPorts: number[] = [];
  const shared = { id: 'shared', title: 'Shared', fidelity: 'actual',
    setup: async ctx => { sharedPorts.push(await ctx.sharedPort('http')); return {}; }, env: () => ({}) } satisfies TwinService;
  const one = createTwinRuntime({ exec: f.exec, services: { shared }, isFree: async () => true });
  const two = createTwinRuntime({ exec: f.exec, services: { shared }, isFree: async () => true });
  await Promise.all(([[one, 'one'], [two, 'two']] as const).map(([runtime, id]) => runtime.prepare({
    dataDir: f.dataDir, source: f.source, id, config: { ...app, services: { shared: {} } },
  })));
  const blocks: number[][] = await Promise.all(['one', 'two'].map(async id => JSON.parse(await readFile(join(f.dataDir, 'environments', id, 'twin', 'twin.json'), 'utf8')).block));
  assert.equal(new Set(blocks.flat()).size, blocks[0].length + blocks[1].length);
  assert.equal(new Set(sharedPorts).size, 1);
  assert.equal(blocks.flat().includes(sharedPorts[0]), false);
});

test('A failed final state save preserves unconfirmed service cleanup and both failures', async t => {
  for (const step of ['setup', 'accounts'] as const) await t.test(step, async t => {
    const f = await fixture(t);
    const fail = async () => {
      await rm(f.file); await mkdir(f.file);
      throw Object.assign(new Error('The provider process could not stop.'), { cleanupIncomplete: true });
    };
    const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}), [step]: fail } satisfies TwinService;
    const runtime = createTwinRuntime({ exec: f.exec, services: { probe }, isFree: async () => true });
    await assert.rejects(runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: { services: { probe: {} } } }), error => {
      assert.equal((error as { cleanupIncomplete?: boolean }).cleanupIncomplete, true);
      assert.match((error as Error).message, /The provider process could not stop/);
      assert.match((error as Error).message, /Twin state could not be saved/);
      return true;
    });
    assert.ok((await stat(f.dir)).isDirectory(), 'An uncertain cleanup retains the owned directory.');
  });
});

test('Diagnostics hide newly generated credentials even when their final state save fails', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), secret = 'generated-sensitive-fixture-value';
  t.after(() => chmod(f.dir, 0o700).catch(() => {}));
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}), accounts: async ctx => {
    ctx.rememberSecret?.(secret);
    await chmod(f.dir, 0o500);
    throw new Error('Provisioning failed');
  } } satisfies TwinService;
  const runtime = createTwinRuntime({ services: { probe }, isFree: async () => true, exec: async (_file, args) => ({ stdout: args.includes('logs') ? `diagnostic ${secret}` : '' }) });
  await assert.rejects(runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: { services: { probe: {} } } }), /Provisioning failed.*Twin state could not be saved/);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.ok(!saved.secrets.includes(secret), 'The generated value did not reach persisted state.');
  const logs = await runtime.logs({ dataDir: f.dataDir, id: 'beta' });
  assert.ok(!logs.includes(secret));
  assert.match(logs, /diagnostic \[redacted\]/i);
  await runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
});

test('Parent aliases preserve lexical paths and the default resource owner through cleanup', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias');
  await symlink(f.root, alias);
  const dataDir = join(alias, 'data'), owner = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  await f.runtime.prepare({ dataDir, source: f.source, id: 'beta', config: app });
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.owner, owner);
  assert.equal(f.calls.filter(args => args[0] === 'compose').every(args => args[args.indexOf('--project-directory') + 1] === join(dataDir, 'environments', 'beta', 'twin')), true);
  f.calls.length = 0;
  await f.runtime.destroy({ dataDir, id: 'beta' });
  assert.ok(f.calls.some(args => args[0] === 'ps' && args.includes(`label=perpetual.owner=${owner}`)));
});

test('Partial preparation and legacy state without accounts retain service teardown data', async t => {
  const f = await fixture(t), seen: unknown[] = [];
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}), teardown: async ctx => { seen.push(ctx.options, ctx.outputs); } } satisfies TwinService;
  const runtime = createTwinRuntime({ exec: f.exec, services: { probe } });
  await writeFile(f.file, JSON.stringify({ ...f.state, services: [{ id: 'probe', options: { project: 'fixture' }, outputs: { resource: 'fixture-resource' } }] }));
  await runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
  assert.deepEqual(seen, [{ project: 'fixture' }, { resource: 'fixture-resource' }]);
  assert.ok(f.calls.some(args => args[0] === 'ps'));
});

test('Oversized setup output is preserved completely and requires recovery before cleanup', async t => {
  const f = await fixture(t), output = 'x'.repeat(STATE_LIMIT + 1);
  let tornDown = false;
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', setup: async () => ({ resource: 'fixture-resource', output }), env: () => ({}),
    teardown: async () => { tornDown = true; } } satisfies TwinService;
  const runtime = createTwinRuntime({ exec: f.exec, services: { probe }, isFree: async () => true });
  await assert.rejects(runtime.prepare({ dataDir: f.dataDir, source: f.source, id: 'beta', config: { services: { probe: {} } } }), /Twin state exceeds 32 MiB.*manual recovery/);
  const original = await readFile(f.file, 'utf8'), state = JSON.parse(original);
  assert.equal(state.services[0].outputs.resource, 'fixture-resource');
  assert.ok(state.services[0].outputs.output === output, 'All teardown output bytes survive the rejected preparation.');
  await assert.rejects(runtime.destroy({ dataDir: f.dataDir, id: 'beta' }), invalid);
  assert.equal(await readFile(f.file, 'utf8'), original);
  assert.equal(tornDown, false);
  assert.equal(f.calls.length, 0);
});
