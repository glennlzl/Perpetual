import type { BrowserContext, Page, Request } from '@playwright/test';
import type { ControlReadReason } from '../../../contract/browser.ts';
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
  'read-failed': 'A request failed while reading the judged page. Resolve the failed read before checking persistence.',
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

/** A control failure needs a fresh document of the judged page, after its blocked change. */
export function controlReads(context: BrowserContext) {
  type Document = { request: Request; epoch: number; ok: boolean; responded: boolean; finished: boolean; committed: boolean };
  type State = { epoch: number; document?: Document; invalid: boolean; reason?: ControlReadReason };
  const pages = new WeakMap<Page, State>(), documents = new WeakMap<Request, Document>(), blockedRequests = new WeakSet<Request>(), captures = new Map<string, number>();
  let sequence = 0;
  const state = (page: Page) => { let item = pages.get(page); if (!item) { item = { epoch: 0, invalid: true }; pages.set(page, item); } return item; };
  const owner = (request: Request) => { try { return request.frame().page(); } catch { return undefined; } };
  const top = (request: Request) => { try { return request.isNavigationRequest() && !request.frame().parentFrame(); } catch { return false; } };
  const blocked = (page: Page | undefined) => { sequence++; if (page) { const item = state(page); Object.assign(item, { epoch: sequence, reason: item.document ? 'blocked-after-read' : item.reason || 'no-fresh-document', document: undefined, invalid: true }); } };
  const invalidate = (request: Request) => { const page = owner(request); if (page) Object.assign(state(page), { invalid: true, reason: blockedRequests.has(request) ? 'blocked-request-failed' : 'read-failed' }); };
  context.on('request', request => {
    const page = owner(request); if (!page || !top(request)) return;
    const item = state(page);
    item.document = undefined; item.invalid = true; item.reason = undefined;
    if (request.method() !== 'GET' || !item.epoch) return;
    const document: Document = { request, epoch: item.epoch, ok: false, responded: false, finished: false, committed: false };
    documents.set(request, document); item.document = document; item.invalid = false;
  });
  context.on('response', response => {
    const request = response.request(), document = documents.get(request);
    if (document) { document.responded = true; document.ok = response.ok(); }
    // The block already invalidated its document. Its synthetic response may arrive after a paired
    // response wait starts the fresh GET; it is not a failed read of that new document.
    if (response.status() >= 400 && !blockedRequests.has(request)) invalidate(request);
  });
  context.on('requestfailed', invalidate);
  context.on('requestfinished', request => { const document = documents.get(request); if (document) document.finished = true; });
  const watch = (page: Page) => page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const document = state(page).document;
    if (document && frame.url() === document.request.url()) document.committed = true;
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
    if (page.url() !== document.request.url()) return 'url-changed';
  };
  const readable = (page: Page | undefined, document: Document | undefined) => readProblem(page, document) === undefined;
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
    blockedRequest(request: Request) { blockedRequests.add(request); blocked(owner(request)); },
    captured(check: EvaluatedCheck) { if (check.type === 'read-number' && check.passed && Number.isFinite(check.observed)) captures.set(check.name, sequence); },
    eligible,
    // Snapshot before the browser observation. A later document can never certify this check,
    // either when its result arrives or when the fixture finishes reporting it.
    observation(page: Page | undefined) {
      const document = page ? state(page).document : undefined, initialReason = readProblem(page, document), started = !initialReason;
      return Object.assign((check: EvaluatedCheck) => {
        const valid = () => readable(page, document) && eligible(page, check);
        return started && valid() ? valid : undefined;
      }, { reason(check: EvaluatedCheck) { return () => check.passed ? undefined : initialReason || readProblem(page, document) || checkProblem(page, check); } });
    },
  };
}
