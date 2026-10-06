import type { Scan } from './scanner.ts';
import type { GitHubSource } from './github.ts';
import type { Environment, StageRemoval } from './environment.ts';
import type { BrowserSummaryReply } from './browser.ts';
import type { AutopilotView } from './autopilot.ts';

/** The saved pipeline definition. Environment readiness and journey verdicts are separate records. */
export type StageKind = 'source' | 'build' | 'production' | 'sandbox';
export interface Stage { id: string; name: string; kind: StageKind; collapsed: boolean; githubWorkflow?: string | null }
export interface Transition { id: string; source: string; target: string; blocked: boolean; reason: string }
export interface Pipeline { repoPath: string; stages: Stage[]; transitions: Transition[] }
/** POST /api/pipeline/action returns the definition after the saved change. */
export interface PipelineActionReply { pipeline: Pipeline }
/**
 * GET /api/state: current source summaries. Private manager state and credentials are excluded. Whether a model and the
 * browser runtime are ready is GET /api/settings/model's and the stage's browser view's to say.
 */
export interface PipelineStateReply {
  scan: Scan | null; defaultRepo: string; pipeline: Pipeline | null; source?: GitHubSource | null;
  pipelines: Record<string, Pipeline>; githubConnection?: { login: string; connectedAt: string } | null;
  environments: Environment[]; stageRemovals: StageRemoval[]; browserTests: Record<string, BrowserSummaryReply>; autopilot: AutopilotView | null;
}
/** POST /api/source/github replies after the source and its pipeline are durably saved. */
export interface SourceReply { scan: Scan; source: GitHubSource; pipeline: Pipeline }
