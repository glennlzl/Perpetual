// The deployments GitHub records for the current commit, read through
// /api/github/deployments. A record for another commit never describes the current source.
import { createGitHubPoller, type GitHubPollerOptions } from './pipeline-github.ts';

// The shapes are the controller's contract (contract/github.ts): GET /api/github/deployments as the controller replies.
import type { CommitDeployments, DeploymentRecord } from '../../../contract/github.ts';
import type { ScanNode, DeploymentGroup } from '../../../contract/scanner.ts';
export type GitHubDeployment = DeploymentRecord;
export type GitHubDeployments = CommitDeployments;
export type DeploymentMark = 'deploying' | 'queued' | 'deployed' | 'failed' | 'inactive';
export const DEPLOYMENT_MARK_LABELS: Record<DeploymentMark, string> = { deploying: 'Deploying', queued: 'Queued', deployed: 'Deployed', failed: 'Failed', inactive: 'Inactive' };
const MARKS: Record<string, DeploymentMark> = { pending: 'queued', queued: 'queued', in_progress: 'deploying', success: 'deployed', failure: 'failed', error: 'failed', inactive: 'inactive' };

export const deploymentMark = (deployment: Pick<GitHubDeployment, 'state'> | null | undefined): DeploymentMark | null => MARKS[String(deployment?.state)] || null;
export const deploymentsActive = (result: GitHubDeployments | null | undefined) => (result?.deployments || []).some(item => ['queued', 'deploying'].includes(String(deploymentMark(item))));
/** The repository's deployments on GitHub, when it holds older records for the commit than the reply carries; else null. */
export const moreDeployments = (result: GitHubDeployments | null | undefined) => result?.more ? `https://github.com/${result.repository.split('/').map(encodeURIComponent).join('/')}/deployments` : null;

/** A Production target as the delivery projection supplies it. */
export type DiscoveredTarget = Pick<ScanNode, 'id'> & Partial<Pick<ScanNode, 'kind' | 'provider' | 'label'>>;
/** A Production row for a recorded deployment, beside the targets discovery found. */
export interface RecordedDeployment { id: string; kind: 'github-deployment'; provider: string; label: string; deployment: GitHubDeployment }
/** A provider's group of Production rows: discovered targets and recorded deployments. */
export type DeploymentGroupRow<T extends DiscoveredTarget = DiscoveredTarget> = DeploymentGroup<T | RecordedDeployment>;
const isGroup = <T extends DiscoveredTarget>(row: T | DeploymentGroupRow<T>): row is DeploymentGroupRow<T> => row.kind === 'deployment-group' && Array.isArray((row as DeploymentGroupRow<T>).deployments);
export const isRecordedDeployment = (row: DiscoveredTarget | RecordedDeployment): row is RecordedDeployment => row.kind === 'github-deployment' && 'deployment' in row;

// Recorded deployments join the provider group discovery supplied, or form one after
// them; nothing supplied is removed or reordered. GitHub lists records newest first,
// so one row per environment keeps its newest record.
export function productionRows<T extends DiscoveredTarget>(rows: readonly (T | DeploymentGroupRow<T>)[], result: GitHubDeployments | null | undefined, sha: string | null | undefined): readonly (T | DeploymentGroupRow<T>)[] {
  const deployments = result && sha && result.sha === sha ? result.deployments || [] : [];
  if (!deployments.length) return rows;
  const groups = new Map<string, DeploymentGroupRow<T>>();
  const next = rows.map(row => {
    if (!isGroup(row)) return row;
    const copy = { ...row, deployments: [...row.deployments] };
    groups.set(copy.provider.toLowerCase(), copy);
    return copy;
  });
  const seen = new Set<string>();
  for (const deployment of deployments) {
    const provider = deployment.provider.toLowerCase(), key = `${provider}\n${deployment.environment.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let group = groups.get(provider);
    if (!group) {
      group = { id: `deployment-provider:${encodeURIComponent(provider)}`, kind: 'deployment-group', provider: deployment.provider, label: deployment.provider, deployments: [] };
      groups.set(provider, group);
      next.push(group);
    }
    group.deployments.push({ id: `github-deployment:${deployment.id}`, kind: 'github-deployment', provider: deployment.provider, label: deployment.environment, deployment });
  }
  return next;
}

// A changed GitHub connection reads the recorded deployments again at once.
const listeners = new Set<() => void>();
export const deploymentChanges = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  notify() { listeners.forEach(listener => listener()); },
};
export function createGitHubDeploymentsPoller({ repoPath, ...options }: Omit<GitHubPollerOptions<GitHubDeployments>, 'path' | 'active'> & { repoPath: string }) {
  return createGitHubPoller<GitHubDeployments>({ ...options, path: `/api/github/deployments?${new URLSearchParams({ repoPath })}`, active: deploymentsActive });
}
