import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentRuntime, type EnvironmentTwin } from '../src/environments/runtime.ts';
import { snapshotSource } from '../src/environments/plans.ts';

const revision = 'a'.repeat(40);
const config = { services: {}, apps: { web: { directory: '.', start: 'node app.mjs', port: 3000, env: {} } }, fixtures: [] };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected twin operation.'); };

test('local reuse receives the repository identity and actual snapshot fingerprint, refreshed after source edits', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-local-build-environment-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'app.mjs'), 'export const version = 1;\n');
  const prepared: Parameters<EnvironmentTwin['prepare']>[0][] = [];
  const twin: EnvironmentTwin = { health: unexpected, logs: unexpected, destroy: unexpected, prepare: async input => {
    prepared.push(input);
    return { services: [], apps: [] };
  } };
  const runtime = createEnvironmentRuntime({ twin });
  const prepare = async (id: string) => runtime.prepareEnvironment({ dataDir: root,
    environment: { id, pipelineKey: 'repository-pipeline-key', sourceRevision: revision, plan: config },
    repoPath, directory: join(root, id), selectionReviewed: true, onUpdate: async () => {}, cancelled: () => false });

  const firstSnapshot = await snapshotSource(repoPath, join(root, 'expected-first'));
  await prepare('stage-one');
  assert.equal(prepared[0]?.repository, 'repository-pipeline-key');
  assert.deepEqual(prepared[0]?.buildSource, { revision, hash: firstSnapshot.hash });

  await writeFile(join(repoPath, 'app.mjs'), 'export const version = 2;\n');
  const secondSnapshot = await snapshotSource(repoPath, join(root, 'expected-second'));
  await prepare('stage-two');
  assert.equal(prepared[1]?.repository, 'repository-pipeline-key');
  assert.deepEqual(prepared[1]?.buildSource, { revision, hash: secondSnapshot.hash });
  assert.notEqual(prepared[1]?.buildSource?.hash, prepared[0]?.buildSource?.hash, 'A caller-supplied source version cannot stand in for the copied snapshot fingerprint.');
});

test('repair environments receive neither repository sharing nor a reusable build source identity', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-local-build-repair-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'app.mjs'), 'export const repair = true;\n');
  let prepared: Parameters<EnvironmentTwin['prepare']>[0] | undefined;
  const twin: EnvironmentTwin = { health: unexpected, logs: unexpected, destroy: unexpected, prepare: async input => {
    prepared = input;
    return { services: [], apps: [] };
  } };
  const runtime = createEnvironmentRuntime({ twin });
  await runtime.prepareEnvironment({ dataDir: root,
    environment: { id: 'repair-environment', repair: 'repair-head', pipelineKey: 'repository-pipeline-key', sourceRevision: revision, plan: config },
    repoPath, directory: join(root, 'repair-environment'), selectionReviewed: true, onUpdate: async () => {}, cancelled: () => false });
  assert.ok(prepared);
  assert.equal(prepared.repository, undefined);
  assert.equal(prepared.buildSource, undefined);
});
