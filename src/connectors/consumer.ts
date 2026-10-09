import { join } from 'node:path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { redact } from '../redaction.ts';
import { authUrl, identifier, object } from './composio.ts';
import { CONSUMER_MCP, consumerFetch, createBrowserAuth, type BrowserAuthOptions } from './browser-auth.ts';
import { createConnectorObservations } from './observations.ts';
import type { ConnectorAccount, ConnectorAuthConfig, ConnectorProvider } from '../../contract/connectors.ts';

const INVALID = 'Cannot load saved browser connections. Keep browser-connections.json and restore a valid snapshot.';
const PROVIDERS = ['slack', 'linear', 'gmail', 'jira'];
interface Binding { id?: string; redirectUrl?: string; initiating?: boolean }
interface State { schema: 1; accounts: Partial<Record<ConnectorProvider, Binding>> }
class ConnectionError extends Error {}
interface Account { id: string; name: string; status: string }
function toolData(raw: unknown): Record<string, unknown> {
  const reply = object(raw); if (reply.isError === true) throw new ConnectionError('Composio could not manage the connection. Try again.');
  let data: unknown = reply.structuredContent;
  if (data === undefined && Array.isArray(reply.content)) {
    const block = reply.content.find(v => object(v).type === 'text');
    const text = object(block).text;
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new ConnectionError('Could not read Composio connection data.');
    try { data = JSON.parse(text) as unknown; } catch { throw new ConnectionError('Could not read Composio connection data.'); }
  }
  const value = object(data); if (value.successful === false || value.error) throw new ConnectionError('Composio could not manage the connection. Try again.');
  return object(value.data ?? value);
}

/** The consumer MCP account is authorized by its person; no Platform key or user id is supplied. */
export async function createConsumerConnections(options: BrowserAuthOptions) {
  const directory = await privateDirectory(join(options.dataDir, 'connectors'), INVALID), file = join(directory, 'browser-connections.json');
  const stored = await readStateFile(file, { limit: 32768, invalid: INVALID }); let state: State = { schema: 1, accounts: {} };
  if (stored !== undefined) {
    const value = object(stored), accounts = object(value.accounts);
    if (value.schema !== 1 || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts) || Object.keys(accounts).some(key => !PROVIDERS.includes(key))) throw new ConnectionError(INVALID);
    for (const provider of PROVIDERS as ConnectorProvider[]) {
      if (accounts[provider] === undefined) continue;
      const binding = object(accounts[provider]);
      if ((binding.id !== undefined && !identifier(binding.id)) || (binding.redirectUrl !== undefined && !authUrl(binding.redirectUrl)) || (binding.initiating !== undefined && typeof binding.initiating !== 'boolean') || (!binding.id && binding.initiating !== true)) throw new ConnectionError(INVALID);
      state.accounts[provider] = { ...(binding.id ? { id: binding.id as string } : {}), ...(binding.redirectUrl ? { redirectUrl: binding.redirectUrl as string } : {}), ...(binding.initiating ? { initiating: true } : {}) };
    }
  }
  const authorization = await createBrowserAuth(options), queue = createSaveQueue(), vendorFetch = consumerFetch(options.transport);
  const observations = createConnectorObservations();
  let closed = false;
  const run = <T>(work: () => Promise<T>) => queue.run(async () => { if (closed) throw new ConnectionError('The controller is stopping.'); return work(); });
  async function save(next: State) { await writeStateFile(file, JSON.stringify(next)); state = next; }
  async function manage<T>(operation: (invoke: (args: Record<string, unknown>) => Promise<Record<string, unknown>>, schema: Record<string, unknown>) => Promise<T>): Promise<T> {
    const token = await authorization.token();
    const client = new Client({ name: 'Perpetual', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(CONSUMER_MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }, fetch: vendorFetch });
    try {
      await client.connect(transport, { timeout: 20000 });
      const tool = (await client.listTools(undefined, { timeout: 20000 })).tools.find(tool => tool.name === 'COMPOSIO_MANAGE_CONNECTIONS');
      if (!tool) throw new ConnectionError('Composio account management is unavailable. Try again.');
      const schema = object(tool.inputSchema), validator = new AjvJsonSchemaValidator().getValidator(schema);
      return await operation(async args => {
        if (!validator(args).valid) throw new ConnectionError('Composio changed its connection interface. Refresh and try again.');
        return toolData(await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 20000 }));
      }, schema);
    } catch (error) {
      // SDK errors can repeat bearer credentials or untrusted vendor text.
      if (error instanceof UnauthorizedError || error instanceof StreamableHTTPError && error.code === 401) await authorization.invalidate();
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError('Could not read Composio connections. Sign in again or try Refresh.');
    } finally { await client.close().catch(() => {}); }
  }
  function connectionOperation(schema: Record<string, unknown>, provider: ConnectorProvider, action: 'list' | 'add') {
    const toolkit = object(object(object(schema.properties).toolkits).items);
    const values = object(object(toolkit.properties).action).enum;
    if (!Array.isArray(values) || !values.includes(action)) throw new ConnectionError('Composio account management is unavailable. Try again.');
    // The vendor defaults an omitted action to add: every read must explicitly say list.
    return { toolkits: [{ name: provider, action }] };
  }
  async function list(provider: ConnectorProvider): Promise<Account[]> {
    const data = await manage(async (invoke, schema) => invoke(connectionOperation(schema, provider, 'list')));
    const group = object(object(data.results)[provider]);
    if (group.toolkit !== provider || !Array.isArray(group.accounts)) throw new ConnectionError('Could not read Composio connection data.');
    const secret = await authorization.token();
    return group.accounts.flatMap(value => {
      const account = object(value), toolkit = object(account.toolkit).slug ?? account.toolkit_slug ?? account.toolkit;
      const id = account.connected_account_id ?? account.account_id ?? account.id;
      if (toolkit !== undefined && toolkit !== provider) throw new ConnectionError('Could not read Composio connection data.');
      if (!identifier(id) || typeof account.status !== 'string') throw new ConnectionError('Could not read Composio connection data.');
      return [{ id, status: account.is_disabled === true ? 'DISABLED' : account.status.toUpperCase(), name: typeof account.alias === 'string' ? redact(account.alias, { secrets: [secret] }).slice(0, 160) : id }];
    });
  }
  async function connect(provider: ConnectorProvider, selected?: unknown) {
    if (selected !== undefined && !identifier(selected)) throw new ConnectionError('Choose an account to connect.');
    const accounts = await list(provider), active = accounts.filter(account => account.status === 'ACTIVE');
    if (selected !== undefined || active.length) {
      const chosen = selected === undefined && active.length === 1 ? active[0] : active.find(account => account.id === selected);
      if (!chosen) throw new ConnectionError('Choose an account to connect.');
      await save({ ...state, accounts: { ...state.accounts, [provider]: { id: chosen.id } } }); return;
    }
    const binding = state.accounts[provider], current = accounts.find(account => account.id === binding?.id);
    if (current && ['INITIATED', 'INITIALIZING'].includes(current.status) && binding?.redirectUrl) return;
    if (binding && (!binding.id || current && !['EXPIRED', 'FAILED', 'REVOKED', 'INACTIVE', 'DISABLED'].includes(current.status))) throw new ConnectionError('Sign-in is still pending or unconfirmed. Continue it, or disconnect before trying again.');
    await save({ ...state, accounts: { ...state.accounts, [provider]: { initiating: true } } });
    const data = await manage(async (invoke, schema) => invoke(connectionOperation(schema, provider, 'add')));
    const record = object(object(data.results)[provider]), redirectUrl = authUrl(record.redirect_url);
    const added = Array.isArray(record.accounts) ? record.accounts.map(object).filter(account => !accounts.some(existing => existing.id === account.id)) : [];
    const id = added[0]?.id, addedStatus = String(added[0]?.status).toLowerCase();
    if (record.toolkit !== provider || added.length !== 1 || !identifier(id) || !['active', 'initiated'].includes(String(record.status)) || !['active', 'initiated', 'initializing'].includes(addedStatus)) throw new ConnectionError('Sign-in could not be confirmed. Check Composio before trying again.');
    await save({ ...state, accounts: { ...state.accounts, [provider]: { id, ...(redirectUrl ? { redirectUrl } : {}) } } });
    if (addedStatus !== 'active' && !redirectUrl) throw new ConnectionError('Composio did not return a sign-in link. Disconnect and try again.');
  }
  function snapshot(): Partial<Record<ConnectorProvider, ConnectorAccount>> {
    const accounts: Partial<Record<ConnectorProvider, ConnectorAccount>> = {}, pending = authorization.pending();
    if (pending) accounts[pending.provider] = { method: 'browser', status: 'pending', ...(pending.redirectUrl ? { redirectUrl: pending.redirectUrl } : {}) };
    for (const provider of PROVIDERS as ConnectorProvider[]) {
      const binding = state.accounts[provider];
      if (binding && pending?.provider !== provider) accounts[provider] = authorization.authorized()
        ? { ...observations.snapshot(provider, binding.id ?? 'initiating'), method: 'browser' }
        : { method: 'browser', status: 'unverified', error: 'Sign in again to verify this connection.' };
    }
    return accounts;
  }
  return {
    snapshot,
    owns: (provider: ConnectorProvider) => Boolean(state.accounts[provider]) || authorization.pending()?.provider === provider,
    read: () => run(async () => {
      const accounts: Partial<Record<ConnectorProvider, ConnectorAccount>> = {}, pending = authorization.pending();
      if (pending) accounts[pending.provider] = { method: 'browser', status: 'pending', ...(pending.redirectUrl ? { redirectUrl: pending.redirectUrl } : {}) };
      for (const provider of PROVIDERS as ConnectorProvider[]) {
        const binding = state.accounts[provider]; if (!binding || pending?.provider === provider) continue;
        try {
          if (!binding.id) throw new ConnectionError('Sign-in could not be confirmed. Check Composio before reconnecting.');
          const account = (await list(provider)).find(account => account.id === binding.id);
          if (!account) throw new ConnectionError('This connection was removed from Composio. Disconnect it here to reconnect.');
          accounts[provider] = { method: 'browser', status: account.status === 'ACTIVE' ? 'connected' : ['INITIATED', 'INITIALIZING'].includes(account.status) ? 'pending' : 'needs-auth', ...(account.status !== 'ACTIVE' && binding.redirectUrl ? { redirectUrl: binding.redirectUrl } : {}) };
        } catch (error) { accounts[provider] = { method: 'browser', status: 'unverified', error: error instanceof ConnectionError ? error.message : 'Could not verify the connection. Sign in again or try Refresh.' }; }
        observations.remember(provider, binding.id ?? 'initiating', accounts[provider]!);
      }
      return accounts;
    }),
    options: (provider: ConnectorProvider): Promise<ConnectorAuthConfig[]> => run(async () => !authorization.authorized() ? [] : (await list(provider)).filter(account => account.status === 'ACTIVE').map(({ id, name }) => ({ id, name }))),
    start: (provider: ConnectorProvider, selected?: unknown) => run(async () => {
      if (!authorization.authorized()) return authorization.start(provider);
      await connect(provider, selected); return state.accounts[provider]?.redirectUrl;
    }),
    complete: (input: unknown) => run(async () => { const provider = await authorization.complete(input); await connect(provider); return state.accounts[provider]?.redirectUrl; }),
    remove: (provider: ConnectorProvider, cancel = false) => run(async () => { const binding = state.accounts[provider]; if (cancel && binding?.id && (await list(provider)).some(account => account.id === binding.id && account.status === 'ACTIVE')) throw new ConnectionError('Sign-in completed. Use Disconnect to remove this account.'); await authorization.cancel(provider); const accounts = { ...state.accounts }; delete accounts[provider]; await save({ ...state, accounts }); }),
    async close() { closed = true; await queue.idle(); await authorization.close(); },
  };
}
