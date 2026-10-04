/** Safe authoring diagnostics only. These facts never establish a business result. */
export type AuthoringTool = 'generator_setup_page' | 'generator_read_log' | 'generator_write_test' | 'browser_navigate' | 'browser_navigate_back' | 'browser_click' | 'browser_type' | 'browser_fill_form' | 'browser_press_key' | 'browser_select_option' | 'browser_hover' | 'browser_drag' | 'browser_snapshot' | 'browser_take_screenshot' | 'browser_wait_for' | 'browser_tabs' | 'browser_handle_dialog' | 'browser_file_upload' | 'browser_evaluate' | 'browser_run_code' | 'browser_console_messages' | 'browser_network_requests' | 'browser_close' | 'unknown';
export type AuthoringFinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other' | 'unknown';
export type AuthoringToolError = 'stale-reference' | 'ambiguous-locator' | 'no-native-dialog' | 'timeout' | 'unknown';
export type AuthoringBlockerKind = 'missing-prerequisite' | 'application-error' | 'action-unavailable' | 'observation-mismatch' | 'request-unobserved' | 'unknown';
/** A model's report about a numbered reviewed milestone, never an independently established business blocker. */
export interface AuthoringBlocker { milestone: number; kind: AuthoringBlockerKind }
export interface AuthoringUsage { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }
export interface HarnessEvidence {
  startedAt: string; completedAt: string; durationMs: number;
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  outputHash: string; outputBytes: number; eventsTruncated: boolean;
  events: { tool: AuthoringTool; outcome: 'completed' | 'error' }[];
  /** The last observed tool failure's fixed category, not its raw error or the inferred reason authoring stopped. */
  lastToolError?: { tool: AuthoringTool; kind: AuthoringToolError };
  /** Only a complete, final, structured model report. Ordinary terminal prose remains withheld. */
  reportedBlocker?: AuthoringBlocker;
  /** The last structured step_finish, not an inferred process exit reason or an aggregate usage estimate. */
  reportedFinishReason: AuthoringFinishReason; usage: AuthoringUsage | null;
  cleanupIncomplete?: true;
}
export interface AuthoringRecord {
  id: string; startedAt: string; completedAt: string; durationMs: number; caseHash: string;
  outcome: 'draft' | 'failed' | 'cancelled' | 'timed-out'; outputHash: string | null;
  provenance: { harness: string; generator: string; model: string };
  attempts: (HarnessEvidence & { phase: 'generation' | 'grammar-repair'; codeHash: string | null })[];
  cleanup: 'complete' | 'incomplete';
}
