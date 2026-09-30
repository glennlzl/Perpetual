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

export interface DeploymentStatus { state: string | null; stateAt: string | null; url: string | null; logUrl: string | null }
/** One deployment GitHub records for the scanned commit, as the app that created it reported it. */
export interface DeploymentRecord extends DeploymentStatus {
  id: string; environment: string; provider: string; creator: string | null; production: boolean | null; transient: boolean | null;
  ref: string | null; task: string | null; createdAt: string | null; updatedAt: string | null;
}
/** GET /api/github/deployments: the deployments GitHub records for the scanned commit. */
export interface CommitDeployments { repository: string; sha: string | null; deployments: DeploymentRecord[] }
