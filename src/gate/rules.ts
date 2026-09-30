// A journey gate decides whether one commit may leave one Sandbox stage.
// queued -> rebuilding -> running -> passed | failed | needs-release -> released; a queued gate
// is superseded when a newer commit reaches its stage. A repair gate judges a repair's pull request
// head the same way, beside the target branch's gates: it never promotes or supersedes.

import type { GateStatus } from '../../contract/gate.ts';
export type { GateStatus };
export type CommitState = 'pending' | 'success' | 'failure' | 'error';
/** A commit status as GitHub keeps it: one per context on a commit. */
export interface CommitStatus { state: CommitState; context: string; description: string }
/**
 * The commit and stage a gate judges, as the manager hands it to its steps. A repair gate also names its repair and
 * snapshot, the absolute scan path of a checkout Perpetual owns at the pull request head; its branch is the repair
 * branch, and the source never moves for it.
 */
export interface GateRef { key: string; branch: string | null; stageId: string; sha: string; repair?: string; snapshot?: string }
/** One journey gate, persisted under <dataDir>/gates/state.json. */
export interface Gate extends GateRef {
  id: string; context: string; status: GateStatus; reason?: string;
  createdAt: string; detectedAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
  runId?: string; environmentId?: string; releasedBy?: string; releasedAt?: string;
  posted?: CommitStatus; statusError?: string;
}
/** What a gate's verdict reads from a finished run's roll-up (src/browser/results.ts). */
export interface RunRollup { id?: string; status?: string; error?: string | null; results?: readonly { caseId?: string; status?: string; error?: string | null }[] | null }
export type Verdict = { status: 'passed'; reason?: undefined } | { status: 'failed' | 'needs-release'; reason: string };
type Dated = Pick<Gate, 'status' | 'detectedAt' | 'updatedAt'>;

export { SHA } from '../github-cli.ts';
export const ACTIVE: readonly GateStatus[] = Object.freeze(['rebuilding', 'running']);
/** No twin or journey started; these gates can recheck CI and be superseded by a newer commit. */
export const PENDING: readonly GateStatus[] = Object.freeze(['queued', 'waiting-build', 'build-failed']);
export const PROMOTED: readonly GateStatus[] = Object.freeze(['passed', 'released']);
export const short = (sha: unknown) => String(sha).slice(0, 7);

const RUN_REASONS: Partial<Record<string, string>> = {
  blocked: 'A journey is blocked.',
  needs_review: 'A journey needs review.',
  cancelled: 'The run was cancelled.',
  completed: 'A journey was skipped.',
};

/**
 * The gate a run's roll-up implies: a failed journey fails; blocked and unreviewed results need a person.
 * A run that stopped without a failed journey, such as a browser runtime error, is no journey verdict.
 */
export function verdict(run: RunRollup | null | undefined): Verdict {
  if (run?.status === 'passed') return { status: 'passed' };
  const failed = (run?.results || []).find(result => result.status === 'failed');
  if (run?.status === 'failed' && failed) return { status: 'failed', reason: failed.error || run.error || 'A journey failed.' };
  return { status: 'needs-release', reason: RUN_REASONS[String(run?.status)] || run?.error || 'Journeys did not all pass.' };
}

const STATUSES: Partial<Record<GateStatus, [CommitState, string]>> = {
  'waiting-build': ['pending', 'Waiting for Build'],
  'build-failed': ['failure', 'Build did not pass'],
  rebuilding: ['pending', 'Running'],
  running: ['pending', 'Running'],
  passed: ['success', 'Passed'],
  failed: ['failure', 'Failed'],
  'needs-release': ['pending', 'Needs release'],
};

/** The GitHub commit status a gate reports; queued and superseded gates report nothing. */
export function commitStatus(gate: Pick<Gate, 'status' | 'context' | 'releasedBy'> | null | undefined): CommitStatus | null {
  if (gate?.status === 'released') return { state: 'success', context: gate.context, description: `Released by ${gate.releasedBy}` };
  const status = gate && STATUSES[gate.status];
  return status ? { state: status[0], context: gate.context, description: status[1] } : null;
}

export const sameStatus = (left: CommitStatus | null | undefined, right: CommitStatus | null | undefined) => Boolean(left && right) && (['state', 'context', 'description'] as const).every(key => left?.[key] === right?.[key]);

const newest = (a: Dated, b: Dated) => b.detectedAt.localeCompare(a.detectedAt) || b.updatedAt.localeCompare(a.updatedAt);

/** The gate a stage shows: the one at work, else its newest commit's. */
export function stageGate<G extends Dated>(gates: readonly G[]): G | null {
  return gates.find(gate => ACTIVE.includes(gate.status)) || gates.filter(gate => gate.status !== 'superseded').sort(newest)[0] || null;
}

/** The next gate to run: later stages first, so a commit leaves the pipeline before another enters it. */
export function nextGate<G extends Dated & Pick<Gate, 'stageId'>>(gates: readonly G[], sandboxIds: readonly string[]): G | null {
  return gates.filter(gate => PENDING.includes(gate.status) && sandboxIds.includes(gate.stageId))
    .sort((a, b) => sandboxIds.indexOf(b.stageId) - sandboxIds.indexOf(a.stageId) || newest(a, b))[0] || null;
}

/** Production is Ready for the newest commit that every Sandbox gate passed or released. */
export function productionReady(gates: readonly (Dated & Pick<Gate, 'stageId' | 'sha'>)[], sandboxIds: readonly string[]): { sha: string; status: 'ready' } | null {
  if (!sandboxIds.length) return null;
  const shas = [...new Set(gates.filter(gate => gate.status !== 'superseded').sort(newest).map(gate => gate.sha))];
  const sha = shas.find(value => sandboxIds.every(stageId => gates.some(gate => gate.stageId === stageId && gate.sha === value && PROMOTED.includes(gate.status))));
  return sha ? { sha, status: 'ready' } : null;
}
