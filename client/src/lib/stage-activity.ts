// Stage motion derives only from controller records: environment lifecycle,
// browser preparation and runs, and confirmed stage removal.
import type { BrowserRun } from './browser-test-ui.ts';
import type { BrowserPreparation, Environment, StageRemoval } from './test-workspace.ts';

/** The controller records stage motion reads: a workspace snapshot, or the part of it a view holds. */
export interface ActivitySnapshot {
  environments?: Pick<Environment, 'stageId' | 'status'>[]; stageRemovals?: Pick<StageRemoval, 'stageId' | 'status'>[];
  browserTests?: Record<string, { runs?: Pick<BrowserRun, 'mode' | 'status'>[]; preparation?: Pick<BrowserPreparation, 'status'> | null } | undefined>;
}
export type StageActivity = 'removing' | 'provisioning' | 'testing' | 'discovering';

const PROVISIONING = ['queued', 'creating', 'preparing'];
const activeRun = (run: Pick<BrowserRun, 'status'> | null | undefined) => ['queued', 'running'].includes(run?.status ?? '');

export const environmentWorking = (status: string | undefined) => [...PROVISIONING, 'destroying'].includes(status ?? '');
export const environmentProvisioning = (status: string | undefined) => PROVISIONING.includes(status ?? '');
export const browserRunActive = activeRun;

export function stageActivity(stage: { id: string; kind: string } | null | undefined, snapshot: ActivitySnapshot = {}): StageActivity | null {
  if (stage?.kind !== 'sandbox') return null;
  const environments = (snapshot.environments || []).filter(item => item.stageId === stage.id);
  const tests = snapshot.browserTests?.[stage.id];
  const runs = (tests?.runs || []).filter(activeRun);
  if ((snapshot.stageRemovals || []).some(item => item.stageId === stage.id && ['queued', 'removing'].includes(item.status))
    || environments.some(item => item.status === 'destroying')) return 'removing';
  if (environments.some(item => PROVISIONING.includes(item.status))) return 'provisioning';
  if (runs.some(run => run.mode === 'run')) return 'testing';
  if (runs.some(run => run.mode === 'discover') || ['preparing', 'discovering'].includes(tests?.preparation?.status ?? '')) return 'discovering';
  return null;
}
