import { createHash, timingSafeEqual } from 'node:crypto';
import type { TrialDisconnectReply, TrialGmailProfileReply, TrialIdentityProfileReply, TrialLinkReply, TrialProfileReply, TrialStatusReply } from '../../contract/broker-trial.ts';

/** The deliberately narrow adapter boundary for one provider trial. */
export interface Adapter {
  start(userId: string): Promise<{ id: string; redirectUrl: string }>;
  inspect(id: string): Promise<{ userId: string; toolkit: string; authConfigId: string; status: string }>;
  remove(id: string, userId: string, terminalStatuses?: readonly string[]): Promise<'removed' | 'not-found'>;
  profile(id: string, userId: string): Promise<TrialProfileReply | TrialIdentityProfileReply | TrialGmailProfileReply>;
}
export type BrokerProvider = 'linear' | 'gmail' | 'slack' | 'jira';

export interface BrokerPrincipal { id: string; tokenHash: string }
export interface BrokerStateConnection { principalId: string; id?: string; createdAt: number; failed?: true; linked?: true; redirectUrl?: string }
export interface BrokerState { version: 1; connections: BrokerStateConnection[] }
export interface BrokerStateStore { load(): Promise<unknown>; save(state: BrokerState): Promise<void> }
export interface BrokerOptions {
  adapter: Adapter;
  expectedAuthConfigId: string;
  provider?: BrokerProvider;
  principals: BrokerPrincipal[];
  /** Per-principal request budget. Kept configurable so tests can use a small value. */
  requestsPerMinute?: number;
  now?: () => number;
  /** Optional durable metadata store. It must not contain provider tokens or credentials. */
  stateStore?: BrokerStateStore;
}

interface Connection { id?: string; redirectUrl?: string; createdAt: number; failed?: true; linked?: true }
interface OwnedConnection { id?: string; status: 'connected' | 'pending' | 'unverified' | 'needs-auth' }
const MAX_BODY_BYTES = 1024;
const PENDING_TTL_MS = 10 * 60_000;
const ERROR = Object.freeze({ error: 'Request could not be completed.' });
const NO_AUTH = Object.freeze({ error: 'Authentication required.' });
const NOT_FOUND = Object.freeze({ error: 'Not found.' });
const INVALID = Object.freeze({ error: 'Invalid request.' });
const BUSY = Object.freeze({ error: 'Request limit reached. Try again shortly.' });
const UNAVAILABLE = Object.freeze({ error: 'Connection is not ready.' });
const TERMINAL_STATUSES = new Set(['REVOKED', 'EXPIRED', 'FAILED', 'INACTIVE']);
const PENDING_STATUSES = new Set(['INITIALIZING', 'INITIATED', 'PENDING']);
const hash = (token: string) => createHash('sha256').update(token).digest();

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readSmallBody(request: Request): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } catch { return undefined; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return undefined; }
  return text;
}

async function emptyJson(request: Request): Promise<boolean> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) return false;
  const text = await readSmallBody(request);
  if (text === undefined) return false;
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

async function noBody(request: Request): Promise<boolean> { return await readSmallBody(request) === ''; }

/**
 * Creates a server-to-server-only request handler. Connection IDs stay in this process and are
 * always selected from the authenticated principal's private mapping.
 */
export interface BrokerHandler { (request: Request): Promise<Response>; ready: Promise<void> }

function stateObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

export function createBroker({ adapter, expectedAuthConfigId, provider = 'linear', principals, requestsPerMinute = 30, now = Date.now, stateStore }: BrokerOptions): BrokerHandler {
  if (!expectedAuthConfigId || !Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) throw new Error('Invalid broker configuration.');
  const byId = new Map<string, { tokenHash: Buffer }>();
  const seenHashes = new Set<string>();
  const connections = new Map<string, Connection>();
  const queues = new Map<string, Promise<void>>();
  const budgets = new Map<string, { started: number; count: number }>();
  const principalIds = new Set<string>();
  for (const principal of principals) {
    if (!principal.id || byId.has(principal.id) || !/^[a-f0-9]{64}$/iu.test(principal.tokenHash) || seenHashes.has(principal.tokenHash.toLowerCase())) throw new Error('Invalid broker principal configuration.');
    seenHashes.add(principal.tokenHash.toLowerCase());
    principalIds.add(principal.id);
    byId.set(principal.id, { tokenHash: Buffer.from(principal.tokenHash, 'hex') });
  }

  function snapshot(): BrokerState {
    return { version: 1, connections: [...connections].map(([principalId, value]) => ({ principalId, ...value })) };
  }

  let saving: Promise<unknown> = Promise.resolve();
  async function persist(): Promise<void> {
    if (!stateStore) return;
    const state = snapshot();
    const operation = saving.then(() => stateStore.save(state));
    saving = operation.catch(() => {});
    await operation;
  }

  const ready = (async () => {
    if (!stateStore) return;
    const raw: unknown = await stateStore.load();
    if (raw === undefined) return;
    if (!stateObject(raw) || Object.keys(raw).sort().join(',') !== 'connections,version' || raw.version !== 1 || !Array.isArray(raw.connections) || raw.connections.length > principals.length) throw new Error('Invalid broker connection state.');
    const seenPrincipals = new Set<string>(), seenIds = new Set<string>();
    for (const item of raw.connections) {
      if (!stateObject(item)) throw new Error('Invalid broker connection state.');
      const allowed = ['principalId', 'id', 'createdAt', 'failed', 'linked', 'redirectUrl'];
      if (Object.keys(item).some(key => !allowed.includes(key)) || typeof item.principalId !== 'string' || !principalIds.has(item.principalId) ||
          seenPrincipals.has(item.principalId) || !Number.isSafeInteger(item.createdAt) || (item.createdAt as number) < 0 || (item.createdAt as number) > now() + 60_000) throw new Error('Invalid broker connection state.');
      seenPrincipals.add(item.principalId);
      const tombstone = item.failed === true;
      if (tombstone) {
        if (item.id !== undefined || item.linked !== undefined || item.redirectUrl !== undefined) throw new Error('Invalid broker connection state.');
        connections.set(item.principalId, { createdAt: item.createdAt as number, failed: true });
        continue;
      }
      if (item.failed !== undefined || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(item.id) || seenIds.has(item.id) ||
          item.linked !== undefined && item.linked !== true || item.redirectUrl !== undefined && (typeof item.redirectUrl !== 'string' || item.redirectUrl.length > 4096)) throw new Error('Invalid broker connection state.');
      seenIds.add(item.id);
      let redirectUrl: string | undefined;
      if (item.redirectUrl !== undefined) {
        try {
          const url = new URL(item.redirectUrl);
          if (url.protocol !== 'https:' || url.username || url.password || !['backend.composio.dev', 'connect.composio.dev'].includes(url.hostname.toLowerCase())) throw new Error();
          redirectUrl = url.toString();
        } catch { throw new Error('Invalid broker connection state.'); }
      }
      connections.set(item.principalId, { id: item.id, createdAt: item.createdAt as number, ...(item.linked ? { linked: true as const } : {}), ...(redirectUrl ? { redirectUrl } : {}) });
    }
  })();

  function principalFor(request: Request): string | undefined {
    const header = request.headers.get('authorization');
    const match = header && /^Bearer ([A-Za-z0-9._~+/-]{20,256})$/u.exec(header);
    if (!match) return undefined;
    const candidate = hash(match[1]!);
    let selected: string | undefined;
    // Check every configured principal so a match does not disclose which entry was found early.
    for (const [id, principal] of byId) if (timingSafeEqual(candidate, principal.tokenHash)) selected = id;
    return selected;
  }

  function allowed(principalId: string): boolean {
    const time = now(), prior = budgets.get(principalId);
    if (!prior || time - prior.started >= 60_000 || time < prior.started) {
      budgets.set(principalId, { started: time, count: 1 });
      return true;
    }
    if (prior.count >= requestsPerMinute) return false;
    prior.count++;
    return true;
  }

  async function serialized<T>(principalId: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(principalId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    queues.set(principalId, current);
    await previous;
    try { return await work(); }
    finally { release(); if (queues.get(principalId) === current) queues.delete(principalId); }
  }

  async function inspectOwned(principalId: string): Promise<OwnedConnection | undefined> {
    const connection = connections.get(principalId);
    if (!connection) return undefined;
    if (connection.failed || !connection.id) return { status: 'needs-auth' };
    try {
      const details = await adapter.inspect(connection.id);
      const ownerMatches = details.userId === principalId && details.toolkit.toLowerCase() === provider && details.authConfigId === expectedAuthConfigId;
      if (!ownerMatches) return { id: connection.id, status: 'unverified' };
      if (details.status === 'ACTIVE') {
        if (!connection.linked) {
          connection.linked = true;
          try { await persist(); } catch (error) { delete connection.linked; throw error; }
        }
        return { id: connection.id, status: 'connected' };
      }
      if (!connection.linked && now() - connection.createdAt >= PENDING_TTL_MS) return { id: connection.id, status: 'needs-auth' };
      if (['INITIALIZING', 'INITIATED', 'PENDING'].includes(details.status)) return { id: connection.id, status: 'pending' };
      if (['REVOKED', 'EXPIRED', 'FAILED', 'INACTIVE'].includes(details.status)) return { id: connection.id, status: 'needs-auth' };
      return { id: connection.id, status: 'unverified' };
    } catch {
      return { id: connection.id, status: !connection.linked && now() - connection.createdAt >= PENDING_TTL_MS ? 'needs-auth' : 'unverified' };
    }
  }

  const handle: BrokerHandler = async function handle(request: Request): Promise<Response> {
    try { await ready; } catch { return json(503, ERROR); }
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) return json(403, ERROR);
    const url = new URL(request.url);
    if (url.search || url.hash) return json(400, INVALID);
    const actions = ['connect', 'status', 'profile', 'disconnect'] as const;
    const routeMatch = provider === 'linear'
      ? /^\/trial\/(?:linear\/)?(connect|status|profile|disconnect)$/u.exec(url.pathname)
      : new RegExp(`^/trial/${provider}/(connect|status|profile|disconnect)$`, 'u').exec(url.pathname);
    const action = routeMatch?.[1];
    if (!action || !actions.includes(action as typeof actions[number])) return json(404, NOT_FOUND);
    const route = `${request.method} ${action}`;
    if (!['POST connect', 'GET status', 'POST profile', 'POST disconnect'].includes(route)) return json(404, NOT_FOUND);
    const principalId = principalFor(request);
    if (!principalId) return json(401, NO_AUTH);
    if (!allowed(principalId)) return json(429, BUSY);

    if (request.method === 'POST' && !await emptyJson(request) || request.method === 'GET' && !await noBody(request)) return json(400, INVALID);
    return serialized(principalId, async () => {
      try {
        if (route === 'POST connect') {
          let existing = connections.get(principalId);
          if (existing) {
            // An uncertain link creation has no account ID to inspect, so it must remain a
            // tombstone. For tracked accounts, only verified terminal accounts can be removed
            // automatically before a replacement is created.
            if (existing.failed || !existing.id) return json(502, ERROR);
            let details: Awaited<ReturnType<Adapter['inspect']>>;
            try { details = await adapter.inspect(existing.id); }
            catch { return json(502, ERROR); }
            const ownerMatches = details.userId === principalId && details.toolkit.toLowerCase() === provider && details.authConfigId === expectedAuthConfigId;
            if (!ownerMatches) return json(409, UNAVAILABLE);

            const terminal = TERMINAL_STATUSES.has(details.status);
            if (terminal) {
              let removed: 'removed' | 'not-found';
              try { removed = await adapter.remove(existing.id, principalId, [...TERMINAL_STATUSES]); }
              catch { return json(502, ERROR); }
              if (removed !== 'removed' && removed !== 'not-found') return json(502, ERROR);
              connections.delete(principalId);
              try { await persist(); }
              catch { connections.set(principalId, existing); return json(502, ERROR); }
              existing = undefined;
            } else if (!existing.linked && PENDING_STATUSES.has(details.status) && existing.redirectUrl && now() - existing.createdAt < PENDING_TTL_MS) {
              return json(200, { redirectUrl: existing.redirectUrl } satisfies TrialLinkReply);
            } else {
              return json(502, ERROR);
            }
          }
          // A failed request may have reached Composio. Persist a tombstone before the call so a
          // restart also blocks another authorization attempt instead of risking a duplicate link.
          const tombstone: Connection = { createdAt: now(), failed: true };
          connections.set(principalId, tombstone);
          try { await persist(); } catch { connections.delete(principalId); return json(503, ERROR); }
          const started = await adapter.start(principalId);
          let redirect: URL;
          try { redirect = new URL(started.redirectUrl); } catch { return json(502, ERROR); }
          if (!started.id || !/^[A-Za-z0-9_-]{1,256}$/u.test(started.id) || redirect.protocol !== 'https:' || redirect.username || redirect.password || !['backend.composio.dev', 'connect.composio.dev'].includes(redirect.hostname.toLowerCase())) return json(502, ERROR);
          connections.set(principalId, { id: started.id, redirectUrl: started.redirectUrl, createdAt: now() });
          try { await persist(); } catch { connections.set(principalId, tombstone); await persist().catch(() => {}); return json(502, ERROR); }
          return json(200, { redirectUrl: started.redirectUrl } satisfies TrialLinkReply);
        }

        if (route === 'POST disconnect') {
          const existing = connections.get(principalId);
          if (!existing) return json(200, { status: 'not-connected' } satisfies TrialDisconnectReply);
          // An uncertain creation has no safe account ID to revoke. Keep its tombstone so a later
          // connect cannot silently make a duplicate authorization attempt.
          if (existing.failed || !existing.id) return json(502, ERROR);
          const details = await adapter.inspect(existing.id);
          const ownerMatches = details.userId === principalId && details.toolkit.toLowerCase() === provider && details.authConfigId === expectedAuthConfigId;
          if (!ownerMatches) return json(409, UNAVAILABLE);
          const removed = await adapter.remove(existing.id, principalId);
          if (removed !== 'removed' && removed !== 'not-found') return json(502, ERROR);
          connections.delete(principalId);
          try { await persist(); } catch {
            connections.set(principalId, existing);
            return json(502, ERROR);
          }
          return json(200, { status: 'not-connected' } satisfies TrialDisconnectReply);
        }

        const owned = await inspectOwned(principalId);
        if (!owned) return route === 'POST profile' ? json(409, UNAVAILABLE) : json(200, { status: 'not-connected' } satisfies TrialStatusReply);
        if (route === 'GET status') return json(200, { status: owned.status } satisfies TrialStatusReply);
        if (owned.status !== 'connected') return json(409, UNAVAILABLE);

        if (!owned.id) return json(409, UNAVAILABLE);
        const profile = await adapter.profile(owned.id, principalId);
        const safeField = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
        if (provider === 'linear') {
          if (!('id' in profile) || !('name' in profile) || !('email' in profile) || !safeField(profile.id, 256) || !safeField(profile.name, 256) || !safeField(profile.email, 320)) return json(502, ERROR);
          return json(200, { id: profile.id, name: profile.name, email: profile.email } satisfies TrialProfileReply);
        }
        if (provider === 'slack' || provider === 'jira') {
          if (!('label' in profile) || !('id' in profile) || !safeField(profile.id, 256) || !safeField(profile.label, 320)) return json(502, ERROR);
          return json(200, { id: profile.id, label: profile.label } satisfies TrialIdentityProfileReply);
        }
        if (!('emailAddress' in profile) || !safeField(profile.emailAddress, 320) || !safeField(profile.historyId, 256) ||
            !Number.isSafeInteger(profile.messagesTotal) || profile.messagesTotal < 0 || !Number.isSafeInteger(profile.threadsTotal) || profile.threadsTotal < 0) return json(502, ERROR);
        return json(200, { emailAddress: profile.emailAddress, messagesTotal: profile.messagesTotal, threadsTotal: profile.threadsTotal, historyId: profile.historyId } satisfies TrialGmailProfileReply);
      } catch {
        return json(502, ERROR);
      }
    });
  };
  handle.ready = ready;
  return handle;
}
