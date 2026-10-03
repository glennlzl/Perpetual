// OpenCode (opencode-ai, pinned), run headlessly against OpenRouter, wherever an agent authors data for Perpetual:
// journey code (src/journeys/playwright/generation.ts) and twin configs (src/twin/authoring.ts), which may instead run
// Perpetual's own loop (src/twin/author-loop.ts) through the same harness seam. A use prepares a private workspace whose
// OpenCode project is its own git root, writes the project's opencode.json, and runs its agent once per prompt through
// this module: in an environment with only what OpenCode needs, the model key only there, within a time limit, cancelled
// by killing the process tree, and with its output tails redacted before they are kept.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { browserError, superviseWorker, type WorkerError, type WorkerJob } from '../browser/runtime.ts';
import { hide as hideValues } from '../redaction.ts';
import { captureAuthoringEvidence } from './authoring-evidence.ts';
import type { HarnessEvidence } from '../../contract/authoring.ts';

export const OPENCODE_VERSION = '1.18.32';
/** The harness as a use's provenance names it. */
export const OPENCODE = `opencode@${OPENCODE_VERSION}`;
/** A command, and the variables its process needs beyond its use's environment. */
export type Command = { command: string; args: string[]; env?: Record<string, string> };
/**
 * The command that runs a use's agent once with a prompt, in `cwd`, the use's project; model is `openrouter/<id>`. Tests
 * supply a fake.
 */
export type Harness = (input: { model: string; prompt: string; cwd: string }) => Command;
/** What a use says when its agent is cancelled, runs out of time, stops or cannot start. */
export type RunMessages = { cancelled: string; timedOut: string; stopped: string; unavailable: string };

/** OpenCode running `agent`, a primary agent of the project's opencode.json, once with a prompt. */
export const opencodeRun = (agent: string, { json = false } = {}): Harness => ({ model, prompt }) => ({ command: 'npx', args: ['-y', `opencode-ai@${OPENCODE_VERSION}`, 'run', ...(json ? ['--format', 'json'] : []), '--agent', agent, '--model', model, prompt] });

/** Settings every use's opencode.json carries: no update or sharing, only its OpenRouter model, and its permission. */
export const opencodeSettings = ({ model, permission, modelOptions }: { model: string; permission: Record<string, unknown>; modelOptions?: Record<string, unknown> }) =>
  ({ autoupdate: false, share: 'disabled', permission, provider: { openrouter: { models: { [model]: modelOptions ? { options: modelOptions } : {} } } } });

const exec = promisify(execFile);
const TAIL = 4000;
// Observe complete bounded streams before retaining their tails. An overflow loses the context needed for redaction.
const CAPTURE_BYTES = 256 * 1024;
const OUTPUT_WITHHELD = 'Agent output exceeded the capture limit; output text withheld.';
/** Added to a use's own reason for a failed run, which replaces the worker's, when its processes may remain. */
const INCOMPLETE = 'Cleanup incomplete; the agent’s processes could not be confirmed stopped.';
// OpenRouter refusals OpenCode reports as `Error: <message>` before it exits, and what a person does about each.
const REFUSALS: [RegExp, string][] = [
  [/\bError: .{0,200}?would exceed your available credits given your current in-flight requests\b/i, 'Wait for active OpenRouter requests to finish or add credits, then try again.'],
  [/\bError: .{0,200}?(?:requires more credits|insufficient credits)/i, 'Add credits to your OpenRouter account and try again.'],
  [/\bError: .{0,200}?(?:no auth credentials found|user not found|invalid api key)/i, 'Check your OpenRouter API key in Settings.'],
  // A request the model's provider rejects, such as Gemini's reasoning details, fails the same way on every attempt.
  [/\bError: \{.{0,40}"code":\s*400\b/, 'The selected model does not work with this agent. Choose another model in Settings.'],
];
/** What a person does about the OpenRouter refusal that stopped a run, if one did. */
export const openrouterRefusal = (output: string) => REFUSALS.find(([pattern]) => pattern.test(output))?.[1];
const pick = (values: NodeJS.ProcessEnv, keys: string[]) => Object.fromEntries(keys.filter(key => typeof values[key] === 'string').map(key => [key, values[key] as string]));

/** A private 0700 folder under root for one use; remove() deletes it and everything in it. */
export async function privateWorkspace(root: string) {
  const path = join(root, randomUUID());
  await mkdir(path, { mode: 0o700 });
  return { path, remove: () => rm(path, { recursive: true, force: true }).catch(() => {}) };
}

/** The environment of commands that prepare a workspace: no credential, and HOME is the workspace's own. */
export const setupEnvironment = (values: NodeJS.ProcessEnv, home: string): Record<string, string> => ({ FORCE_COLOR: '0', ...pick(values, ['PATH', 'TMPDIR', 'LANG']), HOME: home });

/** Runs one command that prepares a workspace. Its output may echo the workspace, so a failure says only `failure`. */
export async function setupCommand(command: string, args: string[], { cwd, env, signal, failure, cancelled }: {
  cwd: string; env: Record<string, string>; signal: AbortSignal; failure: string; cancelled: string;
}) {
  try { await exec(command, args, { cwd, env, timeout: 60000, signal, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error(signal.aborted ? cancelled : failure); }
}

/**
 * What OpenCode's process needs beyond its use's own variables. HOME and the XDG folders under it are the workspace's,
 * so OpenCode reads none of the user's config, plugins, skills or instructions; npx and OpenCode keep the user's npm
 * settings and caches. The model key is the only credential.
 */
export function opencodeEnvironment(values: NodeJS.ProcessEnv, { home, userHome, apiKey }: { home: string; userHome: string; apiKey: string }): Record<string, string> {
  return {
    ...pick(values, ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']),
    HOME: home, XDG_CACHE_HOME: values.XDG_CACHE_HOME || join(userHome, '.cache'),
    npm_config_cache: join(userHome, '.npm'), npm_config_userconfig: join(userHome, '.npmrc'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENROUTER_API_KEY: apiKey,
  };
}

/** sha256 of each file by path, to tell whether files an agent cannot write stayed unchanged. */
export const fingerprint = async (files: string[]): Promise<Record<string, string>> =>
  Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));

/**
 * A failed run: its message is the actionable refusal, or the reason and output tail for other failures;
 * `reason` and redacted `output` are each alone, and `timedOut`
 * says it ran out of time rather than stopping or being cancelled.
 */
export type RunFailure = Error & { reason: string; output: string; timedOut?: true; cleanupIncomplete?: true; evidence?: HarnessEvidence };

/**
 * Runs a use's agent, once per call to run(prompt), which resolves with the end of its output. cancel() stops the current
 * run and refuses later ones. A failed run rejects with a RunFailure, redacted of `secrets` and of the model key in
 * `env`; `cleanupIncomplete` says an owned process may remain.
 */
export function createOpencodeRunner({ harness, model, cwd, env, secrets, timeoutMs, cleanupGraceMs, settleMs = 0, messages, structuredOutput = false }: {
  harness: Harness; model: string; cwd: string; env: Record<string, string>; secrets: (string | undefined)[];
  timeoutMs: number; cleanupGraceMs: number; settleMs?: number; messages: RunMessages; structuredOutput?: boolean;
}) {
  const abort = new AbortController(), hidden = secrets.filter((value): value is string => Boolean(value));
  const hide = hideValues(hidden);
  let job: WorkerJob | null = null;
  async function run(prompt: string): Promise<{ output: string; evidence: HarnessEvidence }> {
    if (abort.signal.aborted) throw new Error(messages.cancelled);
    const { command, args, env: own } = harness({ model: `openrouter/${model}`, prompt, cwd });
    const childEnv = { ...env, ...own };
    let reportedRefusal: string | undefined;
    const evidence = captureAuthoringEvidence(value => browserError(hide(String(value)), childEnv, Infinity), message => { reportedRefusal = openrouterRefusal(`Error: ${message}`); });
    const captures = { stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } };
    const tail = (stream: 'stdout' | 'stderr') => {
      if (structuredOutput) return ''; // JSON tool results contain page contents and account data; only the allowlisted evidence leaves.
      const capture = captures[stream];
      // browserError owns the environment's model keys and text redaction. Let it see the complete capture first.
      return capture.truncated ? OUTPUT_WITHHELD : capture.text ? browserError(hide(capture.text), childEnv, Infinity).slice(-TAIL).trim() : '';
    };
    job = superviseWorker({ command, args, cwd, env: childEnv, timeoutMs, cleanupGraceMs, settleMs, secrets: hidden, unavailable: messages.unavailable,
      onOutput(chunk, stream) {
        evidence.write(chunk, stream);
        const capture = captures[stream];
        if (capture.truncated) return;
        if (Buffer.byteLength(capture.text) + Buffer.byteLength(chunk) > CAPTURE_BYTES) { capture.text = ''; capture.truncated = true; }
        else capture.text += chunk;
      } });
    try {
      await job.promise;
      const output = structuredOutput ? reportedRefusal ?? '' : [tail('stdout'), tail('stderr')].filter(Boolean).join('\n');
      return { output: output && browserError(output, childEnv, TAIL), evidence: evidence.finish('completed') };
    }
    catch (caught) {
      const error = caught as WorkerError, incomplete = { ...(error.cleanupIncomplete ? { cleanupIncomplete: true } : {}), evidence: evidence.finish(abort.signal.aborted ? 'cancelled' : error.timedOut ? 'timed-out' : 'failed', error.cleanupIncomplete) };
      const said = (reason: string) => error.cleanupIncomplete && !reason.includes('Cleanup incomplete') ? `${reason} ${INCOMPLETE}` : reason;
      if (abort.signal.aborted) throw Object.assign(new Error(said(messages.cancelled)), { reason: said(messages.cancelled), output: '' }, incomplete);
      const output = (tail('stderr') || tail('stdout')).split('\n').slice(-6).join(' ').slice(-500);
      const stopped = /exited before completing/.test(error.message);
      const refusal = stopped && !error.timedOut ? structuredOutput ? reportedRefusal : openrouterRefusal(output) : undefined;
      const reason = said(error.timedOut ? messages.timedOut : stopped ? refusal ?? messages.stopped : error.message);
      throw Object.assign(new Error(browserError(hide(`${reason}${output && !refusal ? ` ${output}` : ''}`), childEnv, 800)),
        { reason: browserError(hide(reason), childEnv, 800), output: output && browserError(hide(output), childEnv, 800) }, error.timedOut ? { timedOut: true } : {}, incomplete);
    } finally { job = null; }
  }
  return { run, hide, signal: abort.signal, cancel() { abort.abort(); job?.cancel(); } };
}
export type OpencodeRunner = ReturnType<typeof createOpencodeRunner>;
