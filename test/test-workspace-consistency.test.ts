import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserManager, type BrowserManagerOptions } from '../src/browser/manager.ts';
import { createTestWorkspace } from '../client/src/lib/test-workspace.ts';

import type { BrowserCase } from '../contract/browser.ts';

const original: BrowserCase = { id: 'checkout', name: 'Complete checkout', goal: 'Buy a product', steps: [{ id: 'buy', title: 'Buy a product' }, { id: 'verify', title: 'Verify the saved order' }], expectedOutcomes: ['Order saved'], preconditions: [], assertions: [{ type: 'text-visible', value: 'Order saved' }], needsReview: true, selected: false, isolation: 'shared', evidence: [] };

// A runtime for tests that only save and read cases: it reports its capabilities and never starts a worker.
const casesOnly = (capabilities: { runtimeInstalled: boolean; browserInstalled: boolean; modelConfigured: boolean }): NonNullable<BrowserManagerOptions['runtime']> => ({ capabilities: async () => capabilities, start() { throw new Error('These tests start no browser worker.'); } });

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-workspace-consistency-'));
  const manager = await createBrowserManager({ dataDir, runtime: casesOnly({ runtimeInstalled: true, browserInstalled: true, modelConfigured: false }) });
  const source = { path: join(dataDir, 'repo'), branch: 'main' };
  const context = { key: 'repo', stageId: 'beta', scan: { repo: source } };
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (path, input) => {
    if (path === '/api/browser/cases') return manager.saveCases(context, input!.cases, input!.baseCases);
    if (path.startsWith('/api/browser?')) return manager.view(context);
    throw new Error(`Unexpected request: ${path}`);
  } });
  t.after(async () => { workspace.dispose(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.saveCases(context, [original]);
  workspace.activate(source, { browserTests: { beta: await manager.view(context) } });
  return { manager, context, workspace, stage: workspace.stage('beta'), dataDir };
}

test('saving an open case review cannot silently delete a case added by another caller', async t => {
  const { manager, context, stage } = await fixture(t);
  // Another source of case updates finishes before the open editor's next poll.
  const added = { ...original, id: 'refund', name: 'Complete refund' };
  await manager.saveCases(context, [original, added]);
  let failure: Error | undefined;
  try { await stage.saveBrowserCase({ ...original, needsReview: false }); }
  catch (error) { failure = error as Error; }

  const persisted = await manager.view(context);
  assert.equal(persisted.cases.some(item => item.id === added.id), true, 'The stale review save deleted the newer case');
  assert.match(failure?.message || '', /changed|refresh|reopen/i, 'The editor must explain why its stale save was rejected');
  assert.equal(persisted.cases.find(item => item.id === original.id)!.needsReview, true);
  assert.deepEqual(stage.getSnapshot().browser.cases, persisted.cases, 'A rejected save refreshes the list for the next attempt');
});

test('a refreshed list cannot turn an old open editor into approval of another caller’s changes', async t => {
  const { manager, context, stage } = await fixture(t);
  const opened = stage.getSnapshot().browser.cases[0];
  await manager.saveCases(context, [{ ...original, goal: 'Buy a different product' }]);
  await stage.refresh('browser');
  await assert.rejects(stage.saveBrowserCase({ ...opened, needsReview: false }, opened), /changed|reopen/i);
  const persisted = (await manager.view(context)).cases[0];
  assert.equal(persisted.goal, 'Buy a different product');
  assert.equal(persisted.needsReview, true);
});

test('an open review cannot recreate a case deleted while the editor was open', async t => {
  const { manager, context, stage } = await fixture(t);
  const opened = stage.getSnapshot().browser.cases[0];
  await manager.saveCases(context, []);
  await stage.refresh('browser');
  await assert.rejects(stage.saveBrowserCase({ ...opened, needsReview: false }, opened), /changed|reopen/i);
  assert.deepEqual((await manager.view(context)).cases, []);
});

test('current case baselines save successfully, including legacy internal callers without a baseline', async t => {
  const { manager, context, stage } = await fixture(t);
  const opened = stage.getSnapshot().browser.cases[0];
  await stage.saveBrowserCase({ ...opened, needsReview: false }, opened);
  assert.equal((await manager.view(context)).cases[0].needsReview, false);
  await manager.saveCases(context, [original]);
  assert.equal((await manager.view(context)).cases[0].needsReview, true);
});

test('two simultaneous reviewers cannot both replace the same case baseline', async t => {
  const { manager, context } = await fixture(t);
  const baseline = (await manager.view(context)).cases;
  const changes = ['First review', 'Second review'].map(name => [{ ...baseline[0], name, needsReview: false }]);
  const results = await Promise.allSettled(changes.map(cases => manager.saveCases(context, cases, baseline)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal((rejected!.reason as { statusCode?: number }).statusCode, 409);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal((await manager.view(context)).cases[0].name, changes[winner][0].name);
});

test('failed case persistence leaves the previous review and another stage’s cases intact', async t => {
  const { manager, context, dataDir } = await fixture(t);
  const other = { ...context, stageId: 'gamma' };
  await manager.saveCases(other, [{ ...original, name: 'Other stage' }]);
  const baseline = (await manager.view(context)).cases;
  // Only the disposable fixture store is made unavailable; no real state is read.
  await rename(join(dataDir, 'browser'), join(dataDir, 'unavailable-browser'));
  try {
    await assert.rejects(manager.saveCases(context, [{ ...baseline[0], needsReview: false }], baseline), /ENOENT/);
  } finally { await rename(join(dataDir, 'unavailable-browser'), join(dataDir, 'browser')); }
  assert.deepEqual((await manager.view(context)).cases, baseline);
  assert.equal((await manager.view(other)).cases[0].name, 'Other stage');
  await manager.saveCases(context, [{ ...baseline[0], needsReview: false }], baseline);
  assert.equal((await manager.view(context)).cases[0].needsReview, false);
});

test('case saves in independent stages both remain persisted', async t => {
  const { manager, context, dataDir } = await fixture(t);
  const other = { ...context, stageId: 'gamma' };
  await manager.saveCases(other, [original]);
  const baseline = (await manager.view(context)).cases;
  await Promise.all([
    manager.saveCases(context, [{ ...baseline[0], name: 'Beta review' }], baseline),
    manager.saveCases(other, [{ ...baseline[0], name: 'Gamma review' }], baseline),
  ]);
  await manager.close();
  const restored = await createBrowserManager({ dataDir, runtime: casesOnly({ runtimeInstalled: false, browserInstalled: false, modelConfigured: false }) });
  try {
    assert.equal((await restored.view(context)).cases[0].name, 'Beta review');
    assert.equal((await restored.view(other)).cases[0].name, 'Gamma review');
  } finally { await restored.close(); }
});
