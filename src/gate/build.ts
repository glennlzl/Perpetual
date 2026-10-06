import { SHA, isRepository } from '../github-cli.ts';
import { githubRequest, normalizeWorkflowRuns, type GitHubResponse, type WorkflowRun } from '../github-runs.ts';
import { getGitHubSession, type GitHubSession } from '../github-source.ts';
import { branchRuns, completedRuns } from '../repair/triage.ts';
import type { BuildInput, BuildVerdict } from './manager.ts';

type Request = (endpoint: string, etag: string | null) => Promise<GitHubResponse>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const waiting = (reason: string): BuildVerdict => ({ status: 'waiting', reason });
const INCOMPLETE = 'GitHub did not return complete Build evidence. Waiting to check again.';

/**
 * Fresh Actions evidence for one branch commit. Commit statuses (including perpetual/*) are never read here.
 * The latest run of each workflow is the build to judge; its older failures do not defeat a successful rerun.
 * A missing run, unreadable/incomplete evidence or an account change never admits a twin.
 */
export async function readBuild(input: BuildInput, { request = githubRequest, session = getGitHubSession }: { request?: Request; session?: () => Promise<GitHubSession> } = {}): Promise<BuildVerdict> {
  const { repository, branch, sha, login } = input;
  if (!isRepository(repository) || typeof branch !== 'string' || !branch || !SHA.test(sha) || typeof login !== 'string' || !login) return waiting('Connect a GitHub branch to verify Build.');
  const connected = async () => { const value = await session(); return value.authenticated && value.account.login.toLowerCase() === login.toLowerCase(); };
  if (!(await connected())) return waiting('Reconnect the GitHub account to verify Build.');
  const latest = new Map<number, WorkflowRun>();
  let total: number | undefined, received = 0;
  for (let page = 1; page <= 10; page++) {
    const response = await request(`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`, null);
    const data = response.data;
    if (response.status !== 200 || !record(data) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 || !Array.isArray(data.workflow_runs)) return waiting(INCOMPLETE);
    if (total !== undefined && total !== data.total_count) return waiting(INCOMPLETE);
    total = Number(data.total_count);
    if (total > 1000) return waiting('Build has more workflow runs than Perpetual can verify.');
    const rows = data.workflow_runs;
    if (rows.length > 100 || rows.some(row => !record(row) || !positive(row.id) || !positive(row.workflow_id) || typeof row.head_sha !== 'string' || (row.run_attempt !== undefined && !positive(row.run_attempt)))) return waiting(INCOMPLETE);
    received += rows.length;
    if (received > total) return waiting(INCOMPLETE);
    for (const row of rows) {
      const value = row as Record<string, unknown>;
      const [run] = branchRuns(normalizeWorkflowRuns({ workflow_runs: [value] }, sha), branch);
      if (!run) continue;
      const workflow = value.workflow_id as number, previous = latest.get(workflow);
      if (!previous || Number(run.id) > Number(previous.id) || run.id === previous.id && run.attempt > previous.attempt) latest.set(workflow, run);
    }
    if (received >= total) break;
    if (rows.length < 100) return waiting(INCOMPLETE);
  }
  if (!(await connected())) return waiting('The GitHub account changed while verifying Build.');
  if (total === undefined || received < total) return waiting(INCOMPLETE);
  const runs = [...latest.values()], result = completedRuns(runs, branch);
  if (!runs.length) return waiting('Waiting for GitHub Actions to build this branch commit.');
  if (!result) return waiting('Waiting for GitHub Actions to finish Build.');
  if (result.failed.length) return { status: 'blocked', reason: 'GitHub Actions Build failed. Repair it or rerun the failed workflow.' };
  if (!result.passed) return { status: 'blocked', reason: 'GitHub Actions Build did not pass. Complete a successful workflow run.' };
  return { status: 'passed' };
}
