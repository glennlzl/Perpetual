// OpenCode v1.18.32 cli/cmd/run.ts emits newline-delimited {type, timestamp, part} in --format json.
// Project tool_use status, fixed error categories, step_finish metadata and a final structured blocker report.
// Ordinary text, tool input/output, session ids and error prose are never diagnostics. See docs/journeys.md.
import { createHash } from 'node:crypto';
import { redact } from '../redaction.ts';
import type { AuthoringBlocker, AuthoringBlockerKind, AuthoringFinishReason, AuthoringTool, AuthoringToolError, AuthoringUsage, HarnessEvidence } from '../../contract/authoring.ts';

const TOOLS: readonly AuthoringTool[] = ['generator_setup_page','generator_read_log','generator_write_test','browser_navigate','browser_navigate_back','browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_snapshot','browser_take_screenshot','browser_wait_for','browser_tabs','browser_handle_dialog','browser_file_upload','browser_evaluate','browser_run_code','browser_console_messages','browser_network_requests','browser_close','browser_verify_element_visible','browser_verify_list_visible','browser_verify_text_visible','browser_verify_value','read','ls','glob','grep'];
const REASONS: readonly AuthoringFinishReason[] = ['stop','length','tool-calls','content-filter','error','other'];
const ERRORS: readonly AuthoringToolError[] = ['stale-reference','ambiguous-locator','no-native-dialog','timeout'];
const BLOCKERS: readonly AuthoringBlockerKind[] = ['missing-prerequisite','application-error','action-unavailable','observation-mismatch','request-unobserved','unknown'];
export const MAX_AUTHORING_EVENTS = 64;
const LINE_BYTES = 64 * 1024, STREAM_BYTES = 1024 * 1024;
export const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export const finishReason = (value: unknown): AuthoringFinishReason => REASONS.includes(value as AuthoringFinishReason) ? value as AuthoringFinishReason : 'unknown';
export const toolName = (value: unknown): AuthoringTool => TOOLS.includes(value as AuthoringTool) ? value as AuthoringTool : 'unknown';
export const toolErrorKind = (value: unknown): AuthoringToolError => ERRORS.includes(value as AuthoringToolError) ? value as AuthoringToolError : 'unknown';
/** A numbered milestone and fixed kind only. The generator also checks the ordinal against its actual case. */
export function authoringBlocker(value: unknown, hide: (text: unknown) => string): AuthoringBlocker | undefined {
  const report = object(value);
  if (!report || typeof report.milestone !== 'number' || !Number.isInteger(report.milestone) || report.milestone < 1 || report.milestone > 12 || typeof report.kind !== 'string') return;
  const kind = redact(hide(report.kind));
  return BLOCKERS.includes(kind as AuthoringBlockerKind) ? { milestone: report.milestone, kind: kind as AuthoringBlockerKind } : undefined;
}
/** Fixed upstream error categories only; neither an error's contents nor page data leaves this projection. */
function classifyToolError(tool: AuthoringTool, text: string): AuthoringToolError {
  if (tool === 'browser_handle_dialog' && /\bNo dialog visible\b/i.test(text)) return 'no-native-dialog';
  if (/\bRef \S+ not found in the current page snapshot\b/i.test(text)) return 'stale-reference';
  if (/\bstrict mode violation\b/i.test(text)) return 'ambiguous-locator';
  if (/\b(?:TimeoutError|Timeout \d+ms exceeded)\b/i.test(text)) return 'timeout';
  return 'unknown';
}
export function authoringUsage(value: unknown): AuthoringUsage | null {
  const usage = object(value);
  if (!usage || !['input','output','reasoning','cacheRead','cacheWrite','cost'].every(key => number(usage[key]))) return null;
  return { input: usage.input as number, output: usage.output as number, reasoning: usage.reasoning as number, cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, cost: usage.cost as number };
}

/** Bounded raw lines live only until projection; redact complete JSON string values before allowlisting them. */
export function captureAuthoringEvidence(hide: (text: unknown) => string, onError: (message: string) => void = () => {}) {
  const started = Date.now(), hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  let outputBytes = 0, scanned = 0, pending = '', discarding = false, eventsTruncated = false, limited = false;
  let reportedFinishReason: AuthoringFinishReason = 'unknown', usage: AuthoringUsage | null = null;
  let lastToolError: HarnessEvidence['lastToolError'];
  let reportedBlocker: AuthoringBlocker | undefined;
  let reportStopped = false, scanIncomplete = false;
  const events: HarnessEvidence['events'] = [];
  const safe = (value: unknown) => typeof value === 'string' ? redact(hide(value)) : '';
  const clearReport = () => { reportedBlocker = undefined; reportStopped = false; };
  const loseScanIntegrity = () => { scanIncomplete = true; clearReport(); };
  const reportError = (envelope: Record<string, unknown> | null) => {
    const data = object(object(envelope?.error)?.data);
    if (typeof data?.message === 'string') onError(safe(data.message));
  };
  // Past the stream bound, only error envelopes are read, for the provider refusal one may carry.
  function errorLine(text: string) {
    if (!text.includes('"error"')) return;
    let value: unknown; try { value = JSON.parse(text); } catch { return; }
    const envelope = object(value);
    if (envelope?.type === 'error') reportError(envelope);
  }
  function line(text: string) {
    let value: unknown; try { value = JSON.parse(text); } catch { loseScanIntegrity(); return; }
    const envelope = object(value), part = object(envelope?.part);
    if (envelope?.type === 'step_start' || envelope?.type === 'tool_use' || envelope?.type === 'error') clearReport();
    if (envelope?.type === 'text') {
      clearReport();
      const end = object(part?.time)?.end;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 512 && number(end) && end > 0) {
        let parsed: unknown; try { parsed = JSON.parse(safe(part.text)); } catch { return; }
        const wrapper = object(parsed), report = object(wrapper?.perpetual_blocker);
        if (wrapper && Object.keys(wrapper).length === 1 && report && Object.keys(report).length === 2) reportedBlocker = authoringBlocker(report, hide);
      }
    }
    if (envelope?.type === 'error') reportError(envelope);
    if (envelope?.type === 'tool_use' && part?.type === 'tool') {
      const state = object(part.state);
      if (state?.status !== 'completed' && state?.status !== 'error') return;
      // OpenCode preserves the configured MCP server's name when prefixing the tool.
      const tool = safe(part.tool).replace(/^playwright[-_]test_/, '');
      if (state.status === 'error') lastToolError = { tool: toolName(tool), kind: classifyToolError(toolName(tool), safe(state.error)) };
      if (events.length < MAX_AUTHORING_EVENTS) events.push({ tool: toolName(tool), outcome: state.status });
      else eventsTruncated = true;
    }
    if (envelope?.type === 'step_finish') {
      if (part?.type !== 'step-finish') { clearReport(); return; }
      reportedFinishReason = finishReason(safe(part.reason));
      if (reportedFinishReason !== 'stop') clearReport();
      reportStopped = reportedBlocker !== undefined && reportedFinishReason === 'stop';
      const tokens = object(part.tokens), cache = object(tokens?.cache);
      usage = authoringUsage({ input: tokens?.input, output: tokens?.output, reasoning: tokens?.reasoning, cacheRead: cache?.read, cacheWrite: cache?.write, cost: part.cost });
    }
  }
  return {
    write(chunk: string, stream: 'stdout' | 'stderr') {
      // Separate stream digests are stable across arbitrary chunk boundaries and output interleaving.
      const bytes = Buffer.byteLength(chunk); outputBytes += bytes; hashes[stream].update(chunk);
      if (stream !== 'stdout') return;
      if (!limited && scanned + bytes > STREAM_BYTES) { limited = true; pending = ''; discarding = true; eventsTruncated = true; loseScanIntegrity(); }
      if (!limited) scanned += bytes;
      const read = limited ? errorLine : line;
      for (const [index, piece] of chunk.split('\n').entries()) {
        if (index) { if (!discarding) read(pending); pending = ''; discarding = false; }
        if (discarding) continue;
        if (Buffer.byteLength(pending) + Buffer.byteLength(piece) > LINE_BYTES) { pending = ''; discarding = true; eventsTruncated = true; loseScanIntegrity(); }
        else pending += piece;
      }
    },
    finish(outcome: HarnessEvidence['outcome'], cleanupIncomplete = false): HarnessEvidence {
      // A partial final line is not a complete harness envelope. Missing metadata remains unknown.
      const completed = Date.now();
      return { startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), durationMs: Math.max(0, completed - started), outcome,
        outputHash: createHash('sha256').update(hashes.stdout.digest('hex')).update(hashes.stderr.digest('hex')).digest('hex'), outputBytes, eventsTruncated, events, reportedFinishReason, usage, ...(lastToolError ? { lastToolError } : {}),
        ...(outcome === 'completed' && !pending && !discarding && !scanIncomplete && reportStopped && reportedBlocker ? { reportedBlocker } : {}), ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}) };
    },
  };
}
