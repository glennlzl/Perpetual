import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, privateFileExists, readStateFile, writeStateFile } from '../store.ts';
import { createLocalAuth, localOrigin } from './auth-runtime.ts';
import { APPS, ConnectorAuthError, object, providerAuthorizationUrl, providerOf } from './providers.ts';
import { createConnectorObservations } from './observations.ts';
import { createLocalBrokerTrial } from './broker-trial.ts';
import type { ConnectorProvider, ConnectorsReply } from '../../contract/connectors.ts';

const INVALID = 'Cannot load local connector authorization. Restore auth.json and auth.sqlite together.';
const TTL = 10 * 60_000;
interface Attempt { state: string; url: string; cookie: string; origin: string; createdAt: number; exchanging?: true }
interface Binding { id?: string; accountId?: string; label?: string; pending?: Attempt; needsAuth?: true; error?: string }
interface State { schema: 2; secret: string; ownerId: string; accounts: Partial<Record<ConnectorProvider, Binding>> }
export type ConnectorManagerOptions = { dataDir: string; origin: () => string; env?: NodeJS.ProcessEnv; transport?: typeof fetch };
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function load(raw: unknown): State {
  const state = object(raw), accounts = object(state.accounts);
  if (state.schema !== 2 || !text(state.secret, 128) || !/^[a-f0-9]{64}$/.test(state.secret) || !text(state.ownerId) || !/^[a-f0-9-]{36}$/.test(state.ownerId) || accounts !== state.accounts || Object.keys(accounts).some(key => !APPS.some(app => app.provider === key))) throw new Error(INVALID);
  const result: State = { schema: 2, secret: state.secret, ownerId: state.ownerId, accounts: {} };
  for (const app of APPS) {
    if (accounts[app.provider] === undefined) continue;
    const item = object(accounts[app.provider]);
    if (['id', 'accountId', 'label', 'error'].some(key => item[key] !== undefined && !text(item[key])) || item.needsAuth !== undefined && item.needsAuth !== true || Boolean(item.id) !== Boolean(item.accountId)) throw new Error(INVALID);
    const binding: Binding = { ...(item.id ? { id: item.id as string, accountId: item.accountId as string } : {}), ...(item.label ? { label: item.label as string } : {}), ...(item.needsAuth ? { needsAuth: true } : {}), ...(item.error ? { error: item.error as string } : {}) };
    if (item.pending !== undefined) {
      const p = object(item.pending);
      if (!text(p.state, 256) || !text(p.cookie, 16384) || !text(p.origin) || !providerAuthorizationUrl(app.provider, p.url) || typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt) || p.exchanging !== undefined && p.exchanging !== true) throw new Error(INVALID);
      const target = new URL(p.url as string);
      if (localOrigin(p.origin) !== p.origin || target.searchParams.get('state') !== p.state) throw new Error(INVALID);
      binding.pending = { state: p.state, cookie: p.cookie, url: p.url as string, origin: p.origin, createdAt: p.createdAt, ...(p.exchanging ? { exchanging: true } : {}) };
    }
    result.accounts[app.provider] = binding;
  }
  return result;
}

/** Local records render immediately. Better Auth owns provider grants; observations never grant access. */
export async function createConnectorManager({ dataDir, origin, env = process.env, transport }: ConnectorManagerOptions) {
  const directory = await privateDirectory(join(dataDir, 'connectors'), INVALID), file = join(directory, 'auth.json');
  const saved = await readStateFile(file, { limit: 128 * 1024, invalid: INVALID });
  if (saved === undefined && await privateFileExists(join(directory, 'auth.sqlite'), INVALID)) throw new Error(INVALID);
  let state: State = saved === undefined ? { schema: 2, secret: randomBytes(32).toString('hex'), ownerId: randomUUID(), accounts: {} } : load(saved);
  await writeStateFile(file, JSON.stringify(state));
  const brokers = {
    linear: await createLocalBrokerTrial({ dataDir, env, transport, provider: 'linear' }),
    gmail: await createLocalBrokerTrial({ dataDir, env, transport, provider: 'gmail' }),
    slack: await createLocalBrokerTrial({ dataDir, env, transport, provider: 'slack' }),
    jira: await createLocalBrokerTrial({ dataDir, env, transport, provider: 'jira' }),
  };
  const brokerFor = (provider: ConnectorProvider) => brokers[provider];
  for (const provider of Object.keys(brokers) as ConnectorProvider[]) {
    if (brokers[provider] && (state.accounts[provider]?.id || state.accounts[provider]?.pending)) throw new Error(`Disconnect the existing ${APPS.find(app => app.provider === provider)!.name} account before enabling the connection trial.`);
  }
  const runtime = await createLocalAuth({ file: join(directory, 'auth.sqlite'), secret: state.secret, ownerId: state.ownerId, origin, env, transport });
  const queue = createSaveQueue(), observations = createConnectorObservations();
  const checked = new Map<ConnectorProvider, number>();
  let closed = false, revision = 0;
  const reads = new Map<string, Promise<ConnectorsReply>>();
  async function save(next: State) { await writeStateFile(file, JSON.stringify(next)); state = next; }
  const enqueue = <T>(work: () => Promise<T>) => queue.run(async () => { if (closed) throw new Error('The controller is stopping.'); return work(); });
  const mutate = <T>(work: () => Promise<T>) => { revision++; return enqueue(work); };
  const usableAttempt = (p: Attempt) => !p.exchanging && p.createdAt <= Date.now() + 60_000 && Date.now() - p.createdAt < TTL && p.origin === localOrigin(origin());
  function snapshot(): ConnectorsReply {
    return { apps: APPS.map(app => {
      const broker = brokerFor(app.provider);
      if (broker) return broker.snapshot();
      const binding = state.accounts[app.provider];
      const account = !binding ? null : binding.pending && usableAttempt(binding.pending) ? { status: 'pending' as const, redirectUrl: binding.pending.url } : binding.needsAuth || !binding.id || binding.pending ? { status: 'needs-auth' as const, error: binding.error ?? 'Sign in again to reconnect.' } : { ...observations.snapshot(app.provider, binding.id), ...(binding.label ? { label: binding.label } : {}) };
      return { ...app, ...runtime.providers.configuration(app.provider), account };
    }) };
  }
  async function refresh(provider: ConnectorProvider, force: boolean) {
    const broker = brokerFor(provider);
    if (broker) { await broker.read(force); return; }
    const binding = state.accounts[provider];
    if (!binding?.id || binding.pending || binding.needsAuth || !force && (checked.get(provider) ?? 0) > Date.now()) return;
    const config = runtime.providers.configuration(provider);
    if (!config.configured) { observations.remember(provider, binding.id, { status: 'unverified', error: config.setupError }); return; }
    try {
      const stored = await runtime.account(binding.id);
      if (!stored || stored.providerId !== provider || stored.accountId !== binding.accountId) throw new ConnectorAuthError('Sign in again to reconnect.', true);
      const accessToken = await runtime.token(binding.id);
      const account = await runtime.providers.verifyAccount(provider, accessToken);
      if (account.id !== binding.accountId) throw new ConnectorAuthError('The service returned a different account. Sign in again.', true);
      observations.remember(provider, binding.id, { status: 'connected', label: account.label });
      checked.set(provider, Date.now() + 30_000);
    } catch (error) {
      const failure = error instanceof ConnectorAuthError ? error : runtime.providers.refreshFailure(provider);
      const needsAuth = failure?.needsAuth === true;
      observations.remember(provider, binding.id, { status: needsAuth ? 'needs-auth' : 'unverified', error: failure?.message ?? 'Could not verify this account. Try again.' });
      checked.set(provider, Date.now() + 5_000);
    }
  }
  return {
    snapshot,
    read(force?: unknown) {
      const selected = force === 'all' ? 'all' : force === undefined || force === null ? undefined : providerOf(force);
      const key = `${revision}:${selected ?? ''}`;
      if (!reads.has(key)) {
        const task = enqueue(async () => { await Promise.all(APPS.map(app => refresh(app.provider, selected === 'all' || selected === app.provider))); return snapshot(); });
        reads.set(key, task); void task.finally(() => { if (reads.get(key) === task) reads.delete(key); }).catch(() => {});
      }
      return reads.get(key)!.then(value => structuredClone(value));
    },
    start: (input: unknown) => mutate(async () => {
      const provider = providerOf(object(input).provider);
      const broker = brokerFor(provider);
      if (broker) { await broker.start(); return snapshot(); }
      const config = runtime.providers.configuration(provider);
      if (!config.configured) throw new Error(config.setupError);
      const binding = state.accounts[provider];
      if (binding?.pending && usableAttempt(binding.pending)) return snapshot();
      if (binding?.id && observations.snapshot(provider, binding.id).status === 'connected') throw new Error('This app is already connected. Disconnect it before changing accounts.');
      if (binding?.pending) await runtime.cancel(binding.pending.state);
      // Reconnection is an explicit replacement. Clear unusable grants before starting another attempt.
      await runtime.remove(provider);
      await save({ ...state, accounts: { ...state.accounts, [provider]: { needsAuth: true } } });
      const prepared = await runtime.prepare(provider);
      await save({ ...state, accounts: { ...state.accounts, [provider]: { pending: { ...prepared, createdAt: Date.now() } } } });
      observations.remove(provider); checked.delete(provider);
      return snapshot();
    }),
    complete: (selected: unknown, params: URLSearchParams) => mutate(async () => {
      const provider = providerOf(selected), binding = state.accounts[provider], attempt = binding?.pending, nonce = params.get('state');
      if (provider === 'gmail' || brokerFor(provider)) throw new Error('Complete sign-in through the connection service.');
      if (['state', 'code', 'error', 'error_description', 'iss'].some(name => params.getAll(name).length > 1) || !attempt || !usableAttempt(attempt) || !nonce || nonce.length !== attempt.state.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(attempt.state))) throw new Error('Sign-in expired or does not match this request.');
      if (!params.has('error') && !text(params.get('code'), 4096)) throw new Error('The service did not return a valid sign-in code.');
      await save({ ...state, accounts: { ...state.accounts, [provider]: { pending: { ...attempt, exchanging: true } } } });
      try {
        const account = await runtime.complete(provider, params, attempt.cookie);
        await save({ ...state, accounts: { ...state.accounts, [provider]: account } });
        await refresh(provider, true);
      } catch {
        await save({ ...state, accounts: { ...state.accounts, [provider]: { needsAuth: true, error: params.has('error') ? 'Sign-in was cancelled. Connect again when ready.' : 'Sign-in could not finish. Connect again.' } } });
        throw new Error('Sign-in could not finish. Return to Perpetual and connect again.');
      }
    }),
    remove: (input: unknown) => mutate(async () => {
      const data = object(input), provider = providerOf(data.provider), binding = state.accounts[provider];
      const broker = brokerFor(provider);
      if (broker) { await broker.remove(data.cancel === true); return snapshot(); }
      if (!binding) return snapshot();
      if (data.cancel === true && !binding.pending && binding.id) throw new Error('Sign-in completed. Use Disconnect to remove this account.');
      if (binding.pending) await runtime.cancel(binding.pending.state);
      await runtime.remove(provider);
      const accounts = { ...state.accounts }; delete accounts[provider];
      await save({ ...state, accounts }); observations.remove(provider); checked.delete(provider);
      return snapshot();
    }),
    async close() { if (closed) return; closed = true; await queue.idle(); await Promise.all(Object.values(brokers).map(broker => broker?.close())); runtime.close(); },
  };
}
