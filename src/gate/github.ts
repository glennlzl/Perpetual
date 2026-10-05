import { GITHUB_MESSAGES, githubFailureKind, githubHttpStatus, isRepository, runGitHub, type GitHubRun } from '../github-cli.ts';
import { githubRequest } from '../github-runs.ts';
import { SHA, type CommitStatus } from './rules.ts';

export interface BranchHeadInput { repository: string; branch: string | null; etag?: string | null }
/** 304: the head is unchanged since the ETag; 200: the head commit and its new ETag. */
export type BranchHead = { status: 304 } | { status: 200; sha: string; etag: string | null };
export type CommitStatusPost = CommitStatus & { repository: string; sha: string };
/** A `gh api` GET (src/github-runs.ts); data is the parsed response body. */
type GitHubRequest = (endpoint: string, etag: string | null) => Promise<{ status: number; etag?: string | null; data?: unknown }>;
const STATES = new Set(['pending', 'success', 'failure', 'error']);
const TEXT = /^[^\u0000-\u001f\u007f]{1,140}$/u;
const repository = (value: unknown) => {
  if (!isRepository(value)) throw new Error('Connect a GitHub repository.');
  return value;
};

/** The branch head, read conditionally: an unchanged head costs a 304 and no rate limit. */
export async function readBranchHead({ repository: name, branch, etag = null }: BranchHeadInput, { request = githubRequest }: { request?: GitHubRequest } = {}): Promise<BranchHead> {
  const endpoint = `repos/${repository(name)}/branches/${encodeURIComponent(String(branch))}`;
  let response;
  try { response = await request(endpoint, etag); }
  catch { throw new Error(`Could not read ${branch} from GitHub.`); }
  if (response.status === 304) return { status: 304 };
  const sha = (response.data as { commit?: { sha?: unknown } } | null | undefined)?.commit?.sha;
  if (response.status !== 200 || typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`GitHub returned no commit for ${branch}.`);
  return { status: 200, sha: sha.toLowerCase(), etag: response.etag || null };
}

// GitHub gives the same answer to the same account for the same commit, so the gate does not send the report again.
const refused = (message: string) => Object.assign(new Error(message), { refused: true });
// The failure's kind comes from github-cli; the words for it are the gate's, and never the raw output. A refusal
// (HTTP 403, 404 or 422) that is not a rate limit is marked `refused`.
function statusFailure(error: unknown) {
  const kind = githubFailureKind(error), status = githubHttpStatus(error);
  if (kind === 'missing' || kind === 'rate-limit' || kind === 'unauthenticated') return new Error(GITHUB_MESSAGES[kind]);
  if (kind === 'timeout') return new Error('Reporting the commit status timed out.');
  if (kind === 'not-found' || kind === 'denied' || status === 403 || status === 404) return refused('GitHub denied the commit status. Check write access to this repository, then run the gate again.');
  if (status === 422) return refused('GitHub refused the commit status. Check that the commit is on GitHub, then run the gate again.');
  return new Error('Reporting the commit status failed.');
}

/** Sets a commit status through the signed-in GitHub CLI session; a refusal GitHub would repeat rejects with `refused: true`. */
export async function postCommitStatus({ repository: name, sha, state, context, description }: CommitStatusPost, { run }: { run?: GitHubRun } = {}) {
  if (typeof sha !== 'string' || !SHA.test(sha) || !STATES.has(state) || !TEXT.test(context || '') || !TEXT.test(description || '')) throw new Error('Invalid commit status.');
  const args = ['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json',
    `repos/${repository(name)}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`];
  try { await runGitHub(args, { maxBuffer: 1024 * 1024, run }); }
  catch (error) { throw statusFailure(error); }
}
