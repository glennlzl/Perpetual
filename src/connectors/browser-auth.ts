import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { auth, refreshAuthorization, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationFullSchema, OAuthTokensSchema, type OAuthClientInformationFull, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { object } from './composio.ts';
import type { ConnectorProvider } from '../../contract/connectors.ts';

export const CONSUMER_MCP = 'https://connect.composio.dev/mcp';
const ISSUER = 'https://connect.composio.dev';
const INVALID = 'Cannot load saved browser authorization. Keep browser-auth.json and restore a valid snapshot.';
const PROVIDERS = ['slack', 'linear', 'gmail', 'jira'];
interface Attempt { provider: ConnectorProvider; state: string; redirectUri: string; createdAt: number; verifier?: string; redirectUrl?: string; exchanging?: boolean }
interface State { schema: 1; client?: OAuthClientInformationFull; redirectUri?: string; tokens?: OAuthTokens; expiresAt?: number; needsAuth?: boolean; attempt?: Attempt }
export interface BrowserAuthOptions { dataDir: string; callbackUrl: () => string; transport?: typeof fetch }

/** OAuth traffic is vendor-pinned even when discovery documents or redirects are hostile. */
export function consumerFetch(transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const allowed = url.origin === ISSUER && (url.pathname === '/mcp' || url.pathname.startsWith('/.well-known/')) || url.origin === 'https://login.composio.dev' && ['/oauth2/register', '/oauth2/token'].includes(url.pathname);
    if (!allowed || url.username || url.password) throw new Error('Composio returned an unsupported authorization endpoint.');
    const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(init?.signal ? [init.signal] : [])]);
    const response = await transport(input, { ...init, redirect: 'error', signal });
    // Keep authorization JSON and MCP messages bounded; streaming MCP is closed after each operation.
    if (!response.body) return response;
    const reader = response.body.getReader(); let length = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        try { const chunk = await reader.read(); if (chunk.done) { controller.close(); return; } length += chunk.value.length; if (length > 2 * 1024 * 1024) throw new Error('Composio response exceeds the allowed size.'); controller.enqueue(chunk.value); }
        catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      },
      cancel: () => reader.cancel(),
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
function callback(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/connectors/oauth/callback' || url.search || url.hash || url.username || url.password) throw new Error('Browser authorization needs the local controller callback.');
  return url.href;
}
function load(raw: unknown): State {
  const value = object(raw); if (value.schema !== 1) throw new Error(INVALID);
  const state: State = { schema: 1 };
  if (value.client !== undefined) { const parsed = OAuthClientInformationFullSchema.safeParse(value.client); if (!parsed.success || parsed.data.issuer !== ISSUER || parsed.data.token_endpoint_auth_method !== 'none') throw new Error(INVALID); state.client = parsed.data; }
  if (value.redirectUri !== undefined) { if (typeof value.redirectUri !== 'string') throw new Error(INVALID); try { state.redirectUri = callback(value.redirectUri); } catch { throw new Error(INVALID); } }
  if (state.client && (!state.redirectUri || !state.client.redirect_uris.includes(state.redirectUri))) throw new Error(INVALID);
  if (value.tokens !== undefined) { const parsed = OAuthTokensSchema.safeParse(value.tokens); if (!parsed.success || parsed.data.issuer !== ISSUER || !state.client || !validTokens(parsed.data) || parsed.data.token_type.toLowerCase() !== 'bearer') throw new Error(INVALID); state.tokens = parsed.data; }
  if (value.expiresAt !== undefined) { if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || !state.tokens) throw new Error(INVALID); state.expiresAt = value.expiresAt; }
  if (value.needsAuth !== undefined) { if (typeof value.needsAuth !== 'boolean') throw new Error(INVALID); state.needsAuth = value.needsAuth; }
  if (value.attempt !== undefined) {
    const a = object(value.attempt);
    if (!PROVIDERS.includes(String(a.provider)) || typeof a.state !== 'string' || !/^[a-f0-9]{64}$/.test(a.state) || typeof a.redirectUri !== 'string' || typeof a.createdAt !== 'number' || !Number.isFinite(a.createdAt) || (a.verifier !== undefined && (typeof a.verifier !== 'string' || !/^[a-zA-Z0-9._~-]{43,128}$/.test(a.verifier))) || (a.redirectUrl !== undefined && (typeof a.redirectUrl !== 'string' || !validAuthorization(a.redirectUrl, a.state, a.redirectUri))) || (a.exchanging !== undefined && typeof a.exchanging !== 'boolean')) throw new Error(INVALID);
    state.attempt = { provider: a.provider as ConnectorProvider, state: a.state, redirectUri: callback(a.redirectUri), createdAt: a.createdAt, ...(a.verifier ? { verifier: a.verifier as string } : {}), ...(a.redirectUrl ? { redirectUrl: a.redirectUrl as string } : {}), ...(a.exchanging ? { exchanging: true } : {}) };
  }
  return state;
}
function validTokens(tokens: OAuthTokens) {
  return [tokens.access_token, tokens.refresh_token, tokens.id_token].every(value => value === undefined || typeof value === 'string' && value.length > 0 && value.length <= 16384) && (tokens.expires_in === undefined || Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 && tokens.expires_in <= 365 * 86400);
}
function validAuthorization(raw: string, nonce: string, redirectUri: string) {
  try { const url = new URL(raw); return url.origin === ISSUER && url.pathname === '/oauth/authorize' && !url.username && !url.password && url.searchParams.get('state') === nonce && url.searchParams.get('redirect_uri') === redirectUri && url.searchParams.get('code_challenge_method') === 'S256'; } catch { return false; }
}

/** No app credentials or OAuth state leave this module; only a browser link crosses its public interface. */
export async function createBrowserAuth({ dataDir, callbackUrl, transport }: BrowserAuthOptions) {
  const directory = await privateDirectory(join(dataDir, 'connectors'), INVALID), file = join(directory, 'browser-auth.json');
  const stored = await readStateFile(file, { limit: 65536, invalid: INVALID }); let state: State = stored === undefined ? { schema: 1 } : load(stored);
  const queue = createSaveQueue(), vendorFetch = consumerFetch(transport); let closed = false;
  const run = <T>(work: () => Promise<T>) => queue.run(async () => { if (closed) throw new Error('The controller is stopping.'); return work(); });
  async function save(next: State) { await writeStateFile(file, JSON.stringify(next)); state = next; }
  function provider(attempt: Attempt): OAuthClientProvider {
    return {
      redirectUrl: attempt.redirectUri,
      clientMetadata: { client_name: 'Perpetual', redirect_uris: [attempt.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'openid profile email offline_access' },
      state: () => attempt.state,
      clientInformation: () => state.redirectUri === attempt.redirectUri ? state.client : undefined,
      async saveClientInformation(value) { const parsed = OAuthClientInformationFullSchema.safeParse(value); if (!parsed.success || parsed.data.issuer !== ISSUER || parsed.data.token_endpoint_auth_method !== 'none' || !parsed.data.redirect_uris.includes(attempt.redirectUri)) throw new Error('Could not verify Composio client registration.'); await save({ ...state, client: parsed.data, redirectUri: attempt.redirectUri, ...(state.redirectUri !== attempt.redirectUri ? { tokens: undefined, expiresAt: undefined } : {}) }); },
      tokens: () => undefined,
      async saveTokens(value) { const parsed = OAuthTokensSchema.safeParse(value); if (!parsed.success || parsed.data.issuer !== ISSUER || !validTokens(parsed.data) || parsed.data.token_type.toLowerCase() !== 'bearer') throw new Error('Could not verify Composio authorization.'); await save({ ...state, tokens: parsed.data, needsAuth: false, expiresAt: parsed.data.expires_in === undefined ? undefined : Date.now() + parsed.data.expires_in * 1000 }); },
      async redirectToAuthorization(url) { if (!validAuthorization(url.href, attempt.state, attempt.redirectUri)) throw new Error('Composio returned an unsupported sign-in link.'); await save({ ...state, attempt: { ...state.attempt!, redirectUrl: url.href } }); },
      async saveCodeVerifier(verifier) { await save({ ...state, attempt: { ...state.attempt!, verifier } }); },
      codeVerifier() { if (!attempt.verifier) throw new Error('Sign-in expired. Connect again.'); return attempt.verifier; },
    };
  }
  return {
    pending: () => state.attempt && !state.attempt.exchanging && Date.now() - state.attempt.createdAt < 10 * 60 * 1000 ? { provider: state.attempt.provider, redirectUrl: state.attempt.redirectUrl } : undefined,
    authorized: () => Boolean(state.tokens) && !state.needsAuth,
    invalidate: () => run(async () => { await save({ ...state, needsAuth: true }); }),
    start: (selected: ConnectorProvider) => run(async () => {
      const redirectUri = callback(callbackUrl()), pending = state.attempt;
      if (pending?.provider === selected && pending.redirectUri === redirectUri && pending.redirectUrl && !pending.exchanging && Date.now() - pending.createdAt < 10 * 60 * 1000) return pending.redirectUrl;
      const attempt: Attempt = { provider: selected, state: randomBytes(32).toString('hex'), redirectUri, createdAt: Date.now() };
      await save({ ...state, attempt });
      try { await auth(provider(attempt), { serverUrl: CONSUMER_MCP, scope: 'openid profile email offline_access', fetchFn: vendorFetch }); }
      catch { throw new Error('Could not start Composio sign-in. Connect again.'); }
      if (!state.attempt?.redirectUrl) throw new Error('Composio did not return a sign-in link. Connect again.');
      return state.attempt.redirectUrl;
    }),
    complete: (input: unknown) => run(async () => {
      const value = object(input), attempt = state.attempt;
      if (!attempt || attempt.exchanging || typeof value.state !== 'string' || value.state.length !== attempt.state.length || !timingSafeEqual(Buffer.from(value.state), Buffer.from(attempt.state)) || Date.now() - attempt.createdAt >= 10 * 60 * 1000 || attempt.redirectUri !== callback(callbackUrl())) throw new Error('Sign-in expired or does not match this browser request. Connect again.');
      if (value.error !== undefined) { await save({ ...state, attempt: undefined }); throw new Error('Composio sign-in was cancelled. Connect again when ready.'); }
      if (typeof value.code !== 'string' || !value.code || value.code.length > 4096 || !attempt.verifier) throw new Error('Composio did not return a valid sign-in code. Connect again.');
      await save({ ...state, attempt: { ...attempt, exchanging: true } });
      try { const result = await auth(provider(attempt), { serverUrl: CONSUMER_MCP, authorizationCode: value.code, fetchFn: vendorFetch }); if (result !== 'AUTHORIZED' || !state.tokens) throw new Error(); await save({ ...state, attempt: undefined }); return attempt.provider; }
      catch { throw new Error('Could not finish Composio sign-in. Connect again.'); }
    }),
    token: () => run(async () => {
      if (!state.tokens || !state.client || state.needsAuth) throw new Error('Sign in to connect this app.');
      if (state.expiresAt && state.expiresAt <= Date.now() + 60000) {
        if (!state.tokens.refresh_token) { await save({ ...state, needsAuth: true }); throw new Error('Composio sign-in expired. Sign in again.'); }
        try {
          const metadata = { issuer: ISSUER, authorization_endpoint: ISSUER + '/oauth/authorize', token_endpoint: 'https://login.composio.dev/oauth2/token', response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] };
          const tokens = await refreshAuthorization(ISSUER, { metadata, clientInformation: state.client, refreshToken: state.tokens.refresh_token, resource: CONSUMER_MCP, fetchFn: vendorFetch });
          if (!validTokens(tokens) || tokens.token_type.toLowerCase() !== 'bearer') throw new Error();
          await save({ ...state, tokens: { ...tokens, refresh_token: tokens.refresh_token ?? state.tokens.refresh_token, issuer: ISSUER }, needsAuth: false, expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000 });
        } catch (error) { if (error instanceof InvalidGrantError || error instanceof InvalidClientError) await save({ ...state, needsAuth: true }); throw new Error('Could not refresh Composio sign-in. Sign in again.'); }
      }
      return state.tokens!.access_token;
    }),
    cancel: (selected: ConnectorProvider) => run(async () => { if (state.attempt?.provider === selected) await save({ ...state, attempt: undefined }); }),
    async close() { closed = true; await queue.idle(); },
  };
}
