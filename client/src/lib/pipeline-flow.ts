import { browserRunActive, environmentProvisioning, type ActivitySnapshot } from './stage-activity.ts';
import { gateActive, type GateView } from './stage-gate.ts';
import type { Environment } from './test-workspace.ts';

export type FlowEnvironment = Pick<Environment, 'status' | 'sourceRevision'> & Partial<Pick<Environment, 'sourceBranch' | 'repair'>>;

// Edge motion maps to real work only: a current-commit GitHub run feeding
// Build, provisioning and browser runs in a sandbox fed directly by
// Build, or a journey gate rebuilding or running at a sandbox. Only a
// gate carries a commit from one sandbox to the next; otherwise a
// sandbox-to-sandbox edge never flows and that stage's card ring carries its activity.
export function transitionFlow(edge: { source: string; target: string; blocked?: boolean }, { stages = [], snapshot = {}, build = null, latest = {}, sha = null, gates = null }: { stages?: { id: string; kind: string }[]; snapshot?: ActivitySnapshot; build?: { status: string } | null; latest?: Record<string, FlowEnvironment | undefined>; sha?: string | null; gates?: GateView | null } = {}): 'active' | 'behind' | null {
  if (edge.blocked) return null;
  const source = stages.find(stage => stage.id === edge.source), target = stages.find(stage => stage.id === edge.target);
  if (!target || target.kind === 'production') return null;
  if (target.kind === 'build') return source?.kind === 'source' && ['running', 'queued'].includes(build?.status ?? '') ? 'active' : null;
  if (target.kind !== 'sandbox') return null;
  if (gateActive(gates?.stages?.[target.id])) return 'active';
  if (source?.kind === 'build' && ((snapshot.environments || []).some(item => item.stageId === target.id && environmentProvisioning(item.status))
    || (snapshot.browserTests?.[target.id]?.runs || []).some(browserRunActive))) return 'active';
  return environmentBehind(latest[target.id], sha) ? 'behind' : null;
}

// A twin a repair's journey gate built runs its pull request head, which is never behind the scanned commit. A twin of an
// earlier checkout of the source, such as one built before a branch switch, is the stage's twin until Create replaces it,
// behind when it runs another commit.
export const environmentBehind = (environment: FlowEnvironment | null | undefined, sha: string | null | undefined) => Boolean(environment?.status === 'ready' && !environment.repair && environment.sourceRevision && sha && environment.sourceRevision !== sha);
/** A behind twin's short commit and the scanned one, each with its branch when the twin was built from another branch. */
export function behindCommits(environment: FlowEnvironment, sha: string, branch: string | null | undefined) {
  const named = Boolean(environment.sourceBranch && branch && environment.sourceBranch !== branch);
  const at = (name: string | null | undefined, commit: string | null | undefined) => [named ? name : '', commit?.slice(0, 7)].filter(Boolean).join(' · ');
  return `${at(environment.sourceBranch, environment.sourceRevision)} → ${at(branch, sha)}`;
}
/** The branch and short commit of the pull request head a ready repair twin runs; empty for any other environment. */
export const repairHead = (environment: FlowEnvironment | null | undefined) => environment?.status === 'ready' && environment.repair
  ? [environment.sourceBranch, environment.sourceRevision?.slice(0, 7)].filter(Boolean).join(' · ') : '';

// Keyed by environment id + updatedAt, so a transition flashes once per observation.
export function readyArrivals(seen: Map<string, string> | null | undefined, environments: Pick<Environment, 'id' | 'stageId' | 'status' | 'updatedAt'>[] = []) {
  const next = new Map<string, string>(), arrived: { stageId: string; key: string }[] = [];
  for (const item of environments) {
    next.set(item.id, item.status);
    if (seen && environmentProvisioning(seen.get(item.id)) && item.status === 'ready') arrived.push({ stageId: item.stageId, key: `${item.id}:${item.updatedAt}` });
  }
  return { seen: next, arrived };
}

export function shallowEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left), a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && a[key] === b[key]);
}
