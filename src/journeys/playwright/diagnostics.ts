// Optional lifecycle evidence for browser failures. No URLs, page text, request bodies or error messages enter it.
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { hide, redact } from '../../redaction.ts';
import { privateDirectory, writeStateFile } from '../../store.ts';
import type { BrowserContext, CDPSession, Frame, Page } from '@playwright/test';

const SOURCES = new Set(['fixture', 'reporter', 'supervisor', 'runtime']);
const NAMES = new Set([
  'page-open', 'page-close', 'page-crash', 'page-load', 'page-domcontentloaded', 'frame-attached', 'frame-detached', 'frame-navigated',
  'context-close', 'browser-disconnected', 'cdp-attached', 'cdp-detached', 'diagnostic-unavailable', 'fixture-cleanup',
  'frame-started-loading', 'frame-stopped-loading', 'frame-started-navigating', 'frame-lifecycle', 'target-created', 'target-destroyed', 'target-detached', 'target-crashed',
  'document-request', 'document-response', 'reload-begin', 'reload-end', 'test-end', 'reporter-end',
  'worker-start', 'worker-stop', 'worker-signal', 'worker-exit', 'worker-close', 'worker-done', 'worker-diagnostic-truncated', 'runtime-cancel', 'runtime-end',
]);
const STRINGS: Record<string, ReadonlySet<string>> = {
  error: new Set(['none', 'inactive-page', 'closed', 'timeout', 'other']),
  status: new Set(['passed', 'failed', 'timedOut', 'interrupted', 'skipped']),
  reason: new Set(['cancel', 'deadline', 'protocol', 'consumer', 'descendants', 'remove', 'swap', 'RenderFrameHostChanged', 'target_closed', 'other']),
  signal: new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP']),
  method: new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'other']),
  lifecycle: new Set(['init', 'load', 'DOMContentLoaded', 'commit', 'networkAlmostIdle', 'networkIdle', 'firstMeaningfulPaintCandidate', 'firstContentfulPaint', 'firstPaint', 'other']),
  navigation: new Set(['reload', 'reloadBypassingCache', 'restore', 'restoreWithPost', 'historySameDocument', 'historyDifferentDocument', 'sameDocument', 'differentDocument', 'other']),
  targetType: new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker', 'other']),
};
const NUMBERS = ['page', 'frame', 'parent', 'loader', 'target', 'session', 'request', 'code', 'httpStatus', 'redirectStatus', 'dropped'];
const BOOLEANS = ['main', 'detached', 'closed', 'failed', 'cleanupIncomplete', 'timedOut', 'cdp'];
const CDP_EVENTS = [
  ['Page.frameAttached', 'frame-attached'], ['Page.frameDetached', 'frame-detached'], ['Page.frameNavigated', 'frame-navigated'],
  ['Page.frameStartedLoading', 'frame-started-loading'], ['Page.frameStoppedLoading', 'frame-stopped-loading'],
  ['Page.frameStartedNavigating', 'frame-started-navigating'], ['Page.lifecycleEvent', 'frame-lifecycle'],
  ['Target.targetCreated', 'target-created'], ['Target.targetDestroyed', 'target-destroyed'], ['Target.detachedFromTarget', 'target-detached'],
  ['Inspector.detached', 'target-detached'], ['Inspector.targetCrashed', 'target-crashed'],
  ['Network.requestWillBeSent', 'document-request'], ['Network.responseReceived', 'document-response'],
] as const;
export type LifecycleEvent = { source: string; name: string; at?: number; [key: string]: string | number | boolean | undefined };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Diagnostic inputs are untrusted; select fields rather than copying or clipping arbitrary text. */
export function lifecycleEvent(value: unknown): LifecycleEvent | null {
  if (!record(value) || typeof value.source !== 'string' || !SOURCES.has(value.source) || typeof value.name !== 'string' || !NAMES.has(value.name)) return null;
  const owner = value.name.startsWith('worker-') ? 'supervisor' : value.name.startsWith('runtime-') ? 'runtime'
    : ['reload-begin', 'reload-end', 'test-end', 'reporter-end'].includes(value.name) ? 'reporter' : 'fixture';
  if (value.source !== owner) return null;
  const result: LifecycleEvent = { source: value.source, name: value.name };
  if (typeof value.at === 'number' && Number.isSafeInteger(value.at) && value.at >= 0) result.at = value.at;
  for (const key of NUMBERS) if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const key of BOOLEANS) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const [key, values] of Object.entries(STRINGS)) if (typeof value[key] === 'string' && values.has(value[key])) result[key] = value[key];
  return result;
}

/** Observe the existing guard's CDP session; never wrap actions or capture their arguments. */
export function fixtureLifecycle(context: BrowserContext, send: (event: LifecycleEvent) => void) {
  const pages = new WeakMap<Page, number>(), frames = new WeakMap<Frame, number>(), ids = new Map<string, number>();
  let pageCount = 0, frameCount = 0, sent = 0, dropped = 0;
  const emit = (name: string, detail: Record<string, unknown> = {}, terminal = false) => {
    if (sent >= 1024 && !terminal) { dropped++; return; }
    const event = lifecycleEvent({ source: 'fixture', name, at: Date.now(), ...detail, ...(terminal ? { dropped } : {}) });
    if (event) { sent++; try { send(event); } catch { /* Optional evidence cannot stop a journey. */ } }
  };
  // Raw protocol identifiers are never persisted. Both their count and individual size are bounded.
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 128) return undefined;
    if (ids.has(value)) return ids.get(value);
    if (ids.size >= 1024) return undefined;
    const next = ids.size + 1; ids.set(value, next); return next;
  };
  const frameId = (frame: Frame) => {
    if (frames.has(frame)) return frames.get(frame);
    if (frameCount >= 1024) return undefined;
    const next = ++frameCount; frames.set(frame, next); return next;
  };
  context.on('close', () => emit('context-close', {}, true));
  context.browser()?.on('disconnected', () => emit('browser-disconnected', {}, true));
  return {
    cleanup() { emit('fixture-cleanup', {}, true); },
    page(page: Page) {
      if (pages.has(page) || pageCount >= 128) return;
      const number = ++pageCount; pages.set(page, number);
      emit('page-open', { page: number });
      page.on('close', () => emit('page-close', { page: number, closed: true }, true));
      page.on('crash', () => emit('page-crash', { page: number, closed: page.isClosed() }, true));
      page.on('domcontentloaded', () => emit('page-domcontentloaded', { page: number }));
      page.on('load', () => emit('page-load', { page: number }));
      const frameEvent = (name: string) => (frame: Frame) => emit(name, { page: number, frame: frameId(frame), main: frame === page.mainFrame(), detached: frame.isDetached(), cdp: false });
      page.on('frameattached', frameEvent('frame-attached')); page.on('framedetached', frameEvent('frame-detached')); page.on('framenavigated', frameEvent('frame-navigated'));
    },
    cdp(page: Page, cdp: CDPSession, targetInfo: unknown) {
      const number = pages.get(page);
      if (number === undefined) return;
      const target = record(targetInfo) ? id(targetInfo.targetId) : undefined;
      emit('cdp-attached', { page: number, target });
      cdp.on('close', () => emit('cdp-detached', { page: number, target }, true));
      const watch = (protocol: typeof CDP_EVENTS[number][0], name: string) => cdp.on(protocol, (value: unknown) => {
        if (!record(value)) return;
        const frame = record(value.frame) ? value.frame : {}, info = record(value.targetInfo) ? value.targetInfo : {};
        const request = record(value.request) ? value.request : {}, response = record(value.response) ? value.response : {}, redirect = record(value.redirectResponse) ? value.redirectResponse : {};
        // Network events include every resource; keep only document method/status and opaque identities.
        if (protocol.startsWith('Network.') && value.type !== 'Document') return;
        emit(name, {
          page: number, cdp: true, target: id(value.targetId ?? info.targetId) ?? target, frame: id(value.frameId ?? frame.id), parent: id(value.parentFrameId ?? frame.parentId),
          loader: id(value.loaderId ?? frame.loaderId), session: id(value.sessionId), request: id(value.requestId),
          lifecycle: typeof value.name === 'string' && STRINGS.lifecycle.has(value.name) ? value.name : undefined,
          reason: typeof value.reason === 'string' && STRINGS.reason.has(value.reason) ? value.reason : undefined,
          navigation: typeof value.navigationType === 'string' && STRINGS.navigation.has(value.navigationType) ? value.navigationType : undefined,
          targetType: typeof info.type === 'string' && STRINGS.targetType.has(info.type) ? info.type : undefined,
          method: typeof request.method === 'string' && STRINGS.method.has(request.method) ? request.method : undefined,
          httpStatus: response.status, redirectStatus: redirect.status,
        });
      });
      for (const [protocol, name] of CDP_EVENTS) watch(protocol, name);
      // These enable observation only. A failure is recorded, never awaited by navigation or cleanup.
      void Promise.all([cdp.send('Page.enable'), cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }), cdp.send('Network.enable'), cdp.send('Target.setDiscoverTargets', { discover: true })])
        .catch(() => emit('diagnostic-unavailable', { page: number }));
    },
  };
}

/** Classify only; Playwright errors can contain page content, URLs and credentials. */
export function lifecycleError(error: unknown): string {
  const message = error instanceof Error ? error.message : record(error) && typeof error.message === 'string' ? error.message : '';
  return /Not attached to an active page/.test(message) ? 'inactive-page' : /closed/i.test(message) ? 'closed' : /timeout|timed out/i.test(message) ? 'timeout' : error ? 'other' : 'none';
}

/** One bounded in-memory run, saved after cleanup only for a failed ordinary run. Storage is always best effort. */
export function createLifecycleRecorder({ directory, secrets = [], blockWrites = false }: { directory?: string; secrets?: string[]; blockWrites?: boolean }) {
  const enabled = typeof directory === 'string' && isAbsolute(directory) && !blockWrites;
  const events: LifecycleEvent[] = [], safe = hide(secrets), startedAt = Date.now();
  let dropped = 0, finished = false, truncated = false;
  return {
    enabled,
    record(value: unknown) {
      if (!enabled || finished) return;
      const event = lifecycleEvent(value);
      if (!event) return;
      truncated ||= event.name === 'worker-diagnostic-truncated' || typeof event.dropped === 'number' && event.dropped > 0;
      // Redact individual values before JSON encoding: a secret may itself include JSON punctuation.
      for (const [key, value] of Object.entries(event)) if (typeof value === 'string') event[key] = redact(safe(value));
      events.push({ at: Date.now(), ...event });
      if (events.length > 512) { events.shift(); dropped++; }
    },
    async finish(failed: boolean) {
      if (finished) return;
      finished = true;
      if (!enabled || !failed) return;
      try {
        const content = JSON.stringify({ version: 1, startedAt, dropped, truncated: truncated || dropped > 0, events }) + '\n';
        const root = await privateDirectory(directory!, 'A diagnostic directory cannot be a symbolic link.');
        await writeStateFile(join(root, `playwright-${randomUUID()}.json`), content, { prefix: '.playwright-', removeTemporary: true });
      } catch { /* Diagnostics must never change the result or retain browser ownership. */ }
    },
  };
}
