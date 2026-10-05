// Turns one journey's `playwright test` process into the browser worker contract (src/browser/runtime.ts):
// one JSON event per stdout line. The fixture's events arrive as worker output tagged with the run's channel
// token; Playwright's steps become the live action list; the test's end becomes the journey's result facts.
import { copyFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { FullResult, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import { SIGN_IN_ACTION, STEPS, approvedCase, type ApprovedCase } from './checks.ts';
import { hide, failureText } from '../../redaction.ts';
import { lifecycleEvent, lifecycleError } from './diagnostics.ts';

/** One journey action in the live list, as the browser worker contract reports it. */
export type JourneyAction = { type: string; status: 'running' | 'passed' | 'failed' | 'cancelled' };
/** The facts a finished journey reports; the controller decides its status from them (src/browser/results.ts). */
export type JourneyFacts = { caseId: string; assertions: { passed?: unknown }[]; stopCause: 'none' | 'deadline' | 'action'; controlRead?: boolean; error?: string; actionFeedback?: string };
// A fixture event read back from the channel: the fixture writes it, but it is parsed text until each field is checked.
type ChannelEvent = { caseId?: unknown; type?: unknown; status?: unknown; stepId?: unknown; assertions?: unknown; error?: unknown; eligible?: unknown; lifecycle?: unknown; feedback?: unknown };

// Journey actions by Playwright step title; fixture reads stay private while explicit readiness waits are visible.
const ACTIONS: [RegExp, string][] = [[/^Navigate\b/, 'navigate'], [/^Reload\b/, 'reload_page'], [/^Go back\b/, 'go_back'], [/^(?:Click|Double click|Tap|Check|Uncheck|Set checked|Drag)\b/, 'click'], [/^(?:Fill|Type|Press sequentially|Clear)\b/, 'input'], [/^Press\b/, 'send_keys'], [/^Select option\b/, 'select_option'], [/^Hover\b/, 'hover'], [/^Scroll\b/, 'scroll'], [/^Wait for (?:timeout|URL|navigation|load state)\b/i, 'wait']];
const FORWARDED = new Set<unknown>(['frame', 'journey-step']);
const plain = (value: unknown) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').replace(/^\s*Error:\s*/, '');

export default class JourneyReporter implements Reporter {
  channel: string | undefined; approved: ApprovedCase; videoDir: string | undefined; secrets: string[];
  controlRead: boolean | undefined;
  actionFeedback: string | undefined;
  diagnostics = process.env.PERPETUAL_LIFECYCLE_DIAGNOSTICS === '1' && process.env.PERPETUAL_BLOCK_WRITES !== '1';
  diagnosticBytes = 0; diagnosticDropped = 0;
  buffer = ''; actions: JourneyAction[] = []; indexes = new Map<TestStep, number>(); running: unknown = null; checkFailed = false;
  assertions: { passed?: unknown }[] = []; stop: string | null = null; result: TestResult | null = null; errors: TestError[] = [];
  constructor() {
    const env = process.env;
    this.channel = env.PERPETUAL_EVENT_CHANNEL;
    // The runtime writes the approved case snapshot for every journey process.
    this.approved = approvedCase(JSON.parse(readFileSync(env.PERPETUAL_CASE!, 'utf8')));
    this.videoDir = env.PERPETUAL_VIDEO_DIR;
    this.secrets = [env.PERPETUAL_ACCOUNT_USERNAME, env.PERPETUAL_ACCOUNT_PASSWORD].filter((value): value is string => Boolean(value));
  }
  // The event protocol owns stdout, so Playwright adds no reporter of its own.
  printsToStdio() { return true; }
  write(event: unknown) { process.stdout.write(`${JSON.stringify(event)}\n`); }
  safe(text: unknown) { return failureText(hide(this.secrets)(plain(text)).split('\n')[0].trim(), 300); }
  diagnostic(value: unknown) {
    if (!this.diagnostics) return;
    const event = lifecycleEvent(value);
    if (!event || !['fixture', 'reporter'].includes(event.source)) return;
    // Keep the terminal summary even after chatty pages fill the optional pipe's budget.
    const terminal = event.source === 'reporter' && event.name === 'reporter-end';
    const line = JSON.stringify({ at: Date.now(), ...event, ...(terminal ? { dropped: this.diagnosticDropped } : {}) }) + '\n';
    if (line.length > 1024 || !terminal && this.diagnosticBytes + Buffer.byteLength(line) > 192 * 1024) { this.diagnosticDropped++; return; }
    this.diagnosticBytes += Buffer.byteLength(line);
    try { writeSync(3, line); } catch { /* A missing/full diagnostic pipe must not affect Playwright. */ }
  }
  sendActions() { this.write({ type: 'case', caseId: this.approved.id, actions: this.actions.slice(-150) }); }
  onBegin() { this.sendActions(); }
  onStdOut(chunk: string | Buffer) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!this.channel || !line.startsWith(this.channel)) continue;
      let parsed: unknown; try { parsed = JSON.parse(line.slice(this.channel.length)); } catch { continue; }
      const event: ChannelEvent | null = parsed !== null && typeof parsed === 'object' ? parsed : null;
      if (event?.caseId !== this.approved.id) continue;
      if (event.type === 'lifecycle') {
        const lifecycle = lifecycleEvent(event.lifecycle);
        if (lifecycle?.source === 'fixture') this.diagnostic(lifecycle);
        continue;
      }
      if (FORWARDED.has(event.type)) {
        if (event.type === 'journey-step') { this.running = event.status === 'running' ? event.stepId : null; this.checkFailed ||= event.status === 'failed'; }
        this.write(event);
      } else if (event.type === 'assertions' && Array.isArray(event.assertions)) this.assertions = event.assertions;
      else if (event.type === 'action-feedback' && typeof event.feedback === 'string' && event.feedback.length <= 2000) this.actionFeedback = failureText(hide(this.secrets)(event.feedback), 2000);
      else if (event.type === 'control-read' && typeof event.eligible === 'boolean') this.controlRead = event.eligible;
      else if (event.type === 'journey-stop' && typeof event.error === 'string') this.stop ||= event.error;
    }
  }
  // Calls inside setup or reviewed checks stay private. Sign-in and reload readiness have one named action each.
  action(step: TestStep) {
    for (let parent = step.parent; parent; parent = parent.parent) if (['fixture', 'hook'].includes(parent.category) || parent.category === 'test.step' && [STEPS.checks, STEPS.signIn].includes(parent.title)) return null;
    if (step.category === 'test.step') return step.title === STEPS.signIn ? SIGN_IN_ACTION : step.title === STEPS.reloadReady ? 'wait' : null;
    return step.category === 'pw:api' ? ACTIONS.find(([pattern]) => pattern.test(step.title))?.[1] || null : null;
  }
  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep) {
    const type = this.action(step);
    if (type === 'reload_page') this.diagnostic({ source: 'reporter', name: 'reload-begin' });
    if (!type) return;
    this.indexes.set(step, this.actions.length); this.actions.push({ type, status: 'running' }); this.sendActions();
  }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    const index = this.indexes.get(step);
    if (index === undefined) return;
    if (this.actions[index].type === 'reload_page') this.diagnostic({ source: 'reporter', name: 'reload-end', error: lifecycleError(step.error) });
    this.actions[index].status = step.error ? 'failed' : 'passed'; this.sendActions();
  }
  onError(error: TestError) { this.errors.push(error); }
  onTestEnd(_test: TestCase, result: TestResult) { this.result = result; this.diagnostic({ source: 'reporter', name: 'test-end', status: result.status }); }
  // Facts, never a verdict: the controller decides status from these, the milestones and the approved case.
  facts(): JourneyFacts {
    const { id: caseId, steps = [] } = this.approved, result = this.result;
    const base = { caseId, assertions: this.assertions, ...(this.controlRead === undefined ? {} : { controlRead: this.controlRead }) };
    if (result?.status === 'passed') return { ...base, stopCause: 'none' };
    if (result?.status === 'timedOut') return { ...base, stopCause: 'deadline' };
    // A reviewed check that failed decides the journey; the error that stopped it adds nothing.
    if (this.checkFailed || this.assertions.some(item => item.passed === false)) return { ...base, stopCause: 'none' };
    const title = steps.find(step => step.id === this.running)?.title;
    const error = this.stop || this.safe((result?.errors || this.errors)[0]?.message) || 'The spec stopped before the journey ended.';
    return { ...base, stopCause: 'action', error: title ? `Action failed at “${title}”: ${error}` : error, ...(this.actionFeedback ? { actionFeedback: this.actionFeedback } : {}) };
  }
  async onEnd(full: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    this.diagnostic({ source: 'reporter', name: 'reporter-end', status: full.status, failed: full.status !== 'passed' || this.result?.status !== 'passed' });
    for (const action of this.actions) if (action.status === 'running') action.status = 'cancelled';
    this.sendActions();
    // Each page's recording, including a skipped journey's, named as the controller serves it.
    const files: string[] = [];
    if (this.videoDir) for (const attachment of this.result?.attachments || []) {
      if (attachment.name !== 'video' || !attachment.path) continue;
      const name = `page@${randomBytes(16).toString('hex')}.webm`;
      try { if ((await stat(attachment.path)).size) { await copyFile(attachment.path, join(this.videoDir, name)); files.push(name); } } catch { /* An unfinished recording is left out, never an error. */ }
    }
    if (files.length) this.write({ type: 'video', caseId: this.approved.id, files });
    // Only the controller interrupts a journey, and it decides that journey's result itself.
    if (full.status === 'interrupted') return;
    this.write({ type: 'result', result: this.facts() });
    return { status: 'passed' };
  }
}
