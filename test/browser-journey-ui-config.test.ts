import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_DISCOVERED, branchMismatchNote, defaultReplaceIds, generateError, generateRoom, journeyTimeoutMinutes, previewTargets, sameUrl, targetSuggestions, validateTestSettings } from '../client/src/lib/journey-config.ts';
import { caseDraftKey, caseDraftOriginal, caseDrafts, hasCaseDrafts, newTestDraftKey, newTestDrafts, pruneCaseDrafts, pruneStageDrafts } from '../client/src/lib/case-drafts.ts';

const settings = (patch: Partial<Parameters<typeof validateTestSettings>[0]>) => validateTestSettings({ targetUrl:'http://127.0.0.1:55887/login', externalOrigins:[], authEndpoints:[], timeoutMinutes:'15', ...patch });

test('test settings save normalized HTTPS provider origins', () => {
  const { valid, values } = settings({ externalOrigins:['https://checkout.stripe.com', ' https://billing.stripe.com/ ', ''] });
  assert.equal(valid, true);
  assert.deepEqual(values, { targetUrl:'http://127.0.0.1:55887/login', signInUrl:'', externalOrigins:['https://checkout.stripe.com', 'https://billing.stripe.com'], authEndpoints:[], journeyTimeoutSeconds:900 });
});
test('test settings accept explicit local HTTP dependencies and refuse remote HTTP lookalikes', () => {
  const checked = settings({ externalOrigins:['http://localhost:55888/', 'http://127.0.0.1:55889', 'http://[::1]:55890', 'http://host.docker.internal:55891', 'http://ui.localhost:55892'] });
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.values.externalOrigins, ['http://localhost:55888', 'http://127.0.0.1:55889', 'http://[::1]:55890', 'http://host.docker.internal:55891', 'http://ui.localhost:55892']);
  for (const origin of ['http://localhost.example.com:55888', 'http://127.example.com:55888', 'http://10.0.0.1:55888', 'http://169.254.169.254', 'http://gateway.docker.internal:55888']) assert.equal(settings({externalOrigins:[origin]}).valid, false, origin);
});
test('the optional sign-in page stays on the target URL’s origin and keeps a hash route', () => {
  assert.deepEqual([settings({}).valid, settings({ signInUrl:'  ' }).values.signInUrl], [true, '']);
  const { valid, values } = settings({ signInUrl:' http://127.0.0.1:55887/account/sign-in?next=%2F ' });
  assert.equal(valid, true);
  assert.equal(values.signInUrl, 'http://127.0.0.1:55887/account/sign-in?next=%2F');
  // A hash-routed application shows its form only on its hash route; an empty hash is no route.
  assert.deepEqual(['http://127.0.0.1:55887/#/login', 'http://127.0.0.1:55887/login#'].map(signInUrl => settings({ signInUrl }).values.signInUrl), ['http://127.0.0.1:55887/#/login', 'http://127.0.0.1:55887/login']);
  for (const [signInUrl, error] of [['http://127.0.0.1:55888/login', 'Use the target URL’s origin.'], ['https://127.0.0.1:55887/login', 'Use the target URL’s origin.'], ['http://user:secret@127.0.0.1:55887/login', 'Remove the credentials.'],
    ['/login', 'Enter an HTTP or HTTPS URL.'], ['javascript:alert(1)', 'Enter an HTTP or HTTPS URL.'], ['ftp://127.0.0.1:55887/login', 'Enter an HTTP or HTTPS URL.']]) {
    const checked = settings({ signInUrl });
    assert.deepEqual([checked.valid, checked.errors.signInUrl], [false, error], signInUrl);
  }
  assert.equal(settings({ targetUrl:'', signInUrl:'http://127.0.0.1:55887/login' }).errors.signInUrl, 'Use the target URL’s origin.');
  // The controller takes at most 2048 characters of the normalized URL, which encodes what was typed, as it saves it.
  for (const path of ['ü'.repeat(1000), `${' '.repeat(1800)}x`, 'x'.repeat(2048 - 'http://127.0.0.1:55887/'.length + 1)]) {
    const checked = settings({ signInUrl:`http://127.0.0.1:55887/${path}` });
    assert.deepEqual([checked.valid, checked.errors.signInUrl], [false, 'Use at most 2048 characters.'], path.slice(0, 3));
  }
  assert.equal(settings({ signInUrl:`http://127.0.0.1:55887/${'x'.repeat(2048 - 'http://127.0.0.1:55887/'.length)}` }).valid, true);
});
test('the test settings dialog saves the sign-in page from one labelled field beside the target URL', async () => {
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  const dialog = panel.slice(panel.indexOf('function TestSettingsDialog'), panel.indexOf('type GenerateTestsDialogProps'));
  assert.match(dialog, /const \[signInUrl, setSignInUrl\] = useState\(config\.signInUrl \|\| ''\);/);
  assert.match(dialog, /validateTestSettings\(\{ targetUrl, signInUrl, externalOrigins:/);
  assert.match(dialog, /await onSave\(\{ \.\.\.config, \.\.\.checked\.values(?:, [^\n]*)? \}\)/);
  const field = dialog.slice(dialog.indexOf('<Field id="test-sign-in-url"'), dialog.indexOf('<ListField id="external-origins"'));
  // A label and the field's error only: no helper text or placeholder. The error describes the field it is about.
  assert.equal(field.trim(), `<Field id="test-sign-in-url" label="Sign-in page">
          <Input id="test-sign-in-url" type="url" maxLength={2048} value={signInUrl} aria-invalid={Boolean(shown.signInUrl) || undefined} aria-describedby={described('test-sign-in-url', shown.signInUrl)} onChange={event => setSignInUrl(event.target.value)} />
          <FieldError id="test-sign-in-url">{shown.signInUrl}</FieldError>
        </Field>`);
  // Every field of the settings reads its error: the input names it while it shows.
  assert.match(panel, /function FieldError\(\{ id, children \}: \{ id: string; children\?: ReactNode \}\) \{ return children \? <p id=\{`\$\{id\}-error`\} className="break-words text-xs text-destructive">\{children\}<\/p> : null; \}/);
  assert.match(panel, /const described = \(id: string, error: unknown\) => error \? `\$\{id\}-error` : undefined;/);
  for (const [id, error] of [['test-target-url', 'shown.targetUrl'], ['journey-time-limit', 'shown.timeout']]) {
    assert.ok(dialog.includes(`aria-describedby={described('${id}', ${error})}`) && dialog.includes(`<FieldError id="${id}">{${error}}</FieldError>`), id);
  }
  assert.ok(panel.includes('aria-describedby={described(`${id}-${index}`, showErrors && errors[index])}') && panel.includes('{showErrors && <FieldError id={`${id}-${index}`}>{errors[index]}</FieldError>}'), 'Each list entry names its error.');
  assert.ok(panel.includes('aria-describedby={described(id, listError)}') && panel.includes('<FieldError id={id}>{listError}</FieldError>'), 'A list names its own error.');
  assert.doesNotMatch(panel, /<FieldError>/, 'No error is left unlinked.');
  assert.ok(dialog.indexOf('<FieldError>{shown.targetUrl}</FieldError>') < dialog.indexOf('<Field id="test-sign-in-url"'), 'It follows the target URL.');
});
test('external origins reject anything but a bare HTTPS origin', () => {
  const { valid, errors } = settings({ externalOrigins:['http://checkout.stripe.com', 'https://user:secret@stripe.com', 'https://checkout.stripe.com/pay?x=1', 'stripe', 'https://js.stripe.com', 'https://js.stripe.com/'] });
  assert.equal(valid, false);
  assert.deepEqual(errors.externalOrigins, ['Use HTTPS.', 'Remove the credentials.', 'Remove the path and query.', 'Enter an HTTPS origin.', '', 'Duplicate origin.']);
  assert.equal(settings({ externalOrigins:Array.from({ length:11 }, (_, index) => `https://p${index}.example.com`) }).errors.externalOriginsList, 'Use at most 10 origins.');
});
test('auth endpoints stay on the target host on any port', () => {
  const { valid, values, errors } = settings({ authEndpoints:['http://127.0.0.1:55888/auth/v1/token', 'https://evil.example/auth', '/auth/v1/token', 'ftp://127.0.0.1/auth'] });
  assert.equal(valid, false);
  assert.deepEqual(errors.authEndpoints, ['', 'Use the target host.', 'Enter an absolute URL.', 'Use HTTP or HTTPS.']);
  assert.deepEqual(settings({ authEndpoints:['http://127.0.0.1:55888/auth/v1/token'] }).values.authEndpoints, ['http://127.0.0.1:55888/auth/v1/token']);
  assert.equal(settings({ authEndpoints:['a', 'b', 'c', 'd'].map(path => `http://127.0.0.1:55888/${path}`) }).errors.authEndpointsList, 'Use at most 3 endpoints.');
  assert.equal(values.targetUrl, 'http://127.0.0.1:55887/login');
});
test('auth endpoints must name a specific path without a query', () => {
  const endpoints = ['http://127.0.0.1:55887', 'http://127.0.0.1:55887/', 'http://127.0.0.1:55888/', 'http://127.0.0.1:55887/auth?x=1', 'http://127.0.0.1:55887/auth#token', 'http://127.0.0.1:55887/auth?'];
  const { valid, errors } = settings({ authEndpoints:endpoints.slice(0, 3) });
  assert.equal(valid, false);
  assert.deepEqual(errors.authEndpoints, Array(3).fill('Use a specific endpoint path.'));
  assert.deepEqual(settings({ authEndpoints:endpoints.slice(3) }).errors.authEndpoints, Array(3).fill('Remove the query.'));
});
test('auth endpoint settings accept loopback host aliases and keep parent-path restrictions on their shared origin', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']) {
    const endpoint = `http://${host}:55888/auth/v1/token`;
    const current = settings({ authEndpoints: [endpoint] });
    assert.equal(current.valid, true, endpoint);
    assert.deepEqual(current.values.authEndpoints, [endpoint]);
    const parents = settings({ targetUrl: 'http://127.0.0.1:55887/app/workspace', authEndpoints: [`http://${host}:55887/app`, `http://${host}:55888/app`, `https://${host}:55887/app`] });
    assert.deepEqual(parents.errors.authEndpoints, ['Use a specific endpoint path.', '', '']);
  }
  for (const host of ['other.example', 'host.docker.internal.other.example', '127.0.0.2']) {
    assert.deepEqual(settings({ authEndpoints: [`http://${host}:55888/auth/v1/token`] }).errors.authEndpoints, ['Use the target host.']);
  }
});

test('auth endpoints cannot cover the target page or its parents', () => {
  const errors = settings({ authEndpoints:['http://127.0.0.1:55887/log', 'http://127.0.0.1:55887/login', 'http://127.0.0.1:55888/log'] }).errors.authEndpoints;
  assert.deepEqual(errors, ['Use a specific endpoint path.', '', '']);
  const app = validateTestSettings({ targetUrl:'http://127.0.0.1:55887/app/', authEndpoints:['http://127.0.0.1:55887/app/', 'http://127.0.0.1:55887/app/auth/token'], timeoutMinutes:'15' });
  assert.deepEqual(app.errors.authEndpoints, ['Use a specific endpoint path.', '']);
});
test('journey time limit is 1–30 minutes', () => {
  assert.equal(settings({ timeoutMinutes:'1' }).values.journeyTimeoutSeconds, 60);
  assert.equal(settings({ timeoutMinutes:'30' }).values.journeyTimeoutSeconds, 1800);
  for (const value of ['0.5', '31', '', 'soon']) assert.equal(settings({ timeoutMinutes:value }).errors.timeout, 'Use 1–30 minutes.');
  assert.equal(journeyTimeoutMinutes({}), '15');
  assert.equal(journeyTimeoutMinutes({ journeyTimeoutSeconds:90 }), '1.5');
  assert.equal(settings({ targetUrl:'javascript:alert(1)' }).errors.targetUrl, 'Enter an HTTP or HTTPS target URL.');
});
test('generation preselects only legacy step-less cases and drafts', () => {
  const cases = [{ id:'legacy', needsReview:false, steps:[] }, { id:'reviewed', needsReview:false, steps:[{ id:'a', title:'A' }, { id:'b', title:'B' }] }, { id:'draft', needsReview:true, steps:[{ id:'a', title:'A' }] }, { id:'old', needsReview:false, steps:[] }];
  assert.deepEqual(defaultReplaceIds(cases), ['legacy', 'draft', 'old']);
  assert.equal(generateRoom(60, 0), 0);
  assert.equal(generateRoom(60, 3), 3);
  assert.equal(generateRoom(12, 0), 48);
});
test('generation at the case limit needs room for a full discovery result', () => {
  assert.equal(MAX_DISCOVERED, 4);
  assert.equal(generateError(60, 1), 'Select 3 more tests to replace.');
  assert.equal(generateError(60, 3), 'Select 1 more test to replace.');
  assert.equal(generateError(60, 4), '');
  assert.equal(generateError(57, 0), 'Select 1 more test to replace.');
  assert.equal(generateError(56, 0), '');
  assert.equal(generateError(0, 0), '');
});
test('stale case drafts are pruned when their case changes or disappears', () => {
  const drafts = new Map<string, { original: string; draft: unknown }>();
  const kept = { id:'a', name:'Checkout', selected:true }, changed = { id:'b', name:'Refund', selected:false };
  drafts.set(caseDraftKey('/repo', 'beta', 'a'), { original:caseDraftOriginal({ ...kept, selected:false }), draft:{} });
  drafts.set(caseDraftKey('/repo', 'beta', 'b'), { original:caseDraftOriginal(changed), draft:{} });
  drafts.set(caseDraftKey('/repo', 'beta', 'gone'), { original:'{}', draft:{} });
  drafts.set(caseDraftKey('/repo', 'gamma', 'gone'), { original:'{}', draft:{} });
  pruneCaseDrafts('/repo', 'beta', [kept, { ...changed, name:'Refund a purchase' }], drafts);
  assert.deepEqual([...drafts.keys()], [caseDraftKey('/repo', 'beta', 'a'), caseDraftKey('/repo', 'gamma', 'gone')]);
});
test('a new test description is kept on every close; only Generate or Discard draft clears it', async () => {
  const key = newTestDraftKey('/repo', 'beta');
  assert.notEqual(key, caseDraftKey('/repo', 'beta', 'new'));
  assert.equal(hasCaseDrafts(), false);
  newTestDrafts.set(key, 'Sign in, create a workflow and run it');
  try {
    assert.equal(hasCaseDrafts(), true);
    pruneCaseDrafts('/repo', 'beta', []);
    assert.equal(newTestDrafts.get(key), 'Sign in, create a workflow and run it', 'Case pruning never drops an unsent description');
  } finally { newTestDrafts.clear(); caseDrafts.clear(); }
  const dialog = await readFile(new URL('../client/src/NewTestDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /useState\(\(\) => newTestDrafts\.get\(draftKey\) \|\| ''\)/);
  // The text is written through while typed, so Cancel, Esc, X, an outside click and Settings all keep it.
  assert.match(dialog, /useEffect\(\(\) => \{\n    if \(description\.trim\(\)\) newTestDrafts\.set\(draftKey, description\);\n    else newTestDrafts\.delete\(draftKey\);\n  \}, \[draftKey, description\]\);/);
  const close = dialog.slice(dialog.indexOf('function close()'), dialog.indexOf('function discard()'));
  assert.doesNotMatch(close, /newTestDrafts/, 'Closing never clears the draft');
  const discard = dialog.slice(dialog.indexOf('function discard()'), dialog.indexOf('async function submit'));
  assert.match(discard, /newTestDrafts\.delete\(draftKey\)/);
  assert.match(dialog, /try \{ await onCreate\(description\.trim\(\)\); newTestDrafts\.delete\(draftKey\); \}/);
  assert.match(dialog, /\{description\.trim\(\) && <Button type="button" variant="ghost" disabled=\{saving\} onClick=\{discard\}>Discard draft<\/Button>\}/);
  assert.match(dialog, /<Dialog open onOpenChange=\{open => \{ if \(!open\) close\(\); \}\}>/);
  assert.match(dialog, /onClick=\{\(\) => \{ close\(\); onAppSettings\?\.\(\); \}\}>Settings<\/Button>/);
  assert.ok(dialog.indexOf('new-test-model-required') < dialog.indexOf('<Textarea'), 'The model gate precedes the description');
  assert.match(dialog, /aria-label="Dictate description"/);
  assert.doesNotMatch(dialog, /aria-label=\{voiceTitle\}|title=\{voiceTitle\}/);
  // The mic stays focusable and named while blocked; no focusable wrapper without a role.
  assert.match(dialog, /<TooltipTrigger asChild>\s*<Button [^\n]*aria-label="Dictate description"[^\n]*aria-disabled=\{voiceDisabled \|\| undefined\} onClick=\{\(\) => \{ if \(voiceDisabled\) return;/);
  assert.doesNotMatch(dialog, /tabIndex=|<span[^>]*focus-visible:ring/);
});
test('drafts of a stage that left the pipeline stop keeping the unload prompt alive', () => {
  const cases = new Map<string, { original: string; draft: unknown }>(), descriptions = new Map<string, string>();
  cases.set(caseDraftKey('/repo', 'beta', 'a'), { original:'{}', draft:{} });
  cases.set(caseDraftKey('/repo', 'gone', 'a'), { original:'{}', draft:{} });
  cases.set(caseDraftKey('/other', 'gone', 'a'), { original:'{}', draft:{} });
  descriptions.set(newTestDraftKey('/repo', 'beta'), 'Checkout');
  descriptions.set(newTestDraftKey('/repo', 'gone'), 'Refund');
  descriptions.set(newTestDraftKey('/other', 'gone'), 'Elsewhere');
  descriptions.set('not json', 'kept');
  pruneStageDrafts('/repo', ['source', 'beta', 'production'], [cases, descriptions]);
  assert.deepEqual([...cases.keys()], [caseDraftKey('/repo', 'beta', 'a'), caseDraftKey('/other', 'gone', 'a')]);
  assert.deepEqual([...descriptions.keys()], [newTestDraftKey('/repo', 'beta'), newTestDraftKey('/other', 'gone'), 'not json'], 'Only the scanned source is pruned');
  newTestDrafts.set(newTestDraftKey('/repo', 'gone'), 'Refund');
  try {
    assert.equal(hasCaseDrafts(), true);
    pruneStageDrafts('/repo', ['beta']);
    assert.equal(hasCaseDrafts(), false, 'The default maps are the ones the unload prompt reads');
  } finally { newTestDrafts.clear(); caseDrafts.clear(); }
});
test('known target URLs come only from a ready sandbox or twin and scanned Vercel previews', () => {
  const scan = { nodes:[
    { id:'vercel:storefront', kind:'deployment', provider:'Vercel', label:'storefront preview', previewAlias:'storefront-git-preview-acme.vercel.app' },
    { id:'vercel:bad', kind:'deployment', provider:'Vercel', label:'bad', previewAlias:'evil.example.com' },
    { id:'railway', kind:'deployment', provider:'Railway', previewAlias:'x.vercel.app' },
  ] };
  const previews = previewTargets(scan);
  assert.deepEqual(previews, [{ url:'https://storefront-git-preview-acme.vercel.app', label:'storefront preview' }]);
  assert.deepEqual(previewTargets(null), []);
  const services = [{ id:'frontend', name:'frontend', url:'http://127.0.0.1:52001' }, { id:'api', name:'api', url:'not a url' }];
  assert.deepEqual(targetSuggestions({ environment:{ status:'ready', services }, previews }).map(item => item.label), ['frontend', 'storefront preview']);
  assert.deepEqual(targetSuggestions({ environment:{ status:'ready', services }, previews:previews.map(item => ({ ...item, branches:['preview'] })) }).map(item => [item.label, item.mismatch]), [['frontend', false], ['storefront preview', false]], 'An unknown scanned branch flags nothing');
  assert.deepEqual(targetSuggestions({ environment:{ status:'preparing', services }, previews }).map(item => item.label), ['storefront preview'], 'A sandbox URL is offered only once it is ready');
  assert.deepEqual(targetSuggestions({ environment:{ status:'ready', services:[...services, { name:'again', url:'http://127.0.0.1:52001/' }] } }).length, 1);
  assert.deepEqual(targetSuggestions(), []);
  // A twin's URLs are its apps'; its services have none.
  const twin = { status:'ready', sourceBranch:'main', apps:[{ id:'backend', url:'http://host.docker.internal:43100' }, { id:'frontend', url:'http://host.docker.internal:43101' }], services:[{ id:'supabase' }] };
  assert.deepEqual(targetSuggestions({ environment:twin, previews }).map(item => [item.label, item.url]),
    [['backend', 'http://host.docker.internal:43100'], ['frontend', 'http://host.docker.internal:43101'], ['storefront preview', 'https://storefront-git-preview-acme.vercel.app']]);
  assert.deepEqual(targetSuggestions({ environment:{ ...twin, status:'preparing' } }), [], 'A twin app is offered only once the twin is ready');
  assert.equal(sameUrl('https://storefront-git-preview-acme.vercel.app', 'https://storefront-git-preview-acme.vercel.app/'), true);
  assert.equal(sameUrl('', 'https://a.test'), false);
});
test('known URLs carry the branch they deploy only when known and flag another branch', () => {
  const scan = { repo:{ branch:'codex/cart-checkout-agent-demo' }, nodes:[
    { provider:'Vercel', label:'storefront preview', previewAlias:'storefront-git-preview-acme.vercel.app', deployBranches:['preview'] },
    { provider:'Vercel', label:'docs preview', previewAlias:'docs-git-preview-acme.vercel.app' },
    { provider:'Vercel', label:'glob', previewAlias:'glob.vercel.app', deployBranches:['release/*', 42] },
  ] };
  const previews = previewTargets(scan);
  assert.deepEqual(previews.map(item => item.branches), [['preview'], undefined, undefined], 'A branch is never inferred from an alias or a glob');
  const environment = { status:'ready', sourceBranch:'codex/cart-checkout-agent-demo', services:[{ name:'frontend', url:'http://127.0.0.1:52001' }] };
  const items = targetSuggestions({ environment, previews, branch:'codex/cart-checkout-agent-demo' });
  assert.deepEqual(items.map(item => [item.label, item.branches, item.mismatch]), [
    ['frontend', ['codex/cart-checkout-agent-demo'], false],
    ['docs preview', [], false],
    ['glob', [], false],
    ['storefront preview', ['preview'], true],
  ], 'Sandbox services lead; a preview of another branch follows the others and is flagged');
  const stale = targetSuggestions({ environment:{ ...environment, sourceBranch:'main' }, previews:[], branch:'codex/cart-checkout-agent-demo' });
  assert.deepEqual(stale.map(item => [item.label, item.mismatch]), [['frontend', true]], 'A sandbox built from an earlier branch is flagged too');
  assert.equal(Object.hasOwn(stale[0], 'sandbox'), false);
  // Only a flagged URL carries the scanned branch its note names.
  assert.deepEqual(items.map(item => item.scannedBranch), [undefined, undefined, undefined, 'codex/cart-checkout-agent-demo']);
  assert.equal(branchMismatchNote(items[3].branches, items[3].scannedBranch!), 'Deploys preview, not codex/cart-checkout-agent-demo');
  assert.equal(branchMismatchNote(stale[0].branches, stale[0].scannedBranch!), 'Deploys main, not codex/cart-checkout-agent-demo');
});
test('the selected known URL reads as selected, wraps on narrow screens and names its branch', async () => {
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  const group = panel.slice(panel.indexOf('role="group" aria-label="Known URLs"'), panel.indexOf('<FieldError>{shown.targetUrl}</FieldError>'));
  assert.match(group, /<KnownUrl key=\{item\.url\} item=\{item\} chosen=\{sameUrl\(targetUrl\.trim\(\), item\.url\)\} onChoose=\{\(\) => setTargetUrl\(item\.url\)\} \/>/);
  const chips = panel.slice(panel.indexOf('function KnownUrl'), panel.indexOf('function TestSettingsDialog'));
  assert.match(chips, /variant=\{chosen \? 'default' : 'outline'\} aria-pressed=\{chosen\} title=\{note \? undefined : item\.url\}/, 'A flagged chip shows its note instead of a second, native tooltip');
  assert.match(chips, /\$\{chosen \? '' : 'dark:bg-transparent'\}/);
  assert.match(chips, /whitespace-normal/);
  assert.doesNotMatch(chips, /\btruncate\b/);
  // A mismatch keeps the branch mark and name, tinted, and never swaps the mark for a warning icon.
  assert.match(chips, /\$\{item\.mismatch \? warning : quiet\}`\}><GitBranch aria-hidden="true" className="size-3" \/>\{branch\}<\/span>/);
  assert.doesNotMatch(chips, /TriangleAlert|<Badge/);
  assert.match(chips, /const warning = chosen \? 'text-amber-300 dark:text-amber-800' : 'text-\(--warning\)';/, 'The tint inverts on the filled, chosen chip');
  assert.match(chips, /const note = item\.mismatch && item\.scannedBranch \? branchMismatchNote\(item\.branches, item\.scannedBranch\) : '';/);
  assert.match(chips, /return note \? <Tooltip><TooltipTrigger asChild>\{chip\}<\/TooltipTrigger><TooltipContent>\{note\}<\/TooltipContent><\/Tooltip> : chip;/, 'The chip itself is the keyboard-reachable trigger');
  assert.match(chips, /aria-label=\{`\$\{item\.label\}: \$\{item\.url\}\$\{branch \? `, branch \$\{branch\}` : ''\}\$\{item\.mismatch \? ', not the scanned branch' : ''\}`\}/);
  const inspector = await readFile(new URL('../client/src/EnvironmentSettings.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /targetSuggestions\(\{ environment: current, previews, branch \}\)/);
});
test('test settings name what each list allows and keep their stored keys', async () => {
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<ListField id="external-origins" label="External sites allowed in runs" itemLabel="Site" addLabel="Add site"[^\n]*rows=\{origins\}/);
  assert.match(panel, /<ListField id="auth-endpoints" label="Sign-in API endpoints" itemLabel="Endpoint" addLabel="Add endpoint"[^\n]*rows=\{endpoints\}/);
  assert.match(panel, /externalOrigins: origins\.map\(row => row\.value\), authEndpoints: endpoints\.map\(row => row\.value\)/);
  assert.match(panel, /role="group" aria-label="Known URLs"/);
  assert.match(panel, /onChoose=\{\(\) => setTargetUrl\(item\.url\)\}/);
});
test('unsaved forms offer Cancel and Save; read-only surfaces offer Close', async () => {
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  const editor = panel.slice(panel.indexOf('function BusinessCaseEditor'), panel.indexOf('export default function BrowserTestingPanel'));
  assert.match(editor, />Cancel<\/Button><Button type="submit"/);
  assert.doesNotMatch(editor, />Close<\/Button>|Save test/);
  assert.doesNotMatch(panel, /Save changes/);
  const inspector = await readFile(new URL('../client/src/EnvironmentSettings.tsx', import.meta.url), 'utf8');
  const header = await readFile(new URL('../client/src/InspectorHeaders.tsx', import.meta.url), 'utf8');
  assert.match(header, /aria-label="Close" onClick=\{onClose\}/);
  assert.doesNotMatch(header, /Close sandbox/);
  // One clear close: the view-only inspector has no second "Close" in a footer.
  assert.doesNotMatch(inspector, />Close<\/Button>|SheetFooter/);
  assert.match(header, /\(current \|\| snapshot\.pending === 'create' \|\| !snapshot\.loading\.environment\) && <EnvironmentStatus status=\{snapshot\.pending === 'create' \? 'preparing' : requestFailed \? 'failed' : current\?\.status\} step=\{current\?\.step\} \/>/);
  // The header status reads like the stage card: outline + icon when absent or idle, secondary when ready or working, destructive when failed.
  const status = header.slice(header.indexOf('export function environmentTone'));
  assert.match(status, /variant=\{tone === 'failed' \? 'destructive' : quiet \? 'outline' : 'secondary'\}/);
  assert.match(status, /const quiet = \['idle', 'unconfigured'\]\.includes\(tone\);/);
  assert.match(status, /<Icon aria-hidden="true"[^\n]*\/>\{stopped \? 'Stopped' : environmentStatusLabel\(status\)\}/);
  assert.match(status, /if \(!status\) return 'unconfigured';/);
  assert.match(inspector, /<TabsContent[^>]*focus-visible:ring/);
});
