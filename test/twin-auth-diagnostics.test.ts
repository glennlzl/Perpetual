import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import supabase from '../src/twin/services/supabase.ts';

type Context = Parameters<typeof supabase.accounts>[0];
const user = { id: 'owner', email: 'owner@example.test' };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected account capability'); };
const context = (fetch: NonNullable<Context['fetch']>, overrides: Partial<Context> = {}): Context => ({ options: { users: [user] },
  outputs: { serviceRoleKey: 'private-service-key', anonKey: '', url: '', jwtSecret: '', dbUrl: '' }, inputs: {}, host: 'host.docker.internal', project: 'perpetual-beta', dir: '/fixture/service', shared: '/fixture/shared', source: '/fixture/source',
  port: () => 43100, url: () => 'http://host.docker.internal:43100/auth/v1/token', apps: [], app: () => { throw new Error('Unexpected app lookup'); }, sharedPort: unexpected, run: unexpected, exec: unexpected, fetch, ...overrides });
const failure = async (ctx: Context) => { try { await supabase.accounts(ctx); assert.fail('The account request must fail'); } catch (error) { return (error as Error).message; } };
const diagnostic = (message: string, kind: RegExp, phase: string) => {
  assert.match(message, /account [a-f0-9]{12}/);
  assert.match(message, /POST \/auth\/v1\/admin\/users/);
  assert.match(message, /\d+ ms/);
  assert.match(message, new RegExp(`phase: ${phase}`));
  assert.match(message, kind);
  assert.match(message, /outcome unknown/);
  assert.doesNotMatch(message, /owner|example\.test|private-service-key|private-response|private-password/);
};

for (const [name, error, kind] of [
  ['deadline', new DOMException('private-response', 'TimeoutError'), /request deadline/],
  ['cancellation', new DOMException('private-response', 'AbortError'), /cancelled/],
  ['transport', new TypeError('private-response private-service-key'), /transport failure/],
] as const) test(`Auth ${name} identifies the waiting-for-headers phase and never retries a POST`, async () => {
  let requests = 0;
  const message = await failure(context(async () => { requests++; throw error; }));
  diagnostic(message, kind, 'awaiting response headers');
  assert.equal(requests, 1);
});

test('Auth body deadline preserves the received status and the unknown POST outcome', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private-response', 'TimeoutError')); } }), { status: 200 });
  const message = await failure(context(async () => response));
  diagnostic(message, /request deadline/, 'reading response body');
  assert.match(message, /HTTP 200/);
});

test('Auth HTTP failures discard raw replies and keep the account reference stable', async () => {
  const failed = () => context(async () => new Response('private-response owner@example.test private-password', { status: 500 }));
  const first = await failure(failed()), second = await failure(failed());
  diagnostic(first, /HTTP failure.*500/, 'response received');
  assert.equal(first.match(/account [a-f0-9]{12}/)?.[0], second.match(/account [a-f0-9]{12}/)?.[0]);
});

test('Auth GET and PUT diagnostics use path templates without email filters or remote user IDs', async () => {
  for (const method of ['GET', 'PUT']) {
    const calls: string[] = [];
    const message = await failure(context(async (_url, init) => {
      calls.push(init!.method!);
      if (init!.method === 'POST') return new Response('{}', { status: 422 });
      if (init!.method === method) throw new TypeError('private-response');
      return Response.json({ users: [{ id: 'remote-private-user', email: user.email }] });
    }));
    assert.match(message, new RegExp(`${method} /auth/v1/admin/users${method === 'PUT' ? '/:user' : ''}`));
    assert.doesNotMatch(message, /filter|owner|example\.test|remote-private|private-response/);
    assert.equal(calls.filter(item => item === method).length, 1);
    assert.equal(message.includes('outcome unknown'), method === 'PUT');
  }
});

test('Generated passwords are registered for redaction before an account request can fail', async () => {
  const hidden = new Set<string>();
  let submitted = '';
  await failure(context(async (_url, init) => {
    submitted = (JSON.parse(String(init!.body)) as { password: string }).password;
    assert.ok(hidden.has(submitted), 'password must already be hidden when the write begins');
    throw new TypeError('connection lost');
  }, { rememberSecret: (value: string) => hidden.add(value) }));
  assert.ok(hidden.has(submitted));
  assert.ok(hidden.has(user.email), 'vendor logs must also hide the account email');
});

test('The unchanged 20-second request deadline remains identifiable when a body abort reports AbortError', async t => {
  const deadline = new AbortController();
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return deadline.signal; });
  let began = false;
  const message = await failure(context(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    began = true;
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('body stopped', 'AbortError')), { once: true });
    queueMicrotask(() => { deadline.abort(new DOMException('request timed out', 'TimeoutError')); if (!init?.signal) controller.error(new DOMException('body stopped', 'AbortError')); });
  } }))));
  assert.equal(began, true);
  assert.deepEqual(limits, [20_000]);
  diagnostic(message, /request deadline/, 'reading response body');
});

test('Cancellation during body consumption keeps its phase and does not become a deadline', async () => {
  const cancellation = new AbortController();
  const message = await failure(context(async () => new Response(new ReadableStream({ start(controller) {
    queueMicrotask(() => { cancellation.abort(new Error('Private cancellation reason')); controller.error(new DOMException('body stopped', 'AbortError')); });
  } })), { signal: cancellation.signal }));
  diagnostic(message, /cancelled/, 'reading response body');
  assert.doesNotMatch(message, /Private cancellation reason/);
});

test('Cancellation before dispatch identifies a request that was never sent', async () => {
  const cancellation = new AbortController(); cancellation.abort(new Error('private cancel reason'));
  let requests = 0;
  const message = await failure(context(async () => { requests++; return Response.json({}); }, { signal: cancellation.signal }));
  assert.match(message, /cancelled.*phase: not sent/);
  assert.doesNotMatch(message, /outcome unknown|private cancel reason/);
  assert.equal(requests, 0);
});

test('A real HTTP response body that stalls retains deadline attribution after headers arrive', async t => {
  const deadline = new AbortController(), limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return deadline.signal; });
  let writes = 0;
  const server = createServer((_request, response) => { writes++; response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"user":'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const message = await failure(context(async (url, init) => {
    const response = await fetch(url, init);
    setTimeout(() => deadline.abort(new DOMException('deadline reached', 'TimeoutError')), 10);
    return response;
  }, { port: () => (server.address() as AddressInfo).port }));
  diagnostic(message, /request deadline/, 'reading response body');
  assert.match(message, /HTTP 200/);
  assert.equal(writes, 1);
  assert.deepEqual(limits, [20_000]);
});
