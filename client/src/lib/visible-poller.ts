import { sourceBusy } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';

export type PollResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * One read at a time while the page is visible. A refresh requested during a read
 * runs once after it settles, and stopping prevents that read from publishing.
 * The caller owns the result, failures and cadence; this module owns their lifetime.
 * A read the controller refused while it saved a source change publishes nothing:
 * the caller keeps its last result, and the next read follows at its interval.
 */
export function createVisiblePoller<T>({ read, onResult, interval, document = globalThis.document, timers = globalThis }: {
  read: () => Promise<T>; onResult: (result: PollResult<T>) => void; interval: () => number;
  document?: PageVisibility | null; timers?: Timers;
}) {
  let timer: unknown, stopped = false, loading = false, again = false;
  async function poll(): Promise<void> {
    if (stopped || document?.hidden) return;
    if (loading) { again = true; return; }
    loading = true;
    let result: PollResult<T>;
    try { result = { ok: true, value: await read() }; }
    catch (error) { result = { ok: false, error }; }
    if (stopped) { loading = false; return; }
    try { if (result.ok || !sourceBusy(result.error)) onResult(result); }
    finally { loading = false; }
    if (stopped) return;
    if (again) { again = false; return poll(); }
    timers.clearTimeout(timer);
    if (!document?.hidden) timer = timers.setTimeout(poll, interval());
  }
  const refresh = () => { timers.clearTimeout(timer); void poll(); };
  const visibility = () => { if (!document?.hidden && !stopped) refresh(); };
  document?.addEventListener?.('visibilitychange', visibility);
  void poll();
  return {
    refresh,
    stop() { stopped = true; timers.clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); },
  };
}
