/** The saved pipeline definition. Environment readiness and journey verdicts are separate records. */
export type StageKind = 'source' | 'build' | 'production' | 'sandbox';
export interface Stage { id: string; name: string; kind: StageKind; collapsed: boolean; githubWorkflow?: string | null }
export interface Transition { id: string; source: string; target: string; blocked: boolean; reason: string }
export interface Pipeline { repoPath: string; stages: Stage[]; transitions: Transition[] }
/** POST /api/pipeline/action returns the definition after the saved change. */
export interface PipelineActionReply { pipeline: Pipeline }
