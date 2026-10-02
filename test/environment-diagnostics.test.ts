import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText, retainDiagnostics } from '../src/environments/diagnostics.ts';

test('Failure evidence retention expires logs, keeps a tombstone and never drops resource ownership', () => {
  const at = Date.parse('2026-10-02T00:00:00Z');
  const old = { createdAt: '2026-09-01T00:00:00Z', logsAt: '2026-09-01T00:00:00Z', logs: 'expired', sandboxId: 'beta', cleanupError: 'still owned' };
  const records = [old, ...Array.from({ length: 40 }, (_, index) => ({ createdAt: new Date(at - index * 60_000).toISOString(), logsAt: new Date(at - index * 60_000).toISOString(), logs: `evidence-${index}`, sandboxId: `owned-${index}` }))];
  retainDiagnostics(records, at);
  assert.equal(records.filter(record => record.logs).length, 32);
  assert.equal(old.logs, undefined);
  assert.equal(old.logsAt, '2026-09-01T00:00:00Z');
  assert.equal(old.sandboxId, 'beta'); assert.equal(old.cleanupError, 'still owned');
  assert.equal(records[1].logs, 'evidence-0');
  assert.equal(records.at(-1)!.sandboxId, 'owned-39');
});

test('Long secrets crossing the retained evidence boundary are removed before byte clipping', () => {
  const text = diagnosticText(`prefix\npassword=${'p'.repeat(200_000)}\n${'λ'.repeat(100_000)}\nlast diagnostic`, 128 * 1024);
  assert.ok(Buffer.byteLength(text) <= 128 * 1024);
  assert.doesNotMatch(text, /pppp/);
  assert.match(text, /last diagnostic$/);
  assert.doesNotMatch(text, /^.*�/);
});
