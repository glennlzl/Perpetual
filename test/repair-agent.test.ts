import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { githubUnreachable } from '../src/github-cli.ts';
import { diagnoseFailure } from '../src/providers.ts';
import { NO_CI, createRepairAgent } from '../src/repair/agent.ts';
import { HELD, REJECTED } from '../src/repair/changes.ts';
import { createRepairHost } from '../src/repair/clone.ts';
import { createRepairManager, type Repair, type RepairGitHub, type RepairSource } from '../src/repair/manager.ts';
import type { CommandRunner, PullRequestRef } from '../src/repair/github.ts';
import type { RepairMerge } from '../src/repair/merge.ts';
import type { WorkflowRun } from '../src/github-runs.ts';
import { hostBoxes, managedCopy } from './fixtures/repair-box.ts';
import { scriptedModel, type ModelCall, type ScriptedStep } from './fixtures/scripted-model.ts';

const A = 'a'.repeat(40), C = 'c'.repeat(40);
const KEY = 'sk-or-v1-fedcba9876543210fedcba9876543210';
const TIMED_OUT = 'Reading GitHub timed out. Check your connection and try again.';
const MODELS = { apiKey: KEY, model: 'openai/gpt-6-luna', escalationModel: 'anthropic/claude-sonnet-5' };
const exec = promisify(execFile) as CommandRunner;
const FIX: ScriptedStep[] = [
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }], cost: 0.01 },
  { calls: [{ tool: 'edit', input: { path: 'add.js', old: 'a - b', new: 'a + b' } }], cost: 0.01 },
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }], cost: 0.01 },
  { calls: [{ tool: 'done', input: { summary: 'add() subtracted; it adds now.' } }], cost: 0.01 },
];
const run = (id: string, sha: string, conclusion: string | null, { branch = 'main', event = 'push', name = 'CI', path = '.github/workflows/ci.yml' } = {}): WorkflowRun =>
  ({ id, workflowId: '7', name, path, event, status: conclusion ? 'completed' : 'in_progress', conclusion, attempt: 1, sha, branch, url: `https://github.com/owner/app/actions/runs/${id}`, createdAt: null, startedAt: null, updatedAt: null, jobs: [] });
const failure = (runId: string, log = 'Error: add(2, 3) returned -1, expected 5') =>
  ({ runId, jobs: [{ id: `job-${runId}`, name: 'test', conclusion: 'failure', failedSteps: ['Check'] }], log, tail: log, diagnosis: diagnoseFailure(log), observedAt: '2026-09-25T10:00:00.000Z' });
async function until(check: () => unknown, attempts = 2000) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (check()) return; await new Promise(done => setTimeout(done, 5)); }
  throw new Error('The repair did not settle.');
}

/**
 * A manager with the real agent step: a managed source copy on disk, host boxes, a scripted model per attempt, and a
 * fake GitHub whose pull request writes and pushes are recorded. `ci(n)` answers the nth pushed commit's runs, and `logs`
 * a failed run's log by its id. GitHub keeps the repair branch's head (`remote`, the last push), its open pull request
 * and that pull request's state; while `blips` is above zero the agent's connection reads fail, while `outages` is, they
 * find GitHub unreachable, while `labelErrors` is, labelling the pull request does, while `closeErrors` is, closing it
 * does, as a network error, and while `readyErrors` is, GitHub refuses to mark it ready. `spent` is what the pipeline's
 * repairs already cost today.
 */
async function harness(t: TestContext, { scripts, ci, budget, noRunMs = 80, outageMs, beforePush, logs = {}, merge, spent }: { scripts: ScriptedStep[][]; ci: (push: number, sha: string) => WorkflowRun[]; budget?: { cost?: number }; noRunMs?: number; outageMs?: number; beforePush?: () => Promise<void>; logs?: Record<string, string>; merge?: Pick<RepairMerge, 'merge'>; spent?: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-agent-'));
  const { checkoutPath, sha: B } = await managedCopy(dataDir);
  const current: RepairSource = { key: 'github:owner/app:/', branch: 'main', repository: 'owner/app', checkoutPath, rootDirectory: '/' };
  if (spent) {
    const at = new Date().toISOString();
    await mkdir(join(dataDir, 'repairs'), { recursive: true });
    await writeFile(join(dataDir, 'repairs', 'state.json'), JSON.stringify({ version: 1, repairs: [{ id: 'earlier', key: current.key, repository: 'owner/app', branch: 'main', sha: 'd'.repeat(40), login: 'developer',
      checkoutPath, rootDirectory: '/', trigger: 'push', status: 'merged', merged: 'e'.repeat(40), runs: [], attempts: [{ number: 1, model: MODELS.model, startedAt: at, completedAt: at, cost: spent }], createdAt: at, updatedAt: at }] }));
  }
  const pull: PullRequestRef = { number: 7, url: 'https://github.com/owner/app/pull/7', draft: true };
  const github = { head: A, connection: { login: 'developer', repository: 'owner/app' } as { login: string; repository: string } | null, runs: {} as Record<string, WorkflowRun[]>,
    remote: null as string | null, openPull: null as PullRequestRef | null, pullState: 'open' as 'open' | 'closed' | 'merged', blips: 0, outages: 0, labelErrors: 0, closeErrors: 0, readyErrors: 0 };
  const pushes: { sha: string; lease: string; branch: string; author: string; files: string }[] = [], remoteReads: (AbortSignal | undefined)[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    const directory = args[args.indexOf('-C') + 1];
    if (args.includes('ls-remote')) { remoteReads.push(options.signal); return { stdout: github.remote ? `${github.remote}\t${args.at(-1)}\n` : '' }; }
    if (!args.includes('push')) return exec(file, args, options);
    await beforePush?.();
    const lease = args.find(arg => arg.startsWith('--force-with-lease='))!, [sha, ref] = args.at(-1)!.split(':');
    const show = async (format: string) => (await exec('git', ['-C', directory, 'show', '-s', `--format=${format}`, sha], options)).stdout.trim();
    pushes.push({ sha, lease: lease.split(':')[1], branch: ref.replace('refs/heads/', ''), author: await show('%an <%ae>'), files: (await exec('git', ['-C', directory, 'show', '--name-only', '--format=', sha], options)).stdout.trim() });
    assert.deepEqual(args.slice(args.indexOf('--') + 1, -1), ['https://github.com/owner/app.git'], 'The push names GitHub, never a credential.');
    github.remote = sha;
    return { stdout: '' };
  };
  const records = { created: [] as { title: string; body: string; branch: unknown; base: string }[], updated: [] as string[], ready: [] as number[], labels: [] as string[], labelCalls: 0, comments: [] as string[], closed: [] as number[], states: 0 };
  const pullRequests = {
    async account() { return { login: 'developer', id: 1234 }; },
    async find() { return github.openPull; },
    async create(input: { title: string; body: string; branch: unknown; base: string }) { records.created.push(input); github.openPull = pull; return pull; },
    async update({ body }: { body: string }) { records.updated.push(body); },
    async ready({ number }: { number: unknown }) {
      if (github.readyErrors > 0) { github.readyErrors -= 1; throw new Error('GitHub denied the pull request. Check write access to this repository.'); }
      records.ready.push(number as number);
    },
    async label({ label }: { label: string }) {
      records.labelCalls += 1;
      if (github.labelErrors > 0) { github.labelErrors -= 1; throw new Error('GitHub denied the pull request. Check write access to this repository.'); }
      records.labels.push(label);
    },
    async comment({ body }: { body: string }) { records.comments.push(body); },
    // A merged pull request's read names its merge commit, which no test head is.
    async state() { records.states += 1; return { state: github.pullState, mergeCommit: github.pullState === 'merged' ? 'e'.repeat(40) : null }; },
    async close({ number }: { number: unknown }) {
      if (github.closeErrors > 0) { github.closeErrors -= 1; throw new Error('Closing the pull request failed. Check your network connection and try again.'); }
      records.closed.push(number as number);
      github.pullState = 'closed';
    },
  };
  const boxes = hostBoxes(), models: string[] = [], keys: string[] = [], prompts: string[][] = [];
  const agent = createRepairAgent({
    models: async () => MODELS, boxes: boxes.boxes, host: createRepairHost({ dataDir, run: runner }), budget, ci: { pollMs: 2, noRunMs, waitMs: 20_000, ...(outageMs === undefined ? {} : { outageMs }) }, merge,
    github: {
      connection: async () => {
        if (github.outages > 0) { github.outages -= 1; throw githubUnreachable(TIMED_OUT); }
        if (github.blips > 0) { github.blips -= 1; return null; }
        return github.connection;
      },
      runs: async ({ sha }) => { const push = pushes.findIndex(item => item.sha === sha); return { runs: push >= 0 ? ci(push, sha) : [] }; },
      failure: async ({ runId }) => failure(runId, 'Error: lint found 1 problem in add.js'),
      pullRequests,
    },
    model(id, apiKey) {
      models.push(id); keys.push(apiKey);
      const calls: string[] = [];
      prompts.push(calls);
      return scriptedModel(scripts[models.length - 1] ?? [], { onCall: (call: ModelCall) => calls.push(JSON.stringify(call.prompt)) });
    },
  });
  const fake: RepairGitHub = {
    async connection() { return github.connection; },
    async head(input) { const etag = `"${github.head.slice(0, 7)}"`; return input.etag === etag ? { status: 304 } : { status: 200, sha: github.head, etag }; },
    async runs({ sha }) { return { runs: structuredClone(github.runs[sha] ?? []) }; },
    async failure({ runId }) { return failure(runId, logs[runId]); },
    async rerun() { throw new Error('unused'); },
  };
  const manager = await createRepairManager({ dataDir, source: () => current, github: fake, steps: { unavailable: () => null, repair: agent.repair, state: agent.state, close: agent.close, recover: agent.recover, cleanup: agent.cleanup } });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const saved = async (): Promise<Repair> => JSON.parse(await readFile(join(dataDir, 'repairs', 'state.json'), 'utf8')).repairs[0];
  const repair = () => manager.view().repairs.find(item => item.sha === B);
  async function fail() {
    await manager.check(); await manager.idle(); // head A is the baseline
    github.head = B;
    github.runs[B] = [run('2', B, 'failure')];
    await manager.check();
  }
  return { manager, github, B, pushes, remoteReads, records, boxes, models, keys, prompts, saved, repair, fail, dataDir };
}

test('a failed head gets a draft pull request; a CI failure becomes the second attempt, and green CI readies it', async t => {
  const h = await harness(t, {
    scripts: [FIX, [
      { calls: [{ tool: 'write', input: { path: 'test/add.test.js', text: "require('assert').equal(require('../add.js')(2, 3), 5);\n" } }] },
      { calls: [{ tool: 'done', input: { summary: 'Covered add() with a test.' } }] },
    ]],
    ci: (push, sha) => [run(String(101 + push), sha, push === 0 ? 'failure' : 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
  });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  const view = h.repair()!;
  assert.deepEqual([view.status, view.reason, view.pullRequest], ['ready', undefined, { number: 7, url: 'https://github.com/owner/app/pull/7', draft: false }]);
  const branch = `perpetual/repair/${h.B.slice(0, 7)}`;
  assert.deepEqual(h.pushes.map(push => [push.branch, push.lease]), [[branch, ''], [branch, h.pushes[0].sha]], 'The first push leases a missing branch, the next the commit it pushed.');
  assert.deepEqual(h.pushes.map(push => push.author), ['developer <1234+developer@users.noreply.github.com>', 'developer <1234+developer@users.noreply.github.com>']);
  assert.deepEqual(h.pushes.map(push => push.files), ['add.js', 'test/add.test.js'], 'A later attempt pushes a new commit on top of the last.');
  assert.equal(h.records.created.length, 1);
  assert.deepEqual([h.records.created[0].branch, h.records.created[0].base, h.records.created[0].title], [branch, 'main', `Fix the failed CI build at ${h.B.slice(0, 7)}`]);
  for (const expected of ['### Failure', 'Diagnosis:', '### Change', 'add() subtracted; it adds now.', '### Attempts', 'openai/gpt-6-luna', 'Total cost: $0.0400']) assert.ok(h.records.created[0].body.includes(expected), expected);
  assert.deepEqual([h.records.labels, h.records.ready, h.records.updated.length], [['perpetual-repair'], [7], 1]);
  assert.match(h.records.updated[0], /Held for a person: The change touches tests\./);
  const stored = await h.saved();
  assert.deepEqual(stored.attempts?.map(attempt => [attempt.number, attempt.model, attempt.reproduced]), [[1, 'openai/gpt-6-luna', true], [2, 'openai/gpt-6-luna', false]]);
  assert.match(stored.attempts?.[0].failure ?? '', /The pushed change failed CI: CI\./);
  assert.deepEqual([stored.ciRuns, stored.holds, stored.diffHash?.length], [['101', '102'], [HELD.tests], 64]);
  assert.match(h.prompts[1][0], /lint found 1 problem in add\.js/, 'The CI failure is the second attempt\'s input.');
  assert.deepEqual([h.boxes.images, h.boxes.created.every(box => box.removed())], [['node:22-bookworm'], true]);
  assert.deepEqual(h.keys, [KEY, KEY], 'The key reaches only the model factory.');
  assert.ok(!JSON.stringify(h.boxes.created.map(box => [box.calls, box.outputs])).includes(KEY) && !JSON.stringify(stored).includes(KEY), 'The key never enters the box or the repair.');
  await assert.rejects(stat(join(h.dataDir, 'repairs', view.id)), { code: 'ENOENT' });
  await assert.rejects(stat(join(h.dataDir, 'repairs', view.id, 'clone')), 'The host copy is removed with the box.');
});

test('a pull request no workflow runs for is ready after the wait, and stays a draft', async t => {
  const h = await harness(t, { scripts: [FIX], ci: () => [], noRunMs: 30 });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.records.ready], [NO_CI, true, []]);
});

// A workflow that runs only on pushes to the target branch never runs for the pull request, so another workflow's pass
// judges nothing of the fix.
test('a pull request where the workflow that failed did not run waits for a person, whatever else passed, and stays a draft', async t => {
  let merges = 0;
  const h = await harness(t, {
    scripts: [FIX], noRunMs: 30, merge: { async merge() { merges += 1; return { status: 'merged', merged: C }; } },
    ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request', name: 'Lint', path: '.github/workflows/lint.yml' })],
  });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.records.ready, merges], ['The failed workflow CI did not run for the pull request.', true, [], 0]);
});

test('a newer head supersedes the repair waiting for CI at once and removes its box; its pull request closes with a comment once a newer head passes', async t => {
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, null, { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'verifying-ci' && h.boxes.created.length);
  h.github.head = C;
  h.github.runs[C] = [run('3', C, null)];
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.repair()?.status, h.repair()?.reason], ['superseded', `Superseded by ${C.slice(0, 7)}.`]);
  assert.equal(h.boxes.created[0].removed(), true);
  assert.deepEqual([h.records.closed, h.records.comments], [[], []], 'The pull request may hold a valid fix, so it stays open.');
  h.github.runs[C] = [run('3', C, 'success')];
  h.github.closeErrors = 1;
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.records.closed, h.records.comments], [[], []], 'A close that failed posts nothing.');
  await h.manager.check();
  await h.manager.idle();
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.records.closed, h.records.comments], [[7], [`Perpetual closed this repair: Superseded by ${C.slice(0, 7)}.`]], 'It closes at the next check, with one comment.');
});

test('two attempts that end without a fix escalate to the escalation model', async t => {
  const h = await harness(t, { scripts: [[{ text: 'Unsure.' }], [{ text: 'Still unsure.' }], FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual(h.models, ['openai/gpt-6-luna', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5']);
  const stored = await h.saved();
  assert.deepEqual(stored.attempts?.map(attempt => attempt.failure), ['The model stopped without calling done.', 'The model stopped without calling done.', undefined]);
  assert.match(h.prompts[2][0], /The model stopped without calling done\./, 'Why the previous attempt failed is the next one\'s input.');
});

// The instructions have the model call done and say why when the code cannot fix the failure. A weaker Settings model
// may give up where the escalation model would not, so its verdict is put to that model once.
test('an attempt that calls done without changing a file ends the repair with the model\'s explanation once the escalation model agrees', async t => {
  const explain: ScriptedStep[] = [
    { calls: [{ tool: 'run', input: { command: 'node check.js' } }] },
    { calls: [{ tool: 'done', input: { summary: 'The workflow pins a Node version the code does not support; the fix is in .github/workflows/ci.yml, which a repair may not change.' } }] },
  ];
  const h = await harness(t, { scripts: [explain, explain, FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'needs-person');
  await h.manager.idle();
  assert.equal(h.repair()?.reason, 'The model changed no file: The workflow pins a Node version the code does not support; the fix is in .github/workflows/ci.yml, which a repair may not change.');
  assert.deepEqual([h.models, h.pushes, (await h.saved()).attempts?.map(attempt => [attempt.number, attempt.failure])], [[MODELS.model, MODELS.escalationModel], [], [[1, 'The attempt changed no file.'], [3, 'The attempt changed no file.']]], 'No later attempt pays to agree.');
  assert.match(h.prompts[1][0], /The attempt changed no file and called done: The workflow pins a Node version/, 'The escalation model reads the verdict it is asked about.');
  const fixed = await harness(t, { scripts: [explain, FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await fixed.fail();
  await until(() => fixed.repair()?.status === 'ready');
  await fixed.manager.idle();
  assert.deepEqual([fixed.models, fixed.pushes.map(push => push.files)], [[MODELS.model, MODELS.escalationModel], ['add.js']], 'An escalation model that finds a fix makes it.');
});

test('a change the rules reject is never pushed, and its reason goes back to the agent', async t => {
  const leak = [{ calls: [{ tool: 'write', input: { path: 'config.js', text: "module.exports = { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' };\n" } }] }, { calls: [{ tool: 'done', input: { summary: 'Added a token.' } }] }];
  const undo = { calls: [{ tool: 'run', input: { command: 'rm config.js' } }] };
  const h = await harness(t, { scripts: [leak, [undo, ...FIX]], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual(h.pushes.map(push => push.files), ['add.js']);
  assert.equal((await h.saved()).attempts?.[0].failure, `${REJECTED.credential} Found at config.js:1.`);
  assert.ok(h.prompts[1][0].includes('looks like a credential') && h.prompts[1][0].includes('config.js:1'), 'The next attempt learns where, never the text.');
});

test('a change that weakens how CI checks the code reaches the merge step held for a person', async t => {
  const seen: (readonly string[])[] = [];
  const weaken: ScriptedStep[] = [
    { calls: [{ tool: 'edit', input: { path: 'package.json', old: '"check": "node check.js"', new: '"check": "exit 0"' } }] },
    { calls: [{ tool: 'done', input: { summary: 'The check passes now.' } }] },
  ];
  const h = await harness(t, {
    scripts: [weaken], ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
    merge: { async merge(input) { seen.push(input.holds); return { status: 'ready', reason: `Held for a person: ${input.holds.join(' ')}` }; } },
  });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([seen, (await h.saved()).holds], [[[HELD.checks]], [HELD.checks]], 'The package script the failing step runs is a judge of the fix.');
});

// git attributes such as -diff make text files binary in the box's diff, where they count no lines.
test('a change\'s size is read from what the host copy staged, so a file git treats as binary counts its lines', async t => {
  const seen: (readonly string[])[] = [];
  const values = Array.from({ length: 500 }, (_, index) => `exports.value${index} = ${index};`).join('\n');
  const large: ScriptedStep[] = [
    { calls: [{ tool: 'write', input: { path: '.gitattributes', text: '* -diff\n' } }, { tool: 'write', input: { path: 'values.js', text: `${values}\n` } }] },
    { calls: [{ tool: 'done', input: { summary: 'Added the values.' } }] },
  ];
  const h = await harness(t, {
    scripts: [large], ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
    merge: { async merge(input) { seen.push(input.holds); return { status: 'ready', reason: `Held for a person: ${input.holds.join(' ')}` }; } },
  });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual(seen, [[HELD.size]]);
  assert.match(h.records.created[0].body, /2 files, \+501 −0/);
});

test('a credential in a file git treats as binary is refused from what the host copy staged, and never pushed', async t => {
  const hidden = [
    { calls: [{ tool: 'write', input: { path: '.gitattributes', text: '*.env binary\n' } }, { tool: 'write', input: { path: 'deploy.env', text: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' } }] },
    { calls: [{ tool: 'done', input: { summary: 'Configured deployment.' } }] },
  ];
  const undo = { calls: [{ tool: 'run', input: { command: 'rm .gitattributes deploy.env' } }] };
  const h = await harness(t, { scripts: [hidden, [undo, ...FIX]], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual(h.pushes.map(push => push.files), ['add.js']);
  assert.equal((await h.saved()).attempts?.[0].failure, `${REJECTED.credential} Found at deploy.env:1.`);
});

test('the cost cap ends the repair as failed and keeps its pull request a draft', async t => {
  const h = await harness(t, { scripts: [FIX, FIX], budget: { cost: 0.04 }, ci: (_push, sha) => [run('101', sha, 'failure', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'failed');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.records.ready, h.models.length], ['The repair reached its $0.04 cost cap.', true, [], 1]);
});

test('a repair Autopilot starts by itself spends no more than what is left of its pipeline\'s daily cost cap', async t => {
  const h = await harness(t, { scripts: [FIX, FIX], spent: 9.98, ci: (_push, sha) => [run('101', sha, 'failure', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'failed');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.models.length, h.pushes.length], ['The repair reached this pipeline\'s $10.00 daily cost cap.', 1, 0]);
});

test('an attempt a Stop cuts short is recorded with what its finished steps cost', async t => {
  const h = await harness(t, { scripts: [[{ calls: [{ tool: 'list', input: {} }], cost: 0.3 }, { hang: true }]], ci: () => [] });
  await h.fail();
  await until(() => h.prompts[0]?.length === 2);
  await h.manager.stop({ id: h.repair()!.id });
  await h.manager.idle();
  const attempt = (await h.saved()).attempts?.[0];
  assert.deepEqual([h.repair()?.status, attempt?.cost, attempt?.inputTokens, Boolean(attempt?.completedAt), attempt?.failure], ['cancelled', 0.3, 100, true, undefined]);
  assert.deepEqual(h.repair()?.attempts, [{ number: 1, model: MODELS.model, cost: 0.3 }], 'The change shows what the stopped attempt cost.');
});

test('without the connected account that saw the failure, nothing is pushed', async t => {
  const h = await harness(t, { scripts: [[{ calls: [{ tool: 'run', input: { command: 'sleep 1' } }] }, ...FIX]], ci: () => [] });
  await h.fail();
  await until(() => h.boxes.created.length);
  h.github.connection = { login: 'someone-else', repository: 'owner/app' };
  await until(() => h.repair()?.status === 'needs-person');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.pushes], ['The GitHub connection changed. Start the repair again.', []]);
});

const OVERFLOW = "This endpoint's maximum context length is 128000 tokens. However, you requested about 131072 tokens (129000 of text input, 2072 in the output).";
test('an attempt whose conversation outgrows the model\'s context window fails, and the next attempt starts afresh', async t => {
  const h = await harness(t, { scripts: [[{ calls: [{ tool: 'list', input: {} }] }, { error: { status: 400, message: OVERFLOW } }], FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.models], [undefined, ['openai/gpt-6-luna', 'openai/gpt-6-luna']]);
  assert.match((await h.saved()).attempts?.[0].failure ?? '', /context window/);
});

test('GitHub reads that fail while CI runs are tried again at the next poll', async t => {
  let polls = 0;
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => {
    polls += 1;
    if (polls === 1) { h.github.blips = 3; throw new Error('GitHub has temporarily limited requests. Wait before trying again.'); }
    return [run('101', sha, 'success', { event: 'pull_request' })];
  } });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.records.ready, h.github.blips], [undefined, [7], 0]);
});

test('GitHub unreadable for longer than the outage limit while CI runs needs a person, and leaves the pull request a draft', async t => {
  const h = await harness(t, { scripts: [FIX], outageMs: 40, ci: () => { h.github.blips = Number.POSITIVE_INFINITY; return []; } });
  await h.fail();
  await until(() => h.repair()?.status === 'needs-person');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.records.ready, h.pushes.length], ['Connect GitHub to repair builds.', true, [], 1]);
});

test('GitHub unreachable after a paid attempt is waited out: the change is pushed once GitHub answers', async t => {
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  // The agent's first connection read is the one before its push.
  h.github.outages = 3;
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.models.length, h.pushes.length, h.records.ready, h.github.outages], [undefined, 1, 1, [7], 0]);
});

test('GitHub unreachable for longer than the outage limit needs a person with why, never as a disconnect', async t => {
  await t.test('before the push', async t => {
    const h = await harness(t, { scripts: [FIX], outageMs: 40, ci: () => [] });
    h.github.outages = Number.POSITIVE_INFINITY;
    await h.fail();
    await until(() => h.repair()?.status === 'needs-person');
    h.github.outages = 0;
    await h.manager.idle();
    assert.deepEqual([h.repair()?.reason, h.pushes.length, h.records.created], [TIMED_OUT, 0, []]);
  });
  await t.test('while CI runs', async t => {
    const h = await harness(t, { scripts: [FIX], outageMs: 40, ci: () => { h.github.outages = Number.POSITIVE_INFINITY; return []; } });
    await h.fail();
    await until(() => h.repair()?.status === 'needs-person');
    h.github.outages = 0;
    await h.manager.idle();
    assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.pushes.length], [TIMED_OUT, true, 1]);
  });
});

test('another connected account while CI runs ends the repair at once', async t => {
  const h = await harness(t, { scripts: [FIX], ci: () => { h.github.connection = { login: 'someone-else', repository: 'owner/app' }; return []; } });
  await h.fail();
  await until(() => h.repair()?.status === 'needs-person');
  await h.manager.idle();
  assert.deepEqual([h.repair()?.reason, h.records.ready], ['The GitHub connection changed. Start the repair again.', []]);
});

test('a repair branch that holds commits Perpetual did not push is never overwritten: the repair needs a person', async t => {
  const h = await harness(t, { scripts: [FIX], ci: () => [] });
  h.github.remote = 'e'.repeat(40);
  await h.fail();
  await until(() => h.repair()?.status === 'needs-person');
  await h.manager.idle();
  assert.match(h.repair()?.reason ?? '', new RegExp(`perpetual/repair/${h.B.slice(0, 7)} has commits Perpetual did not push`));
  assert.deepEqual([h.pushes, h.records.created], [[], []]);
});

test('a person\'s second Repair of the same commit leases the branch as the first left it, and continues its open pull request', async t => {
  // The second repair's summary differs, so its commit does; the same change and message in the same second is the same commit.
  const again = [...FIX.slice(0, -1), { calls: [{ tool: 'done', input: { summary: 'add() subtracted; it adds now, again.' } }], cost: 0.01 }];
  const h = await harness(t, { scripts: [FIX, again], budget: { cost: 0.04 }, ci: (push, sha) => [run(String(101 + push), sha, push === 0 ? 'failure' : 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'failed');
  await h.manager.idle();
  const first = (await h.saved());
  assert.equal(first.pushed, h.pushes[0].sha, 'The commit Perpetual pushed is recorded.');
  await h.manager.repair({ runId: '2' });
  await until(() => h.manager.view().repairs.length === 2 && h.repair()?.status === 'ready');
  await h.manager.idle();
  assert.deepEqual(h.pushes.map(push => push.lease), ['', h.pushes[0].sha], 'The second repair leases the commit the first pushed.');
  assert.deepEqual([h.records.created.length, h.records.closed], [1, []], 'The open pull request is reused, never closed as another repair\'s.');
  assert.match(h.records.updated.at(-1) ?? '', /### Attempts/);
  assert.deepEqual([h.repair()?.pullRequest, h.records.ready], [{ number: 7, url: 'https://github.com/owner/app/pull/7', draft: false }, [7]]);
});

test('a repair stopped while it pushes records the push and opens no pull request', async t => {
  let stopped = false;
  const h = await harness(t, { scripts: [FIX], ci: () => [], beforePush: async () => { await h.manager.stop({ id: h.repair()!.id }); stopped = true; } });
  await h.fail();
  await until(() => stopped && h.repair()?.status === 'cancelled');
  await h.manager.idle();
  assert.deepEqual([h.pushes.length, h.records.created, h.repair()?.pullRequest], [1, [], undefined]);
  assert.equal((await h.saved()).pushed, h.pushes[0].sha, 'The next Repair continues from the pushed commit.');
  assert.ok(h.remoteReads.every(signal => signal instanceof AbortSignal), 'Reading the branch stops with the repair.');
});

test('a ready repair whose pull request a person merged is recorded as merged, and nothing is posted on it', async t => {
  const M = 'f'.repeat(40);
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  h.github.pullState = 'merged';
  h.github.head = M;
  h.github.runs[M] = [run('5', M, 'success')];
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.repair()?.status, h.repair()?.reason, h.records.comments, h.records.closed], ['merged', 'Merged on GitHub.', [], []]);
});

test('a ready repair whose pull request a person closed is superseded by a newer passing head, with nothing posted on it', async t => {
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  h.github.pullState = 'closed';
  h.github.head = C;
  h.github.runs[C] = [run('5', C, 'success')];
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.repair()?.status, h.records.comments, h.records.closed], ['superseded', [], []]);
});

test('a pull request GitHub would not label is labelled after a later push, and a label still missing is named in the reason', async t => {
  const retried = await harness(t, {
    scripts: [FIX, [{ calls: [{ tool: 'write', input: { path: 'test/add.test.js', text: "require('assert').equal(require('../add.js')(2, 3), 5);\n" } }] }, { calls: [{ tool: 'done', input: { summary: 'Covered add().' } }] }]],
    ci: (push, sha) => [run(String(101 + push), sha, push === 0 ? 'failure' : 'success', { event: 'pull_request' })],
  });
  retried.github.labelErrors = 1;
  await retried.fail();
  await until(() => retried.repair()?.status === 'ready');
  await retried.manager.idle();
  assert.deepEqual([retried.repair()?.reason, retried.records.labels, retried.records.labelCalls], [undefined, ['perpetual-repair'], 2]);
  const missing = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })] });
  missing.github.labelErrors = Number.POSITIVE_INFINITY;
  await missing.fail();
  await until(() => missing.repair()?.status === 'ready');
  await missing.manager.idle();
  assert.deepEqual([missing.repair()?.reason, missing.repair()?.pullRequest?.draft, missing.records.labelCalls],
    ['Could not label the pull request perpetual-repair: GitHub denied the pull request. Check write access to this repository.', false, 2]);
});

test('a ready repair whose pull request a person merged is merged when the merge commit fails CI, and the merge commit gets its own repair', async t => {
  const M = 'f'.repeat(40);
  const h = await harness(t, { scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { event: 'pull_request' })], logs: { 5: 'Error: VERCEL_TOKEN is required' } });
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  await h.manager.idle();
  h.github.pullState = 'merged';
  h.github.head = M;
  h.github.runs[M] = [run('5', M, 'failure')];
  await h.manager.check();
  await h.manager.idle();
  assert.deepEqual([h.repair()?.status, h.repair()?.reason, h.records.comments, h.records.closed, h.records.states], ['merged', 'Merged on GitHub.', [], [], 1]);
  assert.equal(h.manager.view().repairs.find(item => item.sha === M)?.status, 'needs-person', 'The merge commit\'s own failure is triaged as usual.');
  await h.manager.check();
  await h.manager.idle();
  assert.equal(h.records.states, 1, 'A merged repair is not read again.');
});

test('a pull request that passed CI goes to the merge step with its pushed head, host copy and holds, and its merge is recorded', async t => {
  const M = 'd'.repeat(40), seen: { sha: string; head: string; holds: readonly string[]; autoMerge: boolean; boxRemoved: boolean; draft?: boolean; ci: unknown }[] = [];
  const h: Awaited<ReturnType<typeof harness>> = await harness(t, {
    scripts: [FIX],
    ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
    merge: {
      async merge(input, signal) {
        const head = (await promisify(execFile)('git', ['-C', input.clone, 'rev-parse', 'HEAD'])).stdout.trim();
        // A head this step made by updating the branch goes through the same CI wait; none runs for it here.
        seen.push({ sha: input.sha, head, holds: input.holds, autoMerge: input.autoMerge(), boxRemoved: h.boxes.created.every(box => box.removed()), draft: input.pullRequest.draft, ci: await input.ci('e'.repeat(40), signal) });
        await mkdir(join(input.directory, `gate-${input.sha.slice(0, 7)}`));
        await input.report({ status: 'verifying-gates' });
        await input.report({ merged: M });
        return { status: 'merged', merged: M };
      },
    },
  });
  await h.fail();
  await until(() => h.repair()?.status === 'merged');
  await h.manager.idle();
  assert.deepEqual(seen, [{ sha: h.pushes[0].sha, head: h.pushes[0].sha, holds: [], autoMerge: true, boxRemoved: true, draft: false, ci: { status: 'failed', reason: NO_CI } }], 'The merge step gets the pushed head in the live host copy, after the box is gone.');
  assert.deepEqual([h.repair()?.merged, (await h.saved()).merged, h.records.ready], [M, M, [7]]);
  await assert.rejects(stat(join(h.dataDir, 'repairs', h.repair()!.id)), { code: 'ENOENT' }, 'The host copy and gate checkout are removed after confirmed cleanup.');
});

test('a pull request GitHub refuses to mark ready after CI still goes to the merge step, as a draft', async t => {
  const seen: { draft?: boolean; sha: string }[] = [];
  const h = await harness(t, {
    scripts: [FIX],
    ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
    merge: { async merge(input) { seen.push({ draft: input.pullRequest.draft, sha: input.sha }); return { status: 'ready', reason: 'Beta needs release: No reviewed journeys.' }; } },
  });
  h.github.readyErrors = 1;
  await h.fail();
  await until(() => h.repair()?.status === 'ready');
  assert.deepEqual(seen, [{ draft: true, sha: h.pushes[0].sha }], 'The merge step gets the draft and its verified head.');
  assert.deepEqual([h.repair()?.reason, h.repair()?.pullRequest?.draft, h.records.ready], ['Beta needs release: No reviewed journeys.', true, []]);
});

test('an unremoved box holds the merge and host clone; cleanup retry never repeats model work', async t => {
  let failed = true, merged = 0;
  const h = await harness(t, {
    scripts: [FIX], ci: (_push, sha) => [run('101', sha, 'success', { branch: 'perpetual/repair/x', event: 'pull_request' })],
    merge: { async merge() { merged++; return { status: 'merged', merged: C }; } },
  });
  const create = h.boxes.boxes.create;
  h.boxes.boxes.create = async input => {
    const box = await create(input), remove = box.remove;
    box.remove = async () => { if (failed) throw new Error('Docker could not remove the box'); await remove(); };
    return box;
  };
  t.after(async () => { failed = false; for (const made of h.boxes.created) await made.box.remove(); });
  await h.fail(); await h.manager.idle();
  const saved = await h.saved(), clone = join(h.dataDir, 'repairs', saved.id, 'clone');
  assert.deepEqual([saved.status, saved.cleanup?.status, merged], ['needs-person', 'failed', 0]);
  assert.match(saved.reason ?? '', /could not remove/);
  assert.equal(h.boxes.created[0].removed(), false);
  assert.equal((await stat(clone)).isDirectory(), true);
  failed = false;
  await h.manager.check(); await h.manager.idle();
  assert.deepEqual([h.models.length, merged, (await h.saved()).cleanup, h.boxes.created[0].removed()], [1, 0, undefined, true]);
  await assert.rejects(stat(clone), { code: 'ENOENT' });
});
