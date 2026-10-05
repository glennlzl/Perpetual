// The attempt context without Docker: from a captured run, the prompt is the product's attemptPrompt for attempt 1 of
// the product's four, byte for byte, with INSTRUCTIONS as the system text and the failing step's command for reproduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUDGET } from '../../../src/repair/agent.ts';
import { INSTRUCTIONS, attemptPrompt, describeFailures, repositoryDigest } from '../../../src/repair/context.ts';
import { captureFailure, workflowJob } from '../ci.ts';
import { WORKFLOW, buildContext, captureProblems, imageFor } from '../context.ts';
import { loadCases, materialize } from '../corpus.ts';

test('every framework gets the product\'s prompt and instructions for the case', async t => {
  const [c] = await loadCases(['ts-refactor-rename']);
  const snapshot = await mkdtemp(join(tmpdir(), 'bench-context-'));
  t.after(() => rm(snapshot, { recursive: true, force: true }));
  const sha = await materialize(c, snapshot), job = workflowJob(await readFile(join(snapshot, WORKFLOW.path), 'utf8'));
  const capture = [{ name: 'Run npm ci', exit: 0, ms: 1, timedOut: false, output: 'added 1 package\n' }, { name: 'Build', exit: 2, ms: 1, timedOut: false, output: "src/format.ts(6,24): error TS2339: Property 'name' does not exist on type 'User'.\n" }];
  const context = await buildContext({ c, snapshot, sha, job, capture });
  const failure = await captureFailure({ repository: 'acme/directory', job, steps: job.steps, runs: capture });
  const expected = attemptPrompt({ repair: { repository: 'acme/directory', branch: 'main', sha }, workflows: await describeFailures(snapshot, [WORKFLOW], [failure]), digest: await repositoryDigest(snapshot), number: 1, total: BUDGET.attempts, feedback: '', changed: false });
  assert.equal(context.prompt, expected);
  assert.ok(context.prompt.startsWith(`Repository acme/directory, branch main, failing commit ${sha}. Attempt 1 of 4.`));
  assert.match(context.prompt, /Failed step: Build\./);
  assert.ok(!context.prompt.includes(c.meta.class) && !context.prompt.includes(c.name), 'Nothing of meta.json reaches the prompt.');
  assert.equal(context.system, INSTRUCTIONS);
  assert.deepEqual(context.failing, ['npm run build']);
  assert.deepEqual([context.image, await imageFor(snapshot), context.failure.diagnosis.category], ['node:22-bookworm', 'node:22-bookworm', 'build']);
});

// A registry timeout while the capture installs, or a CI that passes, is not the case's failure, and would prompt every
// framework's paid attempt with the wrong one.
test('a capture is the case\'s stated failure only at its failing step, with its expected log', async () => {
  const [c] = await loadCases(['ts-refactor-rename']);
  const step = (name: string, exit: number, output = '') => ({ name, exit, ms: 1, timedOut: false, output });
  const build = step('Build', 2, "src/format.ts(6,24): error TS2339: Property 'name' does not exist on type 'User'.\n");
  assert.deepEqual([c.meta.failingStep, new RegExp(c.meta.expect.logRegex).test(build.output)], ['Build', true], 'The fixture capture is the case\'s.');
  assert.deepEqual(captureProblems(c, [step('Run npm ci', 0), build]), []);
  assert.deepEqual(captureProblems(c, [step('Run npm ci', 1, 'npm ERR! network request to https://registry.npmjs.org/typescript failed, reason: ETIMEDOUT\n')]), [`CI failed at Run npm ci, not Build.`, `The failed log does not match ${c.meta.expect.logRegex}.`]);
  assert.deepEqual(captureProblems(c, [step('Run npm ci', 0), step('Build', 0)]), ['CI passed before any change.']);
});
