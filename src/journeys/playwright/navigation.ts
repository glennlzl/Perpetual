import { errors, type CDPSession, type Page } from '@playwright/test';

export const NAVIGATION_TIMEOUT_MS = 20000;
type WaitStep = (action: () => Promise<void>) => Promise<void>;

/**
 * Chromium emits frameNavigated before its new RenderFrameHost becomes active. A click can therefore finish while
 * browser-side Page.reload still rejects that host. A renderer-side read waits for Chromium's navigation suspension
 * to end, without waiting for page assets or repeating a navigation. Use the guard's existing session.
 */
export function synchronizeReload(page: Page, cdp: CDPSession, waitStep: WaitStep) {
  const reload = page.reload.bind(page);
  page.reload = async options => {
    if (page.isClosed()) return reload(options);
    const timeout = options?.timeout ?? NAVIGATION_TIMEOUT_MS, started = performance.now();
    const expired = () => new errors.TimeoutError(`page.reload: Timeout ${timeout}ms exceeded while waiting for the current document to become active.`);
    await waitStep(async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const ready = cdp.send('Page.getFrameTree').then(() => {});
        await (timeout > 0 ? Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expired()), timeout); })]) : ready);
      } finally { clearTimeout(timer); }
    });
    const remaining = timeout - (performance.now() - started);
    if (timeout > 0 && remaining <= 0) throw expired();
    // One navigation budget covers both synchronization and the one actual reload. Zero still disables it.
    return reload({ ...options, timeout: timeout > 0 ? remaining : timeout });
  };
}
