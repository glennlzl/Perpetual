import type { Environment } from './test-workspace';

const ACTIVE = ['queued', 'creating', 'preparing', 'ready', 'destroying', 'cleanup_failed'];
const STATUS: Record<string, string> = { queued: 'Queued', creating: 'Creating', preparing: 'Preparing', ready: 'Ready', failed: 'Failed', destroying: 'Deleting', destroyed: 'Deleted', cleanup_failed: 'Cleanup failed' };

export const environmentStatusLabel = (status: string | undefined) => (status && STATUS[status]) || status || 'Not provisioned';
export const environmentHasResources = (item: Environment | null | undefined) => Boolean(item && item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt)));
export function latestEnvironment(environments: Environment[] = [], stageId?: string) {
  const items = environments.filter(item => !stageId || item.stageId === stageId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return items.find(item => ACTIVE.includes(item.status) || environmentHasResources(item)) || items[0] || null;
}
