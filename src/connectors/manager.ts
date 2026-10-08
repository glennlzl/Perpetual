import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { redact } from '../redaction.ts';
import { authUrl, ComposioError, createComposio, identifier, object } from './composio.ts';
import { createConsumerConnections } from './consumer.ts';
import type { ConnectorAccount, ConnectorOptionsReply, ConnectorProvider, ConnectorsReply } from '../../contract/connectors.ts';

const APPS = [{ provider: 'slack', name: 'Slack' }, { provider: 'linear', name: 'Linear' }, { provider: 'gmail', name: 'Gmail' }, { provider: 'jira', name: 'Jira' }] as const;
const INVALID = 'Cannot load saved connectors. Keep connectors.json and restore a valid snapshot.';
const PENDING = new Set(['INITIATED', 'INITIALIZING']);
interface Record { configId: string; alias: string; id?: string; redirectUrl?: string; expiresAt?: string }
interface ConfigSetup { name: string; id?: string }
interface State { schema: 1; userId: string; apiKey?: string; method?: 'browser' | 'project'; accounts: Partial<{ [K in ConnectorProvider]: Record }>; configSetups: Partial<{ [K in ConnectorProvider]: ConfigSetup }> }
export type ConnectorManagerOptions = { dataDir: string; transport?: typeof fetch; callbackUrl?: () => string; consumerTransport?: typeof fetch };
function providerOf(value: unknown): ConnectorProvider {
  if (!APPS.some(app => app.provider === value)) throw new Error('Choose an available app.');
  return value as ConnectorProvider;
}
function keyOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('Enter a valid Composio project API key.');
  return value;
}
function load(value: unknown): State {
  const state = object(value), accounts = object(state.accounts), configSetups = object(state.configSetups);
  if (state.schema !== 1 || typeof state.userId !== 'string' || !/^perpetual-[a-f0-9-]{36}$/.test(state.userId) || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts) || Object.keys(accounts).some(key => !APPS.some(app => app.provider === key))) throw new Error(INVALID);
  if (state.apiKey !== undefined) keyOf(state.apiKey);
  if (state.method !== undefined && state.method !== 'browser' && state.method !== 'project') throw new Error(INVALID);
  if (state.configSetups !== undefined && (!state.configSetups || typeof state.configSetups !== 'object' || Array.isArray(state.configSetups) || Object.keys(configSetups).some(key => !APPS.some(app => app.provider === key)))) throw new Error(INVALID);
  const result: State = { schema: 1, userId: state.userId, ...(state.apiKey ? { apiKey: state.apiKey as string } : {}), ...(state.method ? { method: state.method as 'browser' | 'project' } : {}), accounts: {}, configSetups: {} };
  for (const app of APPS) {
    const setup = configSetups[app.provider];
    if (setup !== undefined) {
      const config = object(setup);
      if (!identifier(config.name) || (config.id !== undefined && !identifier(config.id))) throw new Error(INVALID);
      result.configSetups[app.provider] = { name: config.name, ...(config.id ? { id: config.id as string } : {}) };
    }
    const raw = accounts[app.provider]; if (raw === undefined) continue;
    const record = object(raw);
    if (!identifier(record.configId) || !identifier(record.alias) || (record.id !== undefined && !identifier(record.id)) || (record.redirectUrl !== undefined && !authUrl(record.redirectUrl)) || (record.expiresAt !== undefined && (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))))) throw new Error(INVALID);
    result.accounts[app.provider] = { configId: record.configId, alias: record.alias, ...(record.id ? { id: record.id as string } : {}), ...(record.redirectUrl ? { redirectUrl: record.redirectUrl as string } : {}), ...(record.expiresAt ? { expiresAt: record.expiresAt as string } : {}) };
  }
  if ((Object.keys(result.accounts).length || Object.keys(result.configSetups).length) && !result.apiKey) throw new Error(INVALID);
  return result;
}

/** A local installation owns only accounts it explicitly initiated. Opening the page only reads them. */
export async function createConnectorManager({ dataDir, transport, callbackUrl, consumerTransport }: ConnectorManagerOptions) {
  const directory = await privateDirectory(join(dataDir, 'connectors'), INVALID), file = join(directory, 'connectors.json');
  const saved = await readStateFile(file, { limit: 32768, invalid: INVALID });
  let state: State = saved === undefined ? { schema: 1, userId: `perpetual-${randomUUID()}`, accounts: {}, configSetups: {} } : load(saved);
  const queue = createSaveQueue(), vendor = createComposio({ transport });
  const consumer = callbackUrl ? await createConsumerConnections({ dataDir, callbackUrl, transport: consumerTransport }) : undefined;
  const observations = new Map<ConnectorProvider, ConnectorAccount>();
  let closed = false;
  const serialize = <T>(work: () => Promise<T>) => queue.run(async () => { if (closed) throw new Error('The controller is stopping.'); return work(); });
  async function save(next: State) { await writeStateFile(file, JSON.stringify(next)); state = next; }
  function key() { if (!state.apiKey) throw new Error('Set up Composio to connect this app.'); return state.apiKey; }
  const method = () => state.method ?? (consumer ? 'browser' : 'project');
  async function view(): Promise<ConnectorsReply> {
    const browserAccounts = await consumer?.read();
    return { configured: Boolean(state.apiKey), method: method(), apps: APPS.map(app => ({ ...app, account: state.accounts[app.provider] ? { ...(observations.get(app.provider) ?? { status: 'unverified' as const }), method: 'project' as const } : browserAccounts?.[app.provider] ?? null })) };
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
  async function clearConfigSetup(provider: ConnectorProvider) {
    const configSetups = { ...state.configSetups }; delete configSetups[provider];
    await save({ ...state, configSetups });
  }
  async function prepareConfig(provider: ConnectorProvider, selected: unknown) {
    const apiKey = key(), configs = await vendor.configRecords(apiKey, provider), pending = state.configSetups[provider];
    if (selected !== undefined && !identifier(selected)) throw new Error('Choose an enabled OAuth configuration for this app.');
    if (pending) {
      const matches = configs.filter(config => pending.id ? config.id === pending.id : config.name === pending.name);
      if (matches.length !== 1) throw new Error('Sign-in setup could not be confirmed. Check the configuration in Composio, then Refresh.');
      if (!matches[0].enabled) throw new Error('Enable the OAuth configuration in Composio, then Refresh.');
      if (selected !== undefined && selected !== matches[0].id) throw new Error('Refresh and choose the prepared authorization.');
      await clearConfigSetup(provider); return matches[0].id;
    }
    const enabled = configs.filter(config => config.enabled);
    if (selected !== undefined) {
      if (!enabled.some(config => config.id === selected)) throw new Error('Choose an enabled OAuth configuration for this app.');
      return selected;
    }
    if (enabled.length === 1) return enabled[0].id;
    if (enabled.length > 1) throw new Error('Choose an enabled OAuth configuration for this app.');
    if (configs.length) throw new Error('Check the OAuth configuration in Composio, then Refresh.');
    if (!await vendor.supportsManagedOAuth(apiKey, provider)) throw new Error('This app needs an OAuth configuration in Composio. Configure it there, then Refresh.');
    const name = `perpetual-${provider}-${randomUUID()}`;
    // A lost creation reply must be recovered by name, never repeated after a restart.
    await save({ ...state, configSetups: { ...state.configSetups, [provider]: { name } } });
    try {
      const id = await vendor.createManagedConfig(apiKey, provider, name);
      await save({ ...state, configSetups: { ...state.configSetups, [provider]: { name, id } } });
      const verified = (await vendor.configRecords(apiKey, provider)).find(config => config.id === id && config.enabled);
      if (!verified) throw new Error('Sign-in setup is not verified yet. Refresh before trying again.');
      await clearConfigSetup(provider); return id;
    } catch (error) {
      if (error instanceof ComposioError && [400, 401, 403, 404, 422, 429, 501].includes(error.status)) await clearConfigSetup(provider);
      throw error;
    }
  }
  return {
    read: () => serialize(async () => { for (const app of APPS) await refresh(app.provider); return view(); }),
    setup: (input: unknown) => serialize(async () => {
      const apiKey = keyOf(object(input).apiKey);
      if (apiKey.startsWith('ck_')) throw new Error('This is a Composio Connect key. Get a project API key in Platform → your project → API Keys.');
      if (apiKey.startsWith('uak_')) throw new Error('This is a Composio user key. Get a project API key in Platform → your project → API Keys.');
      // Validate access without creating configs, accounts, or invoking provider tools.
      await vendor.configs(apiKey, 'slack');
      for (const app of APPS) { const record = state.accounts[app.provider]; if (record) await inspect(app.provider, record, apiKey); }
      for (const app of APPS) { const pending = state.configSetups[app.provider]; if (pending && !(await vendor.configRecords(apiKey, app.provider)).some(config => pending.id ? config.id === pending.id : config.name === pending.name)) throw new Error('Resolve the pending sign-in setup in Composio before replacing its project key.'); }
      await save({ ...state, apiKey, method: 'project' }); return view();
    }),
    options: (input: unknown): Promise<ConnectorOptionsReply> => serialize(async () => {
      const provider = providerOf(object(input).provider);
      return !state.accounts[provider] && consumer && (method() === 'browser' || consumer.owns(provider)) ? { configs: [], accounts: await consumer.options(provider) } : { configs: await vendor.configs(key(), provider) };
    }),
    start: (input: unknown) => serialize(async () => {
      const data = object(input), provider = providerOf(data.provider);
      if (state.accounts[provider]) throw new Error('This app already has a connection. Continue sign-in or disconnect it first.');
      if (consumer && (method() === 'browser' || consumer.owns(provider))) { await consumer.start(provider, data.accountId); return view(); }
      const apiKey = key();
      const configId = await prepareConfig(provider, data.configId);
      const record: Record = { configId, alias: `perpetual-${randomUUID()}` };
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
      if (!record) { await consumer?.remove(provider, data.cancel === true); return view(); }
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
    useBrowser: () => serialize(async () => { if (!consumer) throw new Error('Browser authorization is unavailable.'); await save({ ...state, method: 'browser' }); return view(); }),
    complete: (input: unknown) => serialize(async () => { if (!consumer) throw new Error('Browser authorization is unavailable.'); return consumer.complete(input); }),
    async close() { closed = true; await queue.idle(); await consumer?.close(); },
  };
}
