import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPOSIO_GMAIL_DEFAULT_SCOPES, createComposioAdapter, type ComposioFetch } from './adapter.ts';

const API_KEY = 'fixture-project-api-key';
const AUTH_ID = 'linear-auth-config';
const SCOPES = ['read'] as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown; redirect?: RequestRedirect }> = [];
  const transport: ComposioFetch = async (input, init = {}) => {
    const url = String(input);
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body) as unknown;
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body, redirect: init.redirect });
    if (url.includes('/auth_configs/')) return json({
      id: AUTH_ID, status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: 'linear' },
      credentials: { scopes: [...SCOPES], user_scopes: [] }, restrict_to_following_tools: [],
      tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['LINEAR_GET_CURRENT_USER'] },
      ...((overrides.authConfig as Record<string, unknown> | undefined) ?? {}),
    });
    if (url.includes('/tools/LINEAR_GET_CURRENT_USER?')) return json({
      slug: 'LINEAR_GET_CURRENT_USER', toolkit: { slug: 'linear' }, input_parameters: { type: 'object', title: 'GetCurrentUserRequest', properties: {}, description: 'No parameters needed.' },
      ...((overrides.tool as Record<string, unknown> | undefined) ?? {}),
    });
    if (url.endsWith('/connected_accounts/link')) return json({
      connected_account_id: 'ca_fixture123', redirect_url: 'https://connect.composio.dev/session/opaque',
      expires_at: '2030-01-01T00:00:00Z', link_token: 'never-return-this',
    });
    if (url.endsWith('/connected_accounts/ca_fixture123')) return json({
      id: 'ca_fixture123', user_id: 'principal-a', toolkit: { slug: 'linear' },
      auth_config: { id: AUTH_ID, auth_scheme: 'OAUTH2', is_disabled: false },
      status: 'ACTIVE', is_disabled: false, experimental: { account_type: 'PRIVATE' },
      state: { secret: 'must-not-escape' }, params: { token: 'must-not-escape' },
      ...((overrides.connection as Record<string, unknown> | undefined) ?? {}),
    }, typeof overrides.connectionStatus === 'number' ? overrides.connectionStatus : 200);
    if (url.includes('/connected_accounts/ca_fixture123?revoke_on_delete=true')) return json(
      (overrides.deleteResponse as unknown) ?? { success: true, revoke_job_id: 'revoke_fixture' },
      typeof overrides.deleteStatus === 'number' ? overrides.deleteStatus : 200,
    );
    if (url.endsWith('/tools/execute/LINEAR_GET_CURRENT_USER')) return json({
      successful: true, data: { viewer: { id: 'lin-user-1', name: 'Example User', email: 'user@example.test', accessToken: 'must-not-escape' } }, error: null,
      ...((overrides.execution as Record<string, unknown> | undefined) ?? {}),
    });
    return json({ error: 'unexpected request' }, 404);
  };
  const adapter = createComposioAdapter({ apiKey: API_KEY, authConfigId: AUTH_ID, expectedScopes: SCOPES, transport });
  return { adapter, calls };
}

function providerFixture(provider: 'slack' | 'jira', authOverrides: Record<string, unknown> = {}, execution: unknown = {}) {
  const authId = `${provider}-auth-config`;
  const scopes = provider === 'jira' ? ['read:jira-user', 'offline_access'] : ['users:read'];
  const userScopes = provider === 'slack' ? ['users:read'] : [];
  const slug = provider === 'slack' ? 'SLACK_WHO_AM_I' : 'JIRA_GET_CURRENT_USER';
  const version = provider === 'slack' ? '20261008_00' : '20261001_00';
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const transport: ComposioFetch = async (input, init = {}) => {
    const url = String(input);
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body) as unknown;
    calls.push({ url, method: init.method ?? 'GET', body });
    if (url.includes('/auth_configs/')) return json({
      id: authId, status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: provider },
      credentials: { scopes, user_scopes: userScopes }, restrict_to_following_tools: [],
      tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: [slug] },
      ...authOverrides,
    });
    if (url.includes(`/tools/${slug}?`)) return json({
      slug, toolkit: { slug: provider }, input_parameters: {
        type: 'object', properties: provider === 'jira' ? { expand: { type: 'string' } } : {}, required: [],
      },
    });
    if (url.endsWith(`/tools/execute/${slug}`)) return json({ successful: true, data: execution, error: null });
    if (url.endsWith('/connected_accounts/link')) return json({ connected_account_id: 'ca_fixture123', redirect_url: 'https://connect.composio.dev/session/opaque' });
    return json({ error: 'unexpected request' }, 404);
  };
  const adapter = createComposioAdapter({ apiKey: API_KEY, authConfigId: authId, provider,
    expectedScopes: scopes, ...(provider === 'slack' ? { expectedUserScopes: userScopes } : {}), transport });
  return { adapter, calls, slug, version, authId };
}

test('start verifies the narrow setup and sends only the authenticated user and auth config', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.start('principal-a'), {
    id: 'ca_fixture123', redirectUrl: 'https://connect.composio.dev/session/opaque',
  });
  const link = f.calls.find(call => call.url.endsWith('/connected_accounts/link'))!;
  assert.equal(link.method, 'POST');
  assert.deepEqual(link.body, { auth_config_id: AUTH_ID, user_id: 'principal-a' });
  assert.equal(link.headers.get('x-api-key'), API_KEY);
  assert.equal(link.redirect, 'error');
  assert.ok(f.calls.some(call => call.url.includes('/auth_configs/')));
  assert.ok(f.calls.some(call => call.url.endsWith('/tools/LINEAR_GET_CURRENT_USER?version=20260924_00')));
  assert.doesNotMatch(JSON.stringify(await f.adapter.start('principal-a')), /link_token/u);
});

test('accepts the documented comma-separated scopes encoding as well as the observed API array', async () => {
  const f = fixture({ authConfig: { credentials: { scopes: 'read', user_scopes: [] } } });
  assert.equal((await f.adapter.start('principal-a')).id, 'ca_fixture123');
});

test('setup rejects auth configs or tool metadata outside the configured read-only scope', async t => {
  for (const [name, overrides] of [
    ['wrong toolkit', { authConfig: { toolkit: { slug: 'github' } } }],
    ['wrong auth scheme', { authConfig: { auth_scheme: 'API_KEY' } }],
    ['disabled config', { authConfig: { status: 'DISABLED' } }],
    ['wide scopes', { authConfig: { credentials: { scopes: ['read', 'write'], user_scopes: [] } } }],
    ['extra user scopes', { authConfig: { credentials: { scopes: [...SCOPES], user_scopes: ['write'] } } }],
    ['legacy allowlist conflict', { authConfig: { restrict_to_following_tools: ['LINEAR_CREATE_LINEAR_ISSUE'] } }],
    ['wide modern execution access', { authConfig: { tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['LINEAR_GET_CURRENT_USER', 'LINEAR_CREATE_LINEAR_ISSUE'] } } }],
    ['account creation tools enabled', { authConfig: { tool_access_config: { tools_for_connected_account_creation: ['LINEAR_GET_CURRENT_USER'], tools_available_for_execution: ['LINEAR_GET_CURRENT_USER'] } } }],
    ['unknown access config field', { authConfig: { tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['LINEAR_GET_CURRENT_USER'], tools_for_anything_else: ['LINEAR_CREATE_LINEAR_ISSUE'] } } }],
    ['tool requires arguments', { tool: { input_parameters: { type: 'object', properties: { issue_id: { type: 'string' } }, required: ['issue_id'] } } }],
    ['wrong tool toolkit', { tool: { toolkit: { slug: 'github' } } }],
  ] as Array<[string, Record<string, unknown>]>) {
    await t.test(name, async () => {
      const f = fixture(overrides);
      await assert.rejects(f.adapter.start('principal-a'), /not verified/u);
      assert.equal(f.calls.some(call => call.url.endsWith('/connected_accounts/link')), false);
    });
  }
});

test('inspect returns only ownership and account metadata and requires an explicitly private enabled account', async t => {
  const f = fixture();
  assert.deepEqual(await f.adapter.inspect('ca_fixture123'), {
    userId: 'principal-a', toolkit: 'linear', authConfigId: AUTH_ID, status: 'ACTIVE',
  });
  assert.doesNotMatch(JSON.stringify(await f.adapter.inspect('ca_fixture123')), /secret|token/u);

  for (const change of [
    { experimental: { account_type: 'SHARED' } },
    { experimental: {} },
    { experimental: { account_type: 'FUTURE' } },
    { experimental: undefined },
    { is_disabled: true },
    { auth_config: { id: AUTH_ID, is_disabled: true } },
  ]) await t.test(JSON.stringify(change), async () => {
    const changed = fixture({ connection: change });
    await assert.rejects(changed.adapter.inspect('ca_fixture123'), /Composio request failed/u);
  });
});

test('remove verifies the owner and private Linear mapping before revoking and deleting', async () => {
  const f = fixture();
  assert.equal(await f.adapter.remove('ca_fixture123', 'principal-a'), 'removed');
  const deletion = f.calls.find(call => call.method === 'DELETE')!;
  assert.equal(deletion.url, 'https://backend.composio.dev/api/v3.1/connected_accounts/ca_fixture123?revoke_on_delete=true');
  assert.equal(deletion.headers.get('x-api-key'), API_KEY);
  assert.equal(deletion.redirect, 'error');

  const wrongOwner = fixture();
  await assert.rejects(wrongOwner.adapter.remove('ca_fixture123', 'principal-b'), /Composio request failed/u);
  assert.equal(wrongOwner.calls.some(call => call.method === 'DELETE'), false);
});

test('terminal-only removal rechecks status immediately before delete', async () => {
  // The default fixture account is ACTIVE; the terminal-only guard must refuse it.
  const activeAccount = fixture();
  await assert.rejects(activeAccount.adapter.remove('ca_fixture123', 'principal-a', ['EXPIRED']), /Composio request failed/u);
  assert.equal(activeAccount.calls.some(call => call.method === 'DELETE'), false);

  const expired = fixture({ connection: { status: 'EXPIRED' } });
  assert.equal(await expired.adapter.remove('ca_fixture123', 'principal-a', ['EXPIRED', 'FAILED']), 'removed');
  assert.equal(expired.calls.some(call => call.method === 'DELETE'), true);
});

test('remove treats documented 404 as already removed and retains failure on uncertain replies', async () => {
  const missing = fixture({ deleteStatus: 404 });
  assert.equal(await missing.adapter.remove('ca_fixture123', 'principal-a'), 'not-found');

  const alreadyMissing = fixture({ connectionStatus: 404 });
  assert.equal(await alreadyMissing.adapter.remove('ca_fixture123', 'principal-a'), 'not-found');
  assert.equal(alreadyMissing.calls.some(call => call.method === 'DELETE'), false);

  const uncertain = fixture({ deleteResponse: { success: false } });
  await assert.rejects(uncertain.adapter.remove('ca_fixture123', 'principal-a'), /Composio request failed/u);
});

test('executes only the pinned current-user read and returns only the viewer profile fields', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), {
    id: 'lin-user-1', name: 'Example User', email: 'user@example.test',
  });
  const execution = f.calls.find(call => call.url.endsWith('/tools/execute/LINEAR_GET_CURRENT_USER'))!;
  assert.equal(execution.method, 'POST');
  assert.deepEqual(execution.body, {
    connected_account_id: 'ca_fixture123', user_id: 'principal-a', version: '20260924_00', arguments: {},
  });
  assert.doesNotMatch(JSON.stringify(await f.adapter.profile('ca_fixture123', 'principal-a')), /accessToken/u);
});

test('accepts the current-user tool user envelope observed after real Linear consent', async () => {
  const f = fixture({ execution: {
    successful: true,
    data: { user: { id: 'lin-user-3', name: 'Example User', email: 'user@example.test', admin: true, avatarUrl: 'https://example.test/avatar' } },
    error: null,
  } });
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), {
    id: 'lin-user-3', name: 'Example User', email: 'user@example.test',
  });
});

test('rejects unsuccessful and malformed execution results without exposing provider errors', async t => {
  for (const execution of [
    { successful: false, data: { viewer: { id: 'lin-user-1', name: 'Example User', email: 'x@y.test' } }, error: 'private token' },
    { successful: true, data: { viewer: { id: 'lin-user-1', name: 'Example User' } }, error: null },
    { successful: true, data: { viewer: { id: 'lin-user-1', name: 'Example\nUser', email: 'x@y.test' } }, error: null },
    { successful: true, data: { viewer: { id: 'lin-user-1', name: 'Example User', email: 'x@y.test' }, data: { viewer: { id: 'another', name: 'Ambiguous', email: 'x@y.test' } } }, error: null },
    { successful: true, data: { user: { id: 'lin-user-1', name: 'Example User', email: 'x@y.test' }, viewer: { id: 'another', name: 'Ambiguous', email: 'x@y.test' } }, error: null },
    { successful: true, data: { id: 'lin-user-1', name: 'Unsupported', email: 'x@y.test' }, error: null },
    { successful: true, data: 'not-json', error: null },
  ]) await t.test(JSON.stringify(execution), async () => {
    const f = fixture({ execution });
    await assert.rejects(f.adapter.profile('ca_fixture123', 'principal-a'), /Composio request failed/u);
  });
});

test('accepts the documented nested GraphQL viewer when execution data is a JSON string', async () => {
  const f = fixture({ execution: {
    successful: true,
    data: JSON.stringify({ data: { viewer: { id: 'lin-user-2', name: 'Nested User', email: 'nested@example.test', token: 'private' } } }),
    error: null,
  } });
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), {
    id: 'lin-user-2', name: 'Nested User', email: 'nested@example.test',
  });
  assert.doesNotMatch(JSON.stringify(await f.adapter.profile('ca_fixture123', 'principal-a')), /private/u);
});

test('rejects unsafe redirects, oversized bodies, non-JSON and arbitrary IDs', async () => {
  const transport: ComposioFetch = async input => {
    const url = String(input);
    if (url.includes('/auth_configs/')) return json({ id: AUTH_ID, status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: 'linear' }, credentials: { scopes: [...SCOPES], user_scopes: [] }, restrict_to_following_tools: [], tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['LINEAR_GET_CURRENT_USER'] } });
    if (url.includes('/tools/LINEAR_GET_CURRENT_USER?')) return json({ slug: 'LINEAR_GET_CURRENT_USER', toolkit: { slug: 'linear' }, input_parameters: { type: 'object', properties: {}, required: [] } });
    if (url.endsWith('/connected_accounts/link')) return json({ connected_account_id: 'ca_fixture123', redirect_url: 'https://attacker.example/steal' });
    return json({});
  };
  const unsafe = createComposioAdapter({ apiKey: API_KEY, authConfigId: AUTH_ID, expectedScopes: SCOPES, transport });
  await assert.rejects(unsafe.start('principal-a'), /Composio request failed/u);

  const invalidId = fixture();
  await assert.rejects(invalidId.adapter.inspect('https://attacker.example'), /Composio request failed/u);

  const tooLarge: ComposioFetch = async () => new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
  const largeAdapter = createComposioAdapter({ apiKey: API_KEY, authConfigId: AUTH_ID, expectedScopes: SCOPES, transport: tooLarge });
  await assert.rejects(largeAdapter.inspect('ca_fixture123'), /Composio request failed/u);
  const nonJson = createComposioAdapter({ apiKey: API_KEY, authConfigId: AUTH_ID, expectedScopes: SCOPES, transport: async () => new Response('private token') });
  await assert.rejects(nonJson.inspect('ca_fixture123'), /Composio request failed/u);
});

test('pins Gmail setup and executes only the configured profile tool', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const transport: ComposioFetch = async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body });
    if (url.includes('/auth_configs/')) return json({
      id: 'gmail-auth-config', status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: 'gmail' },
      credentials: { scopes: [...COMPOSIO_GMAIL_DEFAULT_SCOPES], user_scopes: [] },
      tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['GMAIL_GET_PROFILE'] },
      restrict_to_following_tools: [],
    });
    if (url.includes('/tools/GMAIL_GET_PROFILE?')) return json({
      slug: 'GMAIL_GET_PROFILE', toolkit: { slug: 'gmail' }, input_parameters: { type: 'object', properties: { user_id: { type: 'string', default: 'me' } } },
    });
    if (url.endsWith('/tools/execute/GMAIL_GET_PROFILE')) return json({
      successful: true, error: null, data: { emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1', display_url: 'https://mail.google.com/' },
    });
    return json({});
  };
  const adapter = createComposioAdapter({
    apiKey: API_KEY, authConfigId: 'gmail-auth-config', provider: 'gmail',
    expectedScopes: COMPOSIO_GMAIL_DEFAULT_SCOPES, transport,
    profileTool: {
      slug: 'GMAIL_GET_PROFILE', version: '20260915_00', inputProperties: ['user_id'], requiredProperties: [], arguments: { user_id: 'me' },
      parse(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const data = value as Record<string, unknown>;
        if (typeof data.emailAddress !== 'string' || typeof data.historyId !== 'string' || !Number.isSafeInteger(data.messagesTotal) || !Number.isSafeInteger(data.threadsTotal)) return undefined;
        return { emailAddress: data.emailAddress, historyId: data.historyId, messagesTotal: data.messagesTotal as number, threadsTotal: data.threadsTotal as number };
      },
    },
  });
  await adapter.inspectSetup();
  assert.deepEqual(await adapter.profile('ca_fixture123', 'principal-a'), {
    emailAddress: 'user@example.test', messagesTotal: 12, threadsTotal: 8, historyId: 'history-1',
  });
  assert.ok(calls.some(call => call.url.endsWith('/tools/GMAIL_GET_PROFILE?version=20260915_00')));
  assert.deepEqual(calls.find(call => call.url.endsWith('/tools/execute/GMAIL_GET_PROFILE'))?.body, {
    connected_account_id: 'ca_fixture123', user_id: 'principal-a', version: '20260915_00', arguments: { user_id: 'me' },
  });
  assert.equal(calls.some(call => call.url.includes('/messages')), false);
});

test('pins Slack user identity to WHO_AM_I, exact bot and user scopes, and no tool arguments', async () => {
  const f = providerFixture('slack', {}, { display_name: 'Example Member', data: { user_id: 'U123', team_id: 'T456', user: 'member', team: 'workspace' } });
  assert.deepEqual(await f.adapter.start('principal-a'), { id: 'ca_fixture123', redirectUrl: 'https://connect.composio.dev/session/opaque' });
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), { id: 'T456:U123', label: 'Example Member' });
  assert.ok(f.calls.some(call => call.url.endsWith(`/tools/${f.slug}?version=${f.version}`)));
  assert.deepEqual(f.calls.find(call => call.url.endsWith(`/tools/execute/${f.slug}`))?.body, {
    connected_account_id: 'ca_fixture123', user_id: 'principal-a', version: f.version, arguments: {},
  });
  assert.doesNotMatch(JSON.stringify(await f.adapter.profile('ca_fixture123', 'principal-a')), /email|token|team_name/u);
});

test('normalizes Slack identity from stable IDs when optional names are absent', async () => {
  const f = providerFixture('slack', {}, { data: { user_id: 'U123', team_id: 'T456' } });
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), { id: 'T456:U123', label: 'T456:U123' });
});

test('rejects Slack scope drift in either exact scope list', async t => {
  for (const [name, authOverrides] of [
    ['bot scope', { credentials: { scopes: ['users:read', 'chat:write'], user_scopes: ['users:read'] } }],
    ['user scope', { credentials: { scopes: ['users:read'], user_scopes: ['users:read', 'users:write'] } }],
    ['missing user scope evidence', { credentials: { scopes: [] } }],
    ['missing bot scope', { credentials: { scopes: [], user_scopes: ['users:read'] } }],
  ] as Array<[string, Record<string, unknown>]>) await t.test(name, async () => {
    const f = providerFixture('slack', authOverrides, { data: { user_id: 'U123', team_id: 'T456' } });
    await assert.rejects(f.adapter.start('principal-a'), /not verified/u);
    assert.equal(f.calls.some(call => call.url.endsWith('/connected_accounts/link')), false);
  });
});

test('Slack requires both explicit scope policies at adapter construction', () => {
  assert.throws(() => createComposioAdapter({ apiKey: API_KEY, authConfigId: 'slack-auth-config', provider: 'slack', expectedUserScopes: ['users:read'], transport: async () => json({}) }), /Invalid Composio adapter configuration/u);
  assert.throws(() => createComposioAdapter({ apiKey: API_KEY, authConfigId: 'slack-auth-config', provider: 'slack', expectedScopes: ['users:read'], transport: async () => json({}) }), /Invalid Composio adapter configuration/u);
});

test('rejects Slack identities whose combined ID is too long and bounds composed labels', async () => {
  const longTeamId = 'T'.repeat(256), f = providerFixture('slack', {}, { data: { user_id: 'U123', team_id: longTeamId } });
  await assert.rejects(f.adapter.profile('ca_fixture123', 'principal-a'), /Composio request failed/u);

  const longNames = providerFixture('slack', {}, { data: { user_id: 'U123', team_id: 'T456', user: 'u'.repeat(250), team: 't'.repeat(250) } });
  assert.deepEqual(await longNames.adapter.profile('ca_fixture123', 'principal-a'), { id: 'T456:U123', label: 'T456:U123' });
});

test('pins Jira profile verification to active current-user identity and uses display name without an email', async () => {
  const f = providerFixture('jira', {}, { accountId: 'jira-user-123', displayName: 'Example User', active: true, emailAddress: null });
  assert.deepEqual(await f.adapter.start('principal-a'), { id: 'ca_fixture123', redirectUrl: 'https://connect.composio.dev/session/opaque' });
  assert.deepEqual(await f.adapter.profile('ca_fixture123', 'principal-a'), { id: 'jira-user-123', label: 'Example User' });
  assert.ok(f.calls.some(call => call.url.endsWith(`/tools/${f.slug}?version=${f.version}`)));
  assert.deepEqual(f.calls.find(call => call.url.endsWith(`/tools/execute/${f.slug}`))?.body, {
    connected_account_id: 'ca_fixture123', user_id: 'principal-a', version: f.version, arguments: {},
  });
});

test('rejects inactive or unidentifiable Jira profiles and never manufactures email', async t => {
  for (const execution of [
    { accountId: 'jira-user-123', displayName: 'Example User', active: false },
    { accountId: 'jira-user-123', active: true },
    { accountId: 'bad\nid', displayName: 'Example User', active: true },
  ]) await t.test(JSON.stringify(execution), async () => {
    const f = providerFixture('jira', {}, execution);
    await assert.rejects(f.adapter.profile('ca_fixture123', 'principal-a'), /Composio request failed/u);
  });
});

test('rejects Gmail scope expansion and tool allowlist expansion independently', async t => {
  for (const scenario of [
    {
      name: 'extra scope',
      scopes: [...COMPOSIO_GMAIL_DEFAULT_SCOPES, 'https://www.googleapis.com/auth/gmail.modify'],
      tools: ['GMAIL_GET_PROFILE'],
    },
    {
      name: 'extra execution tool',
      scopes: [...COMPOSIO_GMAIL_DEFAULT_SCOPES],
      tools: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_MESSAGES'],
    },
  ]) await t.test(scenario.name, async () => {
    const transport: ComposioFetch = async input => {
      if (String(input).includes('/auth_configs/')) return json({
        id: 'gmail-auth-config', status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: 'gmail' },
        credentials: { scopes: scenario.scopes, user_scopes: [] },
        tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: scenario.tools },
        restrict_to_following_tools: [],
      });
      return json({ slug: 'GMAIL_GET_PROFILE', toolkit: { slug: 'gmail' }, input_parameters: { type: 'object', properties: { user_id: { type: 'string', default: 'me' } } } });
    };
    const adapter = createComposioAdapter({
      apiKey: API_KEY, authConfigId: 'gmail-auth-config', provider: 'gmail',
      expectedScopes: COMPOSIO_GMAIL_DEFAULT_SCOPES, transport,
      profileTool: { slug: 'GMAIL_GET_PROFILE', version: '20260915_00', inputProperties: ['user_id'], requiredProperties: [], arguments: { user_id: 'me' }, parse: () => undefined },
    });
    await assert.rejects(adapter.inspectSetup(), /not verified/u);
  });
});

test('rejects a custom Gmail scope set even when it looks narrower', async () => {
  const transport: ComposioFetch = async input => {
    if (String(input).includes('/auth_configs/')) return json({
      id: 'gmail-auth-config', status: 'ENABLED', auth_scheme: 'OAUTH2', toolkit: { slug: 'gmail' },
      credentials: { scopes: ['https://www.googleapis.com/auth/gmail.readonly'], user_scopes: [] },
      tool_access_config: { tools_for_connected_account_creation: [], tools_available_for_execution: ['GMAIL_GET_PROFILE'] },
      restrict_to_following_tools: [],
    });
    return json({ slug: 'GMAIL_GET_PROFILE', toolkit: { slug: 'gmail' }, input_parameters: { type: 'object', properties: { user_id: { type: 'string', default: 'me' } } } });
  };
  const adapter = createComposioAdapter({
    apiKey: API_KEY, authConfigId: 'gmail-auth-config', provider: 'gmail',
    expectedScopes: COMPOSIO_GMAIL_DEFAULT_SCOPES, transport,
    profileTool: { slug: 'GMAIL_GET_PROFILE', version: '20260915_00', inputProperties: ['user_id'], requiredProperties: [], arguments: { user_id: 'me' }, parse: () => undefined },
  });
  await assert.rejects(adapter.inspectSetup(), /not verified/u);
});
