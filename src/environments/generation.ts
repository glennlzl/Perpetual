// A detected stage's twin config, written by an agent and verified by building the twin (docs/twins.md, "Generated
// twin config"). The controller owns the loop: at most four attempts, each authored (../twin/authoring.ts), validated,
// then prepared as the environment's real twin, which counts only when it is ready, every app answers on its address and,
// when a service can, a test account exists. Why an attempt failed is the next attempt's feedback, staged and redacted:
// the stage it failed at, the app or service and its command, the error, the unwired variables of the config the next
// attempt starts from and the failed containers' logs; an attempt that ran out of time is one of them. A person sees a
// short error; the author's output goes to the logs.
import { CONFIG } from '../twin/authoring.ts';
import { serviceOptionErrors, validateTwinConfig } from '../twin/config.ts';
import { services as registry } from '../twin/registry.ts';
import type { Authored } from '../twin/authoring.ts';
import type { TwinConfig } from '../twin/config.ts';
import type { TwinServices } from '../twin/registry.ts';
import type { EnvironmentAttempt } from '../../contract/environment.ts';

export const ATTEMPTS = 4;
/** The folder under an environment's directory that holds its generation's agent workspaces while it runs. */
export const AUTHORING = 'authoring';
export const writingStep = (attempt: number) => `Writing twin config (attempt ${attempt} of ${ATTEMPTS})`;
/** Log lines of a failed preparation kept in its feedback. */
export const LOG_LINES = 150;
const ERROR_TEXT = 4000, LOG_TEXT = 16000, LINE_TEXT = 300;

/** Where a saved plan came from, when an agent wrote it. */
export interface PlanProvenance { generatedAt: string; harness: string; model: string; attempts: number }
/**
 * A stage's draft: the last twin.json and why it failed, which the next generation starts from. Generation leaves one
 * when it fails, and so does a generated config that fails to build later.
 */
export interface GenerationDraft { text: string; feedback: string }
/**
 * Where a config failed: it was refused before anything ran (valid), preparing its twin failed (build), a container did
 * not become healthy (healthy), an app did not answer on its address (answers), or no test account exists (account).
 */
export type Stage = 'valid' | 'build' | 'healthy' | 'answers' | 'account';
/**
 * Why a config failed: its stage, a heading, the app or service it names with its command, the error, the reason a
 * person sees when it differs, and the failed containers' logs.
 */
export interface StagedFailure { stage: Stage; heading: string; subject?: string; error: string; reason?: string; logs?: string }
/** A failed attempt as a person sees it: where it failed and one redacted line on why. */
export type AttemptOutcome = EnvironmentAttempt;
/** Generation that failed: the environment fails with its message and keeps `logs`, and the stage keeps the draft. */
export type GenerationFailure = Error & { draft: GenerationDraft; logs?: string };
export const isGenerationFailure = (error: unknown): error is GenerationFailure => error instanceof Error && 'draft' in error;

/** The config twin.json holds, or why it is refused: not JSON, not a twin config, a service's options, or no app. */
export function checkWritten(text: string, services: TwinServices = registry): { config: TwinConfig; error?: undefined } | { error: string; config?: undefined } {
  let value: unknown, config: TwinConfig;
  try { value = JSON.parse(text); } catch (error) { return { error: `${CONFIG} is not valid JSON: ${(error as Error).message}` }; }
  try { config = validateTwinConfig(value, { services }); } catch (error) { return { error: (error as Error).message }; }
  const errors = serviceOptionErrors(config, { services });
  if (!Object.keys(config.apps).length) errors.push('Add an app: the repository code the twin runs.');
  return errors.length ? { error: errors.join('\n') } : { config };
}

const clip = (text: string, limit: number, keep: 'start' | 'end') => text.length <= limit ? text : keep === 'start' ? `${text.slice(0, limit)}…` : `…${text.slice(-limit)}`;
const firstLine = (text: string) => clip(text.trim().split('\n')[0].trim(), LINE_TEXT, 'start');
/**
 * Build and health output usually starts with progress. Keep its terminal line beside the failed step, so the
 * person sees the cause as well as where it happened. Redact the complete error before selecting or clipping lines.
 */
const summary = (failure: StagedFailure, hide: (text: string) => string) => {
  if (failure.reason) return hide(failure.reason);
  const error = hide(failure.error).trim();
  return failure.subject && (failure.stage === 'build' || failure.stage === 'healthy')
    ? `${clip(hide(`${failure.heading}: ${failure.subject}`), 158, 'start')}; ${clip(error.split('\n').at(-1)?.trim() || 'See logs.', 138, 'start')}`
    : error;
};
/**
 * feedback.md: the failure's stage, the app or service it names and its command, its error, each app's unwired
 * variables in the config the next attempt starts from, then the failed containers' last lines. Every part is redacted
 * by `hide`.
 */
export function feedbackText({ title, failure, unwired = [], hide }: { title: string; failure: StagedFailure; unwired?: string[]; hide: (text: string) => string }) {
  const lines = [`# ${title}: ${failure.heading}`, '', `- Stage: \`${failure.stage}\``, ...(failure.subject ? [`- ${failure.subject}`] : []),
    '', '## Error', '', clip(hide(failure.error).trim(), ERROR_TEXT, 'start')];
  if (unwired.length) lines.push('', '## Unwired variables', '', ...unwired);
  const tail = failure.logs && clip(hide(failure.logs).trim(), LOG_TEXT, 'end');
  if (tail) lines.push('', '## Logs', '', `The last lines of the failed containers' logs, at most ${LOG_LINES}:`, '', '```', tail, '```');
  return `${hide(lines.join('\n'))}\n`;
}
export const attemptTitle = (attempt: number) => `Attempt ${attempt} of ${ATTEMPTS}`;
/** Why a failed preparation stopped where it did: its stage, step, the app or service it names, and the logs. */
export type Diagnosis = { stage: Stage; step: string; subject?: string; logs: string };

export interface GenerationSteps<Result> {
  draft: string; feedback?: string | null; services?: TwinServices;
  /** Reports a step of the environment. */
  step(step: string): Promise<void>;
  /**
   * Runs the agent once: what it wrote, or why the attempt is refused. Rejects when it cannot run, and when cancelled,
   * with the end of its output in the error's `logs`.
   */
  author(input: { draft: string; feedback: string | null; attempt: number }): Promise<Authored>;
  /** Prepares the twin from a valid config, reporting its steps; rejects with its failure. */
  prepare(config: TwinConfig): Promise<Result>;
  /** Why a prepared twin does not count as ready, with the app that did not answer, or null when it does. */
  verify(config: TwinConfig, result: Result): Promise<(Pick<StagedFailure, 'stage' | 'subject' | 'error'> & { app?: string }) | null>;
  /** Where a failed preparation of `config` stopped, and the end of the failed containers' logs. */
  diagnose(config: TwinConfig, error: unknown): Promise<Diagnosis>;
  /** The end of the prepared twin's relevant logs: the app's that did not answer, when one did not. */
  logs(app?: string): Promise<string>;
  /** Each app's unwired variables in a twin.json, as feedback lines. */
  unwired?(text: string): string[];
  /** Records a failed attempt's outcome before the next attempt starts. */
  failed?(outcome: AttemptOutcome): Promise<void>;
  /** Keeps a completed author's config and failure as a draft before another paid attempt starts. */
  checkpoint?(draft: GenerationDraft): Promise<void>;
  /** Tears the failed twin down before the next attempt. */
  teardown(config: TwinConfig): Promise<void>;
  /** Redacts the secrets the controller knows: the model key and the twin's secret inputs. */
  hide(text: string): string;
  cancelled(): boolean;
}

/**
 * Runs the loop until an attempt's twin counts as ready: resolves its config, the prepared result and how many attempts
 * it took. After the last failed attempt it rejects with a GenerationFailure, and the last twin is left for the caller's
 * usual failure cleanup. A cancellation, or an agent that cannot run, ends the loop at once; running out of time does
 * not. Its log, in `logs` of the result and of each rejection, holds every attempt's output and each failed attempt's
 * feedback, all redacted.
 */
export async function generateTwinConfig<Result>({ draft, feedback = null, services = registry, step, author, prepare, verify, diagnose, logs, unwired = () => [], failed = async () => {}, checkpoint = async () => {}, teardown, hide, cancelled }: GenerationSteps<Result>) {
  let text = draft, notes = feedback;
  const output: string[] = [];
  const record = (attempt: number, what: string, tail: unknown) => { if (typeof tail === 'string' && tail.trim()) output.push(`${writingStep(attempt)}: ${hide(what)}\n${hide(tail).trim()}`); };
  const withLogs = <Failure extends Error>(error: Failure) => output.length ? Object.assign(error, { logs: output.join('\n\n') }) : error;
  for (let attempt = 1; ; attempt += 1) {
    await step(writingStep(attempt));
    let written: Authored;
    try { written = await author({ draft: text, feedback: notes, attempt }); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      record(attempt, error.message, 'logs' in error ? error.logs : null);
      throw withLogs(error);
    }
    if (written.logs) record(attempt, written.timedOut ? 'Ran out of time.' : 'The author’s output.', written.logs);
    let failure: StagedFailure, built: TwinConfig | undefined;
    if (written.error !== undefined) failure = { stage: 'valid', heading: written.timedOut ? 'ran out of time' : 'refused', error: written.error, reason: written.reason };
    else {
      text = written.text;
      const checked = checkWritten(text, services);
      if (checked.error !== undefined) failure = { stage: 'valid', heading: `${CONFIG} is not a valid twin config`, error: checked.error };
      else {
        built = checked.config;
        try {
          const result = await prepare(built);
          const problem = await verify(built, result);
          if (problem === null) return { config: built, result, attempts: attempt, logs: output.join('\n\n') };
          // A Stop or shutdown aborts the check itself: the config did not fail.
          if (cancelled()) throw withLogs(new Error('Environment creation cancelled.'));
          const { app, ...found } = problem;
          failure = { ...found, heading: 'the twin started, but does not count as ready', logs: await logs(app) };
        } catch (error) {
          if (cancelled() || error instanceof Error && 'cleanupIncomplete' in error && error.cleanupIncomplete === true) throw error instanceof Error ? withLogs(error) : error;
          const { step: at, ...found } = await diagnose(built, error);
          failure = { ...found, heading: `preparing the twin failed at "${at}"`, error: String((error as Error).message ?? error) };
        }
      }
    }
    // The unwired variables of the config the next attempt starts from.
    notes = feedbackText({ title: attemptTitle(attempt), failure, unwired: unwired(text), hide });
    if (written.error === undefined) await checkpoint({ text, feedback: notes });
    const said = firstLine(summary(failure, hide));
    await failed({ attempt, stage: failure.stage, summary: said });
    record(attempt, `Failed at ${failure.stage}.`, notes);
    if (attempt === ATTEMPTS) throw withLogs(Object.assign(new Error(`Writing the twin config failed after ${ATTEMPTS} attempts: ${said}`), { draft: { text, feedback: notes } }));
    if (built) await teardown(built);
  }
}
