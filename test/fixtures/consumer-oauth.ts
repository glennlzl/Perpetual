import assert from 'node:assert/strict';

// Schema, list and add envelopes were observed on the authenticated consumer MCP endpoint.
// Account identities and credentials are neutral fixtures, not real account evidence.
export function consumerFixture() {
  const calls: { path: string; operation?: string; args?: Record<string, unknown> }[] = [];
  const accounts: Record<string, unknown>[] = []; let failRead = false, expired = false, lostAdd = false, supportsList = true;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) { calls.push({ path: url.pathname }); return json({ resource: 'https://connect.composio.dev/mcp', authorization_servers: ['https://connect.composio.dev'] }); }
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: 'https://connect.composio.dev', authorization_endpoint: 'https://connect.composio.dev/oauth/authorize', token_endpoint: 'https://login.composio.dev/oauth2/token', registration_endpoint: 'https://login.composio.dev/oauth2/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/oauth2/register') { calls.push({ path: url.pathname }); return json({ ...JSON.parse(String(init?.body)), client_id: 'client_fixture' }); }
    if (url.pathname === '/oauth2/token') { calls.push({ path: url.pathname }); return json({ access_token: 'private_fixture_bearer', token_type: 'Bearer', expires_in: 3600 }); }
    assert.equal(url.pathname, '/mcp'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private_fixture_bearer');
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 });
    if (expired) return json({}, 401);
    const request = JSON.parse(String(init?.body)); const operation = request.method;
    calls.push({ path: url.pathname, operation, ...(request.params?.arguments ? { args: request.params.arguments } : {}) });
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (operation === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (operation === 'tools/list') result = { tools: [{ name: 'COMPOSIO_MANAGE_CONNECTIONS', inputSchema: { type: 'object', properties: { toolkits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, action: { type: 'string', enum: supportsList ? ['add', 'rename', 'list', 'remove'] : ['add'], default: 'add' }, alias: { type: 'string' }, account_id: { type: 'string' } }, required: ['name'], additionalProperties: false } }, session_id: { type: 'string' } }, required: ['toolkits'], additionalProperties: false } }] };
    else if (operation === 'tools/call') {
      assert.equal(request.params.name, 'COMPOSIO_MANAGE_CONNECTIONS');
      const args = request.params.arguments;
      assert.equal(args.toolkits.length, 1); const { name: provider, action } = args.toolkits[0];
      if (action === 'list') { if (failRead) throw new Error('untrusted SDK message: private_fixture_bearer'); result = { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: { [provider]: { toolkit: provider, status: 'initiated', accounts: accounts.filter(a => a.toolkit === provider).map(({ toolkit, ...a }) => ({ ...a, status: String(a.status).toLowerCase(), is_default: false, account_type: 'PRIVATE' })) } } } }) }] }; }
      else { assert.equal(action, 'add'); const account = { id: `ca_${provider}_${accounts.length + 1}`, toolkit: provider, status: 'INITIALIZING', alias: 'Work' }; accounts.push(account); if (lostAdd) throw new Error('Uncertain write private_fixture_bearer'); result = { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: { [provider]: { toolkit: provider, status: 'initiated', redirect_url: 'https://connect.composio.dev/link/ln_fixture', accounts: [{ id: account.id, status: 'initializing', is_default: false, account_type: 'PRIVATE' }] } } } }) }] }; }
    } else assert.fail(`Unexpected MCP method ${operation}`);
    return json({ jsonrpc: '2.0', id: request.id, result });
  };
  return { transport, calls, accounts, set flags(v: { failRead?: boolean; expired?: boolean; lostAdd?: boolean; supportsList?: boolean }) { ({ failRead = failRead, expired = expired, lostAdd = lostAdd, supportsList = supportsList } = v); } };
}
