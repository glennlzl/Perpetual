import type { BrowserContext, Page, Request } from '@playwright/test';
import { RUN, checkTemplate, type EvaluatedCheck } from './checks.ts';

// Chromium reports a document's request without its fragment, while frame and page URLs keep it, as a hash route does.
const unhashed = (url: string) => url.split('#')[0];

/** A control failure needs a fresh document of the judged page, after its blocked change. */
export function controlReads(context: BrowserContext) {
  type Document = { request: Request; epoch: number; ok: boolean; finished: boolean; committed: boolean };
  type State = { epoch: number; document?: Document; invalid: boolean };
  const pages = new WeakMap<Page, State>(), documents = new WeakMap<Request, Document>(), captures = new Map<string, number>();
  let sequence = 0;
  const state = (page: Page) => { let item = pages.get(page); if (!item) { item = { epoch: 0, invalid: true }; pages.set(page, item); } return item; };
  const owner = (request: Request) => { try { return request.frame().page(); } catch { return undefined; } };
  const top = (request: Request) => { try { return request.isNavigationRequest() && !request.frame().parentFrame(); } catch { return false; } };
  const blocked = (page: Page | undefined) => { sequence++; if (page) Object.assign(state(page), { epoch: sequence, document: undefined, invalid: true }); };
  const invalidate = (request: Request) => { const page = owner(request); if (page) state(page).invalid = true; };
  context.on('request', request => {
    const page = owner(request); if (!page || !top(request)) return;
    const item = state(page);
    item.document = undefined; item.invalid = true;
    if (request.method() !== 'GET' || !item.epoch) return;
    const document: Document = { request, epoch: item.epoch, ok: false, finished: false, committed: false };
    documents.set(request, document); item.document = document; item.invalid = false;
  });
  context.on('response', response => {
    const request = response.request(), document = documents.get(request);
    if (document) document.ok = response.ok();
    if (response.status() >= 400) invalidate(request);
  });
  context.on('requestfailed', invalidate);
  context.on('requestfinished', request => { const document = documents.get(request); if (document) document.finished = true; });
  const watch = (page: Page) => page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const document = state(page).document;
    if (document && unhashed(frame.url()) === unhashed(document.request.url())) document.committed = true;
  });
  context.pages().forEach(watch); context.on('page', watch);
  const readable = (page: Page | undefined, document: Document | undefined) => {
    if (!page || page.isClosed() || !document) return false;
    const item = state(page);
    return item.document === document && !item.invalid && document.ok && document.finished && document.committed && document.epoch === item.epoch && unhashed(page.url()) === unhashed(document.request.url());
  };
  function eligible(page: Page | undefined, check: EvaluatedCheck) {
    if (!page || check.passed || check.error) return false;
    const item = state(page);
    if (!readable(page, item.document)) return false;
    // A missing label/baseline is unreadable, not evidence that the stored number stayed unchanged.
    if (check.type === 'compare-number') return Number.isFinite(check.observed) && captures.has(check.than) && captures.get(check.than)! < item.epoch;
    return check.type !== 'url-contains' && checkTemplate(check).includes(RUN);
  }
  return {
    blocked,
    blockedRequest(request: Request) { blocked(owner(request)); },
    captured(check: EvaluatedCheck) { if (check.type === 'read-number' && check.passed && Number.isFinite(check.observed)) captures.set(check.name, sequence); },
    eligible,
    // Snapshot before the browser observation. A later document can never certify this check,
    // either when its result arrives or when the fixture finishes reporting it.
    observation(page: Page | undefined) {
      const document = page ? state(page).document : undefined, started = readable(page, document);
      return (check: EvaluatedCheck) => {
        const valid = () => readable(page, document) && eligible(page, check);
        return started && valid() ? valid : undefined;
      };
    },
  };
}
