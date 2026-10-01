import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowRows, githubBranchBuild, githubMark, watchedBuildStatus } from '../client/src/lib/pipeline-github.ts';
import type { BuildReply, GitHubRun } from '../client/src/lib/pipeline-github.ts';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), CI = '.github/workflows/ci.yml';
const run = (id: string, fields: Partial<GitHubRun> = {}): GitHubRun => ({
  id, workflowId: '7', name: 'CI', path: CI, event: 'push', attempt: 1, sha: SHA, branch: 'main', url: null,
  status: 'completed', conclusion: 'success', createdAt: null, startedAt: null, updatedAt: null,
  jobs: [{ id: `job-${id}`, name: 'Test', status: 'completed', conclusion: 'success', startedAt: null, completedAt: null, url: null,
    steps: [{ number: 1, name: 'Unit tests', status: 'completed', conclusion: 'success' }] }], ...fields,
});
const result = (runs: GitHubRun[]): BuildReply => ({ repoPath: '/acme/app', repository: 'acme/app', branch: 'main', sha: SHA, scannedSha: SHA, source: 'scanned', runs });

test('successful branch dispatch and running PR share one passing Build, workflow, job and step projection', () => {
  const manual = run('10', { event: 'workflow_dispatch' });
  const pr = run('11', { event: 'pull_request', status: 'in_progress', conclusion: null,
    jobs: [{ ...manual.jobs![0], status: 'in_progress', conclusion: null, steps: [{ number: 1, name: 'Unit tests', status: 'in_progress', conclusion: null }] }] });
  const raw = result([pr, manual]), rows = buildWorkflowRows(raw, [], SHA);
  assert.deepEqual(watchedBuildStatus(raw), { kind: 'passed', text: 'Passed', sha: 'aaaaaaa' });
  assert.deepEqual(rows.map(row => row.file), [CI]);
  const selected = rows[0].runs;
  assert.deepEqual(selected.map(run => run.id), ['10']);
  assert.equal(githubMark(selected[0]), 'passed');
  assert.equal(githubMark(selected[0].jobs![0]), 'passed');
  assert.equal(githubMark(selected[0].jobs![0].steps[0]), 'passed');
  assert.deepEqual(raw.runs.map(run => run.id), ['11', '10'], 'The original GitHub evidence is preserved.');
});

test('Build evidence belongs to the scanned commit and known branch, never a PR, schedule, dynamic run or missing workflow', () => {
  for (const fields of [{ sha: OTHER }, { branch: 'preview' }, { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'schedule' }, { path: 'dynamic/codeql' }, { workflowId: null }]) {
    assert.deepEqual(githubBranchBuild(result([run('1', fields)]), SHA, 'main')?.runs, [], JSON.stringify(fields));
  }
  for (const branch of [null, undefined, '']) assert.equal(githubBranchBuild(result([run('1')]), SHA, branch), null, 'An unknown branch never guesses main.');
  assert.equal(githubBranchBuild(result([run('1')]), OTHER, 'main'), null);
  assert.equal(githubBranchBuild(result([run('1')]), null, 'main'), null);
  assert.equal(githubBranchBuild(null, SHA, 'main'), null);
});

test('newest eligible run and attempt replace old evidence by workflow identity, independent of input order or path', () => {
  const rows = [run('9', { conclusion: 'failure' }), run('10', { path: '.github/workflows/renamed.yml' }),
    run('10', { attempt: 2, path: '.github/workflows/renamed.yml', status: 'in_progress', conclusion: null }),
    run('20', { event: 'pull_request', conclusion: 'failure' }), run('30', { branch: 'preview', conclusion: 'failure' })];
  for (const runs of [rows, [...rows].reverse()]) {
    const view = githubBranchBuild(result(runs), SHA, 'main');
    assert.deepEqual(view?.runs.map(run => [run.id, run.attempt]), [['10', 2]]);
    const projected = buildWorkflowRows(result(runs), [], SHA);
    assert.deepEqual(projected.map(row => row.file), ['.github/workflows/renamed.yml'], 'Renaming a workflow does not revive its earlier failure.');
    assert.equal(githubMark(projected[0].runs[0]), 'running');
  }
  const view = result([run('9', { conclusion: 'failure' }), run('10')]);
  assert.equal(watchedBuildStatus(view)?.text, 'Passed', 'A successful rerun replaces its older failure.');
});

test('a different workflow is retained even when its path or name is the same', () => {
  const view = githubBranchBuild(result([run('10'), run('11', { workflowId: '8', conclusion: 'failure' })]), SHA, 'main');
  assert.deepEqual(view?.runs.map(run => run.id), ['10', '11']);
  const raw = result([run('10'), run('11', { workflowId: '8', conclusion: 'failure' })]);
  assert.deepEqual(buildWorkflowRows(raw, [], SHA)[0].runs.map(run => run.id), ['10', '11']);
  assert.deepEqual(watchedBuildStatus(raw), { kind: 'failed', text: 'Failed', sha: 'aaaaaaa' });
});
