import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APPS, DIRECT_APPS, ConnectorAuthError, createConnectorProviders, providerAuthorizationUrl, providerOf, providerRedirectUri } from '../src/connectors/providers.ts';
import type { ConnectorProvider } from '../contract/connectors.ts';

// Protocol fixtures exercise the provider adapters; they do not claim a real external account was authorized.
const env = { PERPETUAL_SLACK_CLIENT_ID: 'slack-app', PERPETUAL_LINEAR_CLIENT_ID: 'linear-app', PERPETUAL_JIRA_CLIENT_ID: 'jira-app', PERPETUAL_JIRA_CLIENT_SECRET: 'jira-secret' };
const redirectURI = 'http://127.0.0.1:4317/connectors/auth/callback/example';
const codeVerifier = 'proof-for-a-local-oauth-request-that-is-long-enough';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const authorize = { state: 'test-state', codeVerifier, redirectURI };
const grant = { code: 'test-code', codeVerifier, redirectURI };
const failure = (needsAuth: boolean, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof ConnectorAuthError);
  assert.equal(error.needsAuth, needsAuth);
  if (message) assert.match(error.message, message);
  assert.doesNotMatch(error.message, /private-provider-detail/);
  return true;
};
async function harness(transport: typeof fetch = async () => { throw new Error('Unexpected provider request.'); }, environment: Record<string, string | undefined> = env) {
  const adapters = createConnectorProviders({ env: environment, transport });
  const auth = betterAuth({ baseURL: 'http://127.0.0.1:4317', secret: 'unit-test-only-better-auth-secret-value', telemetry: { enabled: false }, logger: { disabled: true }, plugins: [adapters.plugin] });
  const { socialProviders } = await auth.$context;
  return { ...adapters, provider: (id: ConnectorProvider) => { const provider = socialProviders.find(item => item.id === id); assert.ok(provider); return provider; } };
}

test('provider configuration validates local app registrations and does not expose credentials', () => {
  const empty = createConnectorProviders({ env: {} });
  for (const { provider } of APPS) assert.equal(empty.configuration(provider).configured, false);
  assert.match(empty.configuration('linear').setupError!, /PERPETUAL_LINEAR_CLIENT_ID/);
  assert.match(empty.configuration('gmail').setupError!, /connector broker/);
  const configured = createConnectorProviders({ env: { ...env, PERPETUAL_LINEAR_CLIENT_SECRET: '' } });
  for (const { provider } of DIRECT_APPS) assert.deepEqual(configured.configuration(provider), { configured: true });
  const googleCredentials = createConnectorProviders({ env: { PERPETUAL_GOOGLE_CLIENT_ID: 'ignored-app', PERPETUAL_GOOGLE_CLIENT_SECRET: 'ignored-secret' } });
  assert.deepEqual(googleCredentials.configuration('gmail'), { configured: false, setupError: 'Gmail authorization is managed by the connector broker.' });
  const missingJiraSecret = createConnectorProviders({ env: { ...env, PERPETUAL_JIRA_CLIENT_SECRET: '' } });
  assert.match(missingJiraSecret.configuration('jira').setupError!, /PERPETUAL_JIRA_CLIENT_SECRET/);
  const invalid = createConnectorProviders({ env: { ...env, PERPETUAL_LINEAR_CLIENT_ID: 'bad\ncredential' } });
  assert.equal(invalid.configuration('linear').configured, false);
  assert.throws(() => providerOf('other'), /available app/);
});

test('direct authorization URLs preserve Better Auth state, PKCE and provider-specific scope semantics', async () => {
  const adapters = await harness();
  assert.ok(APPS.some(app => app.provider === 'gmail'), 'Gmail remains available to the UI.');
  assert.deepEqual(DIRECT_APPS.map(app => app.provider), ['slack', 'linear', 'jira']);
  for (const { provider } of DIRECT_APPS) {
    const url = await adapters.provider(provider).createAuthorizationURL(authorize);
    assert.equal(url.searchParams.get('state'), authorize.state);
    assert.equal(url.searchParams.get('redirect_uri'), provider === 'slack' ? 'http://localhost:4317/connectors/auth/callback/example' : redirectURI);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(providerAuthorizationUrl(provider, url.href), url.href);
    if (provider === 'jira') {
      assert.equal(url.searchParams.has('code_challenge'), false);
      assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
      assert.ok(url.searchParams.get('scope')!.split(' ').includes('offline_access'));
    } else {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(codeVerifier).digest('base64url'));
    }
    if (provider === 'slack') {
      assert.equal(url.searchParams.get('scope'), '', 'Never inherit configured bot scopes for the public client.');
      assert.equal(url.searchParams.get('user_scope'), 'users:read,users:read.email');
    }
  }
  assert.equal(providerAuthorizationUrl('gmail', 'https://accounts.google.com/o/oauth2/v2/auth'), undefined);
  assert.equal(providerAuthorizationUrl('linear', 'https://linear.app.example.test/oauth/authorize'), undefined);
  assert.equal(providerAuthorizationUrl('linear', 'https://user:pass@linear.app/oauth/authorize'), undefined);
  assert.equal(providerAuthorizationUrl('linear', 'https://linear.app/oauth/authorize#fragment'), undefined);
  assert.equal(providerAuthorizationUrl('linear', 'https://linear.app/other'), undefined);
  assert.equal(providerRedirectUri('slack', redirectURI), 'http://localhost:4317/connectors/auth/callback/example');
  assert.equal(providerRedirectUri('slack', 'https://127.0.0.1:4317/callback'), 'https://127.0.0.1:4317/callback');
});

test('Gmail has no direct Better Auth provider or Google account verification traffic', async () => {
  let requests = 0;
  const adapters = await harness(async () => { requests++; throw new Error('Unexpected direct Gmail request.'); }, { ...env, PERPETUAL_GOOGLE_CLIENT_ID: 'ignored-app', PERPETUAL_GOOGLE_CLIENT_SECRET: 'ignored-secret' });
  assert.throws(() => adapters.provider('gmail'));
  await assert.rejects(adapters.verifyAccount('gmail', 'provider-access'), /connector broker/);
  assert.equal(requests, 0);
});

test('Slack extracts the initial nested user grant and rotating top-level user grant', async () => {
  const calls: URLSearchParams[] = [];
  const adapters = await harness(async (input, options) => {
    assert.equal(String(input), 'https://slack.com/api/oauth.v2.access');
    assert.equal(new Headers(options?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(options?.body)); calls.push(body);
    assert.equal(body.has('client_secret'), false);
    if (body.get('grant_type') === 'authorization_code') {
      assert.equal(body.get('code_verifier'), codeVerifier);
      assert.equal(body.get('redirect_uri'), 'http://localhost:4317/connectors/auth/callback/example');
      return json({ ok: true, access_token: 'bot-should-never-be-used', token_type: 'bot', authed_user: { id: 'U1', token_type: 'user', access_token: 'user-access', refresh_token: 'user-refresh', expires_in: 43200, scope: 'users:read,users:read.email' } });
    }
    assert.equal(body.get('refresh_token'), 'user-refresh');
    assert.equal(body.has('code_verifier'), false);
    return json({ ok: true, token_type: 'user', access_token: 'new-user-access', refresh_token: 'new-user-refresh', expires_in: 43200, scope: 'users:read,users:read.email' });
  }, { ...env, PERPETUAL_SLACK_CLIENT_SECRET: 'ignored-for-public-pkce' });
  const provider = adapters.provider('slack');
  const initial = await provider.validateAuthorizationCode(grant);
  assert.ok(initial);
  assert.equal(initial?.accessToken, 'user-access');
  assert.equal(initial.refreshToken, 'user-refresh');
  assert.deepEqual(initial.scopes, ['users:read', 'users:read.email']);
  assert.ok(initial.accessTokenExpiresAt!.getTime() > Date.now());
  const refreshed = await provider.refreshAccessToken!('user-refresh');
  assert.equal(refreshed.accessToken, 'new-user-access');
  assert.equal(refreshed.refreshToken, 'new-user-refresh');
  assert.equal(calls.length, 2);
});

test('Slack refuses bot and malformed token responses instead of treating them as user connections', async t => {
  for (const response of [{ token_type: 'bot', access_token: 'bot-access' }, { token_type: 'user', access_token: 'bad\ntoken' }, { token_type: 'user', access_token: 'access', expires_in: -1 }]) {
    await t.test(JSON.stringify(response), async () => {
      const adapters = await harness(async () => json({ ok: true, authed_user: response }));
      await assert.rejects(adapters.provider('slack').validateAuthorizationCode(grant), ConnectorAuthError);
    });
  }
});

test('Slack account identity includes the workspace and comes from the verified user', async () => {
  const urls: string[] = [];
  const adapters = await harness(async (input, options) => {
    const url = String(input); urls.push(url);
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer user-access');
    return url.endsWith('/auth.test') ? json({ ok: true, user_id: 'U1', team_id: 'T1', user: 'alice' }) : json({ ok: true, user: { id: 'U1', profile: { email: 'alice@example.test', real_name: 'Alice' } } });
  });
  const provider = adapters.provider('slack'), result = await provider.getUserInfo({ accessToken: 'user-access' });
  assert.ok(result);
  assert.equal(await provider.accountSubject({ tokens: {}, profile: result.data }), 'T1:U1');
  assert.equal('id' in result.user, false, 'Better Auth 1.7 derives identity from accountSubject, not user.id.');
  assert.equal(result.user.name, 'Alice');
  assert.equal(result.user.email, 'alice@example.test');
  assert.deepEqual(urls, ['https://slack.com/api/auth.test', 'https://slack.com/api/users.info?user=U1']);
});

test('Linear public PKCE exchanges and rotates without a client secret', async () => {
  const adapters = await harness(async (input, options) => {
    assert.equal(String(input), 'https://api.linear.app/oauth/token');
    const body = new URLSearchParams(String(options?.body));
    assert.equal(body.get('client_id'), 'linear-app');
    assert.equal(body.has('client_secret'), false);
    assert.equal(new Headers(options?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    if (body.get('grant_type') === 'authorization_code') assert.equal(body.get('code_verifier'), codeVerifier);
    else assert.equal(body.get('refresh_token'), 'linear-refresh');
    return json({ access_token: 'linear-access', refresh_token: 'linear-refresh-next', expires_in: 86399, scope: ['read'] });
  });
  const provider = adapters.provider('linear');
  assert.deepEqual((await provider.validateAuthorizationCode(grant))?.scopes, ['read']);
  assert.equal((await provider.refreshAccessToken!('linear-refresh')).refreshToken, 'linear-refresh-next');
  await assert.rejects(provider.validateAuthorizationCode({ code: 'code', redirectURI }), failure(true, /expired/));
});

test('Jira sends JSON token requests with its required local app secret and uses the account profile', async () => {
  let exchanges = 0;
  const adapters = await harness(async (input, options) => {
    if (String(input) === 'https://api.atlassian.com/me') return json({ account_id: 'jira-user', account_status: 'active', email: 'alice@example.test', name: 'Alice' });
    assert.equal(String(input), 'https://auth.atlassian.com/oauth/token');
    assert.equal(new Headers(options?.headers).get('content-type'), 'application/json');
    const body: unknown = JSON.parse(String(options?.body));
    assert.deepEqual(body, exchanges++ === 0 ? { grant_type: 'authorization_code', code: 'test-code', redirect_uri: redirectURI, client_id: 'jira-app', client_secret: 'jira-secret' } : { grant_type: 'refresh_token', refresh_token: 'jira-refresh', client_id: 'jira-app', client_secret: 'jira-secret' });
    return json({ access_token: 'jira-access', refresh_token: 'jira-refresh-next', expires_in: 3600, scope: 'read:me read:jira-work' });
  });
  const provider = adapters.provider('jira');
  assert.equal((await provider.validateAuthorizationCode(grant))?.accessToken, 'jira-access');
  assert.equal((await provider.refreshAccessToken!('jira-refresh')).refreshToken, 'jira-refresh-next');
  assert.deepEqual(await adapters.verifyAccount('jira', 'jira-access'), { id: 'jira-user', label: 'Alice' });
});

test('provider authentication failures remain distinct from transient and installation failures', async t => {
  const cases: { name: string; provider: ConnectorProvider; status: number; response: unknown; needsAuth: boolean }[] = [
    { name: 'Slack expired token', provider: 'slack', status: 200, response: { ok: false, error: 'token_expired' }, needsAuth: true },
    { name: 'Linear GraphQL authentication', provider: 'linear', status: 400, response: { errors: [{ message: 'private-provider-detail', extensions: { type: 'authentication error' } }] }, needsAuth: true },
    { name: 'Linear GraphQL rate limit', provider: 'linear', status: 400, response: { errors: [{ extensions: { type: 'ratelimited' } }] }, needsAuth: false },
    { name: 'HTTP authentication', provider: 'jira', status: 401, response: {}, needsAuth: true },
    { name: 'HTTP permission', provider: 'jira', status: 403, response: {}, needsAuth: true },
    { name: 'HTTP rate limit', provider: 'jira', status: 429, response: {}, needsAuth: false },
    { name: 'HTTP unavailable', provider: 'jira', status: 503, response: { error: 'private-provider-detail' }, needsAuth: false },
    { name: 'Invalid app credentials', provider: 'linear', status: 401, response: { error: 'invalid_client' }, needsAuth: false },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const adapters = await harness(async () => json(item.response, item.status));
    await assert.rejects(adapters.verifyAccount(item.provider, 'provider-access'), failure(item.needsAuth));
  });
});

test('refresh records a current classified error and clears it after a successful rotation', async () => {
  let attempt = 0;
  const adapters = await harness(async () => ++attempt === 1 ? json({ error: 'invalid_grant', error_description: 'private-provider-detail' }, 400) : json({ access_token: 'new-access', refresh_token: 'new-refresh' }));
  await assert.rejects(adapters.provider('linear').refreshAccessToken!('old-refresh'), failure(true));
  assert.equal(adapters.refreshFailure('linear')?.needsAuth, true);
  assert.equal((await adapters.provider('linear').refreshAccessToken!('old-refresh')).accessToken, 'new-access');
  assert.equal(adapters.refreshFailure('linear'), undefined);
});

test('provider transport bounds response size, blocks redirects, and sanitizes network errors', async t => {
  for (const [name, response] of [
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://unrelated.example.test' } })],
    ['declared oversized', () => new Response('{}', { headers: { 'content-length': '262145' } })],
    ['streamed oversized', () => new Response('x'.repeat(262145))],
    ['invalid JSON', () => new Response('private-provider-detail')],
    ['invalid shape', () => json([])],
  ] as const) await t.test(name, async () => {
    const adapters = await harness(async (_input, options) => {
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      return response();
    });
    await assert.rejects(adapters.verifyAccount('linear', 'provider-access'), failure(false));
  });
  for (const error of [new Error('private-provider-detail'), new DOMException('private-provider-detail', 'TimeoutError')]) {
    const adapters = await harness(async () => { throw error; });
    await assert.rejects(adapters.verifyAccount('linear', 'provider-access'), failure(false, /Could not reach/));
  }
});
