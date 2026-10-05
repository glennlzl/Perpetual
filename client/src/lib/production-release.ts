import type { ReleaseRecord, ReleaseReply, ReleaseTarget, ReleaseView } from '../../../contract/releases.ts';
import type { Controller } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';
import { createVisiblePoller } from './visible-poller.ts';

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

/** Whether the release a person requested is still being requested, queued, deployed or resolved. */
export const releasePending = (view: ReleaseReply | null | undefined) => ['requesting', 'queued', 'deploying', 'unknown'].includes(view?.current?.status ?? '');

/**
 * Source-bound reads clear stale deployment eligibility when the controller cannot be read. Each read checks the GitHub
 * session, so the release is read every `activeDelay` only while it is pending and otherwise every `idleDelay`; a
 * refresh reads it at once.
 */
export function createReleasePoller({ repoPath, controller, onChange, onError, activeDelay = 3000, idleDelay = 60000, document = globalThis.document, timers = globalThis }: { repoPath: string; controller: Controller; onChange: (view: ReleaseReply | null) => void; onError?: (message: string | null) => void; activeDelay?: number; idleDelay?: number; document?: PageVisibility | null; timers?: Timers }) {
  let pending = false;
  return createVisiblePoller({ document, timers, interval: () => pending ? activeDelay : idleDelay,
    async read() {
      const reply = await controller(`/api/releases?${new URLSearchParams({ repoPath })}`) as ReleaseReply;
      if (reply?.repoPath !== repoPath) throw new Error('The source changed. Reload the pipeline.');
      return reply;
    },
    onResult(result) {
      pending = result.ok && releasePending(result.value);
      onChange(result.ok ? result.value : null);
      onError?.(result.ok ? null : result.error instanceof Error ? result.error.message : 'Release status unavailable. Check status to retry.');
    },
  });
}
