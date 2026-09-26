// Autopilot as the pipeline reads it (contract/autopilot.ts), derived from the repair manager's view: the Build stage
// carries each repair as one change with the five steps the interface shows, and its mode is the pipeline's auto-merge
// switch. Nothing here infers a state the manager did not record; the words are the interface's.
import type { AutopilotChange, AutopilotMode, AutopilotView, ChangeStatus, ChangeStep, DetailPart, StageAutopilot, StepStatus } from '../../contract/autopilot.ts';
import { short } from '../gate/rules.ts';
import { ACTIVE, retryable, type PublicRepair, type RepairView } from './manager.ts';

const MODES: readonly AutopilotMode[] = ['merge', 'ask'];
/** A mode from a request, checked as unknown. */
export function autopilotMode(value: unknown): AutopilotMode {
  if (!MODES.includes(value as AutopilotMode)) throw new Error('Choose Merge changes or Ask before merging.');
  return value as AutopilotMode;
}

const STEPS = [['failure', 'Read the failure'], ['diagnose', 'Diagnose'], ['change', 'Change'], ['verify', 'Verify'], ['merge', 'Merge']] as const;
/** What each rule-based diagnosis found, in the step's words. */
const CAUSES: Record<string, string> = {
  configuration: 'Credentials or permissions need a person', dependency: 'The manifest and lockfile disagree', build: 'The build does not compile',
  availability: 'A network or deadline error', 'test-regression': 'A test failed', unknown: 'The cause is not classified',
};
const chip = (text: string, href?: string | null): DetailPart => href ? { text, href } : { text };
const list = (parts: DetailPart[][], separator = ', ') => parts.flatMap((part, index) => index ? [separator, ...part] : part);
const money = (value: number) => `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
const words = (status: string) => status.replaceAll('-', ' ');
type Names = (stageId: string) => string;

// running while the manager works; merged; passed when the failure cleared without a change; a fix that waits for a
// person is under review, and one that ended without a fix, or whose pull request is closed, is not merged.
const changeStatus = (repair: PublicRepair): ChangeStatus => ACTIVE.includes(repair.status) ? 'running' : repair.status === 'merged' ? 'merged' : repair.status === 'flaky' ? 'passed'
  : repair.status === 'ready' || repair.status !== 'failed' && repair.pullRequest && !repair.pullRequest.closed ? 'needs-review' : 'not-merged';

// The step a repair is at: the ones before it are done, it is active or how the repair ended, the rest are pending.
function reached(repair: PublicRepair) {
  const { status } = repair;
  if (status === 'merged' || status === 'ready') return 4;
  if (status === 'verifying-ci' || status === 'verifying-gates') return 3;
  if (status === 'repairing') return 2;
  if (status === 'rerunning' || status === 'flaky') return 1;
  if (status === 'triaging') return 0;
  return repair.pullRequest ? 3 : repair.startedAt || repair.attempts?.length ? 2 : repair.category ? 1 : 0;
}

function details(repair: PublicRepair, names: Names): DetailPart[][] {
  const { status, pullRequest } = repair, attempts = repair.attempts ?? [], cause = repair.category ? CAUSES[repair.category] ?? repair.category : '';
  const pull = pullRequest ? chip(`#${pullRequest.number}`, pullRequest.url) : null;
  const change: DetailPart[][] = [], verify: DetailPart[][] = [];
  const last = attempts.at(-1), spent = attempts.reduce((total, attempt) => total + (attempt.cost ?? 0), 0);
  if (last) change.push([`Attempt ${last.number} with `, chip(last.model), ...(spent ? [', ', money(spent)] : [])]);
  if (pull) change.push(['pull request ', pull]);
  if (repair.holds?.length) change.push([`held: ${repair.holds.join(' ')}`]);
  if (pull && reached(repair) >= 3) verify.push(['CI on ', pull]);
  for (const gate of repair.gates ?? []) verify.push([chip(names(gate.stageId)), ` ${words(gate.status)} at `, chip(short(gate.sha))]);
  return [
    list(repair.runs.slice(0, 3).map(run => [chip(run.name || run.path || run.id, run.url), ' failed at ', chip(short(repair.sha))])),
    status === 'rerunning' ? [cause ? `${cause}: rerunning the failed jobs.` : 'Rerunning the failed jobs.'] : status === 'flaky' ? [cause ? `${cause}: the rerun passed.` : 'The rerun passed.'] : cause ? [`${cause}.`] : [],
    list(change),
    list(verify),
    status === 'merged' && repair.merged && pull ? ['Merged ', pull, ' into ', chip(repair.branch), ' as ', chip(short(repair.merged))] : status === 'merged' && repair.merged ? ['Merged as ', chip(short(repair.merged))] : [],
  ];
}

function steps(repair: PublicRepair, names: Names, reason: string | undefined): ChangeStep[] {
  const at = reached(repair), { status } = repair;
  const end: StepStatus = ACTIVE.includes(status) ? 'active' : status === 'merged' || status === 'flaky' ? 'done' : status === 'failed' ? 'failed' : 'waiting';
  const parts = details(repair, names);
  // Why a repair stopped is said at the step it stopped at.
  if ((end === 'waiting' || end === 'failed') && reason) parts[at] = [...parts[at], ...(parts[at].length ? [' '] : []), reason];
  return (status === 'flaky' ? STEPS.slice(0, 2) : STEPS).map(([id, name], index) => {
    const detail = parts[index], mark: StepStatus = index < at ? 'done' : index === at ? end : 'pending';
    return { id, name, status: mark, ...(detail.length ? { detail } : {}) };
  });
}

/** A repair as one change of the Build stage. */
export function repairChange(repair: PublicRepair, stageId: string, names: Names = id => id): AutopilotChange {
  const rerun = repair.category === 'availability' && (repair.status === 'rerunning' || repair.status === 'flaky');
  const reason = repair.reason ?? (repair.status === 'cancelled' ? 'Stopped.' : undefined);
  return {
    id: repair.id, stageId, kind: rerun ? 'rerun' : 'fix', title: rerun ? 'Rerunning build' : 'Fixing build', status: changeStatus(repair), steps: steps(repair, names, reason), sha: repair.sha,
    ...(repair.pullRequest ? { pullRequest: { number: repair.pullRequest.number, url: repair.pullRequest.url } } : {}), ...(reason ? { reason } : {}),
    startedAt: repair.createdAt, ...(repair.completedAt ? { endedAt: repair.completedAt } : {}),
  };
}

/**
 * The Build stage's Autopilot: only a managed GitHub source has one. Its mode is the auto-merge switch, its changes the
 * repairs, and the watched head's failed runs are offered for a person's Repair while the head has no repair under way
 * or waiting with its pull request.
 */
export function autopilotStages(view: RepairView, stageId: string | null, names: Names = id => id): Record<string, StageAutopilot> {
  if (!stageId || view.autoMerge === undefined) return {};
  const { head } = view, current = head && view.repairs.find(repair => repair.sha === head.sha);
  const runs = head && (!current || retryable(current.status)) ? head.failed : [];
  return { [stageId]: { mode: view.autoMerge ? 'merge' : 'ask', changes: view.repairs.map(repair => repairChange(repair, stageId, names)), ...(head ? { failed: { sha: head.sha, runs } } : {}) } };
}

/** GET /api/autopilot, and the state's autopilot field. */
export function autopilotView(view: RepairView, { repoPath, stageId, stages = [] }: { repoPath: string; stageId: string | null; stages?: readonly { id: string; name: string }[] }): AutopilotView {
  const names: Names = id => stages.find(stage => stage.id === id)?.name ?? id;
  return { repoPath, stages: autopilotStages(view, stageId, names), ...(view.watchError ? { watchError: view.watchError } : {}) };
}
