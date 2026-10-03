import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentRuntime } from '../src/environments/runtime.ts';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import type { ManagedRuntime } from '../src/environments/manager.ts';
import type { Json } from '../src/twin/config.ts';
import type { TwinService } from '../src/twin/registry.ts';

const PASSWORD = 'twin-password-fixture-9f3a';
const auth = {
  id: 'auth', title: 'Auth', fidelity: 'actual',
  containers: () => [{ name: 'auth', image: 'auth/server:1.0', ports: { api: 9999 } }],
  env: ctx => ({ AUTH_URL: ctx.url('api') }),
  accounts: async ctx => (Array.isArray(ctx.options.users) ? ctx.options.users.map(String) : []).map(id => ({ id, label: `${id} account`, username: `${id}@example.test`, password: `${PASSWORD}-${id}` })),
} satisfies TwinService<{ users?: Json }>;

test('a prepared environment lists its twin test accounts without their passwords', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-environment-accounts-')));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repoPath = join(dataDir, 'repo'), directory = join(dataDir, 'environments', 'environment-1');
  await mkdir(repoPath); await mkdir(directory, { recursive: true });
  await writeFile(join(repoPath, 'server.mjs'), 'export {};\n');
  // The actual twin runtime; only the Docker CLI is replaced.
  const twin = createTwinRuntime({ exec: async () => ({ stdout: '', stderr: '' }), services: { auth }, isFree: async () => true });
  // The app answers on its twin address; nothing listens there in a test.
  const runtime = createEnvironmentRuntime({ services: { auth }, twin, inputs: async () => ({}), answers: async () => 200 });
  const plan = { services: { auth: { users: ['owner'] } }, apps: { web: { directory: '.', start: 'node server.mjs', port: 3000 } }, fixtures: [] };
  const updates: { timings?: unknown[] }[] = [];
  const prepared = await runtime.prepareEnvironment({ dataDir, environment: { id: 'environment-1', plan }, repoPath, directory, onUpdate: async update => { updates.push(update); }, cancelled: () => false });
  assert.deepEqual(prepared.accounts, [{ id: 'owner', label: 'owner account', username: 'owner@example.test' }]);
  // Each step's duration is recorded when the next step starts, so a failed preparation keeps the steps it finished.
  assert.deepEqual(prepared.timings.map(item => item.step), ['Copying source', 'Checking application runtimes', 'Preparing twin', 'Setting up Auth', 'Loading source', 'Starting services', 'Creating test accounts', 'Starting twin', 'Checking apps']);
  assert.ok(prepared.timings.every(item => Number.isInteger(item.ms) && item.ms >= 0));
  assert.deepEqual(updates.map(update => update.timings?.length), updates.map((_, index) => index));
  assert.ok(!JSON.stringify(prepared).includes(PASSWORD));
  const other = join(dataDir, 'environments', 'environment-2');
  await mkdir(other, { recursive: true });
  const plain = await runtime.prepareEnvironment({ dataDir, environment: { id: 'environment-2', plan: { ...plan, services: {} } }, repoPath, directory: other, onUpdate: async () => {}, cancelled: () => false });
  assert.deepEqual(plain.accounts, []);
});

const context = { key: 'local:fixture', stageId: 'beta', scan: { repo: { path: '/fixture/source', sha: 'fixture-revision', branch: 'main' }, services: [] } };
const WEB = 'http://host.docker.internal:50123';

test('environment state and every environment view keep accounts without passwords, and deletion drops them', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-accounts-'));
  // Even a runtime that returned a password could not put it into environment state.
  const runtime: ManagedRuntime = {
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id });
      return { status: 'ready', step: 'Ready', services: [], apps: [{ id: 'web', url: WEB }], accounts: [{ id: 'owner', label: 'owner', username: 'owner@example.test', password: PASSWORD }] }; },
    environmentLogs: async () => '', environmentHealth: async () => ({ status: 'ready' }), destroySandbox: async () => {},
  };
  const manager = await createEnvironmentManager({ dataDir, runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.savePlan(context, { services: {}, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const { environment } = await manager.create(context);
  const ready = await manager.awaitIdle(environment.id);
  const expected = [{ id: 'owner', label: 'owner', username: 'owner@example.test' }];
  assert.deepEqual(ready.accounts, expected);
  assert.deepEqual(manager.summaries(context.key)[0].accounts, expected);
  assert.deepEqual((await manager.view(context)).environments[0].accounts, expected);
  assert.deepEqual(manager.resolveTarget(`${WEB}/billing`)?.accounts, expected);
  for (const value of [ready, manager.summaries(context.key), await manager.view(context), manager.resolveTarget(WEB)]) assert.ok(!JSON.stringify(value).includes(PASSWORD));
  assert.ok(!(await readFile(join(dataDir, 'environments', 'state.json'), 'utf8')).includes(PASSWORD));
  await manager.destroy(context, environment.id);
  const destroyed = await manager.awaitIdle(environment.id);
  assert.equal(destroyed.status, 'destroyed');
  assert.equal('accounts' in destroyed, false);
});
