// Generates the actions of a reviewed journey's spec with Playwright's own generator agent (`playwright init-agents
// --loop=opencode`), run headlessly by OpenCode against OpenRouter (src/agents/opencode.ts). Perpetual writes no agent
// loop or MCP client: it prepares a private workspace, runs the harness, and accepts only code that validateJourneySpec
// accepts.
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { OPENCODE, createOpencodeRunner, fingerprint, opencodeEnvironment, opencodeRun, opencodeSettings, setupCommand, setupEnvironment, type Harness, type OpencodeRunner } from '../../agents/opencode.ts';
import type { WorkerEvent, WorkerJob } from '../../browser/runtime.ts';
import type { RunCredentials } from '../../browser/run-credentials.ts';
import { RUN, SIGN_IN_ACTION, checkTemplate, readsRunData, type ApprovedCase, type Check, type JourneyStep } from './checks.ts';
import { PLAYWRIGHT_CLI, PLAYWRIGHT_VERSION, createPlaywrightRuntime, journeyEnvironment, writeJourneyWorkspace, type JourneyRunInput } from './runtime.ts';
import { specHash, validateJourneySpec } from './specs.ts';

/** A reviewed case whose spec is generated: it names its milestones. */
export type GenerationCase = ApprovedCase & { steps: JourneyStep[] };
/** The command that runs the generator agent once with a prompt. */
export type { Harness };
export type GenerationStep = 'preparing' | 'generating' | 'repairing';
/** What runs the seed once before the generator starts: the Playwright runtime that runs journeys. */
export type SeedRuntime = { start(input: JourneyRunInput, onEvent: (event: WorkerEvent) => void): WorkerJob<unknown> };
export type GenerationOptions = {
  workspace: string; item: GenerationCase; targetUrl: string; allowedOrigins?: string[]; timeoutSeconds: number;
  credentials?: RunCredentials; signInUrl?: string; apiKey: string; model: string; harness?: Harness; playwright?: SeedRuntime;
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv); timeoutMs?: number; cleanupGraceMs?: number; onStep?: (step: GenerationStep) => void;
};
export type GeneratedSpec = { code: string; provenance: { harness: string; generator: string; model: string } };
// Playwright's init-agents writes opencode.json; it is parsed text until the agent and MCP server it needs are checked.
// opencode.json as Playwright's init-agents writes it, read back as parsed JSON: each level is checked before it is changed.
const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
type AttemptSpec = { file: string; code: string; error?: undefined; rejected?: undefined } | { file: string; error: string; rejected?: string; code?: undefined };

export const GENERATOR_AGENT = 'playwright-test-generator';
export const SEED = 'seed.spec.mjs', PLAN = 'specs/plan.md', TESTS = 'tests', TARGET = `${TESTS}/journey.spec.mjs`;
const SEED_PROJECT = 'seed';
// The test MCP server exits before its Playwright worker finishes teardown, so OpenCode can exit first.
const MAX_SPEC = 256 * 1024, SETTLE_MS = 10000;
export const CANCELLED = 'Code generation cancelled.';
const MESSAGES = { cancelled: CANCELLED, timedOut: 'Code generation exceeded its time limit.', stopped: 'The code generator stopped.', unavailable: 'The code generator could not start. Install Node.js with npx.' };

// The workspace the caller owns holds three folders:
// - project: OpenCode's project and the test MCP server's root, its own git root with opencode.json, .opencode,
//   specs/plan.md and tests. generator_write_test writes only inside a Playwright project's testDir under this root,
//   and the only one is tests, which no project loads.
// - run: what the seed's Playwright process loads (config, `perpetual` shim, case snapshot and seed). It is outside
//   the root and read-only, so no file the generator writes runs beside the account or changes an import.
// - home: the harness's HOME, so OpenCode reads none of the user's global config, plugins, skills or instructions.
const workspaceFolders = (workspace: string) => ({ project: join(workspace, 'project'), run: join(workspace, 'run'), home: join(workspace, 'home') });

/** The default harness: OpenCode runs Playwright's generator agent once in the workspace. model is `openrouter/<id>`. */
export const opencodeHarness: Harness = opencodeRun(GENERATOR_AGENT);

/** The seed opens the application, as every journey starts, and signs in when the twin has a test account. */
export const seedSpec = (signIn: boolean) => `import { test } from 'perpetual';

// The fixture opens the application; a generated test starts the same way.
test('seed', async ({ page, journey }) => {
${signIn ? '  await journey.signIn();\n' : ''}});
`;

const MAX_REJECTED = 20000;
const line = (value: unknown) => String(value).replace(/\s+/g, ' ').trim();
/** The texts of reviewed checks that name the run's token as {run}, as the page must show them. */
const runTexts = (checks: readonly Check[] = []) => [...new Set(checks.map(checkTemplate).filter(text => text.includes(RUN)).map(line))];
/**
 * What a case's checks tell the generator about journey.run: which texts hold {run}, milestone by milestone and apart
 * from the final assertions, and from which milestone on journey.run may name an element, exactly as validateJourneySpec
 * judges it: after the first milestone with a check that fails when this run's data is missing.
 */
function runRules(item: Pick<ApprovedCase, 'steps' | 'assertions'>) {
  const steps = item.steps || [];
  const read = [...steps.map(step => [runTexts(step.checks), `in milestone ${step.id}`] as const), [runTexts(item.assertions), 'in the final assertions'] as const]
    .filter(([texts]) => texts.length).map(([texts, where]) => `${texts.map(text => JSON.stringify(text)).join(', ')} ${where}`);
  const first = steps.findIndex(step => (step.checks || []).some(readsRunData)), next = first < 0 ? undefined : steps[first + 1];
  return [
    ...(read.length ? [`Reviewed checks read ${read.join('; ')}: type the data they read with \`\${journey.run}\` in place of \`${RUN}\`.`] : []),
    next ? `\`journey.run\` names an element or a \`waitForURL\` address only from milestone ${next.id} on, after milestone ${steps[first].id}'s reviewed check shows or reads \`${RUN}\`: before it, a blocked save makes the action fail instead of the check. Name this run's data by \`journey.run\` there only while that check fails with nothing saved; when the page shows the typed text before it is saved, as a live preview does, locate by names that stay the same across runs.`
      : `\`journey.run\` names no element or address in this journey, as no milestone follows one whose reviewed check shows or reads \`${RUN}\`: type it only with \`fill\`, \`type\` or \`pressSequentially\`.`,
    '`page.goto` takes a literal URL or path; `journey.run` never makes its address.',
  ];
}
/**
 * The code rules of a generated spec: the grammar validateJourneySpec accepts, in the generator's terms. Runs share the
 * application's data, so data a later check reads holds the run's token, never a value an earlier run stored.
 */
export function generationRules(item: Pick<ApprovedCase, 'name' | 'steps' | 'assertions'>, { signIn }: { signIn: boolean }) {
  return [
    "Write JavaScript. The file starts with `import { test } from 'perpetual';` and imports nothing else.",
    `It contains exactly one \`test(${JSON.stringify(line(item.name))}, async ({ page, journey }) => { … });\`, with no \`test.describe\`, hooks or other statements.`,
    "Wrap the actions of each numbered step in `await journey.milestone('<milestone id>', async () => { … });`, one call per step, in order, with the literal milestone id.",
    ...(signIn ? ['Start the first milestone with `await journey.signIn();`, as the seed signs in. Never type the test account yourself.'] : []),
    'The test starts on the application URL, as the seed does.',
    'Write actions only: each statement in a milestone is one awaited Playwright action on `page`, its locators, `page.keyboard` or `page.mouse`, with literal arguments. No variables, `expect` or other assertions, waits for text, `evaluate`, requests, loops or conditions: Perpetual evaluates the reviewed checks itself.',
    "Every run uses the same application data. When a step creates or changes data that a later check reads, type a value that includes `journey.run`, such as `` `QA ${journey.run}` ``, never a fixed literal that an earlier run may already have stored. `journey.run` is the run's token and the only value an argument may read, alone or in a template literal.",
    'A check never reads a form field the journey typed into or chose on the current page, nor the fields of a page reached with `goBack` or `goForward`: to see a saved value in a field, reload or open the page again.',
    ...runRules(item),
    "An entity or record URL observed during exploration belongs to that exploration, not to a future run. Reopen data created by this run through its visible links, using journey.run only where the rules allow it. Use `await page.reload();` to check persistence on the current record; never hard-code an explored record's URL in `page.goto`.",
    "Locate controls by names that stay the same across runs, apart from this run's own data where `journey.run` may name it: never by a fixed text this journey types or saves, nor by text an earlier run may have saved, such as a name shown in an account menu; when a control's name holds such text, use its stable part, such as a label, an email or a test id.",
    'Prefer role, label or id locators from the log.',
  ];
}

/** specs/plan.md in the generator's test plan format: goal, numbered steps with their milestone ids, and the code rules. */
export function generationPlan(item: Pick<GenerationCase, 'name' | 'goal' | 'steps' | 'assertions'>, { signIn }: { signIn: boolean }) {
  const name = line(item.name);
  return [`# ${name}`, '', `**Seed:** \`${SEED}\``, '', `**Seed project:** \`${SEED_PROJECT}\``, '', `Goal: ${line(item.goal)}`, '', `### 1. ${name}`, '', `#### 1.1 ${name}`, '', '**Steps:**',
    ...item.steps.map((step, index) => `${index + 1}. ${line(step.title)} (milestone id: ${step.id})`), '',
    '**Code rules (required):**', ...generationRules(item, { signIn }).map(rule => `- ${rule}`), ''].join('\n');
}

const setupPrompt = `Set up the page with generator_setup_page using \`project: "${SEED_PROJECT}"\` and \`seedFile: "${SEED}"\` for the scenario in \`${PLAN}\`.`;
export const generatePrompt = `${setupPrompt} Generate the test and write it with generator_write_test to \`${TARGET}\`. Follow the plan's code rules exactly.`;
/** A repair names only what validation rejected and the rules; the harness starts a new session for it. */
export const repairPrompt = (error: string, file: string, rules: string[]) => [`The test in \`${file}\` is invalid: ${error}`, '', 'Rules:', ...rules.map(rule => `- ${rule}`), '',
  `${setupPrompt} Then write the corrected test with generator_write_test to \`${file}\`.`].join('\n');

// The project is its own git root, so neither instructions nor files above it belong to it.
async function prepare({ project, run, home, item, targetUrl, timeoutSeconds, model, signIn, values, userHome, signal }: {
  project: string; run: string; home: string; item: GenerationCase; targetUrl: string; timeoutSeconds: number; model: string;
  signIn: boolean; values: NodeJS.ProcessEnv; userHome: string; signal: AbortSignal;
}) {
  const seedDir = join(run, 'seed');
  for (const dir of [join(project, 'specs'), join(project, TESTS), seedDir, home]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = await writeJourneyWorkspace(run, { item, targetUrl, timeoutSeconds, video: false, projects: [
    { name: SEED_PROJECT, testDir: seedDir, testMatch: SEED },
    { name: TESTS, testDir: join(project, TESTS), testIgnore: '**' },
  ] });
  const seed = seedSpec(signIn);
  await writeFile(join(seedDir, SEED), seed);
  await writeFile(join(project, PLAN), generationPlan(item, { signIn }));
  const base = setupEnvironment(values, home);
  const setup = (command: string, args: string[], failure: string) => setupCommand(command, args, { cwd: project, env: base, signal, failure, cancelled: CANCELLED });
  await setup('git', ['init', '--quiet'], 'Git is required to generate code.');
  // Playwright writes its OpenCode agents for the pinned version, and finds the seed in the config's first project.
  await setup(process.execPath, [PLAYWRIGHT_CLI, 'init-agents', '--loop=opencode', '--config', config], 'Playwright could not write its generator agent.');
  const file = join(project, 'opencode.json');
  const opencode = record(JSON.parse(await readFile(file, 'utf8'))), agent = record(record(opencode?.agent)?.[GENERATOR_AGENT]);
  const tools = record(agent?.tools), server = record(record(opencode?.mcp)?.['playwright-test']);
  if (!opencode || !agent || !tools || !server) throw new Error('Playwright could not write its generator agent.');
  // `opencode run --agent` runs a primary agent. It gets Playwright's tool list and nothing else, so no shell, edit or
  // web tool can read the harness environment, and files outside the project stay closed.
  Object.assign(agent, { mode: 'primary', model: `openrouter/${model}`, tools: { '*': false, ...tools } });
  // The test MCP server is the pinned Playwright, headless, on the seed's config; npx would fetch another version.
  // OpenCode starts it with its own environment and this one on top: the user's HOME, where Playwright's browsers are,
  // and no model key.
  Object.assign(server, {
    command: [process.execPath, PLAYWRIGHT_CLI, 'run-test-mcp-server', '--headless', '--config', config],
    environment: { HOME: userHome, OPENROUTER_API_KEY: '' },
  });
  Object.assign(opencode, opencodeSettings({ model, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' } }));
  await writeFile(file, `${JSON.stringify(opencode, null, 2)}\n`);
  // Nothing writes these again: they are read-only, and an attempt's spec is accepted only while they are unchanged.
  const kept = [config, join(run, 'case.json'), join(run, 'node_modules', 'perpetual', 'package.json'), join(run, 'node_modules', 'perpetual', 'index.mjs'), join(seedDir, SEED),
    file, join(project, '.opencode', 'prompts', `${GENERATOR_AGENT}.md`), join(project, PLAN)];
  await Promise.all(kept.map(path => chmod(path, 0o444)));
  return { seed, kept: await fingerprint(kept) };
}

/**
 * Runs the seed once as a journey runs, with the Playwright runtime and no model, so a generation whose seed cannot sign
 * in stops before the generator spends a model call writing locators for pages it never saw. The fixture says why; a
 * seed that stopped before its sign-in began, as when the application does not load, says the application could not
 * be opened instead.
 */
async function seedSignsIn(playwright: SeedRuntime, input: Pick<JourneyRunInput, 'case' | 'spec' | 'targetUrl' | 'timeoutSeconds' | 'allowedOrigins' | 'credentials' | 'signInUrl'>, signal: AbortSignal) {
  if (signal.aborted) throw new Error(CANCELLED);
  let facts: unknown = null, signing = false;
  const job = playwright.start({ mode: 'run', ...input }, event => {
    if (event.type === 'result') facts = event.result;
    // The reporter lists journey.signIn() as an action once it starts.
    else if (event.type === 'case' && Array.isArray(event.actions)) signing ||= event.actions.some(action => record(action)?.type === SIGN_IN_ACTION);
  });
  const cancel = () => job.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  // A cancelled seed still reports a browser that outlived it, so its twin is marked uncertain, as the generator's is.
  try { await job.promise; } catch (error) { if (signal.aborted) throw Object.assign(new Error(CANCELLED), (error as { cleanupIncomplete?: unknown } | null)?.cleanupIncomplete === true ? { cleanupIncomplete: true } : {}); throw error; } finally { signal.removeEventListener('abort', cancel); }
  if (signal.aborted) throw new Error(CANCELLED);
  const reported = record(facts);
  if (reported?.stopCause === 'none') return;
  const reason = typeof reported?.error === 'string' && reported.error.trim() ? reported.error : 'The seed stopped before it signed in.';
  throw new Error(`${signing ? 'The test account could not sign in' : 'The application could not be opened'}: ${reason}`);
}

// Every test file the generator wrote, all in tests.
async function writtenSpecs(project: string) {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path);
    }
  };
  await walk(join(project, TESTS), 0);
  return found;
}

// The one spec an attempt wrote: its code once valid, else what validation rejected. A repair may leave the
// earlier file beside a new one; only files written since the attempt began count then.
async function readSpec(project: string, item: GenerationCase, since: number): Promise<AttemptSpec> {
  let files = await writtenSpecs(project);
  if (files.length > 1) files = (await Promise.all(files.map(async file => (await lstat(file)).mtimeMs >= since ? file : null))).filter((file): file is string => Boolean(file));
  if (files.length !== 1) return { file: TARGET, error: files.length ? `Write one test file; found ${files.map(file => relative(project, file)).join(', ')}.` : 'No test file was written.' };
  const [path] = files, file = relative(project, path), info = await lstat(path);
  if (!info.isFile() || info.size > MAX_SPEC) return { file, error: 'Provide a spec of at most 200 KB.' };
  const code = await readFile(path, 'utf8');
  try { return { file, code: validateJourneySpec(code, item) }; } catch (error) { return { file, error: (error as Error).message, rejected: code }; }
}

/**
 * Generates a reviewed case's spec in a private workspace the caller owns and removes. The model key reaches only
 * OpenCode's environment and the test account only the harness's and the seed's, and every captured output is redacted.
 * With an account, the seed must first sign in, on the sign-in page when one is set, as it does for the generator.
 * Resolves { code, provenance } with code validateJourneySpec accepts; after one invalid attempt the harness repairs once
 * with the validation error.
 */
export function generateJourneySpec({ workspace, item, targetUrl, allowedOrigins, timeoutSeconds, credentials, signInUrl, apiKey, model, harness = opencodeHarness, playwright = createPlaywrightRuntime(), env = process.env, timeoutMs = 10 * 60 * 1000, cleanupGraceMs = 15000, onStep = () => {} }: GenerationOptions): WorkerJob<GeneratedSpec> {
  const abort = new AbortController(), secrets = [apiKey, credentials?.password];
  let runner: OpencodeRunner | null = null;
  const promise = (async () => {
    onStep('preparing');
    const values = typeof env === 'function' ? env() : env, signIn = Boolean(credentials), userHome = values.HOME || homedir();
    // Real paths, as the test MCP server compares its root and the config's test folders.
    const { project, run, home } = workspaceFolders(await realpath(workspace));
    const { seed, kept } = await prepare({ project, run, home, item, targetUrl, timeoutSeconds, model, signIn, values, userHome, signal: abort.signal });
    const intact = async () => { if (!isDeepStrictEqual(await fingerprint(Object.keys(kept)).catch(() => null), kept)) throw new Error('The code generation workspace changed.'); };
    if (credentials) await seedSignsIn(playwright, { case: item, spec: { code: seed, hash: specHash(seed) }, targetUrl, allowedOrigins, timeoutSeconds, credentials, ...(signInUrl ? { signInUrl } : {}) }, abort.signal);
    const childEnv = {
      // The seed runs as a journey does, without reporting: its hash is the one the fixture accepts.
      ...journeyEnvironment(values, run, { hash: specHash(seed), targetUrl, allowedOrigins, credentials, signInUrl, events: false }),
      ...opencodeEnvironment(values, { home, userHome, apiKey }),
    };
    if (abort.signal.aborted) throw new Error(CANCELLED);
    const agent = runner = createOpencodeRunner({ harness, model, cwd: project, env: childEnv, secrets, timeoutMs, cleanupGraceMs, settleMs: SETTLE_MS, messages: MESSAGES });
    onStep('generating');
    let since = Date.now();
    const first = await agent.run(generatePrompt);
    await intact();
    let result = await readSpec(project, item, since);
    if (result.error) {
      onStep('repairing');
      since = Date.now();
      const repair = await agent.run(repairPrompt(result.error, result.file, generationRules(item, { signIn })));
      await intact();
      result = await readSpec(project, item, since);
      // The rejected code stays with the failure, so a person can see what the generator wrote.
      if (result.error) {
        // A harness may exit successfully after reporting a tool/provider failure without writing a file.
        // Its output was already redacted by the runner; keep both bounded tails before removing the workspace.
        const diagnostics = !result.rejected ? [first, repair].map(({ output }, index) => output ? `${index ? 'Repair' : 'Generation'}: ${line(output).slice(-300)}` : '').filter(Boolean).join(' ') : '';
        throw Object.assign(new Error(agent.hide(`The generated code is invalid: ${result.error}${diagnostics ? ` ${diagnostics}` : ''}`).slice(0, 800)), result.rejected ? { rejected: agent.hide(result.rejected).slice(0, MAX_REJECTED) } : {});
      }
    }
    // A spec without an error is the validated code.
    return { code: result.code!, provenance: { harness: OPENCODE, generator: `${GENERATOR_AGENT}@${PLAYWRIGHT_VERSION}`, model: `openrouter/${model}` } };
  })();
  return { promise, cancel() { abort.abort(); runner?.cancel(); } };
}
