import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import aiPackage from 'ai/package.json' with { type: 'json' };
import { AUTHOR_HARNESSES, AUTHOR_LOOP, CANCELLED, FACTS, LOOP, UNWRITTEN, authorTwinConfig, authoringPrompt, loopHarness, opencodeHarness, selectedAuthorHarness, twinInstructions } from '../src/twin/authoring.ts';
import { CHANGE_APPROACH, CONTEXT_FULL, ERROR_MESSAGE_CHARS, FORCED_WRITE_STEP, LIMITS, PROVIDER_STOPPED, authorLoop, isMainModule, openrouterModel } from '../src/twin/author-loop.ts';
import { OPENCODE } from '../src/agents/opencode.ts';
import type { Harness } from '../src/agents/opencode.ts';
import { evidenceText, repositoryFacts } from '../src/environments/evidence.ts';
import { scriptedLoopHarness, scriptedModel } from './fixtures/scripted-model.ts';
import { services } from './fixtures/twin/services.ts';
import type { LoopOptions } from '../src/twin/author-loop.ts';
import type { ModelCall, ScriptedStep } from './fixtures/scripted-model.ts';

// The twin author loop with scripted models in place of OpenRouter's: no network, no model, no Docker.
const KEY = 'sk-or-v1-fixture-loop-key-8841', MODEL = 'vendor/model-1';
const FIXTURE = fileURLToPath(new URL('./fixtures/scripted-author-loop.ts', import.meta.url));
const APP_SOURCE = '// A fixture app; nothing runs it.\nexport const port = process.env.FIXTURE_PORT;\n';
const app = { directory: '.', start: 'node app.mjs', port: 3000 };
const draft = `${JSON.stringify({ services: {}, apps: { web: app } }, null, 2)}\n`;
const valid = `${JSON.stringify({ services: { database: {} }, apps: { web: { ...app, env: { STORE_URL: '{{database.DATABASE_URL}}' } } } }, null, 2)}\n`;
/** A config whose app id has an underscore, which the controller refuses. */
const invalid = JSON.stringify({ services: { database: {} }, apps: { web_app: app } });
const INVALID_ERROR = 'App id "web_app" must use lowercase letters, digits and single hyphens, such as "web-app".';
const write = (text: string) => ({ tool: 'write_config', input: { text } });
const call = (tool: string, input: unknown) => ({ calls: [{ tool, input }] });
const done = call('done', {});

type Logged = { model: string; prompt: ModelCall['prompt']; toolChoice: ModelCall['toolChoice']; tools: string[] };
type ToolMessage = { role: string; content: { type: string; output?: { type: string; value: unknown }; providerOptions?: unknown }[] };
/** The tool results a model received with its call. */
const received = (call: Pick<ModelCall, 'prompt'>) => ((call.prompt.at(-1) as ToolMessage).content).map(part => part.output?.value);
const jsonLines = async <Line>(file: string): Promise<Line[]> => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Line);

/** Cancelling an in-flight request needs evidence that startup reached the model, not a one-second guess. */
async function waitForModelCall(calls: () => Promise<unknown[]>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await calls()).length) return;
    await delay(20);
  }
  throw new Error('The fixture author did not reach its model request.');
}

/** An authoring workspace as the controller prepares one: the project with its instructions, evidence, draft and repo/. */
async function workspace(t: TestContext, files: Record<string, string> = {}) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-loop-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const project = join(path, 'project');
  const all = { 'TWIN.md': twinInstructions(services), 'EVIDENCE.md': '# Repository evidence\n', 'twin.json': draft, 'repo/package.json': '{ "name": "fixture" }\n', 'repo/app.mjs': APP_SOURCE, ...files };
  for (const [file, text] of Object.entries(all)) { await mkdir(dirname(join(project, file)), { recursive: true }); await writeFile(join(project, file), text); }
  return { path, project };
}

/** The loop in this process with a scripted model: its exit code, output lines by stream and the model's calls. */
async function loop(t: TestContext, steps: ScriptedStep[], { files, ...options }: { files?: Record<string, string> } & Partial<LoopOptions> = {}) {
  const { path, project } = await workspace(t, files);
  const model = scriptedModel(steps), out: string[] = [], err: string[] = [];
  const code = await authorLoop({ workspace: path, prompt: 'Go', model, services, print: (line, stream) => (stream === 'stdout' ? out : err).push(line), ...options });
  return { code, out, err, calls: model.doGenerateCalls, project, config: () => readFile(join(project, 'twin.json'), 'utf8') };
}

/** One attempt of authorTwinConfig with the loop's harness and a scripted model, as the controller runs it. */
async function attempt(t: TestContext, steps: ScriptedStep[], { feedback = null, facts = true, harness, env = {} }: { feedback?: string | null; facts?: boolean; harness?: Harness; env?: NodeJS.ProcessEnv } = {}) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-loop-attempt-')));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repo = join(dataDir, 'repo'), workspacePath = join(dataDir, 'workspace'), script = join(dataDir, 'script.json'), log = join(dataDir, 'calls.jsonl');
  await mkdir(repo); await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { start: 'node app.mjs' } }));
  await writeFile(join(repo, 'app.mjs'), APP_SOURCE);
  await writeFile(script, JSON.stringify(steps));
  const known = await repositoryFacts({ source: repo, draft, services }), evidence = evidenceText(known, draft);
  const job = authorTwinConfig({ workspace: workspacePath, source: repo, draft, evidence, ...(facts ? { facts: known } : {}), feedback, apiKey: KEY, model: MODEL, services,
    env: { PATH: process.env.PATH, HOME: join(dataDir, 'home'), ...env }, cleanupGraceMs: 2000, harness: harness ?? scriptedLoopHarness(script, log) });
  return { job, evidence, calls: () => jsonLines<Logged>(log) };
}

/** The loop's process, run directly with the key in its environment: its exit code and each stream's lines. */
async function loopProcess(t: TestContext, steps: ScriptedStep[], { signal }: { signal?: (pid: number) => void } = {}) {
  const { path } = await workspace(t);
  const script = join(path, 'script.json'), log = join(path, 'calls.jsonl');
  await writeFile(script, JSON.stringify(steps));
  return new Promise<{ code: number | null; stdout: string[]; stderr: string[] }>(resolve => {
    const child = execFile(process.execPath, [FIXTURE, script, log, path, MODEL, 'Go'], { env: { PATH: process.env.PATH, OPENROUTER_API_KEY: KEY } }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: stdout.split('\n').filter(Boolean), stderr: stderr.split('\n').filter(Boolean) }));
    if (signal && child.pid !== undefined) {
      const pid = child.pid;
      void waitForModelCall(() => jsonLines(log)).then(() => signal(pid), () => child.kill('SIGKILL'));
    }
  });
}

test('the loop harness runs this Node.js with the loop module, the workspace around the project, the model id and the prompt', () => {
  assert.deepEqual(loopHarness({ model: `openrouter/${MODEL}`, prompt: 'Go', cwd: '/data/authoring/abc/project' }),
    { command: process.execPath, args: [AUTHOR_LOOP, '/data/authoring/abc', MODEL, 'Go'], env: { NODE_USE_ENV_PROXY: '1' } });
  assert.equal(LOOP, `perpetual-loop@${aiPackage.version}`);
  assert.equal(aiPackage.version, '7.0.116');
});

test('the loop module runs as a process with OpenRouter’s model, which needs the key in its environment', async t => {
  const model = openrouterModel(MODEL, KEY);
  assert.deepEqual([model.provider, model.modelId, model.settings], ['openrouter', MODEL, { usage: { include: true } }]);
  const { path } = await workspace(t);
  const run = (args: string[]) => new Promise<{ code: unknown; stderr: string }>(resolve =>
    execFile(process.execPath, [AUTHOR_LOOP, ...args], { env: { PATH: process.env.PATH } }, (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
  assert.deepEqual(await run([path, MODEL, 'Go']), { code: 1, stderr: 'OPENROUTER_API_KEY is not set.\n' });
  assert.deepEqual(await run([path]), { code: 1, stderr: 'Usage: node author-loop.ts <workspace> <model id> <prompt>\n' });
});

test('the loop module runs itself only as the process’s entry point, named through a link or not, on every Node.js 24', async t => {
  const moduleUrl = pathToFileURL(AUTHOR_LOOP).href, { path } = await workspace(t);
  await symlink(AUTHOR_LOOP, join(path, 'linked-loop.ts'));
  assert.equal(isMainModule(moduleUrl, AUTHOR_LOOP), true);
  assert.equal(isMainModule(moduleUrl, join(path, 'linked-loop.ts')), true);
  assert.equal(isMainModule(moduleUrl, FIXTURE), false, 'A script that imports the module runs its own process.');
  assert.equal(isMainModule(moduleUrl, undefined), false);
  assert.equal(isMainModule(moduleUrl, join(path, 'missing.ts')), false);
});

test('the loop’s process sends its requests through the proxy the controller’s environment names', async t => {
  // A proxy that records each request and forwards none, so nothing leaves this machine.
  const requests: string[] = [];
  const proxy = createServer(socket => socket.once('data', data => { requests.push(data.toString().split('\r\n')[0]); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const { port } = proxy.address() as { port: number };
  // The loop's command as its harness gives it, environment and all, with a request of Node.js's fetch, which the
  // model's provider uses, in place of the loop's module. The host never resolves, so only a proxy can take it.
  const probe: Harness = input => ({ ...loopHarness(input), args: ['--input-type=module', '--eval', "await fetch('https://perpetual-proxy-probe.invalid/').catch(() => {});"] });
  const { job } = await attempt(t, [], { harness: probe, env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } });
  assert.equal((await job.promise).reason, UNWRITTEN.reason);
  assert.deepEqual(requests, ['CONNECT perpetual-proxy-probe.invalid:443 HTTP/1.1']);
});

test('PERPETUAL_TWIN_AUTHOR selects the loop, and OpenCode stays the default', () => {
  assert.deepEqual(selectedAuthorHarness({}), { harness: opencodeHarness, name: OPENCODE });
  assert.equal(selectedAuthorHarness({ PERPETUAL_TWIN_AUTHOR: 'opencode' }), AUTHOR_HARNESSES.opencode);
  assert.deepEqual(selectedAuthorHarness({ PERPETUAL_TWIN_AUTHOR: 'loop' }), { harness: loopHarness, name: LOOP });
  assert.throws(() => selectedAuthorHarness({ PERPETUAL_TWIN_AUTHOR: 'shell' }), /^Error: PERPETUAL_TWIN_AUTHOR must be opencode or loop\.$/);
});

test('through the harness, an invalid write is refused within the attempt and a valid one is twin.json when the model is done', async t => {
  const { job, evidence, calls } = await attempt(t, [call('read', { path: 'repo/package.json' }), { calls: [write(invalid)] }, { calls: [write(valid)], cost: 0.0025 }, done]);
  const written = await job.promise;
  assert.equal(written.error, undefined);
  assert.equal(written.text, valid);
  assert.deepEqual(written.logs?.split('\n'), ['→ read repo/package.json', `✗ write_config: ${INVALID_ERROR}`, '✓ write_config', '✓ done', 'Usage: 4 steps, 400 input tokens, 80 output tokens, $0.002500.']);
  const [first, second, third, fourth, ...more] = await calls();
  assert.equal(more.length, 0);
  assert.equal(first.model, MODEL, 'The harness passes the OpenRouter model id without its prefix.');
  // TWIN.md and EVIDENCE.md are the instructions, the attempt's prompt the user's message, and the tools the only capabilities.
  assert.deepEqual(first.prompt.slice(0, 2), [{ role: 'system', content: `${twinInstructions(services)}\n\n${evidence}` }, { role: 'user', content: [{ type: 'text', text: authoringPrompt(false) }] }]);
  assert.deepEqual(first.tools, ['list', 'read', 'grep', 'write_config', 'done']);
  assert.deepEqual(first.toolChoice, { type: 'auto' });
  assert.deepEqual(received(second), [{ ok: true, path: 'repo/package.json', lines: 1, content: `1\t${JSON.stringify({ name: 'fixture', scripts: { start: 'node app.mjs' } })}`, truncated: false }]);
  assert.deepEqual(received(third), [{ ok: false, error: INVALID_ERROR }]);
  // A valid write returns the unwired variables recomputed from what it wrote.
  assert.deepEqual(received(fourth), [{ ok: true, unwired: ['- `web`: FIXTURE_PORT'] }]);
});

test('the loop’s prompt carries feedback.md after the attempt’s prompt, and a write leaves unwired variables out without facts', async t => {
  const feedback = '# Attempt 1 of 4: refused\n\n- Stage: `valid`\n';
  const { job, calls } = await attempt(t, [{ calls: [write(valid)] }, done], { feedback, facts: false });
  assert.equal((await job.promise).text, valid);
  const [first, second] = await calls();
  assert.deepEqual(first.prompt[1], { role: 'user', content: [{ type: 'text', text: `${authoringPrompt(true)}\n\n${feedback}` }] });
  assert.deepEqual(received(second), [{ ok: true }]);
});

test('the loop reads only inside the project: a parent path, an absolute path and a link out are refused, a link inside is not', async t => {
  const outside = join(tmpdir(), 'perpetual-loop-outside.txt');
  const { path, project } = await workspace(t);
  await writeFile(join(path, 'outside.txt'), 'secret outside\n');
  await symlink(join(path, 'outside.txt'), join(project, 'repo', 'link.txt'));
  await symlink(path, join(project, 'repo', 'up'));
  await symlink('package.json', join(project, 'repo', 'alias.json'));
  const model = scriptedModel([
    { calls: [{ tool: 'read', input: { path: '../../etc/passwd' } }, { tool: 'read', input: { path: '/etc/passwd' } }, { tool: 'read', input: { path: outside } }, { tool: 'read', input: { path: 'repo/link.txt' } }] },
    { calls: [{ tool: 'list', input: { path: 'repo/up' } }, { tool: 'list', input: { path: '..' } }, { tool: 'grep', input: { pattern: 'secret', path: 'repo/up' } }, { tool: 'read', input: { path: 'repo/alias.json' } }] },
    { calls: [{ tool: 'grep', input: { pattern: 'secret|fixture', path: 'repo' } }, { tool: 'list', input: { path: 'repo' } }] },
  ]);
  const out: string[] = [];
  assert.equal(await authorLoop({ workspace: path, prompt: 'Go', model, services, print: line => out.push(line) }), 0);
  const calls = model.doGenerateCalls;
  assert.deepEqual(received(calls[1]), [
    { ok: false, error: '../../etc/passwd is outside the workspace.' },
    { ok: false, error: '/etc/passwd is absolute; name a path relative to the workspace, such as repo/package.json.' },
    { ok: false, error: `${outside} is absolute; name a path relative to the workspace, such as repo/package.json.` },
    { ok: false, error: 'repo/link.txt leads outside the workspace.' },
  ]);
  assert.deepEqual(received(calls[2]), [
    { ok: false, error: 'repo/up leads outside the workspace.' }, { ok: false, error: '.. is outside the workspace.' }, { ok: false, error: 'repo/up leads outside the workspace.' },
    { ok: true, path: 'repo/alias.json', lines: 1, content: '1\t{ "name": "fixture" }', truncated: false },
  ]);
  // A search never follows a link, so the file outside is not searched through repo/link.txt or repo/up.
  assert.deepEqual(received(calls[3]), [
    { ok: true, path: 'repo', matches: ['repo/app.mjs:1: // A fixture app; nothing runs it.', 'repo/package.json:1: { "name": "fixture" }'], truncated: false },
    { ok: true, path: 'repo', entries: ['alias.json@', 'app.mjs', 'link.txt@', 'package.json', 'up@'], truncated: false },
  ]);
  assert.deepEqual(out.slice(0, 4), ['✗ read ../../etc/passwd: ../../etc/passwd is outside the workspace.', '✗ read /etc/passwd: /etc/passwd is absolute; name a path relative to the workspace, such as repo/package.json.',
    `✗ read ${outside}: ${outside} is absolute; name a path relative to the workspace, such as repo/package.json.`, '✗ read repo/link.txt: repo/link.txt leads outside the workspace.']);
  assert.equal(await readFile(join(path, 'outside.txt'), 'utf8'), 'secret outside\n');
});

test('reads page by line with a truncated flag, and grep filters by a glob and caps its matches', async t => {
  const long = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join('\n');
  const matches = Array.from({ length: 150 }, (_, index) => `export const value${index} = 'needle';`).join('\n');
  const { calls, out } = await loop(t, [
    { calls: [{ tool: 'read', input: { path: 'repo/long.txt' } }, { tool: 'read', input: { path: 'repo/long.txt', offset: 2400, limit: 50 } }, { tool: 'read', input: { path: 'repo', offset: 0 } }] },
    { calls: [{ tool: 'grep', input: { pattern: 'needle', path: 'repo', include: '*.ts' } }, { tool: 'grep', input: { pattern: 'needle', path: 'repo', include: 'src/*.js' } }, { tool: 'grep', input: { pattern: '(', path: 'repo' } }] },
  ], { files: { 'repo/long.txt': long, 'repo/src/many.ts': matches, 'repo/src/one.js': "'needle'\n", 'repo/image.png': '\0PNG' } });
  const [whole, page, folder] = received(calls[1]) as Record<string, unknown>[];
  assert.equal(whole.lines, 2500); assert.equal(whole.truncated, true); assert.equal(whole.next, 2001);
  assert.equal((whole.content as string).split('\n').length, 2000);
  assert.deepEqual(page, { ok: true, path: 'repo/long.txt', lines: 2500, content: Array.from({ length: 50 }, (_, index) => `${2400 + index}\tline ${2400 + index}`).join('\n'), truncated: true, next: 2450 });
  assert.deepEqual(folder, { ok: false, error: 'offset and limit are whole numbers from 1.' });
  const [typed, below, broken] = received(calls[2]) as Record<string, unknown>[];
  assert.equal((typed.matches as string[]).length, LIMITS.matches); assert.equal(typed.truncated, true);
  assert.equal((typed.matches as string[])[0], "repo/src/many.ts:1: export const value0 = 'needle';");
  assert.deepEqual(below, { ok: true, path: 'repo', matches: ["repo/src/one.js:1: 'needle'"], truncated: false });
  assert.match(String(broken.error), /^The pattern is not a regular expression: /);
  assert.deepEqual(out.slice(0, 6), ['→ read repo/long.txt', '→ read repo/long.txt:2400', '✗ read repo: offset and limit are whole numbers from 1.',
    '→ grep "needle" in repo (*.ts)', '→ grep "needle" in repo (src/*.js)', `✗ grep "(" in repo: ${String(broken.error)}`]);
});

test('repository reads protect complete text before selecting lines, searching or clipping', async t => {
  const body = 'private-material-offset-must-not-leave', known = `known-exact-value-${'z'.repeat(100)}`;
  const source = `notes\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n${'x'.repeat(LIMITS.lineChars - 5)}${known}\n`;
  const { calls, project } = await loop(t, [{ calls: [
    { tool: 'read', input: { path: 'repo/notes.txt', offset: 3, limit: 1 } },
    { tool: 'read', input: { path: 'repo/notes.txt', offset: 5 } },
    { tool: 'grep', input: { path: 'repo/notes.txt', pattern: body } },
    { tool: 'grep', input: { path: 'repo/notes.txt', pattern: 'REDACTED' } },
  ] }], { files: { 'repo/notes.txt': source }, secrets: [known] });
  const [offset, clipped, secretSearch, protectedSearch] = received(calls[1]) as Record<string, unknown>[];
  assert.equal(offset.content, '3\t[REDACTED]', 'A PEM body stays protected when its header is outside the requested page.');
  assert.equal(clipped.content, `5\t${'x'.repeat(LIMITS.lineChars - 5)}[REDA…`, 'Known values are hidden before a line clip can leave their prefix.');
  assert.deepEqual(secretSearch.matches, [], 'Search matches the protected observation, never the raw credential.');
  assert.deepEqual((protectedSearch.matches as string[]).slice(0, 3), ['repo/notes.txt:2: [REDACTED]', 'repo/notes.txt:3: [REDACTED]', 'repo/notes.txt:4: [REDACTED]']);
  assert.doesNotMatch(JSON.stringify(received(calls[1])), /private-material|known-exact/);
  assert.equal(await readFile(join(project, 'repo/notes.txt'), 'utf8'), source, 'Observation protection never rewrites the repository.');
});

test('a supplied multiline value preserves later source line numbers in read and grep', async t => {
  const known = 'caller-only-first-line\ncaller-only-second-line';
  const source = `heading\n${known}\nconst result = 42;\n`;
  const { calls } = await loop(t, [{ calls: [
    { tool: 'read', input: { path: 'repo/notes.txt', offset: 4, limit: 1 } },
    { tool: 'grep', input: { path: 'repo/notes.txt', pattern: 'const result' } },
  ] }], { files: { 'repo/notes.txt': source }, secrets: [known] });
  assert.deepEqual(received(calls[1]), [
    { ok: true, path: 'repo/notes.txt', lines: 4, content: '4\tconst result = 42;', truncated: false },
    { ok: true, path: 'repo/notes.txt', matches: ['repo/notes.txt:4: const result = 42;'], truncated: false },
  ]);
});

test('credential-shaped multiline text preserves later source line numbers', async t => {
  for (const [name, credential] of [
    ['named', 'API_KEY="neutral-first-line\nneutral-second-line"'],
    ['flag', 'command --api-key "neutral-first-line\nneutral-second-line"'],
    ['bearer', 'Bearer\nneutral-value'],
  ]) await t.test(name, async t => {
    const { calls } = await loop(t, [{ calls: [
      { tool: 'read', input: { path: 'repo/notes.txt', offset: 4, limit: 1 } },
      { tool: 'grep', input: { path: 'repo/notes.txt', pattern: 'const result' } },
    ] }], { files: { 'repo/notes.txt': `heading\n${credential}\nconst result = 42;\n` } });
    assert.deepEqual(received(calls[1]), [
      { ok: true, path: 'repo/notes.txt', lines: 4, content: '4\tconst result = 42;', truncated: false },
      { ok: true, path: 'repo/notes.txt', matches: ['repo/notes.txt:4: const result = 42;'], truncated: false },
    ]);
  });
});

test('initial instructions, evidence, prompt and feedback protect known values and credential shapes', async t => {
  const known = 'only-the-caller-knows-this-value', token = 'sk-observation-fixture-token-12345', body = 'private-feedback-body';
  const { calls } = await loop(t, [done], { secrets: [known], prompt: `Inspect ${known}`, files: {
    'TWIN.md': `Instructions ${known}`,
    'EVIDENCE.md': `Evidence ${token}`,
    'feedback.md': `Failure\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
  } });
  assert.deepEqual(calls[0].prompt.slice(0, 2).map(({ role, content }) => ({ role, content })), [
    { role: 'system', content: 'Instructions [REDACTED]\n\nEvidence [REDACTED]' },
    { role: 'user', content: [{ type: 'text', text: 'Inspect [REDACTED]\n\nFailure\n[REDACTED]\n[REDACTED]\n[REDACTED]' }] },
  ]);
});

test('the evidence keeps its credential-named variables with their lines, in the instructions and when it is read', async t => {
  const evidence = '# Repository evidence\n\n- SESSION_SECRET: `repo/app.mjs:1`\n- NPM_TOKEN: script, `repo/Dockerfile:2`\n';
  const { calls } = await loop(t, [call('read', { path: 'EVIDENCE.md' }), done], { files: { 'EVIDENCE.md': evidence } });
  assert.equal(calls[0].prompt[0].content, `${twinInstructions(services)}\n\n${evidence}`);
  assert.deepEqual(received(calls[1]), [{ ok: true, path: 'EVIDENCE.md', lines: 4, content: evidence.trimEnd().split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'), truncated: false }]);
});

test('tool paths, list entries, refusals and logs are protected before metadata is clipped', async t => {
  const known = `caller-only-value-${'m'.repeat(90)}`, token = 'sk-list-entry-fixture-12345', absolute = `/${'x'.repeat(190)}${known}`;
  const { calls, out } = await loop(t, [{ calls: [
    { tool: 'read', input: { path: absolute } },
    { tool: 'list', input: { path: 'repo' } },
    { tool: 'read', input: { path: `repo/${token}.txt` } },
    { tool: 'grep', input: { path: 'repo', pattern: `(${known}` } },
  ] }], { secrets: [known], files: { [`repo/${token}.txt`]: 'ordinary text' } });
  const [outside, listed, read, pattern] = received(calls[1]) as Record<string, unknown>[];
  assert.doesNotMatch(JSON.stringify([received(calls[1]), out]), /caller-only|sk-list-entry/, 'A metadata clip must not keep even the recognizable prefix.');
  assert.match(String(outside.error), /\[REDACTED/);
  assert.ok((listed.entries as string[]).includes('[REDACTED].txt'));
  assert.equal(read.path, 'repo/[REDACTED].txt');
  assert.match(String(pattern.error), /\[REDACTED\]/);
});

test('twin.json observations and accepted writes preserve legitimate templates and ordinary application values', async t => {
  const template = JSON.stringify({ services: { payments: {} }, apps: { web: { ...app, env: { PAYMENTS_KEY: '{{payments.PAYMENTS_KEY}}', SESSION_SECRET: 'fixture-secret-value', SOURCE_REFERENCE: 'process.env.TOKEN' } } } }, null, 2);
  const changed = template.replace('fixture-secret-value', 'fixture-changed-value');
  const { calls, config } = await loop(t, [
    { calls: [{ tool: 'read', input: { path: 'twin.json' } }, { tool: 'grep', input: { path: 'twin.json', pattern: 'PAYMENTS_KEY' } }] },
    { calls: [write(changed)] },
    call('read', { path: 'twin.json' }),
  ], { files: { 'twin.json': template } });
  const initial = received(calls[1]) as Record<string, unknown>[];
  assert.equal(initial[0].content, template.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'));
  assert.match(String((initial[1].matches as string[])[0]), /"PAYMENTS_KEY": "\{\{payments\.PAYMENTS_KEY\}\}"/);
  assert.deepEqual(received(calls[2]), [{ ok: true }]);
  assert.equal((received(calls[3])[0] as Record<string, unknown>).content, changed.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'));
  assert.equal(await config(), changed);
});

test('write_config refuses credential literals without replacing the prior draft', async t => {
  for (const literal of ['sk-twin-config-fixture-12345', 'a-value-only-the-caller-knows']) await t.test(literal.startsWith('sk-') ? 'catalogued' : 'supplied', async t => {
    const withLiteral = JSON.stringify({ apps: { web: { ...app, env: { CUSTOM_VALUE: literal } } } });
    const { calls, config } = await loop(t, [{ calls: [write(withLiteral)] }, call('read', { path: 'twin.json' })], { secrets: ['a-value-only-the-caller-knows'] });
    const refusal = received(calls[1])[0] as Record<string, unknown>;
    assert.equal(refusal.ok, false);
    assert.match(String(refusal.error), /credential literal.*service placeholder.*test input/i);
    assert.doesNotMatch(JSON.stringify(received(calls[1])), /sk-twin-config|a-value-only/);
    assert.equal((received(calls[2])[0] as Record<string, unknown>).content, draft.trimEnd().split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'));
    assert.equal(await config(), draft);
  });
});

test('an existing twin.json credential literal is refused before an offset read or grep exposes it', async t => {
  const withLiteral = JSON.stringify({ apps: { web: { ...app, env: { CUSTOM_VALUE: 'sk-existing-config-fixture-12345' } } } }, null, 2);
  const { calls, config } = await loop(t, [{ calls: [
    { tool: 'read', input: { path: 'twin.json', offset: 8, limit: 1 } },
    { tool: 'grep', input: { path: 'twin.json', pattern: 'CUSTOM_VALUE' } },
  ] }], { files: { 'twin.json': withLiteral } });
  for (const result of received(calls[1]) as Record<string, unknown>[]) {
    assert.equal(result.ok, false);
    assert.match(String(result.error), /credential literal.*service placeholder.*test input/i);
  }
  assert.doesNotMatch(JSON.stringify(received(calls[1])), /sk-existing-config/);
  assert.equal(await config(), withLiteral, 'An unsafe draft stays private and unchanged.');
});

test('unwired tool feedback protects original fact values before formatting them', async t => {
  const known = 'only-the-caller-knows\nthis-function-path', { path } = await workspace(t);
  const facts = { packages: [], reads: [], examples: {}, functions: [{ folder: `functions/${known}`, reads: [{ name: 'NEEDS_INPUT', file: 'functions/index.ts', line: 1, role: 'runtime' }] }] };
  await writeFile(join(path, FACTS), JSON.stringify(facts));
  const model = scriptedModel([{ calls: [write(valid)] }, done]);
  assert.equal(await authorLoop({ workspace: path, prompt: 'Go', model, services, secrets: [known], print: () => {} }), 0);
  assert.deepEqual(received(model.doGenerateCalls[1]), [{ ok: true, unwired: ['- `web`: none', '- Functions not served that read variables: `functions/[REDACTED] [REDACTED]`'] }]);
  assert.deepEqual(JSON.parse(await readFile(join(path, FACTS), 'utf8')), facts, 'Raw semantic facts remain unchanged.');
});

const OUT_OF_TIME = `The search took over ${LIMITS.searchMs / 1000} seconds; use a simpler pattern, include or a narrower path.`;

test('a pattern that backtracks without end stops at the search’s time limit', async t => {
  const started = Date.now();
  const { calls } = await loop(t, [call('grep', { pattern: '(a+)+b', path: 'repo' })], { files: { 'repo/input.txt': `${'a'.repeat(40)}c\n` } });
  assert.deepEqual(received(calls[1]), [{ ok: false, error: OUT_OF_TIME }]);
  assert.ok(Date.now() - started < LIMITS.searchMs + 3000);
});

test('include globs match names or paths below the searched folder, with one level of {a,b}, and others are refused', async t => {
  const files = { 'repo/src/a.ts': 'needle\n', 'repo/src/b.tsx': 'needle\n', 'repo/src/deep/c.ts': 'needle\n', 'repo/src/d.js': 'needle\n', 'repo/(group)/page.ts': 'needle\n', 'repo/.env': 'needle\n' };
  const grep = (include: string) => ({ tool: 'grep', input: { pattern: 'needle', path: 'repo', include } });
  const { calls } = await loop(t, [{ calls: [grep('*.{ts,tsx}'), grep('src/**/*.ts'), grep('(group)/*.ts'), grep('[!a-c].*'), grep('src/?.js'), grep('*.{ts,{tsx}}'), grep('[z-a]*')] }], { files });
  const found = (...paths: string[]) => ({ ok: true, path: 'repo', matches: paths.map(path => `repo/${path}:1: needle`), truncated: false });
  assert.deepEqual(received(calls[1]), [
    found('(group)/page.ts', 'src/a.ts', 'src/b.tsx', 'src/deep/c.ts'), found('src/a.ts', 'src/deep/c.ts'), found('(group)/page.ts'), found('src/d.js'), found('src/d.js'),
    { ok: false, error: 'include is a glob such as *.ts, src/**/*.{ts,tsx} or [!.]*: * and ? within a name, ** across folders, [...] and {a,b}.' },
    { ok: false, error: 'include is a glob such as *.ts, src/**/*.{ts,tsx} or [!.]*: * and ? within a name, ** across folders, [...] and {a,b}.' },
  ]);
});

test('an include glob costs what its expression does, and one that backtracks without end stops at the search’s time limit', async t => {
  // Expanding 17 groups of {a,b} would take Node.js’s own glob matching many seconds; as one expression it takes none.
  const files = { [`repo/${'ab'.repeat(15)}c`]: 'needle\n', [`repo/${'a'.repeat(30)}b`]: 'needle\n' };
  const timed = async (include: string) => {
    const started = Date.now(), { calls } = await loop(t, [call('grep', { pattern: 'needle', path: 'repo', include })], { files });
    return { result: received(calls[1]), took: Date.now() - started };
  };
  const braces = await timed('{a,b}'.repeat(17));
  assert.deepEqual(braces.result, [{ ok: true, path: 'repo', matches: [], truncated: false }]);
  assert.ok(braces.took < 1000, `A brace-heavy include returns at once, not in ${braces.took} ms.`);
  const backtracking = await timed('{a,a}'.repeat(30));
  assert.deepEqual(backtracking.result, [{ ok: false, error: OUT_OF_TIME }]);
  assert.ok(backtracking.took < LIMITS.searchMs + 3000);
});

test('write_config writes only a valid config, and the third identical failure asks for another approach', async t => {
  const refused = { ok: false, error: 'Add an app: the repository code the twin runs.' };
  const { calls, out, config } = await loop(t, [
    { calls: [write('{"apps": {}}')] }, { calls: [write('{"apps": {}}')] }, { calls: [write('{"apps": {} }')] }, { calls: [write('not json')] },
    { calls: [{ tool: 'write_config', input: { text: { apps: {} } } }, write(' '.repeat(256 * 1024) + '{}')] }, done,
  ]);
  assert.deepEqual(received(calls[1]), [refused]);
  assert.deepEqual(received(calls[2]), [refused]);
  assert.deepEqual(received(calls[3]), [{ ...refused, note: CHANGE_APPROACH }]);
  assert.match(String((received(calls[4])[0] as { error: string }).error), /^twin\.json is not valid JSON: /);
  assert.deepEqual(received(calls[5]), [{ ok: false, error: 'Pass the whole twin.json as text.' }, { ok: false, error: 'Keep twin.json under 256 KB.' }]);
  assert.equal(await config(), draft, 'No refused write reaches twin.json.');
  assert.equal(out.filter(line => line.startsWith('✗ write_config: ')).length, 6);
});

test('writes of one step apply in the order the model made them', async t => {
  const other = valid.replace('STORE_URL', 'OTHER_URL');
  const { calls, config, out } = await loop(t, [{ calls: [write(other), write(invalid), write(valid)] }, done]);
  assert.deepEqual(received(calls[1]), [{ ok: true }, { ok: false, error: INVALID_ERROR }, { ok: true }]);
  assert.equal(await config(), valid);
  assert.deepEqual(out.slice(0, 3), ['✓ write_config', `✗ write_config: ${INVALID_ERROR}`, '✓ write_config']);
});

test(`a model that has not written a valid config must write at step ${FORCED_WRITE_STEP}, once`, async t => {
  const reads = (count: number) => Array.from({ length: count }, () => call('list', { path: 'repo' }));
  const forced = { type: 'tool', toolName: 'write_config' }, auto = { type: 'auto' };
  // It writes when it must, and goes on.
  const complied = await loop(t, [...reads(FORCED_WRITE_STEP - 1), { calls: [write(valid)] }, ...reads(2), done]);
  assert.deepEqual(complied.calls.map(item => item.toolChoice), [...Array(FORCED_WRITE_STEP - 1).fill(auto), forced, auto, auto, auto]);
  assert.equal(complied.code, 0);
  assert.equal(await complied.config(), valid);
  // A model that already wrote a valid config is never forced; one that ignores the forced call ends its attempt.
  const early = await loop(t, [call('write_config', { text: valid }), ...reads(FORCED_WRITE_STEP + 1), done]);
  assert.ok(early.calls.every(item => item.toolChoice?.type === 'auto'));
  const ignored = await loop(t, reads(20).map(step => ({ ...step, cost: 0.001 })));
  assert.equal(ignored.calls.length, FORCED_WRITE_STEP);
  assert.deepEqual(ignored.calls.at(-1)?.toolChoice, forced);
  assert.equal(ignored.code, 0);
  // The answer that broke the forced write was paid for, so its tokens and cost count.
  assert.deepEqual(ignored.out.slice(-2), [`✗ write_config: the model wrote nothing at step ${FORCED_WRITE_STEP}, when it had to.`,
    `Usage: ${FORCED_WRITE_STEP} steps, ${FORCED_WRITE_STEP * 100} input tokens, ${FORCED_WRITE_STEP * 20} output tokens, $${(FORCED_WRITE_STEP * 0.001).toFixed(6)}.`]);
  assert.equal(await ignored.config(), draft);
});

test('reasoning and its provider metadata reach the next step as the provider returned them', async t => {
  const opaque = 'sk-provider-opaque-fixture-12345';
  const details = [{ type: 'reasoning.text', text: 'Read the manifest first.', signature: opaque, format: 'google-gemini-v1' }, { type: 'reasoning.encrypted', data: opaque }];
  const { calls } = await loop(t, [{ reasoning: { text: 'Read the manifest first.', details }, calls: [{ tool: 'read', input: { path: 'repo/package.json' } }] }, done], { secrets: [opaque] });
  const assistant = calls[1].prompt.find(message => message.role === 'assistant') as ToolMessage | undefined;
  const carried = { openrouter: { reasoning_details: details } };
  assert.deepEqual(assistant?.content.map(part => [part.type, part.providerOptions]), [['reasoning', carried], ['tool-call', carried]]);
});

test('a provider error exits 1 with the provider’s Error: line, and no line has the key', async t => {
  const { code, stdout, stderr } = await loopProcess(t, [call('read', { path: 'repo/package.json' }), { error: { status: 402, message: `This request requires more credits; key ${KEY}.` } }]);
  assert.equal(code, 1);
  assert.deepEqual(stderr, [PROVIDER_STOPPED, 'Error: {"code":402,"message":"This request requires more credits; key [REDACTED]."}']);
  assert.deepEqual(stdout, ['→ read repo/package.json', 'Usage: 1 step, 100 input tokens, 20 output tokens.']);
  assert.ok(![...stdout, ...stderr].some(line => line.includes(KEY)));
});

test('the controller maps the loop’s credits, key and request errors as it maps OpenCode’s, and stops generation', async t => {
  const cases = [
    [{ status: 402, message: 'This request requires more credits, or fewer max_tokens.' }, 'Add credits to your OpenRouter account and try again.'],
    [{ status: 401, message: 'No auth credentials found' }, 'Check your OpenRouter API key in Settings.'],
    [{ status: 400, message: 'Provider returned error' }, 'The selected model does not work with this agent. Choose another model in Settings.'],
    // A provider's long message, and a refusal OpenRouter answers with HTTP 200 and the code in its body, map alike.
    [{ status: 400, message: `[Google] ${'Function call is missing a thought_signature in functionCall parts. '.repeat(8)}` }, 'The selected model does not work with this agent. Choose another model in Settings.'],
    [{ status: 200, message: 'Provider returned error', data: { code: 400, message: 'Provider returned error' } }, 'The selected model does not work with this agent. Choose another model in Settings.'],
  ] as const;
  for (const [error, reason] of cases) {
    const { job } = await attempt(t, [{ error }]);
    await assert.rejects(job.promise, (failure: Error & { logs?: string }) => {
      assert.equal(failure.message, reason);
      assert.match(failure.logs ?? '', /Error: \{"code":\d+,"message":/);
      assert.ok(!failure.logs?.includes(KEY));
      return true;
    });
  }
});

test('a long provider error is redacted before it is clipped, so its Error: line holds no part of the key', async t => {
  // The key starts five characters before the clip, which would have kept its first five.
  const { code, stderr } = await loopProcess(t, [{ error: { status: 402, message: `${'x'.repeat(ERROR_MESSAGE_CHARS - 5)}${KEY} and more after it` } }]);
  assert.equal(code, 1);
  assert.equal(stderr[0], PROVIDER_STOPPED);
  const { code: status, message } = JSON.parse(stderr[1].replace(/^Error: /, '')) as { code: number; message: string };
  assert.deepEqual([status, message], [402, `${'x'.repeat(ERROR_MESSAGE_CHARS - 5)}[REDA…`]);
  assert.ok(!stderr.some(line => line.includes(KEY.slice(0, 5))));
});

test('a history that outgrows the model’s context ends the attempt with what it wrote, not as a refusal', async t => {
  const overflow = { error: { status: 400, message: 'This endpoint\'s maximum context length is 200000 tokens. However, you requested about 250000 tokens.' } };
  const { job } = await attempt(t, [{ calls: [write(valid)] }, overflow]);
  const written = await job.promise;
  assert.equal(written.error, undefined);
  assert.equal(written.text, valid);
  assert.deepEqual(written.logs?.split('\n'), ['✓ write_config', CONTEXT_FULL, 'Usage: 1 step, 100 input tokens, 20 output tokens.']);
});

test('provider errors protect credential shapes before clipping without a supplied secret value', async t => {
  const token = 'sk-provider-failure-fixture-12345', prefix = `${'x'.repeat(ERROR_MESSAGE_CHARS - 6)} `;
  const { code, err } = await loop(t, [{ error: { status: 402, message: `${prefix}${token}` } }]);
  assert.equal(code, 1);
  assert.equal(err[0], PROVIDER_STOPPED);
  assert.deepEqual(JSON.parse(err[1].replace(/^Error: /, '')), { code: 402, message: `${prefix}[REDA…` });
  assert.doesNotMatch(err.join('\n'), /sk-pr/);
});

test('SIGTERM stops the loop at once, so cancelling an attempt confirms its process stopped', async t => {
  const stopped = await loopProcess(t, [{ hang: true }], { signal: pid => process.kill(pid, 'SIGTERM') });
  assert.equal(stopped.code, 1);
  assert.deepEqual(stopped.stderr, ['The twin config author was stopped.']);
  const { job, calls } = await attempt(t, [{ hang: true }]);
  const settled = job.promise.then(() => undefined, () => undefined);
  t.after(async () => { job.cancel(); await settled; });
  await waitForModelCall(calls);
  job.cancel();
  await assert.rejects(job.promise, (failure: Error & { cleanupIncomplete?: true }) => {
    assert.equal(failure.message, CANCELLED);
    assert.equal(failure.cleanupIncomplete, undefined);
    return true;
  });
});

test('the loop’s own time limit ends it as its step limit does, with what it wrote', async t => {
  const { code, out, config } = await loop(t, [{ calls: [write(valid)] }, { hang: true }], { timeoutMs: 500 });
  assert.equal(code, 0);
  assert.deepEqual(out, ['✓ write_config', 'The twin config author reached its time limit.', 'Usage: 1 step, 100 input tokens, 20 output tokens.']);
  assert.equal(await config(), valid);
});
