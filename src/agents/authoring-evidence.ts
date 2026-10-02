// OpenCode v1.18.32 cli/cmd/run.ts emits newline-delimited {type, timestamp, part} in --format json.
// Project only tool_use part.state.status and step_finish metadata. Text, tool input/output, session ids and errors
// are never diagnostics. See docs/journeys.md for the pinned upstream contract and explicit bounds.
import { createHash } from 'node:crypto';
import { redact } from '../redaction.ts';
import type { AuthoringFinishReason, AuthoringTool, AuthoringUsage, HarnessEvidence } from '../../contract/authoring.ts';

const TOOLS: readonly AuthoringTool[] = ['generator_setup_page','generator_read_log','generator_write_test','browser_navigate','browser_navigate_back','browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_snapshot','browser_take_screenshot','browser_wait_for','browser_tabs','browser_handle_dialog','browser_file_upload','browser_evaluate','browser_run_code','browser_console_messages','browser_network_requests','browser_close'];
const REASONS: readonly AuthoringFinishReason[] = ['stop','length','tool-calls','content-filter','error','other'];
export const MAX_AUTHORING_EVENTS = 64;
const LINE_BYTES = 64 * 1024, STREAM_BYTES = 1024 * 1024;
export const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export const finishReason = (value: unknown): AuthoringFinishReason => REASONS.includes(value as AuthoringFinishReason) ? value as AuthoringFinishReason : 'unknown';
export const toolName = (value: unknown): AuthoringTool => TOOLS.includes(value as AuthoringTool) ? value as AuthoringTool : 'unknown';
export function authoringUsage(value: unknown): AuthoringUsage | null {
  const usage = object(value);
  if (!usage || !['input','output','reasoning','cacheRead','cacheWrite','cost'].every(key => number(usage[key]))) return null;
  return { input: usage.input as number, output: usage.output as number, reasoning: usage.reasoning as number, cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, cost: usage.cost as number };
}

/** Bounded raw lines live only until projection; redact complete JSON string values before allowlisting them. */
export function captureAuthoringEvidence(hide: (text: unknown) => string, onError: (message: string) => void = () => {}) {
  const started = Date.now(), hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  let outputBytes = 0, scanned = 0, pending = '', discarding = false, eventsTruncated = false;
  let reportedFinishReason: AuthoringFinishReason = 'unknown', usage: AuthoringUsage | null = null;
  const events: HarnessEvidence['events'] = [];
  const safe = (value: unknown) => typeof value === 'string' ? redact(hide(value)) : '';
  function line(text: string) {
    let value: unknown; try { value = JSON.parse(text); } catch { return; }
    const envelope = object(value), part = object(envelope?.part);
    if (envelope?.type === 'error') {
      const data = object(object(envelope.error)?.data);
      if (typeof data?.message === 'string') onError(safe(data.message));
    }
    if (envelope?.type === 'tool_use' && part?.type === 'tool') {
      const state = object(part.state);
      if (state?.status !== 'completed' && state?.status !== 'error') return;
      // OpenCode preserves the configured MCP server's name when prefixing the tool.
      const tool = safe(part.tool).replace(/^playwright[-_]test_/, '');
      if (events.length < MAX_AUTHORING_EVENTS) events.push({ tool: toolName(tool), outcome: state.status });
      else eventsTruncated = true;
    }
    if (envelope?.type === 'step_finish' && part?.type === 'step-finish') {
      reportedFinishReason = finishReason(safe(part.reason));
      const tokens = object(part.tokens), cache = object(tokens?.cache);
      usage = authoringUsage({ input: tokens?.input, output: tokens?.output, reasoning: tokens?.reasoning, cacheRead: cache?.read, cacheWrite: cache?.write, cost: part.cost });
    }
  }
  return {
    write(chunk: string, stream: 'stdout' | 'stderr') {
      // Separate stream digests are stable across arbitrary chunk boundaries and output interleaving.
      const bytes = Buffer.byteLength(chunk); outputBytes += bytes; hashes[stream].update(chunk);
      if (stream !== 'stdout') return;
      if (scanned + bytes > STREAM_BYTES) { scanned = STREAM_BYTES; pending = ''; discarding = true; eventsTruncated = true; return; }
      if (scanned === STREAM_BYTES) return;
      scanned += bytes;
      for (const [index, piece] of chunk.split('\n').entries()) {
        if (index) { if (!discarding) line(pending); pending = ''; discarding = false; }
        if (discarding) continue;
        if (Buffer.byteLength(pending) + Buffer.byteLength(piece) > LINE_BYTES) { pending = ''; discarding = true; eventsTruncated = true; }
        else pending += piece;
      }
    },
    finish(outcome: HarnessEvidence['outcome'], cleanupIncomplete = false): HarnessEvidence {
      // A partial final line is not a complete harness envelope. Missing metadata remains unknown.
      const completed = Date.now();
      return { startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), durationMs: Math.max(0, completed - started), outcome,
        outputHash: createHash('sha256').update(hashes.stdout.digest('hex')).update(hashes.stderr.digest('hex')).digest('hex'), outputBytes, eventsTruncated, events, reportedFinishReason, usage, ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}) };
    },
  };
}
