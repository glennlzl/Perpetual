import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { startServer, type ServerOptions } from '../src/server.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import { readBranchHead, type CommitStatusPost } from '../src/gate/github.ts';
import { readBuild } from '../src/gate/build.ts';
import { createGitHubRunsReader, githubRequest } from '../src/github-runs.ts';
import { REJECTED } from '../src/repair/changes.ts';
import { createRepairHost } from '../src/repair/clone.ts';
import { createRepairPullRequests, getGitHubFailure, rerunFailedJobs, type CommandRunner } from '../src/repair/github.ts';
import type { ManagedRuntime } from '../src/environments/manager.ts';
import type { WorkerEvent } from '../src/browser/runtime.ts';
import type { JourneyRunInput } from '../src/journeys/playwright/runtime.ts';
import type { GitHubSession } from '../src/github-source.ts';
import type { CI } from '../src/repair/agent.ts';
import type { MERGE } from '../src/repair/merge.ts';
import type { Repair } from '../src/repair/manager.ts';
import type { AutopilotView } from '../contract/autopilot.ts';
import { brokenRepository, fixtureGit, hostBoxes, managedCopy } from './fixtures/repair-box.ts';
import { scriptedModel, type ScriptedStep } from './fixtures/scripted-model.ts';

// A controller with the real repair wiring: GitHub is a fake gh and git that answer from fixtures through the real
// readers and writers (branch head, runs, failed jobs and log, pull requests, the host copy's push); the model is
// scripted and the box is a host folder. Nothing reaches GitHub, a model or Docker.
const KEY = 'sk-or-v1-fedcba9876543210fedcba9876543210';
const MODEL = 'openai/gpt-6-luna', ESCALATION = 'anthropic/claude-sonnet-5';
const exec = promisify(execFile) as CommandRunner;
const SESSION: GitHubSession = { available: true, authenticated: true, account: { login: 'developer', name: null } };
const FIX: ScriptedStep[] = [
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }] },
  { calls: [{ tool: 'edit', input: { path: 'add.js', old: 'a - b', new: 'a + b' } }] },
  { calls: [{ tool: 'run', input: { command: 'node check.js' } }] },
  { calls: [{ tool: 'done', input: { summary: 'add() subtracted; it adds now.' } }] },
];
type AutopilotResponse = AutopilotView & { error?: string };
/** The view as the pipeline reads it, beside the repair's own record from the state file. */
type Polled = { view: AutopilotResponse; repair: Repair };
const change = (view: AutopilotResponse) => view.stages?.build?.changes[0];

/**
 * gh and git as the controller runs them, answering for owner/app whose branch main is at `sha` with failed run 2: its
 * job, its failed-step log (with a token on an error line triage keeps and on a line only its tail keeps), the signed-in
 * account and pull request 7, whose head is the last commit pushed: its CI run 101 passes, its checks are that run and
 * the commit statuses posted on it, it is not behind main, and it merges as MERGED onto main. git runs locally, except
 * that the repair branch reads as missing and a push is recorded. With `remote`, a bare repository holding main, a push
 * also lands there, a fetch from GitHub reads it, and when main moves to `next` as the pull request's first head's checks
 * are read, the pull request is behind main until GitHub updates its branch with a merge of main, whose CI passes too.
 */
const MERGED = 'd'.repeat(40);
function fakeGitHub(sha: string, { remote, next }: { remote?: string; next?: string } = {}) {
  const calls: string[][] = [], pushes: { branch: string; lease: string; files: string }[] = [], commits: string[] = [], statuses: CommitStatusPost[] = [];
  const branch = `perpetual/repair/${sha.slice(0, 7)}`, updates: string[] = [];
  const pushed = () => updates.at(-1) ?? commits.at(-1);
  let target = sha;
  const run = { id: 2, workflow_id: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'failure', head_sha: sha, head_branch: 'main', run_attempt: 1, html_url: 'https://github.com/owner/app/actions/runs/2', created_at: '2026-09-25T10:00:00Z', run_started_at: '2026-09-25T10:00:00Z', updated_at: '2026-09-25T10:05:00Z' };
  const jobs = { total_count: 1, jobs: [{ id: 11, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/app/actions/runs/2/job/11', steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' }, { number: 2, name: 'Check', status: 'completed', conclusion: 'failure' }] }] };
  const log = ['> node check.js', 'env GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', 'Error: add(2, 3) returned -1, expected 5', 'Error: reporting failed with token ghp_abcdefghijklmnopqrstuvwxyz0123', '##[error]Process completed with exit code 1.']
    .map((line, index) => `test\tCheck\t2026-09-25T10:04:0${index}.0000000Z ${line}`).join('\n');
  const answer = (data: unknown, etag?: string) => ({ stdout: etag ? `HTTP/2.0 200 OK\r\nEtag: "${etag}"\r\n\r\n${JSON.stringify(data)}` : JSON.stringify(data) });
  const gh: CommandRunner = async (file, args) => {
    assert.equal(file, 'gh');
    calls.push(args);
    const endpoint = args.find(arg => arg.startsWith('repos/') || arg === 'user'), method = args[args.indexOf('--method') + 1], included = args.includes('--include');
    if (args[0] === 'run' && args.includes('--log-failed')) return { stdout: log };
    if (endpoint === 'repos/owner/app/branches/main') return answer({ commit: { sha: target } }, 'head');
    if (endpoint === `repos/owner/app/actions/runs?head_sha=${sha}&per_page=50`) return answer({ total_count: 1, workflow_runs: [run] }, included ? 'runs' : undefined);
    if (endpoint === `repos/owner/app/actions/runs?head_sha=${sha}&per_page=100&page=1`) return answer({ total_count: 1, workflow_runs: [{ ...run, workflow_id: 1 }] });
    if (endpoint === 'repos/owner/app/actions/runs/2/jobs?per_page=100' || endpoint === 'repos/owner/app/actions/runs/2/attempts/1/jobs?per_page=100') return answer(jobs, included ? 'jobs' : undefined);
    if (endpoint === 'user') return answer({ login: 'developer', id: 1234 });
    if (endpoint?.startsWith('repos/owner/app/pulls?state=open&')) return answer([]);
    if (endpoint === 'repos/owner/app/pulls' && method === 'POST') return answer({ number: 7, html_url: 'https://github.com/owner/app/pull/7', draft: true });
    if (endpoint === 'repos/owner/app/issues/7/labels' && method === 'POST') return answer([{ name: 'perpetual-repair' }]);
    const head = /^repos\/owner\/app\/actions\/runs\?head_sha=([a-f\d]{40})&per_page=50$/.exec(endpoint ?? '')?.[1];
    if (head && (commits.includes(head) || updates.includes(head))) return answer({ total_count: 1, workflow_runs: [{ ...run, id: 101, event: 'pull_request', conclusion: 'success', head_sha: head, head_branch: branch, html_url: 'https://github.com/owner/app/actions/runs/101' }] }, included ? 'pull-runs' : undefined);
    if (args[0] === 'pr' && args[1] === 'ready') return { stdout: '' };
    if (endpoint === 'repos/owner/app/pulls/7' && method === 'GET') return answer({ number: 7, state: 'open', merged: false, draft: false, head: { sha: pushed(), ref: branch, repo: { full_name: 'owner/app' } }, base: { sha, ref: 'main' } });
    if (endpoint === `repos/owner/app/commits/${pushed()}/check-runs?per_page=100&page=1`) {
      if (next && pushed() === commits[0]) target = next;
      return answer({ total_count: 1, check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });
    }
    if (endpoint === `repos/owner/app/commits/${pushed()}/status?per_page=100&page=1`) {
      const latest = [...new Map(statuses.filter(item => item.sha === pushed()).map(item => [item.context, { context: item.context, state: item.state }])).values()];
      return answer({ state: 'pending', total_count: latest.length, statuses: latest });
    }
    if (endpoint === `repos/owner/app/compare/${target}...${pushed()}?per_page=1`) return answer({ status: 'ahead', ahead_by: 1, behind_by: target !== sha && !updates.length ? 1 : 0 });
    if (endpoint === 'repos/owner/app/pulls/7/update-branch' && method === 'PUT' && remote) {
      assert.ok(args.includes(`expected_head_sha=${pushed()}`), 'The update names the verified head.');
      // GitHub merges main into the repair branch.
      const work = join(dirname(remote), 'github-work');
      await rm(work, { recursive: true, force: true });
      fixtureGit(dirname(remote), 'clone', '--quiet', remote, work);
      fixtureGit(work, 'checkout', '--quiet', '--detach', pushed()!);
      fixtureGit(work, 'merge', '--quiet', '--no-ff', '--no-edit', target);
      updates.push(fixtureGit(work, 'rev-parse', 'HEAD'));
      fixtureGit(work, 'push', '--quiet', '--force', 'origin', `${pushed()}:refs/heads/${branch}`);
      return answer({ message: 'Updating pull request branch.' });
    }
    if (endpoint === `repos/owner/app/git/commits/${MERGED}`) return answer({ parents: [{ sha: target }] });
    const commit = /^repos\/owner\/app\/git\/commits\/([a-f\d]{40})$/.exec(endpoint ?? '')?.[1];
    if (commit && remote) return answer({ parents: fixtureGit(remote, 'show', '-s', '--format=%P', commit).split(' ').map(parent => ({ sha: parent })) });
    if (endpoint === 'repos/owner/app/pulls/7/merge' && method === 'PUT') return answer({ sha: MERGED, merged: true, message: 'Pull Request successfully merged' });
    throw Object.assign(new Error('Command failed: gh'), { stderr: `HTTP 404: Not Found (${endpoint})` });
  };
  const git: CommandRunner = async (file, args, options) => {
    if (args.includes('ls-remote')) return { stdout: '' };
    const github = args.indexOf('https://github.com/owner/app.git');
    // A fetch from GitHub, such as of GitHub's merge commit, reads the bare repository.
    if (args.includes('fetch') && github >= 0 && remote) return exec(file, [...args.slice(0, args.indexOf('fetch')), '-c', 'protocol.file.allow=always', ...args.slice(args.indexOf('fetch'), github), remote, ...args.slice(github + 1)], options);
    if (!args.includes('push')) return exec(file, args, options);
    const directory = args[args.indexOf('-C') + 1], [commit, ref] = args.at(-1)!.split(':');
    const lease = args.find(arg => arg.startsWith('--force-with-lease='))!.split(':')[1];
    pushes.push({ branch: ref.replace('refs/heads/', ''), lease, files: (await exec('git', ['-C', directory, 'show', '--name-only', '--format=', commit], options)).stdout.trim() });
    if (remote) fixtureGit(directory, '-c', 'protocol.file.allow=always', 'push', '--quiet', '--force', remote, `${commit}:${ref}`);
    commits.push(commit);
    return { stdout: '' };
  };
  return { gh, git, calls, pushes, commits, updates, statuses, target: () => target };
}

async function controller(t: TestContext, { build = brokenRepository, root = '/', nodes = [], scripts, escalation, stages, ci, timing, moves = false, runtimes = {} }: {
  build?: (directory: string) => Promise<string>; root?: string; nodes?: unknown[]; scripts: ScriptedStep[][]; escalation?: string; stages?: unknown[]; ci?: Partial<typeof CI>; timing?: Partial<typeof MERGE>;
  moves?: boolean; runtimes?: Pick<ServerOptions, 'environments' | 'browser'>;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-repair-controller-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const { checkoutPath, sha } = await managedCopy(dataDir, build);
  // GitHub's copy of the repository, where main moves to `next`, a commit of someone else's.
  let remote: string | undefined, next: string | undefined;
  if (moves) {
    remote = join(dir, 'github.git');
    fixtureGit(dir, 'clone', '--quiet', '--bare', checkoutPath, remote);
    fixtureGit(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const work = join(dir, 'next');
    fixtureGit(dir, 'clone', '--quiet', remote, work);
    await writeFile(join(work, 'README.md'), 'A calculator.\n');
    fixtureGit(work, 'add', 'README.md');
    fixtureGit(work, 'commit', '--quiet', '-m', 'Describe the calculator');
    next = fixtureGit(work, 'rev-parse', 'HEAD');
    fixtureGit(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/next');
  }
  const scanPath = join(checkoutPath, ...root.split('/').filter(Boolean));
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: scanPath, name: 'app', sha, branch: 'main', remote: 'https://github.com/owner/app.git' }, nodes, edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-25T10:00:00.000Z' };
  const source = { scanPath, checkoutPath, repository: 'owner/app', branch: 'main', rootDirectory: root, sha, connectedAccount: 'developer', savedAt: '2026-09-25T09:00:00.000Z' };
  const pipelines = stages ? { [`github:owner/app:${root}`]: { repoPath: scanPath, stages } } : {};
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, providers: [], pipelines, githubConnection: { login: 'developer', connectedAt: '2026-09-25T09:00:00.000Z' }, source } }));
  // App Settings as the Settings page saves them: the OpenRouter key, the model and, once chosen, the escalation model.
  await writeFile(join(dataDir, 'browser-model.json'), JSON.stringify({ apiKey: KEY, model: MODEL, baseUrl: 'https://openrouter.ai/api/v1', ...(escalation ? { escalationModel: escalation } : {}) }));
  const github = fakeGitHub(sha, { remote, next }), request = (endpoint: string, etag: string | null) => githubRequest(endpoint, etag, { run: github.gh }), pulls = createRepairPullRequests({ run: github.gh });
  const boxes = hostBoxes(), models: { id: string; apiKey: string }[] = [], prompts: string[] = [];
  const app = await startServer({
    port: 0, repo: dir, dataDir,
    github: {
      auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
      runs: createGitHubRunsReader({ request, session: async () => SESSION }),
      head: input => readBranchHead(input, { request }),
      build: input => readBuild(input, { request, session: async () => SESSION }),
      status: async input => { github.statuses.push(input); },
      failure: input => getGitHubFailure(input, { run: github.gh }),
      rerun: input => rerunFailedJobs(input, { run: github.gh }),
    },
    repair: {
      boxes: boxes.boxes, host: createRepairHost({ dataDir, run: github.git }), pullRequests: pulls, merges: pulls, ci, timing,
      model(id, apiKey) { models.push({ id, apiKey }); return scriptedModel(scripts[models.length - 1] ?? [], { onCall: call => prompts.push(JSON.stringify(call.prompt)) }); },
    },
    ...runtimes,
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const send = async <T = AutopilotResponse>(path: string, input: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const post = (path: string, input: unknown) => send(path, input);
  const view = async (): Promise<AutopilotResponse> => (await fetch(`${app.url}/api/autopilot?${new URLSearchParams({ repoPath: scanPath })}`)).json();
  const saved = async (): Promise<Repair> => JSON.parse(await readFile(join(dataDir, 'repairs', 'state.json'), 'utf8')).repairs[0];
  async function until(check: (view: AutopilotResponse, repair: Repair | undefined) => unknown, attempts = 1000): Promise<Polled> {
    for (let attempt = 0; attempt < attempts; attempt++) { const current = await view(), repair = await saved(); if (check(current, repair)) return { view: current, repair }; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('The repair did not settle.');
  }
  const finished = (status: Repair['status']) => until((view, repair) => repair?.status === status && !repair.cleanup && !change(view)?.steps.some(step => step.id === 'cleanup'));
  const read = async (path: string) => (await fetch(`${app.url}${path}`)).json();
  return { sha, next, scanPath, checkoutPath, dataDir, github, boxes, models, prompts, post, send, view, until, finished, saved, read };
}

test('a person\'s Repair goes from gh\'s failed jobs and log through triage, the box and the scripted model to a draft pull request', async t => {
  const c = await controller(t, { scripts: [FIX] });
  const branch = `perpetual/repair/${c.sha.slice(0, 7)}`;
  const offered = await c.until(view => view.stages?.build?.failed?.runs.length);
  assert.deepEqual(offered.view.stages?.build, { mode: 'merge', changes: [], failed: { sha: c.sha, runs: [{ id: '2', name: 'CI', path: '.github/workflows/ci.yml', url: 'https://github.com/owner/app/actions/runs/2' }] } }, 'The head\'s failed run, read through gh, is offered on Build.');
  const started = await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  assert.deepEqual([started.status, change(started.body)?.status, change(started.body)?.title, (await c.saved()).trigger], [202, 'running', 'Fixing build', 'person']);
  const verifying = await c.until((_view, repair) => repair?.status === 'verifying-ci');
  assert.deepEqual([verifying.repair.category, verifying.repair.pullRequest, change(verifying.view)?.pullRequest], ['unknown', { number: 7, url: 'https://github.com/owner/app/pull/7', branch, draft: true }, { number: 7, url: 'https://github.com/owner/app/pull/7' }]);
  assert.deepEqual(change(verifying.view)?.steps.map(step => [step.name, step.status]), [['Read the failure', 'done'], ['Diagnose', 'done'], ['Change', 'done'], ['Verify', 'active'], ['Merge', 'pending']]);
  const triage = c.github.calls.filter(args => args[0] === 'run' || args.at(-1) === 'repos/owner/app/actions/runs/2/jobs?per_page=100' && !args.includes('--include'));
  assert.deepEqual(triage.map(args => args.at(-1)).sort(), ['--log-failed', 'repos/owner/app/actions/runs/2/jobs?per_page=100'], 'Triage reads the failed jobs and the failed-step log through gh.');
  assert.deepEqual(c.github.pushes, [{ branch, lease: '', files: 'add.js' }]);
  const created = c.github.calls.find(args => args.includes('repos/owner/app/pulls') && args.includes('POST'))!;
  const field = (name: string) => created.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  assert.deepEqual([field('head'), field('base'), field('title'), field('draft')], [branch, 'main', `Fix the failed CI build at ${c.sha.slice(0, 7)}`, 'true'], 'A draft pull request opens against the target branch.');
  for (const expected of ['Error: add(2, 3) returned -1, expected 5', 'Diagnosis:', 'add() subtracted; it adds now.', MODEL]) assert.ok(field('body')?.includes(expected), expected);
  assert.ok(field('body')?.includes('Error: reporting failed with token [REDACTED]') && !field('body')?.includes('ghp_'), 'The token in the log reaches the pull request only redacted.');
  assert.ok(c.prompts.length && c.prompts.every(prompt => prompt.includes('failed with token [REDACTED]') && prompt.includes('GITHUB_TOKEN=[REDACTED]') && !prompt.includes('ghp_')), 'The model sees the error lines and the tail only redacted.');
  assert.ok(c.github.calls.some(args => args.includes('repos/owner/app/issues/7/labels') && args.includes('labels[]=perpetual-repair')));
  const stored = await c.saved();
  assert.ok(stored.failures?.[0].log.includes('failed with token [REDACTED]') && !JSON.stringify(stored).includes('ghp_'), 'The stored failure is redacted.');
  assert.deepEqual(stored.attempts?.map(attempt => [attempt.model, attempt.reproduced]), [[MODEL, true]], 'The agent ran the failing step\'s command and saw it fail first.');
  assert.match(stored.pushed ?? '', /^[a-f\d]{40}$/, 'The pushed commit is recorded.');
  assert.deepEqual(c.models, [{ id: MODEL, apiKey: KEY }]);
  assert.ok(!JSON.stringify(stored).includes(KEY) && !JSON.stringify(c.boxes.created.map(box => box.calls)).includes(KEY), 'The key reaches only the model factory.');
});

// A repository whose pipeline is its web/ directory, with Vercel and Railway configuration there.
async function webRepository(directory: string) {
  const files: Record<string, string> = {
    'web/package.json': JSON.stringify({ name: 'web', private: true }),
    'web/add.js': 'module.exports = (a, b) => a - b;\n',
    'web/check.js': "if (require('./add.js')(2, 3) !== 5) { console.error('Error: add(2, 3) returned -1, expected 5'); process.exit(1); }\n",
    'web/vercel.json': '{ "framework": null }\n',
    'web/railway.toml': '[build]\nbuilder = "nixpacks"\n',
    '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Check\n        working-directory: web\n        run: node check.js\n',
  };
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); }
  fixtureGit(directory, 'init', '--quiet');
  fixtureGit(directory, 'add', '-A');
  fixtureGit(directory, 'commit', '--quiet', '-m', 'Add a web check');
  return fixtureGit(directory, 'rev-parse', 'HEAD');
}

test('attempts 1 and 2 use the App Settings model and 3 and 4 its escalation model, and the scan\'s deploy files under the root directory are refused', async t => {
  const touch = (path: string): ScriptedStep[] => [{ calls: [{ tool: 'write', input: { path, text: '{}\n' } }] }, { calls: [{ tool: 'done', input: { summary: `Changed ${path}.` } }] }];
  const c = await controller(t, {
    build: webRepository, root: '/web', escalation: ESCALATION,
    // Scan paths are relative to the pipeline's root directory; a deployment's evidence and its configuration file count,
    // each on its own.
    nodes: [
      { id: 'vercel', kind: 'deployment', label: 'Vercel', provider: 'vercel', evidence: [{ file: 'package.json' }], configFile: 'vercel.json' },
      { id: 'railway', kind: 'deployment', label: 'Railway', provider: 'railway', evidence: [{ file: 'railway.toml' }] },
      { id: 'web', kind: 'application', label: 'web', evidence: [{ file: 'package.json' }] },
    ],
    scripts: [[{ text: 'Unsure.' }], [{ text: 'Still unsure.' }], touch('web/vercel.json'), touch('web/railway.toml')],
  });
  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  const failed = await c.finished('failed');
  assert.deepEqual([failed.repair.reason, change(failed.view)?.status, change(failed.view)?.reason], ['The build was not fixed in 4 attempts.', 'not-merged', 'The build was not fixed in 4 attempts.']);
  assert.deepEqual(c.models, [{ id: MODEL, apiKey: KEY }, { id: MODEL, apiKey: KEY }, { id: ESCALATION, apiKey: KEY }, { id: ESCALATION, apiKey: KEY }]);
  const stored = await c.saved();
  assert.deepEqual(stored.attempts?.map(attempt => [attempt.number, attempt.model, attempt.failure]), [
    [1, MODEL, 'The model stopped without calling done.'], [2, MODEL, 'The model stopped without calling done.'],
    [3, ESCALATION, REJECTED.delivery], [4, ESCALATION, REJECTED.delivery],
  ], 'The Vercel configuration file and the Railway evidence file, under web/, are the scan\'s deploy files.');
  assert.deepEqual([c.github.pushes, c.github.calls.filter(args => args.includes('repos/owner/app/pulls'))], [[], []], 'A refused change is never pushed.');
});

test('without an escalation model saved, all four attempts use the App Settings model', async t => {
  const c = await controller(t, { scripts: [[{ text: 'Unsure.' }], [{ text: 'Unsure.' }], [{ text: 'Unsure.' }], [{ text: 'Unsure.' }]] });
  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  await c.finished('failed');
  assert.deepEqual(c.models.map(model => model.id), [MODEL, MODEL, MODEL, MODEL]);
});

// Fast CI and merge waits; the pull request's CI passes at its first read.
const FAST = { ci: { pollMs: 5, noRunMs: 5000 }, timing: { pollMs: 5, checksMs: 2000 } };
const STAGES = [
  { id: 'source', name: 'Source', kind: 'source', collapsed: false }, { id: 'build', name: 'Build', kind: 'build', collapsed: false },
  { id: 'beta', name: 'Beta', kind: 'sandbox', collapsed: false }, { id: 'production', name: 'Production', kind: 'production', collapsed: false },
];

test('without a Sandbox stage, a pull request that passed CI is squash-merged at its verified head through gh', async t => {
  const c = await controller(t, { scripts: [FIX], ...FAST });
  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  const merged = await c.finished('merged');
  const head = c.github.commits[0];
  assert.deepEqual([merged.repair.merged, merged.repair.pullRequest, change(merged.view)?.status], [MERGED, { number: 7, url: 'https://github.com/owner/app/pull/7', branch: `perpetual/repair/${c.sha.slice(0, 7)}`, draft: false }, 'merged']);
  assert.deepEqual(change(merged.view)?.steps.at(-1), { id: 'merge', name: 'Merge', status: 'done', detail: ['Merged ', { text: '#7', href: 'https://github.com/owner/app/pull/7' }, ' into ', { text: 'main' }, ' as ', { text: MERGED.slice(0, 7) }] });
  assert.ok(c.github.calls.some(args => args.join(' ') === 'pr ready 7 --repo owner/app'), 'CI passing readies the pull request first.');
  const merge = c.github.calls.find(args => args.includes('repos/owner/app/pulls/7/merge'))!;
  assert.deepEqual(merge.slice(merge.indexOf('--method')), ['--method', 'PUT', 'repos/owner/app/pulls/7/merge', '-f', 'merge_method=squash', '-f', `sha=${head}`, '-f', `commit_title=Fix the failed CI build at ${c.sha.slice(0, 7)} (#7)`]);
  assert.ok(c.github.calls.some(args => args.includes(`repos/owner/app/compare/${c.sha}...${head}?per_page=1`)), 'The head is compared with main as GitHub has it.');
  assert.deepEqual([(await c.saved()).merged, c.github.statuses], [MERGED, []], 'No gate ran or reported.');
});

test('a Sandbox stage without reviewed journeys holds the fix at ready, reports on the pull request head, and never moves the source', async t => {
  const c = await controller(t, { scripts: [FIX], stages: STAGES, ...FAST });
  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  const ready = await c.finished('ready');
  const head = c.github.commits[0];
  assert.deepEqual([ready.repair.reason, change(ready.view)?.status, change(ready.view)?.steps.at(-1)?.status], ['Beta needs release: No reviewed journeys.', 'needs-review', 'waiting']);
  assert.equal(c.github.calls.some(args => args.includes('repos/owner/app/pulls/7/merge')), false, 'A stage without reviewed journeys never merges by itself.');
  const stored = await c.saved();
  assert.deepEqual(stored.gates?.map(item => [item.stageId, item.sha, item.status]), [['beta', head, 'needs-release']]);
  for (let attempt = 0; attempt < 200 && !c.github.statuses.length; attempt++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(c.github.statuses, [{ repository: 'owner/app', sha: head, state: 'pending', context: 'perpetual/Beta', description: 'Needs release' }], 'The gate reports its commit status on the pull request head.');
  assert.deepEqual(await c.read(`/api/gate`), { repoPath: c.scanPath, sha: c.sha, stages: {}, production: null }, 'A repair gate is not the stage\'s gate.');
  const state = await c.read('/api/state');
  assert.deepEqual([state.scan.repo.sha, state.scan.repo.path, state.source.sha], [c.sha, c.scanPath, c.sha], 'The scan and the source stay at the watched commit.');
  assert.equal(fixtureGit(c.checkoutPath, 'rev-parse', 'HEAD'), c.sha, 'The managed source copy never moves to the pull request head.');
  assert.deepEqual(await readdir(join(c.dataDir, 'repairs', ready.repair.id)).catch(() => []), [], 'The pull request checkout is removed.');
});

test('the Build stage\'s Autopilot mode is the pipeline\'s auto-merge switch, set for the scanned source only, and Ask first stops the fix at ready after CI', async t => {
  const c = await controller(t, { scripts: [FIX], ...FAST });
  assert.deepEqual(await c.post('/api/autopilot/mode', { repoPath: c.scanPath, stageId: 'build', mode: 'off' }), { status: 400, body: { error: 'Choose Merge changes or Ask before merging.' } });
  assert.deepEqual(await c.post('/api/autopilot/mode', { repoPath: c.scanPath, stageId: 'production', mode: 'ask' }), { status: 400, body: { error: 'Autopilot is available for Build.' } });
  assert.equal((await c.post('/api/autopilot/mode', { repoPath: '/elsewhere', stageId: 'build', mode: 'ask' })).status, 409);
  const ask = await c.post('/api/autopilot/mode', { repoPath: c.scanPath, stageId: 'build', mode: 'ask' });
  assert.deepEqual([ask.status, ask.body.stages?.build?.mode, (await c.view()).stages?.build?.mode, (await c.read('/api/state')).autopilot.stages.build.mode], [200, 'ask', 'ask', 'ask']);
  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  const ready = await c.finished('ready');
  assert.deepEqual([ready.repair.reason, change(ready.view)?.status, change(ready.view)?.reason], ['Auto-merge is off.', 'needs-review', 'Auto-merge is off.']);
  assert.equal(c.github.calls.some(args => args.includes('repos/owner/app/pulls/7/merge')), false);
});

// A twin runtime that starts nothing: each twin is ready at a loopback URL of its own, and records what its checkout
// holds. Journeys pass, except in a verification's control run, where every change is blocked and the second
// milestone's reviewed check notices.
function twinsAndJourneys() {
  const built: { id: string; repoPath: string; add: string; readme: boolean }[] = [], destroyed: string[] = [], launches: JourneyRunInput[] = [];
  let port = 45170;
  const environments: ManagedRuntime = {
    async prepareEnvironment({ environment, repoPath, generate }) {
      assert.equal(generate, undefined, 'No twin config is generated.');
      built.push({ id: environment.id, repoPath, add: await readFile(join(repoPath, 'add.js'), 'utf8'), readme: await readFile(join(repoPath, 'README.md')).then(() => true, () => false) });
      return { status: 'ready', step: 'Ready', sandboxId: environment.id, services: [], apps: [{ id: 'web', url: `http://127.0.0.1:${port++}/` }] };
    },
    async environmentHealth() { return { status: 'ready' }; },
    async environmentLogs() { return ''; },
    async destroySandbox({ environment }) { destroyed.push(environment.id); },
  };
  const events = (input: JourneyRunInput): WorkerEvent[] => {
    const id = input.case.id, [first, second] = input.case.steps!;
    const step = (item: typeof first, passed: boolean) => [{ type: 'journey-step', caseId: id, stepId: item.id, status: 'running' }, { type: 'journey-step', caseId: id, stepId: item.id, status: passed ? 'completed' : 'failed', evidence: passed ? 'Reviewed checks passed.' : 'A reviewed check failed.', checks: item.checks!.map(check => ({ ...check, passed })) }];
    return input.blockWrites
      ? [...step(first, true), ...step(second, false), { type: 'result', result: { caseId: id, stopCause: 'none', assertions: [] } }]
      : [...step(first, true), ...step(second, true), { type: 'result', result: { caseId: id, stopCause: 'none', agentCompleted: true, outcomes: [{ outcomeIndex: 0, status: 'satisfied', evidence: 'Shown.' }], assertions: input.case.assertions!.map(check => ({ ...check, passed: true })) } }];
  };
  const browser: NonNullable<ServerOptions['browser']> = {
    runtime: { capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: false }), start() { throw new Error('The browser agent must not start.'); } },
    playwright: {
      capabilities: async () => ({ browserInstalled: true }),
      start(input, onEvent) {
        launches.push(input);
        let cancel!: () => void;
        const promise = new Promise<void>((resolve, reject) => { cancel = () => reject(new Error('cancelled')); setTimeout(() => { try { for (const event of events(input)) onEvent(event); resolve(); } catch (error) { reject(error); } }, 5); });
        return { promise, cancel };
      },
    },
  };
  return { runtimes: { environments: { runtime: environments }, browser }, built, destroyed, launches };
}
const JOURNEY = {
  id: 'sum', name: 'Add two numbers', goal: 'Add 2 and 3 and see the sum kept.', isolation: 'shared', selected: true, needsReview: false, preconditions: [], expectedOutcomes: ['The sum 5 is kept.'],
  steps: [{ id: 'open', title: 'Open the calculator', checks: [{ type: 'text-visible', value: 'Calculator' }] }, { id: 'add', title: 'Add 2 and 3 and reload', checks: [{ type: 'text-visible', value: 'Sum: 5' }] }],
  assertions: [{ type: 'text-visible', value: 'Sum: 5' }],
};
const CODE = "import { test } from 'perpetual';\n\ntest('Add two numbers', async ({ page, journey }) => {\n  await journey.milestone('open', async () => { await page.goto('/'); });\n  await journey.milestone('add', async () => { await page.getByRole('button', { name: 'Add' }).click(); });\n});\n";
type BrowserResponse = { config: { targetUrl: string }; preparation?: { status: string } | null; specs: Record<string, { draft?: { hash: string; verification?: { status: string; control?: string } }; approved?: { hash: string } }>; runs: { id: string; status: string; sourceRevision?: string | null; verification?: unknown }[] };
type StateResponse = { scan: { repo: { sha: string; path: string } }; source: { sha: string }; environments: { id: string; stageId: string; status: string; repoPath: string; sourceBranch: string | null; sourceRevision: string | null; repair?: string }[] };

test('a Beta journey that passes at the pull request head, and again at GitHub\'s merge of a moved main, merges the fix through the controller', async t => {
  const f = twinsAndJourneys();
  const c = await controller(t, { scripts: [FIX], stages: STAGES, ...FAST, moves: true, runtimes: f.runtimes });
  const stage = { repoPath: c.scanPath, stageId: 'beta' }, browser = () => c.read(`/api/browser?${new URLSearchParams(stage)}`) as Promise<BrowserResponse>;
  const settled = async <T>(read: () => Promise<T>, check: (value: T) => unknown) => { for (let attempt = 0; attempt < 1000; attempt++) { const value = await read(); if (check(value)) return value; await new Promise(done => setTimeout(done, 10)); } throw new Error('Nothing settled.'); };
  // Beta, as a person set it up at the scanned commit: a twin config, a reviewed journey, a twin and approved code.
  assert.equal((await c.send('/api/environments/plan', { ...stage, plan: { services: {}, apps: { web: { directory: '.', start: 'node server.js', port: 3000 } } } })).status, 200);
  assert.equal((await c.send('/api/browser/cases', { ...stage, cases: [JOURNEY] })).status, 200);
  assert.equal((await c.send('/api/environments/create', stage)).status, 202);
  const prepared = await settled(browser, view => view.preparation?.status === 'completed' && view.config.targetUrl);
  const saved = await c.send<{ spec: { draft: { hash: string } } }>('/api/browser/specs', { ...stage, caseId: JOURNEY.id, code: CODE });
  assert.equal((await c.send('/api/browser/specs/verify', { ...stage, caseId: JOURNEY.id, hash: saved.body.spec.draft.hash })).status, 202);
  const verified = await settled(browser, view => view.specs[JOURNEY.id]?.draft?.verification?.status !== 'running' && view.specs[JOURNEY.id]?.draft?.verification);
  assert.deepEqual(verified.specs[JOURNEY.id].draft?.verification, { status: 'passed', passes: 3, control: 'caught' });
  assert.equal((await c.send('/api/browser/specs/approve', { ...stage, caseId: JOURNEY.id, hash: saved.body.spec.draft.hash })).status, 200);

  await c.post('/api/autopilot/repair', { repoPath: c.scanPath, stageId: 'build', runId: '2' });
  const merged = await c.until((_view, repair) => ['merged', 'ready', 'failed', 'needs-person'].includes(repair?.status ?? ''), 3000);
  const [head] = c.github.commits, [update] = c.github.updates, branch = `perpetual/repair/${c.sha.slice(0, 7)}`;
  assert.deepEqual([merged.repair.status, merged.repair.reason, merged.repair.merged, change(merged.view)?.status], ['merged', undefined, MERGED, 'merged']);
  const stored = await c.saved();
  assert.deepEqual(stored.gates?.map(item => [item.stageId, item.sha, item.status]), [['beta', head, 'passed'], ['beta', update, 'passed']], 'Beta passed at the pull request head, then at GitHub\'s merge of main into it.');
  assert.equal(stored.pushed, update, 'A later Repair of the commit leases the branch as GitHub left it.');
  assert.equal(fixtureGit(join(c.dataDir, '..', 'github.git'), 'show', '-s', '--format=%P', update), `${head} ${c.next}`);
  const merge = c.github.calls.find(args => args.includes('repos/owner/app/pulls/7/merge'))!;
  assert.ok(merge.includes(`sha=${update}`), 'The merge names the head the journeys passed at.');
  assert.ok(c.github.calls.some(args => args.includes('repos/owner/app/pulls/7/update-branch') && args.includes(`expected_head_sha=${head}`)));
  // Each gate's status reached GitHub on its head, and the merge read it back as a check.
  const posted = (sha: string) => c.github.statuses.filter(item => item.sha === sha).map(item => [item.context, item.state, item.description]);
  for (const sha of [head, update]) assert.deepEqual(posted(sha), [['perpetual/Beta', 'pending', 'Running'], ['perpetual/Beta', 'success', 'Passed']]);
  assert.ok(c.github.calls.some(args => args.includes(`repos/owner/app/commits/${update}/status?per_page=100&page=1`)));
  // The twin was rebuilt from each head's own checkout, and the approved code ran against it.
  const repairs = join(await realpath(c.dataDir), 'repairs', stored.id);
  assert.deepEqual(f.built.map(item => [item.repoPath, item.add.includes('a + b'), item.readme]), [[c.scanPath, false, false], [join(repairs, `gate-${head.slice(0, 7)}`), true, false], [join(repairs, `gate-${update.slice(0, 7)}`), true, true]]);
  assert.deepEqual(f.destroyed, f.built.slice(0, 2).map(item => item.id), 'Each gate replaced the stage\'s twin.');
  const gateRuns = f.launches.filter(input => !input.blockWrites).slice(-2);
  assert.deepEqual(gateRuns.map(input => [input.targetUrl, input.spec?.code]), [['http://127.0.0.1:45171/', CODE], ['http://127.0.0.1:45172/', CODE]]);
  assert.equal(prepared.config.targetUrl, 'http://127.0.0.1:45170/');
  const runs = (await browser()).runs.filter(run => !run.verification);
  assert.deepEqual(runs.slice(0, 2).map(run => [run.status, run.sourceRevision]), [['passed', update], ['passed', head]], 'The stage lists the runs its repair gates made, at each head.');
  // The stage's twin is now the pull request's, and the source never moved.
  const state = await c.read('/api/state') as StateResponse, twin = state.environments.find(item => item.id === f.built[2].id)!;
  assert.deepEqual([twin.status, twin.repair, twin.sourceBranch, twin.sourceRevision], ['ready', stored.id, branch, update]);
  assert.deepEqual([state.scan.repo.sha, state.scan.repo.path, state.source.sha], [c.sha, c.scanPath, c.sha]);
  assert.equal(fixtureGit(c.checkoutPath, 'rev-parse', 'HEAD'), c.sha);
  assert.deepEqual(await c.read('/api/gate'), { repoPath: c.scanPath, sha: c.sha, stages: {}, production: null });
  assert.deepEqual((await readdir(repairs).catch(() => [])).filter(entry => entry.startsWith('gate-')), [], 'Each checkout is removed once its gates settled.');
});
