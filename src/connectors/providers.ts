import type { BetterAuthPlugin } from 'better-auth';
import { createAuthorizationURL, type OAuth2Tokens, type OAuthProvider } from 'better-auth/oauth2';
import type { ConnectorProvider } from '../../contract/connectors.ts';
import { redact } from '../redaction.ts';

export const APPS = [{ provider: 'slack', name: 'Slack' }, { provider: 'linear', name: 'Linear' }, { provider: 'gmail', name: 'Gmail' }, { provider: 'jira', name: 'Jira' }] as const;
export type DirectConnectorProvider = Exclude<ConnectorProvider, 'gmail'>;
export const DIRECT_APPS = APPS.filter((app): app is Extract<typeof APPS[number], { provider: DirectConnectorProvider }> => app.provider !== 'gmail');
const ENDPOINTS = {
  slack: { env: 'SLACK', authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', scopes: ['users:read', 'users:read.email'] },
  linear: { env: 'LINEAR', authorize: 'https://linear.app/oauth/authorize', token: 'https://api.linear.app/oauth/token', scopes: ['read'] },
  jira: { env: 'JIRA', authorize: 'https://auth.atlassian.com/authorize', token: 'https://auth.atlassian.com/oauth/token', scopes: ['read:me', 'read:jira-user', 'read:jira-work', 'offline_access'] },
} satisfies Record<DirectConnectorProvider, { env: string; authorize: string; token: string; scopes: readonly string[] }>;
const LIMIT = 262144;
const AUTH_ERRORS = new Set(['invalid_grant', 'invalid_token', 'invalid_auth', 'token_expired', 'token_revoked', 'account_inactive', 'not_authed', 'missing_scope', 'access_denied']);
const RATE_ERRORS = new Set(['ratelimited', 'rate_limited', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED', 'usage limit exceeded']);
const CONFIG_ERRORS = new Set(['invalid_client', 'unauthorized_client', 'invalid_client_id', 'bad_client_secret', 'invalid_scope']);
type Configuration = { clientId: string; clientSecret?: string };
type Profile = { id: string; label: string; email: string; emailVerified: boolean };
export class ConnectorAuthError extends Error {
  readonly needsAuth: boolean;
  constructor(message: string, needsAuth = false) { super(message); this.name = 'ConnectorAuthError'; this.needsAuth = needsAuth; }
}
export function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function providerOf(value: unknown): ConnectorProvider {
  if (!APPS.some(app => app.provider === value)) throw new Error('Choose an available app.');
  return value as ConnectorProvider;
}
export function providerAuthorizationUrl(provider: ConnectorProvider, value: unknown): string | undefined {
  if (provider === 'gmail') return;
  if (typeof value !== 'string' || value.length > 16384) return;
  try {
    const url = new URL(value), expected = new URL(ENDPOINTS[provider].authorize);
    if (url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password && !url.hash) return url.href;
  } catch { /* Invalid URLs are never opened. */ }
}
export function providerRedirectUri(provider: ConnectorProvider, uri: string): string {
  if (provider !== 'slack') return uri;
  const url = new URL(uri);
  // Slack documents localhost as its public desktop redirect; the controller also accepts this callback host.
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') url.hostname = 'localhost';
  return url.href;
}
const credential = (value: unknown, limit = 32768): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
function string(value: unknown, limit = 512): string | undefined { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined; }
function identity(id: unknown, email: unknown, label: unknown, emailVerified = false): Profile {
  const subject = string(id), address = string(email), name = string(label);
  if (!subject || !address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ConnectorAuthError('The service did not return a complete account profile. Check the app permissions.');
  return { id: subject, email: address, label: redact(name ?? address), emailVerified };
}

/** Better Auth owns state, callbacks, storage and refresh; providers normalize their documented wire formats. */
export function createConnectorProviders({ env, transport = fetch }: { env: Record<string, string | undefined>; transport?: typeof fetch }) {
  const settings = new Map<DirectConnectorProvider, Configuration>(), setupErrors = new Map<ConnectorProvider, string>();
  const refreshErrors = new Map<DirectConnectorProvider, ConnectorAuthError>();
  setupErrors.set('gmail', 'Gmail authorization is managed by the connector broker.');
  for (const { provider, name } of DIRECT_APPS) {
    const prefix = `PERPETUAL_${ENDPOINTS[provider].env}`, clientId = env[`${prefix}_CLIENT_ID`]?.trim(), clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim() || undefined;
    if (!clientId) setupErrors.set(provider, `${name} OAuth is not configured on this installation. Set ${prefix}_CLIENT_ID and restart Perpetual.`);
    else if (!credential(clientId, 1024) || (clientSecret !== undefined && !credential(clientSecret, 4096))) setupErrors.set(provider, `Check this installation's ${name} OAuth credentials and restart Perpetual.`);
    else if (provider === 'jira' && !clientSecret) setupErrors.set(provider, 'Jira OAuth requires PERPETUAL_JIRA_CLIENT_SECRET on this installation. Set it and restart Perpetual.');
    else settings.set(provider, { clientId, ...(clientSecret ? { clientSecret } : {}) });
  }
  function configuration(provider: ConnectorProvider): { configured: boolean; setupError?: string } {
    return { configured: provider !== 'gmail' && settings.has(provider), ...(setupErrors.has(provider) ? { setupError: setupErrors.get(provider)! } : {}) };
  }
  async function request(provider: DirectConnectorProvider, url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
    const name = APPS.find(app => app.provider === provider)!.name;
    try {
      const response = await transport(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new ConnectorAuthError(`${name} returned an unexpected redirect. Try again.`);
      if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw new ConnectorAuthError(`${name} returned an invalid response. Try again.`); }
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorAuthError(`${name} returned an invalid response. Try again.`);
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > LIMIT) { await reader.cancel(); throw new ConnectorAuthError(`${name} returned an invalid response. Try again.`); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ConnectorAuthError(`${name} returned an invalid response. Try again.`); }
      const data = object(raw), error = typeof data.error === 'string' ? data.error : object(data.error).status;
      const reasons = Array.isArray(object(data.error).errors) ? (object(data.error).errors as unknown[]).map(item => object(item).reason) : [];
      const graphErrors = provider === 'linear' && Array.isArray(data.errors) ? data.errors.map(item => object(object(item).extensions).type) : [];
      const codes = [error, ...reasons, ...graphErrors].filter((value): value is string => typeof value === 'string');
      if (codes.some(code => CONFIG_ERRORS.has(code))) throw new ConnectorAuthError(`${name} OAuth is misconfigured on this installation. Check the app credentials and permissions.`);
      if (response.status === 429 || codes.some(code => RATE_ERRORS.has(code))) throw new ConnectorAuthError(`${name} is limiting requests. Try again later.`);
      if (response.status === 401 || codes.some(code => AUTH_ERRORS.has(code) || code === 'authentication error' || code === 'UNAUTHENTICATED')) throw new ConnectorAuthError(`Sign in to ${name} again.`, true);
      if (response.status === 403) throw new ConnectorAuthError(`${name} denied access. Check the app permissions and sign in again.`, true);
      if (!response.ok || data.ok === false || data.error !== undefined || (provider === 'linear' && Array.isArray(data.errors) && data.errors.length > 0)) throw new ConnectorAuthError(`${name} could not complete the request. Try again.`);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConnectorAuthError(`${name} returned an invalid response. Try again.`);
      return data;
    } catch (error) {
      if (error instanceof ConnectorAuthError) throw error;
      throw new ConnectorAuthError(`Could not reach ${name}. Try again.`);
    }
  }
  async function profile(provider: DirectConnectorProvider, accessToken: string): Promise<Profile> {
    if (!credential(accessToken)) throw new ConnectorAuthError('Sign in to this app again.', true);
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (provider === 'slack') {
      const verified = await request(provider, 'https://slack.com/api/auth.test', { headers });
      const userId = string(verified.user_id), teamId = string(verified.team_id);
      if (!userId || !teamId) throw new ConnectorAuthError('Slack did not return a complete account profile.');
      const result = await request(provider, `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, { headers }), user = object(result.user), details = object(user.profile);
      if (user.id !== userId || user.deleted === true) throw new ConnectorAuthError('Sign in to Slack again.', true);
      return identity(`${teamId}:${userId}`, details.email, details.real_name ?? user.real_name ?? verified.user);
    }
    if (provider === 'linear') {
      const result = await request(provider, 'https://api.linear.app/graphql', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { id name email } }' }) });
      const viewer = object(object(result.data).viewer);
      return identity(viewer.id, viewer.email, viewer.name);
    }
    const result = await request(provider, 'https://api.atlassian.com/me', { headers });
    if (result.account_status !== undefined && result.account_status !== 'active') throw new ConnectorAuthError('Sign in to Jira again.', true);
    return identity(result.account_id, result.email, result.name);
  }
  function normalize(provider: DirectConnectorProvider, result: Record<string, unknown>, refreshing: boolean): OAuth2Tokens {
    const data = provider === 'slack' && !refreshing ? object(result.authed_user) : result;
    if (!credential(data.access_token) || (data.refresh_token !== undefined && !credential(data.refresh_token))) throw new ConnectorAuthError('The service returned invalid authorization credentials. Sign in again.', true);
    if (provider === 'slack' && data.token_type !== 'user') throw new ConnectorAuthError('Slack did not grant a user connection. Check the app OAuth configuration.');
    const expiresIn = data.expires_in;
    if (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 315360000)) throw new ConnectorAuthError('The service returned an invalid token expiry. Try again.');
    const scopes = typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : Array.isArray(data.scope) && data.scope.every(scope => typeof scope === 'string') ? data.scope as string[] : undefined;
    return { accessToken: data.access_token, ...(data.refresh_token ? { refreshToken: data.refresh_token as string } : {}), ...(typeof expiresIn === 'number' ? { accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000) } : {}), ...(scopes ? { scopes } : {}) };
  }
  async function exchange(provider: DirectConnectorProvider, config: Configuration, grant: Record<string, string>): Promise<OAuth2Tokens> {
    const body = { ...grant, client_id: config.clientId, ...(config.clientSecret && provider !== 'slack' ? { client_secret: config.clientSecret } : {}) };
    const result = await request(provider, ENDPOINTS[provider].token, { method: 'POST', headers: { 'Content-Type': provider === 'jira' ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: provider === 'jira' ? JSON.stringify(body) : new URLSearchParams(body).toString() });
    return normalize(provider, result, grant.grant_type === 'refresh_token');
  }
  const providers: OAuthProvider<Profile>[] = DIRECT_APPS.flatMap(({ provider, name }) => {
    const config = settings.get(provider); if (!config) return [];
    const endpoints = ENDPOINTS[provider];
    return [{
      id: provider, name,
      accountSubject: ({ profile: account }) => account.id,
      async createAuthorizationURL(data) {
        const url = await createAuthorizationURL({
          id: provider, options: { clientId: config.clientId }, authorizationEndpoint: endpoints.authorize,
          state: data.state, redirectURI: providerRedirectUri(provider, data.redirectURI), codeVerifier: provider === 'jira' ? undefined : data.codeVerifier,
          scopes: provider === 'slack' ? [] : [...endpoints.scopes], scopeJoiner: provider === 'linear' ? ',' : ' ',
          ...(provider === 'jira' ? { prompt: 'consent', additionalParams: { audience: 'api.atlassian.com' } } : {}),
          ...(provider === 'slack' ? { additionalParams: { user_scope: endpoints.scopes.join(',') } } : {}),
        });
        // Slack otherwise falls back to configured bot scopes, which public desktop clients cannot request.
        if (provider === 'slack') url.searchParams.set('scope', '');
        return url;
      },
      async validateAuthorizationCode({ code, redirectURI, codeVerifier }) {
        if (provider !== 'jira' && !credential(codeVerifier)) throw new ConnectorAuthError('The sign-in request expired. Start again.', true);
        return exchange(provider, config, { grant_type: 'authorization_code', code, redirect_uri: providerRedirectUri(provider, redirectURI), ...(provider !== 'jira' && codeVerifier ? { code_verifier: codeVerifier } : {}) });
      },
      async getUserInfo(tokens) {
        if (!tokens.accessToken) throw new ConnectorAuthError('Sign in to this app again.', true);
        const account = await profile(provider, tokens.accessToken);
        return { user: { name: account.label, email: account.email, emailVerified: account.emailVerified }, data: account };
      },
      async refreshAccessToken(refreshToken) {
        refreshErrors.delete(provider);
        try { return await exchange(provider, config, { grant_type: 'refresh_token', refresh_token: refreshToken }); }
        catch (error) {
          const failure = error instanceof ConnectorAuthError ? error : new ConnectorAuthError(`Could not refresh ${name}. Try again.`);
          refreshErrors.set(provider, failure); throw failure;
        }
      },
    } satisfies OAuthProvider<Profile>];
  });
  const plugin: BetterAuthPlugin = { id: 'perpetual-connectors', init: context => ({ context: { socialProviders: [...providers, ...context.socialProviders] } }) };
  return { plugin, configuration, refreshFailure: (provider: ConnectorProvider) => provider === 'gmail' ? undefined : refreshErrors.get(provider), verifyAccount: async (provider: ConnectorProvider, accessToken: string) => {
    if (provider === 'gmail') throw new ConnectorAuthError('Gmail account verification is managed by the connector broker.');
    const account = await profile(provider, accessToken); return { id: account.id, label: account.label };
  } };
}
