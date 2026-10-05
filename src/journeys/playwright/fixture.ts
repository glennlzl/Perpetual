// The generic journey fixture, which an approved spec imports as 'perpetual'. The spec performs a reviewed
// journey's actions; the reviewed checks come from the approved case snapshot at run time, so a spec can
// neither write nor weaken them. The run's token, journey.run, only fills in a reviewed check's {run}. Events reach the
// controller through ./reporter.ts.
import { test as base, errors, type Page, type Request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CHECK_VERSION, OPERATORS, RUN, RUN_TOKEN, STEPS, approvedCase, checkTemplate, checkText, navigationAllowed, numberAfter, paymentAllowed, resolveCheck, sameOrigin, stripeLive } from './checks.ts';
import type { ApprovedCase, Captures, Check, Evaluation, EvaluatedCheck, FixtureEvent, Reading, TextCheck } from './checks.ts';
import { reviewedRead, validateReadRequests } from '../../browser/read-requests.ts';
import { controlReads } from './control.ts';
import { fixtureLifecycle } from './diagnostics.ts';
import { synchronizeReload } from './navigation.ts';
import { installActionObservation, resetActionObservation, actionFeedback } from './action-observation.ts';
import type { RunCredentials } from '../../browser/run-credentials.ts';

/** What a spec calls on its `journey` fixture; run is the run's token, for data a reviewed check names with {run}. */
export type JourneyFixture = { readonly run: string; milestone(id: string, actions: () => Promise<void>): Promise<void>; signIn(): Promise<void> };
/** A check's result on the page; final means waiting longer cannot change it. */
type Observation = Evaluation & { final?: true };
/** Why no reviewed check can judge the page any more, once a navigation was refused. */
type Guard = { refused: string | null };
/** A control run's document: the journey's actions in it, their count when the fixture last signed in, and whether it signs in now. */
type Held = { actions: number; signedAt: number; signingIn: boolean };

// A spec body runs in this worker process. The event channel, the account, its sign-in page and the run's token stay in
// this module: they leave the environment before any spec runs, so neither a spec nor the browser Playwright launches
// later can read them there. A spec reads the token only as journey.run, which checks never read back.
const env = { ...process.env }, write = process.stdout.write;
if (env.TEST_WORKER_INDEX !== undefined) for (const key of ['PERPETUAL_EVENT_CHANNEL', 'PERPETUAL_ACCOUNT_USERNAME', 'PERPETUAL_ACCOUNT_PASSWORD', 'PERPETUAL_SIGN_IN_URL', 'PERPETUAL_RUN_TOKEN', 'PERPETUAL_READ_REQUESTS']) delete process.env[key];
// The runtime sets the case snapshot, the target URL and the allowed origins for every journey process.
const approved: ApprovedCase = approvedCase(JSON.parse(readFileSync(env.PERPETUAL_CASE!, 'utf8')));
const origins: unknown = JSON.parse(env.PERPETUAL_ALLOWED_ORIGINS || '[]');
if (!Array.isArray(origins) || !origins.every((origin): origin is string => typeof origin === 'string')) throw new Error('The allowed origins are unreadable.');
const allowed = new Set(origins);
const readRequests = validateReadRequests(JSON.parse(env.PERPETUAL_READ_REQUESTS || '[]'), env.PERPETUAL_TARGET_URL!);
const account = env.PERPETUAL_ACCOUNT_USERNAME && env.PERPETUAL_ACCOUNT_PASSWORD ? { username: env.PERPETUAL_ACCOUNT_USERNAME, password: env.PERPETUAL_ACCOUNT_PASSWORD } : null;
// The stage's sign-in page, where the account signs in when the application URL shows no sign-in form.
const SIGN_IN_URL = env.PERPETUAL_SIGN_IN_URL || '';
if (SIGN_IN_URL && !sameOrigin(SIGN_IN_URL, env.PERPETUAL_TARGET_URL!)) throw new Error('The sign-in page is unreadable.');
const TOKEN = env.PERPETUAL_RUN_TOKEN ?? '';
if (!RUN_TOKEN.test(TOKEN)) throw new Error('The run token is unreadable.');
// Code approved under an earlier check version runs with the checks its control run was caught with: before version 2,
// text checks read no form field.
const CHECKS = Number(env.PERPETUAL_CHECK_VERSION ?? CHECK_VERSION);
if (!Number.isInteger(CHECKS) || CHECKS < 1 || CHECKS > CHECK_VERSION) throw new Error('The check version is unreadable.');
const VIEWPORT = { width: 1280, height: 800 }, FRAME_MS = 333, POLL_MS = 200, SIGN_IN_MS = 20000, FORM_MS = 2000;
// A verification's control run blocks every request that could change state, on every origin, except while the
// fixture signs in, so later milestones are still reached. Each is answered without reaching the application, so the
// page stays judgeable: a document (a form's submission) with 204, which leaves its page as it was, anything else with
// 503. Once the journey acts after a page's WebSocket opened, what the page sends over it is dropped (holdSockets), while
// what the server sends still arrives. A reviewed check must then notice that nothing was kept.
const BLOCK_WRITES = env.PERPETUAL_BLOCK_WRITES === '1', READS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Fixed reasons a journey stops for review (the runner's navigation_not_allowed and payment_live_mode_rejected), and
// why a control run in which every check passed proves nothing; a page calls REPORT when a write may have got past.
const NAVIGATION = 'Navigation is outside approved origins.', PAYMENT = 'Payment pages accept input only in Stripe test mode.';
const UNGUARDED = 'The control run could not block everything the pages sent.', REPORT = '__perpetualUnguarded';
// Why journey.signIn() found no sign-in form to fill.
const NO_FORM = 'The application URL shows no sign-in form. Set the sign-in page.', NO_SIGN_IN_FORM = 'The sign-in page shows no sign-in form. Check the sign-in page.';
const OFF_ORIGIN = 'The sign-in form is not on the application origin.';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Only lines carrying the run's channel token are events; anything else a worker prints is ignored. Without a
// channel, as while code is generated, nothing is reported.
const emit = (event: FixtureEvent) => { if (env.PERPETUAL_EVENT_CHANNEL) write.call(process.stdout, `${env.PERPETUAL_EVENT_CHANNEL}${JSON.stringify({ ...event, caseId: approved.id })}\n`); };
// The spec cannot be judged as written; the reporter makes the journey need review with this fixed reason.
function halt(error: string) { emit({ type: 'journey-stop', error }); return new Error(error); }
// Why a document may not load: a top-level page stays on the approved origins and off Stripe unless in test mode.
const refusal = (url: string, top: boolean) => !navigationAllowed(url, allowed) ? NAVIGATION : (top ? !paymentAllowed(url) : stripeLive(url)) ? PAYMENT : null;
const topLevel = (request: Request) => { try { return !request.frame().parentFrame(); } catch { return false; } };

// The number shown right after a visible label: a label standing on its own wins over one within a longer word, as
// Total over Subtotal, then the nearest ancestor, then the nearest number.
async function readNumber(page: Page, label: string) {
  let nodes = page.getByText(label.trim()).filter({ visible: true }), within: number | null = null;
  for (let depth = 0; depth < 4; depth++) {
    const found = (await nodes.allInnerTexts()).slice(0, 20).map((text, order) => ({ order, hit: numberAfter(text, label, depth > 0) })).filter((item): item is { order: number; hit: Reading } => item.hit !== null);
    const best = found.sort((a, b) => Number(b.hit.own) - Number(a.hit.own) || a.hit.gap - b.hit.gap || a.order - b.order)[0];
    if (best?.hit.own) return best.hit.value;
    within ??= best?.hit.value ?? null;
    nodes = nodes.locator('xpath=..');
  }
  return within;
}

// A field's value is what the application kept only while nothing else set it. Before the application's scripts run,
// each document marks every form field or editing host (contenteditable) an input or change event reaches, whoever
// sent it: what a journey typed, chose or cleared there.
const EDITED = 'perpetual.edited';
function markEdits(key: string) {
  const edited = new WeakSet<EventTarget>();
  Object.defineProperty(window, Symbol.for(key), { value: edited });
  for (const type of ['input', 'change']) window.addEventListener(type, event => { const target = event.composedPath()[0]; if (target) edited.add(target); }, true);
}
// Whether matched visible text or visible form fields hold the text as the application put it there, matched as getByText
// matches: ignoring case and runs of whitespace. A text field or text area holds its value, a select its selected options' labels. A password
// field is never read, nor a field edited in the current document, nor any field of a document the browser returned to
// through history, into which it restores what was typed before. Without the marks, no field is read. Visible text the
// journey typed into an editing host of the current document is no more what the application kept, so it is not read.
// From version 4, declared search controls carry query context, never stored-result evidence, even after a fresh GET.
function holds(nodes: Element[], [text, key, version, fields]: [string, string, number, boolean]) {
  const edited = (window as unknown as Record<symbol, WeakSet<EventTarget> | undefined>)[Symbol.for(key)];
  // Playwright pierces open shadow roots, so an exclusion must follow their hosts too.
  const up = (node: Element) => { const root = node.getRootNode(); return node.assignedSlot || node.parentElement || (root instanceof ShadowRoot ? root.host : null); };
  const query = (node: Element) => {
    let control = false;
    for (let parent: Element | null = node; parent; parent = up(parent)) {
      control ||= parent.matches('input, textarea, select');
      if (parent.matches('input[type="search" i], [role~="searchbox" i]') || control && parent.matches('search, [role~="search" i]')) return true;
    }
    return false;
  };
  const typed = (node: Element) => { for (let parent: Element | null = node; parent; parent = up(parent)) if (parent instanceof HTMLElement && parent.isContentEditable && edited?.has(parent)) return true; return false; };
  nodes = nodes.filter(node => (version < 4 || !query(node)) && !typed(node));
  if (!fields) return nodes.length > 0;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!edited || navigation?.type === 'back_forward') return false;
  const normal = (value: string) => value.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().toLowerCase(), wanted = normal(text);
  const TEXT_FIELDS = ['text', 'search', 'email', 'url', 'tel', 'number'];
  const held = (node: Element) => node instanceof HTMLSelectElement ? [...node.selectedOptions].map(option => option.label)
    : node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && TEXT_FIELDS.includes(node.type) ? [node.value] : [];
  return nodes.some(node => !edited.has(node) && held(node).some(value => normal(value).includes(wanted)));
}
// Text a person sees on the page: visible text, or what the application put in a visible form field, as a saved value is
// often shown. text-absent passes exactly when this is false.
async function shows(page: Page, text: string) {
  const nodes = page.getByText(text).filter({ visible: true });
  // A textarea's server-rendered query is textContent too; exclude search controls from both observation paths.
  if (CHECKS < 4 ? await nodes.count() : await nodes.evaluateAll(holds, [text, EDITED, CHECKS, false] as [string, string, number, boolean])) return true;
  if (CHECKS < 2) return false;
  return page.locator('input, textarea, select').filter({ visible: true }).evaluateAll(holds, [text, EDITED, CHECKS, true] as [string, string, number, boolean]);
}

async function observe(page: Page, check: Check, captures: Captures): Promise<Observation> {
  if (check.type === 'url-contains') return { passed: page.url().includes(check.value) };
  if (check.type !== 'read-number' && check.type !== 'compare-number') return { passed: await shows(page, check.value) === (check.type === 'text-visible') };
  if (check.type === 'compare-number' && !Object.hasOwn(captures, check.than)) return { passed: false, final: true, error: 'The earlier value was not captured.' };
  const value = await readNumber(page, check.label);
  if (value === null) return { passed: false, error: 'No number follows this label on the current page.' };
  return check.type === 'read-number' ? { passed: true, observed: value } : { passed: OPERATORS[check.op](value, captures[check.than]), observed: value };
}

// Why no reviewed check can judge the current page: a refused navigation, or no approved page to read.
function unjudged(page: Page | undefined, guard: Guard) {
  if (guard.refused) return guard.refused;
  if (!page) return 'Every page of the journey was closed.';
  if (page.url().startsWith('chrome-error:')) return 'The page could not be loaded.';
  return page.url() !== 'about:blank' && navigationAllowed(page.url(), allowed) ? null : 'The current page is outside approved origins.';
}

// Checks that also hold on a page whose data has not arrived yet, an absent text or a placeholder number, pass only on
// an observation made once the page's network was idle.
const SETTLED = new Set<Check['type']>(['text-absent', 'read-number', 'compare-number']);
// Why a page that no observation can read, as a crashed page or one whose main thread is blocked, stops the journey.
const UNCHECKED = 'The current page could not be checked.', OBSERVE_GRACE_MS = 5000;
// A browser call on such a page can wait without end, so an observation gets until the deadline and a grace period.
const bounded = <T>(promise: Promise<T>, deadline: number) => Promise.race([promise, wait(Math.max(0, deadline - Date.now()) + OBSERVE_GRACE_MS).then((): T => { throw new Error(UNCHECKED); })]);

// Actions return before the page settles, so a check waits for its condition up to the check timeout. A page no check
// can judge stops the journey for review instead, at once after a refused navigation, else once the timeout passes.
// The page is judged by the check with the run's token in place of {run}; the result keeps the check as written.
async function verify<C extends Check>(page: () => Page | undefined, check: C, captures: Captures, timeout: number, guard: Guard, record?: (page: Page) => (check: EvaluatedCheck) => void): Promise<{ stop: string } | EvaluatedCheck<C>> {
  const deadline = Date.now() + timeout, judged = resolveCheck(check, TOKEN), filled = checkTemplate(check).includes(RUN) ? { resolved: checkTemplate(judged) } : {};
  for (let settled = false;;) {
    const target = page(), reason = unjudged(target, guard), late = Date.now() >= deadline;
    if (reason && (guard.refused || late)) return { stop: reason };
    if (!reason) {
      const observed = record?.(target!);
      // Browser errors can contain page text; keep only a fixed reason. An observation that threw, or was still running,
      // at the deadline judged nothing, so the journey stops for review rather than failing the check.
      const result = await bounded(observe(target!, judged, captures), deadline).catch(() => null);
      if (!result && Date.now() >= deadline) return { stop: UNCHECKED };
      // A document whose network was already idle resolves at once; one still loading its data is observed again once
      // it is idle, or judged as it is at the deadline.
      const settle = result?.passed === true && !late && !settled && SETTLED.has(check.type);
      if (settle && (settled = await target!.waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) }).then(() => true, () => false))) continue;
      if (result && !settle && (result.passed || result.final || late)) {
        // A passed read-number check always observed its number.
        if (check.type === 'read-number' && result.passed) captures[check.name] = result.observed!;
        const { final: _final, ...evaluated } = result;
        const complete = { ...check, ...evaluated, ...filled };
        observed?.(complete);
        return complete;
      }
    }
    settled = false;
    await wait(POLL_MS);
  }
}

// ~3 JPEG frames a second for the live view; the latest frame of a burst is always sent.
async function streamFrames(page: Page) {
  if (!env.PERPETUAL_EVENT_CHANNEL) return async () => {};
  let last = 0, pending: { data: Buffer; timestamp: number } | null = null, timer: NodeJS.Timeout | undefined;
  const send = () => {
    timer = undefined;
    if (!pending) return;
    const { data, timestamp } = pending; pending = null; last = Date.now();
    if (data.length <= 1_500_000) emit({ type: 'frame', data: data.toString('base64'), timestamp: Math.round(timestamp) });
  };
  try {
    await page.screencast.start({ size: VIEWPORT, quality: 55, onFrame(frame) { pending = frame; timer ??= setTimeout(send, Math.max(0, FRAME_MS - (Date.now() - last))); } });
  } catch { return async () => {}; }
  return async () => { await page.screencast.stop().catch(() => {}); clearTimeout(timer); send(); };
}

// A control run's script in each document, after Playwright's WebSocket mock and before the page's own scripts. It
// counts the journey's actions there (a click, a key press, typing or a selection), except while the fixture signs in.
// A socket drops what the page sends once the journey has acted since it opened, so its opening message and
// subscriptions still reach the application. What a socket that opened after an action since the fixture last signed
// in sends may be a write, so the page reports it.
function holdSockets(report: string) {
  type Send = Parameters<WebSocket['send']>;
  const state: Held = { actions: 0, signedAt: 0, signingIn: false }, opened = new WeakMap<WebSocket, number>(), Routed = globalThis.WebSocket;
  Object.defineProperty(globalThis, Symbol.for('perpetual.sockets'), { value: state });
  for (const type of ['pointerdown', 'keydown', 'input', 'change']) addEventListener(type, () => { if (!state.signingIn) state.actions++; }, true);
  globalThis.WebSocket = class WebSocket extends Routed {
    constructor(...args: ConstructorParameters<typeof Routed>) { super(...args); this.addEventListener('open', () => opened.set(this, state.actions)); }
    override send(...args: Send) {
      const at = opened.get(this);
      if (at !== undefined && !state.signingIn) { if (at !== state.actions) { (globalThis as unknown as Record<string, (kind: string) => void>)[report]?.('blocked'); return; } if (at > state.signedAt) (globalThis as unknown as Record<string, (kind: string) => void>)[report]?.('unguarded'); }
      super.send(...args);
    }
  };
}
// While the fixture signs in, a control run's page sends freely and its input is no journey action; a socket the page
// opens for the account is no write.
function signingInPage(on: boolean) {
  const state = (globalThis as unknown as Record<symbol, Held | undefined>)[Symbol.for('perpetual.sockets')];
  if (state) Object.assign(state, { signingIn: on, signedAt: state.actions });
}

// A sign-in form has one password field, not new-password, so a sign-up form is none; its username is the type=email
// or autocomplete username/email field in the same form, else the nearest text field before the password (as
// integrations/browser-use/sign_in.py finds it). Without one, null.
type Control = HTMLInputElement | HTMLButtonElement;
function findForm(): { username: HTMLInputElement; password: HTMLInputElement; submit: Control | null } | null {
  const nodes: Control[] = [];
  const walk = (root: Document | ShadowRoot) => root.querySelectorAll('*').forEach(node => { if (node.tagName === 'INPUT' || node.tagName === 'BUTTON') nodes.push(node as Control); if (node.shadowRoot) walk(node.shadowRoot); });
  walk(document);
  const up = (node: Node) => node.parentElement || (node.getRootNode() as { host?: Element }).host || null;
  const inside = (node: Node, box: Node | null) => { for (let at: Node | null = node; at; at = up(at)) if (at === box) return true; return false; };
  const kind = (node: Element) => (node.getAttribute('type') || 'text').toLowerCase();
  const shown = (node: Element) => node.getClientRects().length > 0 && node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const before = (node: Control, other: Control) => nodes.indexOf(node) < nodes.indexOf(other);
  const inputs = nodes.filter((node): node is HTMLInputElement => node.tagName === 'INPUT' && !node.disabled && !(node as HTMLInputElement).readOnly && shown(node));
  const passwords = inputs.filter(node => kind(node) === 'password');
  const names = inputs.filter(node => kind(node) === 'text' || kind(node) === 'email');
  const hinted = (node: Element) => kind(node) === 'email' || /\b(username|email)\b/i.test(node.getAttribute('autocomplete') || '');
  for (const password of passwords) {
    let member = (node: Control) => node.form === password.form;
    if (!password.form) {
      let box = up(password);
      while (box && !names.some(node => inside(node, box))) box = up(box);
      member = node => !!box && inside(node, box);
    }
    if (/new-password/i.test(password.getAttribute('autocomplete') || '') || passwords.filter(member).length !== 1) continue;
    const fields = names.filter(member), preferred = fields.filter(hinted);
    const username = preferred.filter(node => before(node, password)).pop() || preferred[0] || fields.filter(node => before(node, password)).pop();
    if (!username) continue;
    const submits = nodes.filter(node => member(node) && (node.tagName === 'BUTTON' ? node.type === 'submit' : ['submit', 'image'].includes(kind(node))) && shown(node));
    return { username, password, submit: submits.find(node => before(password, node)) || submits[0] || null };
  }
  return null;
}

export const test = base.extend<{ journey: JourneyFixture }>({
  journey: async ({ page, context }, use, testInfo) => {
    if (createHash('sha256').update(readFileSync(testInfo.file)).digest('hex') !== env.PERPETUAL_SPEC_HASH) throw halt('The spec differs from its approved version.');
    const timeout = Number(env.PERPETUAL_CHECK_TIMEOUT_MS) || 10000, captures: Captures = {}, done: string[] = [];
    let running = false, broken = false, signingIn = false, forwarded = 0, sent = 0, unguarded = false;
    const controlFailures: (() => boolean)[] = [];
    let controlCheckFailed = false;
    const control = BLOCK_WRITES && CHECKS >= 3 ? controlReads(context) : undefined;
    const diagnostic = env.PERPETUAL_LIFECYCLE_DIAGNOSTICS === '1' && !BLOCK_WRITES && env.PERPETUAL_EVENT_CHANNEL ? fixtureLifecycle(context, lifecycle => {
      write.call(process.stdout, `${env.PERPETUAL_EVENT_CHANNEL}${JSON.stringify({ type: 'lifecycle', caseId: approved.id, lifecycle })}\n`);
    }) : undefined;
    const recordControl = control ? (target: Page) => {
      const observed = control.observation(target);
      return (check: EvaluatedCheck) => {
        control.captured(check);
        controlCheckFailed ||= !check.passed;
        const witness = observed(check);
        if (witness && !unguarded) controlFailures.push(witness);
      };
    } : undefined;
    const current = () => page.isClosed() ? context.pages().filter(item => !item.isClosed()).at(-1) : page;
    const guard: Guard = { refused: null }, stop = (reason: string) => { broken = true; return halt(reason); };
    // A refused top-level document stops the journey for review; a refused frame only stays empty.
    const refuse = (url: string, top: boolean) => { const reason = refusal(url, top); if (reason && top) guard.refused ||= reason; return reason; };
    // Playwright's routes see only the first request of a redirect chain, so each page also pauses every document hop
    // over CDP. Routes still cover a popup's first request, which precedes its page's CDP session, keep live Stripe
    // resources out of every frame, and in a control run answer every write, a form's submission included.
    await context.route('**/*', async route => {
      const request = route.request(), url = request.url(), navigation = request.isNavigationRequest();
      if (navigation ? refuse(url, topLevel(request)) : stripeLive(url)) return route.abort('blockedbyclient').catch(() => {});
      if (BLOCK_WRITES && !signingIn && !READS.has(request.method()) && !reviewedRead(readRequests, request.method(), url, request.postData(), request.headers())) { control?.blockedRequest(request); return route.fulfill({ status: navigation ? 204 : 503 }).catch(() => {}); }
      // Context routes never see redirect hops, and a popup can issue reads before CDP attaches. Fetch exactly the
      // reviewed request with redirects/retries disabled, then give its response to the page. A redirect is not authority.
      if(BLOCK_WRITES&&reviewedRead(readRequests,request.method(),url,request.postData(),request.headers())){
        try{
          const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:30000});
          if(response.status()>=300&&response.status()<400){control?.blockedRequest(request);await response.dispose();await route.fulfill({status:503});return;}
          try{await route.fulfill({response});}finally{await response.dispose();}
          return;
        }catch{return route.abort('blockedbyclient').catch(()=>{});}
      }
      return route.continue().catch(() => {});
    });
    // Routes never see a WebSocket's messages, so a control run also routes every page's sockets to their server,
    // counting what holdSockets lets through; the page's script is added after the route's, so it sees routed sockets.
    if (BLOCK_WRITES) {
      await context.exposeBinding(REPORT, ({ page }, kind: unknown) => { if (kind === 'blocked') control?.blocked(page); else unguarded = true; });
      await context.routeWebSocket('**/*', socket => {
        const server = socket.connectToServer();
        socket.onMessage(message => { forwarded++; server.send(message); });
      });
      await context.addInitScript(holdSockets, REPORT);
    }
    const watch = async (target: Page) => {
      diagnostic?.page(target);
      // Neither kind of route reaches a worker's WebSocket, a page's WebSocketStream or anything a shared worker sends. A
      // socket message sent beyond those forwarded, or any shared worker, leaves a control run unable to vouch that
      // nothing was kept.
      if (BLOCK_WRITES) target.on('websocket', socket => socket.on('framesent', () => { if (++sent > forwarded) unguarded = true; }));
      const cdp = await context.newCDPSession(target), { targetInfo } = await cdp.send('Target.getTargetInfo');
      diagnostic?.cdp(target, cdp, targetInfo);
      synchronizeReload(target, cdp, action => base.step(STEPS.reloadReady, action));
      // First requests must reach Playwright's route so it reports their blocked response to response waits.
      // CDP still guards every navigation and blocks write redirect hops, which context routes never see.
      cdp.on('Fetch.requestPaused', ({ requestId, request, frameId, resourceType, redirectedRequestId }) => {
        const navigation = resourceType === 'Document';
        const refused = navigation ? refuse(request.url, frameId === targetInfo.targetId) : stripeLive(request.url);
        if (!refused && redirectedRequestId && BLOCK_WRITES && !signingIn && !READS.has(request.method) && !reviewedRead(readRequests, request.method, request.url, request.postData, request.headers)) {
          control?.blocked(target);
          cdp.send('Fetch.fulfillRequest', { requestId, responseCode: navigation ? 204 : 503 }).catch(() => {}); return;
        }
        cdp.send(refused ? 'Fetch.failRequest' : 'Fetch.continueRequest', refused ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', ...(BLOCK_WRITES && readRequests.length ? {} : { resourceType: 'Document' }), requestStage: 'Request' }] });
      if (!BLOCK_WRITES) return;
      cdp.on('Target.targetCreated', ({ targetInfo: created }) => { if (created.type === 'shared_worker') unguarded = true; });
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    };
    if (CHECKS >= 2) await context.addInitScript(markEdits, EDITED);
    if (env.PERPETUAL_EVENT_CHANNEL) await installActionObservation(context);
    const GUARD = 'The browser navigation guard could not be attached.';
    // A page the guard cannot watch is closed and stops the journey.
    context.on('page', target => { watch(target).catch(() => { if (target.isClosed()) return; guard.refused ||= GUARD; target.close().catch(() => {}); }); });
    try { await watch(page); } catch { throw halt(GUARD); }
    // An action that fails or ends after a refused navigation stops the journey with the refusal, never as page trouble.
    const acting = async (actions: () => Promise<unknown>) => {
      try { await actions(); } catch (error) { throw guard.refused ? stop(guard.refused) : error; }
      if (guard.refused) throw stop(guard.refused);
    };
    const stopFrames = await streamFrames(page);
    try {
      // The spec starts on the run's application URL, where discovery starts too.
      await acting(() => page.goto(env.PERPETUAL_TARGET_URL!));
      const milestone = async (id: string, actions: () => Promise<void>) => {
        const step = approved.steps?.[done.length];
        if (running || broken || step?.id !== id || typeof actions !== 'function') throw stop('The spec ran a milestone outside the reviewed order.');
        running = true; done.push(id);
        emit({ type: 'journey-step', stepId: id, status: 'running' });
        if (env.PERPETUAL_EVENT_CHANNEL) await resetActionObservation(page);
        try { await acting(() => base.step(step.title, actions)); }
        catch (error) {
          const target = current();
          if (target && !signingIn && env.PERPETUAL_EVENT_CHANNEL) {
            const feedback = await actionFeedback(target, [account?.username, account?.password]);
            if (feedback) emit({ type: 'action-feedback', feedback });
          }
          throw error;
        }
        const checks: EvaluatedCheck[] = [];
        let unjudgeable: string | null = null;
        await base.step(STEPS.checks, async () => {
          for (const check of step.checks || []) {
            const result = await verify(current, check, captures, timeout, guard, recordControl);
            if ('stop' in result) { unjudgeable = result.stop; break; }
            checks.push(result); if (!result.passed) break;
          }
        });
        if (unjudgeable) throw stop(unjudgeable);
        const failed = checks.find(check => !check.passed);
        const evidence = failed ? `Reviewed check failed: ${checkText(failed, captures)}.` : checks.length ? `Reviewed checks passed: ${checks.map(check => checkText(check, captures)).join('; ')}.` : 'Actions completed; this milestone has no reviewed checks.';
        emit({ type: 'journey-step', stepId: id, status: failed ? 'failed' : 'completed', evidence: evidence.slice(0, 2000), ...(checks.length ? { checks } : {}) });
        if (failed) { broken = true; throw new Error(`Reviewed check failed at milestone: ${step.title}.`); }
        running = false;
      };
      const hold = (on: boolean, target = current()) => BLOCK_WRITES ? target?.evaluate(signingInPage, on).catch(() => {}) : undefined;
      const signIn = () => base.step(STEPS.signIn, async () => {
        if (!account) throw new Error('No test account is available for this run.');
        signingIn = true; await hold(true);
        try { await signInWith(account); } finally { signingIn = false; await hold(false); }
      });
      const signInWith = async (account: RunCredentials) => {
        const signing = current();
        if (!signing) throw new Error(OFF_ORIGIN);
        const onApplication = () => sameOrigin(signing.url(), env.PERPETUAL_TARGET_URL!);
        if (!onApplication()) throw new Error(OFF_ORIGIN);
        // The form is on the current page, else on the sign-in page: a sign-up form, or any other password field, does
        // not count. With a sign-in page set, the current page gets a short wait before it opens; without one, the
        // action timeout, as a slowly rendered form needs.
        const found = (timeout?: number) => signing.mainFrame().waitForFunction(findForm, undefined, { polling: POLL_MS, timeout }).then(handle => handle, (error: unknown) => { if (error instanceof errors.TimeoutError) return null; throw error; });
        const onSignInPage = async () => {
          if (!SIGN_IN_URL) throw new Error(NO_FORM);
          // The sign-in page is a new document, which a control run marks as signing in too.
          await signing.goto(SIGN_IN_URL); await hold(true, signing);
          return await found() ?? Promise.reject(new Error(NO_SIGN_IN_FORM));
        };
        const form = await found(SIGN_IN_URL ? FORM_MS : undefined) ?? await onSignInPage();
        try {
          // A redirect can leave the application's origin; the account is entered only on it.
          if (!onApplication()) throw new Error(OFF_ORIGIN);
          const [username, password, submit] = await Promise.all(['username', 'password', 'submit'].map(name => form.getProperty(name).then(handle => handle.asElement())));
          if (!username || !password) throw new Error('The page has no sign-in form with one password field.');
          await username.fill(account.username); await password.fill(account.password);
          // Click waits until a control disabled before both fields held values is enabled.
          if (!submit || !await submit.click({ timeout: 3000 }).then(() => true, () => false)) await password.press('Enter', { timeout: 3000 }).catch(() => {});
        } finally { await form.dispose().catch(() => {}); }
        // Signed in once an approved page stays without a visible password field, so a brief transition does not count.
        const deadline = Date.now() + SIGN_IN_MS;
        for (let streak = 0; streak < 3;) {
          if (Date.now() >= deadline || signing.isClosed()) throw new Error('The test account did not sign in.');
          await wait(250);
          const gone = await bounded(signing.locator('input[type=password]').filter({ visible: true }).count(), deadline).then(count => !count, () => false);
          streak = gone && navigationAllowed(signing.url(), allowed) ? streak + 1 : 0;
        }
      };
      await use(Object.freeze({ run: TOKEN, milestone, signIn }));
      // An action, a check or the deadline ended the journey early; its milestones were already reported. A valid
      // spec runs a milestone per reviewed step, so only a generator's seed, which opens the application and at most
      // signs in, finishes without one: nothing was judged, and nothing is reported.
      if (testInfo.status !== 'passed' || broken || !done.length && approved.steps?.length) return;
      if (running || done.length !== (approved.steps || []).length) throw halt('The spec did not run every reviewed milestone in order.');
      if (guard.refused) throw halt(guard.refused);
      const assertions: EvaluatedCheck<TextCheck>[] = [];
      for (const check of approved.assertions || []) {
        const result = await verify(current, check, captures, assertions.some(item => !item.passed) ? 0 : timeout, guard, recordControl);
        if ('stop' in result) throw halt(result.stop);
        assertions.push(result);
      }
      emit({ type: 'assertions', assertions: assertions.map(({ type, value, passed, resolved }) => ({ type, value, passed, ...(resolved ? { resolved } : {}) })) });
      if (assertions.some(item => !item.passed)) throw new Error('A final assertion failed.');
      // Every check passed, but a write may have got past the block: the control run is inconclusive, not missed.
      if (unguarded) throw halt(UNGUARDED);
    } finally {
      diagnostic?.cleanup();
      await stopFrames();
      if (control && controlCheckFailed) emit({ type: 'control-read', eligible: !unguarded && controlFailures.some(valid => valid()) });
    }
  },
});
