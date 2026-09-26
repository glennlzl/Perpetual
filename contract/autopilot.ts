// Autopilot as the controller records it: GET /api/autopilot?repoPath= replies with an AutopilotView, GET /api/state
// carries the same view as `autopilot`, POST /api/autopilot/mode takes { repoPath, stageId, mode }, POST
// /api/autopilot/repair takes { repoPath, stageId, runId } for a failed run of the watched head, and POST
// /api/autopilot/stop takes { repoPath, stageId, id } for a change under way. The controller derives the view from its
// repairs (src/repair/view.ts) and the client reads it (client/src/lib/pipeline-autopilot.ts). Types only.

/** How a stage handles the changes Autopilot makes: merge them once verified, or open them and ask. */
export type AutopilotMode = 'merge' | 'ask';
/** A step is still to come, under way, done, failed, or waiting for a person. */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'waiting';
/** A piece of a step's detail: text, or a fact set in a mono chip, linked when it has an https address. */
export type DetailPart = string | { text: string; href?: string };
export interface ChangeStep { id: string; name: string; status: StepStatus; detail?: DetailPart[] }
/** A change is under way, merged, opened for a person's review, left unmerged, or passed: the failure cleared without a change, such as a rerun that passed. */
export type ChangeStatus = 'running' | 'merged' | 'passed' | 'needs-review' | 'not-merged';
/** A change Autopilot makes for a stage: a pull request and the steps that led to it. `title` names the work, such as Fixing build. */
export interface AutopilotChange {
  id: string; stageId: string; kind: string; title: string; status: ChangeStatus; steps: ChangeStep[];
  /** The commit the change is for, when it is one commit's, such as a build repair's failing commit. */
  sha?: string;
  pullRequest?: { number: number; url: string } | null; reason?: string; startedAt?: string; endedAt?: string;
}
/** A failed workflow run at the watched head, which a person may hand to Autopilot. */
export interface RepairableRun { id: string; name: string | null; path: string | null; url: string | null }
/**
 * A stage's Autopilot: its mode, its changes newest first, and the watched head's failed runs (`failed`, with the head's
 * commit) a person may hand to it while the head has no change under way or waiting with its pull request.
 */
export interface StageAutopilot { mode: AutopilotMode; changes: AutopilotChange[]; failed?: { sha: string; runs: RepairableRun[] } }
/** Every stage that carries Autopilot, by stage id; a stage without an entry shows nothing about it. */
export interface AutopilotView { repoPath?: string; stages?: Record<string, StageAutopilot>; watchError?: string }
