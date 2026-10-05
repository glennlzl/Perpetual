// A failed workflow run as a repair reads it, the one write triage makes (rerunning its failed jobs), and the agent
// step's writes: pushing its repair branch and opening, updating, readying and closing its pull request, and the merge
// step's reads and writes: the pull request, its head's checks, how far it is behind the target branch, updating its
// branch, the parents of the head that update made, and merging it. All run the signed-in GitHub CLI, or git with gh's
// credential helper, for a repository the caller names; the caller verifies that the session is the connected account
// first, as for workflow runs. No token enters a URL, file or git config.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { GITHUB_MESSAGES, SHA as COMMIT, githubFailureKind, githubHttpStatus, isRepository, runGitHub } from '../github-cli.ts';
import { commandEnvironment, gitArgs } from '../github-source.ts';
import { diagnoseFailure, type FailureDiagnosis } from '../providers.ts';
import { redact } from '../redaction.ts';

/** A job of the run; failedSteps names the steps that concluded failure. */
export interface FailedJob { id: string; name: string; conclusion: string | null; failedSteps: string[] }
/** A run's failure: its jobs, the redacted error lines and tail of its failed-step log, and their rule-based diagnosis. */
export interface GitHubFailure { runId: string; jobs: FailedJob[]; log: string; tail: string; diagnosis: FailureDiagnosis; observedAt: string }
export interface RunInput { repository: unknown; runId: unknown }
type Options = { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal };
/** An execFile-shaped command runner; tests supply one that records its arguments. */
export type CommandRunner = (file: string, args: string[], options: Options) => Promise<{ stdout: string }>;
type ExecFailure = { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown; killed?: boolean };

const exec = promisify(execFile) as CommandRunner;
const RUN_ID = /^\d{1,20}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : '';
// Error lines kept for triage: test failures, error markers and deadlines read without case, and read with their case
// what CLIs print without the word error, such as an error code (ERR_PNPM_OUTDATED_LOCKFILE), git's fatal: and a push
// it refused, GitHub refusing a token, gh's and curl's own 401/403 lines and a credential variable that is not set. A
// passing test's line is never one, whatever its name says. The tail keeps the context around them.
const ERROR_LINE = /AssertionError|TestingLibraryElementError|(?:\s|^)FAIL\s|##\[error\]|Error\]?:|\berror\b|ERR!|expected:|received:|timed? ?out/i;
const CODE_LINE = /\bERR_[A-Z\d_]{3,}|\bfatal: |\bPermission to \S+ denied to |Bad credentials|Resource not accessible by (?:integration|personal access token)|^gh: .*\(HTTP 40[13]\)\s*$|^HTTP 40[13]: .*\(https:\/\/api\.github\.com\/|returned error: 40[13]\b|\b(?:[A-Z][A-Z\d]*_)*(?:TOKEN|API_KEY|SECRET(?:_KEY)?)\b(?: environment variable)?(?: is| was)? (?:required|missing|not set)\b/;
const PASSED_LINE = /^\s*(?:[✓✔√]\s|ok \d+ |--- PASS: |PASS\s)/;
// `gh run view --log-failed` prefixes each line with its job, its step and a timestamp, whose digits must never read as a status code.
const PREFIX = /^[^\t\n]*\t[^\t\n]*\t/;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

function target({ repository, runId }: RunInput) {
  if (!isRepository(repository) || typeof runId !== 'string' && typeof runId !== 'number' || !RUN_ID.test(String(runId))) {
    throw new Error('Choose a GitHub workflow run from the connected repository.');
  }
  return { repository, runId: String(runId) };
}

/** Fixed messages for HTTP statuses a call expects GitHub to refuse with, such as 409 for a merge whose head moved. */
type Refusals = Partial<Record<405 | 409 | 422, string>>;
// What a failure is comes from github-cli, which reads the raw output and never returns it; the words are the repair's.
// GitHub refusing the request, which trying again cannot change, is marked refused; so is a status the call names in
// refusals.
function commandFailure(error: unknown, operation: string, denied: string, refusals: Refusals = {}) {
  const kind = githubFailureKind(error), status = githubHttpStatus(error) as keyof Refusals;
  if (kind === 'missing' || kind === 'rate-limit' || kind === 'unauthenticated') return new Error(GITHUB_MESSAGES[kind]);
  if (kind === 'timeout') return new Error(`${operation} timed out. Try again.`);
  if (kind === 'too-large') return new Error(`${operation} returned more than Perpetual reads.`);
  if (refusals[status]) return Object.assign(new Error(refusals[status]), { refused: true, status });
  if (kind === 'not-found' || kind === 'denied') return Object.assign(new Error(denied), { refused: true });
  return new Error(`${operation} failed. Check your network connection and try again.`);
}

async function gh(run: CommandRunner, args: string[], operation: string, denied: string, maxBuffer = 1024 * 1024, refusals: Refusals = {}) {
  try { return (await runGitHub(args, { timeout: 30000, maxBuffer, run })).stdout; }
  catch (error) { throw commandFailure(error, operation, denied, refusals); }
}

/** The failed run's jobs and redacted failed-step log, classified without a model. */
export async function getGitHubFailure(input: RunInput, { run = exec, now = () => new Date().toISOString() }: { run?: CommandRunner; now?: () => string } = {}): Promise<GitHubFailure> {
  const { repository, runId } = target(input);
  const denied = 'GitHub denied access to workflow runs. Check repository access and Actions permissions.';
  const [rawJobs, rawLog] = await Promise.all([
    gh(run, ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`], 'Reading the failed jobs', denied),
    gh(run, ['run', 'view', runId, '--repo', repository, '--log-failed'], 'Reading the failed log', denied, 16 * 1024 * 1024),
  ]);
  let listed: unknown;
  try { listed = JSON.parse(rawJobs); } catch { throw new Error('GitHub returned an unreadable job list.'); }
  if (!isRecord(listed) || !Array.isArray(listed.jobs)) throw new Error('GitHub returned an unreadable job list.');
  const jobs = listed.jobs.filter(isRecord).filter(job => Number.isSafeInteger(job.id)).slice(0, 100).map(job => ({
    id: String(job.id), name: text(job.name), conclusion: typeof job.conclusion === 'string' ? job.conclusion.slice(0, 40) : null,
    failedSteps: (Array.isArray(job.steps) ? job.steps : []).filter(isRecord).filter(step => step.conclusion === 'failure').map(step => text(step.name)).slice(0, 50),
  }));
  const lines = redact(rawLog).split(/\r?\n/).map(line => line.replace(PREFIX, '').replace(TIMESTAMP, '')).filter(line => line.trim());
  const log = lines.filter(line => !PASSED_LINE.test(line) && (ERROR_LINE.test(line) || CODE_LINE.test(line))).slice(0, 100).join('\n').slice(0, 20000);
  const tail = lines.slice(-80).join('\n').slice(-12000);
  return { runId, jobs, log, tail, diagnosis: diagnoseFailure(log), observedAt: now() };
}

/** Reruns a completed run's failed jobs once, as a new attempt of the same run. */
export async function rerunFailedJobs(input: RunInput, { run = exec }: { run?: CommandRunner } = {}): Promise<void> {
  const { repository, runId } = target(input);
  await gh(run, ['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`],
    'Rerunning the failed jobs', 'GitHub denied the rerun. Check write access to Actions in this repository.');
}

/** The only branch a repair pushes: perpetual/repair/<short sha of the failing commit>. */
export const REPAIR_BRANCH = /^perpetual\/repair\/[a-f\d]{7,40}$/;
export const repairBranch = (sha: string) => `perpetual/repair/${sha.slice(0, 7).toLowerCase()}`;
export interface PushInput { directory: unknown; repository: unknown; branch: unknown; sha: unknown; lease: unknown }
export interface BranchInput extends Pick<PushInput, 'directory' | 'repository' | 'branch'> { signal?: AbortSignal }

function repositoryOf(value: unknown) {
  if (!isRepository(value)) throw new Error('Choose a GitHub repository from the connected account.');
  return value;
}
function branchInput({ directory, repository, branch }: Pick<PushInput, 'directory' | 'repository' | 'branch'>) {
  if (typeof branch !== 'string' || !REPAIR_BRANCH.test(branch)) throw new Error('A repair pushes only its perpetual/repair branch.');
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new Error('The repair copy is unavailable.');
  return { directory, repository: repositoryOf(repository), branch };
}
async function git(run: CommandRunner, args: string[], operation: string, denied: string, signal?: AbortSignal) {
  try { return (await run('git', gitArgs(args), { timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true, env: commandEnvironment(), ...(signal ? { signal } : {}) })).stdout; }
  catch (error) {
    // git push --porcelain reports a rejected ref on stdout, and only that the push failed on stderr.
    const { stdout, stderr } = error as ExecFailure, detail = `${String(stdout || '')}\n${String(stderr || '')}`.toLowerCase();
    if (/stale info|fetch first|non-fast-forward|\[rejected\]/.test(detail)) throw new Error('The repair branch changed on GitHub. Start the repair again.');
    throw commandFailure(error, operation, denied);
  }
}

/** The repair branch's commit on GitHub, or null when it does not exist; signal stops the read. */
export async function remoteRepairBranch(input: BranchInput, { run = exec }: { run?: CommandRunner } = {}): Promise<string | null> {
  const { directory, repository, branch } = branchInput(input);
  const listed = await git(run, ['-C', directory, 'ls-remote', '--heads', '--', `https://github.com/${repository}.git`, `refs/heads/${branch}`], 'Reading the repair branch', 'GitHub denied access to the repository. Check repository access.', input.signal);
  const sha = listed.split('\n').map(line => line.split('\t')).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
  return sha && COMMIT.test(sha) ? sha.toLowerCase() : null;
}

/**
 * Pushes one commit to the repair branch, and only there: any other ref is refused before git runs. The lease is the
 * branch's commit as last seen (empty when it must not exist yet), so a branch someone else moved is never overwritten.
 */
export async function pushRepairBranch(input: PushInput, { run = exec }: { run?: CommandRunner } = {}): Promise<void> {
  const { directory, repository, branch } = branchInput(input), { sha, lease } = input;
  if (typeof sha !== 'string' || !COMMIT.test(sha) || typeof lease !== 'string' || lease && !COMMIT.test(lease)) throw new Error('A repair pushes only its own commit.');
  await git(run, ['-C', directory, 'push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/${branch}:${lease}`, '--', `https://github.com/${repository}.git`, `${sha}:refs/heads/${branch}`],
    'Pushing the repair branch', 'GitHub denied the push. Check write access to this repository.');
}

/** A repair's pull request as GitHub returns it. */
export interface PullRequestRef { number: number; url: string; draft: boolean }
const pullNumber = (value: unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Choose the repair\'s pull request.'); return value as number; };
function pullRequest(data: unknown): PullRequestRef {
  if (!isRecord(data) || !Number.isSafeInteger(data.number) || typeof data.html_url !== 'string' || !data.html_url.startsWith('https://github.com/')) throw new Error('GitHub returned an unreadable pull request.');
  return { number: data.number as number, url: data.html_url.slice(0, 500), draft: data.draft === true };
}
function json(stdout: string) { try { return JSON.parse(stdout) as unknown; } catch { throw new Error('GitHub returned an unreadable response.'); } }
const shaOf = (value: unknown) => { if (typeof value !== 'string' || !COMMIT.test(value)) throw new Error('Choose a commit.'); return value.toLowerCase(); };
const readSha = (value: unknown) => typeof value === 'string' && COMMIT.test(value) ? value.toLowerCase() : null;
const plain = (value: unknown, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit) : '';
/**
 * One read of a pull request: open, closed, or merged with the merge commit that same read names (merge_commit_sha), null
 * when it names none. An open pull request's merge_commit_sha is GitHub's test merge, never read.
 */
export interface PullRequestRead { state: 'open' | 'closed' | 'merged'; mergeCommit: string | null }
/** A pull request as the merge step reads it: its state, merge commit, draft flag, head and base. */
export interface PullRequestState {
  state: 'open' | 'closed'; merged: boolean; mergeCommit: string | null; draft: boolean;
  head: { sha: string; ref: string; repository: string | null }; base: { sha: string | null; ref: string };
}
/** A check run or commit status of a commit, as far as its verdict reads it. */
export interface CheckRun { name: string; status: string; conclusion: string | null }
export interface StatusCheck { context: string; state: string }
/** A commit's check runs and latest commit statuses; complete is false when there were more than the pages read. */
export interface CommitChecks { runs: CheckRun[]; statuses: StatusCheck[]; complete: boolean }
/** Pages of 100 check runs, and of 100 commit statuses, read at most. */
export const CHECK_PAGES = 10;

/** The pull request writes of a repair's agent step through the signed-in GitHub CLI. */
export function createRepairPullRequests({ run = exec }: { run?: CommandRunner } = {}) {
  const denied = 'GitHub denied the pull request. Check write access to this repository.';
  const api = (args: string[], operation: string) => gh(run, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', ...args], operation, denied);
  return {
    /** The signed-in account, whose noreply address authors the repair's commits. */
    async account() {
      const data = json(await gh(run, ['api', '--hostname', 'github.com', 'user'], 'Reading the GitHub account', 'GitHub denied access to the account.'));
      if (!isRecord(data) || typeof data.login !== 'string' || !Number.isSafeInteger(data.id)) throw new Error('GitHub returned an unreadable account.');
      return { login: data.login, id: data.id as number };
    },
    /**
     * The open pull request of a head branch into base, such as one a previous repair of the same commit left; one a
     * person opened or retargeted from the branch into another base is not the repair's.
     */
    async find({ repository, branch, base }: { repository: unknown; branch: unknown; base: string }) {
      const name = repositoryOf(repository);
      if (typeof branch !== 'string' || !REPAIR_BRANCH.test(branch)) throw new Error('A repair opens only its perpetual/repair branch.');
      const data = json(await api(['--method', 'GET', `repos/${name}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${name.split('/')[0]}:${branch}`)}&base=${encodeURIComponent(base)}`], 'Reading pull requests'));
      const found = Array.isArray(data) ? data.find(item => isRecord(item) && isRecord(item.head) && item.head.ref === branch && isRecord(item.base) && item.base.ref === base) : undefined;
      return found ? pullRequest(found) : null;
    },
    async create({ repository, base, branch, title, body }: { repository: unknown; base: string; branch: unknown; title: string; body: string }) {
      const name = repositoryOf(repository);
      if (typeof branch !== 'string' || !REPAIR_BRANCH.test(branch)) throw new Error('A repair opens only its perpetual/repair branch.');
      return pullRequest(json(await api(['--method', 'POST', `repos/${name}/pulls`, '-f', `title=${title}`, '-f', `head=${branch}`, '-f', `base=${base}`, '-f', `body=${body}`, '-F', 'draft=true'], 'Opening the pull request')));
    },
    async update({ repository, number, body }: { repository: unknown; number: unknown; body: string }) {
      await api(['--method', 'PATCH', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}`, '-f', `body=${body}`], 'Updating the pull request');
    },
    async ready({ repository, number }: { repository: unknown; number: unknown }) {
      await gh(run, ['pr', 'ready', String(pullNumber(number)), '--repo', repositoryOf(repository)], 'Marking the pull request ready', denied);
    },
    async label({ repository, number, label }: { repository: unknown; number: unknown; label: string }) {
      await api(['--method', 'POST', `repos/${repositoryOf(repository)}/issues/${pullNumber(number)}/labels`, '-f', `labels[]=${label}`], 'Labelling the pull request');
    },
    async comment({ repository, number, body }: { repository: unknown; number: unknown; body: string }) {
      await api(['--method', 'POST', `repos/${repositoryOf(repository)}/issues/${pullNumber(number)}/comments`, '-f', `body=${body}`], 'Commenting on the pull request');
    },
    /** Whether the pull request is open, closed, or merged, which a person may have done on GitHub, and its merge commit. */
    async state({ repository, number }: { repository: unknown; number: unknown }): Promise<PullRequestRead> {
      const data = json(await api(['--method', 'GET', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}`], 'Reading the pull request'));
      if (!isRecord(data) || data.state !== 'open' && data.state !== 'closed') throw new Error('GitHub returned an unreadable pull request.');
      return data.merged === true || typeof data.merged_at === 'string' ? { state: 'merged', mergeCommit: readSha(data.merge_commit_sha) } : { state: data.state, mergeCommit: null };
    },
    async close({ repository, number }: { repository: unknown; number: unknown }) {
      await api(['--method', 'PATCH', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}`, '-f', 'state=closed'], 'Closing the pull request');
    },
    /** The pull request as the merge step reads it before merging; a person may have merged, closed or pushed to it. */
    async pull({ repository, number }: { repository: unknown; number: unknown }): Promise<PullRequestState> {
      const data = json(await api(['--method', 'GET', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}`], 'Reading the pull request'));
      const head = isRecord(data) && isRecord(data.head) ? data.head : null, base = isRecord(data) && isRecord(data.base) ? data.base : null, sha = readSha(head?.sha);
      if (!isRecord(data) || data.state !== 'open' && data.state !== 'closed' || !head || !base || !sha || typeof head.ref !== 'string' || typeof base.ref !== 'string') throw new Error('GitHub returned an unreadable pull request.');
      const merged = data.merged === true || typeof data.merged_at === 'string';
      return { state: data.state, merged, mergeCommit: merged ? readSha(data.merge_commit_sha) : null, draft: data.draft === true,
        head: { sha, ref: head.ref.slice(0, 255), repository: isRecord(head.repo) && typeof head.repo.full_name === 'string' ? head.repo.full_name.slice(0, 200) : null },
        base: { sha: readSha(base.sha), ref: base.ref.slice(0, 255) } };
    },
    /**
     * A commit's check runs (the latest of each, GitHub's default) and its latest commit status per context, up to
     * CHECK_PAGES pages of each; complete is false when there were more.
     */
    async checks({ repository, sha }: { repository: unknown; sha: unknown }): Promise<CommitChecks> {
      const target = `repos/${repositoryOf(repository)}/commits/${shaOf(sha)}`;
      const pages = async <T>(endpoint: string, field: string, item: (value: Record<string, unknown>) => T | null) => {
        const items: T[] = [];
        for (let page = 1; page <= CHECK_PAGES; page += 1) {
          const data = json(await api(['--method', 'GET', `${target}/${endpoint}?per_page=100&page=${page}`], 'Reading the checks'));
          const list = isRecord(data) ? data[field] : null, total = isRecord(data) ? data.total_count : null;
          if (!Array.isArray(list) || !Number.isSafeInteger(total)) throw new Error('GitHub returned unreadable checks.');
          for (const entry of list) { const value = isRecord(entry) ? item(entry) : null; if (!value) throw new Error('GitHub returned unreadable checks.'); items.push(value); }
          if (list.length < 100 || items.length >= (total as number)) return { items, complete: true };
        }
        return { items, complete: false };
      };
      const [runs, statuses] = await Promise.all([
        pages('check-runs', 'check_runs', value => typeof value.status === 'string' ? { name: plain(value.name), status: value.status.slice(0, 40), conclusion: typeof value.conclusion === 'string' ? value.conclusion.slice(0, 40) : null } : null),
        pages('status', 'statuses', value => typeof value.state === 'string' && typeof value.context === 'string' ? { context: plain(value.context, 255), state: value.state.slice(0, 40) } : null),
      ]);
      return { runs: runs.items, statuses: statuses.items, complete: runs.complete && statuses.complete };
    },
    /** How far head is behind and ahead of base: behindBy counts base's commits head lacks, such as the target branch moving. */
    async compare({ repository, base, head }: { repository: unknown; base: unknown; head: unknown }) {
      const data = json(await api(['--method', 'GET', `repos/${repositoryOf(repository)}/compare/${shaOf(base)}...${shaOf(head)}?per_page=1`], 'Comparing the pull request'));
      if (!isRecord(data) || !Number.isSafeInteger(data.behind_by) || !Number.isSafeInteger(data.ahead_by) || typeof data.status !== 'string') throw new Error('GitHub returned an unreadable comparison.');
      return { status: data.status.slice(0, 40), behindBy: data.behind_by as number, aheadBy: data.ahead_by as number };
    },
    /** A commit's parents in order, such as those of the merge commit GitHub makes when it updates a pull request's branch. */
    async parents({ repository, sha }: { repository: unknown; sha: unknown }): Promise<string[]> {
      const data = json(await api(['--method', 'GET', `repos/${repositoryOf(repository)}/git/commits/${shaOf(sha)}`], 'Reading the commit'));
      const parents = isRecord(data) && Array.isArray(data.parents) && data.parents.length <= 64 ? data.parents.map(parent => readSha(isRecord(parent) ? parent.sha : null)) : null;
      if (!parents || parents.some(parent => !parent)) throw new Error('GitHub returned an unreadable commit.');
      return parents as string[];
    },
    /** Merges the target branch into the pull request's branch on GitHub, only while its head is still sha (422 otherwise). */
    async updateBranch({ repository, number, sha }: { repository: unknown; number: unknown; sha: unknown }) {
      await gh(run, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', '--method', 'PUT', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}/update-branch`, '-f', `expected_head_sha=${shaOf(sha)}`],
        'Updating the pull request branch', denied, undefined, { 422: 'GitHub could not update the pull request branch. Resolve its conflicts on GitHub.' });
    },
    /**
     * Squash-merges the pull request only while its head is still sha: GitHub refuses a head that moved (409). Returns the
     * merge commit. Its message is fixed, so no model text from the repair's commits or body reaches the target branch.
     */
    async merge({ repository, number, sha, title }: { repository: unknown; number: unknown; sha: unknown; title: string }) {
      const data = json(await gh(run, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', '--method', 'PUT', `repos/${repositoryOf(repository)}/pulls/${pullNumber(number)}/merge`,
        '-f', 'merge_method=squash', '-f', `sha=${shaOf(sha)}`, '-f', `commit_title=${plain(title, 250)}`, '-f', 'commit_message=Merged by Perpetual.'], 'Merging the pull request', denied, undefined,
      { 405: 'GitHub refused the merge. Check the pull request\'s required reviews and checks.', 409: 'The pull request changed after verification.', 422: 'GitHub refused the merge. Check the pull request\'s required reviews and checks.' }));
      const merged = isRecord(data) && data.merged === true ? readSha(data.sha) : null;
      if (!merged) throw new Error('GitHub did not merge the pull request.');
      return { sha: merged };
    },
  };
}
export type RepairPullRequests = ReturnType<typeof createRepairPullRequests>;
