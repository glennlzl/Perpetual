import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { holdsResources } from '../src/environments/usage.ts';
import type { EnvironmentManager, ManagedRuntime } from '../src/environments/manager.ts';

type Saved = { environments: { id: string; status: string; cleanedAt?: string; services?: unknown[] }[] };
// A runtime with only the calls a test expects; any other call fails as it would without it.
const only = (calls: Partial<ManagedRuntime>) => calls as ManagedRuntime;

const context = { key: 'crash-fixture', stageId: 'beta', scan: { repo: { path: '/fixture/source', sha: 'fixture', branch: 'main' }, services: [] } };
const script = String.raw`
  const { dataDir, managerUrl, context, operation } = JSON.parse(process.argv[1]);
  const { createEnvironmentManager } = await import(managerUrl);
  const keepAlive = setInterval(() => {}, 1000);
  const wait = new Promise(() => {});
  let current, other;
  const entered = () => { process.stdout.write(JSON.stringify({ current, other })+'\n'); return wait; };
  const manager = await createEnvironmentManager({ dataDir, runtime: {
    prepareEnvironment: async ({ environment, onUpdate }) => {
      await onUpdate({ sandboxId: environment.id });
      return { status: 'ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:' + (environment.stageId === 'beta' ? 50123 : 50124) }] };
    },
    destroySandbox: () => wait,
  } });
  const plan = { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } };
  for (const stageId of ['beta', 'gamma']) {
    const scope = { ...context, stageId };
    await manager.savePlan(scope, plan);
    const { environment } = await manager.create(scope);
    await manager.awaitIdle(environment.id);
    if (stageId === 'beta') current = environment.id; else other = environment.id;
  }
  // Deletion is durably recorded before the crash; the twin call never returns.
  if (operation === 'destroy') await manager.destroy(context, current);
  await entered();
`;

async function crashFixture(t: TestContext, operation: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-crash-'));
  const managers: EnvironmentManager[] = [];
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify({ dataDir, operation, context,
    managerUrl: new URL('../src/environments/manager.ts', import.meta.url).href })], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const resources = await new Promise<{ current: string; other: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Crash worker exited before admission: ${errors}`)));
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
  });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  return { dataDir, ...resources, manage: (manager: EnvironmentManager) => { managers.push(manager); return manager; } };
}

test('hard crash during deletion preserves and blocks only the affected owned environment until cleanup', { timeout: 10000 }, async t => {
  const { dataDir, current, other, manage } = await crashFixture(t, 'destroy');
  const before: Saved = JSON.parse(await readFile(join(dataDir, 'environments/state.json'), 'utf8'));
  assert.equal(before.environments.find(item => item.id === current)?.status, 'destroying');
  let destroyed = 0;
  const unexpected = async () => { throw new Error('Recovery must not replay twin operations'); };
  const manager = manage(await createEnvironmentManager({ dataDir, runtime: only({
    prepareEnvironment: unexpected, environmentHealth: unexpected,
    destroySandbox: async ({ environment }) => { assert.equal(environment.sandboxId, current); destroyed++; },
  }), onReady: unexpected }));
  const affected = (await manager.view(context)).environments.find(item => item.id === current)!;
  assert.equal(affected.status, 'cleanup_failed');
  assert.equal(affected.sandboxId, current);
  assert.match(affected.error!, /stopped/i);
  assert.equal(manager.resolveTarget('http://localhost:50123/workspace')?.status, 'cleanup_failed');
  assert.equal(manager.summaries(context.key).find(item => item.id === other)?.status, 'ready');
  assert.equal(destroyed, 0);
  await manager.destroy(context, current); await manager.awaitIdle(current);
  assert.equal(destroyed, 1);
  assert.equal(manager.resolveTarget('http://127.0.0.1:50123/')?.status, 'destroyed');
});

test('interrupted owned Browser use quarantines its environment without replaying work on either restart', { timeout: 10000 }, async t => {
  const { dataDir, current, other, manage } = await crashFixture(t, 'idle');
  let manager = manage(await createEnvironmentManager({ dataDir, interruptedEnvironmentIds: [current, 'missing-environment'] }));
  assert.equal(manager.resolveTarget('http://localhost:50123/')?.status, 'cleanup_failed');
  assert.equal(manager.summaries(context.key).find(item => item.id === other)?.status, 'ready');
  await manager.close();
  manager = manage(await createEnvironmentManager({ dataDir }));
  assert.equal(manager.resolveTarget('http://localhost:50123/')?.status, 'cleanup_failed');
  await manager.close();
});

test('a creation interrupted before it owned a sandbox leaves no copied source behind', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-crash-'));
  let manager: EnvironmentManager | undefined;
  t.after(async () => { await manager?.close(); await rm(dataDir, { recursive: true, force: true }); });
  // The controller was killed while each was queued or copying the source, before the twin recorded its ownership.
  const statuses = ['queued', 'creating', 'preparing'], ids = statuses.map(() => randomUUID());
  await mkdir(join(dataDir, 'environments'), { mode: 0o700 });
  for (const id of ids) { await mkdir(join(dataDir, 'environments', id, 'source'), { recursive: true }); await writeFile(join(dataDir, 'environments', id, 'source', 'app.mjs'), 'export {};\n'); }
  await writeFile(join(dataDir, 'environments/state.json'), JSON.stringify({ version: 1, plans: {}, detected: {}, drafts: {}, environments: statuses.map((status, index) => ({
    id: ids[index], scope: 'fixture-scope', pipelineKey: context.key, stageId: context.stageId, repoPath: context.scan.repo.path, sourceBranch: 'main', sourceRevision: 'fixture',
    status, step: 'Copying source', services: [], apps: [], createdAt: new Date().toISOString() })) }));
  const unexpected = async () => { throw new Error('Recovery must not replay twin operations'); };
  manager = await createEnvironmentManager({ dataDir, runtime: only({ prepareEnvironment: unexpected, environmentHealth: unexpected, destroySandbox: unexpected }) });
  assert.deepEqual(manager.summaries(context.key).map(item => [item.status, item.step, holdsResources(item)]), statuses.map(() => ['failed', 'Interrupted', false]));
  for (const id of ids) await assert.rejects(access(join(dataDir, 'environments', id)), { code: 'ENOENT' }, id);
});

test('interrupted Browser IDs do not revive ownership for deleted or already-cleaned environments', { timeout: 10000 }, async t => {
  const { dataDir, current, other, manage } = await crashFixture(t, 'idle');
  const file = join(dataDir, 'environments/state.json');
  const saved: Saved = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(saved.environments.find(item => item.id === current)!, { status: 'failed', cleanedAt: new Date().toISOString() });
  Object.assign(saved.environments.find(item => item.id === other)!, { status: 'destroyed', services: [] });
  await writeFile(file, JSON.stringify(saved));
  const manager = manage(await createEnvironmentManager({ dataDir, interruptedEnvironmentIds: [current, other] }));
  assert.equal(manager.summaries(context.key).find(item => item.id === current)?.status, 'failed');
  assert.equal(manager.summaries(context.key).find(item => item.id === other)?.status, 'destroyed');
});
