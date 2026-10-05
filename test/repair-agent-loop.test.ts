import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENROUTER_OPTIONS, openrouterModels, runAttempt } from '../src/repair/agent.ts';
import { attemptPrompt, commitMessage, describeFailures, pullRequestBody, pullRequestTitle, repositoryDigest, INSTRUCTIONS, type FailedWorkflow } from '../src/repair/context.ts';
import { getGitHubFailure, type CommandRunner } from '../src/repair/github.ts';
import { brokenRepository, hostBox } from './fixtures/repair-box.ts';
import { scriptedModel, type ModelCall, type ScriptedStep } from './fixtures/scripted-model.ts';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
// The fix a capable model makes: reproduce, read, edit, pass, done.
const FIX: ScriptedStep[] = [
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }], cost: 0.01 },
  { calls: [{ tool: 'read', input: { path: 'add.js' } }], cost: 0.01 },
  { calls: [{ tool: 'edit', input: { path: 'add.js', old: 'a - b', new: 'a + b' } }], cost: 0.01 },
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }], cost: 0.01 },
  { calls: [{ tool: 'done', input: { summary: 'add() subtracted; it adds now. node check.js passes.' } }], cost: 0.01 },
];

async function workspace(t: TestContext) {
  const source = await mkdtemp(join(tmpdir(), 'perpetual-repair-loop-'));
  const sha = await brokenRepository(source);
  const made = await hostBox(source);
  t.after(async () => { await made.box.remove(); await rm(source, { recursive: true, force: true }); });
  return { ...made, source, sha };
}
const outputOf = (call: ModelCall) => JSON.stringify(call.prompt);

test('the loop reproduces the failure, edits, sees the command pass and ends at done, with its usage and cost', async t => {
  const f = await workspace(t);
  const calls: ModelCall[] = [];
  const result = await runAttempt({ model: scriptedModel(FIX, { onCall: call => calls.push(call) }), box: f.box, prompt: 'Fix the build.', signal: new AbortController().signal, failing: ['node check.js'] });
  assert.deepEqual([result.end, result.steps, result.reproduced, result.inputTokens, result.outputTokens], ['done', 5, true, 500, 100]);
  assert.equal(result.summary, 'add() subtracted; it adds now. node check.js passes.');
  assert.ok(Math.abs(result.cost - 0.05) < 1e-9);
  assert.equal(await readFile(join(f.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.match(outputOf(calls[1]), /returned -1, expected 5/, 'The failing run\'s output reaches the model.');
  assert.match(outputOf(calls[4]), /"exitCode":0/, 'The command passes before done.');
  const diff = (await f.box.diff(f.sha)).toString('utf8');
  assert.match(diff, /^-module\.exports = \(a, b\) => a - b;$/m);
  assert.match(diff, /^\+module\.exports = \(a, b\) => a \+ b;$/m);
  assert.deepEqual([...diff.matchAll(/^diff --git a\/(\S+)/gm)].map(match => match[1]), ['add.js']);
});

test('an attempt reproduced the failure only when the failing step\'s own command failed before any change', async t => {
  const f = await workspace(t);
  const attempt = async (steps: ScriptedStep[]) => (await runAttempt({ model: scriptedModel([...steps, { calls: [{ tool: 'done', input: { summary: 'Done.' } }] }]), box: f.box, prompt: 'x', signal: new AbortController().signal, failing: ['npm ci\nnode check.js'] })).reproduced;
  const run = (command: string): ScriptedStep => ({ calls: [{ tool: 'run', input: { command } }] });
  assert.equal(await attempt([run('cat missing-file'), run('ls nope')]), false, 'Another command that fails reproduces nothing.');
  assert.equal(await attempt([run('node check.js | tail -n 5')]), false, 'A pipeline that hides the exit code saw no failure.');
  assert.equal(await attempt([run('cd . && CI=true node check.js')]), true);
  assert.equal(await attempt([{ calls: [{ tool: 'write', input: { path: 'notes.txt', text: 'x\n' } }] }, run('node check.js')]), false, 'A failure seen after a change is not the original one.');
  const unknown = await runAttempt({ model: scriptedModel([run('node check.js')]), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.equal(unknown.reproduced, false, 'Without the failing step\'s command nothing can be compared.');
});

// Weaker models often finish with a message instead of calling done, and fixes made by a command count as well.
test('a model that stops without calling done ends done once its change, made through run, passes the failing step in the box', async t => {
  const f = await workspace(t);
  const signal = new AbortController().signal, failing = ['node check.js'];
  const viaRun = await runAttempt({ model: scriptedModel([{ calls: [{ tool: 'run', input: { command: 'sed -i.bak "s/a - b/a + b/" add.js && rm add.js.bak' } }] }, { text: 'Fixed.' }]), box: f.box, prompt: 'x', signal, failing, base: f.sha });
  assert.deepEqual([viaRun.end, viaRun.verified, (await f.box.diff(f.sha)).toString('utf8').includes('+module.exports = (a, b) => a + b;')], ['done', true, true]);
  const unchanged = await hostBox(f.source);
  t.after(() => unchanged.box.remove());
  const idle = await runAttempt({ model: scriptedModel([{ calls: [{ tool: 'run', input: { command: 'node check.js' } }] }, { text: 'It fails.' }]), box: unchanged.box, prompt: 'x', signal, failing, base: f.sha });
  assert.deepEqual([idle.end, idle.verified], ['idle', undefined], 'Without a change nothing is verified.');
});

test('every request routes with data collection denied and usage accounting on', async t => {
  const f = await workspace(t);
  const calls: ModelCall[] = [];
  await runAttempt({ model: scriptedModel(FIX, { onCall: call => calls.push(call) }), box: f.box, prompt: 'Fix the build.', signal: new AbortController().signal });
  assert.equal(calls.length, 5);
  for (const call of calls) assert.deepEqual(call.providerOptions?.openrouter, OPENROUTER_OPTIONS);
});

test('the OpenRouter provider sends data_collection deny and usage in the request body, and the key only in its header', async t => {
  const f = await workspace(t);
  const requests: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const replies = [
    { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ command: 'node check.js' }) } }] },
    { tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'Reproduced only.' }) } }] },
  ];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
    const message = replies[requests.length - 1];
    return new Response(JSON.stringify({ id: `gen-${requests.length}`, model: 'openai/gpt-6-luna', created: 1, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, ...message } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.02 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const result = await runAttempt({ model: openrouterModels({ fetch })('openai/gpt-6-luna', KEY), box: f.box, prompt: 'Fix the build.', signal: new AbortController().signal });
  assert.deepEqual([result.end, result.steps, result.inputTokens, result.outputTokens], ['done', 2, 240, 60]);
  assert.ok(Math.abs(result.cost - 0.04) < 1e-9, 'Cost is summed from OpenRouter\'s reported usage.');
  for (const request of requests) {
    assert.deepEqual(request.body.provider, { data_collection: 'deny' });
    assert.deepEqual(request.body.usage, { include: true });
    assert.equal(request.authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(request.body).includes(KEY));
  }
  assert.ok(!JSON.stringify(f.calls).includes(KEY) && !f.outputs.join('\n').includes(KEY), 'The key never enters a box command, its input or its output.');
});

test('a bring-your-own-key request counts the provider\'s own charge that OpenRouter reports beside its fee', async t => {
  const f = await workspace(t);
  const replies = [
    { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list', arguments: '{}' } }] },
    { tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'Listed.' }) } }] },
  ];
  let count = 0;
  const fetch = (async () => {
    const message = replies[count++];
    return new Response(JSON.stringify({ id: `gen-${count}`, model: 'openai/gpt-6-luna', created: 1, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, ...message } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const result = await runAttempt({ model: openrouterModels({ fetch })('openai/gpt-6-luna', KEY), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.ok(Math.abs(result.cost - 0.042) < 1e-9, String(result.cost));
});

test('a conversation that outgrows the model\'s context window ends the attempt, and is no refusal', async t => {
  const f = await workspace(t);
  const replies: Response[] = [
    new Response(JSON.stringify({ id: 'gen-1', model: 'openai/gpt-6-luna', created: 1, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.01 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ error: { code: 400, message: "This endpoint's maximum context length is 128000 tokens. However, you requested about 131072 tokens." } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  ];
  let count = 0;
  const fetch = (async () => replies[count++]) as typeof globalThis.fetch;
  const result = await runAttempt({ model: openrouterModels({ fetch })('openai/gpt-6-luna', KEY), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.deepEqual([result.end, result.refusal, result.steps], ['context', undefined, 1]);
  assert.match(result.error ?? '', /maximum context length/);
  const rejected = await runAttempt({ model: scriptedModel([{ error: { status: 400, message: 'Provider returned error: reasoning_details are not supported' } }]), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.equal(rejected.refusal, 'The selected model does not work with this agent. Choose another model in Settings.', 'Another request the model rejects is still a refusal.');
});

test('an attempt ends at its step limit, its time limit or the repair\'s remaining budget', async t => {
  const f = await workspace(t);
  const signal = new AbortController().signal;
  const listing = (cost?: number) => scriptedModel(() => ({ calls: [{ tool: 'list', input: {} }], cost }));
  const steps = await runAttempt({ model: listing(), box: f.box, prompt: 'x', signal, steps: 3 });
  assert.deepEqual([steps.end, steps.steps], ['steps', 3]);
  const time = await runAttempt({ model: scriptedModel([{ calls: [{ tool: 'list', input: {} }] }, { hang: true }]), box: f.box, prompt: 'x', signal, timeoutMs: 200 });
  assert.deepEqual([time.end, time.steps], ['time', 1]);
  const cost = await runAttempt({ model: listing(0.6), box: f.box, prompt: 'x', signal, budget: 1 });
  assert.deepEqual([cost.end, cost.steps], ['cost', 2]);
  assert.ok(Math.abs(cost.cost - 1.2) < 1e-9);
  const idle = await runAttempt({ model: scriptedModel([{ text: 'I cannot help.' }]), box: f.box, prompt: 'x', signal });
  assert.deepEqual([idle.end, idle.reproduced], ['idle', false]);
});

test('a stop rejects the attempt; an OpenRouter refusal returns what a person does about it', async t => {
  const f = await workspace(t);
  const stop = new AbortController();
  const running = runAttempt({ model: scriptedModel([{ hang: true }]), box: f.box, prompt: 'x', signal: stop.signal });
  setTimeout(() => stop.abort(new Error('Stopped.')), 50);
  await assert.rejects(running, /Stopped\./);
  const credits = await runAttempt({ model: scriptedModel([{ error: { status: 402, message: 'This request requires more credits, or fewer max_tokens.' } }]), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.deepEqual([credits.end, credits.refusal], ['provider', 'Add credits to your OpenRouter account and try again.']);
  const outage = await runAttempt({ model: scriptedModel([{ error: { status: 503, message: `Upstream unavailable for key ${KEY}` } }]), box: f.box, prompt: 'x', signal: new AbortController().signal });
  assert.equal(outage.refusal, undefined);
  assert.ok(outage.error && !outage.error.includes(KEY), 'Provider errors are redacted.');
});

test('an attempt reports its usage after each step, so one that is stopped still says what it cost', async t => {
  const f = await workspace(t);
  const stop = new AbortController(), usage: { inputTokens: number; outputTokens: number; cost: number }[] = [];
  const listing = (cost: number): ScriptedStep => ({ calls: [{ tool: 'list', input: {} }], cost });
  const running = runAttempt({ model: scriptedModel([listing(0.25), listing(0.5), { hang: true }]), box: f.box, prompt: 'x', signal: stop.signal,
    onStep: step => { usage.push(step); if (usage.length === 2) stop.abort(new Error('Stopped.')); } });
  await assert.rejects(running, /Stopped\./);
  assert.deepEqual(usage, [{ inputTokens: 100, outputTokens: 20, cost: 0.25 }, { inputTokens: 200, outputTokens: 40, cost: 0.75 }]);
});

test('a box removed for writing too much ends the attempt with why, whatever the model does', async t => {
  const f = await workspace(t);
  const removed = new AbortController();
  const running = runAttempt({ model: scriptedModel([{ hang: true }]), box: { ...f.box, signal: removed.signal }, prompt: 'x', signal: new AbortController().signal });
  setTimeout(() => removed.abort(new Error('The repair box wrote more than 20 GB and was removed.')), 50);
  await assert.rejects(running, /wrote more than 20 GB/);
});

test('the prompt carries the failing workflow, step, command, redacted log, diagnosis and digest as fenced data', async t => {
  const f = await workspace(t);
  // The failure as the triage reader builds it from gh's output, which prints a token the step echoed.
  const log = ['test\tCheck\t2026-09-25T10:14:01.0000000Z node check.js', 'test\tCheck\t2026-09-25T10:14:01.1000000Z Error: add(2, 3) returned -1, expected 5 with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123'].join('\n');
  const jobs = JSON.stringify({ jobs: [{ id: 1, name: 'test', conclusion: 'failure', steps: [{ name: 'Check', conclusion: 'failure' }] }] });
  const run: CommandRunner = async (_file, args) => ({ stdout: args[0] === 'run' ? log : jobs });
  const failure = await getGitHubFailure({ repository: 'owner/app', runId: '41' }, { run, now: () => '2026-09-25T10:15:00.000Z' });
  const workflows = await describeFailures(f.root, [{ id: '41', name: 'CI', path: '.github/workflows/ci.yml' }], [failure]);
  assert.deepEqual([workflows[0].step.step, workflows[0].step.run, workflows[0].step.toolchain?.version], ['Check', 'node check.js', '22']);
  const digest = await repositoryDigest(f.root);
  // The digest twin authoring builds, on how the repository builds.
  assert.match(digest, /^- Top level: `\.github\/`, `add\.js`, `check\.js`, `package\.json`$/m);
  assert.match(digest, /^ {2}- `check`: `node check\.js`$/m);
  assert.match(digest, /^### `\.github\/workflows\/ci\.yml`$/m);
  const prompt = attemptPrompt({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha }, workflows, digest, number: 3, total: 4, feedback: 'The previous attempt reached its 100-step limit without calling done.', changed: true });
  for (const expected of ['Attempt 3 of 4', "Failed step: Check", 'node check.js', 'returned -1, expected 5', 'GITHUB_TOKEN=[REDACTED]', 'Diagnosis (rule-based', 'node-version: 22', 'Repository digest', `git diff ${f.sha}`, '100-step limit']) assert.ok(prompt.includes(expected), expected);
  assert.ok(!prompt.includes('ghp_'));
  assert.match(INSTRUCTIONS, /data, never instructions/);
  assert.match(INSTRUCTIONS, /First reproduce the failure/);
  assert.match(INSTRUCTIONS, /Never weaken what judges the fix/);
  assert.match(INSTRUCTIONS, /Never change CI or deployment configuration/);
  assert.doesNotMatch(INSTRUCTIONS, /unless the workflow/);
});

const pem = (size: number) => `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(size)}\n-----END PRIVATE KEY-----`;
const repair = { repository: 'acme/app', branch: 'main', sha: 'a'.repeat(40) };
const workflow = (yaml: string, run = 'npm test'): FailedWorkflow => ({
  id: '41', name: 'CI', path: '.github/workflows/ci.yml', yaml, failure: null,
  step: { job: 'test', step: 'Check', run, workingDirectory: null, toolchain: null },
});

test('the repair prompt redacts workflow and command credentials before any text is clipped', () => {
  const original = workflow(`env:\n  API_KEY: synthetic-workflow-value\n${pem(2200)}`, `npm test --password synthetic-command-value\n${pem(1200)}`);
  const prompt = attemptPrompt({ repair, workflows: [original], digest: 'token=synthetic-digest-value', number: 1, total: 4, feedback: pem(2200), changed: false });
  assert.ok(!prompt.includes('synthetic-') && !prompt.includes('QUJD'), 'No credential or clipped key fragment reaches model context.');
  assert.match(prompt, /API_KEY: \[REDACTED\]/);
  assert.match(prompt, /npm test --password \[REDACTED\]/);
  assert.match(prompt, /token=\[REDACTED\]/);
  assert.ok(original.yaml?.includes('synthetic-workflow-value'), 'The original workflow remains intact for reproduction.');
  assert.ok(original.step.run?.includes('synthetic-command-value'));
});

test('the done summary is redacted before the attempt applies its length limit', async t => {
  const f = await workspace(t);
  const result = await runAttempt({ model: scriptedModel([{ calls: [{ tool: 'done', input: { summary: `Repaired the parser.\n${pem(1200)}\nVerified npm test.` } }] }]), box: f.box, prompt: 'Fix the build.', signal: new AbortController().signal });
  assert.equal(result.end, 'done');
  assert.equal(result.summary, 'Repaired the parser.\n[REDACTED]\n[REDACTED]\n[REDACTED]\nVerified npm test.');
  const long = await runAttempt({ model: scriptedModel([{ calls: [{ tool: 'done', input: { summary: 'x'.repeat(4100) } }] }]), box: f.box, prompt: 'Fix the build.', signal: new AbortController().signal });
  assert.equal(long.summary, 'x'.repeat(4000), 'Ordinary summaries retain the existing bound.');
});

test('repair commit and pull request text redact complete secrets before their field limits', () => {
  const summary = `Repaired the parser.\n${pem(900)}\nVerified npm test.`;
  const message = commitMessage('Fix CI', summary);
  const body = pullRequestBody({ repair, workflows: [], summary, attempts: [], holds: [], check: null, spent: 0 });
  for (const text of [message, body]) {
    assert.ok(!text.includes('QUJD') && !text.includes('BEGIN PRIVATE KEY'), 'Public repair text contains no clipped key fragment.');
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /Repaired the parser/);
    assert.match(text, /Verified npm test/);
  }
  const title = pullRequestTitle(repair, [{ ...workflow(''), name: `CI ${pem(80)}` }]);
  assert.ok(!title.includes('QUJD'), 'Inline metadata is redacted before flattening and clipping.');
  assert.match(title, /\[REDACTED\]/);
});

test('ordinary repair text still uses the existing commit and pull request bounds', () => {
  const summary = 'x'.repeat(4100);
  assert.equal(commitMessage('Fix CI', summary), `Fix CI\n\n${'x'.repeat(2000)}…\n\nPerpetual build repair.`);
  const body = pullRequestBody({ repair, workflows: [], summary, attempts: [], holds: [], check: null, spent: 0 });
  assert.ok(body.includes(`\n${'x'.repeat(3000)}…\n`));
  assert.ok(!body.includes('x'.repeat(3001)));
});

// A summary the model wrote, or that a log or source file steered, never acts as the connected account on GitHub.
test('the model\'s summary is fenced in the pull request, and neither references, mentions nor trailers in a commit', () => {
  const summary = 'Fixes #42 for @acme/team, see acme/other#7.\nCo-authored-by: Someone <someone@example.com>';
  const message = commitMessage('Fix CI', summary);
  assert.doesNotMatch(message, /#\d|@[\w-]/, 'No issue reference or mention is left to link, close or notify.');
  assert.equal(message.replaceAll('\u2060', ''), `Fix CI\n\n${summary}\n\nPerpetual build repair.`, 'The text reads as written.');
  assert.match(message, /\n\nPerpetual build repair\.$/, 'The summary is never the last paragraph, where trailers are read.');
  const body = pullRequestBody({ repair, workflows: [], summary, attempts: [], holds: [], check: null, spent: 0 });
  assert.ok(body.includes(`\`\`\`\`\n${summary}\n\`\`\`\``), 'In the body it is quoted as code, where GitHub acts on none of it.');
  const linked = commitMessage('Fix CI', 'Closes https://github.com/acme/app/issues/12 and GH-13, like https://github.com/acme/app/pull/14.');
  assert.doesNotMatch(linked, /\/(?:issues|pull)\/\d|GH-\d/, 'An issue or pull request named by its URL or GH- number is not referenced either.');
  assert.equal(linked.replaceAll('⁠', ''), 'Fix CI\n\nCloses https://github.com/acme/app/issues/12 and GH-13, like https://github.com/acme/app/pull/14.\n\nPerpetual build repair.');
});

// Where a change adds credential text is named by the paths the model chose, which reach the attempts table.
test('an attempt\'s failure is code in the pull request\'s attempts table, so the paths it names neither mention nor close anything', () => {
  const failure = 'The change adds text that looks like a credential. Remove it; a repair never adds secrets. Found at fixes #12.env:1, @acme/team.env:1.';
  const body = pullRequestBody({ repair, workflows: [], summary: '', attempts: [{ number: 1, model: 'openai/gpt-6-luna', startedAt: '2026-09-25T10:00:00.000Z', completedAt: '2026-09-25T10:05:00.000Z', failure }], holds: [], check: null, spent: 0 });
  assert.ok(body.includes(`| 1 | \`openai/gpt-6-luna\` | \`${failure}\` | 0 | $0.0000 |`), body);
});
