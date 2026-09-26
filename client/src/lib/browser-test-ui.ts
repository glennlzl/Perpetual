const LABELS: Record<string, string> = { queued: 'Queued', pending: 'Queued', running: 'Running', skipping: 'Skipping…', skipped: 'Skipped', blocked: 'Blocked', cancelling: 'Cancelling…', unconfirmed: 'Unconfirmed', completed: 'Cases ready', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', needs_review: 'Needs review', not_run: 'Not run' };
export const ACTIONS: Record<string, string> = { navigate: 'Navigate', go_to_url: 'Navigate', click: 'Click', click_element: 'Click', fill: 'Enter text', input: 'Enter text', input_text: 'Enter text', type: 'Enter text', scroll: 'Scroll', search: 'Search', search_page: 'Search page', search_google: 'Search', observe: 'Observe page', screenshot: 'Observe page', wait: 'Wait', done: 'Finish', extract: 'Read page', extract_content: 'Read page', switch_tab: 'Switch tab', open_tab: 'Open tab', go_back: 'Go back', send_keys: 'Press key', upload_file: 'Upload file', evaluate: 'Inspect page', check: 'Check outcome', report_journey_step: 'Report milestone', sign_in_with_test_account: 'Sign in', reload_page: 'Reload' };
import { diffLines } from 'diff';

// The controller's browser test records as this UI reads them. Statuses are the controller's own strings; unknown
// ones are shown as they are.
/** A reviewed milestone check: text and URL checks use value; number checks use label and name, comparisons op and than. */
export interface StepCheck { type: string; value?: string; label?: string; name?: string; op?: string; than?: string }
/** A business milestone of a journey. Its ID stays stable so results keep matching it. */
export interface JourneyStep { id: string; title: string; checks?: StepCheck[] }
/** A final check on the journey's end state. */
export interface CaseAssertion { type: string; value: string }
/** A reviewed journey (a browser test case) or an unreviewed draft. */
export interface BrowserCase {
  id: string; name: string; goal?: string; preconditions?: string[]; expectedOutcomes?: string[]; assertions?: CaseAssertion[];
  steps?: JourneyStep[]; isolation?: string; selected?: boolean; needsReview?: boolean; evidence?: { path: string; line: number }[];
}
/** A check as a run evaluated it; values are observed by the runner, never the model. */
interface CheckOutcome { passed?: boolean; observed?: number; error?: string; reached?: boolean }
export interface CheckResult extends Partial<StepCheck>, CheckOutcome {}
/** A final assertion's result. reached: false marks an end state the journey never reached. */
export type AssertionResult = CheckResult;
/** A milestone as a run reported it. Older runs also recorded a provenance, which is never shown. */
export interface StepProgress { id: string; title?: string; status: string; evidence?: string; checks?: CheckResult[]; provenance?: string }
export interface BrowserAction { index?: number; type?: string; status?: string; errorCode?: string }
/** One journey's live progress in a run. */
export interface CaseProgress {
  id?: string; caseId?: string; name?: string; status: string; queueReason?: string; startedAt?: string; completedAt?: string; error?: string;
  frameUpdatedAt?: string; frameCapturedAt?: string; actionCount?: number; actions?: BrowserAction[]; lastAction?: BrowserAction; steps?: StepProgress[]; videos?: string[];
}
export interface RunProgress { revision?: number; status?: string; cases?: CaseProgress[] }
export interface JourneyBlocker { kind?: string; stepId?: string; evidence?: string }
/** The controller's verdict for one journey of a run. */
export interface CaseResult { caseId: string; status: string; error?: string; engine?: string; blockers?: JourneyBlocker[]; assertions?: AssertionResult[] }
/** A browser run: a discovery, or a run of selected journeys (a verification attempt or its control run). */
export interface BrowserRun {
  id: string; mode: 'run' | 'discover'; status: string; createdAt?: string; startedAt?: string; completedAt?: string; error?: string;
  stageId?: string; environmentId?: string; engine?: string; targetUrl?: string; sourceRevision?: string | null;
  caseIds?: string[]; caseSummaries?: BrowserCase[]; results?: CaseResult[]; progress?: RunProgress; verification?: { id?: string; attempt?: number; control?: boolean };
  discovery?: { summary?: string; authenticated?: boolean; cases?: BrowserCase[] };
  frameUpdatedAt?: string; frameCapturedAt?: string; concurrency?: number; effectiveConcurrency?: number; concurrencyLimit?: string | null;
}
/** A run as the viewer opens it: live when it opens while the run is queued or running, as Watch live does. */
export function watchedRun<T extends Pick<BrowserRun, 'status'>>(run: T): T & { live: boolean } { return { ...run, live: ['queued', 'running'].includes(run.status) }; }
/**
 * The attempt a viewer opened live on a verification follows once the attempt it shows has ended: that verification's
 * active one, its control run included. Null for an attempt a person opened after it ended, while the shown run is
 * active, or when it is no verification attempt.
 */
export function verificationAttempt(watched: { id?: string | null; live?: boolean } | null | undefined, runs: readonly BrowserRun[]) {
  const shown = watched?.live ? runs.find(run => run.id === watched.id) : undefined, id = shown?.verification?.id, active = (run: BrowserRun) => ['queued', 'running'].includes(run.status);
  if (!shown || !id || active(shown)) return null;
  return runs.find(run => run.id !== shown.id && run.verification?.id === id && active(run)) ?? null;
}
/** What this machine can run, with the App Settings model view the controller merges in. An absent field is unknown, not missing. */
export interface BrowserCapabilities {
  runtimeInstalled?: boolean; browserInstalled?: boolean; runtimeProject?: string; modelConfigured?: boolean; modelError?: string; playwright?: { browserInstalled?: boolean } | null;
  provider?: 'openrouter' | 'custom'; model?: string; baseUrl?: string; keyConfigured?: boolean;
}
export interface CodeVersion { hash?: string; stale?: boolean; code?: string }
export interface CodeVerification { status?: string; passes?: number; control?: string | null; error?: string }
/** A journey's code: the approved code, the draft beside it and a code generation. */
export interface JourneySpec { approved?: CodeVersion | null; draft?: (CodeVersion & { verification?: CodeVerification }) | null; generation?: { status?: string; step?: string; error?: string } | null }
export type JourneySpecs = Record<string, JourneySpec | undefined>;
export type BadgeTone = 'destructive' | 'secondary' | 'outline';

export const CHECKS: Record<string, string> = { 'text-visible': 'Text visible', 'text-absent': 'Text absent', 'url-contains': 'URL contains', 'read-number': 'Read number', 'compare-number': 'Compare number' };
const ACTION_ERRORS: Record<string, string> = { action_not_allowed: 'Action blocked', navigation_not_allowed: 'Navigation blocked', attachments_not_allowed: 'Attachment blocked', credential_literal_rejected: 'Use account placeholder', credential_reference_invalid: 'Invalid account placeholder', credential_origin_mismatch: 'Login origin mismatch', credential_field_unavailable: 'Login field unavailable', credential_target_mismatch: 'Login tab mismatch', credential_frame_mismatch: 'Login frame mismatch', credential_field_type_mismatch: 'Wrong login field', credential_verification_failed: 'Login field not verified', browser_action_failed: 'Browser action failed', action_result_missing: 'No action result', journey_progress_invalid: 'Invalid journey progress', payment_live_mode_rejected: 'Live payment blocked' };
const BLOCKERS: Record<string, string> = { account: 'Account', fixture: 'Test data', integration: 'Integration', permission: 'Permission', environment: 'Environment' };
const LIMITS: Record<string, string> = { 'shared-data': 'Shared test data', account: 'Test account' };
const QUEUES: Record<string, string> = { 'shared-data': 'Waiting for shared test data', account: 'Waiting for test account' };
const OPS: Record<string, string> = { '<': '<', '>': '>', '=': '=', '!=': '≠' };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const own = (map: Record<string, string>, key: string | null | undefined) => typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : '';
const number = (value: number) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 });
export const journeyActive = (status: string | undefined) => ['queued', 'pending', 'running', 'skipping', 'cancelling'].includes(status ?? '');
export const journeyStreaming = (status: string | undefined) => ['running', 'skipping', 'cancelling'].includes(status ?? '');
export const journeyProgress = (run: Pick<BrowserRun, 'progress'> | null | undefined, caseId: string) => run?.progress?.cases?.find(value => (value.caseId || value.id) === caseId);
// A finished journey replays its recordings, one per browser tab; a live one keeps streaming frames.
export function journeyRecordings({ repoPath, stageId, run, caseId, status }: { repoPath: string; stageId: string; run?: BrowserRun | null; caseId: string; status: string }) {
  const videos = journeyProgress(run, caseId)?.videos;
  if (!run || journeyActive(status) || !Array.isArray(videos)) return [];
  return videos.map(file => `/api/browser/runs/${encodeURIComponent(run.id)}/video?${new URLSearchParams({ repoPath, stageId, caseId, file })}`);
}
// Lists open only journeys that are live or failed; finished journeys stay collapsed until asked.
export const journeyOpenByDefault = (status: string) => journeyActive(status) || status === 'failed';
// Only a failed journey's error reads as failure; blocked and review errors are context, not a verdict.
export const journeyErrorTone = (status: string) => status === 'failed' ? 'text-destructive' : 'text-muted-foreground';

// A journey's own reported events (actions and milestone states), so one journey acting never refreshes another's frame.
export function journeyRevision(progress: Partial<CaseProgress> | null | undefined) {
  if (!progress) return undefined;
  return `${progress.actionCount ?? progress.actions?.length ?? 0}:${(progress.steps || []).map(step => step.status).join(',')}`;
}

const RUNTIME_PROJECT = /^\/[\w./-]+$/;
// The runtime and its Chromium install with the documented commands (docs/journeys.md),
// relative to the Perpetual source unless the controller names its path.
export function browserInstallCommand(capabilities: BrowserCapabilities | null | undefined) {
  if (!capabilities || (capabilities.runtimeInstalled && capabilities.browserInstalled !== false)) return '';
  const project = typeof capabilities.runtimeProject === 'string' && RUNTIME_PROJECT.test(capabilities.runtimeProject) ? capabilities.runtimeProject : 'integrations/browser-use';
  const chromium = `uv run --project ${project} python -m playwright install chromium`;
  return capabilities.runtimeInstalled ? chromium : `uv sync --project ${project} --frozen\n${chromium}`;
}

export const PLAYWRIGHT_INSTALL = 'npx playwright install chromium';
export type ReadinessId = 'target' | 'runtime' | 'model' | 'playwright';
/** A prerequisite of Generate or Run and its fix: a blocker line and, where a command fixes it, that command. */
export interface ReadinessItem { id: ReadinessId; label: string; ready: boolean; blocker: string; command?: string }
// Every prerequisite of Generate and Run, in fix order, each with its own fix. Unknown capabilities
// are not missing; the panel re-checks once the full view loads. App Settings fixes only the key.
// Generate needs the browser agent's runtime and the key; a run executes Playwright code in Playwright's Chromium.
export function browserReadiness(capabilities: BrowserCapabilities | null | undefined, validTarget = false) {
  const items: ReadinessItem[] = [{ id: 'target', label: 'Target URL', ready: Boolean(validTarget), blocker: 'Set a target URL' }];
  if (!capabilities) return items;
  const runtime = Boolean(capabilities.runtimeInstalled);
  items.push({ id: 'runtime', label: 'Browser runtime', ready: runtime && capabilities.browserInstalled !== false, blocker: runtime ? 'Install Chromium' : 'Install the browser runtime', command: browserInstallCommand(capabilities) });
  items.push({ id: 'model', label: 'OpenRouter API Key', ready: Boolean(capabilities.modelConfigured), blocker: 'Add an OpenRouter API Key' });
  if (capabilities.playwright) {
    const installed = capabilities.playwright.browserInstalled !== false;
    items.push({ id: 'playwright', label: 'Playwright browser', ready: installed, blocker: 'Install Chromium for Playwright', command: installed ? '' : PLAYWRIGHT_INSTALL });
  }
  return items;
}
const GENERATE: ReadinessId[] = ['target', 'runtime', 'model'], RUN: ReadinessId[] = ['target', 'playwright'];
const blockersOf = (items: ReadinessItem[], ids: ReadinessId[]) => items.filter(item => !item.ready && ids.includes(item.id)).map(item => item.blocker);
// Every missing capability of Generate, one per line; the target URL is checked on its own.
export const browserUnavailable = (capabilities: BrowserCapabilities | null | undefined) => blockersOf(browserReadiness(capabilities, true), GENERATE).join('\n');

// The first unmet prerequisite is the primary action (target → runtime → key → Playwright → tests → run);
// every disabled action lists all of its blockers, one per line. runnable: every selected test has code to run.
export function testToolbar({ wait = '', readiness = [], caseCount = 0, selectedCount = 0, maxCases = Infinity, runnable = true }: { wait?: string; readiness?: ReadinessItem[]; caseCount?: number; selectedCount?: number; maxCases?: number; runnable?: boolean }) {
  const missing = readiness.filter(item => !item.ready);
  const generate = wait || blockersOf(missing, GENERATE).join('\n');
  const run = wait || blockersOf(missing, RUN).join('\n') || (!selectedCount ? 'Select tests' : runnable ? '' : 'Generate code for the selected tests');
  const blockers = { target: wait, generate, add: wait || (caseCount >= maxCases ? `Limit of ${maxCases} tests` : ''), run };
  const primary: ReadinessId | 'generate' | 'run' | '' = missing[0]?.id || (!caseCount ? 'generate' : selectedCount ? 'run' : '');
  return { primary, blockers };
}

// A new graph request selects its own tab in the same render; otherwise the viewer's choice stands.
export interface InspectorTab { request: string; tab: string }
export function inspectorTab(state: InspectorTab | null | undefined, initialTab: string, requestKey: string | number = ''): InspectorTab {
  const request = `${initialTab}\u0000${requestKey}`;
  if (state?.request === request) return state;
  return { request, tab: initialTab === 'browser-runs' ? 'browser-runs' : 'browser' };
}

export function browserRunLabel(run: string | Pick<BrowserRun, 'mode' | 'status'> | null | undefined) {
  const status = typeof run === 'string' ? run : run?.status;
  if (typeof run === 'object' && run?.mode === 'run' && status === 'completed') return 'Finished with skips';
  return LABELS[status ?? ''] || status || 'Not run';
}

// A case's latest run of its current definition. A verification's control run, with every change blocked, never
// counts as the journey's status, except when that run itself is shown (control: true).
export function browserCaseRun(item: BrowserCase, runs: BrowserRun[] = [], { control = false }: { control?: boolean } = {}) {
  if (item.needsReview) return null;
  const run = [...runs].filter(value => value.mode === 'run' && (control || !value.verification?.control) && value.caseIds?.includes(item.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!run) return null;
  // Its definition is the reviewed contract approval binds to (caseHash in src/journeys/playwright/specs.ts): a rename or
  // its isolation leaves the approved code current, so the gate keeps running it and its latest run stays its status.
  const original = run.caseSummaries?.find(value => value.id === item.id);
  if (!original || (['goal','preconditions','expectedOutcomes','assertions'] as const).some(key => !same(original[key] || [], item[key] || [])) || !same(original.steps || [], item.steps || [])) return null;
  return run;
}

// A draft awaiting approval and a finished run awaiting judgement share a status, not a label.
export interface CaseState { status: string; label: string; variant: BadgeTone }
export function browserCaseState(item: BrowserCase, runs: BrowserRun[] = [], options: { control?: boolean } = {}): CaseState {
  const state = (status: string, label = browserRunLabel(status)): CaseState => ({ status, label, variant: status === 'failed' ? 'destructive' : ['running', 'passed'].includes(status) ? 'secondary' : 'outline' });
  if (item.needsReview) return state('needs_review');
  const run = browserCaseRun(item, runs, options);
  if (!run) return state('not_run');
  const result = run.results?.find(value => value.caseId === item.id);
  const progress = journeyProgress(run, item.id);
  let status = result?.status || progress?.status || (['queued', 'running'].includes(run.status) ? 'queued' : 'not_run');
  if (journeyActive(status) && !['queued', 'running'].includes(run.status)) status = ['failed','cancelled','skipped'].includes(run.status) ? run.status : 'needs_review';
  return state(status, status === 'needs_review' ? 'Review result' : undefined);
}

const finite = (value: unknown): value is number => Number.isFinite(value);
function checkText(check: StepCheck & CheckOutcome, captures: Record<string, number>) {
  const observed = check.observed, than = String(check.than);
  if (check.type === 'read-number') return finite(observed) ? `${check.label} ${number(observed)}` : check.label;
  if (check.type === 'compare-number') return finite(observed) && finite(captures[than]) ? `${check.label} ${number(captures[than])} → ${number(observed)}` : finite(observed) ? `${check.label} → ${number(observed)}` : `${check.label} ${OPS[check.op ?? ''] || check.op} ${check.than}`;
  return `${CHECKS[check.type] || check.type}: ${check.value}`;
}

export interface CheckView extends StepCheck, CheckOutcome { text: string | undefined; result: 'Passed' | 'Failed' | 'Not checked' }
export interface JourneyStepView extends JourneyStep { status: string; evidence?: string; checks: CheckView[] }
// Merges reviewed milestone checks with independent results; values are observed by the runner, never the model.
export function browserJourneySteps(item: BrowserCase, progress: Pick<CaseProgress, 'steps'> | null | undefined, status: string): JourneyStepView[] {
  const captures: Record<string, number> = {};
  return (item.steps || []).map(step => {
    const observed = progress?.steps?.find(value => value.id === step.id);
    let stepStatus = observed?.status || 'pending';
    // A finished journey cannot leave a milestone spinning; unreached milestones stay pending.
    if (stepStatus === 'running' && !journeyActive(status)) stepStatus = ['skipped','cancelled'].includes(status) ? status : 'unconfirmed';
    const results = Array.isArray(observed?.checks) ? observed.checks : [];
    const checks = (step.checks || []).map((check, index): CheckView => {
      const found = results[index]?.type === check.type && typeof results[index].passed === 'boolean' ? results[index] : null;
      const merged: StepCheck & CheckOutcome = { ...check, ...(found ? { passed: found.passed, ...(Number.isFinite(found.observed) ? { observed: found.observed } : {}), ...(found.error ? { error: String(found.error) } : {}) } : {}) };
      const text = checkText(merged, captures);
      if (merged.type === 'read-number' && finite(merged.observed)) captures[String(merged.name)] = merged.observed;
      return { ...merged, text, result: merged.passed === true ? 'Passed' : merged.passed === false ? 'Failed' : 'Not checked' };
    });
    return { ...step, status: stepStatus, evidence: observed?.evidence, checks };
  });
}

const current = (code: CodeVersion | null | undefined) => typeof code?.hash === 'string' && code.stale === false;
// A person's run executes each journey's current approved code, else its current draft.
export const runnableCode = (cases: Pick<BrowserCase, 'id'>[], specs: JourneySpecs | null | undefined) => cases.length > 0 && cases.every(item => current(specs?.[item.id]?.approved) || current(specs?.[item.id]?.draft));
// Runs need Playwright's Chromium and code for every chosen journey, not the browser agent or a model.
export const runReady = (capabilities: BrowserCapabilities | null | undefined, cases: Pick<BrowserCase, 'id'>[], specs: JourneySpecs | null | undefined) => capabilities?.playwright?.browserInstalled !== false && runnableCode(cases, specs);
/**
 * A case's code: the approved code (Approved, or Stale once the reviewed journey changed) and the draft beside it
 * (Draft, Verifying n/3, Verified, Verification failed, Stale draft), and a running or failed generation. A current
 * draft is verified before it is approvable: three passing runs, then a control run in which a reviewed check fails.
 * Stale approved code is reusable as the draft while no current draft exists.
 */
export function journeyCode(spec: JourneySpec | null | undefined) {
  const { approved, draft, generation }: JourneySpec = spec || {}, verification = draft?.verification, verifying = verification?.status === 'running';
  const draftState = !draft ? '' : draft.stale ? 'Stale draft' : verifying ? `Verifying ${verification.passes}/3` : verification?.status === 'passed' ? 'Verified' : verification?.status === 'failed' ? 'Verification failed' : 'Draft';
  return {
    approved: approved ? approved.stale ? 'Stale' : 'Approved' : '', draft: draftState, hash: draft?.hash || '',
    verificationError: draftState === 'Verification failed' ? verification?.error || 'Verification failed.' : '',
    generating: generation?.status === 'running', error: generation?.status === 'failed' ? generation.error || 'Code generation failed.' : '',
    exists: Boolean(approved || draft), verifying, verifiable: current(draft) && !verifying && verification?.status !== 'passed', approvable: current(draft) && verification?.status === 'passed',
    reusable: approved?.stale === true && !current(draft),
  };
}
/** The lines a person approves: the draft's code, or its line diff against the approved code (kind same, added, removed). */
export type CodeLine = { kind: 'same' | 'added' | 'removed'; text: string };
export function codeLines(draft: string, approved?: string | null): CodeLine[] {
  const lines = (value: string, kind: CodeLine['kind']) => value.replace(/\n$/, '').split('\n').map(text => ({ kind, text }));
  return typeof approved === 'string' ? diffLines(approved, draft).flatMap(part => lines(part.value, part.added ? 'added' : part.removed ? 'removed' : 'same')) : lines(draft, 'same');
}
// A Playwright journey has no agent: its expected outcomes are backed by its reviewed checks alone. Only a final
// assertion evaluated on the reached end state fails them; a journey that stopped earlier never reached them.
export function checkedOutcome(result: Pick<CaseResult, 'status' | 'assertions'> | null | undefined): { label: string; variant: BadgeTone } {
  if (result?.status === 'passed') return { label: 'Checks · Passed', variant: 'outline' };
  if (result?.assertions?.some(check => check.passed === false && check.reached !== false)) return { label: 'Checks · Failed', variant: 'destructive' };
  return { label: result?.status === 'failed' || result?.assertions?.some(check => check.reached === false) ? 'Checks · Not reached' : 'Checks · Not confirmed', variant: 'outline' };
}

export function journeySegments(steps: { id: string; title?: string; status: string }[]) {
  return steps.map(step => ({ id: step.id, title: step.title, state: step.status === 'completed' ? 'observed' : step.status === 'running' ? 'current' : ['blocked', 'failed'].includes(step.status) ? step.status : 'pending' }));
}

// Progress text counts only milestones the agent reported with evidence.
export function journeySummary(steps: { title: string; status: string }[], status: string): { observed: number; total: number; text: string; status?: string } {
  const total = steps.length, observed = steps.filter(step => step.status === 'completed').length;
  if (!total || ['queued', 'pending', 'not_run'].includes(status)) return { observed, total, text: '' };
  if (journeyStreaming(status)) {
    const current = steps.find(step => step.status === 'running');
    return { observed, total, text: current ? `${observed}/${total} · ${current.title}` : `${observed}/${total}` };
  }
  const stopped = steps.find(step => step.status === 'failed') || steps.find(step => step.status === 'blocked');
  return stopped ? { observed, total, text: stopped.title, status: stopped.status } : { observed, total, text: `${observed}/${total} observed` };
}

export function journeyElapsed(startedAt: string | null | undefined, now: number) {
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000)), pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

export const journeyQueueLabel = (reason: string | undefined) => own(QUEUES, reason) || 'Waiting for a browser';

// Graph summaries carry only actionCount and lastAction; the watch dialog's run progress keeps the full list.
export function journeyActions(progress: Partial<CaseProgress> | null | undefined) {
  const items = Array.isArray(progress?.actions) ? progress.actions : progress?.lastAction ? [progress.lastAction] : [];
  return { items, count: progress?.actionCount ?? items.length };
}

// The controller marks a final check on an end state the journey never reached; it is context, never a failure.
export const journeyCheckFailed = (check: AssertionResult | null | undefined) => check?.passed === false && check.reached !== false;
export function journeyCheckState(check: AssertionResult | null | undefined): { label: string; variant: BadgeTone } {
  if (check?.reached === false) return { label: 'Not reached', variant: 'outline' };
  if (check?.passed === true) return { label: 'Passed', variant: 'outline' };
  return check?.passed === false ? { label: 'Failed', variant: 'destructive' } : { label: 'Not checked', variant: 'outline' };
}

export function journeyLastAction(progress: Partial<CaseProgress> | null | undefined) {
  const last = progress?.lastAction || progress?.actions?.at(-1);
  return last ? { ...last, count: progress?.actionCount ?? progress?.actions?.length ?? 0 } : null;
}

export const browserActionLabel = (type: string | undefined) => own(ACTIONS, type) || String(type || 'Action').replaceAll('_', ' ');
export const browserActionError = (code: string | undefined) => own(ACTION_ERRORS, code);
// A failed action always names its failure in text, not only with an icon.
export const browserActionFailure = (action: BrowserAction | null | undefined) => action?.status === 'failed' ? browserActionError(action.errorCode) || browserRunLabel('failed') : '';

export function browserBlockers(result: Pick<CaseResult, 'blockers'> | null | undefined, steps: Pick<JourneyStep, 'id' | 'title'>[] = []) {
  return (Array.isArray(result?.blockers) ? result.blockers : []).map(blocker => ({ kind: own(BLOCKERS, blocker.kind) || 'Blocker', step: steps.find(step => step.id === blocker.stepId)?.title || '', evidence: String(blocker.evidence || '') }));
}

export function browserFrameLabel({ status, runId, image = false, error = '', fresh = false, streaming = journeyStreaming(status) }: { status: string; runId?: string; image?: boolean; error?: string; fresh?: boolean; streaming?: boolean }) {
  if (image) return streaming ? error ? 'Reconnecting' : fresh ? 'Live' : 'Waiting for frame' : 'Last frame';
  if (streaming) return error ? 'Reconnecting' : status === 'running' ? 'Opening browser…' : browserRunLabel(status);
  if (!runId) return status === 'needs_review' ? 'Review to run' : browserRunLabel(status);
  if (error) return error;
  return journeyActive(status) ? browserRunLabel(status) : 'No browser frame';
}

// The controller's status is the verdict; the list only orders by it.
const ATTENTION = ['failed', 'blocked', 'needs_review'];
const journeyPriority = (status: string) => ATTENTION.includes(status) ? ATTENTION.indexOf(status) : ATTENTION.length;

// Finished runs lead with what needs attention; active runs keep their queue order.
export function orderJourneys<T extends BrowserCase>(items: T[], run: BrowserRun) {
  const entries = items.map(item => { const state = browserCaseState(item, [run], { control: true }); return { item, status: state.status, label: state.label, result: run.results?.find(value => value.caseId === item.id) }; });
  if (['queued', 'running'].includes(run.status)) return entries;
  return entries.map((entry, index) => ({ entry, index, rank: journeyPriority(entry.status) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ entry }) => entry);
}

const integer = (value: unknown): value is number => Number.isInteger(value);
export function browserConcurrencyLabel(run: Pick<BrowserRun, 'concurrency' | 'effectiveConcurrency' | 'concurrencyLimit'> | null | undefined) {
  if (!integer(run?.concurrency) || !integer(run.effectiveConcurrency) || run.effectiveConcurrency >= run.concurrency) return '';
  const reason = own(LIMITS, run.concurrencyLimit);
  return `${run.effectiveConcurrency} of ${run.concurrency} browsers${reason ? ` · ${reason}` : ''}`;
}

// Reviewed journeys lead; step-less legacy cases and drafts stay available but grouped.
export function stageJourneyGroups<T extends BrowserCase>(cases: T[], runs: BrowserRun[] = []) {
  const journeys = cases.filter(item => (!item.needsReview && (item.steps?.length ?? 0) > 0) || journeyActive(browserCaseState(item, runs).status));
  return { journeys, others: cases.filter(item => !journeys.includes(item)) };
}

// Case IDs start with a letter or digit, so '!' requests can never collide with a case.
export const JOURNEY_GENERATE_REQUEST = '!generate';
export const journeyRunRequest = (caseId: string) => `!run:${caseId}`;
// A graph Generate request passes the same gates as the toolbar Generate button.
export const generateRequestDialog = ({ disabled = false, unavailable = false, validTarget = false }: { disabled?: boolean; unavailable?: boolean; validTarget?: boolean }) => disabled || unavailable ? null : validTarget ? 'generate' : 'settings';
export function journeyRequest(value = ''): { kind: 'new' | 'generate' | 'run' | 'case' | ''; caseId: string } {
  if (value === 'new') return { kind: 'new', caseId: '' };
  if (value === JOURNEY_GENERATE_REQUEST) return { kind: 'generate', caseId: '' };
  if (value.startsWith('!run:')) return { kind: 'run', caseId: value.slice(5) };
  return { kind: value && !value.startsWith('!') ? 'case' : '', caseId: value.startsWith('!') ? '' : value };
}

export function browserRunTitle(run: Pick<BrowserRun, 'mode' | 'caseIds' | 'caseSummaries'>) {
  if (run.mode === 'discover') return 'Explore product';
  const summaries = run.caseSummaries || [];
  const count = run.caseIds?.length || summaries.length;
  const name = summaries.find(item => item.name?.trim())?.name;
  if (name) return count > 1 ? `${name} + ${count - 1}` : name;
  return count ? `${count} ${count === 1 ? 'test' : 'tests'}` : 'Test run';
}
