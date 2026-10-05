// Check semantics shared by the Playwright journey fixture and its reporter; discovery proposes checks in these terms
// (integrations/browser-use/journey_steps.py validates them).
import type { BrowserCase, CompareNumberCheck, JourneyStep, MilestoneCheck, TextCheck } from '../../business/browser-cases.ts';

export type { JourneyStep, TextCheck };
/** A reviewed milestone check or final assertion, as src/business/browser-cases.ts validates it. */
export type Check = MilestoneCheck;
export type Operator = CompareNumberCheck['op'];
/** How a check fared on the page: observed is the number it read, resolved the text it looked for when that held {run}. */
export type Evaluation = { passed: boolean; observed?: number; resolved?: string; error?: string };
export type EvaluatedCheck<C extends Check = Check> = C & Evaluation;
/** The first number after a label, how far after it that number starts, and whether the label stood on its own there. */
export type Reading = { value: number; gap: number; own: boolean };
/** Numbers read-number checks captured so far, by name. */
export type Captures = Record<string, number>;
/** The approved case snapshot a journey runs against, as far as it reads it: the controller writes it from the reviewed case. */
export type ApprovedCase = Pick<BrowserCase, 'id' | 'name' | 'goal'> & Partial<Pick<BrowserCase, 'steps' | 'assertions' | 'preconditions' | 'expectedOutcomes'>>;
/** The snapshot as a journey process reads it back from its file: its text fields and lists, which the controller validated. */
export function approvedCase(value: unknown): ApprovedCase {
  const snapshot = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!snapshot || (['id', 'name', 'goal'] as const).some(field => typeof snapshot[field] !== 'string')
    || (['steps', 'assertions', 'preconditions', 'expectedOutcomes'] as const).some(field => snapshot[field] !== undefined && !Array.isArray(snapshot[field]))) throw new Error('The approved case snapshot is unreadable.');
  return snapshot as ApprovedCase;
}
/** What the fixture reports to the reporter over the run's event channel, tagged with the case ID. */
export type FixtureEvent =
  | { type: 'journey-stop'; error: string }
  | { type: 'action-feedback'; feedback: string }
  | { type: 'control-read'; eligible: boolean }
  | { type: 'frame'; data: string; timestamp: number }
  | { type: 'journey-step'; stepId: string; status: 'running' | 'completed' | 'failed'; evidence?: string; checks?: EvaluatedCheck[] }
  | { type: 'assertions'; assertions: { type: TextCheck['type']; value: string; passed: boolean; resolved?: string }[] };

/**
 * The version of what the fixture's reviewed checks read. A verification's attempts and an approval record it, so approved
 * code must be verified again when those semantics change. 1: text checks read visible text. 2: they also read
 * what the application put in visible form fields. 3: a caught control requires a fresh persistence read.
 * 4: declared search controls never supply stored-result text evidence.
 */
export const CHECK_VERSION = 4;

// Named fixture steps keep checks private and report sign-in as one action and reload readiness as a wait.
export const STEPS = { checks: 'Perpetual reviewed checks', signIn: 'Perpetual sign-in', reloadReady: 'Perpetual reload readiness' };
export const SIGN_IN_ACTION = 'sign_in_with_test_account';
export const OPERATORS: Record<Operator, (a: number, b: number) => boolean> = { '<': (a, b) => a < b, '>': (a, b) => a > b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
// A sign or currency symbol must touch its digits, so "Credits - 120" reads 120.
const NUMBER = /(?<![\d.,])([-−]?)(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?/g;
const squash = (value: string) => value.split(/\s+/).filter(Boolean).join(' ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first number after a visible label, { value, gap, own }, or null: 1,240, 1240.5, -3 or $12.00.
 * adjacent: only separators may sit between them, so an ancestor's sibling text is never read.
 * The label is read where it stands on its own, not within a longer word (Total, not the end of Subtotal), else where it
 * first occurs, as in scripts that write words without spaces; own says which. A digit beside it, as its own number in
 * Credits10, is no part of a word.
 * A number that another format continues, as 1.240,50, 12,5, 1'240, 1 240 grouped with a no-break space, or 1.2k, is
 * read as NaN rather than as its first part.
 */
export function numberAfter(text: string, label: string, adjacent = false): Reading | null {
  // Digits grouped by a no-break or thin space are one number, which squashing would split into two.
  text = squash(text.replace(/(?<=\d)[   ](?=\d)/gu, "'")); label = squash(label);
  const found = label ? [...text.matchAll(new RegExp(escape(label), 'giu'))] : [];
  const alone = found.find(item => !/\p{L}$/u.test(text.slice(0, item.index)) && !/^\p{L}/u.test(text.slice(item.index + item[0].length)));
  const at = alone ?? found[0];
  if (!at) return null;
  const end = at.index + at[0].length;
  NUMBER.lastIndex = end;
  const match = NUMBER.exec(text);
  if (!match || adjacent && /[\p{L}\p{N}]/u.test(text.slice(end, match.index))) return null;
  const [, sign, whole, fraction] = match, other = /^(?:[.,'’]\d|[kKMB](?![\p{L}\p{N}]))/u.test(text.slice(match.index + match[0].length));
  return { value: other ? NaN : Number(`${sign ? '-' : ''}${whole.replaceAll(',', '')}${fraction || ''}`), gap: match.index - end, own: Boolean(alone) };
}

const originOf = (url: string) => { try { const { protocol, origin } = new URL(url); return ['http:', 'https:'].includes(protocol) ? origin : null; } catch { return null; } };
export const sameOrigin = (url: string, other: string) => Boolean(originOf(url)) && originOf(url) === originOf(other);
export const navigationAllowed = (url: string, allowed: ReadonlySet<string | null>) => url === 'about:blank' || allowed.has(originOf(url));

// Stripe pages accept input only in test mode. A document is judged before it loads, so
// only its path can show test mode here: cs_test_ or /test_, never a live marker. Nothing live loads in any frame.
const stripePath = (url: string) => { try { const { hostname, pathname } = new URL(url); return hostname === 'stripe.com' || hostname.endsWith('.stripe.com') ? pathname : null; } catch { return null; } };
export const stripeLive = (url: string) => /cs_live_|\/live_/.test(stripePath(url) ?? '');
export const paymentAllowed = (url: string) => stripePath(url) === null || !stripeLive(url) && /cs_test_|\/test_/.test(stripePath(url) ?? '');

const LABELS: Partial<Record<string, string>> = { 'url-contains': 'URL contains', 'text-visible': 'Text visible', 'text-absent': 'Text absent' };
const textCheck = (check: Check): check is TextCheck => Boolean(LABELS[check.type]);

// A reviewed check's text may name the run's token as {run}: a journey types a value holding its token, so what one run
// stores is new to every later run, a verification's control run included. The token only fills the reviewed text in;
// it never changes which check runs. The token is 8 lowercase letters or digits, new for every journey process.
export const RUN = '{run}', RUN_TOKEN = /^[a-z0-9]{8}$/;
/** The text of a check that {run} fills in: a text check's value, a number check's label. */
export const checkTemplate = (check: Check) => textCheck(check) ? check.value : check.label;
/**
 * Whether a reviewed check fails when this run's data is missing: text it shows, or a number it reads after a label,
 * holding {run}. A text-absent check passes with nothing saved, and an address can carry typed text with no save, so
 * neither proves the data exists.
 */
export const readsRunData = (check: Check) => (check.type === 'text-visible' || check.type === 'read-number' || check.type === 'compare-number') && checkTemplate(check).includes(RUN);
/** The check the page is judged by: every {run} in its text replaced by the run's token. */
export function resolveCheck<C extends Check>(check: C, token: string): C {
  return textCheck(check) ? { ...check, value: check.value.replaceAll(RUN, token) } : { ...check, label: (check as Exclude<Check, TextCheck>).label.replaceAll(RUN, token) };
}
/**
 * Whether a reported resolved text is the template with every {run} replaced by one run token: the token is read where
 * the first {run} stands, and the template filled in with it must be the text itself.
 */
export function resolvedFrom(template: string, resolved: unknown) {
  if (typeof resolved !== 'string' || !template.includes(RUN)) return false;
  const start = template.indexOf(RUN), token = resolved.slice(start, start + 8);
  return RUN_TOKEN.test(token) && resolved === template.replaceAll(RUN, token);
}

/** One evaluated check in words, for milestone evidence: the check as written, and the text it looked for when that held {run}. */
export function checkText(check: Check & { observed?: number; resolved?: string }, captures: Captures = {}) {
  const resolved = check.resolved ? ` (“${squash(check.resolved)}”)` : '';
  if (textCheck(check)) return `${LABELS[check.type]} “${squash(check.value)}”${resolved}`;
  const value = Number.isFinite(check.observed) ? ` ${check.observed}` : '';
  if (check.type === 'read-number') return `${squash(check.label)}${resolved}${value}`;
  return `${squash(check.label)}${resolved}${value} ${check.op} ${check.than}${Number.isFinite(captures[check.than]) ? ` ${captures[check.than]}` : ''}`;
}
