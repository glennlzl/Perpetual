import { redact } from '../redaction.ts';

/** One environment's latest failure evidence, in the manager's private state. */
export const DIAGNOSTIC_BYTES = 128 * 1024;
const RETAINED = 32, MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Redact before clipping; keep complete UTF-8 at the end, where a service reports its failure. */
export function diagnosticText(value: string, limit = DIAGNOSTIC_BYTES): string {
  const text = redact(value), bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const marker = '[Earlier log output omitted]\n';
  return marker + bytes.subarray(-(limit - Buffer.byteLength(marker))).toString('utf8').replace(/^\uFFFD+/, '');
}

type DiagnosticRecord = { logs?: string; logsAt?: string; createdAt: string };
/** Expiry affects evidence only, never resource ownership, failures or environment records. */
export function retainDiagnostics(records: DiagnosticRecord[], at = Date.now()) {
  let changed = false;
  const withLogs = records.filter(record => record.logs !== undefined);
  // Older metadata did not always record creation time. Give undated legacy evidence one bounded
  // retention window on migration; an explicit invalid or expired observation is never refreshed.
  for (const record of withLogs) if (record.logsAt === undefined && !Number.isFinite(Date.parse(record.createdAt))) {
    record.logsAt = new Date(at).toISOString(); changed = true;
  }
  withLogs.sort((a, b) => Date.parse(b.logsAt ?? b.createdAt) - Date.parse(a.logsAt ?? a.createdAt));
  for (const [index, record] of withLogs.entries()) {
    const saved = Date.parse(record.logsAt ?? record.createdAt);
    if (index >= RETAINED || !Number.isFinite(saved) || saved < at - MAX_AGE_MS) {
      // Keep the observation time as a tombstone so a log read cannot fall through to old live/setup logs.
      record.logsAt ??= record.createdAt;
      delete record.logs;
      changed = true;
    } else {
      const protectedText = diagnosticText(record.logs!);
      if (protectedText !== record.logs) { record.logs = protectedText; changed = true; }
    }
  }
  return changed;
}
