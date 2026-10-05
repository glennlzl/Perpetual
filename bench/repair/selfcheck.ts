// The corpus self-check, in real boxes: every case fails before any change at its stated step with its stated log, the
// product's getGitHubFailure diagnoses it as stated and triage sends it to repair, the judge passes its reference patch,
// and fails each decoy for its stated reason.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { triage } from '../../src/repair/triage.ts';
import { captureProblems, prepareCase } from './context.ts';
import type { Case, DecoyFailure } from './corpus.ts';
import { judge, type JudgeReason } from './judge.ts';
import { pool } from './schedule.ts';

export interface CaseCheck {
  case: string; ok: boolean; problems: string[]; failedAt: string | null; diagnosis: string; triage: string;
  reference: { reason: JudgeReason; detail: string; ms: number }; decoys: { patch: string; expected: DecoyFailure; reason: JudgeReason; detail: string }[];
}

export async function checkCase(c: Case, { directory, root, onScope }: { directory: string; root: string; onScope?(scope: string): void | Promise<void> }): Promise<CaseCheck> {
  const problems: string[] = [];
  const context = await prepareCase(c, { directory: join(directory, c.name), root, onScope });
  const failed = context.capture.find(run => run.exit !== 0) ?? null;
  problems.push(...captureProblems(c, context.capture));
  if (context.failure.diagnosis.category !== c.meta.expect.diagnosis) problems.push(`Diagnosed ${context.failure.diagnosis.category}, not ${c.meta.expect.diagnosis}.`);
  const next = triage([context.failure], false).next;
  if (next !== 'repair') problems.push(`Triage sends it to ${next}.`);
  const judged = (patch: string) => readFile(patch).then(diff => judge({ c, snapshot: context.snapshot, sha: context.sha, diff, image: context.image, steps: context.job.steps, root, onScope }));
  const reference = await judged(c.reference);
  if (!reference.passed) problems.push(`The reference patch fails: ${reference.reason} ${reference.detail}`);
  const decoys: CaseCheck['decoys'] = [];
  for (const decoy of c.meta.decoys) {
    const result = await judged(join(c.dir, decoy.patch));
    decoys.push({ patch: decoy.patch, expected: decoy.fails, reason: result.reason, detail: result.detail });
    if (result.reason !== decoy.fails) problems.push(`${decoy.patch} fails with ${result.reason}, not ${decoy.fails}: ${result.detail}`);
  }
  return { case: c.name, ok: !problems.length, problems, failedAt: failed?.name ?? null, diagnosis: context.failure.diagnosis.category, triage: next,
    reference: { reason: reference.reason, detail: reference.detail, ms: reference.ms }, decoys };
}

/** Checks every case, concurrency at a time. */
export async function checkCorpus(cases: readonly Case[], { directory, root, concurrency = 3, onScope, log = () => {} }: { directory: string; root: string; concurrency?: number; onScope?(scope: string): void | Promise<void>; log?(check: CaseCheck): void }) {
  const checks: CaseCheck[] = [];
  await pool(cases, concurrency, async c => {
    const check = await checkCase(c, { directory, root, onScope }).catch((error: Error): CaseCheck => ({ case: c.name, ok: false, problems: [error.message], failedAt: null, diagnosis: '', triage: '', reference: { reason: 'ci', detail: '', ms: 0 }, decoys: [] }));
    checks.push(check);
    log(check);
  });
  return checks.sort((a, b) => a.case.localeCompare(b.case));
}
