import { GITHUB_MESSAGES, SHA, githubFailureKind, githubGetArgs, isRepository, notModified, parseGitHubResponse, runGitHub, type GitHubResponse, type GitHubRun } from './github-cli.ts';
import { getGitHubSession, type GitHubSession } from './github-source.ts';

// GitHub JSON is untrusted: every field is checked below before it enters a run or job.
type GitHubJson = { readonly [key: string]: unknown } | null | undefined;
// The reply shapes are the contract's (contract/github.ts), which the client reads as types.
import type { CommitRuns, RunState, WorkflowJob, WorkflowRun, WorkflowStep } from '../contract/github.ts';
export type { CommitRuns, RunState, WorkflowJob, WorkflowRun, WorkflowStep };
export type { GitHubResponse };
export { parseGitHubResponse };
export interface GitHubRunsReader {
  session(): Promise<GitHubSession>;
  read(input: { repository?: unknown; sha?: unknown; login?: unknown }): Promise<CommitRuns>;
}

const STATUSES = new Set(['requested', 'waiting', 'pending', 'queued', 'in_progress', 'completed']);
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const text = (value: unknown, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : null;
const time = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const link = (value: unknown) => typeof value === 'string' && value.startsWith('https://github.com/') ? value.slice(0, 500) : null;
const known = (values: Set<string>, value: unknown): value is string => typeof value === 'string' && values.has(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const state = (item: GitHubJson): RunState => ({ status: known(STATUSES, item?.status) ? item.status : null, conclusion: known(CONCLUSIONS, item?.conclusion) ? item.conclusion : null });
/** A GitHub read that failed upstream, answered as 502; shared with the deployments reader. */
export const failure = (message: string) => Object.assign(new Error(message), { statusCode: 502 });

/** Runs `work` on each item, `limit` at a time: each read is its own gh process, and a commit can have dozens of runs. */
export async function eachBounded<T>(items: readonly T[], work: (item: T) => Promise<void>, limit = 6) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

/** Keeps the newest `limit` entries of a cache map, evicting the oldest. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, limit = 200) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

// Read-only Actions status for one commit. A run for another commit never
// verifies the current source, so non-matching head SHAs are dropped.
export function normalizeWorkflowRuns(data: GitHubJson, sha: string): WorkflowRun[] {
  return (Array.isArray(data?.workflow_runs) ? data.workflow_runs as GitHubJson[] : []).filter((run): run is NonNullable<GitHubJson> => Number.isSafeInteger(run?.id) && run!.head_sha === sha).map(run => ({
    id: String(run.id), workflowId: Number.isSafeInteger(run.workflow_id) && Number(run.workflow_id) > 0 ? String(run.workflow_id) : null,
    name: text(run.name), path: text(run.path)?.replace(/@.*$/, '') || null, event: text(run.event, 60), ...state(run),
    attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt as number : 1, sha, branch: text(run.head_branch, 255), url: link(run.html_url),
    createdAt: time(run.created_at), startedAt: time(run.run_started_at), updatedAt: time(run.updated_at), jobs: null,
  }));
}

export function normalizeWorkflowJobs(data: GitHubJson): WorkflowJob[] {
  return (Array.isArray(data?.jobs) ? data.jobs as GitHubJson[] : []).filter((job): job is NonNullable<GitHubJson> => Number.isSafeInteger(job?.id)).slice(0, 100).map(job => ({
    id: String(job.id), name: text(job.name) || '', ...state(job), startedAt: time(job.started_at), completedAt: time(job.completed_at), url: link(job.html_url),
    steps: (Array.isArray(job.steps) ? job.steps as GitHubJson[] : []).slice(0, 200).map(step => ({ number: Number.isSafeInteger(step?.number) ? step!.number as number : null, name: text(step?.name) || '', ...state(step) })),
  }));
}

/** The same branch/event/workflow identity boundary used by Build admission; no scan-file filter. */
export function latestBranchBuildRuns(runs: readonly WorkflowRun[], sha: string | null, branch: string | null): WorkflowRun[] {
  if (!sha || !branch) return [];
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (run.sha !== sha || run.branch !== branch || !['push', 'workflow_dispatch'].includes(String(run.event)) || !run.path?.startsWith('.github/workflows/') || !run.workflowId) continue;
    const previous = latest.get(run.workflowId);
    if (!previous || Number(run.id) > Number(previous.id) || run.id === previous.id && run.attempt > previous.attempt) latest.set(run.workflowId, run);
  }
  return [...latest.values()];
}

// The failure's kind comes from github-cli; the words for it, per subject, are this reader's.
function requestFailure(error: unknown, subject: string) {
  const kind = githubFailureKind(error);
  if (kind === 'missing' || kind === 'rate-limit' || kind === 'unauthenticated') return failure(GITHUB_MESSAGES[kind]);
  if (kind === 'timeout') return failure(`Reading GitHub ${subject} timed out. Try again.`);
  if (kind === 'not-found' || kind === 'denied') return failure(`GitHub denied access to ${subject}. Check repository access and ${subject === 'deployments' ? 'deployment' : 'Actions'} permissions.`);
  return failure(`Reading GitHub ${subject} failed. Check your network connection and try again.`);
}

/** One conditional GET through gh. `subject` names what is read in failure messages. */
export async function githubRequest(endpoint: string, etag: string | null, { run, subject = 'workflow runs' }: { run?: GitHubRun; subject?: string } = {}): Promise<GitHubResponse> {
  try {
    const { stdout } = await runGitHub(githubGetArgs(endpoint, etag), { run });
    return parseGitHubResponse(stdout, failure);
  } catch (caught) {
    // gh exits non-zero on 304; its included status line still identifies it.
    if (notModified(caught, etag)) return { status: 304 };
    throw (caught as { statusCode?: number }).statusCode ? caught : requestFailure(caught, subject);
  }
}

// Every read is keyed by the connected login, so data read for one account is
// never served to another. The session is re-read on every call because gh
// always uses its active account: a cached verification would keep reading
// after gh auth switch or logout.
export function createGitHubRunsReader({ request = githubRequest, session = getGitHubSession, ttl = 4000, now = Date.now }: {
  request?: (endpoint: string, etag: string | null) => Promise<GitHubResponse>; session?: () => Promise<GitHubSession>; ttl?: number; now?: () => number;
} = {}): GitHubRunsReader {
  const tags = new Map<string, { etag: string; data: unknown }>(), finished = new Map<string, WorkflowJob[]>(), reads = new Map<string, { at: number; promise: Promise<CommitRuns> }>();
  async function conditional(login: string, endpoint: string): Promise<GitHubJson> {
    const tag = `${login}:${endpoint}`, cached = tags.get(tag), response = await request(endpoint, cached?.etag || null);
    if (response.status === 304 && cached) return cached.data as GitHubJson;
    if (response.status !== 200) throw failure('GitHub returned an unexpected response. Try again.');
    if (response.etag) remember(tags, tag, { etag: response.etag, data: response.data });
    return response.data as GitHubJson;
  }
  async function load(login: string, repository: string, sha: string): Promise<CommitRuns> {
    async function pages(endpoint: string, field: 'workflow_runs' | 'jobs', size: number): Promise<Record<string, unknown>[]> {
      const rows: Record<string, unknown>[] = [], ids = new Set<number>();
      let total: number | undefined;
      for (let page = 1; page <= 1000 / size; page++) {
        const data = await conditional(login, `${endpoint}${page === 1 ? '' : `&page=${page}`}`);
        if (!record(data) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 || !Array.isArray(data[field])) throw failure('GitHub did not return complete workflow evidence. Try again.');
        if (total !== undefined && total !== data.total_count) throw failure('GitHub changed its workflow evidence while reading it. Try again.');
        total = Number(data.total_count);
        if (total > 1000) throw failure('GitHub workflow evidence exceeds the 1,000-record reading limit.');
        const values = data[field];
        if (values.length > size) throw failure('GitHub did not return complete workflow evidence. Try again.');
        for (const value of values) {
          if (!record(value) || !positive(value.id) || ids.has(value.id) || field === 'workflow_runs' && (!positive(value.workflow_id) || typeof value.head_sha !== 'string' || !SHA.test(value.head_sha) || value.run_attempt !== undefined && !positive(value.run_attempt))) throw failure('GitHub did not return complete workflow evidence. Try again.');
          ids.add(value.id); rows.push(value);
        }
        if (rows.length === total) return rows;
        if (rows.length > total || values.length < size) throw failure('GitHub did not return complete workflow evidence. Try again.');
      }
      throw failure('GitHub did not return complete workflow evidence. Try again.');
    }
    const runs = normalizeWorkflowRuns({ workflow_runs: await pages(`repos/${repository}/actions/runs?head_sha=${sha}&per_page=50`, 'workflow_runs', 50) }, sha);
    // Jobs of queued or running runs are re-read; a completed attempt is read once.
    await eachBounded(runs, async run => {
      const key = `${login}:${repository}:${run.id}:${run.attempt}:${run.updatedAt}`;
      if (run.status === 'completed' && finished.has(key)) { run.jobs = finished.get(key)!; return; }
      try { run.jobs = (await pages(`repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`, 'jobs', 100)).flatMap(job => normalizeWorkflowJobs({ jobs: [job] })); }
      catch { run.jobs = null; return; }
      if (run.status === 'completed') remember(finished, key, run.jobs);
    });
    return { repository, sha, runs };
  }
  return {
    session() { return session(); },
    read({ repository, sha, login }) {
      if (!isRepository(repository)) return Promise.reject(new Error('Connect a GitHub repository to read workflow runs.'));
      if (typeof login !== 'string' || !login) return Promise.reject(new Error('Connect your GitHub account to read workflow runs.'));
      if (typeof sha !== 'string' || !SHA.test(sha)) return Promise.resolve({ repository, sha: null, runs: [] });
      const account = login.toLowerCase(), key = `${account}:${repository.toLowerCase()}@${sha}`, cached = reads.get(key);
      if (cached && now() - cached.at < ttl) return cached.promise.then(runs => structuredClone(runs));
      const promise = load(account, repository, sha);
      remember(reads, key, { at: now(), promise }, 20);
      promise.catch(() => { if (reads.get(key)?.promise === promise) reads.delete(key); });
      return promise.then(runs => structuredClone(runs));
    },
  };
}
