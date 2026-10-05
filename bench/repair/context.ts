// A case's attempt context, built as the product builds a repair's: the snapshot materialized as one commit, its CI run
// once in a throwaway box to capture the real failure, that failure read through the product's getGitHubFailure, and
// the prompt from the product's describeFailures, chooseImage, repositoryDigest and attemptPrompt (attempt 1 of the
// product's four, no feedback), with INSTRUCTIONS as the system text. Every framework gets these bytes.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUDGET } from '../../src/repair/agent.ts';
import { INSTRUCTIONS, attemptPrompt, chooseImage, describeFailures, repositoryDigest, type FailedWorkflow } from '../../src/repair/context.ts';
import type { GitHubFailure } from '../../src/repair/github.ts';
import { createBenchBox } from './box.ts';
import { captureFailure, runSteps, workflowJob, type CiJob, type StepRun } from './ci.ts';
import { head, materialize, type Case } from './corpus.ts';
import { safeJson, safeText } from './safe.ts';

export const WORKFLOW = { id: '1', name: 'CI', path: '.github/workflows/ci.yml' };
export interface CaseContext {
  name: string; repository: string; sha: string; snapshot: string; image: string; job: CiJob; capture: StepRun[];
  failure: GitHubFailure; workflows: FailedWorkflow[]; digest: string; system: string; prompt: string; failing: string[];
}

/** The box image the failing workflow's setup action picks, before any failure is known. */
export async function imageFor(snapshot: string) {
  return chooseImage(snapshot, await describeFailures(snapshot, [WORKFLOW], []));
}

/** The context from a captured CI run; no Docker. */
export async function buildContext({ c, snapshot, sha, job, capture }: { c: Pick<Case, 'name' | 'meta'>; snapshot: string; sha: string; job: CiJob; capture: StepRun[] }): Promise<CaseContext> {
  const failure = await captureFailure({ repository: c.meta.repository, job, steps: job.steps, runs: capture });
  const workflows = await describeFailures(snapshot, [WORKFLOW], [failure]);
  const digest = await repositoryDigest(snapshot);
  const prompt = attemptPrompt({ repair: { repository: c.meta.repository, branch: 'main', sha }, workflows, digest, number: 1, total: BUDGET.attempts, feedback: '', changed: false });
  return {
    name: c.name, repository: c.meta.repository, sha, snapshot, image: await chooseImage(snapshot, workflows), job, capture, failure, workflows, digest,
    system: INSTRUCTIONS, prompt, failing: workflows.flatMap(workflow => workflow.step.run ? [workflow.step.run] : []),
  };
}

/** Why a capture is not the case's stated failure: CI must fail first at meta.failingStep, its log matching meta.expect.logRegex. */
export function captureProblems(c: Pick<Case, 'meta'>, capture: readonly StepRun[]) {
  const failed = capture.find(run => run.exit !== 0);
  if (!failed) return ['CI passed before any change.'];
  return [
    ...(failed.name === c.meta.failingStep ? [] : [`CI failed at ${failed.name}, not ${c.meta.failingStep}.`]),
    ...(new RegExp(c.meta.expect.logRegex).test(failed.output) ? [] : [`The failed log does not match ${c.meta.expect.logRegex}.`]),
  ];
}

/**
 * Materializes the case under directory/snapshot and captures its failure in a throwaway box, once: a saved capture
 * (directory/capture.json) is reused, so a resumed run prompts exactly as before. A strict capture, a run's, must be the
 * case's stated failure: one that is not, such as a registry timeout, is captured again once, then the case fails, and
 * such a capture is never saved or reused. Files written are redacted and scrubbed.
 */
export async function prepareCase(c: Case, { directory, root, signal, onScope, scrub = async text => text, strict = false }: {
  directory: string; root: string; signal?: AbortSignal; onScope?(scope: string): void | Promise<void>; scrub?(text: string): Promise<string>; strict?: boolean;
}): Promise<CaseContext> {
  const snapshot = join(directory, 'snapshot');
  await mkdir(directory, { recursive: true });
  const sha = await lstat(join(snapshot, '.git')).then(() => head(snapshot), () => materialize(c, snapshot));
  const job = workflowJob(await readFile(join(snapshot, WORKFLOW.path), 'utf8'));
  const saved = await readFile(join(directory, 'capture.json'), 'utf8').then(text => JSON.parse(text) as unknown, () => null);
  let capture = Array.isArray(saved) && (!strict || !captureProblems(c, saved as StepRun[]).length) ? saved as StepRun[] : null;
  for (let tries = 0; !capture; tries += 1) {
    const box = await createBenchBox({ image: await imageFor(snapshot), source: snapshot, root, signal, onScope });
    let runs: StepRun[];
    try { runs = await runSteps(box, job.steps, { signal }); } finally { await box.remove(); }
    const problems = strict ? captureProblems(c, runs) : [];
    if (problems.length && tries) throw new Error(`The captured failure is not the case's: ${problems.join(' ')}`);
    if (problems.length) continue;
    capture = runs;
    await writeFile(join(directory, 'capture.json'), await safeJson(capture, scrub, 2));
  }
  const context = await buildContext({ c, snapshot, sha, job, capture });
  await writeFile(join(directory, 'failure.json'), await safeJson(context.failure, scrub, 2));
  await writeFile(join(directory, 'prompt.md'), await safeText(`# System\n\n${context.system}\n\n# Prompt\n\n${context.prompt}\n`, scrub));
  return context;
}
