import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentRuntime } from '../src/environments/runtime.ts';
import { AUTHOR_HARNESSES, type Authored } from '../src/twin/authoring.ts';
import type { EnvironmentRecord } from '../src/environments/manager.ts';

test('Stop during structured generation preserves the completed draft and records no failed config attempt', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-config-stop-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: '@acme/app', scripts: { start: 'node app.js' } }));
  await writeFile(join(repoPath, 'app.js'), 'export const port = 3000;\n');
  const plan = { services: {}, apps: { web: { directory: '.', start: 'node app.js', port: 3000 } } };
  const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<Authored>();
  const stopped = new AbortController();
  const updates: Partial<EnvironmentRecord>[] = [];
  let builds = 0, checkpoints = 0;
  const runtime = createEnvironmentRuntime({
    authorHarness: AUTHOR_HARNESSES.structured, inputs: async () => ({}),
    author: () => {
      started.resolve();
      return { promise: pending.promise, cancel: () => pending.resolve({ error: 'Writing the twin config was cancelled.', terminal: true }) };
    },
    twin: {
      prepare: async () => { builds++; return { services: [], apps: [] }; },
      health: async () => ({ status: 'ready', containers: [] }), logs: async () => '', destroy: async () => {},
    },
  });
  const execution = runtime.prepareEnvironment({ dataDir: root, repoPath, directory: join(root, 'environment'), environment: { id: 'fixture', plan },
    cancelled: () => stopped.signal.aborted, signal: stopped.signal,
    onUpdate: async update => { updates.push(update); }, onDraft: async () => { checkpoints++; },
    generate: { draft: JSON.stringify(plan), model: { apiKey: 'fixture-model-key', model: 'fixture/model' } },
  });
  const rejection = assert.rejects(execution, error => error instanceof Error && error.message === 'Environment creation cancelled.' && !('draft' in error));
  await started.promise;
  stopped.abort();
  await rejection;
  assert.equal(builds, 0);
  assert.equal(checkpoints, 0);
  assert.ok(!updates.some(update => update.attempts?.length));
  assert.ok(updates.some(update => update.configTimings?.some(timing => timing.phase === 'evidence')));
});
