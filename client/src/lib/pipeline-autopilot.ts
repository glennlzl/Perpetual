// Autopilot as the pipeline shows it, read from GET /api/autopilot. Modes, changes and
// their steps come from the controller's records only; nothing here infers a state.
import type { Controller } from './api.ts';
import { createGitHubPoller, type GitHubPollerOptions } from './pipeline-github.ts';

// The shapes are the controller's contract (contract/autopilot.ts); this file adds what the interface derives from them.
import type { AutopilotChange, AutopilotMode, AutopilotView, ChangeStatus, ChangeStep, DetailPart, StageAutopilot, StepStatus } from '../../../contract/autopilot.ts';
export type { AutopilotChange, AutopilotMode, AutopilotView, ChangeStatus, ChangeStep, DetailPart, StageAutopilot, StepStatus };
export const MODES: readonly AutopilotMode[] = ['merge', 'ask'];
export const MODE_LABELS: Record<AutopilotMode, string> = { merge: 'Autopilot', ask: 'Ask first' };
/** What choosing a mode does, as the menu says it. */
export const MODE_CHOICES: Record<AutopilotMode, string> = { merge: 'Merge changes', ask: 'Ask before merging' };
export const isAutopilotMode = (value: unknown): value is AutopilotMode => MODES.includes(value as AutopilotMode);

export const STEP_LABELS: Record<StepStatus, string> = { pending: 'Not started', active: 'In progress', done: 'Done', failed: 'Failed', waiting: 'Waiting for review' };
export const CHANGE_LABELS: Record<ChangeStatus, string> = { running: 'Running', merged: 'Merged', passed: 'Passed', 'needs-review': 'Needs review', 'not-merged': 'Not merged' };
export type AutopilotTone = 'idle' | 'working' | 'passed' | 'failed' | 'blocked';
const TONES: Record<ChangeStatus, AutopilotTone> = { running: 'working', merged: 'passed', passed: 'passed', 'needs-review': 'blocked', 'not-merged': 'failed' };

export const changeActive = (change: Pick<AutopilotChange, 'status'> | null | undefined) => change?.status === 'running';
export const stageActive = (stage: Pick<StageAutopilot, 'changes'> | null | undefined) => Boolean(stage?.changes?.some(changeActive));
/** Whether any stage has a change under way, so the view is read more often. */
export const autopilotActive = (view: AutopilotView | null | undefined) => Object.values(view?.stages || {}).some(stageActive);

/**
 * The stage Badge: the work under way; else the latest change's end, while that change is the scanned commit's (`sha`)
 * or the watched head's, since an older commit's end no longer describes the stage; else the mode.
 */
export function autopilotBadge(stage: StageAutopilot | null | undefined, sha?: string | null) {
  if (!stage) return null;
  const running = stage.changes.find(changeActive), latest = stage.changes[0];
  if (running) return { text: running.title, tone: TONES.running, change: running };
  if (latest && (!latest.sha || latest.sha === sha || latest.sha === stage.failed?.sha)) return { text: CHANGE_LABELS[latest.status], tone: TONES[latest.status], change: latest };
  return { text: MODE_LABELS[stage.mode], tone: 'idle' as const, change: null };
}

// Unchanged stages keep their identity, so memoized stage cards skip unrelated polls.
export function shareAutopilot(previous: AutopilotView | null, next: AutopilotView | null): AutopilotView | null {
  if (!previous || !next) return next;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (same(previous, next)) return previous;
  const stages = Object.fromEntries(Object.entries(next.stages || {}).map(([id, stage]) => [id, same(previous.stages?.[id], stage) ? previous.stages![id] : stage]));
  return { ...next, stages };
}

// A saved mode refreshes every open view at once.
const listeners = new Set<() => void>();
export const autopilotChanges = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  notify() { listeners.forEach(listener => listener()); },
};

/** Saves a stage's mode through POST /api/autopilot/mode. */
export async function saveAutopilotMode(controller: Controller, { repoPath, stageId, mode }: { repoPath: string; stageId: string; mode: AutopilotMode }) {
  if (!isAutopilotMode(mode)) throw new Error('Choose Merge changes or Ask before merging.');
  await controller('/api/autopilot/mode', { repoPath, stageId, mode });
  autopilotChanges.notify();
}

/** A workflow file's path as a run names it, without a ref suffix. */
const workflowPath = (value: unknown) => String(value || '').replace(/@.*$/, '');
/**
 * Autopilot's Repair for a workflow file: the watched head's failed run of it, with the head's short commit when the runs
 * shown (`shown`) are another commit's. Null while the head has a change under way or waiting, or no such run.
 */
export function repairOffer(stage: Pick<StageAutopilot, 'failed'> | null | undefined, file: string, shown: string | null | undefined): { runId: string; commit?: string } | null {
  const failed = stage?.failed, run = failed?.runs.find(item => workflowPath(item.path) === file);
  if (!failed || !run) return null;
  return { runId: run.id, ...(failed.sha === shown ? {} : { commit: failed.sha.slice(0, 7) }) };
}
/** Hands a failed run at the watched head to Autopilot through POST /api/autopilot/repair. */
export async function startRepair(controller: Controller, input: { repoPath: string; stageId: string; runId: string }) {
  await controller('/api/autopilot/repair', input);
  autopilotChanges.notify();
}
/** Stops a change under way through POST /api/autopilot/stop; a pull request it opened stays open. */
export async function stopChange(controller: Controller, input: { repoPath: string; stageId: string; id: string }) {
  await controller('/api/autopilot/stop', input);
  autopilotChanges.notify();
}

/** Polls the view every 2 seconds while a change is under way and every 15 otherwise, only while the page is visible. */
export function createAutopilotPoller({ repoPath, ...options }: { repoPath: string } & Omit<GitHubPollerOptions<AutopilotView>, 'path' | 'active' | 'activeDelay' | 'idleDelay'>) {
  return createGitHubPoller<AutopilotView>({ ...options, path: `/api/autopilot?repoPath=${encodeURIComponent(repoPath)}`, active: autopilotActive, activeDelay: 2000, idleDelay: 15000 });
}
