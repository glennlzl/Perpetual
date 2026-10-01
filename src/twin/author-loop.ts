// Perpetual's own twin config author (docs/SANDBOX.md, "Author harnesses"): an AI SDK tool loop, run as its own
// process through the harness seam OpenCode runs through (./authoring.ts `loopHarness`), so the workspace, the check that
// only twin.json changed, cancellation, the time limit, the output tail and cleanup stay the controller's. Its tools are
// its only capabilities: list, read and grep inside the workspace's project, write_config, which checks a config as the
// controller does and writes twin.json only when it is valid, so a format slip costs one step rather than an attempt, and
// done. It runs no command and reaches no network but the model's. Observations and output hide known values and secret
// shapes before selecting or clipping text. Editable config keeps its exact bytes or is refused for credential literals.
// The process's model key comes from OPENROUTER_API_KEY alone. Everything it reads, instructions and repository, is data.
//
// Usage: node author-loop.ts <workspace> <OpenRouter model id> <prompt>
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import { APICallError, RetryError, ToolChoiceViolationError, generateText, hasToolCall, isStepCount, jsonSchema, tool, type LanguageModel, type LanguageModelCallEndEvent } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { CONFIG, EVIDENCE, FACTS, FEEDBACK, INSTRUCTIONS, MAX_CONFIG, STEPS, TIME_LIMIT_MS } from './authoring.ts';
import { services as registry } from './registry.ts';
import { checkWritten } from '../environments/generation.ts';
import { unwiredSummary, workFacts } from '../environments/evidence.ts';
import { hasSecretLiteral, hide as hideValues, redact } from '../redaction.ts';
import type { JSONSchema7 } from 'ai';
import type { TwinServices } from './registry.ts';

/** The step, counted from one, at which the model must write twin.json when none of its writes so far was valid. */
export const FORCED_WRITE_STEP = 12;
/** Failed writes in a row with the same error, after which the result asks for another approach. */
export const REPEATED_FAILURES = 3;
/** What the tools return at most, and how long a search may take. */
export const LIMITS = {
  path: 1024, entries: 500, lines: 2000, readBytes: 64 * 1024, lineChars: 2000, fileBytes: 8 * 1024 * 1024,
  pattern: 500, include: 200, matches: 100, matchChars: 300, searchedFiles: 20_000, searchedBytes: 1024 * 1024, searchMs: 5000,
};
export const CHANGE_APPROACH = 'This is the same error as your last writes. Change approach: read the part of TWIN.md or the repository file the error names before you write again.';
/** What the loop says on stderr when the model's provider stops it, before the provider's own error. */
export const PROVIDER_STOPPED = 'The twin config author stopped: the model provider returned an error.';
const STOPPED = 'The twin config author was stopped.', TIMED_OUT = 'The twin config author reached its time limit.';
const CONFIG_CREDENTIAL = `${CONFIG} contains a credential literal. Use a service placeholder or a configured test input.`;

type Stream = 'stdout' | 'stderr';
export type Print = (line: string, stream: Stream) => void;
type Refusal = { ok: false; error: string; note?: string };
type Result = { ok: true; [key: string]: unknown } | Refusal;
type Protect = (value: unknown) => string;
type Observations = { text: Protect; file: (file: string, text: string) => string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (input: unknown, name: string) => isRecord(input) ? input[name] : undefined;
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
/** Text the model or the repository wrote, as one bounded line of the loop's output. */
const oneLine = (value: unknown, limit = 200) => clip(String(value).replace(/\s+/g, ' ').trim(), limit);
const firstLine = (text: string) => oneLine(text.trim().split('\n')[0], 300);
const refused = (error: string): Refusal => ({ ok: false, error });
const binary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const shown = (root: string, path: string) => relative(root, path).split(sep).join('/') || '.';

/**
 * A path the author named, inside the project `root` (a real path): its real path and how it is shown, or why it is
 * refused. An absolute path, one that leaves the project, and one that leads out of it through a link are refused.
 */
async function locate(root: string, value: unknown, protect: Protect): Promise<{ real: string; name: string; error?: undefined } | { error: string }> {
  if (typeof value !== 'string' || value.length > LIMITS.path || value.includes('\0')) return { error: 'Name a path relative to the workspace, such as repo/package.json.' };
  if (isAbsolute(value)) return { error: `${oneLine(protect(value))} is absolute; name a path relative to the workspace, such as repo/package.json.` };
  const target = resolve(root, value);
  if (!within(root, target)) return { error: `${oneLine(protect(value))} is outside the workspace.` };
  const real = await realpath(target).catch(() => null);
  const name = protect(shown(root, target));
  if (real === null) return { error: `${name} does not exist.` };
  if (!within(root, real)) return { error: `${name} leads outside the workspace.` };
  return { real, name };
}

/** A folder's entries, folders ending in / and links in @, sorted. */
async function list(root: string, input: unknown, observe: Observations): Promise<Result> {
  const found = await locate(root, field(input, 'path') ?? '.', observe.text);
  if (found.error !== undefined) return refused(found.error);
  if (!(await stat(found.real)).isDirectory()) return refused(`${found.name} is a file; read it instead.`);
  const entries = (await readdir(found.real, { withFileTypes: true })).map(entry => `${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`).sort();
  return { ok: true, path: found.name, entries: entries.slice(0, LIMITS.entries).map(observe.text), truncated: entries.length > LIMITS.entries };
}

/** A text file's lines from `offset`, numbered, within the line and byte limits; `next` is where a truncated read goes on. */
async function read(root: string, input: unknown, observe: Observations): Promise<Result> {
  const found = await locate(root, field(input, 'path'), observe.text);
  if (found.error !== undefined) return refused(found.error);
  const offset = field(input, 'offset') ?? 1, limit = field(input, 'limit') ?? LIMITS.lines;
  if (!whole(offset) || !whole(limit)) return refused('offset and limit are whole numbers from 1.');
  const info = await stat(found.real);
  if (info.isDirectory()) return refused(`${found.name} is a folder; list it instead.`);
  if (!info.isFile()) return refused(`${found.name} is not a file.`);
  if (info.size > LIMITS.fileBytes) return refused(`${found.name} is over ${LIMITS.fileBytes / 1024 / 1024} MB; grep it instead.`);
  const bytes = await readFile(found.real);
  if (bytes.length > LIMITS.fileBytes) return refused(`${found.name} is over ${LIMITS.fileBytes / 1024 / 1024} MB; grep it instead.`);
  if (binary(bytes)) return refused(`${found.name} is a binary file.`);
  const lines = observe.file(found.real, bytes.toString('utf8')).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const content: string[] = [];
  let size = 0, index = offset - 1;
  for (; index < lines.length && content.length < Math.min(limit, LIMITS.lines); index += 1) {
    const line = `${index + 1}\t${clip(lines[index], LIMITS.lineChars)}`;
    if (content.length && size + Buffer.byteLength(line) + 1 > LIMITS.readBytes) break;
    size += Buffer.byteLength(line) + 1;
    content.push(line);
  }
  const truncated = index < lines.length;
  return { ok: true, path: found.name, lines: lines.length, content: content.join('\n'), truncated, ...(truncated ? { next: index + 1 } : {}) };
}

// A search's regular expressions, its pattern and its include glob, run in a context with a time limit, which stops even
// one that backtracks without end.
const SEARCH = new Script('for (let index = 0; index < lines.length && hits.length < room; index += 1) if (pattern.test(lines[index])) hits.push(index);');
const FILTER = new Script('kept = names.map(name => glob.test(name));');
const TIMED = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
const INCLUDE = 'include is a glob such as *.ts, src/**/*.{ts,tsx} or [!.]*: * and ? within a name, ** across folders, [...] and {a,b}.';

/**
 * An include glob as one regular expression, or why it is refused: * and ? match within a name, ** any folders, [...] one
 * character of a name, and {a,b} one level of alternatives; every other character is itself. Nothing is expanded, so a
 * glob's cost is its expression's, which runs within the search's time limit.
 */
function globExpression(glob: string): RegExp | null {
  let source = '', braces = false;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const folders = glob[index + 2] === '/';
      source += folders ? '(?:[^/]*/)*' : '.*';
      index += folders ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const negated = glob[index + 1] === '!' || glob[index + 1] === '^', start = index + (negated ? 2 : 1), end = glob.indexOf(']', start + 1);
      if (end === -1) { source += '\\['; continue; }
      source += `(?!/)[${negated ? '^' : ''}${glob.slice(start, end).replace(/[\\[\]^]/g, '\\$&')}]`;
      index = end;
    } else if (char === '{') {
      if (braces) return null;
      braces = true; source += '(?:';
    } else if (char === ',' && braces) source += '|';
    else if (char === '}' && braces) { braces = false; source += ')'; }
    else source += char.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  }
  if (braces) return null;
  try { return new RegExp(`^${source}$`); } catch { return null; }
}

/**
 * The lines matching a regular expression in the files under a path, as `path:line: text`, at most LIMITS.matches, and
 * within LIMITS.searchMs. `include` is a glob of file names, or of paths below the searched folder when it has a /.
 * Links are never followed; large and binary files are skipped.
 */
async function grep(root: string, input: unknown, observe: Observations): Promise<Result> {
  const source = field(input, 'pattern'), include = field(input, 'include');
  if (typeof source !== 'string' || !source || source.length > LIMITS.pattern) return refused(`Pass a pattern of 1 to ${LIMITS.pattern} characters.`);
  if (include !== undefined && (typeof include !== 'string' || !include || include.length > LIMITS.include)) return refused(`include is a glob of 1 to ${LIMITS.include} characters, such as *.ts.`);
  const glob = typeof include === 'string' ? globExpression(include) : null, byPath = typeof include === 'string' && include.includes('/');
  if (include !== undefined && glob === null) return refused(INCLUDE);
  let pattern: RegExp;
  try { pattern = new RegExp(source); } catch (error) { return refused(observe.text(`The pattern is not a regular expression: ${(error as Error).message}`)); }
  const found = await locate(root, field(input, 'path'), observe.text);
  if (found.error !== undefined) return refused(found.error);
  const base = found.real, matches: string[] = [], deadline = Date.now() + LIMITS.searchMs;
  const context = createContext({ pattern, lines: [] as string[], hits: [] as number[], room: 0, glob, names: [] as string[], kept: [] as boolean[] });
  const outOfTime = refused(`The search took over ${LIMITS.searchMs / 1000} seconds; use a simpler pattern, include or a narrower path.`);
  const remaining = () => ({ timeout: Math.max(1, deadline - Date.now()) });
  let searched = 0, truncated = false;
  /** A folder's files that include names, by name or, when it has a /, by path below the searched folder. */
  function wanted(folder: string, files: string[]) {
    if (glob === null) return files;
    Object.assign(context, { names: files.map(name => byPath ? shown(base, join(folder, name)) : name), kept: [] });
    FILTER.runInContext(context, remaining());
    return files.filter((_name, index) => (context.kept as boolean[])[index]);
  }
  async function search(file: string) {
    if ((await stat(file)).size > LIMITS.searchedBytes) return;
    const bytes = await readFile(file);
    if (bytes.length > LIMITS.searchedBytes || binary(bytes)) return;
    searched += 1;
    const lines = observe.file(file, bytes.toString('utf8')).split(/\r?\n/);
    Object.assign(context, { lines, hits: [], room: LIMITS.matches + 1 - matches.length });
    SEARCH.runInContext(context, remaining());
    for (const index of context.hits as number[]) matches.push(`${observe.text(shown(root, file))}:${index + 1}: ${clip(lines[index].trim(), LIMITS.matchChars)}`);
  }
  try {
    if ((await stat(found.real)).isFile()) await search(found.real);
    else {
      // Depth first, in name order; a link is an entry of its own, never followed.
      for (const folders = [found.real]; folders.length && !truncated;) {
        const folder = folders.pop()!, entries = (await readdir(folder, { withFileTypes: true })).sort((one, other) => one.name < other.name ? -1 : 1);
        if (Date.now() > deadline) return outOfTime;
        for (const name of wanted(folder, entries.filter(entry => entry.isFile()).map(entry => entry.name))) {
          if (matches.length > LIMITS.matches || searched >= LIMITS.searchedFiles) { truncated = true; break; }
          if (Date.now() > deadline) return outOfTime;
          await search(join(folder, name));
        }
        folders.push(...entries.filter(entry => entry.isDirectory()).map(entry => join(folder, entry.name)).reverse());
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === TIMED) return outOfTime;
    throw error;
  }
  truncated ||= matches.length > LIMITS.matches;
  return { ok: true, path: found.name, matches: matches.slice(0, LIMITS.matches), truncated };
}

const schema = (properties: Record<string, JSONSchema7>, required: string[]) =>
  jsonSchema<unknown>({ type: 'object', properties, required, additionalProperties: false });
const PATH = { type: 'string', description: 'A path relative to the workspace, such as repo or repo/package.json.' } satisfies JSONSchema7;

/** How the loop shows a tool call: its name and what it was asked for, on one line. */
function described(name: string, input: unknown, protect: Protect) {
  const path = oneLine(protect(field(input, 'path') ?? '.')), offset = field(input, 'offset'), include = field(input, 'include');
  if (name === 'read') return `read ${path}${whole(offset) && offset > 1 ? `:${offset}` : ''}`;
  if (name === 'grep') return `grep ${JSON.stringify(oneLine(protect(field(input, 'pattern') ?? '')))} in ${path}${include === undefined ? '' : ` (${oneLine(protect(include))})`}`;
  return `${oneLine(protect(name))} ${path}`;
}
/** A tool call's line: what a read was asked for, or that a write was valid, or why either was refused. */
function outcome(name: string, input: unknown, output: unknown, protect: Protect) {
  const ok = field(output, 'ok') === true, why = firstLine(protect(field(output, 'error') ?? 'refused'));
  if (name === 'write_config') return ok ? '✓ write_config' : `✗ write_config: ${why}`;
  return ok ? `→ ${described(name, input, protect)}` : `✗ ${described(name, input, protect)}: ${why}`;
}

/**
 * The provider's message on the loop's Error: line at most. The controller maps a refusal from the end of the output's
 * last 500 characters, so the whole line, with the line before it, stays within them.
 */
export const ERROR_MESSAGE_CHARS = 300;
const ERROR_LINE_CHARS = 400;
/**
 * The OpenRouter error as OpenCode prints one, `{"code":<status>,"message":...}`, so the controller maps credits, key and
 * request refusals alike. OpenRouter answers some refusals with HTTP 200 and the code in its body, which is the code
 * then. `hide` redacts the message before it is clipped, so a clipped line never keeps part of a secret.
 */
function providerError(error: unknown, hide: (text: string) => string) {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const message = (text: string) => oneLine(hide(text), ERROR_MESSAGE_CHARS);
  if (!APICallError.isInstance(cause)) return message(error instanceof Error ? error.message : String(error));
  if (cause.statusCode === undefined) return message(cause.message);
  const reported = field(cause.data, 'code'), inBody = typeof reported === 'string' && /^\d{3}$/.test(reported) ? Number(reported) : reported;
  const code = cause.statusCode === 200 && typeof inBody === 'number' && Number.isInteger(inBody) ? inBody : cause.statusCode;
  return JSON.stringify({ code, message: message(cause.message) });
}

/** Tokens and, when OpenRouter reports it, the cost of every model call so far, one a step. */
type Usage = { steps: number; input: number; output: number; cost: number | null };
function counted(usage: Usage, { usage: { inputTokens, outputTokens }, providerMetadata }: Pick<LanguageModelCallEndEvent, 'usage' | 'providerMetadata'>) {
  usage.steps += 1;
  usage.input += inputTokens ?? 0;
  usage.output += outputTokens ?? 0;
  const reported = field(field(providerMetadata?.openrouter, 'usage'), 'cost');
  if (typeof reported === 'number' && Number.isFinite(reported)) usage.cost = (usage.cost ?? 0) + reported;
}
const usageLine = ({ steps, input, output, cost }: Usage) =>
  `Usage: ${steps} ${steps === 1 ? 'step' : 'steps'}, ${input} input tokens, ${output} output tokens${cost === null ? '' : `, $${cost.toFixed(6)}`}.`;

export interface LoopOptions {
  /** The authoring workspace: the project the tools reach, and facts.json beside it. */
  workspace: string;
  prompt: string;
  model: LanguageModel;
  services?: TwinServices;
  /** Values no observation or output line may contain, such as the key. */
  secrets?: string[];
  /** Stops the loop, as SIGTERM does. */
  signal?: AbortSignal;
  timeoutMs?: number;
  print?: Print;
}

/**
 * Runs the author once: resolves 0 when the model called done, reached the step limit or the time limit, stopped
 * calling tools or did not write when it had to, and 1 when it was stopped or its provider failed. twin.json holds the
 * last valid config it wrote, or the draft when it wrote none.
 */
export async function authorLoop({ workspace, prompt, model, services = registry, secrets = [], signal, timeoutMs = TIME_LIMIT_MS, print = (line, stream) => { process[stream].write(`${line}\n`); } }: LoopOptions): Promise<number> {
  const hidden = secrets.filter(Boolean), hide = hideValues(hidden, { preserveLines: true });
  const protect = (value: unknown) => redact(hide(value));
  const say = (line: string, stream: Stream = 'stdout') => print(protect(line), stream);
  const root = await realpath(join(workspace, 'project')), text = (file: string) => readFile(file, 'utf8').catch(() => null);
  const [instructions, evidence, feedback, factsText] = await Promise.all([text(join(root, INSTRUCTIONS)), text(join(root, EVIDENCE)), text(join(root, FEEDBACK)), text(join(workspace, FACTS))]);
  if (instructions === null || evidence === null) throw new Error(`The workspace has no ${INSTRUCTIONS} or ${EVIDENCE}.`);
  let facts: ReturnType<typeof workFacts> = null;
  try { facts = factsText === null ? null : workFacts(JSON.parse(factsText)); } catch { /* No facts: results leave the unwired variables out. */ }
  const work = facts && { ...facts, services };
  let written = false, repeated = { error: '', count: 0 };

  const file = join(root, CONFIG);
  // Editable config keeps its exact templates and ordinary values. A credential literal needs a reference, never a rewritten draft.
  const observe: Observations = { text: protect, file: (path, text) => {
    if (path !== file) return protect(text);
    if (hasSecretLiteral(text, hidden)) throw new Error(CONFIG_CREDENTIAL);
    return text;
  } };
  /** The config a write would leave in twin.json, or why it is refused, as the controller would refuse it. */
  async function checked(input: unknown): Promise<{ text: string; error?: undefined } | { error: string }> {
    const text = field(input, 'text');
    if (typeof text !== 'string') return { error: `Pass the whole ${CONFIG} as text.` };
    if (Buffer.byteLength(text) > MAX_CONFIG) return { error: `Keep ${CONFIG} under ${MAX_CONFIG / 1024} KB.` };
    if (hasSecretLiteral(text, hidden)) return { error: CONFIG_CREDENTIAL };
    const { error } = checkWritten(text, services);
    if (error !== undefined) return { error: protect(error) };
    return (await lstat(file).catch(() => null))?.isFile() ? { text } : { error: `${CONFIG} must remain a file.` };
  }
  // Writes of one step run in the order the model made them, so the last valid one is twin.json.
  let writes: Promise<unknown> = Promise.resolve();
  const writeConfig = (input: unknown) => {
    const result = writes.then(() => write(input), () => write(input)).catch((error: unknown) => refused(protect(`The write_config failed: ${(error as Error).message}`)));
    writes = result; return result;
  };
  async function write(input: unknown): Promise<Result> {
    const config = await checked(input);
    if (config.error === undefined) {
      await writeFile(file, config.text);
      written = true; repeated = { error: '', count: 0 };
      return { ok: true, ...(work ? { unwired: unwiredSummary(work, config.text, protect) } : {}) };
    }
    repeated = { error: config.error, count: repeated.error === config.error ? repeated.count + 1 : 1 };
    return { ...refused(config.error), ...(repeated.count >= REPEATED_FAILURES ? { note: CHANGE_APPROACH } : {}) };
  }
  const reading = (name: string, run: (root: string, input: unknown, observe: Observations) => Promise<Result>) => (input: unknown) =>
    run(root, input, observe).catch((error: unknown) => refused(protect(`The ${name} failed: ${(error as Error).message}`)));
  const tools = {
    list: tool({ description: `Lists a folder of the workspace, at most ${LIMITS.entries} entries; folders end in /.`, inputSchema: schema({ path: PATH }, ['path']), execute: reading('list', list) }),
    read: tool({
      description: `Reads a text file of the workspace, its lines numbered: at most ${LIMITS.lines} lines or ${LIMITS.readBytes / 1024} KB from offset. When truncated, next is the line to read on from.`,
      inputSchema: schema({ path: PATH, offset: { type: 'integer', minimum: 1, description: 'The first line, counted from 1.' }, limit: { type: 'integer', minimum: 1, maximum: LIMITS.lines } }, ['path']),
      execute: reading('read', read),
    }),
    grep: tool({
      description: `Searches the files under a path for a JavaScript regular expression, line by line: at most ${LIMITS.matches} matching lines as path:line: text. Pass a narrow path and an include glob.`,
      inputSchema: schema({ pattern: { type: 'string', maxLength: LIMITS.pattern }, path: PATH, include: { type: 'string', maxLength: LIMITS.include, description: 'A glob of file names, such as *.ts or *.{ts,tsx}, or of paths below path when it has a /, such as src/**/*.ts.' } }, ['pattern', 'path']),
      execute: reading('grep', grep),
    }),
    write_config: tool({
      description: `Writes the whole ${CONFIG} once it is a valid twin config. A config that is not valid is not written, and the error says why; a valid one returns each app's unwired variables when they are known.`,
      inputSchema: schema({ text: { type: 'string', description: `The whole ${CONFIG}.` } }, ['text']),
      execute: writeConfig,
    }),
    done: tool({ description: `Ends the attempt once ${CONFIG} holds the config.`, inputSchema: schema({}, []) }),
  };

  const timeout = AbortSignal.timeout(timeoutMs), usage: Usage = { steps: 0, input: 0, output: 0, cost: null };
  try {
    await generateText({
      model, tools, instructions: protect(`${instructions}\n\n${evidence}`), prompt: protect(feedback === null ? prompt : `${prompt}\n\n${feedback}`),
      stopWhen: [isStepCount(STEPS), hasToolCall('done')],
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // Reasoning and its provider metadata carry over from step to step as the provider returned them: nothing here
      // rewrites the messages.
      prepareStep: ({ stepNumber }) => !written && stepNumber + 1 === FORCED_WRITE_STEP ? { toolChoice: { type: 'tool', toolName: 'write_config' } } : undefined,
      // Each answer the model was paid for counts, the one that broke a forced write as well, which ends its step early.
      onLanguageModelCallEnd: call => counted(usage, call),
      // One line per tool call, in the order the model made them: a call the SDK refused, such as one to a tool that
      // does not exist, is a tool error.
      onStepEnd(step) {
        for (const part of step.content) {
          if (part.type === 'tool-result') say(outcome(part.toolName, part.input, part.output, protect));
          else if (part.type === 'tool-error') say(`✗ ${oneLine(protect(part.toolName))}: ${firstLine(protect(part.error instanceof Error ? part.error.message : String(part.error)))}`);
          else if (part.type === 'tool-call' && part.toolName === 'done') say('✓ done');
        }
      },
    });
    return 0;
  } catch (error) {
    if (timeout.aborted) { say(TIMED_OUT); return 0; }
    // A model that does not write when it must ends its attempt as one at its step limit does: with what it wrote.
    if (ToolChoiceViolationError.isInstance(error)) { say(`✗ write_config: the model wrote nothing at step ${FORCED_WRITE_STEP}, when it had to.`); return 0; }
    if (signal?.aborted) { say(STOPPED, 'stderr'); return 1; }
    say(PROVIDER_STOPPED, 'stderr');
    say(`Error: ${oneLine(providerError(error, protect), ERROR_LINE_CHARS)}`, 'stderr');
    return 1;
  } finally { say(usageLine(usage)); }
}

/** The OpenRouter model the controller chose, with the key from the environment. */
export const openrouterModel = (id: string, apiKey: string) => createOpenRouter({ apiKey })(id, { usage: { include: true } });

/**
 * Runs the loop as this process, `<workspace> <model id> <prompt>`, with the key in OPENROUTER_API_KEY: SIGTERM stops
 * it, and it exits with the loop's code. Tests pass a scripted model.
 */
export async function runLoopProcess({ args = process.argv.slice(2), env = process.env, model = openrouterModel, services }: {
  args?: string[]; env?: NodeJS.ProcessEnv; model?: (id: string, apiKey: string) => LanguageModel; services?: TwinServices;
} = {}) {
  const [workspace, id, prompt] = args, apiKey = env.OPENROUTER_API_KEY ?? '';
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  let code = 1;
  if (!workspace || !id || id.length > 200 || !prompt) process.stderr.write('Usage: node author-loop.ts <workspace> <model id> <prompt>\n');
  else if (!apiKey) process.stderr.write('OPENROUTER_API_KEY is not set.\n');
  else {
    try { code = await authorLoop({ workspace, prompt, model: model(id, apiKey), services, secrets: [apiKey], signal: stop.signal }); }
    catch (error) { process.stderr.write(`The twin config author could not start: ${oneLine(redact(hideValues([apiKey])((error as Error).message ?? error)), 500)}\n`); }
  }
  // Exits once its output is written; an idle connection of the model's never holds it open for long.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

/**
 * Whether the module at `url` is the one this process runs, `entry` being its path as given: import.meta.main, which
 * only Node.js 24.2 and later have, for every Node.js the package supports.
 */
export function isMainModule(url: string, entry = process.argv[1]) {
  try { return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isMainModule(import.meta.url)) await runLoopProcess();
