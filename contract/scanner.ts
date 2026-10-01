export interface GitHubActionsEntry { id: 'github-actions'; kind: 'github-actions'; provider: 'GitHub'; label: 'GitHub Actions' }
export interface DeploymentGroup<N> { id: string; kind: 'deployment-group'; provider: string; label: string; deployments: N[] }
export type ProductionEntry<N> = DeploymentGroup<N> | N;
/** Build holds the workflow runner; Production holds the deployment targets the repository configures. */
export interface Delivery<N> { version: 2; source: N[]; build: GitHubActionsEntry[]; production: ProductionEntry<N>[] }

/** Repository evidence returned by scans and controller/source replies. Configuration is not live verification. */
export type Confidence = 'configured' | 'inferred';
export interface Evidence { file: string; line?: number; summary: string }
export interface ScanNode {
  id: string; label: string; kind: string; provider: string | null; status: string; detail: string; evidence: Evidence[];
  projectName?: string | null; previewAlias?: string; deployBranches?: string[]; configFile?: string | null;
}
export interface ScanEdge { source: string; target: string; label: string; confidence: Confidence }
export interface ScanService { id: string; name: string; path: string; framework: string; provider: string | null; commands: Record<string, string> }
export interface ScanWorkflowJob { id: string; name: string; needs: string[] }
export interface ScanWorkflow { file: string; name: string; triggers: string[]; jobs: ScanWorkflowJob[] }
export interface ScanRepo { name: string; path: string; branch: string | null; sha: string | null; remote: string | null }
export interface ScanPlan { summary: string; steps: string[]; workflow?: string }
export interface Scan {
  discoveryVersion: number; repo: ScanRepo; nodes: ScanNode[]; edges: ScanEdge[]; services: ScanService[]; workflows: ScanWorkflow[];
  warnings: string[]; plan: ScanPlan; scannedAt: string; delivery: Delivery<ScanNode>;
}
export interface PreviewPlan { title: string; steps: string[]; workflow?: string }
