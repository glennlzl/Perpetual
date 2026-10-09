// Public GitHub source, connection and evidence replies. Private CLI output and credentials never join these types.

export interface GitHubAccount { login: string; name: string | null }
/** POST /api/source/github: creation confirms branch as the Production branch and initial source; ordinary saves only change the viewed source. */
export interface GitHubSourceSelection { repository: string; branch: string; rootDirectory: string; createPipeline?: boolean }
/**
 * A verified CLI account is present exactly when the session is authenticated. An unreachable session is one GitHub did
 * not answer for now, which says nothing about the account; its message names why.
 */
export type GitHubSession = { available: boolean; authenticated: true; account: GitHubAccount; message?: undefined; unreachable?: undefined }
  | { available: boolean; authenticated: false; account: null; message?: string; unreachable?: true };
/** A saved source or a local checkout's detected remote; older/local projections omit managed-copy fields. */
export interface GitHubSource {
  repository: string; branch?: string | null; rootDirectory?: string | null; scanPath?: string | null;
  checkoutPath?: string; sha?: string | null; connectedAccount?: string; savedAt?: string;
}
/**
 * GET /api/github/connection and POST connect/disconnect. Only GET includes the original local checkout. unreachable
 * marks a connection this instance holds that GitHub could not verify for now: not connected, and not disconnected.
 */
export type GitHubConnection = (
  | (Extract<GitHubSession, { authenticated: true }> & { connected: true })
  | (GitHubSession & { connected: false })
) & { source: GitHubSource | null; localCheckout?: { path: string; branch: string | null } | null };
export interface GitHubRepositoryChoice { fullName: string; name: string | null; private: boolean; defaultBranch: string | null }
export interface GitHubRepositoryPage { repositories: GitHubRepositoryChoice[]; nextPage: number | null }
export interface GitHubBranch { name: string }
export interface GitHubBranchPage { branches: GitHubBranch[]; nextPage: number | null; defaultBranch: string | null }
export type SignInStatus = 'starting' | 'pending' | 'complete' | 'error' | 'expired' | 'cancelled';
/** POST /api/github/auth/start, status and cancel expose this snapshot, never the login process's output. */
export interface SignInSnapshot {
  id: string; status: SignInStatus; userCode: string | null; verificationUrl: string | null;
  expiresAt: string; account: GitHubAccount | null; error: string | null;
}
/** GET /api/github-actions: declared workflow rails, separate from actual workflow run evidence. */
export interface ActionStep { id: string; name: string }
export interface ActionJob { id: string; name: string; steps: ActionStep[] }
export interface ActionWorkflow { file: string; name: string; jobs: ActionJob[]; error?: string }
export interface GitHubActionsReply { workflows: ActionWorkflow[] }

// What the controller reads from GitHub for the scanned commit, as GET /api/github/runs and
// GET /api/github/deployments reply with it. The controller implements these shapes
// (src/github-runs.ts, src/github-deployments.ts) and the client reads them
// (client/src/lib/pipeline-github.ts, client/src/lib/pipeline-deployments.ts). Types only.

export interface RunState { status: string | null; conclusion: string | null }
export interface WorkflowStep extends RunState { number: number | null; name: string }
export interface WorkflowJob extends RunState { id: string; name: string; startedAt: string | null; completedAt: string | null; url: string | null; steps: WorkflowStep[] }
export interface WorkflowRun extends RunState {
  id: string; workflowId: string | null; name: string | null; path: string | null; event: string | null; attempt: number; sha: string; branch: string | null; url: string | null;
  createdAt: string | null; startedAt: string | null; updatedAt: string | null; jobs: WorkflowJob[] | null;
}
/** GET /api/github/runs: the Actions runs GitHub holds for the scanned commit. */
export interface CommitRuns { repository: string; sha: string | null; runs: WorkflowRun[] }
/** GET /api/github/build: one current branch Build, independent of the pinned source scan. */
export interface BuildReply extends CommitRuns {
  repoPath: string; branch: string | null; scannedSha: string | null; source: 'watched' | 'scanned';
}

export interface DeploymentStatus { state: string | null; stateAt: string | null; url: string | null; logUrl: string | null }
/** One deployment GitHub records for the scanned commit, as the app that created it reported it. */
export interface DeploymentRecord extends DeploymentStatus {
  id: string; environment: string; provider: string; creator: string | null; production: boolean | null; transient: boolean | null;
  ref: string | null; task: string | null; createdAt: string | null; updatedAt: string | null;
}
/**
 * GET /api/github/deployments: the deployments GitHub records for the scanned commit, newest first. more: GitHub holds
 * older records for the commit than the newest 1,000 read.
 */
export interface CommitDeployments { repository: string; sha: string | null; deployments: DeploymentRecord[]; more?: true }
