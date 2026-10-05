import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { diagnoseFailure } from '../src/providers.ts';
import { createRepairPullRequests, getGitHubFailure, pushRepairBranch, remoteRepairBranch, rerunFailedJobs, type CommandRunner } from '../src/repair/github.ts';
import { brokenRepository, fixtureGit } from './fixtures/repair-box.ts';
import { triage } from '../src/repair/triage.ts';

// A command runner that records gh's arguments and answers from fixtures; no CLI runs.
function runner(outputs: { jobs?: string | Error; log?: string | Error; rerun?: string | Error }) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const output = outputs[args[0] === 'run' ? 'log' : args.includes('POST') ? 'rerun' : 'jobs'];
    if (output instanceof Error) throw output;
    return { stdout: output ?? '' };
  };
  return { run, calls };
}
const failure = (stderr: string, code?: string) => Object.assign(new Error('Command failed: gh api'), { stderr, ...(code ? { code } : {}) });
const JOBS = JSON.stringify({ jobs: [
  { id: 11, name: 'test', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Typecheck', conclusion: 'failure' }] },
  { id: 12, name: 'lint', conclusion: 'success', steps: [] },
  { id: 'not-a-job', name: 'ignored' },
] });
// gh prefixes each line with its job, step and timestamp; the fraction 4031234 must not read as HTTP 403.
const LOG = [
  'test\tTypecheck\t2026-09-25T10:14:01.4031234Z > tsc --noEmit',
  "test\tTypecheck\t2026-09-25T10:14:01.4031235Z src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  'test\tTypecheck\t2026-09-25T10:14:01.5000000Z env GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
  'test\tTypecheck\t2026-09-25T10:14:02.0000000Z ##[error]Process completed with exit code 2.',
].join('\n');

test('a failed run is read for the named repository through the signed-in CLI, with its log unprefixed and scrubbed', async () => {
  const gh = runner({ jobs: JOBS, log: LOG });
  const result = await getGitHubFailure({ repository: 'owner/app', runId: '123' }, { run: gh.run, now: () => '2026-09-25T10:15:00.000Z' });
  assert.deepEqual(result.jobs, [{ id: '11', name: 'test', conclusion: 'failure', failedSteps: ['Typecheck'] }, { id: '12', name: 'lint', conclusion: 'success', failedSteps: [] }]);
  assert.equal(result.log, "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n##[error]Process completed with exit code 2.");
  assert.equal(result.tail.split('\n')[0], '> tsc --noEmit');
  assert.ok(!result.tail.includes('ghp_') && result.tail.includes('GITHUB_TOKEN=[REDACTED]'));
  assert.deepEqual([result.runId, result.diagnosis.category, result.observedAt], ['123', 'build', '2026-09-25T10:15:00.000Z']);
  assert.deepEqual(gh.calls.map(call => [call.file, ...call.args]), [
    ['gh', 'api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', 'repos/owner/app/actions/runs/123/jobs?per_page=100'],
    ['gh', 'run', 'view', '123', '--repo', 'owner/app', '--log-failed'],
  ]);
  assert.ok(gh.calls.every(call => call.env.GH_HOST === 'github.com' && call.env.GH_PROMPT_DISABLED === '1' && !Object.keys(call.env).some(key => key.startsWith('GIT_'))));
});

test('status-code digits inside a longer number never classify a failure as configuration', () => {
  assert.equal(diagnoseFailure('Error: build failed after 14031 ms').category, 'unknown');
  assert.equal(diagnoseFailure('Error: HTTP 403 from the registry').category, 'configuration');
});

test('only a network failure or a deadline reruns; code that names a timeout goes to repair', async () => {
  for (const [line, category, next] of [
    ["src/poll.ts(12,9): error TS2339: Property 'timeout' does not exist on type 'Options'.", 'build', 'repair'],
    ["  3:1  error  'setTimeout' is not defined  no-undef", 'unknown', 'repair'],
    ['Error: connect ETIMEDOUT 10.0.0.1:443', 'availability', 'rerun'],
    ['Error: read ECONNRESET', 'availability', 'rerun'],
    ['npm ERR! request to https://registry.npmjs.org/x failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org', 'availability', 'rerun'],
    ["Error: ReadTimeoutError: HTTPSConnectionPool(host='pypi.org', port=443): Read timed out.", 'availability', 'rerun'],
    ['Error: dial tcp 140.82.112.3:443: i/o timeout', 'availability', 'rerun'],
  ]) {
    const failure = await getGitHubFailure({ repository: 'owner/app', runId: '1' }, { run: runner({ jobs: JOBS, log: `test\tBuild\t2026-09-25T10:14:01.0000000Z ${line}` }).run });
    assert.deepEqual([failure.diagnosis.category, triage([failure], false).next], [category, next], line);
  }
});

// The failed-step log as gh prints it: each line prefixed with its job, step and timestamp.
const failedLog = (...lines: string[]) => lines.map((line, index) => `test\tBuild\t2026-09-25T10:14:0${index}.0000000Z ${line}`).join('\n');
const triaged = async (...lines: string[]) => {
  const failure = await getGitHubFailure({ repository: 'owner/app', runId: '1' }, { run: runner({ jobs: JOBS, log: failedLog(...lines) }).run });
  return [failure.diagnosis.category, triage([failure], false).next];
};

test('a missing token or permission GitHub, git or npm reports needs a person and never reaches the agent', async () => {
  for (const lines of [
    ['##[error]Input required and not supplied: token'],
    ['##[error]Input required and not supplied: github-token'],
    ['Error: Resource not accessible by integration'],
    ['RequestError [HttpError]: Resource not accessible by personal access token'],
    ['remote: Permission to owner/app.git denied to github-actions[bot].'],
    ['HttpError: Bad credentials'],
    ['Error: {"message": "Bad credentials", "documentation_url": "https://docs.github.com/rest"}'],
    ['npm ERR! code E401', 'npm ERR! Unable to authenticate, your authentication token seems to be invalid.'],
    ['npm error code E403', 'npm error 403 Forbidden - PUT https://registry.npmjs.org/app'],
    ['npm ERR! code ENEEDAUTH', 'npm ERR! need auth This command requires you to be logged in to https://registry.npmjs.org/'],
    // A permission failure beside a network error is still a person's to fix.
    ['Error: connect ETIMEDOUT 10.0.0.1:443', 'Error: Resource not accessible by integration'],
    // GitHub's API refusing a token, pretty-printed by curl or printed by gh, git asking for or refusing credentials,
    // and an HTTP client refusing a request.
    ['{', '  "message": "Bad credentials",', '  "documentation_url": "https://docs.github.com/rest"', '}', '##[error]Process completed with exit code 22.'],
    ['gh: Bad credentials (HTTP 401)', '##[error]Process completed with exit code 1.'],
    ["fatal: Authentication failed for 'https://github.com/owner/app.git/'"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ['curl: (22) The requested URL returned error: 403'],
    // gh's own refusals and a credential variable that is not set carry no error marker of their own.
    ['gh: Resource not accessible by integration (HTTP 403)', '##[error]Process completed with exit code 1.'],
    ['HTTP 403: Resource not accessible by integration (https://api.github.com/repos/owner/app/releases)', '##[error]Process completed with exit code 1.'],
    ['gh: Requires authentication (HTTP 401)', '##[error]Process completed with exit code 4.'],
    ['VERCEL_TOKEN is required', '##[error]Process completed with exit code 1.'],
  ]) assert.deepEqual(await triaged(...lines), ['configuration', 'needs-person'], lines.join(' | '));
});

test('a compile error or a failed test that mentions a token, 401, 403 or unauthorized is code, and a passing test\'s line is never an error', async () => {
  const typeError = "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
  for (const [lines, category] of [
    [['✓ returns 403 when access is denied (4 ms)', typeError], 'build'],
    [['✓ maps err_forbidden to 403', typeError], 'build'],
    [['    ✔ reports an error when API_KEY is missing', typeError], 'build'],
    [['ok 3 - rejects a request without a token: error 401', typeError], 'build'],
    [['✓ unauthorized visitors are denied', 'AssertionError: expected 3 to equal 4'], 'test-regression'],
    [["src/session.ts(8,3): error TS2741: Property 'token' is missing in type '{}' but required in type 'Session'."], 'build'],
    [['AssertionError: expected response status 200, got 401'], 'test-regression'],
    [['● auth › rejects unauthorized requests', 'AssertionError: expected 200 to equal 403'], 'test-regression'],
  ] as const) assert.deepEqual(await triaged(...lines), [category, 'repair'], lines.join(' | '));
});

test('an application\'s own permission or credential messages are code, and go to repair', async () => {
  for (const [lines, category] of [
    [["Error: EACCES: permission denied, open '/home/runner/work/app/dist/out.js'"], 'unknown'],
    [["TypeError: Cannot read properties of undefined (reading 'token')"], 'unknown'],
    [['FAIL src/login.test.ts > rejects a wrong password', 'AssertionError: expected "Bad credentials" to equal "Signed in"'], 'test-regression'],
    [['Error: Input required: name'], 'unknown'],
  ] as const) assert.deepEqual(await triaged(...lines), [category, 'repair'], lines.join(' | '));
});

test('a test regression, a dependency mismatch and a compile error beside a network error go to repair, never a rerun', async () => {
  for (const [lines, category] of [
    [['FAIL src/add.test.ts > add > sums', 'AssertionError: expected -1 to be 5'], 'test-regression'],
    [['AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'], 'test-regression'],
    [['npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync.'], 'dependency'],
    [[' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json'], 'dependency'],
    [['Error: getaddrinfo EAI_AGAIN api.example.com', "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."], 'build'],
    [['Error: connect ECONNREFUSED 127.0.0.1:5432', 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"'], 'dependency'],
  ] as const) assert.deepEqual(await triaged(...lines), [category, 'repair'], lines.join(' | '));
  assert.deepEqual(await triaged('FAIL src/db.test.ts > saves', 'Error: connect ECONNREFUSED 127.0.0.1:5432'), ['availability', 'rerun'], 'A test that failed on a refused connection reruns first.');
});

test('explicit assertion failures outrank unrelated timeout output from passing tests in either log order', async () => {
  const incidental = ['stderr | src/cache.test.ts > handles a slow upstream', '[cache] Request timed out; using fallback', '✓ handles a slow upstream'];
  for (const assertion of [
    "AssertionError: expected 'draft' to be 'stored' // Object.is equality",
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    'TestingLibraryElementError: Unable to find an element with the text: Saved',
  ]) {
    const failed = ['FAIL src/report.test.ts > saves the completed result', assertion];
    for (const lines of [[...incidental, ...failed], [...failed, ...incidental]]) {
      assert.deepEqual(await triaged(...lines), ['test-regression', 'repair'], lines.join(' | '));
    }
  }
});

test('ordinary expected/received output and passing assertion-test titles do not turn a real network failure into code repair', async () => {
  for (const error of ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'Error: request timed out after 10000 ms']) {
    assert.deepEqual(await triaged(
      '✓ prints an AssertionError for a missing field',
      'ok 4 - formats TestingLibraryElementError correctly',
      'received: expected payload received from the test fixture',
      'FAIL src/service.test.ts > fetches a record',
      error,
    ), ['availability', 'rerun']);
  }
  assert.deepEqual(await triaged('Error: Resource not accessible by integration', 'AssertionError: expected 1 to equal 2'), ['configuration', 'needs-person']);
});

test('a run outside the connected repository shape, or without a numeric id, is refused before gh runs', async () => {
  const gh = runner({ jobs: JOBS, log: LOG });
  for (const input of [{ repository: 'owner', runId: '1' }, { repository: 'owner/..', runId: '1' }, { repository: 'owner/app', runId: '1; rm -rf /' }, { repository: 'owner/app', runId: null }, { repository: null, runId: '1' }]) {
    await assert.rejects(getGitHubFailure(input, { run: gh.run }), /Choose a GitHub workflow run from the connected repository/);
    await assert.rejects(rerunFailedJobs(input, { run: gh.run }), /Choose a GitHub workflow run from the connected repository/);
  }
  assert.deepEqual(gh.calls, []);
});

test('gh failures return fixed messages, never the CLI output', async () => {
  const leaked = 'HTTP 403: Resource not accessible (https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com)';
  const denied = await getGitHubFailure({ repository: 'owner/app', runId: 1 }, { run: runner({ jobs: failure(leaked), log: LOG }).run }).catch((error: Error) => error);
  assert.equal((denied as Error).message, 'GitHub denied access to workflow runs. Check repository access and Actions permissions.');
  await assert.rejects(getGitHubFailure({ repository: 'owner/app', runId: 1 }, { run: runner({ jobs: failure('', 'ENOENT'), log: LOG }).run }), /GitHub CLI is unavailable/);
  await assert.rejects(getGitHubFailure({ repository: 'owner/app', runId: 1 }, { run: runner({ jobs: '{"message":', log: LOG }).run }), /unreadable job list/);
  await assert.rejects(getGitHubFailure({ repository: 'owner/app', runId: 1 }, { run: runner({ jobs: failure('HTTP 401: Bad credentials'), log: LOG }).run }), /gh auth login/);
  // A failed-step log over the read limit is no network problem, however often the repair is tried again.
  const huge = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  await assert.rejects(getGitHubFailure({ repository: 'owner/app', runId: 1 }, { run: runner({ jobs: JOBS, log: huge }).run }), (error: Error) => error.message === 'Reading the failed log returned more than Perpetual reads.');
});

test('a rerun posts rerun-failed-jobs for the run, and a refusal names the permission it needs', async () => {
  const gh = runner({ rerun: '' });
  await rerunFailedJobs({ repository: 'owner/app', runId: '123' }, { run: gh.run });
  assert.deepEqual(gh.calls.map(call => call.args), [['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/owner/app/actions/runs/123/rerun-failed-jobs']]);
  await assert.rejects(rerunFailedJobs({ repository: 'owner/app', runId: '123' }, { run: runner({ rerun: failure('HTTP 403: Must have admin rights to Repository.') }).run }), /GitHub denied the rerun\. Check write access to Actions/);
});

const HEAD = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
test('a push names only the repair branch: any other ref is refused before git runs', async () => {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: CommandRunner = async (file, args, options) => { calls.push({ file, args, env: options.env }); return { stdout: '' }; };
  for (const branch of ['main', 'refs/heads/main', 'perpetual/repair/../main', 'perpetual/repair/cb9292c:refs/heads/main', 'perpetual/repair/CB9292C', 'perpetual/repair/cb9292c main', 'perpetual/other/cb9292c', 'perpetual/repair/cb9292c/x', null]) {
    await assert.rejects(pushRepairBranch({ directory: '/data/repairs/r/clone', repository: 'owner/app', branch, sha: HEAD, lease: '' }, { run }), /A repair pushes only its perpetual\/repair branch/, String(branch));
  }
  for (const input of [{ sha: 'main', lease: '' }, { sha: HEAD, lease: 'main' }, { sha: HEAD, lease: null }]) {
    await assert.rejects(pushRepairBranch({ directory: '/data/repairs/r/clone', repository: 'owner/app', branch: 'perpetual/repair/cb9292c', ...input }, { run }), /only its own commit/);
  }
  await assert.rejects(pushRepairBranch({ directory: 'relative', repository: 'owner/app', branch: 'perpetual/repair/cb9292c', sha: HEAD, lease: '' }, { run }), /copy is unavailable/);
  await assert.rejects(pushRepairBranch({ directory: '/data/clone', repository: 'owner/..', branch: 'perpetual/repair/cb9292c', sha: HEAD, lease: '' }, { run }), /Choose a GitHub repository/);
  assert.deepEqual(calls, []);
});

test('the push leases the branch and authenticates through gh\'s credential helper, never a token in its arguments', async () => {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: CommandRunner = async (file, args, options) => { calls.push({ file, args, env: options.env }); return { stdout: '' }; };
  await pushRepairBranch({ directory: '/data/repairs/r/clone', repository: 'owner/app', branch: 'perpetual/repair/cb9292c', sha: HEAD, lease: 'd'.repeat(40) }, { run });
  const [call] = calls;
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args.slice(call.args.indexOf('-C')), ['-C', '/data/repairs/r/clone', 'push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/perpetual/repair/cb9292c:${'d'.repeat(40)}`, '--', 'https://github.com/owner/app.git', `${HEAD}:refs/heads/perpetual/repair/cb9292c`]);
  assert.ok(call.args.includes('credential.helper=!gh auth git-credential') && call.args.includes(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`));
  assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.ok(!call.args.some(arg => /gh[pousr]_|github_pat_|@github\.com/.test(arg)));
  // git push --porcelain prints the rejected ref on stdout; stderr only says the push failed.
  const stale = Object.assign(new Error('Command failed'), { stdout: `!\t${HEAD}:refs/heads/perpetual/repair/cb9292c\t[rejected] (stale info)\nDone`, stderr: "error: failed to push some refs to 'https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/owner/app.git'" });
  await assert.rejects(pushRepairBranch({ directory: '/data/clone', repository: 'owner/app', branch: 'perpetual/repair/cb9292c', sha: HEAD, lease: '' }, { run: async () => { throw stale; } }), (error: Error) => error.message === 'The repair branch changed on GitHub. Start the repair again.');
  await assert.rejects(pushRepairBranch({ directory: '/data/clone', repository: 'owner/app', branch: 'perpetual/repair/cb9292c', sha: HEAD, lease: '' }, { run: async () => { throw failure('remote: Permission to owner/app.git denied. HTTP 403'); } }), /GitHub denied the push/);
});

test('pull requests open as drafts of the repair branch against the target branch, and are readied, labelled and closed through gh', async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_file, args) => {
    calls.push(args);
    if (args.includes('user')) return { stdout: JSON.stringify({ login: 'developer', id: 1234 }) };
    if (args.some(arg => arg.startsWith('repos/owner/app/pulls?'))) return { stdout: '[]' };
    return { stdout: JSON.stringify({ number: 7, html_url: 'https://github.com/owner/app/pull/7', draft: true }) };
  };
  const pulls = createRepairPullRequests({ run });
  assert.deepEqual(await pulls.account(), { login: 'developer', id: 1234 });
  assert.equal(await pulls.find({ repository: 'owner/app', branch: 'perpetual/repair/cb9292c', base: 'main' }), null);
  assert.deepEqual(await pulls.create({ repository: 'owner/app', base: 'main', branch: 'perpetual/repair/cb9292c', title: 'Fix the failed CI build at cb9292c', body: '@owner token=[REDACTED]' }), { number: 7, url: 'https://github.com/owner/app/pull/7', draft: true });
  await pulls.ready({ repository: 'owner/app', number: 7 });
  await pulls.label({ repository: 'owner/app', number: 7, label: 'perpetual-repair' });
  await pulls.comment({ repository: 'owner/app', number: 7, body: 'Perpetual closed this repair: Superseded by ddddddd.' });
  await pulls.close({ repository: 'owner/app', number: 7 });
  const create = calls[2];
  assert.deepEqual(create.slice(create.indexOf('--method')), ['--method', 'POST', 'repos/owner/app/pulls', '-f', 'title=Fix the failed CI build at cb9292c', '-f', 'head=perpetual/repair/cb9292c', '-f', 'base=main', '-f', 'body=@owner token=[REDACTED]', '-F', 'draft=true']);
  assert.ok(calls[1].includes(`repos/owner/app/pulls?state=open&per_page=5&head=${encodeURIComponent('owner:perpetual/repair/cb9292c')}&base=main`));
  assert.deepEqual(calls[3], ['pr', 'ready', '7', '--repo', 'owner/app']);
  assert.deepEqual(calls[4].slice(-3), ['repos/owner/app/issues/7/labels', '-f', 'labels[]=perpetual-repair']);
  assert.deepEqual(calls[5].slice(-3), ['repos/owner/app/issues/7/comments', '-f', 'body=Perpetual closed this repair: Superseded by ddddddd.']);
  assert.deepEqual(calls[6].slice(-4), ['PATCH', 'repos/owner/app/pulls/7', '-f', 'state=closed']);
  await assert.rejects(pulls.create({ repository: 'owner/app', base: 'main', branch: 'main', title: 't', body: 'b' }), /only its perpetual\/repair branch/);
  await assert.rejects(pulls.ready({ repository: 'owner/app', number: '7; rm -rf /' }), /Choose the repair's pull request/);
  assert.equal(calls.length, 7);
});

// A person may open or retarget a pull request from the repair branch into another base, such as a release branch.
test('a repair continues only its own branch\'s open pull request into the target branch, never one into another base', async () => {
  const open = (number: number, base: string, head = 'perpetual/repair/cb9292c') => ({ number, html_url: `https://github.com/owner/app/pull/${number}`, draft: true, head: { ref: head }, base: { ref: base } });
  const answer = (pulls: unknown[]) => createRepairPullRequests({ run: async () => ({ stdout: JSON.stringify(pulls) }) });
  assert.deepEqual(await answer([open(9, 'release'), open(7, 'main')]).find({ repository: 'owner/app', branch: 'perpetual/repair/cb9292c', base: 'main' }), { number: 7, url: 'https://github.com/owner/app/pull/7', draft: true });
  assert.equal(await answer([open(9, 'release'), open(8, 'main', 'perpetual/repair/abc1234')]).find({ repository: 'owner/app', branch: 'perpetual/repair/cb9292c', base: 'main' }), null);
});

// Real git against a local bare repository standing in for GitHub: the runner swaps GitHub's URL for its path.
test('the repair branch is read as GitHub has it, and a push whose lease no longer holds says the branch changed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-repair-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, 'app.git'), work = join(root, 'work'), exec = promisify(execFile) as CommandRunner;
  await promisify(execFile)('git', ['init', '--quiet', '--bare', bare]);
  const first = await brokenRepository(work);
  await writeFile(join(work, 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fixtureGit(work, 'commit', '--quiet', '-am', 'Fix');
  const second = fixtureGit(work, 'rev-parse', 'HEAD');
  const run: CommandRunner = (file, args, options) => exec(file, args.map(arg => arg === 'https://github.com/owner/app.git' ? bare : arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg), options);
  const branch = 'perpetual/repair/cb9292c', input = { directory: work, repository: 'owner/app', branch };
  assert.equal(await remoteRepairBranch(input, { run }), null, 'A branch GitHub does not have reads as null.');
  await pushRepairBranch({ ...input, sha: first, lease: '' }, { run });
  assert.equal(await remoteRepairBranch(input, { run }), first);
  for (const lease of ['', 'd'.repeat(40)]) {
    await assert.rejects(pushRepairBranch({ ...input, sha: second, lease }, { run }), (error: Error) => error.message === 'The repair branch changed on GitHub. Start the repair again.', lease || 'empty lease');
  }
  assert.equal(await remoteRepairBranch(input, { run }), first, 'A lease that no longer holds overwrites nothing.');
  await pushRepairBranch({ ...input, sha: second, lease: first }, { run });
  assert.equal(await remoteRepairBranch(input, { run }), second);
});

test('a pull request\'s state is read as open, closed or merged, with the merge commit the same read names', async () => {
  const M = 'e'.repeat(40);
  // An open pull request's merge_commit_sha is GitHub's test merge, never a merge commit.
  const answers: Record<string, unknown> = { 7: { number: 7, state: 'open', merged: false, merge_commit_sha: 'a'.repeat(40) }, 8: { number: 8, state: 'closed', merged: false }, 9: { number: 9, state: 'closed', merged: true, merged_at: '2026-09-25T11:00:00Z', merge_commit_sha: M.toUpperCase() }, 10: { number: 10, state: 'closed', merged_at: '2026-09-25T11:00:00Z', merge_commit_sha: null } };
  const calls: string[][] = [];
  const run: CommandRunner = async (_file, args) => { calls.push(args); return { stdout: JSON.stringify(answers[args.at(-1)!.split('/').at(-1)!]) }; };
  const pulls = createRepairPullRequests({ run });
  assert.deepEqual(await Promise.all([7, 8, 9, 10].map(number => pulls.state({ repository: 'owner/app', number }))), [
    { state: 'open', mergeCommit: null }, { state: 'closed', mergeCommit: null }, { state: 'merged', mergeCommit: M }, { state: 'merged', mergeCommit: null },
  ]);
  assert.deepEqual(calls[0].slice(-3), ['--method', 'GET', 'repos/owner/app/pulls/7']);
  await assert.rejects(createRepairPullRequests({ run: async () => ({ stdout: '{"state":"weird"}' }) }).state({ repository: 'owner/app', number: 7 }), /unreadable pull request/);
});

test('a close GitHub refuses is marked refused; a network error, a timeout or a rate limit is not', async () => {
  const close = (error: Error) => createRepairPullRequests({ run: async () => { throw error; } }).close({ repository: 'owner/app', number: 7 }).then(() => null, (reason: Error & { refused?: unknown }) => [reason.message, reason.refused === true]);
  assert.deepEqual(await close(failure('HTTP 403: Resource not accessible by integration')), ['GitHub denied the pull request. Check write access to this repository.', true]);
  assert.deepEqual(await close(failure('HTTP 404: Not Found')), ['GitHub denied the pull request. Check write access to this repository.', true]);
  assert.deepEqual(await close(failure('error connecting to api.github.com')), ['Closing the pull request failed. Check your network connection and try again.', false]);
  assert.deepEqual(await close(failure('API rate limit exceeded')), ['GitHub has temporarily limited requests. Wait before trying again.', false]);
  assert.deepEqual(await close(Object.assign(new Error('Command failed'), { killed: true })), ['Closing the pull request timed out. Try again.', false]);
});

test('the merge step reads the pull request, its head\'s checks page by page and how far it is behind, through gh', async () => {
  const P = 'f'.repeat(40), T = 'e'.repeat(40), calls: string[][] = [];
  const pull = { number: 7, state: 'open', merged: false, merge_commit_sha: 'a'.repeat(40), draft: false, head: { sha: P.toUpperCase(), ref: 'perpetual/repair/cb9292c', repo: { full_name: 'owner/app' } }, base: { sha: T, ref: 'main' } };
  const runs = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => ({ name: `check ${offset + index}`, status: 'completed', conclusion: 'success' }));
  const run: CommandRunner = async (_file, args) => {
    calls.push(args);
    const endpoint = args.find(arg => arg.startsWith('repos/'))!;
    if (endpoint === 'repos/owner/app/pulls/7') return { stdout: JSON.stringify(pull) };
    if (endpoint.includes('/check-runs?')) { const page = Number(new URL(`https://x/${endpoint}`).searchParams.get('page')); return { stdout: JSON.stringify({ total_count: 150, check_runs: page === 1 ? runs(100) : runs(50, 100) }) }; }
    if (endpoint.includes('/status?')) return { stdout: JSON.stringify({ state: 'pending', total_count: 1, statuses: [{ context: 'perpetual/Beta', state: 'pending', description: 'Running' }] }) };
    if (endpoint.startsWith('repos/owner/app/compare/')) return { stdout: JSON.stringify({ status: 'diverged', ahead_by: 1, behind_by: 2 }) };
    throw new Error(`unexpected ${endpoint}`);
  };
  const pulls = createRepairPullRequests({ run });
  assert.deepEqual(await pulls.pull({ repository: 'owner/app', number: 7 }), { state: 'open', merged: false, mergeCommit: null, draft: false, head: { sha: P, ref: 'perpetual/repair/cb9292c', repository: 'owner/app' }, base: { sha: T, ref: 'main' } });
  const checks = await pulls.checks({ repository: 'owner/app', sha: P });
  assert.deepEqual([checks.runs.length, checks.runs[149], checks.statuses, checks.complete], [150, { name: 'check 149', status: 'completed', conclusion: 'success' }, [{ context: 'perpetual/Beta', state: 'pending' }], true]);
  assert.deepEqual(await pulls.compare({ repository: 'owner/app', base: T, head: P }), { status: 'diverged', behindBy: 2, aheadBy: 1 });
  assert.deepEqual(calls.map(args => args.slice(args.indexOf('--method'))), [
    ['--method', 'GET', 'repos/owner/app/pulls/7'],
    ['--method', 'GET', `repos/owner/app/commits/${P}/check-runs?per_page=100&page=1`],
    ['--method', 'GET', `repos/owner/app/commits/${P}/status?per_page=100&page=1`],
    ['--method', 'GET', `repos/owner/app/commits/${P}/check-runs?per_page=100&page=2`],
    ['--method', 'GET', `repos/owner/app/compare/${T}...${P}?per_page=1`],
  ]);
  assert.ok(calls.every(args => args.slice(0, 5).join(' ') === 'api --hostname github.com -H Accept: application/vnd.github+json'));
  const merged = createRepairPullRequests({ run: async () => ({ stdout: JSON.stringify({ ...pull, state: 'closed', merged: true, merged_at: '2026-09-25T11:00:00Z' }) }) });
  assert.equal((await merged.pull({ repository: 'owner/app', number: 7 })).mergeCommit, 'a'.repeat(40), 'A merged pull request names its merge commit.');
  const endless = createRepairPullRequests({ run: async (_file, args) => ({ stdout: JSON.stringify(args.some(arg => arg.includes('check-runs')) ? { total_count: 5000, check_runs: runs(100) } : { total_count: 0, statuses: [] }) }) });
  assert.equal((await endless.checks({ repository: 'owner/app', sha: P })).complete, false, 'More than ten pages of checks are not all read.');
  for (const answer of [{ total_count: 1 }, { total_count: 1, check_runs: [{ name: 'x' }] }, 'not json']) {
    await assert.rejects(createRepairPullRequests({ run: async () => ({ stdout: typeof answer === 'string' ? answer : JSON.stringify(answer) }) }).checks({ repository: 'owner/app', sha: P }), /unreadable/);
  }
  await assert.rejects(createRepairPullRequests({ run: async () => ({ stdout: JSON.stringify({ ...pull, head: { ref: 'x' } }) }) }).pull({ repository: 'owner/app', number: 7 }), /unreadable pull request/);
  await assert.rejects(pulls.compare({ repository: 'owner/app', base: 'main', head: P }), /Choose a commit/);
  assert.equal(calls.length, 5, 'A branch name is never sent as a commit.');
});

test('a commit\'s parents are read in order through gh, and an unreadable commit or a branch name is refused', async () => {
  const P = 'f'.repeat(40), T = 'e'.repeat(40), H = 'a'.repeat(40), calls: string[][] = [];
  const run: CommandRunner = async (_file, args) => { calls.push(args); return { stdout: JSON.stringify({ sha: H, parents: [{ sha: P.toUpperCase(), url: 'https://api.github.com/x' }, { sha: T }] }) }; };
  assert.deepEqual(await createRepairPullRequests({ run }).parents({ repository: 'owner/app', sha: H }), [P, T]);
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--method')), ['--method', 'GET', `repos/owner/app/git/commits/${H}`]);
  for (const answer of [{}, { parents: 'x' }, { parents: [{ sha: 'main' }] }, { parents: [null] }]) {
    await assert.rejects(createRepairPullRequests({ run: async () => ({ stdout: JSON.stringify(answer) }) }).parents({ repository: 'owner/app', sha: H }), /unreadable commit/, JSON.stringify(answer));
  }
  await assert.rejects(createRepairPullRequests({ run }).parents({ repository: 'owner/app', sha: 'main' }), /Choose a commit/);
  assert.equal(calls.length, 1, 'A branch name is never sent as a commit.');
});

test('the pull request branch is updated and merged only at the verified head, and GitHub\'s refusals return fixed messages', async () => {
  const P = 'f'.repeat(40), M = 'd'.repeat(40), calls: string[][] = [];
  let answer: Error | string = JSON.stringify({ sha: M, merged: true, message: 'Pull Request successfully merged' });
  const run: CommandRunner = async (_file, args) => { calls.push(args); if (answer instanceof Error) throw answer; return { stdout: answer }; };
  const pulls = createRepairPullRequests({ run });
  assert.deepEqual(await pulls.merge({ repository: 'owner/app', number: 7, sha: P, title: 'Fix the failed CI build at cb9292c (#7)' }), { sha: M });
  answer = JSON.stringify({ message: 'Updating pull request branch.', url: 'https://github.com/owner/app/pull/7' });
  await pulls.updateBranch({ repository: 'owner/app', number: 7, sha: P });
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--method')), ['--method', 'PUT', 'repos/owner/app/pulls/7/merge', '-f', 'merge_method=squash', '-f', `sha=${P}`, '-f', 'commit_title=Fix the failed CI build at cb9292c (#7)', '-f', 'commit_message=Merged by Perpetual.'], 'No model text from the repair reaches the target branch.');
  assert.deepEqual(calls[1].slice(calls[1].indexOf('--method')), ['--method', 'PUT', 'repos/owner/app/pulls/7/update-branch', '-f', `expected_head_sha=${P}`]);
  const refused = async (call: () => Promise<unknown>, stderr: string) => { answer = failure(stderr); return call().then(() => null, (error: Error & { refused?: unknown }) => [error.message, error.refused === true]); };
  const merge = () => pulls.merge({ repository: 'owner/app', number: 7, sha: P, title: 't' }), update = () => pulls.updateBranch({ repository: 'owner/app', number: 7, sha: P });
  assert.deepEqual(await refused(merge, 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)'), ['The pull request changed after verification.', true]);
  assert.deepEqual(await refused(merge, 'gh: Pull Request is not mergeable (HTTP 405)'), ['GitHub refused the merge. Check the pull request\'s required reviews and checks.', true]);
  assert.deepEqual(await refused(update, 'gh: merge conflict between base and head (HTTP 422)'), ['GitHub could not update the pull request branch. Resolve its conflicts on GitHub.', true]);
  assert.deepEqual(await refused(update, 'gh: Resource not accessible by integration (HTTP 403)'), ['GitHub denied the pull request. Check write access to this repository.', true]);
  assert.deepEqual(await refused(merge, 'error connecting to api.github.com'), ['Merging the pull request failed. Check your network connection and try again.', false]);
  answer = JSON.stringify({ merged: false, message: 'Not merged' });
  await assert.rejects(merge(), /did not merge/);
  const before = calls.length;
  await assert.rejects(pulls.merge({ repository: 'owner/app', number: 7, sha: 'main', title: 't' }), /Choose a commit/);
  await assert.rejects(pulls.updateBranch({ repository: 'owner/..', number: 7, sha: P }), /Choose a GitHub repository/);
  assert.equal(calls.length, before, 'A branch name or another repository is refused before gh runs.');
});
