import type { ConnectorAuthConfig, ConnectorProvider } from '../../contract/connectors.ts';
import { redact } from '../redaction.ts';

const BASE = 'https://backend.composio.dev/api/v3.1';
const LIMIT = 2 * 1024 * 1024;
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
export function authUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.origin === 'https://connect.composio.dev' && url.pathname.startsWith('/link/') && !url.username && !url.password) return url.href;
  } catch { /* A vendor reply is untrusted. */ }
}
export class ComposioError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
interface OAuthConfig extends ConnectorAuthConfig { enabled: boolean }
/** Tests replace the transport, never the fixed production URL or credential header. */
export function createComposio({ transport = fetch }: { transport?: typeof fetch } = {}) {
  async function request(key: string, path: string, method = 'GET', input?: unknown): Promise<unknown> {
    try {
      const response = await transport(BASE + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'x-api-key': key, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (!response.ok) {
        await response.body?.cancel();
        const message = response.status === 401 || response.status === 403 ? 'Composio denied access. Check your project API key.' : response.status === 429 ? 'Composio is busy. Try again shortly.' : 'Composio could not complete the request. Try again.';
        throw new ComposioError(response.status, message);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > LIMIT) throw new Error(); chunks.push(item.value); }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof ComposioError) throw error;
      // Fetch failures and vendor bodies can contain keys and tokens. None are returned or logged.
      throw new ComposioError(502, 'Could not read Composio. Try again.');
    }
  }
  async function pages(key: string, path: string): Promise<unknown[]> {
    const items: unknown[] = []; const seen = new Set<string>(); let cursor = '';
    for (let page = 0; page < 20; page++) {
      const data = object(await request(key, path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
      if (!Array.isArray(data.items)) throw new Error('Could not read Composio records. Try again.');
      items.push(...data.items);
      if (!data.next_cursor) return items;
      if (typeof data.next_cursor !== 'string' || data.next_cursor.length > 4096 || seen.has(data.next_cursor)) break;
      cursor = data.next_cursor; seen.add(cursor);
    }
    throw new Error('Too many Composio records. Narrow the project configuration.');
  }
  async function configRecords(key: string, provider: ConnectorProvider): Promise<OAuthConfig[]> {
    const items = await pages(key, `/auth_configs?toolkit_slug=${provider}&show_disabled=true&limit=200`);
    return items.flatMap(value => {
      const item = object(value);
      return object(item.toolkit).slug === provider && item.auth_scheme === 'OAUTH2' && identifier(item.id)
        ? [{ id: item.id, name: typeof item.name === 'string' ? redact(item.name, { secrets: [key] }).slice(0, 160) : item.id, enabled: item.status === 'ENABLED' }] : [];
    });
  }
  return {
    configRecords,
    async configs(key: string, provider: ConnectorProvider): Promise<ConnectorAuthConfig[]> {
      return (await configRecords(key, provider)).filter(item => item.enabled).map(({ id, name }) => ({ id, name }));
    },
    async supportsManagedOAuth(key: string, provider: ConnectorProvider) {
      const data = object(await request(key, `/toolkits/${provider}`));
      if (!Array.isArray(data.composio_managed_auth_schemes)) throw new Error('Could not verify managed sign-in. Refresh and try again.');
      return data.composio_managed_auth_schemes.includes('OAUTH2');
    },
    async createManagedConfig(key: string, provider: ConnectorProvider, name: string) {
      let data: Record<string, unknown>;
      try { data = object(await request(key, '/auth_configs', 'POST', { toolkit: { slug: provider }, auth_config: { type: 'use_composio_managed_auth', name, credentials: {} } })); }
      catch (error) {
        if (error instanceof ComposioError && error.status === 403) throw new ComposioError(403, 'Composio refused sign-in setup. Check the project key and its Auth configs write permission.');
        throw error;
      }
      const config = object(data.auth_config);
      if (object(data.toolkit).slug !== provider || !identifier(config.id) || config.auth_scheme !== 'OAUTH2' || config.is_composio_managed !== true) throw new Error('Could not confirm sign-in setup. Refresh before trying again.');
      return config.id;
    },
    link: (key: string, configId: string, userId: string, alias: string) => request(key, '/connected_accounts/link', 'POST', { auth_config_id: configId, user_id: userId, alias }),
    details: (key: string, id: string) => request(key, `/connected_accounts/${id}`),
    // Recover an uncertain link response by its persisted unique alias, never adopt someone else's account.
    accounts: (key: string, userId: string, provider: ConnectorProvider) => pages(key, `/connected_accounts?user_ids=${encodeURIComponent(userId)}&toolkit_slugs=${provider}&limit=100`),
    async remove(key: string, id: string) {
      const data = object(await request(key, `/connected_accounts/${id}`, 'DELETE'));
      if (data.success !== true) throw new Error('Composio did not confirm disconnect. Refresh and try again.');
    },
  };
}
