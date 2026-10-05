import { SHA, hasNextPage, isRepository } from './github-cli.ts';
import { eachBounded, failure, githubRequest, remember, type GitHubResponse } from './github-runs.ts';
import { getGitHubSession, type GitHubSession } from './github-source.ts';

// GitHub JSON is untrusted: every field is checked below before it enters a record.
type GitHubJson = { readonly [key: string]: unknown } | null | undefined;
/** What the latest deployment status reports: GitHub's state, when, and the deployment's addresses. */
// The reply shapes are the contract's (contract/github.ts), which the client reads as types.
import type { CommitDeployments, DeploymentRecord, DeploymentStatus } from '../contract/github.ts';
export type { CommitDeployments, DeploymentRecord, DeploymentStatus };
export interface GitHubDeploymentsReader {
  session(): Promise<GitHubSession>;
  read(input: { repository?: unknown; sha?: unknown; login?: unknown }): Promise<CommitDeployments>;
}

const STATES = new Set(['pending', 'queued', 'in_progress', 'success', 'failure', 'error', 'inactive']);
const FINAL = new Set(['success', 'failure', 'error', 'inactive']);
// The apps that record deployments on GitHub, by the login they create them with.
const PROVIDERS = new Map([
  ['vercel[bot]', 'Vercel'], ['railway-app[bot]', 'Railway'], ['netlify[bot]', 'Netlify'], ['render[bot]', 'Render'],
  ['cloudflare-workers-and-pages[bot]', 'Cloudflare'], ['github-pages[bot]', 'GitHub Pages'], ['github-actions[bot]', 'GitHub Actions'],
]);
const text = (value: unknown, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : null;
const time = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const flag = (value: unknown) => typeof value === 'boolean' ? value : null;
const record = (value: unknown): value is NonNullable<GitHubJson> => value !== null && typeof value === 'object';
// A deployment's addresses point at the provider, so any https address is kept and everything else dropped.
function link(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

/** The provider a deployment's creator stands for: a known app's name, else the login without its bot suffix. */
export function deploymentProvider(login: unknown): string {
  const name = typeof login === 'string' ? login.trim() : '';
  if (!name) return 'GitHub';
  return PROVIDERS.get(name.toLowerCase()) ?? name.replace(/\[bot\]$/i, '').split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

// Read-only deployment records for one commit. A record for another commit
// never describes the current source, so non-matching SHAs are dropped.
export function normalizeDeployments(data: unknown, sha: string): DeploymentRecord[] {
  const current = sha.toLowerCase();
  return (Array.isArray(data) ? data as GitHubJson[] : []).filter((item): item is NonNullable<GitHubJson> => Number.isSafeInteger(item?.id) && typeof item!.sha === 'string' && item!.sha.toLowerCase() === current).slice(0, 1000).map(item => {
    const creator = record(item.creator) ? text(item.creator.login, 100) : null;
    return {
      id: String(item.id), environment: text(item.environment) || 'Deployment', provider: deploymentProvider(creator), creator,
      production: flag(item.production_environment), transient: flag(item.transient_environment), ref: text(item.ref, 255), task: text(item.task, 100),
      createdAt: time(item.created_at), updatedAt: time(item.updated_at), state: null, stateAt: null, url: null, logUrl: null,
    };
  });
}

/** A deployment's newest status; GitHub lists statuses newest first. */
export function normalizeDeploymentStatus(data: unknown): DeploymentStatus {
  const latest = (Array.isArray(data) ? data as GitHubJson[] : [])[0];
  const state = typeof latest?.state === 'string' && STATES.has(latest.state) ? latest.state : null;
  return { state, stateAt: time(latest?.created_at), url: link(latest?.environment_url), logUrl: link(latest?.log_url) ?? link(latest?.target_url) };
}

// Every read is keyed by the connected login, so data read for one account is
// never served to another; the session is re-read on every call, as for runs.
export function createGitHubDeploymentsReader({ request = (endpoint, etag) => githubRequest(endpoint, etag, { subject: 'deployments' }), session = getGitHubSession, ttl = 4000, now = Date.now }: {
  request?: (endpoint: string, etag: string | null) => Promise<GitHubResponse>; session?: () => Promise<GitHubSession>; ttl?: number; now?: () => number;
} = {}): GitHubDeploymentsReader {
  const tags = new Map<string, { etag: string; data: unknown; next: boolean }>(), settled = new Map<string, DeploymentStatus>(), reads = new Map<string, { at: number; promise: Promise<CommitDeployments> }>();
  // A page's body, and whether another page follows it, which a 304 keeps from the cached reply.
  async function conditional(login: string, endpoint: string): Promise<{ data: unknown; next: boolean }> {
    const tag = `${login}:${endpoint}`, cached = tags.get(tag), response = await request(endpoint, cached?.etag || null);
    if (response.status === 304 && cached) return cached;
    if (response.status !== 200) throw failure('GitHub returned an unexpected response. Try again.');
    const page = { data: response.data, next: hasNextPage(response) };
    if (response.etag) remember(tags, tag, { etag: response.etag, ...page });
    return page;
  }
  async function load(login: string, repository: string, sha: string): Promise<CommitDeployments> {
    // GitHub lists a commit's records newest first, 50 a page; up to 1,000 are read, as workflow runs are.
    const listed: unknown[] = [];
    for (let page = 1; ; page++) {
      const { data, next } = await conditional(login, `repos/${repository}/deployments?sha=${sha}&per_page=50${page === 1 ? '' : `&page=${page}`}`);
      if (Array.isArray(data)) listed.push(...data);
      if (!next) break;
      if (page === 20) throw failure('GitHub deployment records exceed the 1,000-record reading limit.');
    }
    const deployments = normalizeDeployments(listed, sha);
    // A pending deployment's status is re-read; a settled one is read once per update.
    await eachBounded(deployments, async deployment => {
      const key = `${login}:${repository}:${deployment.id}:${deployment.updatedAt}`, known = settled.get(key);
      if (known) { Object.assign(deployment, known); return; }
      let status: DeploymentStatus;
      try { status = normalizeDeploymentStatus((await conditional(login, `repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`)).data); }
      catch { return; }
      Object.assign(deployment, status);
      // As many final statuses are kept as records are read, so a long list never evicts its own.
      if (status.state && FINAL.has(status.state)) remember(settled, key, status, 1000);
    });
    return { repository, sha, deployments };
  }
  return {
    session() { return session(); },
    read({ repository, sha, login }) {
      if (!isRepository(repository)) return Promise.reject(new Error('Connect a GitHub repository to read deployments.'));
      if (typeof login !== 'string' || !login) return Promise.reject(new Error('Connect your GitHub account to read deployments.'));
      if (typeof sha !== 'string' || !SHA.test(sha)) return Promise.resolve({ repository, sha: null, deployments: [] });
      const account = login.toLowerCase(), key = `${account}:${repository.toLowerCase()}@${sha}`, cached = reads.get(key);
      if (cached && now() - cached.at < ttl) return cached.promise.then(result => structuredClone(result));
      const promise = load(account, repository, sha);
      remember(reads, key, { at: now(), promise }, 20);
      promise.catch(() => { if (reads.get(key)?.promise === promise) reads.delete(key); });
      return promise.then(result => structuredClone(result));
    },
  };
}
