import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentRuntime } from '../src/environments/runtime.ts';
import { createEnvironmentUsage } from '../src/environments/usage.ts';
import { createStageRemovalManager } from '../src/environments/stage-removal.ts';
import type { EnvironmentManager } from '../src/environments/manager.ts';
import type { EnvironmentTwin } from '../src/environments/runtime.ts';
import type { StageRemovalManager } from '../src/environments/stage-removal.ts';

// A twin runtime with only the calls a test expects; any other call fails as it would without it.
const only = (calls: Partial<EnvironmentTwin>) => calls as EnvironmentTwin;

const plan = { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } };

// Only Docker Compose is substituted. Ownership checkpoints, source snapshots,
// stored inputs and persisted ownership are real.
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-environment-ownership-'));
  const repoPath = join(dataDir, 'repo');
  await mkdir(repoPath); await writeFile(join(repoPath, 'app.mjs'), 'export const workspace = true;\n');
  const context = { key: 'ownership-fixture', stageId: 'beta', scan: { repo: { path: repoPath }, services: [] } };
  const usage = createEnvironmentUsage(), observations = { cleanups: 0 };
  const twin = only({
    prepare: async ({ source }) => {
      assert.equal(await readFile(join(source, 'app.mjs'), 'utf8'), 'export const workspace = true;\n');
      return { status: 'ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:53000' }] };
    },
    destroy: async () => { observations.cleanups++; },
  });
  // The app answers on its twin address; nothing listens there in a test.
  const runtime = createEnvironmentRuntime({ twin, answers: async () => 200 });
  const managers: EnvironmentManager[] = [];
  let removal: StageRemovalManager | undefined;
  const open = async () => {
    const manager = await createEnvironmentManager({ dataDir, usage, runtime }); managers.push(manager); return manager;
  };
  const manager = await open();
  t.after(async () => {
    await removal?.close();
    for (const item of managers) await item.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await manager.savePlan(context, plan);
  return { dataDir, context, manager, observations, open,
    async removal() {
      removal = await createStageRemovalManager({ dataDir, usage, environments: manager,
        browser: { isActive: () => false, removeStage: async () => {} }, removeStage: async () => {} });
      return removal;
    },
  };
}

test('failed creation admission leaves no phantom operation after storage recovers', async t => {
  const f = await fixture(t);
  const stateFile = join(f.dataDir, 'environments/state.json');
  await rm(stateFile); await mkdir(stateFile);
  await assert.rejects(f.manager.create(f.context), /EISDIR|ENOTEMPTY|rename/);
  await rm(stateFile, { recursive: true });
  await f.manager.savePlan(f.context, plan);
  const removal = await f.removal();
  await removal.start(f.context);
  await removal.awaitIdle(f.context);
  assert.equal(removal.view(f.context).removal?.status, 'completed');
  assert.equal(f.manager.summaries(f.context.key).length, 0, 'Unadmitted work must not leave a queued environment.');
  assert.equal(f.observations.cleanups, 0, 'No twin was allocated by the rejected request.');
});

test('settling browser uncertainty quarantines during shutdown and retains it after a failed save', async t => {
  const f = await fixture(t);
  const { environment } = await f.manager.create(f.context);
  await f.manager.awaitIdle(environment.id);
  await f.manager.close();
  const stateFile = join(f.dataDir, 'environments/state.json');
  await rm(stateFile); await mkdir(stateFile);
  await assert.rejects(f.manager.markUsageUncertain(environment.id, new Error('Browser cleanup remained uncertain')), /EISDIR|ENOTEMPTY|rename/);
  assert.equal(f.manager.resolveTarget('http://localhost:53000/')?.status, 'cleanup_failed');
  await rm(stateFile, { recursive: true });
  await f.manager.markUsageUncertain(environment.id, new Error('Browser cleanup remained uncertain'));
  const restarted = await f.open();
  assert.equal(restarted.resolveTarget('http://localhost:53000/')?.status, 'cleanup_failed');
});

test('stage removal deletes the stage twin through the environment runtime before the stage', async t => {
  const f = await fixture(t);
  const { environment } = await f.manager.create(f.context);
  assert.equal((await f.manager.awaitIdle(environment.id)).sandboxId, environment.id);
  const removal = await f.removal();
  await removal.start(f.context);
  await removal.awaitIdle(f.context);
  assert.equal(removal.view(f.context).removal?.status, 'completed');
  assert.equal(f.observations.cleanups, 1);
  assert.equal(f.manager.summaries(f.context.key)[0].status, 'destroyed');
});
