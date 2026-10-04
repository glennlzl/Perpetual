// Durable diagnostics are part of the browser manager's private state and its save queue.
import type { AuthoringRecord, HarnessEvidence } from '../../contract/authoring.ts';
import { authoringUsage, finishReason, object, toolName, toolErrorKind, MAX_AUTHORING_EVENTS } from '../agents/authoring-evidence.ts';
import { redact } from '../redaction.ts';

export type AuthoringHistory = Record<string, Record<string, AuthoringRecord[]>>;
export const AUTHORING_RECORD_BYTES = 32 * 1024, AUTHORING_CASE_RECORDS = 3, AUTHORING_TOTAL_RECORDS = 100, AUTHORING_DAYS = 14;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const bad = (): never => { throw new Error('Unsupported journey authoring state.'); };
const identifier = (value: unknown, hide: (value: unknown) => string, pattern: RegExp): string => {
  if (typeof value !== 'string') return 'unknown';
  const safe = redact(hide(value));
  return safe.length <= 160 && !safe.includes('://') && pattern.test(safe) ? safe : 'unknown';
};

/** Rebuild the allowlisted shape from unknown state; never spread an untrusted object into a reply. */
export function restoreAuthoringRecord(value: unknown, hide: (value: unknown) => string): AuthoringRecord {
  const record = object(value), provenance = object(record?.provenance);
  if (!record || !provenance || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || !timestamp(record.startedAt) || !timestamp(record.completedAt) || !number(record.durationMs) || !hash(record.caseHash)
    || !['draft','failed','cancelled','timed-out'].includes(String(record.outcome)) || record.outputHash !== null && !hash(record.outputHash)
    || !Array.isArray(record.attempts) || record.attempts.length > 2 || !['complete','incomplete'].includes(String(record.cleanup))) return bad();
  const attempts = record.attempts.map((value): AuthoringRecord['attempts'][number] => {
    const attempt = object(value);
    if (!attempt || !['generation','grammar-repair'].includes(String(attempt.phase)) || !timestamp(attempt.startedAt) || !timestamp(attempt.completedAt) || !number(attempt.durationMs)
      || !['completed','failed','cancelled','timed-out'].includes(String(attempt.outcome)) || !hash(attempt.outputHash) || !number(attempt.outputBytes) || typeof attempt.eventsTruncated !== 'boolean'
      || attempt.codeHash !== null && !hash(attempt.codeHash) || !Array.isArray(attempt.events) || attempt.events.length > MAX_AUTHORING_EVENTS || attempt.cleanupIncomplete !== undefined && attempt.cleanupIncomplete !== true) return bad();
    const events = attempt.events.map(value => {
      const event = object(value);
      if (!event || !['completed','error'].includes(String(event.outcome))) return bad();
      return { tool: toolName(redact(hide(event.tool))), outcome: event.outcome as 'completed' | 'error' };
    });
    const error = object(attempt.lastToolError);
    if (attempt.lastToolError !== undefined && !error) return bad();
    const lastToolError = error ? { tool: toolName(redact(hide(error.tool))), kind: toolErrorKind(redact(hide(error.kind))) } : undefined;
    return { phase: attempt.phase as 'generation' | 'grammar-repair', startedAt: attempt.startedAt, completedAt: attempt.completedAt, durationMs: attempt.durationMs,
      outcome: attempt.outcome as HarnessEvidence['outcome'], outputHash: attempt.outputHash, outputBytes: attempt.outputBytes, eventsTruncated: attempt.eventsTruncated, events,
      reportedFinishReason: finishReason(redact(hide(attempt.reportedFinishReason))), usage: authoringUsage(attempt.usage), codeHash: attempt.codeHash as string | null,
      ...(lastToolError ? { lastToolError } : {}), ...(attempt.cleanupIncomplete ? { cleanupIncomplete: true } : {}) };
  });
  const safe: AuthoringRecord = { id: record.id, startedAt: record.startedAt, completedAt: record.completedAt, durationMs: record.durationMs, caseHash: record.caseHash,
    outcome: record.outcome as AuthoringRecord['outcome'], outputHash: record.outputHash as string | null, attempts, cleanup: record.cleanup as AuthoringRecord['cleanup'],
    provenance: { harness: identifier(provenance.harness, hide, /^opencode@\d+\.\d+\.\d+$/), generator: identifier(provenance.generator, hide, /^playwright-test-generator@\d+\.\d+\.\d+$/), model: identifier(provenance.model, hide, /^openrouter\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:+\/-]+$/) } };
  if (Buffer.byteLength(JSON.stringify(safe)) > AUTHORING_RECORD_BYTES) return bad();
  return safe;
}

/** Newest three per case, newest 100 overall, at most fourteen days; case deletion removes its history. */
export function retainAuthoring(history: AuthoringHistory, cases: Record<string, readonly { id: string }[]>, now = Date.now()): AuthoringHistory {
  const entries = Object.entries(history).flatMap(([scope, values]) => Object.entries(values).flatMap(([caseId, records]) =>
    cases[scope]?.some(item => item.id === caseId) ? records.filter(record => Date.parse(record.completedAt) >= now - AUTHORING_DAYS * 86400000).map(record => ({ scope, caseId, record })) : []))
    .sort((a,b) => b.record.completedAt.localeCompare(a.record.completedAt));
  const result: AuthoringHistory = Object.create(null);
  let kept = 0;
  for (const { scope, caseId, record } of entries) {
    if (kept >= AUTHORING_TOTAL_RECORDS) break;
    if ((result[scope]?.[caseId]?.length ?? 0) >= AUTHORING_CASE_RECORDS) continue;
    result[scope] ??= Object.create(null); result[scope][caseId] ??= []; result[scope][caseId].push(record); kept++;
  }
  return result;
}
export function restoreAuthoring(value: unknown, cases: Record<string, readonly { id: string }[]>, hide: (value: unknown) => string): AuthoringHistory {
  const history = object(value); if (!history) return bad();
  const result: AuthoringHistory = Object.create(null);
  for (const [scope, value] of Object.entries(history)) {
    const cases = object(value); if (!cases) return bad();
    result[scope] = Object.create(null);
    for (const [caseId, records] of Object.entries(cases)) {
      if (!Array.isArray(records)) return bad();
      result[scope][caseId] = records.map(record => restoreAuthoringRecord(record, hide));
    }
  }
  return retainAuthoring(result, cases);
}
