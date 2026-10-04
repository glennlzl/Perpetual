import { randomUUID } from 'node:crypto';
import { businessSourceContext, redactBusinessText } from './discovery.ts';
import { REDACTED } from '../redaction.ts';
import type { ModelSource } from './discovery.ts';

import type { TextCheck, CompareNumberCheck, MilestoneCheck, JourneyStep, FinalAssertion, SourceEvidence, Isolation, BrowserCase } from '../../contract/browser.ts';
export type { TextCheck, ReadNumberCheck, CompareNumberCheck, MilestoneCheck, JourneyStep, FinalAssertion, SourceEvidence, Isolation, BrowserCase } from '../../contract/browser.ts';

/** A proposed journey discovery could not accept, and why. */
export type OmittedCase = { name: string; reason: string };

const CASE_KEYS = new Set(['id', 'name', 'goal', 'steps', 'isolation', 'preconditions', 'expectedOutcomes', 'assertions', 'selected', 'needsReview', 'evidence']);
const CHECKS: ReadonlySet<unknown> = new Set<TextCheck['type']>(['url-contains', 'text-visible', 'text-absent']);
const STEP_CHECKS: ReadonlySet<unknown> = new Set<MilestoneCheck['type']>(['url-contains', 'text-visible', 'text-absent', 'read-number', 'compare-number']);
const OPERATORS: ReadonlySet<unknown> = new Set<CompareNumberCheck['op']>(['<', '>', '=', '!=']);
const ISOLATIONS: ReadonlySet<unknown> = new Set<Isolation>(['shared', 'isolated']);
const isTextCheck = (type: unknown): type is TextCheck['type'] => CHECKS.has(type);
const isStepCheck = (type: unknown): type is MilestoneCheck['type'] => STEP_CHECKS.has(type);
const isOperator = (op: unknown): op is CompareNumberCheck['op'] => OPERATORS.has(op);
const isIsolation = (value: unknown): value is Isolation => ISOLATIONS.has(value);
const CAPTURE = /^[a-z][A-Za-z0-9]{0,39}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} must contain ${empty ? 0 : 1}–${max} characters.`);
  return value.trim();
}
function keys(value: unknown, allowed: ReadonlySet<string>, label: string): asserts value is Record<string, unknown> {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
function texts(value: unknown, label: string, { required = false } = {}): string[] {
  if (!Array.isArray(value) || value.length > 20 || (required && !value.length)) throw new Error(`${label} must contain ${required ? 1 : 0}–20 items.`);
  return value.map(item => text(item, label, 2000));
}
function evidence(value: unknown): SourceEvidence[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error('Evidence must contain at most 40 source references.');
  return value.map(item => {
    keys(item, new Set(['path', 'line']), 'evidence');
    const name = text(item.path, 'Evidence path', 1024);
    if (name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part.startsWith('.')) || /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$|(?:^|\/)(?:secrets?|credentials?)(?:\.|\/|$)|\.(?:pem|key|p12)$/i.test(name)) throw new Error('Evidence must reference a repository source file.');
    if (typeof item.line !== 'number' || !Number.isInteger(item.line) || item.line < 1 || item.line > 1000000) throw new Error('Evidence line must be a positive integer.');
    return { path: name, line: item.line };
  });
}

/** The runner evaluates these on the live page; the model never supplies observed values. */
function milestoneChecks(value: unknown, captures: Set<string>): MilestoneCheck[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error('Provide at most 6 checks per journey step.');
  return value.map((check): MilestoneCheck => {
    if (!object(check) || !isStepCheck(check.type)) throw new Error('Unsupported milestone check type.');
    if (isTextCheck(check.type)) {
      keys(check, new Set(['type', 'value']), 'milestone check');
      return { type: check.type, value: text(check.value, 'Milestone check value', 4000) };
    }
    keys(check, new Set(check.type === 'read-number' ? ['type', 'label', 'name'] : ['type', 'label', 'name', 'op', 'than']), 'milestone check');
    const label = text(check.label, 'Milestone check label', 120);
    if (typeof check.name !== 'string' || !CAPTURE.test(check.name)) throw new Error('Milestone check names start with a lowercase letter and use up to 40 letters or digits.');
    if (check.type === 'read-number') { captures.add(check.name); return { type: check.type, label, name: check.name }; }
    if (!isOperator(check.op)) throw new Error('Choose a milestone check comparison: <, >, = or !=.');
    if (typeof check.than !== 'string' || !captures.has(check.than)) throw new Error('A milestone check can only compare with an earlier read-number check.');
    return { type: 'compare-number', label, name: check.name, op: check.op, than: check.than };
  });
}

/** Milestones describe business progress, never executable browser commands. */
function journeySteps(value: unknown): JourneyStep[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Provide at most 12 journey steps.');
  const ids = new Set<string>(), captures = new Set<string>();
  return value.map((step: unknown) => {
    keys(step, new Set(['id', 'title', 'checks']), 'journey step');
    const id = text(step.id, 'Journey step ID', 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ids.has(id)) throw new Error('Journey step IDs must be valid and unique within the case.');
    ids.add(id);
    const title = text(step.title, 'Journey step title', 240), checks = milestoneChecks(step.checks ?? [], captures);
    return { id, title, ...(checks.length ? { checks } : {}) };
  });
}

/** A reviewed journey needs an observation independent of its generated actions. */
export const hasJourneyChecks = (item: Pick<BrowserCase, 'steps' | 'assertions'>): boolean => item.assertions.length > 0 || item.steps.some(step => Boolean(step.checks?.length));

/** Catch whole-value descriptive placeholders; markup/template syntax may itself be legitimate literal content. */
export function assertExecutableJourneyChecks(item: Partial<Pick<BrowserCase, 'steps' | 'assertions' | 'expectedOutcomes'>>): void {
  const checks = [...(item.steps ?? []).flatMap(step => step.checks ?? []), ...(item.assertions ?? [])];
  for (const check of checks) {
    const value = 'value' in check ? check.value : check.label;
    if (/^<(?:the\s+)?(?:unique|generated|entered|saved|created)\s+[\p{L}][\p{L}\p{N} _-]{0,160}>$/iu.test(value.trim())) {
      throw new Error('Replace the unresolved check placeholder with a concrete expected value. Use {run} for this run’s data, for example “Note {run}”.');
    }
  }
  // Only an explicit run-owned outcome triggers this admission rule. Do not guess
  // whether a goal writes data, or classify business meaning from UI words.
  if (item.expectedOutcomes?.some(outcome => outcome.includes('{run}')) && !checks.some(check => check.type === 'compare-number' || (check.type === 'text-visible' || check.type === 'text-absent') && check.value.includes('{run}'))) {
    throw new Error('Add a persisted outcome check using {run}, or a before/after number comparison. Navigation and static labels alone cannot verify this run’s outcome.');
  }
}

/** New or edited reviewed cases need milestones and checks; stored legacy cases stay readable. */
export function assertReviewedJourneys(cases: readonly BrowserCase[], stored: readonly BrowserCase[] = []): void {
  const unchanged = (item: BrowserCase) => JSON.stringify({ ...item, selected: false });
  const previous = new Map(stored.map(item => [item.id, unchanged(item)]));
  for (const item of cases) {
    if (item.needsReview || previous.get(item.id) === unchanged(item)) continue;
    assertExecutableJourneyChecks(item);
    if (item.steps.length < 2 || item.steps.length > 12) throw new Error(`Add 2–12 milestones before approving “${item.name}”.`);
    if (!hasJourneyChecks(item)) throw new Error(`Add at least one milestone check or final assertion before reviewing “${item.name}”.`);
  }
}

/** Goal-based cases. Empty checks are allowed but cannot yield an independently verified pass. */
export function validateBrowserCases(cases: unknown, { draft = true } = {}): BrowserCase[] {
  if (!Array.isArray(cases) || cases.length > 60) throw new Error('Provide at most 60 browser cases.');
  const ids = new Set<string>();
  return cases.map((item: unknown): BrowserCase => {
    keys(item, CASE_KEYS, 'browser case');
    const id = text(item.id ?? randomUUID(), 'Case ID', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error('Invalid case ID.');
    if (ids.has(id)) throw new Error('Duplicate browser case ID.');
    ids.add(id);
    for (const field of ['selected', 'needsReview']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw new Error(`${field} must be a boolean.`);
    // Checked above: each is a boolean or undefined.
    const selected = (item.selected ?? false) as boolean, needsReview = (item.needsReview ?? draft) as boolean;
    if (selected && needsReview) throw new Error('Review this browser case before selecting it.');
    const isolation = item.isolation ?? 'shared';
    if (!isIsolation(isolation)) throw new Error('Choose shared or isolated test data.');
    const checks = item.assertions ?? [];
    if (!Array.isArray(checks) || checks.length > 20) throw new Error('Provide at most 20 assertions.');
    const assertions = checks.map((check: unknown): FinalAssertion => {
      keys(check, new Set(['type', 'value']), 'assertion');
      if (!isTextCheck(check.type)) throw new Error('Unsupported browser assertion type.');
      return { type: check.type, value: text(check.value, 'Assertion value', 2000) };
    });
    const result = {
      id, name: text(item.name, 'Case name', 120), goal: text(item.goal, 'Business goal', 4000),
      steps: journeySteps(item.steps ?? []), isolation,
      preconditions: texts(item.preconditions ?? [], 'Preconditions'),
      expectedOutcomes: texts(item.expectedOutcomes, 'Expected outcomes', { required: true }),
      assertions, selected, needsReview, evidence: evidence(item.evidence ?? []),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('Browser case exceeds 64 KiB.');
    return result;
  });
}

/** Supplied files and source lines are data, not Agent instructions. */
export async function browserDiscoveryContext({ repoPath, scope = '', requirements = '' }: { repoPath?: string; scope?: string; requirements?: string } = {}): Promise<string> {
  const source = repoPath ? await businessSourceContext(repoPath, { scope: `${scope}\n${requirements}` }) : { files: [], warnings: [] };
  return JSON.stringify({
    scope: redactBusinessText(text(scope, 'Scope', 4000, true)),
    requirements: redactBusinessText(text(requirements, 'Requirements', 20000, true)),
    ...source,
  });
}

/** The source files of a browserDiscoveryContext result, read back: each with its path and numbered source. */
export function sourceFiles(sourceContext: string): ModelSource[] {
  const context: unknown = JSON.parse(sourceContext), files = object(context) ? context.files : undefined;
  if (!files) return [];
  if (!Array.isArray(files) || !files.every((file): file is ModelSource => object(file) && typeof file.path === 'string' && typeof file.source === 'string')) throw new Error('The source context is unreadable.');
  return files;
}

/**
 * Child/model output cannot approve itself or claim nonexistent source evidence. A citation to a
 * line that was not supplied is dropped, and an invalid journey is omitted with its reason, so one
 * bad proposal never discards a whole paid discovery. When no proposed journey is valid, every
 * omission is still returned so the caller can keep the reasons.
 */
export function discoveredBrowserCases(cases: unknown, sourceContext = '{}'): { cases: BrowserCase[]; omitted: OmittedCase[] } {
  if (!Array.isArray(cases) || cases.length > 4) throw new Error('Agent discovery must return at most four complete business journeys.');
  // The controller's own browserDiscoveryContext output.
  const supplied = new Map<unknown, ReadonlySet<unknown>>(sourceFiles(sourceContext).map(file => [file.path, new Set(file.source.split('\n').map(line => Number(line.match(/^(\d+):\s*\S/)?.[1])).filter(Number.isFinite))]));
  const cited = (ref: unknown) => object(ref) && supplied.get(ref.path)?.has(ref.line) === true;
  const ids = new Set<string>(), accepted: BrowserCase[] = [], omitted: OmittedCase[] = [];
  for (const proposal of cases as unknown[]) {
    try {
      const candidate = object(proposal) && Array.isArray(proposal.evidence) ? { ...proposal, evidence: proposal.evidence.filter(cited) } : proposal;
      const [item] = validateBrowserCases([{ ...candidate as object, selected: false, needsReview: true, isolation: 'shared' }], { draft: true });
      if (ids.has(item.id)) throw new Error('Duplicate browser case ID.');
      if (item.steps.length < 2) throw new Error('Generated journeys need at least two ordered business steps.');
      if (JSON.stringify(item).includes(REDACTED)) throw new Error('Redacted source content cannot be used as test input.');
      ids.add(item.id);
      accepted.push(item);
    } catch (error) {
      const plain = (value: unknown, max: number) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
      omitted.push({ name: object(proposal) && typeof proposal.name === 'string' && plain(proposal.name, 120) || 'Untitled journey', reason: plain((error as Error).message, 200) });
    }
  }
  return { cases: accepted, omitted };
}

/** A drafted case must be acceptable: fails with every reason when no proposed journey is valid. */
export function validateDiscoveredBrowserCases(cases: unknown, sourceContext?: string): BrowserCase[] {
  const { cases: accepted, omitted } = discoveredBrowserCases(cases, sourceContext);
  if (!accepted.length && omitted.length) throw new Error(omitted.map(item => item.reason).join(' '));
  return accepted;
}
