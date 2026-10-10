import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { privateDirectory, privateFileExists, readStateFile, writeStateFile } from '../store.ts';
import type { ConnectorAccount, ConnectorApp } from '../../contract/connectors.ts';
import type { TrialGmailProfileReply, TrialIdentityProfileReply, TrialLinkReply, TrialProfileReply, TrialStatusReply } from '../../contract/broker-trial.ts';

const BROKER_ORIGIN = 'http://127.0.0.1:43179';
const TTL = 10 * 60_000;
const CACHE_MS = 30_000;
const CLOCK_SKEW_MS = 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
const APPS = { linear: { provider: 'linear', name: 'Linear' }, gmail: { provider: 'gmail', name: 'Gmail' }, slack: { provider: 'slack', name: 'Slack' }, jira: { provider: 'jira', name: 'Jira' } } as const;

type BrokerStatus = TrialStatusReply['status'];
type BrokerReply = TrialLinkReply | TrialStatusReply | TrialProfileReply | TrialGmailProfileReply | TrialIdentityProfileReply;
type Pairing = { brokerUrl: string; token: string };
interface Metadata { schema: 1; pending?: { redirectUrl: string; createdAt: number }; label?: string; needsAuth?: true }
type BrokerTransport = typeof fetch;
type BrokerFailureKind = 'unavailable' | 'pairing';
class BrokerFailure extends Error {
  readonly kind: BrokerFailureKind;
  constructor(kind: BrokerFailureKind, message: string) { super(message); this.kind = kind; }
}
export interface LocalBrokerTrialOptions { dataDir: string; provider?: keyof typeof APPS; env?: NodeJS.ProcessEnv; transport?: BrokerTransport }

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validatePairing(raw: unknown, pairingError: string): Pairing {
  const value = record(raw);
  if (!value || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'brokerUrl') || !Object.hasOwn(value, 'token') ||
      value.brokerUrl !== `${BROKER_ORIGIN}/` && value.brokerUrl !== BROKER_ORIGIN || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)) throw new Error(pairingError);
  const bytes = Buffer.from(value.token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value.token) throw new Error(pairingError);
  return { brokerUrl: BROKER_ORIGIN, token: value.token };
}
function redirectUrl(value: unknown): string | undefined {
  if (!safeText(value, 4096)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && ['connect.composio.dev', 'backend.composio.dev'].includes(url.hostname.toLowerCase())) return url.href;
  } catch { /* Invalid remote links are never shown to the page. */ }
}
function validStatus(value: unknown): value is BrokerStatus {
  return ['not-connected', 'pending', 'connected', 'unverified', 'needs-auth'].includes(String(value));
}
function loadMetadata(raw: unknown, privateError: string): Metadata {
  const value = record(raw);
  if (!value || value.schema !== 1 || Object.keys(value).some(key => !['schema', 'pending', 'label', 'needsAuth'].includes(key)) ||
      value.label !== undefined && !safeText(value.label, 320) || value.needsAuth !== undefined && value.needsAuth !== true) throw new Error(privateError);
  let pending: Metadata['pending'];
  if (value.pending !== undefined) {
    const p = record(value.pending);
    const safeUrl = p && redirectUrl(p.redirectUrl);
    if (!p || Object.keys(p).length !== 2 || !safeUrl || typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt) || p.createdAt < 0 || p.createdAt > Date.now() + CLOCK_SKEW_MS) throw new Error(privateError);
    pending = { redirectUrl: safeUrl, createdAt: p.createdAt };
  }
  if (pending && (value.label !== undefined || value.needsAuth === true) || value.label !== undefined && value.needsAuth === true) throw new Error(privateError);
  return { schema: 1, ...(pending ? { pending } : {}), ...(value.label ? { label: value.label as string } : {}), ...(value.needsAuth ? { needsAuth: true } : {}) };
}
function pendingIsCurrent(pending: Metadata['pending'], now: number): pending is NonNullable<Metadata['pending']> {
  return Boolean(pending && pending.createdAt <= now + CLOCK_SKEW_MS && now - pending.createdAt < TTL);
}

async function readBounded(response: Response, retryError: string): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw new Error(retryError);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel(); throw new Error(retryError);
  }
  if (!response.body) throw new Error(retryError);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(retryError); }
      chunks.push(value);
    }
  } catch { throw new Error(retryError); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(retryError); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error(retryError); }
}

/**
 * Optional adapter for the isolated localhost broker experiment. The pairing credential stays in
 * the controller process and the private file; no Better Auth or direct provider state is changed.
 */
export async function createLocalBrokerTrial({ dataDir, provider = 'linear', env = process.env, transport = fetch }: LocalBrokerTrialOptions) {
  const app = APPS[provider];
  const pairingEnv = `PERPETUAL_${provider.toUpperCase()}_BROKER_PAIRING`;
  const privateError = `Cannot load the private ${app.name} broker trial state.`;
  const pairingError = `The ${app.name} broker pairing is invalid. Re-pair this installation.`;
  const retryError = `Could not check the ${app.name} connection. Try again.`;
  const unavailableError = 'Connection service is unavailable. Try again.';
  const verifyError = `Could not verify the ${app.name} account. Try again.`;
  const pairingPath = env[pairingEnv];
  if (!pairingPath) return undefined;
  if (!isAbsolute(pairingPath)) throw new Error(pairingError);
  let pairing: Pairing;
  try {
    const raw = await readStateFile(pairingPath, { limit: 2048, invalid: pairingError });
    const info = await lstat(pairingPath);
    if ((info.mode & 0o077) !== 0) throw new Error(pairingError);
    pairing = validatePairing(raw, pairingError);
  } catch { throw new Error(pairingError); }

  const directory = await privateDirectory(join(dataDir, 'connectors'), privateError);
  const metadataPath = join(directory, provider === 'linear' ? 'broker-trial.json' : `${provider}-broker.json`);
  let metadata: Metadata;
  try {
    if (await privateFileExists(metadataPath, privateError) && (await lstat(metadataPath)).mode & 0o077) throw new Error(privateError);
    const raw = await readStateFile(metadataPath, { limit: 8192, invalid: privateError });
    metadata = raw === undefined ? { schema: 1 } : loadMetadata(raw, privateError);
  } catch { throw new Error(privateError); }
  const save = async (next: Metadata) => { await writeStateFile(metadataPath, JSON.stringify(next)); metadata = next; };

  let closed = false, cachedAt = 0, observed: ConnectorAccount | null = null, inflight: Promise<ConnectorApp> | undefined;
  const timestamp = () => Date.now();
  function snapshot(): ConnectorApp {
    let account: ConnectorAccount | null = observed ? structuredClone(observed) : null;
    if (account && timestamp() - cachedAt >= CACHE_MS) account = { ...account, checking: true };
    if (!account && metadata.pending) {
      account = pendingIsCurrent(metadata.pending, timestamp())
        ? { status: 'pending', redirectUrl: metadata.pending.redirectUrl }
        : { status: 'needs-auth', error: `${app.name} sign-in expired. Start a new sign-in or clear the broker trial connection.` };
    }
    if (!account && metadata.needsAuth) account = { status: 'needs-auth', error: `${app.name} authorization needs attention. Reconnect the broker trial.` };
    if (!account && metadata.label) account = { status: 'unverified', checking: true };
    return { ...app, configured: true, account };
  }

  async function call<T extends BrokerReply>(action: 'connect' | 'status' | 'profile' | 'disconnect'): Promise<T> {
    if (closed) throw new Error('The controller is stopping.');
    let response: Response;
    try {
      const route = provider === 'linear' ? `/trial/${action}` : `/trial/${provider}/${action}`;
      response = await transport(new URL(route, pairing.brokerUrl), {
        method: action === 'status' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${pairing.token}`, ...(action === 'status' ? {} : { 'Content-Type': 'application/json' }) },
        ...(action === 'status' ? {} : { body: '{}' }), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch { throw new BrokerFailure('unavailable', unavailableError); }
    if (response.redirected || response.url && new URL(response.url).origin !== BROKER_ORIGIN) { await response.body?.cancel().catch(() => {}); throw new Error(retryError); }
    if (response.status === 401) { await response.body?.cancel().catch(() => {}); throw new BrokerFailure('pairing', pairingError); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(retryError); }
    const value = record(await readBounded(response, retryError));
    if (!value) throw new Error(retryError);
    return value as T;
  }

  async function remoteStatus(): Promise<BrokerStatus> {
    const result = await call<TrialStatusReply>('status');
    if (!validStatus(result.status)) throw new Error(retryError);
    return result.status;
  }

  async function refresh(): Promise<ConnectorApp> {
    let failureMessage = retryError;
    try {
      const status = await remoteStatus();
      if (status === 'not-connected') {
        await save({ schema: 1 }); observed = null; cachedAt = timestamp();
        return snapshot();
      }
      if (status === 'pending') {
        const pending = pendingIsCurrent(metadata.pending, timestamp()) ? metadata.pending : undefined;
        if (metadata.pending && !pending) {
          await save({ schema: 1, needsAuth: true });
          observed = { status: 'needs-auth', error: `${app.name} sign-in expired. Start a new sign-in or clear the broker trial connection.` };
          cachedAt = timestamp();
          return snapshot();
        }
        observed = { status: 'pending', ...(pending ? { redirectUrl: pending.redirectUrl } : {}) };
        cachedAt = timestamp();
        return snapshot();
      }
      if (status === 'needs-auth') {
        await save({ schema: 1, needsAuth: true });
        observed = { status: 'needs-auth', error: `${app.name} authorization needs attention. Reconnect the broker trial.` };
        cachedAt = timestamp();
        return snapshot();
      }
      if (status !== 'connected') {
        observed = { status: 'unverified', ...(metadata.label ? { label: metadata.label } : {}), error: verifyError };
        cachedAt = timestamp();
        return snapshot();
      }
      failureMessage = verifyError;
      const profile = provider === 'gmail' ? await call<TrialGmailProfileReply>('profile') : provider === 'linear' ? await call<TrialProfileReply>('profile') : await call<TrialIdentityProfileReply>('profile');
      let label: string;
      if (provider === 'gmail') {
        const gmailProfile = profile as TrialGmailProfileReply;
        const keys = Object.keys(gmailProfile).sort();
        if (keys.join(',') !== 'emailAddress,historyId,messagesTotal,threadsTotal' || !safeText(gmailProfile.emailAddress, 320) || !safeText(gmailProfile.historyId, 256) || !Number.isSafeInteger(gmailProfile.messagesTotal) || gmailProfile.messagesTotal < 0 || !Number.isSafeInteger(gmailProfile.threadsTotal) || gmailProfile.threadsTotal < 0) throw new Error(retryError);
        label = gmailProfile.emailAddress;
      } else if (provider === 'linear') {
        const linearProfile = profile as TrialProfileReply;
        if (!safeText(linearProfile.id, 256) || !safeText(linearProfile.name, 256) || !safeText(linearProfile.email, 320)) throw new Error(retryError);
        label = linearProfile.email;
      } else {
        const identityProfile = profile as TrialIdentityProfileReply;
        const keys = Object.keys(identityProfile).sort();
        if (keys.join(',') !== 'id,label' || !safeText(identityProfile.id, 256) || !safeText(identityProfile.label, 320)) throw new Error(retryError);
        label = identityProfile.label;
      }
      await save({ schema: 1, label });
      observed = { status: 'connected', label };
      cachedAt = timestamp();
      return snapshot();
    } catch (error) {
      const errorMessage = error instanceof BrokerFailure
        ? error.kind === 'unavailable' ? unavailableError : pairingError
        : failureMessage;
      observed = { status: 'unverified', ...(metadata.label ? { label: metadata.label } : {}), error: errorMessage };
      cachedAt = timestamp();
      return snapshot();
    }
  }

  function read(force = false): Promise<ConnectorApp> {
    if (closed) return Promise.reject(new Error('The controller is stopping.'));
    if (!force && observed && timestamp() - cachedAt < CACHE_MS) return Promise.resolve(snapshot());
    if (inflight) return inflight;
    const task = refresh(); inflight = task;
    void task.finally(() => { if (inflight === task) inflight = undefined; }).catch(() => {});
    return task.then(value => structuredClone(value));
  }

  return {
    snapshot,
    read,
    async start(): Promise<ConnectorApp> {
      if (closed) throw new Error('The controller is stopping.');
      const current = (await read(true)).account;
      if (current?.status === 'connected') throw new Error(`${app.name} is already connected. Disconnect it before changing accounts.`);
      if (current?.status === 'unverified') throw new Error(`Could not verify the ${app.name} broker connection. Refresh before starting sign-in.`);
      if (current?.status === 'pending') {
        if (pendingIsCurrent(metadata.pending, timestamp())) return snapshot();
        throw new Error(`${app.name} sign-in is pending but its link is unavailable. Cancel the broker trial and start again.`);
      }
      const result = await call<TrialLinkReply>('connect');
      const url = redirectUrl(result.redirectUrl);
      if (!url) throw new Error(retryError);
      await save({ schema: 1, pending: { redirectUrl: url, createdAt: timestamp() } });
      observed = { status: 'pending', redirectUrl: url };
      cachedAt = timestamp();
      return snapshot();
    },
    async remove(cancel: boolean): Promise<ConnectorApp> {
      if (closed) throw new Error('The controller is stopping.');
      if (cancel) {
        const status = await remoteStatus();
        if (status === 'connected' || status === 'unverified') throw new Error(`${app.name} sign-in completed or could not be verified. Use Disconnect to remove the account.`);
      }
      const result = await call<TrialStatusReply>('disconnect');
      if (result.status !== 'not-connected') throw new Error(retryError);
      await save({ schema: 1 });
      observed = null; cachedAt = timestamp();
      return snapshot();
    },
    async close() { closed = true; await inflight?.catch(() => {}); },
  };
}
