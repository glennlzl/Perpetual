import type { ReleaseRecord, ReleaseReply, ReleaseTarget, ReleaseView } from '../../../contract/releases.ts';
import type { Controller } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';

export interface ReleaseConfirmation { sha: string; target: ReleaseTarget }
/** The managed checkout keeps its path when a gate advances it to a new commit. */
export function releaseForSource(view: ReleaseReply | null | undefined, repoPath: string | null | undefined, sha: string | null | undefined): ReleaseReply | null {
  return view && view.repoPath === repoPath && (view.sha === null || view.sha === sha) ? view : null;
}
type ReleaseTone = 'idle' | 'working' | 'passed' | 'failed' | 'blocked';
const STATES: Record<ReleaseRecord['status'], { label: string; tone: ReleaseTone }> = {
  requesting: { label: 'Requesting', tone: 'working' }, queued: { label: 'Queued', tone: 'working' }, deploying: { label: 'Deploying', tone: 'working' },
  deployed: { label: 'Deployed', tone: 'passed' }, failed: { label: 'Deploy failed', tone: 'failed' }, inactive: { label: 'Inactive', tone: 'idle' }, unknown: { label: 'Check deployment', tone: 'blocked' },
};
export function releaseBadge(record: ReleaseRecord | null | undefined) {
  if (!record) return null;
  const state = STATES[record.status];
  return { ...state, active: state.tone === 'working', hint: record.error || '', sha: record.sha.slice(0, 7) };
}

/** Polling never changes the commit or target a person is about to confirm. */
export function releaseRequest(view: ReleaseView | null | undefined, confirmed: ReleaseConfirmation): { sha: string; target: ReleaseTarget } | null {
  if (!view?.canDeploy || !view.sha || view.sha !== confirmed.sha || !view.target) return null;
  const target = view.target;
  if (target.environment !== confirmed.target.environment || target.productionEnvironment !== confirmed.target.productionEnvironment || target.workflowPath !== confirmed.target.workflowPath) return null;
  return { sha: confirmed.sha, target: { ...confirmed.target } };
}

const listeners = new Set<() => void>();
export const releaseChanges = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  notify() { listeners.forEach(listener => listener()); },
};

/** Source-bound reads clear stale deployment eligibility when the controller cannot be read. */
export function createReleasePoller({ repoPath, controller, onChange, onError, interval = 3000, document = globalThis.document, timers = globalThis }: { repoPath: string; controller: Controller; onChange: (view: ReleaseReply | null) => void; onError?: (message: string | null) => void; interval?: number; document?: PageVisibility | null; timers?: Timers }) {
  let timer: unknown, stopped = false, loading = false, again = false;
  const schedule = () => { timers.clearTimeout(timer); if (!stopped && !document?.hidden) timer = timers.setTimeout(poll, interval); };
  async function poll() {
    if (stopped || document?.hidden) return;
    if (loading) { again = true; return; }
    loading = true;
    let next: ReleaseReply | null = null, error: string | null = null;
    try {
      const reply = await controller(`/api/releases?${new URLSearchParams({ repoPath })}`) as ReleaseReply;
      if (reply?.repoPath === repoPath) next = reply;
      else error = 'The source changed. Reload the pipeline.';
    } catch (failure) { error = failure instanceof Error ? failure.message : 'Release status unavailable. Check status to retry.'; }
    loading = false;
    if (stopped) return;
    onChange(next);
    onError?.(error);
    if (again) { again = false; void poll(); return; }
    schedule();
  }
  const visibility = () => { if (!document?.hidden && !stopped) { timers.clearTimeout(timer); void poll(); } };
  document?.addEventListener?.('visibilitychange', visibility);
  void poll();
  return {
    refresh() { timers.clearTimeout(timer); void poll(); },
    stop() { stopped = true; timers.clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); },
  };
}
