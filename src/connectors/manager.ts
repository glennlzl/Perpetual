import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { redact } from '../redaction.ts';
import { authUrl, ComposioError, createComposio, identifier, object } from './composio.ts';
import type { ConnectorAccount, ConnectorOptionsReply, ConnectorProvider, ConnectorsReply } from '../../contract/connectors.ts';

const APPS = [{ provider: 'slack', name: 'Slack' }, { provider: 'linear', name: 'Linear' }, { provider: 'gmail', name: 'Gmail' }, { provider: 'jira', name: 'Jira' }] as const;
const INVALID = 'Cannot load saved connectors. Keep connectors.json and restore a valid snapshot.';
const PENDING = new Set(['INITIATED', 'INITIALIZING']);
interface Record { configId: string; alias: string; id?: string; redirectUrl?: string; expiresAt?: string }
interface State { schema: 1; userId: string; apiKey?: string; accounts: Partial<{ [K in ConnectorProvider]: Record }> }
export type ConnectorManagerOptions = { dataDir: string; transport?: typeof fetch };
function providerOf(value: unknown): ConnectorProvider {
  if (!APPS.some(app => app.provider === value)) throw new Error('Choose an available app.');
  return value as ConnectorProvider;
}
function keyOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('Enter a valid Composio API key.');
  return value;
}
function load(value: unknown): State {
  const state = object(value), accounts = object(state.accounts);
  if (state.schema !== 1 || typeof state.userId !== 'string' || !/^perpetual-[a-f0-9-]{36}$/.test(state.userId) || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts) || Object.keys(accounts).some(key => !APPS.some(app => app.provider === key))) throw new Error(INVALID);
  if (state.apiKey !== undefined) keyOf(state.apiKey);
  const result: State = { schema: 1, userId: state.userId, ...(state.apiKey ? { apiKey: state.apiKey as string } : {}), accounts: {} };
  for (const app of APPS) {
    const raw = accounts[app.provider]; if (raw === undefined) continue;
    const record = object(raw);
    if (!identifier(record.configId) || !identifier(record.alias) || (record.id !== undefined && !identifier(record.id)) || (record.redirectUrl !== undefined && !authUrl(record.redirectUrl)) || (record.expiresAt !== undefined && (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))))) throw new Error(INVALID);
    result.accounts[app.provider] = { configId: record.configId, alias: record.alias, ...(record.id ? { id: record.id as string } : {}), ...(record.redirectUrl ? { redirectUrl: record.redirectUrl as string } : {}), ...(record.expiresAt ? { expiresAt: record.expiresAt as string } : {}) };
  }
  if (Object.keys(result.accounts).length && !result.apiKey) throw new Error(INVALID);
  return result;
}

/** A local installation owns only accounts it explicitly initiated. Opening the page only reads them. */
export async function createConnectorManager({ dataDir, transport }: ConnectorManagerOptions) {
  const directory = await privateDirectory(join(dataDir, 'connectors'), INVALID), file = join(directory, 'connectors.json');
  const saved = await readStateFile(file, { limit: 32768, invalid: INVALID });
  let state: State = saved === undefined ? { schema: 1, userId: `perpetual-${randomUUID()}`, accounts: {} } : load(saved);
  const queue = createSaveQueue(), vendor = createComposio({ transport });
  const observations = new Map<ConnectorProvider, ConnectorAccount>();
  let closed = false;
  const serialize = <T>(work: () => Promise<T>) => queue.run(async () => { if (closed) throw new Error('The controller is stopping.'); return work(); });
  async function save(next: State) { await writeStateFile(file, JSON.stringify(next)); state = next; }
  function key() { if (!state.apiKey) throw new Error('Set up Composio to connect this app.'); return state.apiKey; }
  function view(): ConnectorsReply {
    return { configured: Boolean(state.apiKey), apps: APPS.map(app => ({ ...app, account: state.accounts[app.provider] ? observations.get(app.provider) ?? { status: 'unverified' } : null })) };
  }
  function owned(raw: unknown, provider: ConnectorProvider, record: Record) {
    const account = object(raw);
    if (!identifier(account.id) || (record.id && account.id !== record.id) || account.user_id !== state.userId || object(account.toolkit).slug !== provider || object(account.auth_config).id !== record.configId || object(account.auth_config).auth_scheme !== 'OAUTH2') throw new Error('The account does not match this connection. Check the Composio project.');
    return account;
  }
  async function inspect(provider: ConnectorProvider, record: Record, apiKey = key()) {
    if (!record.id) {
      const matches = (await vendor.accounts(apiKey, state.userId, provider)).filter(raw => object(raw).alias === record.alias);
      if (!matches.length) throw new ComposioError(404, 'No account was created for this sign-in.');
      if (matches.length !== 1) throw new Error('Sign-in could not be confirmed. Refresh before trying again.');
      const found = owned(matches[0], provider, record);
      record = { ...record, id: found.id as string };
      await save({ ...state, accounts: { ...state.accounts, [provider]: record } });
    }
    const account = owned(await vendor.details(apiKey, record.id!), provider, record);
    if (account.status === 'ACTIVE' && account.is_disabled !== true && object(account.auth_config).is_disabled !== true) return { status: 'connected' as const };
    if (typeof account.status === 'string' && PENDING.has(account.status)) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return { status: 'needs-auth' as const };
      return { status: 'pending' as const, ...(record.redirectUrl ? { redirectUrl: record.redirectUrl } : {}) };
    }
    if (['EXPIRED', 'FAILED', 'REVOKED', 'INACTIVE', 'DISABLED'].includes(String(account.status)) || account.is_disabled === true || object(account.auth_config).is_disabled === true) return { status: 'needs-auth' as const };
    throw new Error('Composio returned an unknown account status. Refresh and try again.');
  }
  async function refresh(provider: ConnectorProvider) {
    const record = state.accounts[provider]; if (!record) return;
    try { observations.set(provider, await inspect(provider, record)); }
    catch (error) { observations.set(provider, { status: 'unverified', error: error instanceof ComposioError && error.status === 404 ? 'The connection was removed from Composio. Disconnect it here, then sign in again.' : redact(error instanceof Error ? error.message : 'Could not verify the connection.', { secrets: [state.apiKey] }) }); }
  }
  return {
    read: () => serialize(async () => { for (const app of APPS) await refresh(app.provider); return view(); }),
    setup: (input: unknown) => serialize(async () => {
      const apiKey = keyOf(object(input).apiKey);
      // Validate access without creating configs, accounts, or invoking provider tools.
      await vendor.configs(apiKey, 'slack');
      for (const app of APPS) { const record = state.accounts[app.provider]; if (record) await inspect(app.provider, record, apiKey); }
      await save({ ...state, apiKey }); return view();
    }),
    options: (input: unknown): Promise<ConnectorOptionsReply> => serialize(async () => ({ configs: await vendor.configs(key(), providerOf(object(input).provider)) })),
    start: (input: unknown) => serialize(async () => {
      const data = object(input), provider = providerOf(data.provider), apiKey = key();
      if (state.accounts[provider]) throw new Error('This app already has a connection. Continue sign-in or disconnect it first.');
      const configs = await vendor.configs(apiKey, provider);
      if (!identifier(data.configId) || !configs.some(config => config.id === data.configId)) throw new Error('Choose an enabled OAuth configuration for this app.');
      const record: Record = { configId: data.configId, alias: `perpetual-${randomUUID()}` };
      // Persist intent before the remote write, so an uncertain response can be recovered without another account.
      await save({ ...state, accounts: { ...state.accounts, [provider]: record } });
      try {
        const reply = object(await vendor.link(apiKey, record.configId, state.userId, record.alias));
        if (!identifier(reply.connected_account_id)) throw new Error('Sign-in could not be confirmed. Refresh before trying again.');
        const next = { ...record, id: reply.connected_account_id };
        await save({ ...state, accounts: { ...state.accounts, [provider]: next } });
        const redirectUrl = authUrl(reply.redirect_url), expiresAt = typeof reply.expires_at === 'string' && Number.isFinite(Date.parse(reply.expires_at)) ? reply.expires_at : undefined;
        if (!redirectUrl || !expiresAt) throw new Error('Composio returned an invalid sign-in link. Disconnect and try again.');
        await save({ ...state, accounts: { ...state.accounts, [provider]: { ...next, redirectUrl, expiresAt } } });
        await refresh(provider); return view();
      } catch (error) {
        // Definitive rejection created no account; transport/unknown replies retain the intent for recovery.
        if (error instanceof ComposioError && [400, 401, 403, 404, 422, 429, 501].includes(error.status)) { const accounts = { ...state.accounts }; delete accounts[provider]; await save({ ...state, accounts }); }
        throw error;
      }
    }),
    remove: (input: unknown) => serialize(async () => {
      const data = object(input), provider = providerOf(data.provider), record = state.accounts[provider];
      if (!record) return view();
      // Cancellation cannot silently delete an account whose sign-in just finished.
      try {
        const observed = await inspect(provider, record);
        observations.set(provider, observed);
        if (data.cancel === true && observed.status === 'connected') throw new Error('Sign-in completed. Use Disconnect to remove this account.');
        await vendor.remove(key(), state.accounts[provider]!.id!);
      } catch (error) {
        if (!(error instanceof ComposioError && error.status === 404)) throw error;
      }
      const accounts = { ...state.accounts }; delete accounts[provider];
      await save({ ...state, accounts }); observations.delete(provider); return view();
    }),
    async close() { closed = true; await queue.idle(); },
  };
}
