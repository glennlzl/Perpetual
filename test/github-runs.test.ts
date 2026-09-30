import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRunsReader, githubRequest, normalizeWorkflowRuns, normalizeWorkflowJobs, parseGitHubResponse, type GitHubResponse } from '../src/github-runs.ts';

type Route = [RegExp, (endpoint: string, etag: string | null) => GitHubResponse];
type Invocation = [command: string, args: string[], options: { env: NodeJS.ProcessEnv }];

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
const REPO = 'acme/storefront';
const LOGIN = 'glennlzl';
// Trimmed from the shapes GitHub returns for GET /repos/{owner}/{repo}/actions/runs and /runs/{id}/jobs.
const workflowRun = (id: number, extra: object = {}) => ({
  id, name: 'CI', display_title: 'Add credit ledger', node_id: 'WFR_kwLOx', head_branch: 'main', head_sha: SHA, path: '.github/workflows/ci.yml', run_number: 412, event: 'push',
  status: 'completed', conclusion: 'success', workflow_id: 9001, check_suite_id: 1, url: `https://api.github.com/repos/${REPO}/actions/runs/${id}`, html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:04:00Z', run_attempt: 1, run_started_at: '2026-09-23T10:00:05Z', actor: { login: 'glennlzl' }, head_commit: { id: SHA, message: 'Add credit ledger' }, ...extra,
});
const runsPage = (runs: object[]) => ({ total_count: runs.length, workflow_runs: runs });
const workflowJob = (id: number, runId: number, extra: object = {}) => ({
  id, run_id: runId, workflow_name: 'CI', head_branch: 'main', run_url: `https://api.github.com/repos/${REPO}/actions/runs/${runId}`, run_attempt: 1, node_id: 'CR_kwDO', head_sha: SHA, html_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${id}`,
  status: 'in_progress', conclusion: null, created_at: '2026-09-23T10:00:06Z', started_at: '2026-09-23T10:00:10Z', completed_at: null, name: 'Test', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 12',
  steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: '2026-09-23T10:00:10Z', completed_at: '2026-09-23T10:00:12Z' },
    { name: 'Run actions/checkout@v4', status: 'completed', conclusion: 'success', number: 2, started_at: '2026-09-23T10:00:12Z', completed_at: '2026-09-23T10:00:14Z' },
    { name: 'Unit tests', status: 'in_progress', conclusion: null, number: 3, started_at: '2026-09-23T10:00:14Z', completed_at: null },
    { name: 'Complete job', status: 'queued', conclusion: null, number: 4, started_at: null, completed_at: null },
  ], ...extra,
});
const jobsPage = (jobs: object[]) => ({ total_count: jobs.length, jobs });

test('reads all workflow-run pages before reporting a commit', async () => {
  const seen: string[] = [];
  const reader = createGitHubRunsReader({ request: async endpoint => {
    seen.push(endpoint);
    if (endpoint.includes('/jobs')) return { status: 200, data: jobsPage([]) };
    return { status: 200, data: { total_count: 51, workflow_runs: endpoint.includes('page=2') ? [workflowRun(51, { workflow_id: 999, conclusion: 'failure' })] : Array.from({ length: 50 }, (_, index) => workflowRun(index + 1)) } };
  } });
  const result = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(result.runs.length, 51);
  assert.equal(result.runs.at(-1)?.conclusion, 'failure');
  assert.ok(seen.some(endpoint => endpoint.includes('&page=2')));
});

for (const data of [{ total_count: 2, workflow_runs: [workflowRun(1)] }, { total_count: 1001, workflow_runs: [] }, { workflow_runs: [] }, { total_count: 1, workflow_runs: [{ ...workflowRun(1), workflow_id: null }] }]) test('incomplete workflow-run pages cannot become successful Build evidence', async () => {
  const reader = createGitHubRunsReader({ request: async () => ({ status: 200, data }) });
  await assert.rejects(reader.read({ repository: REPO, sha: SHA, login: LOGIN }), /complete|limit/);
});

test('matrix jobs are read completely for the exact run attempt', async () => {
  const seen: string[] = [];
  const reader = createGitHubRunsReader({ request: async endpoint => {
    seen.push(endpoint);
    if (!endpoint.includes('/jobs')) return { status: 200, data: runsPage([workflowRun(11, { run_attempt: 2 })]) };
    return { status: 200, data: { total_count: 101, jobs: endpoint.includes('page=2') ? [workflowJob(101, 11, { name: 'Tests (101)' })] : Array.from({ length: 100 }, (_, index) => workflowJob(index + 1, 11, { name: `Tests (${index + 1})` })) } };
  } });
  const result = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(result.runs[0].jobs?.length, 101);
  assert.ok(seen.some(endpoint => endpoint.includes('/attempts/2/jobs?')));
});

test('an incomplete jobs response remains unavailable instead of an empty successful list', async () => {
  const reader = createGitHubRunsReader({ request: async endpoint => ({ status: 200, data: endpoint.includes('/jobs') ? { total_count: 2, jobs: [workflowJob(1, 11)] } : runsPage([workflowRun(11)]) }) });
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).runs[0].jobs, null);
});

function recorder(routes: Route[]) {
  const calls: { endpoint: string; etag: string | null }[] = [];
  const request = async (endpoint: string, etag: string | null) => {
    calls.push({ endpoint, etag });
    const route = routes.find(([pattern]) => pattern.test(endpoint));
    if (!route) throw new Error(`Unexpected endpoint ${endpoint}`);
    return route[1](endpoint, etag);
  };
  return { calls, request };
}

test('normalizes only current-commit runs with their workflow path and attempt', () => {
  const runs = normalizeWorkflowRuns(runsPage([
    workflowRun(11, { path: '.github/workflows/deploy.yml@refs/heads/main', status: 'in_progress', conclusion: null }),
    workflowRun(12, { head_sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567' }),
    workflowRun(13, { status: 'surprising', conclusion: 'also-surprising', html_url: 'javascript:alert(1)' }),
  ]), SHA);
  assert.deepEqual(runs[0], { id: '11', workflowId: '9001', name: 'CI', path: '.github/workflows/deploy.yml', event: 'push', status: 'in_progress', conclusion: null, attempt: 1, sha: SHA, branch: 'main', url: `https://github.com/${REPO}/actions/runs/11`, createdAt: '2026-09-23T10:00:00Z', startedAt: '2026-09-23T10:00:05Z', updatedAt: '2026-09-23T10:04:00Z', jobs: null });
  assert.deepEqual(runs.map(run => run.id), ['11', '13'], 'A run for another commit never verifies the current one.');
  assert.equal(runs[1].status, null); assert.equal(runs[1].conclusion, null); assert.equal(runs[1].url, null);
  assert.deepEqual(normalizeWorkflowRuns({}, SHA), []);
});

test('workflow identities are validated independently of the display path', () => {
  const ids = [9001, null, undefined, '9001', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  const runs = normalizeWorkflowRuns(runsPage(ids.map((workflow_id, index) => workflowRun(index + 1, { workflow_id }))), SHA);
  assert.deepEqual(runs.map(run => run.workflowId), ['9001', null, null, null, null, null, null, null]);
  assert.equal(runs.length, ids.length, 'An unreadable workflow identity does not remove the raw run from the reply.');
});

test('normalizes jobs and steps without runner metadata', () => {
  const [job] = normalizeWorkflowJobs(jobsPage([workflowJob(21, 11, { name: 'Test (ubuntu-latest, 22)' })]));
  assert.deepEqual(job, {
    id: '21', name: 'Test (ubuntu-latest, 22)', status: 'in_progress', conclusion: null, startedAt: '2026-09-23T10:00:10Z', completedAt: null, url: `https://github.com/${REPO}/actions/runs/11/job/21`,
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Run actions/checkout@v4', status: 'completed', conclusion: 'success' },
      { number: 3, name: 'Unit tests', status: 'in_progress', conclusion: null },
      { number: 4, name: 'Complete job', status: 'queued', conclusion: null },
    ],
  });
  assert.equal(JSON.stringify(job).includes('runner'), false);
});

test('reads current-commit runs with jobs for active runs and once per completed attempt', async () => {
  let active = true;
  const { calls, request } = recorder([
    [/actions\/runs\?/, () => ({ status: 200, etag: 'W/"runs"', data: runsPage([workflowRun(11, active ? { status: 'in_progress', conclusion: null } : {}), workflowRun(12)]) })],
    [/runs\/11\/attempts\/1\/jobs/, () => ({ status: 200, etag: null, data: jobsPage([workflowJob(21, 11, active ? {} : { status: 'completed', conclusion: 'success' })]) })],
    [/runs\/12\/attempts\/1\/jobs/, () => ({ status: 200, etag: null, data: jobsPage([workflowJob(22, 12, { status: 'completed', conclusion: 'success' })]) })],
  ]);
  let time = 0;
  const reader = createGitHubRunsReader({ request, ttl: 4000, now: () => time });
  const first = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.deepEqual(Object.keys(first), ['repository', 'sha', 'runs']);
  assert.equal(first.sha, SHA);
  assert.equal(calls[0].endpoint, `repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=50`);
  assert.deepEqual(first.runs.map(run => [run.id, run.jobs!.map(job => job.id)]), [['11', ['21']], ['12', ['22']]]);
  time = 1000; await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(calls.length, 3, 'Concurrent polls within the cache window share one read.');
  time = 5000; active = false; await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.deepEqual(calls.slice(3).map(call => call.endpoint.replace(`repos/${REPO}/`, '')), [`actions/runs?head_sha=${SHA}&per_page=50`, 'actions/runs/11/attempts/1/jobs?per_page=100'], 'Completed attempt 12 is not refetched; run 11 gets its final jobs once.');
  time = 10000; const settled = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(calls.length, 6, 'Completed attempts reuse their final jobs.');
  assert.equal(settled.runs[0].jobs![0].conclusion, 'success');
});

test('conditional requests reuse the cached body on 304', async () => {
  let version = 1;
  const { calls, request } = recorder([
    [/actions\/runs\?/, (endpoint, etag) => etag === `W/"v${version}"` ? { status: 304 } : { status: 200, etag: `W/"v${version}"`, data: runsPage([workflowRun(12, { name: `CI v${version}` })]) }],
    [/jobs/, () => ({ status: 200, etag: 'W/"jobs"', data: jobsPage([]) })],
  ]);
  let time = 0;
  const reader = createGitHubRunsReader({ request, ttl: 0, now: () => time++ });
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).runs[0].name, 'CI v1');
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).runs[0].name, 'CI v1');
  assert.equal(calls.filter(call => call.endpoint.includes('head_sha')).at(-1)!.etag, 'W/"v1"');
  version = 2;
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).runs[0].name, 'CI v2');
});

test('missing commits and invalid repositories never reach GitHub', async () => {
  const { calls, request } = recorder([]);
  const reader = createGitHubRunsReader({ request });
  assert.deepEqual(await reader.read({ repository: REPO, sha: null, login: LOGIN }), { repository: REPO, sha: null, runs: [] });
  assert.deepEqual(await reader.read({ repository: REPO, sha: 'main', login: LOGIN }), { repository: REPO, sha: null, runs: [] });
  await assert.rejects(reader.read({ repository: 'owner/repo/../../user', sha: SHA, login: LOGIN }), /GitHub repository/);
  await assert.rejects(reader.read({ repository: undefined, sha: SHA, login: LOGIN }), /GitHub repository/);
  assert.equal(calls.length, 0);
});

test('a failed read is not cached and a failed job read leaves that run unknown', async () => {
  let fail = true;
  const { request } = recorder([
    [/actions\/runs\?/, () => { if (fail) throw new Error('GitHub has temporarily limited requests.'); return { status: 200, etag: null, data: runsPage([workflowRun(11, { status: 'queued', conclusion: null })]) }; }],
    [/jobs/, () => { throw new Error('Reading GitHub failed.'); }],
  ]);
  const reader = createGitHubRunsReader({ request, now: () => 0 });
  await assert.rejects(reader.read({ repository: REPO, sha: SHA, login: LOGIN }), /temporarily limited/);
  fail = false;
  const result = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(result.runs[0].status, 'queued');
  assert.equal(result.runs[0].jobs, null);
});

test('the session is re-verified on every call, because gh reads with its active account', async () => {
  let calls = 0, login: string | null = 'glennlzl';
  const reader = createGitHubRunsReader({ request: async () => { throw new Error('unused'); }, session: async () => { calls++; return login ? { available: true, authenticated: true, account: { login, name: null } } : { available: true, authenticated: false, account: null }; }, now: () => 0 });
  assert.equal((await reader.session()).account!.login, 'glennlzl');
  login = 'someone-else';
  assert.equal((await reader.session()).account!.login, 'someone-else', 'gh auth switch is seen on the next call.');
  login = null;
  assert.equal((await reader.session()).authenticated, false, 'gh auth logout is seen on the next call.');
  assert.equal(calls, 3);
});

test('reads require the connected login and never share cached data between accounts', async () => {
  const { calls, request } = recorder([
    [/actions\/runs\?/, (endpoint, etag) => etag ? { status: 304 } : { status: 200, etag: 'W/"runs"', data: runsPage([workflowRun(12)]) }],
    [/jobs/, () => ({ status: 200, etag: null, data: jobsPage([workflowJob(22, 12, { status: 'completed', conclusion: 'success' })]) })],
  ]);
  const reader = createGitHubRunsReader({ request, ttl: 4000, now: () => 0 });
  await assert.rejects(reader.read({ repository: REPO, sha: SHA }), /Connect your GitHub account/);
  await assert.rejects(reader.read({ repository: REPO, sha: SHA, login: '' }), /Connect your GitHub account/);
  assert.equal(calls.length, 0);
  await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(calls.length, 2);
  await reader.read({ repository: REPO, sha: SHA, login: 'GlennLZL' });
  assert.equal(calls.length, 2, 'Logins compare case-insensitively, as GitHub does.');
  const other = await reader.read({ repository: REPO, sha: SHA, login: 'someone-else' });
  assert.deepEqual(calls.slice(2).map(call => [call.endpoint.replace(`repos/${REPO}/`, ''), call.etag]), [[`actions/runs?head_sha=${SHA}&per_page=50`, null], ['actions/runs/12/attempts/1/jobs?per_page=100', null]], 'Another account neither reuses the read, its entity tag, nor completed jobs.');
  assert.equal(other.runs[0].jobs![0].id, '22');
});

test('gh exits non-zero on 304, and the included status line still identifies the unchanged response', async () => {
  const notModified = 'HTTP/2.0 304 Not Modified\r\nEtag: W/"runs"\r\nX-Ratelimit-Remaining: 4999\r\n\r\n';
  const invocations: Invocation[] = [];
  const exit = (stdout: string, stderr = 'gh: HTTP 304') => async (...args: Invocation) => { invocations.push(args); throw Object.assign(new Error('Command failed: gh api'), { code: 1, stdout, stderr }); };
  assert.deepEqual(await githubRequest('repos/o/r/actions/runs', 'W/"runs"', { run: exit(notModified) }), { status: 304 });
  const [command, args, options] = invocations[0];
  assert.equal(command, 'gh');
  assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
  assert.ok(args.includes('If-None-Match: W/"runs"'));
  assert.equal(options.env.GH_HOST, 'github.com');
  assert.equal(Object.keys(options.env).some(key => key.startsWith('GIT_')), false);
  await assert.rejects(githubRequest('repos/o/r/actions/runs', null, { run: exit(notModified) }), /Reading GitHub workflow runs failed/, 'A 304 without a conditional request is not trusted.');
  await assert.rejects(githubRequest('repos/o/r/actions/runs', 'W/"runs"', { run: exit('HTTP/2.0 401 Unauthorized\r\n\r\n{}', 'gh: Bad credentials (HTTP 401) token gho_secret') }), (error: Error & { statusCode?: number }) => {
    assert.match(error.message, /gh auth login --hostname github.com/);
    assert.doesNotMatch(error.message, /gho_secret/, 'Raw CLI output never reaches the message.');
    assert.equal(error.statusCode, 502);
    return true;
  });
  const ok = 'HTTP/2.0 200 OK\r\nEtag: W/"next"\r\n\r\n{"total_count":0,"workflow_runs":[]}';
  assert.deepEqual(await githubRequest('repos/o/r/actions/runs', 'W/"runs"', { run: async () => ({ stdout: ok }) }), { status: 200, etag: 'W/"next"', headers: { etag: 'W/"next"' }, data: { total_count: 0, workflow_runs: [] } });
});

test('parses gh --include output and its entity tag', () => {
  const stdout = 'HTTP/2.0 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: application/json; charset=utf-8\r\nEtag: W/"6f1ed002ab5595859014ebf0951522d9"\r\nX-Ratelimit-Remaining: 4998\r\n\r\n{"total_count":0,"workflow_runs":[]}';
  assert.deepEqual(parseGitHubResponse(stdout), {
    status: 200, etag: 'W/"6f1ed002ab5595859014ebf0951522d9"', data: { total_count: 0, workflow_runs: [] },
    headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', etag: 'W/"6f1ed002ab5595859014ebf0951522d9"', 'x-ratelimit-remaining': '4998' },
  });
  assert.equal(parseGitHubResponse('HTTP/2.0 200 OK\nEtag: bad\netag\n\n{}').etag, null);
  assert.throws(() => parseGitHubResponse('not a response'), /unreadable/);
});
