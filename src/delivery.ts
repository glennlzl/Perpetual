import type { GitHubActionsEntry, DeploymentGroup, ProductionEntry, Delivery } from '../contract/scanner.ts';
export type { GitHubActionsEntry, DeploymentGroup, ProductionEntry, Delivery } from '../contract/scanner.ts';

const PROVIDERS = new Map([
  ['github', 'GitHub'],
  ['vercel', 'Vercel'],
  ['railway', 'Railway'],
]);

// Saved scans may predate the current discovery shape, so every field is checked before use.
export interface DeliveryNode { id?: unknown; kind?: unknown; provider?: unknown }
export interface DeliveryScan { nodes?: readonly (DeliveryNode | null | undefined)[]; workflows?: unknown }
type NodeOf<S extends DeliveryScan> = NonNullable<NonNullable<S['nodes']>[number]>;
export type WithDelivery<S extends DeliveryScan> = S & { delivery: Delivery<NodeOf<S>> };

function knownProvider(value: unknown) {
  return typeof value === 'string' ? PROVIDERS.get(value.trim().toLowerCase()) : undefined;
}

export function withDeliveryGraph<S extends DeliveryScan>(scan: S): WithDelivery<S>;
export function withDeliveryGraph<S extends DeliveryScan>(scan: S | null | undefined): WithDelivery<S> | null | undefined;
export function withDeliveryGraph<S extends DeliveryScan>(scan: S | null | undefined): WithDelivery<S> | null | undefined {
  type N = NodeOf<S>;
  if (scan == null) return scan;
  const nodes: readonly (N | null | undefined)[] = Array.isArray(scan.nodes) ? scan.nodes : [];
  const source = nodes.filter((node): node is N => node?.kind === 'repository');
  const build: GitHubActionsEntry[] = [], production: ProductionEntry<N>[] = [];
  const hasGitHub = (Array.isArray(scan.workflows) && scan.workflows.length > 0) ||
    nodes.some(node => node?.kind === 'workflow' || node?.kind === 'job') ||
    source.some(node => knownProvider(node.provider) === 'GitHub');
  if (hasGitHub) build.push({ id: 'github-actions', kind: 'github-actions', provider: 'GitHub', label: 'GitHub Actions' });

  const deployments = nodes.filter((node): node is N => node?.kind === 'deployment');
  const seen = new Set<unknown>();
  const groups = new Map<string, DeploymentGroup<N>>();
  // Running a workflow never replaces a deployment target: retain each target once.
  for (const deployment of deployments) {
    const identity = typeof deployment.id === 'string' ? deployment.id : deployment;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const provider = knownProvider(deployment.provider);
    if (!provider) {
      production.push(deployment);
      continue;
    }
    let group = groups.get(provider);
    if (!group) {
      group = { id: `deployment-provider:${encodeURIComponent(provider.toLowerCase())}`, kind: 'deployment-group', provider, label: provider, deployments: [] };
      groups.set(provider, group);
      production.push(group);
    }
    group.deployments.push(deployment);
  }

  // Application packages stay in the scan. Only workflow runners belong to Build, and only
  // discovered deployment targets to Production; an unbound service is neither.
  return { ...scan, delivery: { version: 2, source, build, production } };
}
