import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPipelineRemovalManager } from '../src/pipeline-removal.ts';

const scope = { project: 'github:acme/app:/', key: 'pipeline:first', stageIds: ['beta', 'gamma'] };

test('pipeline deletion stays visible during cleanup and retries a failure only on request', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-removal-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let fail = true, removed = false;
  const stages: string[] = [];
  const options = { dataDir, guard() {}, async cleanStage(_scope: unknown, id: string) { stages.push(id); if (fail && id === 'gamma') throw new Error('Sandbox cleanup failed'); }, async removePipeline() { removed = true; } };
  let manager = await createPipelineRemovalManager(options);
  const accepted = await manager.start(scope);
  assert.equal(manager.blocks(scope.project), true);
  await manager.awaitIdle(scope.key);
  assert.equal(manager.view(scope.project)?.status, 'failed'); assert.equal(removed, false);
  await manager.close();
  manager = await createPipelineRemovalManager(options); manager.resume();
  await manager.awaitIdle(scope.key);
  assert.deepEqual(stages, ['beta', 'gamma']); assert.equal(manager.blocks(scope.project), true);
  fail = false;
  assert.equal((await manager.start(scope)).id, accepted.id);
  await manager.awaitIdle(scope.key);
  assert.equal(removed, true); assert.equal(manager.view(scope.project)?.status, 'completed');
  assert.equal(manager.blocks(scope.project), false);
  await manager.close();
});

test('shutdown retains deletion intent and restart finishes its original pipeline scope', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-removal-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const calls: string[] = [];
  const manager = await createPipelineRemovalManager({ dataDir, guard() {}, async cleanStage(_scope, id) { calls.push(id); started.resolve(); await finish.promise; }, async removePipeline() { calls.push('removed'); } });
  await manager.start(scope); await started.promise;
  const closing = manager.close(); finish.resolve(); await closing;
  assert.deepEqual(calls, ['beta']); assert.equal(manager.view(scope.project)?.status, 'queued');
  const restarted = await createPipelineRemovalManager({ dataDir, guard() {}, async cleanStage(value, id) { assert.deepEqual(value, scope); calls.push(id); }, async removePipeline(value) { assert.deepEqual(value, scope); calls.push('removed'); } });
  restarted.resume(); await restarted.awaitIdle(scope.key);
  assert.deepEqual(calls, ['beta', 'beta', 'gamma', 'removed']);
  assert.equal(restarted.view(scope.project)?.status, 'completed'); await restarted.close();
});

test('a rejected deletion has no durable intent and a replacement generation has its own deletion', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-removal-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let blocked = true;
  const manager = await createPipelineRemovalManager({ dataDir, guard() { if (blocked) throw new Error('Run active'); }, async cleanStage() {}, async removePipeline() {} });
  await assert.rejects(manager.start(scope), /Run active/); assert.equal(manager.view(scope.project), null);
  blocked = false;
  const first = await manager.start(scope); await manager.awaitIdle(scope.key);
  const next = { ...scope, key: 'pipeline:second' }, second = await manager.start(next);
  assert.notEqual(first.id, second.id); await manager.awaitIdle(next.key); await manager.close();
});
