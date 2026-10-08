// Read-only evidence for autonomous recovery. No secret values are requested or retained.
import { createHash } from 'node:crypto';
import { githubFailureKind, isRepository, runGitHub, type GitHubRun } from '../github-cli.ts';
import { secretName } from './recovery.ts';
import type { RecoveryRun } from '../../contract/build-recovery.ts';

export interface CredentialBinding { runId: string; name: string; scope: 'repository' | 'environment' | 'organization' | 'missing'; environment: string | null; updatedAt?: string }
export type CredentialSnapshot = { revision: string; ready?: boolean; reason?: string; bindings?: CredentialBinding[] } | { reason: string };
export interface CredentialInput { repository: string; runs: RecoveryRun[] }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Resolve environment > repository > organization using complete metadata lists. A denied list proves nothing. */
export async function readRecoveryCredentials({ repository, runs }: CredentialInput, { run }: { run?: GitHubRun } = {}): Promise<CredentialSnapshot> {
  if (!isRepository(repository) || !runs.length || runs.length > 20 || runs.some(ref => ref.binding !== 'references' || !ref.secrets.length || ref.secrets.length > 20 || !ref.secrets.every(secretName) || ref.environment !== null && (!ref.environment || ref.environment.length > 255 || ref.environment.includes('${{')))) {
    return { reason: 'The workflow credential source is unverified. Automatic recovery is waiting for run evidence.' };
  }
  const lists = new Map<string, Promise<Map<string, string>>>();
  function list(path: string): Promise<Map<string, string>> {
    let pending = lists.get(path);
    if (!pending) {
      pending = (async () => {
        const secrets = new Map<string, string>();
        for (let page = 1; page <= 10; page++) {
          const { stdout } = await runGitHub(['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `${path}?per_page=100&page=${page}`], { run, timeout: 15000, maxBuffer: 256 * 1024 });
          const value: unknown = JSON.parse(stdout);
          if (!record(value) || !Number.isSafeInteger(value.total_count) || Number(value.total_count) < 0 || Number(value.total_count) > 1000 || !Array.isArray(value.secrets) || value.secrets.length > 100) throw new Error('Unreadable secret metadata.');
          for (const secret of value.secrets) {
            if (!record(secret) || !secretName(secret.name) || !date(secret.updated_at) || secrets.has(secret.name.toUpperCase())) throw new Error('Unreadable secret metadata.');
            secrets.set(secret.name.toUpperCase(), secret.updated_at);
          }
          if (secrets.size === value.total_count) return secrets;
          if (!value.secrets.length || secrets.size > Number(value.total_count)) throw new Error('Incomplete secret metadata.');
        }
        throw new Error('Incomplete secret metadata.');
      })();
      lists.set(path, pending);
    }
    return pending;
  }
  try {
    const bindings: string[] = [];
    const resolved: CredentialBinding[] = [];
    let ready = true;
    for (const ref of runs) {
      const scopes = [...(ref.environment ? [`repos/${repository}/environments/${encodeURIComponent(ref.environment)}/secrets`] : []), `repos/${repository}/actions/secrets`, `repos/${repository}/actions/organization-secrets`];
      for (const name of [...new Set(ref.secrets.map(name => name.toUpperCase()))].sort()) {
        let found = false;
        for (const scope of scopes) {
          const updatedAt = (await list(scope)).get(name);
          if (!updatedAt) continue;
          bindings.push(JSON.stringify([ref.id, name, scope, updatedAt]));
          resolved.push({ runId: ref.id, name, scope: scope.includes('/environments/') ? 'environment' : scope.endsWith('/organization-secrets') ? 'organization' : 'repository', environment: ref.environment, updatedAt });
          found = true; break;
        }
        if (!found) { bindings.push(JSON.stringify([ref.id, name, 'missing'])); resolved.push({ runId:ref.id, name, scope:'missing', environment:ref.environment }); ready = false; }
      }
    }
    return { revision: createHash('sha256').update(bindings.sort().join('\n')).digest('hex'), bindings: resolved, ...(ready ? {} : { ready: false, reason: 'A workflow credential is missing. Recovery continues automatically when it becomes available.' }) };
  } catch (error) {
    const kind = githubFailureKind(error);
    return { reason: kind === 'denied' || kind === 'not-found' || kind === 'unauthenticated'
      ? 'GitHub did not allow credential metadata checks. Automatic recovery is still watching the original workflow.'
      : 'Credential updates could not be checked. Perpetual will check again automatically.' };
  }
}
