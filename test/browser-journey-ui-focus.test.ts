import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewFocus, dialogOpener, restoreFocus } from '../client/src/lib/journey-focus.ts';

const element = (log: string[], name: string) => ({ name, focus: () => log.push(name) });
const source = (path: string) => readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');

test('entering focus mode moves focus to the focused journey heading', () => {
  const log: string[] = [], focus = createViewFocus();
  focus.heading(element(log, 'heading'));
  assert.equal(focus.settle(), false);
  focus.enter();
  assert.equal(focus.settle(), true);
  assert.deepEqual(log, ['heading']);
  assert.equal(focus.settle(), false);
});
test('leaving focus mode returns focus to that journey card', () => {
  const log: string[] = [], focus = createViewFocus();
  const ref = focus.card('happy');
  assert.equal(focus.card('happy'), ref);
  ref(element(log, 'happy'));
  focus.card('payment')(element(log, 'payment'));
  focus.leave('happy');
  focus.settle();
  assert.deepEqual(log, ['happy']);
  ref(null);
  focus.leave('happy');
  assert.equal(focus.settle(), false);
});
test('journey controls use shadcn components and the gallery keeps focus on view switches', async () => {
  for (const file of ['BrowserLiveFrame.tsx', 'JourneyCard.tsx', 'JourneySteps.tsx', 'JourneyEvidence.tsx', 'JourneyRecording.tsx', 'JourneyStepEditor.tsx', 'RunJourneyGallery.tsx', 'StageJourney.tsx', 'StageJourneyList.tsx']) assert.doesNotMatch(await source(file), /<button[\s>]/, file);
  const gallery = await source('RunJourneyGallery.tsx');
  assert.match(gallery, /headingRef=\{viewFocus\.heading\}/);
  // The focus view is reused across journeys, so each journey's player starts on its first tab.
  for (const file of ['RunJourneyGallery.tsx', 'JourneyCard.tsx']) assert.match(await source(file), /<JourneyRecording key=\{`\$\{run\.id\}:\$\{item\.id\}`\}/, file);
  assert.match(gallery, /focusRef=\{viewFocus\.card\(item\.id\)\}/);
  assert.doesNotMatch(gallery, /defaultOpen/);
});
test('journey styles have no ambient looping animation', async () => {
  const css = (await source('workspace.css')).split('\n').filter(line => line.includes('journey'));
  assert.ok(css.length > 0);
  for (const line of css) assert.doesNotMatch(line, /infinite/);
});
test('loading spinners stop under reduced motion', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../client/src/', import.meta.url), { recursive: true })).filter(file => /\.(tsx|ts)$/.test(file));
  assert.ok(files.length > 0);
  for (const file of files) assert.doesNotMatch(await source(file), /(?<![\w:-])animate-spin/, file);
});

// Minimal DOM stand-ins: an element knows its menu ancestor, its attributes and whether it is attached.
type FocusLog = [name: string, options: FocusOptions | undefined][];
const node = (name: string, log: FocusLog, { attrs = {}, menu = null, connected = true, disabled = false, inert = false }: { attrs?: Record<string, string>; menu?: { id: string } | null; connected?: boolean; disabled?: boolean; inert?: boolean } = {}) => ({
  name, isConnected: connected, disabled,
  getAttribute: (key: string) => attrs[key] ?? null,
  closest: (selector: string) => selector === '[role="menu"]' ? menu : selector === '[inert]' && inert ? {} : null,
  focus: (options?: FocusOptions) => log.push([name, options]),
});
test('a dialog without a trigger returns focus to its opener, or a menu item\'s menu trigger', () => {
  const log: FocusLog = [], body = node('body', log);
  const button = node('Edit test settings', log);
  assert.equal(dialogOpener({ body, activeElement: button, querySelectorAll: () => [] }), button);
  assert.equal(dialogOpener({ body, activeElement: body, querySelectorAll: () => [] }), null, 'Focus on <body> is no opener');
  const menu = { id: 'radix-«r7»' };
  const other = node('Actions for Refund', log, { attrs: { 'aria-haspopup': 'menu' } });
  const trigger = node('Actions for Checkout', log, { attrs: { 'aria-haspopup': 'menu', 'aria-controls': 'radix-«r7»', 'data-state': 'open' } });
  const item = node('Edit', log, { menu });
  assert.equal(dialogOpener({ body, activeElement: item, querySelectorAll: () => [other, trigger] }), trigger);
  const open = node('Actions', log, { attrs: { 'aria-haspopup': 'menu', 'data-state': 'open' } });
  assert.equal(dialogOpener({ body, activeElement: node('Delete', log, { menu: { id: '' } }), querySelectorAll: () => [other, open] }), open, 'Without ids, the open menu trigger stands in');
});
test('focus falls back when the opener is gone, disabled or inert', () => {
  const log: FocusLog = [];
  const gone = node('deleted case actions', log, { connected: false });
  const disabled = node('busy button', log, { disabled: true });
  const inert = node('behind a modal', log, { inert: true });
  const card = node('case card', log);
  assert.equal(restoreFocus([gone, disabled, inert, null, card]), card);
  assert.deepEqual(log, [['case card', { preventScroll: true }]]);
  assert.equal(restoreFocus([gone, undefined]), null);
});
test('every dialog opened inside the inspector restores focus when it closes', async () => {
  const panel = await source('BrowserTestingPanel.tsx');
  for (const name of ['TestSettingsDialog', 'GenerateTestsDialog', 'RunTestsDialog', 'BusinessCaseEditor', 'ConfirmCaseDialog']) {
    const body = panel.slice(panel.indexOf(`function ${name}(`));
    const component = body.slice(0, body.indexOf('\n}\n'));
    assert.match(component, /const returnFocus = useReturnFocus\(focusFallback\);/, name);
    assert.match(component, /Content [^\n]*onCloseAutoFocus=\{returnFocus\}/, name);
  }
  for (const [name, fallback] of [['BusinessCaseEditor', 'focusCase\\(editingCase\\.id\\)'], ['ConfirmCaseDialog', 'sheet'], ['ConfirmCaseDialog', 'focusCase\\(discarding\\.item\\.id\\)'], ['TestSettingsDialog', 'focusSettings'], ['GenerateTestsDialog', 'sheet'], ['NewTestDialog', 'sheet']]) assert.match(panel, new RegExp(`<${name} [^\\n]*focusFallback=\\{${fallback}\\}`), name);
  assert.match(panel, /const sheet = \(\) => root\.current\?\.closest(?:<\w+>)?\('\[data-slot="sheet-content"\]'\) \|\| null;/);
  for (const file of ['NewTestDialog.tsx', 'BrowserAgentViewer.tsx']) {
    const dialog = await source(file);
    assert.match(dialog, /const returnFocus = useReturnFocus\(focusFallback\);/, file);
    assert.match(dialog, /<DialogContent [^\n]*onCloseAutoFocus=\{returnFocus\}/, file);
  }
});
