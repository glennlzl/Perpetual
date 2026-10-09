import { parse } from 'yaml';
import type { BuildRecovery, RecoveryRun } from '../../contract/build-recovery.ts';
import { isRepository, SHA } from '../github-cli.ts';
import { redact } from '../redaction.ts';
import type { GitHubFailure } from './github.ts';
import type { RepairRun } from './manager.ts';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string => text(value) && /^\d{1,20}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const secretName = (value: unknown): value is string => text(value) && /^[A-Za-z_][A-Za-z\d_]{0,99}$/.test(value);
export const workflowPath = (value: unknown): value is string => text(value) && /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(value);
const statics = (value: unknown): value is string => text(value) && value.length > 0 && value.length <= 255 && !value.includes('${{');

/** Conservative configuration tracing: dynamic jobs, reusable workflows and expressions remain unknown. */
export function credentialReferences(yaml: string, failures: GitHubFailure['jobs']): Pick<RecoveryRun, 'secrets' | 'environment' | 'binding' | 'vercelSecret'> {
  const unknown = { secrets: [], environment: null, binding: 'unknown' } as const;
  let value: unknown;
  try { value = yaml.length <= 256 * 1024 ? parse(yaml, { maxAliasCount: 20 }) : null; } catch { return { ...unknown, secrets: [] }; }
  if (!record(value) || !record(value.jobs)) return { ...unknown, secrets: [] };
  const failed = failures.filter(job => job.conclusion === 'failure');
  if (!failed.length) return { ...unknown, secrets: [] };
  const definitions: Record<string, unknown>[] = [];
  for (const job of failed) {
    const matches = Object.entries(value.jobs).filter(([key, definition]) => record(definition) && !definition.uses && !definition.strategy &&
      (definition.name === undefined ? key === job.name : statics(definition.name) && definition.name === job.name));
    if (matches.length !== 1) return { ...unknown, secrets: [] };
    definitions.push(matches[0][1] as Record<string, unknown>);
  }
  const environments = definitions.map(job => record(job.environment) ? job.environment.name : job.environment);
  if (environments.some(env => env !== undefined && !statics(env)) || new Set(environments).size > 1) return { ...unknown, secrets: [] };
  const names = new Set<string>();
  const vercel = new Set<string>();
  function visit(value: unknown) {
    if (text(value)) for (const match of value.matchAll(/\$\{\{\s*secrets(?:\.([A-Za-z_][A-Za-z\d_]*)|\[['"]([A-Za-z_][A-Za-z\d_]*)['"]\])\s*\}\}/g)) {
      const name = match[1] || match[2];
      if (secretName(name) && name.toUpperCase() !== 'GITHUB_TOKEN') names.add(name);
    }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (record(value)) Object.values(value).forEach(visit);
  }
  // Only the failed step's effective environment and inputs, never unrelated jobs or successful steps.
  for (let index = 0; index < definitions.length; index++) {
    const job = definitions[index], steps = Array.isArray(job.steps) ? job.steps.filter(record) : [];
    for (const name of failed[index].failedSteps) {
      const matches = steps.filter(step => step.name === name || step.name === undefined && text(step.run) && name === `Run ${step.run.trim().split('\n')[0]}`);
      if (matches.length !== 1) continue;
      const step = matches[0];
      const env = { ...(record(value.env) ? value.env : {}), ...(record(job.env) ? job.env : {}), ...(record(step.env) ? step.env : {}) };
      visit(env);
      const reference = text(env.VERCEL_TOKEN) ? /^\$\{\{\s*secrets(?:\.([A-Za-z_][A-Za-z\d_]*)|\[['"]([A-Za-z_][A-Za-z\d_]*)['"]\])\s*\}\}$/.exec(env.VERCEL_TOKEN) : null;
      if (reference) vercel.add(reference[1] || reference[2]);
      visit(step.with);
      visit(step.run);
    }
  }
  return { secrets: [...names].slice(0, 20), environment: statics(environments[0]) ? redact(environments[0]) : null, binding: names.size ? 'references' : 'unknown', ...(vercel.size === 1 && names.has([...vercel][0]) ? { vercelSecret: [...vercel][0] } : {}) };
}

export async function recoveryFor(input: { repository: string; sha: string; runs: RepairRun[]; failures: GitHubFailure[] },
  workflow?: (input: { repository: string; sha: string; path: string }) => Promise<string>): Promise<BuildRecovery> {
  if (!isRepository(input.repository) || !SHA.test(input.sha)) throw new Error('Invalid recovery source.');
  const runs: RecoveryRun[] = [];
  for (const run of input.runs.slice(0, 20)) {
    const failure = input.failures.find(failure => failure.runId === run.id);
    if (failure?.diagnosis.category !== 'configuration') continue;
    const path = run.path?.split('@')[0];
    let binding: Pick<RecoveryRun, 'secrets' | 'environment' | 'binding' | 'vercelSecret'> = { secrets: [], environment: null, binding: 'unknown' };
    if (workflow && workflowPath(path)) {
      try { binding = credentialReferences(await workflow({ repository: input.repository, sha: input.sha, path }), failure.jobs); }
      catch { /* An unavailable configuration is a gap, not an authentication diagnosis. */ }
    }
    runs.push({ id: run.id, attempt: run.attempt, name: redact(run.name || 'Workflow'), workflow: workflowPath(path) ? path : null,
      url: `https://github.com/${input.repository}/actions/runs/${run.id}`, observedAt: failure.observedAt, ...binding,
      settingsUrl: `https://github.com/${input.repository}/settings/${binding.environment ? 'environments' : 'secrets/actions'}` });
  }
  return { status: 'required', runs, requests: [] };
}

/** State remains bounded and contains references only. Old repair records need no migration or external writes. */
export function validRecovery(value: unknown): value is BuildRecovery {
  return record(value) && ['required', 'verifying', 'unconfirmed', 'passed'].includes(String(value.status)) &&
    (value.credentialRevision === undefined || text(value.credentialRevision) && /^[a-f0-9]{64}$/.test(value.credentialRevision)) &&
    (value.automation === undefined || record(value.automation) && ['watching', 'unavailable'].includes(String(value.automation.status)) && (value.automation.reason === undefined || text(value.automation.reason) && value.automation.reason.length <= 500)) &&
    (value.checkedAt === undefined || text(value.checkedAt)) && Array.isArray(value.runs) && value.runs.length <= 20 && value.runs.every(run =>
      record(run) && id(run.id) && count(run.attempt) && text(run.name) && run.name.length <= 300 && text(run.observedAt) &&
      text(run.url) && run.url.startsWith('https://github.com/') && text(run.settingsUrl) && run.settingsUrl.startsWith('https://github.com/') &&
      (run.workflow === null || workflowPath(run.workflow)) && (run.environment === null || statics(run.environment)) &&
      (run.vercelSecret === undefined || secretName(run.vercelSecret) && Array.isArray(run.secrets) && run.secrets.includes(run.vercelSecret)) &&
      ['references', 'unknown'].includes(String(run.binding)) && Array.isArray(run.secrets) && run.secrets.length <= 20 && run.secrets.every(secretName)) &&
    Array.isArray(value.requests) && value.requests.length <= 100 && value.requests.every(request => record(request) && id(request.runId) && count(request.attempt) &&
      text(request.requestedAt) && (request.credentialRevision === undefined || text(request.credentialRevision) && /^[a-f0-9]{64}$/.test(request.credentialRevision)) && ['requested', 'accepted', 'uncertain', 'observed', 'refused'].includes(String(request.status)));
}
