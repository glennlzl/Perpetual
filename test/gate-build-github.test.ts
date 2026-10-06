import test from 'node:test';
import assert from 'node:assert/strict';
import { readBuild } from '../src/gate/build.ts';
import type { GitHubSession } from '../src/github-source.ts';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const input = { repository: 'acme/app', branch: 'main', sha: SHA, login: 'tester' };
const session = async (): Promise<GitHubSession> => ({ available: true, authenticated: true, account: { login: 'tester', name: null } });
const run = (id: number, workflow = id, fields: Record<string, unknown> = {}) => ({ id, workflow_id: workflow, name: 'CI', path: '.github/workflows/ci.yml', head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, ...fields });
const read = (runs: ReturnType<typeof run>[]) => readBuild(input, { session, request: async () => ({ status: 200, data: { total_count: runs.length, workflow_runs: runs } }) });

test('Build admission requires actual branch Actions success and ignores another SHA, branch or PR result', async () => {
  assert.equal((await read([run(1)])).status, 'passed');
  // Complete evidence without a push or dispatch run of the branch at the commit: Build has not run for it.
  for (const fields of [{ head_sha: OTHER }, { head_branch: 'other' }, { event: 'pull_request' }, { event: 'schedule' }, { path: 'dynamic/codeql' }]) {
    assert.deepEqual(await read([run(1, 1, fields)]), { status: 'none', reason: 'Waiting for GitHub Actions to build this branch commit.' });
  }
  assert.equal((await read([])).status, 'none');
  assert.equal((await read([run(1, 1, { event: 'workflow_dispatch' })])).status, 'passed');
});

test('pending, cancelled, failure and all-skipped workflow sets never admit a twin', async () => {
  for (const [fields, status] of [
    [{ status: 'in_progress', conclusion: null }, 'waiting'],
    [{ conclusion: 'failure' }, 'blocked'],
    [{ conclusion: 'timed_out' }, 'blocked'],
    [{ conclusion: 'cancelled' }, 'blocked'],
    [{ conclusion: 'action_required' }, 'blocked'],
    [{ conclusion: 'skipped' }, 'blocked'],
    [{ status: 'unknown', conclusion: 'success' }, 'waiting'],
  ] as const) assert.equal((await read([run(1, 1, fields)])).status, status);
  assert.equal((await read([run(1), run(2, 2, { conclusion: 'skipped' })])).status, 'passed');
  assert.equal((await read([run(1), run(2, 2, { conclusion: 'failure' })])).status, 'blocked');
});

test('the latest run of each workflow replaces earlier runs but cannot hide another workflow failure', async () => {
  assert.equal((await read([run(2, 1), run(1, 1, { conclusion: 'failure' })])).status, 'passed');
  assert.equal((await read([run(1, 1, { conclusion: 'success' }), run(2, 1, { conclusion: 'failure' })])).status, 'blocked');
  assert.equal((await read([run(2, 1), run(1, 1, { conclusion: 'failure' }), run(3, 2, { conclusion: 'failure' })])).status, 'blocked');
  assert.equal((await read([run(2, 1, { run_attempt: 1, conclusion: 'failure' }), run(2, 1, { run_attempt: 2 })])).status, 'passed');
});

test('a failure beyond the first page blocks admission and only Actions endpoints are queried', async () => {
  const endpoints: string[] = [];
  const result = await readBuild(input, { session, request: async endpoint => {
    endpoints.push(endpoint);
    const second = endpoint.endsWith('page=2');
    return { status: 200, data: { total_count: 101, workflow_runs: second ? [run(101, 101, { conclusion: 'failure' })] : Array.from({ length: 100 }, (_, index) => run(index + 1)) } };
  } });
  assert.equal(result.status, 'blocked');
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints.every(endpoint => endpoint.startsWith(`repos/acme/app/actions/runs?head_sha=${SHA}&`)));
});

test('incomplete, malformed or unreadable CI evidence never becomes a successful build', async () => {
  for (const data of [{}, { total_count: 1, workflow_runs: [] }, { total_count: 0, workflow_runs: [run(1)] }, { total_count: 1, workflow_runs: [{ ...run(1), workflow_id: null }] }, { total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, index) => run(index + 1)) }]) {
    const result = await readBuild(input, { session, request: async () => ({ status: 200, data }) });
    // Nor a commit Build has not run for: only complete evidence can tell that.
    assert.equal(result.status, 'waiting');
  }
  await assert.rejects(readBuild(input, { session, request: async () => { throw new Error('offline'); } }), /offline/);
});

test('an account switch while Actions is read invalidates the returned success', async () => {
  let reads = 0;
  const result = await readBuild(input, { session: async () => ({ available: true, authenticated: true, account: { name: null, login: ++reads === 1 ? 'tester' : 'other' } }), request: async () => ({ status: 200, data: { total_count: 1, workflow_runs: [run(1)] } }) });
  assert.notEqual(result.status, 'passed');
});

test('GitHub unreachable leaves Build waiting with why, never asking to reconnect, and never passes a read it cut short', async () => {
  const unreachable: GitHubSession = { available: true, authenticated: false, account: null, message: 'Reading GitHub timed out. Check your connection and try again.', unreachable: true };
  const runs = async () => ({ status: 200, data: { total_count: 1, workflow_runs: [run(1)] } });
  let requests = 0;
  assert.deepEqual(await readBuild(input, { session: async () => unreachable, request: async () => { requests++; return runs(); } }), { status: 'waiting', reason: unreachable.message });
  assert.equal(requests, 0);
  let reads = 0;
  assert.deepEqual(await readBuild(input, { session: async () => ++reads === 1 ? session() : unreachable, request: runs }), { status: 'waiting', reason: unreachable.message });
});

test('another signed-in account cannot supply CI evidence for the connected account', async () => {
  let requests = 0;
  const result = await readBuild(input, { session: async () => ({ available: true, authenticated: true, account: { name: null, login: 'someone-else' } }), request: async () => { requests++; return { status: 200, data: { total_count: 1, workflow_runs: [run(1)] } }; } });
  assert.notEqual(result.status, 'passed');
  assert.equal(requests, 0);
});
