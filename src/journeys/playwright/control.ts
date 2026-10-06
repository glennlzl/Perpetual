import type { BrowserContext, Page, Request } from '@playwright/test';
import type { ControlReadReason, ControlBlockedTransport, ControlFailedRead } from '../../../contract/browser.ts';
import { controlBlocks, controlFailedRead } from '../../browser/control-evidence.ts';
import { RUN, checkTemplate, type EvaluatedCheck } from './checks.ts';

/** Fixed transport limitations, never page text, URLs or message contents. */
export const controlBlockerText = (value: unknown): string | undefined => value === 'shared-worker' ? 'The control run cannot block shared-worker communication.'
  : value === 'unguarded-transport' ? 'The control run could not block everything the pages sent.' : undefined;

const READ_REASONS: Record<ControlReadReason, string> = {
  'page-unavailable': 'The judged page is unavailable. Reopen it after the blocked change.',
  'no-blocked-change': 'No blocked change preceded this page read.',
  'no-fresh-document': 'No fresh GET of the judged page followed the blocked change.',
  'blocked-after-read': 'A request or socket message was blocked after the fresh page read started. Read the page again after that change.',
  'blocked-request-failed': 'A blocked request failed before the control read could be certified. Read the page again after that failure.',
  'read-failed': 'A request carrying the judged page or its data failed. Resolve the failed read before checking persistence.',
  'read-incomplete': 'The fresh page read had not completed when its outcome was checked.',
  'document-not-committed': 'The fresh document had not become the judged page when its outcome was checked.',
  'document-replaced': 'Another document replaced the page that the outcome check observed.',
  'url-changed': 'The judged page address changed after its GET. Check an unchanged freshly read page address.',
  'check-unreadable': 'The outcome check could not read its business value.',
  'baseline-not-before-change': 'The numeric baseline was not read before the blocked change.',
  'check-not-run-owned': 'The failed check did not read a run-unique value or a number against its earlier value.',
};
/** Fixed observed reasons only; untrusted text can never become a diagnostic. */
export const controlReadReasonText = (value: unknown): string | undefined => typeof value === 'string' && Object.hasOwn(READ_REASONS, value) ? READ_REASONS[value as ControlReadReason] : undefined;
const FAILED_READS: Record<ControlFailedRead['resourceType'], string> = { document: 'the page document', script: 'a script of the page', xhr: 'an XHR request', fetch: 'a fetch request', eventsource: 'an EventSource stream' };
/**
 * A rejected read's fixed reason and, when a request failed, which kind of request it was and how it answered: what a
 * person and a regenerating model read. Its address stays in the run's evidence.
 */
export function controlReadDiagnosis({ controlReadReason, controlFailedRead: failed }: { controlReadReason?: unknown; controlFailedRead?: ControlFailedRead }): string | undefined {
  const reason = controlReadReasonText(controlReadReason);
  if (!reason || controlReadReason !== 'read-failed' || !failed || !Object.hasOwn(FAILED_READS, failed.resourceType)) return reason;
  return `${reason} The failed request was ${FAILED_READS[failed.resourceType]} (${Number.isInteger(failed.status) ? `HTTP ${failed.status}` : 'no response'}).`;
}

// Chromium reports a document's request without its fragment, while frame and page URLs keep it, as a hash route does.
const unhashed = (url: string) => url.split('#')[0];
// What a reviewed check reads reaches the judged page through its own document, its XHR, fetch and EventSource requests,
// wherever its data is served, and the scripts of its own origin that fetch and render that data.
const DATA = new Set(['xhr', 'fetch', 'eventsource']);

/** A control failure needs a fresh document of the judged page, after its blocked change. */
export function controlReads(context: BrowserContext, secrets?: Iterable<unknown>) {
  const known = [...(secrets ?? [])];
  type Document = { request: Request; epoch: number; ok: boolean; responded: boolean; finished: boolean; committed: boolean; status?: number };
  type Failure = { request: Request; status?: number };
  type State = { epoch: number; document?: Document; invalid: boolean; reason?: ControlReadReason; failed?: Failure; blocks: ControlBlockedTransport[]; readStarted: boolean };
  const pages = new WeakMap<Page, State>(), documents = new WeakMap<Request, Document>(), blockedRequests = new WeakSet<Request>(), captures = new Map<string, number>();
  // Error statuses by request: Chromium also reports an error response whose empty body the page never read as failed.
  const answered = new WeakMap<Request, number>();
  let sequence = 0;
  const state = (page: Page) => { let item = pages.get(page); if (!item) { item = { epoch: 0, invalid: true, blocks: [], readStarted: false }; pages.set(page, item); } return item; };
  const owner = (request: Request) => { try { return request.frame().page(); } catch { return undefined; } };
  const top = (request: Request) => { try { return request.isNavigationRequest() && !request.frame().parentFrame(); } catch { return false; } };
  const blocked = (page: Page | undefined, transport?: { kind: 'http'; method: string; url: string } | { kind: 'socket'; transport: 'websocket' }) => {
    sequence++;
    if (!page) return;
    const item = state(page);
    if (transport) {
      const block = controlBlocks([{ ...transport, afterRead: item.readStarted }], known)?.[0];
      if (block && !item.blocks.some(previous => JSON.stringify(previous) === JSON.stringify(block))) item.blocks = [...item.blocks, block].slice(-10);
    }
    // Diagnostics never participate in eligibility or change the invalidation order.
    Object.assign(item, { epoch: sequence, reason: item.document ? 'blocked-after-read' : item.reason || 'no-fresh-document', failed: undefined, document: undefined, invalid: true });
  };
  // Only such a request of the page's main frame can keep a stored value from a reviewed check, so only its failure
  // leaves the read unreadable. An image, a font, media, a stylesheet, a manifest, a third-party script, or anything an
  // embedded frame loads, a frame the run refuses included, cannot.
  const carriesData = (request: Request, page: Page) => {
    try {
      if (request.frame().parentFrame()) return false;
      const type = request.resourceType(), document = documents.get(request);
      if (type === 'document') return document !== undefined && document === state(page).document;
      return DATA.has(type) || type === 'script' && new URL(request.url()).origin === new URL(page.url()).origin;
    } catch { return false; }
  };
  // A blocked request that fails leaves its write uncertain, whatever it was.
  const invalidate = (request: Request) => {
    const page = owner(request), status = answered.get(request);
    if (!page) return;
    if (blockedRequests.has(request)) Object.assign(state(page), { invalid: true, reason: 'blocked-request-failed', failed: undefined });
    else if (carriesData(request, page)) Object.assign(state(page), { invalid: true, reason: 'read-failed', failed: { request, ...(status === undefined ? {} : { status }) } });
  };
  context.on('request', request => {
    const page = owner(request); if (!page || !top(request)) return;
    const item = state(page);
    item.document = undefined; item.invalid = true; item.reason = undefined; item.failed = undefined; item.readStarted = false;
    if (request.method() !== 'GET' || !item.epoch) return;
    const document: Document = { request, epoch: item.epoch, ok: false, responded: false, finished: false, committed: false };
    documents.set(request, document); item.document = document; item.invalid = false; item.readStarted = true;
  });
  context.on('response', response => {
    const request = response.request(), document = documents.get(request);
    if (document) Object.assign(document, { responded: true, ok: response.ok(), status: response.status() });
    // The block already invalidated its document. Its synthetic response may arrive after a paired
    // response wait starts the fresh GET; it is not a failed read of that new document.
    if (response.status() >= 400 && !blockedRequests.has(request)) { answered.set(request, response.status()); invalidate(request); }
  });
  context.on('requestfailed', invalidate);
  context.on('requestfinished', request => { const document = documents.get(request); if (document) document.finished = true; });
  const watch = (page: Page) => page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const document = state(page).document;
    if (document && unhashed(frame.url()) === unhashed(document.request.url())) document.committed = true;
  });
  context.pages().forEach(watch); context.on('page', watch);
  const readProblem = (page: Page | undefined, document: Document | undefined): ControlReadReason | undefined => {
    if (!page || page.isClosed()) return 'page-unavailable';
    const item = state(page);
    if (!item.epoch) return 'no-blocked-change';
    if (item.invalid && item.reason) return item.reason;
    if (!document) return 'no-fresh-document';
    if (item.document !== document) return 'document-replaced';
    if (item.invalid || document.responded && !document.ok) return 'read-failed';
    if (!document.ok || !document.finished) return 'read-incomplete';
    if (!document.committed) return 'document-not-committed';
    if (document.epoch !== item.epoch) return 'blocked-after-read';
    if (unhashed(page.url()) !== unhashed(document.request.url())) return 'url-changed';
  };
  const readable = (page: Page | undefined, document: Document | undefined) => readProblem(page, document) === undefined;
  // The request whose failure made a read 'read-failed': a recorded failure, else the judged document's own answer.
  const failure = (page: Page | undefined, document: Document | undefined): ControlFailedRead | undefined => {
    const failed = page && (state(page).failed ?? (document?.responded && !document.ok ? { request: document.request, status: document.status } : undefined));
    if (!failed) return undefined;
    const { request, status } = failed;
    return controlFailedRead({ resourceType: request.resourceType(), method: request.method(), url: request.url(), ...(status === undefined ? {} : { status }) }, known) ?? undefined;
  };
  function checkProblem(page: Page | undefined, check: EvaluatedCheck): ControlReadReason | undefined {
    if (!page) return 'page-unavailable';
    if (check.error || check.type === 'compare-number' && !Number.isFinite(check.observed)) return 'check-unreadable';
    if (check.type === 'compare-number') return captures.has(check.than) && captures.get(check.than)! < state(page).epoch ? undefined : 'baseline-not-before-change';
    if (check.type === 'url-contains' || !checkTemplate(check).includes(RUN)) return 'check-not-run-owned';
  }
  function eligible(page: Page | undefined, check: EvaluatedCheck) {
    if (!page || check.passed || check.error) return false;
    const item = state(page);
    if (!readable(page, item.document)) return false;
    // A missing label/baseline is unreadable, not evidence that the stored number stayed unchanged.
    return checkProblem(page, check) === undefined;
  }
  return {
    blocked,
    blockedRequest(request: Request) { blockedRequests.add(request); blocked(owner(request), { kind: 'http', method: request.method(), url: request.url() }); },
    blocks(page: Page | undefined) { return page ? state(page).blocks.map(block => ({ ...block })) : []; },
    captured(check: EvaluatedCheck) { if (check.type === 'read-number' && check.passed && Number.isFinite(check.observed)) captures.set(check.name, sequence); },
    eligible,
    // Snapshot before the browser observation. A later document can never certify this check,
    // either when its result arrives or when the fixture finishes reporting it.
    observation(page: Page | undefined) {
      const document = page ? state(page).document : undefined, initialReason = readProblem(page, document), started = !initialReason;
      const initialFailure = initialReason === 'read-failed' ? failure(page, document) : undefined;
      return Object.assign((check: EvaluatedCheck) => {
        const valid = () => readable(page, document) && eligible(page, check);
        return started && valid() ? valid : undefined;
      }, {
        reason(check: EvaluatedCheck) { return () => check.passed ? undefined : initialReason || readProblem(page, document) || checkProblem(page, check); },
        // The failed request behind that same reason, when it is a failed read.
        failedRead(check: EvaluatedCheck) { return () => check.passed ? undefined : initialReason ? initialFailure : readProblem(page, document) === 'read-failed' ? failure(page, document) : undefined; },
      });
    },
  };
}
