import type { GateView } from '../../../contract/gate.ts';
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
 * Whether the journey gates allow a release of the scanned commit as far as the page can read them: Production is Ready
 * there, and every stage's gate passed or was released there without a report error. Each gate then reports its commit
 * status to GitHub, which the release requires and the gate view does not show.
 */
export const gatesReleasable = (gates: GateView | null | undefined, sha: string | null | undefined) => Boolean(sha && gates?.production?.sha === sha
  && Object.values(gates.stages).every(gate => gate.sha === sha && ['passed', 'released'].includes(gate.status) && !gate.statusError));
/** Whether Deploy waits only for those reports: the gates allow the commit and a target is set, but the release does not allow it yet. */
export const releaseAwaitingGates = (view: ReleaseReply | null | undefined, gatesReady: boolean) => gatesReady && Boolean(view?.target) && !view?.canDeploy && view?.current?.status !== 'deployed';

/**
 * Source-bound reads clear stale deployment eligibility when the controller cannot be read. Each read checks the GitHub
 * session, so the release is read every `activeDelay` only while it is pending or awaits the gates' reports, given
 * `gatesReady` (see gatesReleasable), and otherwise every `idleDelay`. A failed read keeps the last view's cadence; a
 * refresh reads it at once.
 */
export function createReleasePoller({ repoPath, controller, onChange, onError, gatesReady = () => false, activeDelay = 3000, idleDelay = 60000, document = globalThis.document, timers = globalThis }: { repoPath: string; controller: Controller; onChange: (view: ReleaseReply | null) => void; onError?: (message: string | null) => void; gatesReady?: () => boolean; activeDelay?: number; idleDelay?: number; document?: PageVisibility | null; timers?: Timers }) {
  let last: ReleaseReply | null = null;
  return createVisiblePoller({ document, timers, interval: () => releasePending(last) || releaseAwaitingGates(last, gatesReady()) ? activeDelay : idleDelay,
    async read() {
      const reply = await controller(`/api/releases?${new URLSearchParams({ repoPath })}`) as ReleaseReply;
      if (reply?.repoPath !== repoPath) throw new Error('The source changed. Reload the pipeline.');
      return reply;
    },
    onResult(result) {
      if (result.ok) last = result.value;
      onChange(result.ok ? result.value : null);
      onError?.(result.ok ? null : result.error instanceof Error ? result.error.message : 'Release status unavailable. Check status to retry.');
    },
  });
}
