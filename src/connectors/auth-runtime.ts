import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { privateDatabaseFile } from '../store.ts';
import { DIRECT_APPS, ConnectorAuthError, createConnectorProviders, object, providerAuthorizationUrl, providerRedirectUri } from './providers.ts';
import type { ConnectorProvider } from '../../contract/connectors.ts';

export const AUTH_PATH = '/connectors/auth';
export const callbackPath = (provider: ConnectorProvider) => `${AUTH_PATH}/callback/${provider}`;
const INVALID = 'Cannot open local connector authorization. Restore its private database and auth.json together.';
export function localOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Connector authorization needs the local controller address.');
  return url.origin;
}
const cookies = (headers: Headers) => headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');

/** Better Auth runs inside the controller. Only the guarded callback is reachable over HTTP. */
export async function createLocalAuth({ file, secret, ownerId, origin, env, transport }: {
  file: string; secret: string; ownerId: string; origin: () => string; env: NodeJS.ProcessEnv; transport?: typeof fetch;
}) {
  await privateDatabaseFile(file, INVALID);
  const database = new DatabaseSync(file);
  database.exec('PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;');
  const providers = createConnectorProviders({ env, transport });
  let linkedId: string | undefined;
  // This endpoint is invoked only through the server-side API. It is never mounted on the local HTTP server.
  const localOwner = {
    id: 'perpetual-local-owner',
    endpoints: {
      localOwner: createAuthEndpoint('/local-owner', { method: 'POST' }, async ctx => {
        const adapter = ctx.context.internalAdapter;
        const user = await adapter.findUserById(ownerId) ?? await adapter.createUser({ id: ownerId, email: `${ownerId}@local.invalid`, name: 'Local installation', emailVerified: false }, { method: 'perpetual-local' });
        if (user.id !== ownerId) throw new Error(INVALID);
        const session = await adapter.createSession(ownerId, true);
        await setSessionCookie(ctx, { user, session });
        return ctx.json({ ready: true });
      }),
    },
  };
  const options = (baseURL: string) => ({
    appName: 'Perpetual', baseURL, basePath: AUTH_PATH, secret, database,
    telemetry: { enabled: false }, logger: { disabled: true },
    trustedOrigins: [baseURL],
    plugins: [providers.plugin, localOwner],
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true, allowUnlinkingAll: true, trustedProviders: DIRECT_APPS.map(app => app.provider) } },
    session: { expiresIn: 600, cookieCache: { enabled: false } },
    databaseHooks: { account: {
      create: { after: async (account: { id: string }) => { linkedId = account.id; } },
      update: { after: async (account: { id: string }) => { linkedId = account.id; } },
    } },
  });
  try { await (await getMigrations(options('http://127.0.0.1:4317'))).runMigrations(); }
  catch { database.close(); throw new Error(INVALID); }
  // The operating system assigns --port 0 only after controller initialization. Schema setup needs no live origin.
  let instance: ReturnType<typeof betterAuth<ReturnType<typeof options>>> | undefined, boundOrigin: string | undefined;
  function auth() {
    const current = localOrigin(origin());
    if (!instance || current !== boundOrigin) { instance = betterAuth(options(current)); boundOrigin = current; }
    return instance;
  }
  const accounts = async () => (await auth().$context).internalAdapter.findAccounts(ownerId);
  return {
    providers,
    async prepare(provider: ConnectorProvider) {
      const runtime = auth(), baseURL = localOrigin(origin());
      const owner = await runtime.api.localOwner({ asResponse: true });
      if (!owner.ok) throw new Error('Could not prepare local authorization. Try again.');
      const sessionCookies = cookies(owner.headers);
      const response = await runtime.api.linkSocialAccount({
        headers: new Headers({ cookie: sessionCookies, origin: baseURL }),
        body: { provider, callbackURL: `${baseURL}/#connectors`, errorCallbackURL: `${baseURL}/?connector-error=1#connectors`, disableRedirect: true },
        asResponse: true,
      });
      const data = object(await response.json()), url = providerAuthorizationUrl(provider, data.url);
      if (!response.ok || !url) throw new Error('Could not start sign-in. Try again.');
      const target = new URL(url), state = target.searchParams.get('state');
      if (!state || target.searchParams.get('redirect_uri') !== providerRedirectUri(provider, `${baseURL}${callbackPath(provider)}`)) throw new Error('The service returned an invalid sign-in request.');
      return { state, url, cookie: [sessionCookies, cookies(response.headers)].filter(Boolean).join('; '), origin: baseURL };
    },
    async complete(provider: ConnectorProvider, input: URLSearchParams, cookie: string) {
      const runtime = auth(), baseURL = localOrigin(origin()); linkedId = undefined;
      const response = await runtime.handler(new Request(`${baseURL}${callbackPath(provider)}?${input}`, { headers: { cookie } }));
      const location = response.headers.get('location');
      if (response.status !== 302 || location !== `${baseURL}/#connectors` || !linkedId) throw new Error('Sign-in could not finish. Connect again.');
      const account = (await accounts()).find(item => item.id === linkedId && item.providerId === provider);
      if (!account) throw new Error('The returned account does not match this connection.');
      return { id: account.id, accountId: account.accountId };
    },
    async token(accountId: string) {
      const result = await auth().api.getAccessToken({ body: { accountId, userId: ownerId } });
      if (!result.accessToken || result.accessTokenExpiresAt && new Date(result.accessTokenExpiresAt).getTime() <= Date.now()) throw new ConnectorAuthError('Authorization expired. Sign in again.', true);
      return result.accessToken;
    },
    async account(id: string) { return (await accounts()).find(account => account.id === id); },
    async remove(provider: ConnectorProvider) {
      const context = await auth().$context;
      for (const account of await context.internalAdapter.findAccounts(ownerId)) if (account.providerId === provider) await context.internalAdapter.deleteAccount(account.id);
    },
    async cancel(state: string) { await (await auth().$context).internalAdapter.deleteVerificationByIdentifier(`auth-state:${state}`); },
    close() { database.close(); },
  };
}
