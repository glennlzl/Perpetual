/** An explicitly configured GitHub deployment handler and its destination. */
export interface ReleaseTarget { environment: string; productionEnvironment: boolean; workflowPath: string }
export type ReleaseStatus = 'requesting' | 'unknown' | 'queued' | 'deploying' | 'deployed' | 'failed' | 'inactive';
/** A request and the deployment provider's reported outcome, never a gate verdict. */
export interface ReleaseRecord {
  id: string; sha: string; environment: string; productionEnvironment: boolean; workflowPath: string;
  status: ReleaseStatus; createdAt: string; updatedAt: string;
  deploymentId?: string; statusId?: string; url?: string; logUrl?: string; error?: string;
}
export interface ReleaseView {
  sha: string | null; target: ReleaseTarget | null; canDeploy: boolean; blockedReason: string | null;
  /** The newest request for this commit and target: one still standing or deployed, else the latest attempt. */
  current: ReleaseRecord | null;
  /** An unresolved request of this repository and branch other than current, such as an earlier commit's: it blocks Deploy until it ends. */
  unresolved: ReleaseRecord | null;
  recent: ReleaseRecord[];
}
export interface ReleaseReply extends ReleaseView { repoPath: string }
