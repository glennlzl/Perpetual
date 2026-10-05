import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import type { ManagedRuntime } from '../src/environments/manager.ts';

const runtime: ManagedRuntime = { prepareEnvironment: async () => ({ status: 'ready', services: [], apps: [] }), environmentLogs: async () => '', environmentHealth: async () => ({ status: 'ready' }), destroySandbox: async () => {} };

test('a detected plan follows each new scan until the user saves one, which is never replaced', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-plan-detection-')));
  const repoPath = join(dataDir, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  const context = (scannedAt: string) => ({ key: 'local:fixture', stageId: 'beta', scan: { repo: { path: repoPath, sha: 'a'.repeat(40), branch: 'main' }, scannedAt, services: [] } });
  let manager = await createEnvironmentManager({ dataDir, runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual(Object.keys((await manager.view(context('1'))).plan.services), []);
  // The repository gains a dependency; the next scan detects it.
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'app', dependencies: { stripe: '17.0.0' } }));
  assert.deepEqual(Object.keys((await manager.view(context('1'))).plan.services), [], 'The same scan keeps its plan');
  assert.deepEqual(Object.keys((await manager.view(context('2'))).plan.services), ['stripe']);
  // A restart keeps the detection record.
  await manager.close();
  manager = await createEnvironmentManager({ dataDir, runtime });
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  assert.deepEqual(Object.keys((await manager.view(context('3'))).plan.services), []);
  // A saved plan is the user's.
  await manager.savePlan(context('3'), { services: { stripe: {} }, apps: {} });
  assert.deepEqual(Object.keys((await manager.view(context('4'))).plan.services), ['stripe']);
  // A config its services refuse is not saved, as the twin would never build it.
  await assert.rejects(manager.savePlan(context('4'), { services: { stripe: { bogus: 1 } }, apps: {} }), /^Error: services\.stripe has unsupported option bogus; use /);
  assert.deepEqual((await manager.view(context('4'))).plan.services, { stripe: {} });
});

test('a detected plan without an app says how an agent can write the config', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-plan-detection-'))), repoPath = join(dataDir, 'repo');
  await mkdir(repoPath);
  // A package with no start script, which detection proposes no app for.
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'site', scripts: { dev: 'nuxt dev', build: 'nuxt build' } }));
  let model: { apiKey: string; model: string } | null = null;
  const manager = await createEnvironmentManager({ dataDir, runtime, authoringModel: async () => model });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const context = { key: 'local:fixture', stageId: 'beta', scan: { repo: { path: repoPath, sha: 'a'.repeat(40), branch: 'main' }, scannedAt: '1', services: [{ id: 'service:.', path: '.' }] } };
  // Without an OpenRouter model, a person's Create builds the detected plan as it is.
  await assert.rejects(manager.create(context, { generate: true }), /^Error: No app was detected\. Add an OpenRouter API key in Settings so Perpetual can write the twin config\.$/);
  // A gate never generates; with a model, a person's Create writes the config.
  model = { apiKey: 'sk-or-v1-fixture', model: 'fixture/model' };
  await assert.rejects(manager.create(context), /^Error: No app was detected\. Create the environment so Perpetual can write the twin config\.$/);
  // A person's saved config is theirs to fix.
  await manager.savePlan(context, { services: {}, apps: {} });
  await assert.rejects(manager.create(context, { generate: true }), /^Error: Add an app before creating this environment\.$/);
  assert.deepEqual(manager.summaries(context.key), []);
});

test('a plan saved while a new scan is being detected is kept', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-plan-detection-'))), repoPath = join(dataDir, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  const context = (scannedAt: string) => ({ key: 'local:fixture', stageId: 'beta', scan: { repo: { path: repoPath, sha: 'a'.repeat(40), branch: 'main' }, scannedAt, services: [] } });
  let manager = await createEnvironmentManager({ dataDir, runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual((await manager.view(context('1'))).plan, { services: {}, apps: {} });
  // A rescan's view detects again while the person saves their config.
  const viewing = manager.view(context('2'));
  const { plan: saved } = await manager.savePlan(context('2'), { services: { stripe: {} }, apps: {} });
  assert.deepEqual((await viewing).plan, saved);
  assert.deepEqual((await manager.view(context('3'))).plan, saved, 'The saved plan is never detected again.');
  await manager.close();
  manager = await createEnvironmentManager({ dataDir, runtime });
  assert.deepEqual((await manager.view(context('4'))).plan, saved);
});
