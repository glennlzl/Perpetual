import { controllerFetch } from './api.ts';

/** The journey a frame belongs to: one case of one run. */
export interface FrameSource { repoPath: string; stageId: string; runId: string; caseId: string }
/** The latest frame's object URL, or the last fetch's error. */
export interface FrameSnapshot { identity: string; url: string; error: string; receivedAt: number; checkedAt: number }
/** The journey's state as a view reports it; revision is a key that changes with the journey's own events. */
export interface FrameProgress { status?: string; revision?: string | number }
type FrameMode = 'idle' | 'stream' | 'final' | 'done';
interface FrameEntry {
  identity: string; source: FrameSource; subscribers: Map<object, { listener: () => void; interval: number }>; snapshot: FrameSnapshot; mode: FrameMode; terminal: boolean;
  revision: string | number | undefined; fetchedRevision: string | number | undefined; fetchedAt: number; request: AbortController | null; timer: ReturnType<typeof setTimeout> | undefined;
  /** Failed fetches of a finished journey's last frame so far. */
  retries: number;
}
export type FrameStore = ReturnType<typeof createFrameStore>;

const EMPTY: FrameSnapshot = Object.freeze({ identity: '', url: '', error: '', receivedAt: 0, checkedAt: 0 });
// A failed last frame is fetched again after 1, 2 and 4 seconds, then left until the page is shown again.
const FINAL_RETRIES = 3;
const streaming = (status: string | undefined) => ['running', 'skipping', 'cancelling'].includes(status ?? '');
const modeOf = (status: string | undefined): FrameMode => streaming(status) ? 'stream' : ['queued', 'pending'].includes(status ?? '') ? 'idle' : 'final';
export const frameIdentity = ({ repoPath = '', stageId = '', runId = '', caseId = '' }: Partial<FrameSource>) => JSON.stringify([repoPath, stageId, runId, caseId]);

// One fetch loop per journey identity, shared by every viewport showing it. A loop
// runs only while someone watches a visible page; no frame is reused across identities.
// Under reduced motion a new journey revision refreshes no sooner than reducedFloor after the last frame.
export function createFrameStore({ load, hidden = () => false, reducedMotion = () => false, createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url), reducedInterval = 5000, reducedFloor = 2000 }: {
  load: (source: FrameSource, signal: AbortSignal) => Promise<Blob | null | undefined>; hidden?: () => boolean; reducedMotion?: () => boolean;
  createUrl?: (blob: Blob) => string; revokeUrl?: (url: string) => void; reducedInterval?: number; reducedFloor?: number;
}) {
  const entries = new Map<string, FrameEntry>();
  function dispose(entry: FrameEntry) {
    clearTimeout(entry.timer); entry.request?.abort(); entry.request = null;
    if (entry.snapshot.url) revokeUrl(entry.snapshot.url);
    entries.delete(entry.identity);
  }
  function schedule(entry: FrameEntry) {
    clearTimeout(entry.timer); entry.timer = undefined;
    if (!entry.subscribers.size || entry.request || hidden() || ['idle', 'done'].includes(entry.mode)) return;
    if (entry.mode === 'final') {
      const retry = entry.retries ? entry.fetchedAt + 1000 * 2 ** (entry.retries - 1) - Date.now() : 0;
      if (retry <= 0) return void capture(entry);
      entry.timer = setTimeout(() => schedule(entry), retry);
      return;
    }
    const interval = !reducedMotion() ? Math.min(...[...entry.subscribers.values()].map(item => item.interval)) : entry.fetchedRevision !== entry.revision ? reducedFloor : reducedInterval;
    const wait = entry.fetchedAt + interval - Date.now();
    if (wait <= 0) return void capture(entry);
    entry.timer = setTimeout(() => schedule(entry), wait);
  }
  async function capture(entry: FrameEntry) {
    const request = new AbortController(), mode = entry.mode, revision = entry.revision;
    entry.request = request;
    let url = '', error = '';
    try { const blob = await load(entry.source, request.signal); if (blob && !request.signal.aborted) url = createUrl(blob); }
    catch (failure) { error = (failure as Error | null)?.message || 'Stream unavailable'; }
    if (entry.request !== request) { if (url) revokeUrl(url); return; }
    entry.request = null; entry.fetchedAt = Date.now(); entry.fetchedRevision = revision;
    if (mode === 'final' && entry.mode === 'final') { if (error && entry.retries < FINAL_RETRIES) entry.retries++; else entry.mode = 'done'; }
    const previous = entry.snapshot.url;
    entry.snapshot = { identity: entry.identity, url: url || previous, error, receivedAt: url ? entry.fetchedAt : entry.snapshot.receivedAt, checkedAt: entry.fetchedAt };
    if (url && previous) revokeUrl(previous);
    for (const { listener } of [...entry.subscribers.values()]) listener();
    schedule(entry);
  }
  function update(entry: FrameEntry, { status, revision }: FrameProgress) {
    if (revision !== undefined) entry.revision = revision;
    const mode = modeOf(status);
    // A terminal journey never streams again, even if a lagging view still reports it active.
    if (mode === 'final') { entry.terminal = true; if (entry.mode !== 'done') entry.mode = 'final'; }
    else if (!entry.terminal) entry.mode = mode;
  }
  return {
    subscribe(source: FrameSource, listener: () => void, { interval = 350, status, revision }: FrameProgress & { interval?: number } = {}) {
      const identity = frameIdentity(source);
      let entry = entries.get(identity);
      if (!entry) { entry = { identity, source: { ...source }, subscribers: new Map(), snapshot: { ...EMPTY, identity }, mode: 'idle', terminal: false, revision, fetchedRevision: undefined, fetchedAt: -Infinity, request: null, timer: undefined, retries: 0 }; entries.set(identity, entry); }
      const token = {};
      entry.subscribers.set(token, { listener, interval });
      update(entry, { status, revision });
      schedule(entry);
      return () => { entry.subscribers.delete(token); if (!entry.subscribers.size && entries.get(identity) === entry) dispose(entry); };
    },
    update(source: FrameSource, next: FrameProgress) { const entry = entries.get(frameIdentity(source)); if (entry) { update(entry, next); schedule(entry); } },
    getSnapshot: (source: FrameSource) => entries.get(frameIdentity(source))?.snapshot || EMPTY,
    resume() {
      for (const entry of entries.values()) {
        if (entry.mode === 'done' && entry.snapshot.error) { entry.mode = 'final'; entry.retries = 0; }
        schedule(entry);
      }
    },
    size: () => entries.size,
  };
}

export async function fetchJourneyFrame({ repoPath, stageId, runId, caseId }: FrameSource, signal: AbortSignal) {
  const response = await controllerFetch(`/api/browser/runs/${encodeURIComponent(runId)}/frame?${new URLSearchParams({ repoPath, stageId, caseId })}`, { headers: { Accept: 'image/jpeg' }, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }, signal);
  if (response.status === 204) return null;
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Stream unavailable');
  return response.blob();
}

let shared: FrameStore | undefined;
export function sharedFrameStore() {
  if (shared) return shared;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  shared = createFrameStore({ load: fetchJourneyFrame, hidden: () => document.hidden, reducedMotion: () => motion.matches });
  document.addEventListener('visibilitychange', shared.resume);
  motion.addEventListener('change', shared.resume);
  return shared;
}
