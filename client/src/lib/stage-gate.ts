// Journey gates as the pipeline shows them, read from GET /api/gate. States and commits come
// from the controller's gate records only; nothing here infers a result.
import type { Controller } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';

// The shapes are the controller's contract (contract/gate.ts); GateView here is the whole GET /api/gate reply.
import type { GateReply, GateStatus, ProductionGate, StageGate } from '../../../contract/gate.ts';
export type { GateStatus, ProductionGate, StageGate };
export type GateView = GateReply;
export type GateTone = 'idle' | 'working' | 'passed' | 'failed' | 'blocked';
export const GATE_LABELS: Record<string, string> = { queued: 'Queued', 'waiting-build': 'Waiting for Build', 'build-failed': 'Build failed', rebuilding: 'Running', running: 'Running', passed: 'Passed', failed: 'Failed', 'needs-release': 'Needs release', released: 'Released' };
const TONES: Record<string, GateTone> = { queued: 'idle', 'waiting-build': 'idle', 'build-failed': 'failed', rebuilding: 'working', running: 'working', passed: 'passed', released: 'passed', failed: 'failed', 'needs-release': 'blocked' };
const short = (sha: string | null | undefined) => String(sha || '').slice(0, 7);

/** A stage card's gate is a Sandbox stage's gate or Production's readiness; only the former names a stage. */
export const isStageGate = (gate: StageGate | ProductionGate | null | undefined): gate is StageGate => Boolean(gate && 'stageId' in gate);
export const gateActive = (gate: Pick<StageGate, 'status'> | null | undefined) => ['rebuilding', 'running'].includes(gate?.status ?? '');
export const gatePending = (gate: Pick<StageGate, 'status'> | null | undefined) => ['queued', 'waiting-build'].includes(gate?.status ?? '') || gateActive(gate);
/** Only a gate that needs release offers Release; a failed gate never does. */
export const canRelease = <G extends Pick<StageGate, 'status'>>(gate: G | null | undefined): gate is G => gate?.status === 'needs-release';

export function gateBadge(gate: StageGate | null | undefined) {
  if (!gate || !GATE_LABELS[gate.status]) return null;
  return { label: GATE_LABELS[gate.status], tone: TONES[gate.status], sha: short(gate.sha), hint: [gate.reason, gate.statusError].filter(Boolean).join(' ') };
}

/** Production is Ready only for a commit every Sandbox gate passed or released. */
export const productionStatus = (production: ProductionGate | null | undefined) => production?.status === 'ready' ? { kind: 'passed' as const, text: 'Ready', sha: short(production.sha) } : null;

/** The commit a gate view reports for the same checkout when the controller moved the managed source there, else null. */
export const sourceMoved = (view: Pick<GateView, 'repoPath' | 'sha'> | null | undefined, repo: { path?: string; sha?: string | null } | null | undefined) => (view && repo?.path && view.repoPath === repo.path && view.sha && view.sha !== repo.sha ? view.sha : null);

// Unchanged stage gates keep their identity, so memoized stage cards skip unrelated polls.
export function shareGates(previous: GateView | null, next: GateView | null): GateView | null {
  if (!previous || !next) return next;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (same(previous, next)) return previous;
  // A gate equal to the previous one's exists in the previous stages.
  const stages = Object.fromEntries(Object.entries(next.stages || {}).map(([id, gate]) => [id, same(previous.stages?.[id], gate) ? previous.stages![id] : gate]));
  return { ...next, stages, production: same(previous.production, next.production) ? previous.production : next.production };
}

// Run now and Release refresh every gate view at once.
const listeners = new Set<() => void>();
export const gateChanges = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  notify() { listeners.forEach(listener => listener()); },
};

/** Polls the gate view while the page is visible; a failed read shows no gates rather than stale ones. */
export function createGatePoller({ controller, onChange, interval = 3000, document = globalThis.document, timers = globalThis }: { controller: Controller; onChange: (view: GateView | null) => void; interval?: number; document?: PageVisibility | null; timers?: Timers }) {
  let timer: unknown, stopped = false, loading = false, again = false;
  const schedule = () => { timers.clearTimeout(timer); if (!stopped && !document?.hidden) timer = timers.setTimeout(poll, interval); };
  async function poll() {
    if (stopped || document?.hidden) return;
    if (loading) { again = true; return; }
    loading = true;
    let next: GateView | null = null;
    try { next = await controller('/api/gate') as GateView; } catch { next = null; }
    loading = false;
    if (stopped) return;
    onChange(next);
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
