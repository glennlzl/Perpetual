import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { BlockStatement, CallExpression, File, Identifier, Node, ObjectProperty, Program, Statement } from '@babel/types';
import { readsRunData } from './checks.ts';
import { assertExecutableJourneyChecks, type BrowserCase } from '../../business/browser-cases.ts';

// A journey spec is stage data: the actions of one reviewed case, approved by a person. It runs in the same process
// as the fixture that judges it, so it is an allowlisted grammar, not JavaScript with exceptions: one test of awaited
// milestones, each a list of awaited Playwright actions on page, its locators, keyboard and mouse, whose arguments
// are literals, options objects or locators. A response wait may be armed before one UI action in Promise.all; no
// response value escapes that pair. The one value a spec reads is the run's token, journey.run, alone or in a
// template literal, so a journey can type data no earlier run stored. It names an element or address only after a
// milestone whose reviewed check shows or reads {run}, and so fails when the data is missing: before one, a control
// run's blocked save would fail the action that looks for the data instead of a check. Outside the response pair, no other identifier, assignment, computed access
// or function exists, so checks, page scripts, routing, globals and the runtime stay out of reach. Playwright's bundled Babel parses it,
// the same parser that compiles it for the run.
const MAX_BYTES = 200 * 1024;
type BabelParse = (code: string, filename: string, isModule: boolean) => File;
let parser: BabelParse | null = null;
// The bundle is an untyped internal module: its export is checked to be a function, which returns @babel/parser's File.
function babelParse(): BabelParse {
  const bundle: unknown = createRequire(createRequire(import.meta.url).resolve('@playwright/test'))('playwright/lib/transform/babelBundle');
  const parse = bundle !== null && typeof bundle === 'object' && 'babelParse' in bundle ? bundle.babelParse : undefined;
  if (typeof parse !== 'function') throw new Error("Playwright's bundled Babel parser is unavailable. Run npm install.");
  return parse as BabelParse;
}
const parse = (code: string): Program => (parser ??= babelParse())(code, 'journey.spec.mjs', true).program;

const LOCATE = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'];
const of = <T>(names: string[], value: T): Record<string, T> => Object.fromEntries(names.map(name => [name, value]));
// What each Playwright object may call: a string names the object the call returns; true ends an action.
const API: Record<string, Record<string, string | true>> = {
  page: { ...of(LOCATE, 'locator'), frameLocator: 'frame', ...of(['goto', 'reload', 'goBack', 'goForward', 'waitForURL', 'waitForLoadState', 'waitForTimeout'], true) },
  locator: { ...of([...LOCATE, 'first', 'last', 'nth', 'filter', 'and', 'or'], 'locator'), contentFrame: 'frame', ...of(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'fill', 'clear', 'press', 'pressSequentially', 'type', 'selectOption', 'hover', 'focus', 'blur', 'dragTo', 'scrollIntoViewIfNeeded', 'waitFor'], true) },
  frame: { ...of(LOCATE, 'locator'), frameLocator: 'frame', owner: 'locator' },
  keyboard: of(['press', 'type', 'insertText', 'down', 'up'], true),
  mouse: of(['click', 'dblclick', 'move', 'down', 'up', 'wheel'], true),
};
const PROPERTIES: Record<string, Record<string, string>> = { page: { keyboard: 'keyboard', mouse: 'mouse' } };
const LITERALS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const IMPORT = "Import only the fixture: import { test } from 'perpetual'.";
const TEST = 'A spec contains exactly one test: test(title, async ({ page, journey }) => { … }).';
const MILESTONES = "the test body only awaits journey.milestone('<step id>', async () => { … }) calls.";
const ACTION = "a milestone contains only awaited actions, such as await page.getByRole('button', { name: 'Save' }).click().";
const ARGUMENTS = 'action arguments are literals, options objects or locators; a template literal may hold only ${journey.run}.';
const NAMED = 'journey.run names an element or address only after a milestone whose text-visible, read-number or compare-number check reads {run}; type it with fill, type or pressSequentially, and locate by names that stay the same across runs.';
const TYPED = 'a typing action types text: a string, journey.run or a template literal.';
const GOTO = 'page.goto takes a literal http(s) URL or path; journey.run never makes its address.';
const PERFORMED = "an action performs itself and its page loads: trial and waitUntil: 'commit' are not allowed.";
// The text these actions type may hold journey.run in any milestone.
const TYPING: Record<string, ReadonlySet<string>> = { locator: new Set(['fill', 'type', 'pressSequentially']), keyboard: new Set(['type', 'insertText']) };

function fail(node: Node | null | undefined, message: string): never { throw new Error(`Line ${node?.loc?.start.line ?? 1}: ${message}`); }
const text = (node: Node | null | undefined) => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null;
const named = (node: Node | null | undefined, name: string) => node?.type === 'Identifier' && node.name === name;
const member = (node: Node | null | undefined) => node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : null;
const label = (node: Node): string => node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' ? `${label(node.object)}${member(node) ? `.${member(node)}` : '[…]'}` : node.type === 'CallExpression' ? `${label(node.callee)}()` : '…';
const awaited = (statement: Statement) => statement.type === 'ExpressionStatement' && statement.expression.type === 'AwaitExpression' && statement.expression.argument.type === 'CallExpression' ? statement.expression.argument : null;
const statements = (block: BlockStatement) => block.body.filter(statement => statement.type !== 'EmptyStatement');
const allowed = (owner: string | null, name: string) => owner && Object.hasOwn(API[owner], name) ? API[owner][name] : null;
// journey.run, the run's token, is a string the fixture owns: reading it changes no check.
const token = (node: Node | null | undefined, scope: ReadonlySet<string>) => node?.type === 'MemberExpression' && named(node.object, 'journey') && member(node) === 'run' && scope.has('journey');
const runText = (node: Node, scope: ReadonlySet<string>) => token(node, scope) || node.type === 'TemplateLiteral' && node.expressions.every(item => token(item, scope));

// The Playwright object an expression yields, or null; the arguments of every call on the way are checked.
// runs: whether journey.run may appear here, as typed text or once a reviewed check has read {run}.
function kind(node: Node, scope: ReadonlySet<string>, runs: boolean): string | null {
  if (named(node, 'page')) return scope.has('page') ? 'page' : null;
  if (node.type === 'MemberExpression') { const name = member(node), owner = name && kind(node.object, scope, runs); return owner && name && Object.hasOwn(PROPERTIES[owner] || {}, name) ? PROPERTIES[owner][name] : null; }
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return null;
  const name = member(node.callee), next = name ? allowed(kind(node.callee.object, scope, runs), name) : null;
  if (typeof next !== 'string') return null;
  node.arguments.forEach(item => value(item, scope, runs));
  return next;
}
function value(node: Node, scope: ReadonlySet<string>, runs: boolean) {
  if (LITERALS.has(node.type) || text(node) !== null || node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return;
  if (runText(node, scope)) return runs || fail(node, NAMED);
  if (node.type === 'ArrayExpression') return node.elements.forEach(item => item ? value(item, scope, runs) : fail(node, ARGUMENTS));
  if (node.type === 'ObjectExpression') return node.properties.forEach(item => {
    if (item.type !== 'ObjectProperty') fail(item, ARGUMENTS);
    const key = item.key.type === 'Identifier' ? item.key.name : item.key.type === 'StringLiteral' ? item.key.value : null;
    if (item.computed || item.shorthand || key === null || RESERVED.has(key)) fail(item, ARGUMENTS);
    // A trial action only checks that it could act, and a commit wait returns before the page has content.
    if (key === 'trial' || key === 'waitUntil' && text(item.value) === 'commit') fail(item, PERFORMED);
    value(item.value, scope, runs);
  });
  if (kind(node, scope, runs) !== 'locator') fail(node, ARGUMENTS);
}
// read: whether an earlier milestone's reviewed check read {run}, so journey.run may name an element or address.
function actionCall(call: CallExpression, scope: ReadonlySet<string>, read: boolean) {
  const callee = call.callee, name = member(callee);
  if (callee.type !== 'MemberExpression' || !name) fail(call, ACTION);
  if (named(callee.object, 'journey') && scope.has('journey')) {
    if (name !== 'signIn' || call.arguments.length) fail(call, 'journey.signIn() is the only journey call inside a milestone.');
    return false;
  }
  const owner = kind(callee.object, scope, read);
  if (allowed(owner, name) !== true) fail(call, `${label(callee)} is not an allowed journey action.`);
  // An address is a literal: journey.run never makes one.
  if (owner === 'page' && name === 'goto' && !/^https?:$/.test(URL.parse(text(call.arguments[0]) ?? 'about:', 'http://perpetual.invalid/')?.protocol ?? '')) fail(call, GOTO);
  // Only the text a typing action types may hold journey.run in any milestone; Playwright types nothing but text.
  const typing = owner !== null && TYPING[owner]?.has(name) === true;
  call.arguments.forEach((item, index) => {
    if (!typing || index) return value(item, scope, read);
    if (text(item) !== null || runText(item, scope)) return;
    value(item, scope, read);
    fail(item, TYPED);
  });
  const input = call.arguments[0];
  return typing && Boolean(input && (token(input, scope) || input.type === 'TemplateLiteral' && input.expressions.some(part => token(part, scope))));
}

function action(statement: Statement, scope: ReadonlySet<string>, read: boolean) {
  const call = awaited(statement);
  if (!call) fail(statement, ACTION);
  if (call.callee.type !== 'MemberExpression' || !named(call.callee.object, 'Promise')) return actionCall(call, scope, read);
  // Arm an observed response before its UI action. No response value, predicate, callback or arbitrary parallel work
  // is exposed. Both real writes and the control's blocked replies settle; reviewed checks still judge the fresh read.
  const message = 'Only await Promise.all([page.waitForResponse("observed URL pattern"), one UI action]) is allowed.';
  const pair = call.arguments[0];
  if (member(call.callee) !== 'all' || call.arguments.length !== 1 || pair?.type !== 'ArrayExpression' || pair.elements.length !== 2) fail(call, message);
  const [response, trigger] = pair.elements;
  if (response?.type !== 'CallExpression' || response.callee.type !== 'MemberExpression' || !named(response.callee.object, 'page') || !scope.has('page') || member(response.callee) !== 'waitForResponse'
    || response.arguments.length > 2) fail(call, message);
  const pattern=response.arguments[0];
  if(!text(pattern)&&!(pattern?.type==='TemplateLiteral'&&pattern.quasis.some(part=>Boolean(part.value.cooked))&&runText(pattern,scope)))fail(call,message);
  // Like a locator or URL wait, a later response pattern may identify data already proved by a reviewed check.
  // The token is never a bare address or an option value, and before that proof only literal patterns are allowed.
  response.arguments.forEach((item,index) => value(item, scope, index===0&&read));
  if (trigger?.type !== 'CallExpression' || trigger.callee.type !== 'MemberExpression' || !['locator', 'keyboard', 'mouse'].includes(kind(trigger.callee.object, scope, read) ?? '')) fail(call, message);
  return actionCall(trigger, scope, read);
}

export const specHash = (code: string | Buffer) => createHash('sha256').update(code).digest('hex');
/** The reviewed contract an approval binds to: editing the goal, steps, checks, assertions or outcomes makes it stale. */
export const caseHash = (item: Pick<BrowserCase, 'goal'> & Partial<BrowserCase>) => specHash(JSON.stringify([item.goal, item.preconditions || [], item.steps || [], item.expectedOutcomes || [], item.assertions || []]));

/** The spec's code, when it performs exactly the case's reviewed milestones, in order, in the allowed grammar. */
export function validateJourneySpec(code: unknown, item: Partial<Pick<BrowserCase, 'steps' | 'assertions'>>): string {
  assertExecutableJourneyChecks(item);
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > MAX_BYTES || code.includes('\0')) throw new Error('Provide a spec of at most 200 KB.');
  let program: Program;
  try { program = parse(code); } catch (error) { const { loc } = error as { loc?: { line: number } }; throw new Error(`The spec is not valid JavaScript${loc ? ` (line ${loc.line})` : ''}.`); }
  const [head, ...rest] = program.body;
  const fixture = head?.type === 'ImportDeclaration' && head.source.value === 'perpetual' && head.importKind !== 'type' && !head.phase && !head.attributes?.length && head.specifiers.length === 1
    && head.specifiers[0].type === 'ImportSpecifier' && named(head.specifiers[0].imported, 'test') && named(head.specifiers[0].local, 'test');
  if (!fixture || rest.some(node => /^(?:Import|Export)/.test(node.type))) throw new Error(IMPORT);
  const call = rest.length === 1 && !program.directives.length && rest[0].type === 'ExpressionStatement' ? rest[0].expression : null;
  const [title, body] = call?.type === 'CallExpression' && named(call.callee, 'test') && call.arguments.length === 2 ? call.arguments : [];
  const [fixtures, ...others] = body?.type === 'ArrowFunctionExpression' ? body.params : [];
  if (!(text(title) !== null && body?.type === 'ArrowFunctionExpression' && body.async && body.body.type === 'BlockStatement' && !body.body.directives.length && !others.length
    && (!fixtures || fixtures.type === 'ObjectPattern' && fixtures.properties.every(item => item.type === 'ObjectProperty' && item.shorthand && !item.computed && item.key.type === 'Identifier' && ['page', 'journey'].includes(item.key.name) && named(item.value, item.key.name))))) throw new Error(TEST);
  // Every fixture property is a shorthand page or journey, as checked above.
  const scope = new Set((fixtures?.properties || []).map(item => (item as ObjectProperty & { key: Identifier }).key.name)), ids: (string | null | undefined)[] = [];
  // Milestones pair with the reviewed steps in order.
  const steps = item.steps || [], expected = steps.map(step => step.id);
  const order = () => new Error(`Call journey.milestone once per reviewed step, in order, with its literal ID: ${expected.join(', ') || 'none'}.`);
  let read = false, typedRun = false;
  const requireRunInput = () => { if (!typedRun) throw new Error('A reviewed check reads this run’s data, but no preceding input uses the run token. Type journey.run or a template literal such as `Note ${journey.run}`, never the literal text “journey.run”.'); };
  for (const statement of statements(body.body)) {
    const milestone = awaited(statement), [id, actions] = milestone?.arguments || [];
    if (!milestone || milestone.callee.type !== 'MemberExpression' || !named(milestone.callee.object, 'journey') || member(milestone.callee) !== 'milestone' || !scope.has('journey') || milestone.arguments.length !== 2) fail(statement, MILESTONES);
    if (actions?.type !== 'ArrowFunctionExpression' || !actions.async || actions.params.length || actions.body.type !== 'BlockStatement' || actions.body.directives.length) fail(actions, 'milestone actions are async () => { … }.');
    // The order is judged before the actions, so a milestone's actions are read against its own reviewed step.
    if (ids.push(text(id)) > expected.length || ids.at(-1) !== expected[ids.length - 1]) throw order();
    for (const step of statements(actions.body)) typedRun = action(step, scope, read) || typedRun;
    const reads = (steps[ids.length - 1]?.checks || []).some(readsRunData);
    if (reads) requireRunInput();
    read ||= reads;
  }
  if (ids.length !== expected.length) throw order();
  if ((item.assertions ?? []).some(readsRunData)) requireRunInput();
  return code;
}

/** A spec that signs in needs the run's test account; a valid spec calls journey.signIn only as an action. */
export function signsIn(code: string) {
  const search = (node: unknown): boolean => Array.isArray(node) ? node.some(search) : typeof node === 'object' && node !== null
    && (named((node as { object?: Node }).object, 'journey') && member(node as Node) === 'signIn' || Object.entries(node).some(([key, child]) => key !== 'loc' && typeof child === 'object' && search(child)));
  try { return search(parse(code)); } catch { return false; }
}
