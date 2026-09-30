// The repair agent behind the manager's agent step (docs/repair.md). It clones the failing commit from the managed
// source copy, copies it into a repair box, and runs up to four attempts of an AI SDK tool loop on the host whose tools
// act only inside the box: two with the Settings model, then two with the escalation model, under a cost cap summed
// from OpenRouter's reported usage. A finished attempt's diff meets the change rules, is committed on the host copy as
// the connected account, pushed to perpetual/repair/<short sha> and opened as a draft pull request labelled
// perpetual-repair; its CI decides: all runs passing readies the pull request and hands it to the merge step (the
// journey gates at its head, then the merge) even when GitHub refuses to ready it, a failure becomes the next attempt's
// input. An attempt reproduced the failure only when a failing step's own command failed before it changed a file. The
// OpenRouter key reaches only the model provider, never the box, a command, a log or a report.
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { APICallError, RetryError, generateText, hasToolCall, stepCountIs, type LanguageModel, type StepResult, type ToolSet } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { openrouterRefusal } from '../agents/opencode.ts';
import { redact } from '../redaction.ts';
import type { WorkflowRun } from '../github-runs.ts';
import type { RepairBox, RepairBoxes } from './box.ts';
import { checkChanges, pathRules, type ChangeCheck } from './changes.ts';
import type { RepairHost } from './clone.ts';
import { INSTRUCTIONS, attemptPrompt, chooseImage, commitMessage, describeFailures, pullRequestBody, pullRequestTitle, repositoryDigest, type FailedWorkflow } from './context.ts';
import { repairBranch, type GitHubFailure, type PullRequestRead, type RepairPullRequests } from './github.ts';
import type { Repair, RepairAttempt, RepairContext, RepairOutcome, RepairPullRequest } from './manager.ts';
import { UNREADY, type CiVerdict, type RepairMerge } from './merge.ts';
import { repairTools } from './tools.ts';
import { failedRun, passedRun } from './triage.ts';
import { reproduces } from './workflow.ts';

/** Attempts, the attempt after which the escalation model takes over, steps and time per attempt, and dollars per repair. */
export const BUDGET = { attempts: 4, escalateAfter: 2, steps: 100, attemptMs: 15 * 60_000, cost: 2 };
/**
 * How often the pull request's runs are read, how long without any run means none will come, the longest wait, and how
 * long GitHub may stay unreadable before the wait ends.
 */
export const CI = { pollMs: 30_000, noRunMs: 10 * 60_000, waitMs: 6 * 60 * 60_000, outageMs: 15 * 60_000 };
export const LABEL = 'perpetual-repair';
export const NO_CI = 'No workflow ran for the pull request.';
const DISCONNECTED = 'Connect GitHub to repair builds.', CHANGED = 'The GitHub connection changed. Start the repair again.';
// A conversation that outgrew the model's context window, which OpenRouter answers with HTTP 400 like a request the
// model rejects; the next attempt starts afresh.
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;
// OpenRouter routes the request only to providers that do not collect data, and reports its usage and cost. The
// provider (3.1.0) spreads providerOptions.openrouter into the request body as `provider` and `usage`.
export const OPENROUTER_OPTIONS = { provider: { data_collection: 'deny' }, usage: { include: true } } as const;

export type ModelFactory = (id: string, apiKey: string) => LanguageModel;
/** The App Settings model and escalation model with the stored OpenRouter key; null without one. */
export interface RepairModels { apiKey: string; model: string; escalationModel: string }
export interface RepairAgentGitHub {
  /** The connected, verified account; every write checks it is still the one that saw the failure. */
  connection(): Promise<{ login: string; repository: string } | null>;
  runs(input: { repository: string; sha: string; login: string }): Promise<{ runs: WorkflowRun[] }>;
  failure(input: { repository: string; runId: string }): Promise<GitHubFailure>;
  pullRequests: Pick<RepairPullRequests, 'account' | 'find' | 'create' | 'update' | 'ready' | 'label' | 'comment' | 'state' | 'close'>;
}
export interface RepairAgentOptions {
  models(): Promise<RepairModels | null>;
  boxes: RepairBoxes;
  host: RepairHost;
  github: RepairAgentGitHub;
  model?: ModelFactory;
  /** Deploy configuration files the scan found for the repair's source, relative to the repository. */
  deployFiles?(repair: Repair): readonly string[];
  budget?: Partial<typeof BUDGET>;
  ci?: Partial<typeof CI>;
  /** The merge step once CI passed; without it a repair whose pull request passed CI ends ready. */
  merge?: Pick<RepairMerge, 'merge'>;
  now?: () => string;
  clock?: () => number;
}
export interface AttemptResult {
  end: 'done' | 'steps' | 'time' | 'cost' | 'idle' | 'context' | 'provider';
  summary: string; steps: number; inputTokens: number; outputTokens: number; cost: number; reproduced: boolean; error?: string; refusal?: string;
  /** The model stopped without calling done after changing files, and the failing steps' own commands then passed in the box. */
  verified?: true;
}
/** A failing step's run script and working directory, relative to the workspace. */
export interface FailingCheck { run: string; directory?: string | null }
const VERIFIED = 'The model stopped without calling done; the failing step\'s own command then passed in the box.';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A change the box or the host copy refused, such as one too large; the attempt fails with its message. */
const rejected = (error: unknown) => isRecord(error) && error.rejected === true;
const dollars = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
/**
 * The dollars OpenRouter reported for a step. A bring-your-own-key request's cost is only OpenRouter's fee; the
 * provider's own charge is reported beside it as the upstream inference cost.
 */
const stepCost = (step: Pick<StepResult<ToolSet>, 'providerMetadata'>) => {
  const openrouter = step.providerMetadata?.openrouter, usage = isRecord(openrouter) && isRecord(openrouter.usage) ? openrouter.usage : {};
  return dollars(usage.cost) + dollars(isRecord(usage.costDetails) ? usage.costDetails.upstreamInferenceCost : undefined);
};
const spentBy = (steps: readonly Pick<StepResult<ToolSet>, 'providerMetadata'>[]) => steps.reduce((total, step) => total + stepCost(step), 0);
/** The provider's error as OpenCode prints one, so OpenRouter refusals map to the same actions. */
function providerMessage(error: unknown) {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) return cause.statusCode === undefined ? cause.message : JSON.stringify({ code: cause.statusCode, message: cause.message });
  return error instanceof Error ? error.message : String(error);
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

/** OpenRouter models with usage accounting and data collection denied; tests pass a fetch that records the request. */
export const openrouterModels = ({ fetch }: { fetch?: typeof globalThis.fetch } = {}): ModelFactory => (id, apiKey) =>
  createOpenRouter({ apiKey, ...(fetch ? { fetch } : {}) })(id, { ...OPENROUTER_OPTIONS, provider: { ...OPENROUTER_OPTIONS.provider } });

/**
 * One attempt of the tool loop in a box: it ends when the model calls done, at the step limit, the time limit or the
 * repair's remaining budget, when the model stops calling tools, or when its conversation outgrows the model's context
 * window. A stopped repair, or a box removed for writing too much, rejects; any other provider error returns with the
 * OpenRouter refusal it maps to, if any. `failing` holds the failing steps' run scripts: the attempt reproduced the
 * failure when it ran one of their commands and saw it fail before changing a file. A model that stops calling tools
 * after changing files without calling done still ends done when every failing step (`checks`, by default `failing` in
 * the workspace) then passes in the box: weaker models often finish with a message instead of the done call.
 */
export async function runAttempt({ model, box, instructions = INSTRUCTIONS, prompt, signal, failing = [], checks = failing.map(run => ({ run })), steps: limit = BUDGET.steps, timeoutMs = BUDGET.attemptMs, budget = BUDGET.cost }: {
  model: LanguageModel; box: RepairBox; instructions?: string; prompt: string; signal: AbortSignal; failing?: readonly string[]; checks?: readonly FailingCheck[]; steps?: number; timeoutMs?: number; budget?: number;
}): Promise<AttemptResult> {
  const timeout = AbortSignal.timeout(timeoutMs), stop = AbortSignal.any([signal, timeout, ...(box.signal ? [box.signal] : [])]), seen: StepResult<ToolSet>[] = [];
  let changed = false, reproduced = false;
  const tools = repairTools(box, { signal: stop, events: { run(command, exitCode) { if (!changed && exitCode !== 0 && reproduces(command, failing)) reproduced = true; }, change() { changed = true; } } });
  const result = (end: AttemptResult['end'], extra: Partial<AttemptResult> = {}): AttemptResult => {
    const done = seen.flatMap(step => step.toolCalls).find(call => call.toolName === 'done');
    const summary = done && isRecord(done.input) && typeof done.input.summary === 'string' ? redact(done.input.summary).slice(0, 4000) : '';
    return { end, summary, steps: seen.length, inputTokens: seen.reduce((total, step) => total + (step.usage.inputTokens ?? 0), 0),
      outputTokens: seen.reduce((total, step) => total + (step.usage.outputTokens ?? 0), 0), cost: spentBy(seen), reproduced, ...extra };
  };
  try {
    await generateText({
      model, tools, instructions, prompt, abortSignal: stop, providerOptions: { openrouter: OPENROUTER_OPTIONS },
      stopWhen: [stepCountIs(limit), hasToolCall('done'), ({ steps }) => spentBy(steps) >= budget],
      onStepEnd(step) { seen.push(step); },
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (box.signal?.aborted) throw box.signal.reason;
    if (timeout.aborted) return result('time');
    const message = redact(providerMessage(error)).slice(0, 1000);
    if (CONTEXT.test(message)) return result('context', { error: message });
    return result('provider', { error: message, refusal: openrouterRefusal(`Error: ${message}`) });
  }
  if (box.signal?.aborted) throw box.signal.reason;
  const end = seen.some(step => step.toolCalls.some(call => call.toolName === 'done')) ? 'done' : spentBy(seen) >= budget ? 'cost' : seen.length >= limit ? 'steps' : 'idle';
  if (end === 'idle' && changed && checks.length && await passes(box, checks, stop)) return result('done', { summary: VERIFIED, verified: true });
  if (box.signal?.aborted) throw box.signal.reason;
  return result(end);
}
// Each failing step's script as the runner runs it (bash -e, pipefail) in its working directory; a failure, a timeout or
// an abort, including the attempt's own time limit, is not a pass.
async function passes(box: RepairBox, checks: readonly FailingCheck[], signal: AbortSignal) {
  for (const { run, directory } of checks) {
    const outcome = await box.exec(['bash', '-c', 'set -eo pipefail; cd -- "$1" && eval "$2"', 'bash', directory || '.', run], { signal, timeoutMs: 15 * 60_000, limit: 4096, keep: 'tail' }).catch(() => null);
    if (!outcome || outcome.exitCode !== 0 || outcome.timedOut) return false;
  }
  return true;
}

/** The agent step and its companions for createRepairManager: repair(context, signal), cleanup({ repair, directory }), state(repair), close(repair) and recover(). */
export function createRepairAgent(options: RepairAgentOptions) {
  const budget = { ...BUDGET, ...options.budget }, ci = { ...CI, ...options.ci };
  const now = options.now ?? (() => new Date().toISOString()), clock = options.clock ?? Date.now, model = options.model ?? openrouterModels();
  const { boxes, host, github } = options, pulls = github.pullRequests;
  const capped = `The repair reached its $${budget.cost.toFixed(2)} cost cap.`;
  const ended: Record<Exclude<AttemptResult['end'], 'done'>, (result: AttemptResult) => string> = {
    steps: () => `The attempt reached its ${budget.steps}-step limit without calling done.`,
    time: () => `The attempt reached its ${Math.round(budget.attemptMs / 60_000)}-minute limit.`,
    cost: () => capped,
    idle: () => 'The model stopped without calling done.',
    context: () => 'The attempt\'s conversation outgrew the model\'s context window. Read less at a time: narrower paths, grep, and shorter command output.',
    provider: result => `The model provider returned an error: ${result.error ?? 'unknown'}`,
  };
  const another = (repair: Repair, connection: { login: string; repository: string }) => connection.login !== repair.login || connection.repository !== repair.repository;
  async function connected(repair: Repair) {
    const connection = await github.connection();
    if (!connection) throw new Error(DISCONNECTED);
    if (another(repair, connection)) throw new Error(CHANGED);
  }
  // The pull request's workflow runs at its head: all passing (or skipped, one passing) is a pass, any failure fails,
  // and runs that end otherwise, such as cancelled, are neither. No run at all within noRunMs means none will come.
  // A read that fails, or a connection that cannot be read, is tried again at the next poll: another account ends the
  // wait at once, and GitHub unreadable for outageMs ends it with the last error.
  async function verify(repair: Repair, sha: string, signal: AbortSignal, seen: (ids: string[]) => Promise<void>) {
    const started = clock(), known = new Set<string>();
    let read = started, missed: unknown = null;
    for (;;) {
      await pause(ci.pollMs, signal);
      const connection = await github.connection().catch(() => null);
      if (connection && another(repair, connection)) throw new Error(CHANGED);
      const runs = connection ? await github.runs({ repository: repair.repository, sha, login: repair.login }).then(result => result.runs, error => { missed = error; return null; }) : null;
      if (!connection) missed = new Error(DISCONNECTED);
      signal.throwIfAborted();
      if (!runs) {
        if (clock() - read >= ci.outageMs) throw missed;
        if (clock() - started >= ci.waitMs) throw new Error(`The pull request's workflow runs did not finish in ${Math.round(ci.waitMs / 3_600_000)} hours.`);
        continue;
      }
      read = clock();
      const own = runs.filter(run => run.sha === sha && run.path?.startsWith('.github/workflows/'));
      const fresh = own.map(run => run.id).filter(id => !known.has(id));
      if (fresh.length) { fresh.forEach(id => known.add(id)); await seen(fresh); }
      if (own.length && own.every(run => run.status === 'completed')) {
        const failed = own.filter(failedRun), other = own.find(run => !passedRun(run) && run.conclusion !== 'skipped');
        if (failed.length) return { status: 'failed' as const, runs: failed };
        if (!other && own.some(passedRun)) return { status: 'passed' as const };
        return { status: 'other' as const, conclusion: String(other?.conclusion ?? 'skipped').replaceAll('_', ' ') };
      }
      if (!own.length && clock() - started >= ci.noRunMs) return { status: 'none' as const };
      if (clock() - started >= ci.waitMs) throw new Error(`The pull request's workflow runs did not finish in ${Math.round(ci.waitMs / 3_600_000)} hours.`);
    }
  }

  async function repair(context: RepairContext, signal: AbortSignal): Promise<RepairOutcome> {
    const { repair } = context, clone = join(context.directory, 'clone'), branch = repairBranch(repair.sha);
    const models = await options.models();
    if (!models) return { status: 'needs-person', reason: 'Add an OpenRouter API key in Settings.' };
    const deployFiles = options.deployFiles?.(repair) ?? [], attempts: RepairAttempt[] = [];
    let spent = 0, pushed: string | null = null, pullRequest: RepairPullRequest | null = null;
    let holds: string[] = [], ciRuns: string[] = [], feedback = '', summary = '', check: Pick<ChangeCheck, 'paths' | 'added' | 'removed'> | null = null;
    // The pull request is labelled once it opens, and again after each later push and at the end until GitHub takes the
    // label; one still missing when the repair ends is named in its reason.
    let labelled = false, unlabelled = '';
    const label = async () => {
      if (!pullRequest || labelled) return;
      const { number } = pullRequest;
      try { await connected(repair); await pulls.label({ repository: repair.repository, number, label: LABEL }); labelled = true; }
      catch (error) { signal.throwIfAborted(); unlabelled = redact(String((error as Error | null)?.message ?? error)).slice(0, 300); }
    };
    const finish = async (outcome: RepairOutcome): Promise<RepairOutcome> => {
      await label();
      if (!pullRequest || labelled) return outcome;
      const missing = `Could not label the pull request ${LABEL}: ${unlabelled}`;
      return { ...outcome, reason: outcome.reason ? `${outcome.reason} ${missing}` : missing };
    };
    // Cleanup belongs to the manager, separately from the repair's business outcome.
    await rm(clone, { recursive: true, force: true });
    await host.clone({ repair, directory: clone });
    signal.throwIfAborted();
    const original = await describeFailures(clone, repair.runs, repair.failures ?? []);
    let workflows: FailedWorkflow[] = original;
    const box = await boxes.create({ id: repair.id, image: await chooseImage(clone, original), source: clone, signal });
    const digest = await repositoryDigest(clone), title = pullRequestTitle(repair, original);
    const body = () => pullRequestBody({ repair, workflows: original, summary, attempts, holds, check, spent });
    const record = async (ids: string[]) => { ciRuns = [...ciRuns, ...ids].slice(-100); await context.report({ ciRuns }); };
    // CI at a head the merge step made by updating the pull request's branch.
    const ci = async (head: string, stop: AbortSignal): Promise<CiVerdict> => {
      const verdict = await verify(repair, head, stop, record);
      if (verdict.status === 'passed') return verdict;
      if (verdict.status === 'none') return { status: 'failed', reason: NO_CI };
      if (verdict.status === 'other') return { status: 'failed', reason: `The pull request's workflow runs ended as ${verdict.conclusion}.` };
      return { status: 'failed', reason: `The updated pull request failed CI: ${verdict.runs.map(run => run.name || run.path || run.id).slice(0, 5).join(', ')}.` };
    };
    for (let number = 1; number <= budget.attempts && spent < budget.cost; number += 1) {
      const id = number <= budget.escalateAfter ? models.model : models.escalationModel || models.model;
      const attempt: RepairAttempt = { number, model: id, startedAt: now() };
      attempts.push(attempt);
      await context.report({ status: 'repairing', attempts });
      const result = await runAttempt({ model: model(id, models.apiKey), box, prompt: attemptPrompt({ repair, workflows, digest, number, total: budget.attempts, feedback, changed: number > 1 }),
        signal, failing: workflows.flatMap(workflow => workflow.step.run ? [workflow.step.run] : []),
        checks: workflows.flatMap(workflow => workflow.step.run ? [{ run: workflow.step.run, directory: workflow.step.workingDirectory }] : []), steps: budget.steps, timeoutMs: budget.attemptMs, budget: budget.cost - spent });
      spent += result.cost;
      Object.assign(attempt, { completedAt: now(), reproduced: result.reproduced, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost });
      const fail = async (reason: string, next = reason) => { attempt.failure = reason; feedback = next; await context.report({ attempts }); };
      if (result.refusal) { await fail(result.refusal); return await finish({ status: 'needs-person', reason: result.refusal }); }
      if (result.end !== 'done') { await fail(ended[result.end](result)); continue; }
      summary = result.summary;
      let diff: Buffer;
      try { diff = await box.diff(repair.sha); }
      catch (error) { if (rejected(error)) { await fail((error as Error).message); continue; } throw error; }
      if (!diff.toString('utf8').trim()) { await fail('The attempt changed no file.'); continue; }
      const first = checkChanges(diff.toString('utf8'), { deployFiles });
      if (first.rejected.length) { await fail(first.rejected.join(' ')); continue; }
      // What git staged is checked again, whatever the box's diff said: its own paths, and its text diff with the
      // content of files it treats as binary. Holds and the change's size stay the box diff's, where a binary file
      // counts no lines.
      let staged: { paths: string[]; text: string };
      try { staged = await host.stage({ directory: clone, diff, base: repair.sha }); }
      catch (error) { if (rejected(error)) { await fail((error as Error).message); continue; } throw error; }
      const { paths } = staged, rules = pathRules(paths, deployFiles), checked = checkChanges(staged.text, { deployFiles });
      const refused = [...new Set([...rules.rejected, ...checked.rejected])];
      if (refused.length) { await fail(refused.join(' ')); continue; }
      await connected(repair);
      const account = await pulls.account();
      if (account.login.toLowerCase() !== repair.login.toLowerCase()) throw new Error(CHANGED);
      const sha = await host.commit({ directory: clone, parent: pushed ?? repair.sha, message: commitMessage(title, summary), author: { name: account.login, email: `${account.id}+${account.login}@users.noreply.github.com` } });
      if (!sha) { await fail('The attempt made no change since the last push.'); continue; }
      holds = [...new Set([...first.holds, ...rules.holds])];
      check = { paths, added: first.added, removed: first.removed };
      signal.throwIfAborted();
      let lease = pushed;
      if (!lease) {
        // The first push leases the branch as Perpetual last left it, such as a stopped repair of this commit did; a
        // branch holding commits Perpetual did not push is a person's, and is never overwritten.
        const remote = await host.remote({ directory: clone, repository: repair.repository, branch, signal }).catch(error => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (remote && remote !== repair.pushed) return { status: 'needs-person', reason: `${branch} has commits Perpetual did not push. Merge or close its pull request and delete the branch, then start the repair again.` };
        lease = remote ?? '';
      }
      // The push is recorded before anything else, even when the repair stopped while it ran, and nothing follows it then.
      await host.push({ directory: clone, repository: repair.repository, branch, sha, lease });
      pushed = sha;
      await context.report({ pushed: sha });
      if (!pullRequest) {
        const existing = await pulls.find({ repository: repair.repository, branch });
        signal.throwIfAborted();
        const opened = existing ?? await pulls.create({ repository: repair.repository, base: repair.branch, branch, title, body: body() });
        if (existing) await pulls.update({ repository: repair.repository, number: existing.number, body: body() });
        pullRequest = { number: opened.number, url: opened.url, branch, draft: opened.draft };
      } else await pulls.update({ repository: repair.repository, number: pullRequest.number, body: body() });
      await label();
      await context.report({ status: 'verifying-ci', pullRequest, attempts, diffHash: createHash('sha256').update(diff).digest('hex'), holds });
      const verdict = await verify(repair, sha, signal, record);
      if (verdict.status === 'passed') {
        // A pull request GitHub refuses to mark ready still goes through the gates, and the merge step marks it ready.
        const number = pullRequest.number, readied = await connected(repair).then(() => pulls.ready({ repository: repair.repository, number })).then(() => true, () => false);
        if (readied) { pullRequest = { ...pullRequest, draft: false }; await context.report({ pullRequest }); }
        if (!options.merge) return await finish(readied ? { status: 'ready' } : { status: 'ready', reason: UNREADY });
        // The box has no more work; the gates rebuild twins meanwhile.
        await box.remove();
        return await finish(await options.merge.merge({ repair, pullRequest, sha, holds, directory: context.directory, clone, title,
          autoMerge: () => context.autoMerge(), report: progress => context.report(progress), ci }, signal));
      }
      if (verdict.status === 'none') return await finish({ status: 'ready', reason: NO_CI });
      if (verdict.status === 'other') return await finish({ status: 'ready', reason: `The pull request's workflow runs ended as ${verdict.conclusion}.` });
      // A failed run whose log cannot be read is still named to the next attempt.
      const failures = await Promise.all(verdict.runs.slice(0, 5).map(run => github.failure({ repository: repair.repository, runId: run.id }).catch(() => null)));
      workflows = await describeFailures(clone, verdict.runs, failures.filter(failure => failure !== null));
      const failed = `The pushed change failed CI: ${verdict.runs.map(run => run.name || run.path || run.id).slice(0, 5).join(', ')}.`;
      await fail(failed, `${failed} The failed runs above are the pull request's; fix them on top of the pushed change.`);
    }
    if (pullRequest) await pulls.update({ repository: repair.repository, number: pullRequest.number, body: body() }).catch(() => {});
    return await finish({ status: 'failed', reason: spent >= budget.cost ? capped : `The build was not fixed in ${budget.attempts} attempts.` });
  }

  async function cleanup({ repair, directory }: { repair: Repair; directory: string }) {
    await boxes.remove(repair.id);
    // The host clone is useful recovery evidence until all guest resources are confirmed absent.
    await rm(directory, { recursive: true, force: true });
  }

  return {
    repair, cleanup,
    /**
     * A finished repair's pull request as GitHub has it, read as the account that opened it; a person may have merged or
     * closed it. A merged one's read names its merge commit.
     */
    async state(repair: Repair): Promise<PullRequestRead> {
      if (!repair.pullRequest) throw new Error('This repair has no pull request.');
      await connected(repair);
      return pulls.state({ repository: repair.repository, number: repair.pullRequest.number });
    },
    /**
     * Closes a superseded repair's open pull request with a comment, as the account that opened it. One a person closed
     * is left as it is, and one a person merged is too, returning the read that found it merged, with its merge commit.
     * It closes before it comments, so a close tried again after a failure never comments twice; the comment is best effort.
     */
    async close(repair: Repair): Promise<PullRequestRead | undefined> {
      if (!repair.pullRequest) return;
      await connected(repair);
      const { number } = repair.pullRequest, read = await pulls.state({ repository: repair.repository, number });
      if (read.state === 'merged') return read;
      if (read.state === 'closed') return;
      await pulls.close({ repository: repair.repository, number });
      await pulls.comment({ repository: repair.repository, number, body: redact(`Perpetual closed this repair: ${repair.reason || 'a newer commit superseded it.'}`) }).catch(() => {});
    },
    /** Removes boxes that repairs a controller restart interrupted left behind. */
    recover: () => boxes.removeLeftovers(),
  };
}
