// GitHub Actions status for the watched Build commit, read through /api/github/build.
// A run for another commit never verifies the current source.
import type { Controller } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';
import { createVisiblePoller } from './visible-poller.ts';

// The shapes are the controller's contract (contract/github.ts): GET /api/github/runs as the controller replies.
import type { ActionWorkflow, BuildReply, CommitRuns, WorkflowJob, WorkflowRun, WorkflowStep } from '../../../contract/github.ts';
export type { BuildReply };
export type GitHubStep = WorkflowStep;
export type GitHubJob = WorkflowJob;
export type GitHubRun = WorkflowRun;
/** GET /api/github/runs: the repository's workflow runs for one commit. */
export type GitHubRuns = CommitRuns;
export type GitHubMark = 'running' | 'queued' | 'waiting' | 'failed' | 'cancelled' | 'passed' | 'skipped';
/** The Build status for the current commit. */
export interface BuildSummary { status: GitHubMark; sha: string }
/** Build's status Badge: working, failed, passed or idle. */
export interface BuildStatus { kind: string; text: string; sha?: string; hint?: string }

const STATUS_MARKS: Record<string, GitHubMark> = { requested: 'queued', pending: 'queued', queued: 'queued', waiting: 'waiting', in_progress: 'running' };
const CONCLUSION_MARKS: Record<string, GitHubMark> = { success: 'passed', neutral: 'passed', failure: 'failed', timed_out: 'failed', startup_failure: 'failed', cancelled: 'cancelled', stale: 'cancelled', skipped: 'skipped', action_required: 'waiting' };
const PRIORITY: GitHubMark[] = ['running', 'queued', 'waiting', 'failed', 'cancelled', 'passed', 'skipped'];
export const GITHUB_MARK_LABELS: Record<GitHubMark, string> = { running: 'Running', queued: 'Queued', waiting: 'Waiting', failed: 'Failed', cancelled: 'Cancelled', passed: 'Passed', skipped: 'Skipped' };

export const githubMark = (item: { status: string | null; conclusion?: string | null } | null | undefined): GitHubMark | null => !item ? null : item.status === 'completed' ? CONCLUSION_MARKS[String(item.conclusion)] || null : STATUS_MARKS[String(item.status)] || null;
export function combinedMark(marks: (GitHubMark | null)[]) {
  const present = new Set(marks);
  return PRIORITY.find(mark => present.has(mark)) || null;
}

const workflowPath = (value: unknown) => String(value || '').replace(/@.*$/, '');
/**
 * Build and its workflow/job/step rail share the branch's latest push/manual runs, as gate admission selects them.
 * Preserve the raw reply for other readers. This is display evidence, never authorization: the gate reads all pages
 * independently before admitting a twin. Without a known branch or matching commit the display stays unverified.
 */
export function githubBranchBuild(result: GitHubRuns | null | undefined, sha: string | null | undefined, branch: string | null | undefined): GitHubRuns | null {
  if (!result || !sha || result.sha !== sha || !branch) return null;
  const latest = new Map<string, GitHubRun>();
  for (const run of result.runs) {
    if (run.sha !== sha || run.branch !== branch || !['push', 'workflow_dispatch'].includes(String(run.event))
      || !workflowPath(run.path).startsWith('.github/workflows/') || !run.workflowId) continue;
    const previous = latest.get(run.workflowId);
    if (!previous || Number(run.id) > Number(previous.id) || run.id === previous.id && run.attempt > previous.attempt) latest.set(run.workflowId, run);
  }
  return { ...result, runs: [...latest.values()] };
}
// The rail lists the scanned .github/workflows files only. Dynamic runs such as
// Pages, CodeQL default setup or Dependabot have no row, so they never set the
// Build status, its inbound flow, or the GitHub pulse.
function railRuns(result: GitHubRuns | null | undefined, workflows: string[] | undefined) {
  const listed = new Set(workflows || []);
  return (result?.runs || []).filter(run => { const path = workflowPath(run.path); return Boolean(path) && listed.has(path); });
}

export function githubBuildSummary(result: GitHubRuns | null | undefined, sha: string | null | undefined, workflows?: string[]): BuildSummary | null {
  if (!result || !sha || result.sha !== sha) return null;
  const status = combinedMark(railRuns(result, workflows).map(githubMark));
  return status ? { status, sha: sha.slice(0, 7) } : null;
}
const BUILD_KINDS: Record<string, string> = { running: 'working', queued: 'working', failed: 'failed', passed: 'passed' };
/**
 * Build's status Badge for the current commit, or null while its runs are unknown: not read yet, a failed read,
 * or another commit's runs just after the source moved. Not run only once they were read and no listed workflow ran.
 */
export function githubBuildStatus(result: GitHubRuns | null | undefined, sha: string | null | undefined, workflows?: string[]): BuildStatus | null {
  if (!result || !sha || result.sha !== sha) return null;
  const build = githubBuildSummary(result, sha, workflows);
  return build ? { kind: BUILD_KINDS[build.status] || 'idle', text: GITHUB_MARK_LABELS[build.status], sha: build.sha } : { kind: 'idle', text: 'Not run' };
}

// Rail labels for scanned configuration only. An unnamed `uses:` step keeps its
// action and a short ref; an unevaluated expression leaves its base name and context.
// Observed job and step names are shown exactly as GitHub reported them.
const ACTION_REF = /^([\w.-]+\/[\w./-]+|docker:\/\/[\w./:-]+)@([\w./:-]+)$/;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;
const CONTEXT = /(?<![\w.])(matrix|inputs|github|env|vars|needs|steps|jobs|job|runner|strategy|secrets)\s*[.[]/g;
export function actionLabel(value: unknown, fallback = ''): { text: string; ref: string | null; contexts: string[] } {
  const name = String(value ?? '');
  const action = name.match(ACTION_REF);
  if (action) return { text: action[1], ref: action[2].match(/^(?:sha256:)?([0-9a-f]{40}|[0-9a-f]{64})$/i)?.[1].slice(0, 7) || action[2], contexts: [] };
  const expressions = name.match(EXPRESSION);
  if (!expressions) return { text: name || fallback, ref: null, contexts: [] };
  const contexts = [...new Set(expressions.flatMap(expression => [...expression.matchAll(CONTEXT)].map(match => match[1])))];
  const text = name.replace(EXPRESSION, '\0')
    .replace(/\s*[([][^()[\]]*\0[^()[\]]*[)\]]/g, '')
    .replace(/\s+(?:on|for|with|to|using|via)\s*(?=\0)/gi, ' ')
    .replaceAll('\0', ' ').replace(/\s+/g, ' ')
    .replace(/^[\s:/|,·–—-]+|[\s:/|,·–—-]+$/g, '');
  return { text: text || fallback, ref: null, contexts: contexts.length ? contexts : ['expression'] };
}
export const actionText = (value: unknown, fallback?: string) => { const { text, ref, contexts } = actionLabel(value, fallback); return [text, ref, contexts.length ? `(${contexts.join(', ')})` : ''].filter(Boolean).join(' '); };

/** Build has its own commit; Source and Production continue to describe the scanned checkout. */
export function buildForSource(view: BuildReply | null | undefined, source: { repoPath?: string; branch?: string | null; scannedSha?: string | null }): BuildReply | null {
  return view && view.repoPath === source.repoPath && view.branch === (source.branch ?? null) && view.scannedSha === (source.scannedSha ?? null) ? view : null;
}

export function watchedBuildSummary(view: BuildReply | null | undefined): BuildSummary | null {
  const eligible = githubBranchBuild(view, view?.sha, view?.branch);
  return githubBuildSummary(eligible, view?.sha, eligible?.runs.map(run => workflowPath(run.path)));
}
export function watchedBuildStatus(view: BuildReply | null | undefined, error?: string | null): BuildStatus | null {
  if (error) return { kind: 'idle', text: 'Unverified', hint: error };
  if (!view) return null;
  if (!view.sha || !view.branch) return { kind: 'idle', text: 'Unverified', hint: 'Select a GitHub branch to read Build.' };
  const eligible = githubBranchBuild(view, view.sha, view.branch);
  const status = githubBuildStatus(eligible, view.sha, eligible?.runs.map(run => workflowPath(run.path)));
  return status && { ...status, sha: view.sha.slice(0, 7) };
}

/** Names from the scanned workflow files. These are configuration, never execution evidence. */
export type ConfiguredWorkflow = ActionWorkflow;
export interface BuildWorkflowRow extends ConfiguredWorkflow { runs: GitHubRun[] }
/** Observed jobs retain their exact GitHub names/IDs; a matrix or reusable job is never matched by guessing. */
export function buildWorkflowRows(view: BuildReply | null | undefined, configured: ConfiguredWorkflow[], scannedSha: string | null | undefined): BuildWorkflowRow[] {
  const rows = new Map<string, BuildWorkflowRow>();
  if (view?.sha && view.sha === scannedSha) for (const workflow of configured) rows.set(workflow.file, { ...workflow, runs: [] });
  for (const run of githubBranchBuild(view, view?.sha, view?.branch)?.runs ?? []) {
    const file = workflowPath(run.path), row = rows.get(file);
    if (row) { row.runs.push(run); if (run.name) row.name = run.name; }
    else rows.set(file, { file, name: run.name || file.split('/').at(-1) || file, jobs: [], runs: [run] });
  }
  return [...rows.values()];
}

export interface BuildRead { view: BuildReply | null; error: string | null }
const buildListeners = new Set<() => void>();
export const buildChanges = {
  subscribe(listener: () => void) { buildListeners.add(listener); return () => { buildListeners.delete(listener); }; },
  notify() { buildListeners.forEach(listener => listener()); },
};
export function createGitHubBuildPoller({ repoPath, branch, controller, ...options }: Omit<GitHubPollerOptions<BuildRead>, 'path' | 'active'> & { repoPath: string; branch: string | null }) {
  return createGitHubPoller<BuildRead>({ ...options, path: `/api/github/build?${new URLSearchParams({ repoPath, ...(branch ? { branch } : {}) })}`,
    async controller(path) {
      try { return { view: await controller(path) as BuildReply, error: null }; }
      catch (error) { return { view: null, error: error instanceof Error ? error.message : 'Could not read Build. Reconnect GitHub and try again.' }; }
    },
    active: read => ['running', 'queued'].includes(watchedBuildSummary(read?.view)?.status ?? ''),
  });
}

/** Polls one controller route while the page is visible: every `activeDelay` while `active(result)`, else every `idleDelay`, publishing only changed results. */
export interface GitHubPollerOptions<T> { controller: Controller; path: string; active: (result: T | null) => boolean; onChange: (result: T | null) => void; document?: PageVisibility | null; timers?: Timers; activeDelay?: number; idleDelay?: number }
export function createGitHubPoller<T>({ controller, path, active, onChange, document = globalThis.document, timers = globalThis, activeDelay = 5000, idleDelay = 60000 }: GitHubPollerOptions<T>) {
  let current: T | null = null, key: string | undefined;
  return createVisiblePoller({ document, timers, read: () => controller(path) as Promise<T>,
    interval: () => active(current) ? activeDelay : idleDelay,
    onResult(result) {
      const next = result.ok ? result.value : null, nextKey = JSON.stringify(next);
      if (nextKey !== key) { key = nextKey; current = next; onChange(next); }
    },
  });
}
