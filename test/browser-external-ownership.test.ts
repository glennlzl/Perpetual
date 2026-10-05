import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserManager, type BrowserManagerOptions } from '../src/browser/manager.ts';
import { codeFor } from './fixtures/journey-code.ts';
import type { BrowserCase } from '../src/business/browser-cases.ts';

const journey = { id: 'save', name: 'Save and reopen', goal: 'Save a workflow and reopen it.', isolation: 'shared', selected: true, needsReview: false,
  steps: [{ id: 'save', title: 'Save workflow' }, { id: 'reopen', title: 'Reopen workflow', checks: [{ type: 'text-visible', value: 'Saved' }] }],
  preconditions: [], expectedOutcomes: ['The workflow was saved'], assertions: [], evidence: [] } satisfies BrowserCase;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'openai/gpt-4.1-mini', name: 'Fixture model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'] }] }));
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-external-ownership-')), repo = join(dataDir, 'repo'); await mkdir(repo);
  const workers: { fail(error: Error): void; cancel(): void }[] = [];
  const start = () => {
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((_, reject) => { fail = reject; });
    const worker = { fail, cancel: () => fail(new Error('Cancelled.')) }; workers.push(worker);
    return { promise, cancel: worker.cancel };
  };
  const options: BrowserManagerOptions = { dataDir, resolveEnvironment: () => null,
    runtime: { capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: true }), start },
    playwright: { capabilities: async () => ({ browserInstalled: true }), start },
    generation: { harness: () => { throw new Error('No model runs in this test.'); } } };
  let manager = await createBrowserManager(options);
  const context = (stageId: string) => ({ key: 'repo', stageId, controllerOrigin: 'http://127.0.0.1:49999', scan: { repo: { path: repo, sha: 'a'.repeat(40) } } });
  await manager.saveModel(context('beta'), { apiKey: 'fixture-openrouter-key', model: 'openai/gpt-4.1-mini' });
  for (const [id, targetUrl] of [['beta', 'http://localhost:31001/'], ['gamma', 'http://127.0.0.1:31001/other'], ['delta', 'http://localhost:31002/']]) {
    await manager.saveConfig(context(id), { targetUrl }); await manager.saveCases(context(id), [journey]);
    await manager.saveSpec(context(id), { caseId: journey.id, code: codeFor(journey) });
  }
  t.after(async () => { workers.forEach(worker => worker.cancel()); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, workers, context, get manager() { return manager; },
    async restart() { await manager.close(); manager = await createBrowserManager(options); },
    async started(count: number) { for (let i = 0; i < 300 && workers.length < count; i++) await wait(10); assert.ok(workers.length >= count); },
    async settled(stage: string) { for (let i = 0; i < 300 && manager.isActive(context(stage)); i++) await wait(10); assert.equal(manager.isActive(context(stage)), false); },
  };
}
const account = { credentials: { username: 'tester@example.test', password: 'temporary-password' } };

test('each supported local address keeps the same external application reservation', async t => {
  const f = await fixture(t);
  await f.manager.run(f.context('beta'), {}, { manual: true }); await f.started(1);
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']) {
    await f.manager.saveConfig(f.context('gamma'), { targetUrl: `http://${host}:31001/other?screen=tests` });
    await assert.rejects(f.manager.discover(f.context('gamma')), { statusCode: 409 });
  }
  assert.equal(f.workers.length, 1, 'Changing a local alias cannot admit a second worker against the held application.');
});

test('external code generation reserves its origin against generation, discovery, run and verification in another stage', async t => {
  const f = await fixture(t);
  await f.manager.generateSpec(f.context('beta'), { caseId: journey.id, ...account }); await f.started(1);
  const target = f.context('gamma'), hash = (await f.manager.view(target)).specs[journey.id].draft!.hash;
  for (const operation of [
    () => f.manager.generateSpec(target, { caseId: journey.id, ...account }),
    () => f.manager.discover(target),
    () => f.manager.run(target, {}, { manual: true }),
    () => f.manager.verifySpec(target, { caseId: journey.id, hash }),
  ]) await assert.rejects(operation(), { statusCode: 409 });
  await f.manager.generateSpec(f.context('delta'), { caseId: journey.id, ...account }); await f.started(2);
  await f.manager.cancelSpecGeneration(f.context('beta'), { caseId: journey.id }); await f.settled('beta');
  await f.manager.run(target, {}, { manual: true }); await f.started(3);
});

test('an external generation with unconfirmed cleanup remains blocked after restart without inventing an environment', async t => {
  const f = await fixture(t);
  await f.manager.generateSpec(f.context('beta'), { caseId: journey.id, ...account }); await f.started(1);
  f.workers[0].fail(Object.assign(new Error('Owned process may remain.'), { cleanupIncomplete: true })); await f.settled('beta');
  await assert.rejects(f.manager.run(f.context('gamma'), {}, { manual: true }), /cleanup.*confirm|confirm.*cleanup/i);
  await f.restart();
  await assert.rejects(f.manager.discover(f.context('gamma')), /cleanup.*confirm|confirm.*cleanup/i);
  const generation=(await f.manager.view(f.context('beta'))).specs[journey.id].generation;
  assert.equal(generation?.status,'failed');
  assert.match(generation?.error??'',/cleanup.*confirm|confirm.*cleanup/i);
  assert.equal(f.workers.length,1,'Restoring a failure never starts a worker or releases the held origin.');
  const saved = await readFile(join(f.dataDir, 'browser/state.json'), 'utf8');
  assert.doesNotMatch(saved, /temporary-password|fixture-openrouter-key/);
  assert.equal((await f.manager.view(f.context('gamma'))).runs.length, 0);
});

test('external runs retain unconfirmed ownership and interrupted external operations cannot resume after restart', async t => {
  const f = await fixture(t);
  await f.manager.run(f.context('beta'), {}, { manual: true }); await f.started(1);
  f.workers[0].fail(Object.assign(new Error('Owned process may remain.'), { cleanupIncomplete: true })); await f.settled('beta');
  await assert.rejects(f.manager.generateSpec(f.context('gamma'), { caseId: journey.id, ...account }), /cleanup.*confirm|confirm.*cleanup/i);
  const run = (await f.manager.view(f.context('beta'))).runs[0]; assert.equal(run.environmentId, undefined);
  await f.manager.close();
  const file = join(f.dataDir, 'browser/state.json'), state = JSON.parse(await readFile(file, 'utf8'));
  // A controller killed before it could settle a run leaves it active in its durable history.
  state.externalOperations = {}; state.runs[0].status = 'running';
  await writeFile(file, JSON.stringify(state)); await f.restart();
  await assert.rejects(f.manager.run(f.context('gamma'), {}, { manual: true }), /cleanup.*confirm|confirm.*cleanup/i);
});

test('external run and discovery reservations also refuse a later code generation and release after confirmed shutdown', async t => {
  const f = await fixture(t);
  for (const mode of ['run', 'discover'] as const) {
    const { run } = mode === 'run' ? await f.manager.run(f.context('beta'), {}, { manual: true }) : await f.manager.discover(f.context('beta'));
    await assert.rejects(f.manager.generateSpec(f.context('gamma'), { caseId: journey.id, ...account }), { statusCode: 409 });
    await f.manager.stop(f.context('beta'), run.id); await f.settled('beta');
  }
  await f.manager.generateSpec(f.context('gamma'), { caseId: journey.id, ...account });
});

test('an interrupted external generation keeps its durable hold and workspace when the controller restarts', async t => {
  const f = await fixture(t);
  await f.manager.generateSpec(f.context('beta'), { caseId: journey.id, ...account }); await f.started(1);
  const file = join(f.dataDir, 'browser/state.json'), interrupted = await readFile(file, 'utf8');
  const saved = JSON.parse(interrupted), [owned] = Object.values(saved.externalOperations ?? {}) as { workspace: string }[];
  assert.ok(owned?.workspace, 'The worker must record ownership before it starts.');
  await f.manager.close();
  const workspace = join(f.dataDir, 'browser/generations', owned.workspace); await mkdir(workspace); await writeFile(join(workspace, 'evidence.txt'), 'interrupted worker');
  await writeFile(file, interrupted); await f.restart();
  await assert.rejects(f.manager.run(f.context('gamma'), {}, { manual: true }), /cleanup.*confirm|confirm.*cleanup/i);
  assert.equal(await readFile(join(workspace, 'evidence.txt'), 'utf8'), 'interrupted worker');
});

test('a failed final state save cannot release an external operation for another worker', async t => {
  const f = await fixture(t);
  await f.manager.run(f.context('beta'), {}, { manual: true }); await f.started(1);
  const file = join(f.dataDir, 'browser/state.json');
  // The journey's start is saved as it launches; the file is replaced once that save has landed.
  for (const deadline = Date.now() + 10000; JSON.parse(await readFile(file, 'utf8')).runs[0].progress.cases[0].status !== 'running'; await wait(10)) assert.ok(Date.now() < deadline, 'The journey start was not saved.');
  const saved = await readFile(file, 'utf8');
  await rm(file); await mkdir(file);
  try {
    f.workers[0].fail(new Error('The browser stopped.')); await f.settled('beta');
    // A repeat run waits for its preceding job's final save before reserving the origin again.
    await assert.rejects(f.manager.run(f.context('beta'), {}, { manual: true }), /cleanup.*confirm|confirm.*cleanup/i);
    assert.equal(f.workers.length, 1);
  } finally { await rm(file, { recursive: true }); await writeFile(file, saved); }
});

test('failed generation workspace cleanup preserves ownership and reports a settled failure', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  await f.manager.generateSpec(f.context('beta'), { caseId: journey.id, ...account }); await f.started(1);
  const file = join(f.dataDir, 'browser/state.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  const [owned] = Object.values(saved.externalOperations) as { workspace: string }[];
  const root = join(f.dataDir, 'browser/generations');
  await chmod(root, 0o500);
  try {
    f.workers[0].fail(new Error('The browser stopped.')); await f.settled('beta');
    assert.equal((await f.manager.view(f.context('beta'))).specs[journey.id].generation?.status, 'failed');
    await assert.rejects(f.manager.run(f.context('gamma'), {}, { manual: true }), /cleanup.*confirm|confirm.*cleanup/i);
    const held = JSON.parse(await readFile(file, 'utf8')).externalOperations;
    assert.equal(Object.values(held).length, 1);
    assert.equal((Object.values(held)[0] as { workspace: string }).workspace, owned.workspace);
  } finally { await chmod(root, 0o700); }
});
