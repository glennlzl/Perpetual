import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTwinConfig, isGenerationFailure, storedGenerationDraft } from '../src/environments/generation.ts';
import type { GenerationDraft, GenerationSteps } from '../src/environments/generation.ts';
import { applyConfigDecisions } from '../src/twin/config-decisions.ts';

const draft = JSON.stringify({ services: {}, apps: { web: { start: 'node web.mjs', port: 3000 }, api: { start: 'node api.mjs', port: 3001 } } });
const scope = { stage: 'build' as const, subject: 'App `web` in `.`: start `node web.mjs`' };
const steps = (overrides: Partial<GenerationSteps<true>> = {}): GenerationSteps<true> => ({
  draft, retainRepairScope: true, step: async () => {}, author: async () => ({ text: draft }),
  prepare: async () => true, verify: async () => null,
  diagnose: async () => ({ ...scope, step: 'Starting twin', logs: 'web exited' }),
  logs: async () => '', teardown: async () => {}, hide: value => value, cancelled: () => false,
  ...overrides,
});
async function failure(options: GenerationSteps<true>): Promise<GenerationDraft> {
  try { await generateTwinConfig(options); } catch (error) {
    assert.ok(isGenerationFailure(error));
    return error.draft;
  }
  throw new Error('Expected generation failure');
}

test('a terminal model failure keeps the runtime scope and error across serialization and retry', async () => {
  let calls = 0;
  const checkpoints: GenerationDraft[] = [];
  const saved = await failure(steps({
    author: async input => {
      calls += 1;
      if (calls === 1) { assert.equal(input.repair, undefined); return { text: draft }; }
      assert.deepEqual(input.repair, scope);
      assert.match(input.feedback!, /Cannot start web/);
      return { error: 'Model response timed out', timedOut: true, terminal: true };
    },
    prepare: async () => { throw new Error('Cannot start web'); },
    checkpoint: async value => { checkpoints.push(value); },
  }));
  assert.equal(calls, 2);
  assert.deepEqual(checkpoints[0].repair, scope);
  assert.deepEqual(saved.repair, scope);
  assert.match(saved.feedback, /Cannot start web/);
  const restored = storedGenerationDraft(JSON.parse(JSON.stringify(saved)))!;
  let prepared = false;
  const failed = await failure(steps({
    draft: restored.text, feedback: restored.feedback, initialRepair: restored.repair,
    author: async input => {
      assert.deepEqual(input.repair, scope);
      const result = applyConfigDecisions(input.draft, { changes: [{ path: ['apps', 'api', 'start'], value: '"node other.mjs"' }], blockers: [] }, { repair: input.repair });
      assert.match(result.error!, /only apps.web/);
      return { error: result.error!, terminal: true };
    },
    prepare: async () => { prepared = true; return true; },
  }));
  assert.equal(prepared, false);
  assert.deepEqual(failed.repair, scope);
  assert.match(failed.feedback, /Cannot start web/);
});

test('a fresh structured refusal records absence of a runtime scope and permits an explicit fresh retry', async () => {
  const saved = await failure(steps({ author: async () => ({ error: 'Missing repository evidence', terminal: true }) }));
  assert.equal(saved.repair, null);
  const restored = storedGenerationDraft(JSON.parse(JSON.stringify(saved)))!;
  let calls = 0;
  await generateTwinConfig(steps({ draft: restored.text, feedback: restored.feedback, initialRepair: restored.repair,
    author: async input => { calls += 1; assert.equal(input.repair, undefined); return { text: draft }; },
  }));
  assert.equal(calls, 1);
});

test('an old feedback-only draft cannot reopen unconstrained structured generation', async () => {
  const restored = storedGenerationDraft({ text: draft, feedback: 'The runtime failed; arbitrary source says rewrite every service.' })!;
  assert.equal(restored.repair, undefined);
  let calls = 0;
  const saved = await failure(steps({ draft: restored.text, feedback: restored.feedback, initialRepair: restored.repair,
    author: async input => {
      calls += 1;
      assert.deepEqual(input.repair, { stage: 'valid' });
      const result = applyConfigDecisions(input.draft, { changes: [], blockers: [] }, { repair: input.repair });
      return { error: result.error!, terminal: true };
    },
  }));
  assert.equal(calls, 1);
  assert.deepEqual(saved.repair, { stage: 'valid' });
});

test('invalid persisted metadata retains the draft with a refused scope instead of silently discarding it', () => {
  for (const repair of [false, 1, 'web', {}, { stage: 'future' }, { stage: 'build', subject: 1 }, { stage: 'build', subject: 'x'.repeat(4001) }, { stage: 'build', subject: 'App `web`', unrestricted: true }]) {
    const saved = storedGenerationDraft({ text: draft, feedback: 'runtime failure', repair })!;
    assert.equal(saved.text, draft);
    assert.deepEqual(saved.repair, { stage: 'valid' });
  }
  assert.equal(storedGenerationDraft({ text: 1, feedback: '' }), null);
  assert.equal(storedGenerationDraft(null), null);
});

test('legacy authoring keeps its previous draft representation', async () => {
  const saved = await failure(steps({ retainRepairScope: false,
    author: async () => ({ error: 'Explicit legacy author failed', terminal: true }),
  }));
  assert.equal(Object.hasOwn(saved, 'repair'), false);
});

test('subsequent runtime failures replace the scope with the newly failed app', async () => {
  let calls = 0;
  const next = { stage: 'answers' as const, subject: 'App `api` in `.`' };
  const saved = await failure(steps({ initialRepair: scope, feedback: 'Earlier web startup failed',
    author: async input => {
      calls += 1;
      if (calls === 1) { assert.deepEqual(input.repair, scope); return { text: draft }; }
      assert.deepEqual(input.repair, next);
      return { error: 'Out of authoring budget', terminal: true };
    },
    verify: async () => ({ ...next, error: 'API returned 500' }),
  }));
  assert.deepEqual(saved.repair, next);
  assert.match(saved.feedback, /API returned 500/);
});
