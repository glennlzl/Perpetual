import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace } from '../client/src/lib/test-workspace.ts';
import { applyPipelineAction, defaultPipeline } from '../src/pipeline.ts';

const source = { path: '/acme/app', branch: 'main' };

test('rapid stage toggles stay responsive and a failed save rolls back only its own preference', async t => {
  let saved = defaultPipeline(source.path);
  const first = Promise.withResolvers<void>();
  const requests: string[] = [];
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    requests.push(String(input?.stageId));
    if (requests.length === 1) { await first.promise; throw new Error('Could not save Build'); }
    saved = applyPipelineAction(saved, input);
    return { pipeline: saved };
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: saved, browserTests: {} });
  workspace.stage('build').edit('note', 'unsaved');
  const build = workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' });
  const failed = assert.rejects(build, /Could not save Build/);
  const production = workspace.changePipeline({ action: 'toggle-stage', stageId: 'production' });
  assert.equal(workspace.getSnapshot().pipeline?.stages.find(stage => stage.id === 'build')?.collapsed, true);
  assert.equal(workspace.getSnapshot().pipeline?.stages.find(stage => stage.id === 'production')?.collapsed, true);
  await Promise.resolve();
  assert.deepEqual(requests, ['build'], 'Preference saves reach the controller in click order.');
  first.resolve();
  await failed; await production;
  assert.deepEqual(requests, ['build', 'production']);
  assert.equal(workspace.getSnapshot().pipeline?.stages.find(stage => stage.id === 'build')?.collapsed, false);
  assert.equal(workspace.getSnapshot().pipeline?.stages.find(stage => stage.id === 'production')?.collapsed, true);
  assert.equal(workspace.stage('build').getSnapshot().drafts.note, 'unsaved');
});

test('each saved click stays applied when a later click of the same stage fails', async t => {
  let saved = defaultPipeline(source.path), writes = 0;
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    if (++writes === 1) { await first.promise; saved = applyPipelineAction(saved, input); return { pipeline: saved }; }
    await second.promise; throw new Error('Second click failed');
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: saved, browserTests: {} });
  const once = workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' });
  const twice = assert.rejects(workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' }), /Second click failed/);
  assert.equal(workspace.getSnapshot().pipeline?.stages[1].collapsed, false, 'Both clicks appear before either save finishes.');
  first.resolve(); await once;
  assert.equal(workspace.getSnapshot().pipeline?.stages[1].collapsed, false, 'A successful earlier reply keeps the later click visible.');
  second.resolve(); await twice;
  assert.equal(workspace.getSnapshot().pipeline?.stages[1].collapsed, true, 'Only the failed second click is rolled back.');
});

test('switching source drops unsent pipeline changes and ignores the previous source reply', async t => {
  const first = Promise.withResolvers<void>(), requests: string[] = [];
  const initial = defaultPipeline(source.path), next = applyPipelineAction(initial, { action: 'add-stage', name: 'Gamma' });
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    requests.push(String(input?.stageId)); await first.promise;
    return { pipeline: applyPipelineAction(initial, input) };
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: initial, browserTests: {} });
  const sent = assert.rejects(workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' }), { name: 'AbortError' });
  const queued = assert.rejects(workspace.changePipeline({ action: 'toggle-stage', stageId: 'production' }), { name: 'AbortError' });
  await Promise.resolve();
  assert.deepEqual(requests, ['build']);
  workspace.activate({ ...source, branch: 'feature' }, { pipeline: next, browserTests: {} });
  first.resolve(); await sent; await queued;
  assert.deepEqual(requests, ['build'], 'The queued click from the old branch never reaches the controller.');
  assert.deepEqual(workspace.getSnapshot().pipeline, next);
  assert.equal(workspace.getSnapshot().error, '');
});

test('structural pipeline edits follow preferences without overwriting stage drafts or pending removal', async t => {
  let saved = applyPipelineAction(defaultPipeline(source.path), { action: 'add-stage', name: 'Beta' });
  const beta = saved.stages[2].id, first = Promise.withResolvers<void>(), actions: string[] = [];
  const removal = { id: 'removal', stageId: beta, status: 'destroying' };
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    actions.push(String(input?.action));
    if (actions.length === 1) await first.promise;
    saved = applyPipelineAction(saved, input); return { pipeline: saved };
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: saved, browserTests: {}, stageRemovals: [removal] });
  workspace.stage(beta).edit('config', { targetUrl: 'https://preview.test', scope: 'unsaved', requirements: '', maxSteps: 60 });
  const toggle = workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' });
  const rename = workspace.changePipeline({ action: 'rename-stage', stageId: beta, name: 'Preview' });
  assert.equal(workspace.getSnapshot().pipeline?.stages[2].name, 'Beta', 'Only collapse preferences are optimistic.');
  first.resolve(); await toggle; await rename;
  assert.deepEqual(actions, ['toggle-stage', 'rename-stage']);
  assert.equal(workspace.getSnapshot().pipeline?.stages[1].collapsed, true);
  assert.equal(workspace.getSnapshot().pipeline?.stages[2].name, 'Preview');
  assert.equal(workspace.stage(beta).getSnapshot().drafts.config?.scope, 'unsaved');
  assert.equal(workspace.stage(beta).getSnapshot().dirty.config, true);
  assert.deepEqual(workspace.getSnapshot().stageRemovals, [removal]);
});

test('a poll started during a pending click cannot undo it after the save finishes', async t => {
  const initial = defaultPipeline(source.path), write = Promise.withResolvers<void>(), read = Promise.withResolvers<void>();
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    if (input) { await write.promise; return { pipeline: applyPipelineAction(initial, input) }; }
    await read.promise; return { scan: { repo: source }, pipeline: initial, browserTests: {} };
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: initial, browserTests: {} });
  const saving = workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' });
  const polling = workspace.refreshSource();
  write.resolve(); await saving;
  read.resolve(); await polling;
  assert.equal(workspace.getSnapshot().pipeline?.stages[1].collapsed, true);
});

test('disposing the workspace discards unsent clicks and ignores an in-flight failure', async () => {
  const write = Promise.withResolvers<void>(), requests: unknown[] = [];
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => {
    requests.push(input); await write.promise; throw new Error('Old connection failed');
  } });
  workspace.activate(source, { pipeline: defaultPipeline(source.path), browserTests: {} });
  const first = assert.rejects(workspace.changePipeline({ action: 'toggle-stage', stageId: 'build' }), { name: 'AbortError' });
  const second = assert.rejects(workspace.changePipeline({ action: 'toggle-stage', stageId: 'production' }), { name: 'AbortError' });
  await Promise.resolve(); workspace.dispose();
  const before = workspace.getSnapshot();
  write.resolve(); await first; await second;
  assert.equal(requests.length, 1);
  assert.equal(workspace.getSnapshot(), before);
});

test('source polling observes a disconnect and a deleted pipeline, pruning drafts and refusing its old stage', async () => {
  const drafts: string[][] = [];
  const definition = { repoPath: '/acme/app', stages: [{ id: 'source', name: 'Source', kind: 'source', collapsed: false }, { id: 'build', name: 'Build', kind: 'build', collapsed: false }, { id: 'production', name: 'Production', kind: 'production', collapsed: false }], transitions: [] };
  const removed = { id: 'removal', status: 'completed' as const, createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:01:00Z' };
  const workspace = createTestWorkspace({ pollInterval: 0, pruneDrafts(_path, ids) { drafts.push([...ids]); }, controller: async () => ({ scan: { repo: { path: '/acme/app', branch: 'main' } }, pipeline: null, pipelineId: null, githubConnection: null, pipelineRemoval: removed }) });
  workspace.activate({ path: '/acme/app', branch: 'main' }, { pipeline: definition, browserTests: {}, githubConnection: { login: 'developer', connectedAt: '2026-10-06T12:00:00Z' } });
  const stage = workspace.stage('build'); assert.equal(stage.isCurrent(), true);
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().pipeline, null); assert.equal(workspace.getSnapshot().githubConnection, null); assert.equal(workspace.getSnapshot().pipelineRemoval?.status, 'completed');
  assert.deepEqual(drafts.at(-1), []); assert.equal(stage.isCurrent(), false); workspace.dispose();
});
