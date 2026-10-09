import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getGlobalDispatcher } from 'undici';
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { authorStructuredConfig, configModel, createConfigTransport } from '../src/twin/config-author.ts';

async function listening(t: TestContext, server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function proxy(t: TestContext, mode: 'tunnel' | 'refuse' | 'hang' = 'tunnel') {
  const requests: string[] = [];
  const server = createServer((_request, response) => { response.writeHead(500).end(); });
  server.on('connect', (request, socket, head) => {
    requests.push(request.url!);
    if (mode === 'refuse') { socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return; }
    if (mode === 'hang') return;
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    t.after(() => { upstream.destroy(); });
  });
  return { server, requests, url: await listening(t, server) };
}

function transport(t: TestContext, env: NodeJS.ProcessEnv) {
  const value = createConfigTransport(env);
  t.after(() => value.close());
  return value;
}

test('model transport uses HTTP_PROXY without changing global networking', async t => {
  let requests = 0;
  const target = await listening(t, createServer((_request, response) => { requests += 1; response.end('proxied'); }));
  const route = await proxy(t), before = getGlobalDispatcher();
  const scoped = transport(t, { HTTP_PROXY: route.url });
  const response = await scoped.fetch(target);
  assert.equal(await response.text(), 'proxied');
  assert.equal(requests, 1);
  assert.deepEqual(route.requests, [new URL(target).host]);
  assert.equal(getGlobalDispatcher(), before);
});

test('NO_PROXY is honored while another transport can use the proxy for the same target', async t => {
  const target = await listening(t, createServer((_request, response) => response.end('local')));
  const route = await proxy(t, 'refuse');
  const bypass = transport(t, { HTTP_PROXY: route.url, NO_PROXY: '127.0.0.1' });
  assert.equal(await (await bypass.fetch(target)).text(), 'local');
  assert.equal(route.requests.length, 0);
  const scoped = transport(t, { HTTP_PROXY: route.url, NO_PROXY: '' });
  await assert.rejects(scoped.fetch(target));
  assert.equal(route.requests.length, 1);
});

test('HTTPS_PROXY routes TLS targets and HTTP_PROXY remains the fallback when it is absent', async t => {
  const http = await proxy(t, 'refuse'), https = await proxy(t, 'refuse');
  const preferred = transport(t, { HTTP_PROXY: http.url, HTTPS_PROXY: https.url });
  await assert.rejects(preferred.fetch('https://model.example.test/', { signal: AbortSignal.timeout(1000) }));
  assert.deepEqual(https.requests, ['model.example.test:443']);
  assert.equal(http.requests.length, 0);
  const fallback = transport(t, { HTTP_PROXY: http.url });
  await assert.rejects(fallback.fetch('https://model.example.test/', { signal: AbortSignal.timeout(1000) }));
  assert.deepEqual(http.requests, ['model.example.test:443']);
});

test('a failed proxy never retries directly against the destination', async t => {
  let direct = 0;
  const target = await listening(t, createServer((_request, response) => { direct += 1; response.end('must not receive'); }));
  const route = await proxy(t, 'refuse');
  await assert.rejects(transport(t, { HTTP_PROXY: route.url }).fetch(target));
  assert.equal(route.requests.length, 1);
  assert.equal(direct, 0);
});

test('request cancellation stops a pending proxy tunnel and owned transport can be closed', async t => {
  const route = await proxy(t, 'hang'), scoped = transport(t, { HTTPS_PROXY: route.url });
  const controller = new AbortController(), connected = once(route.server, 'connect');
  const pending = scoped.fetch('https://model.example.test/', { signal: controller.signal });
  await connected;
  controller.abort();
  await assert.rejects(pending);
  await scoped.close();
  await assert.rejects(scoped.fetch('https://model.example.test/'));
});

test('model transport refuses redirects instead of changing the credential destination', async t => {
  let followed = false;
  const other = await listening(t, createServer((_request, response) => { followed = true; response.end(); }));
  const target = await listening(t, createServer((_request, response) => { response.writeHead(302, { Location: other }).end(); }));
  await assert.rejects(transport(t, {}).fetch(target));
  assert.equal(followed, false);
});

test('unsupported structured responses get an actionable message without changing models or retrying', async t => {
  const source = await mkdtemp(join(tmpdir(), 'perpetual-transport-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (const message of ['No endpoints found that support the requested parameters.', 'response_format json_schema is not supported by this model.']) {
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      throw new APICallError({ message, statusCode: 400, url: 'https://model.example.test', requestBodyValues: {}, isRetryable: false });
    } });
    const result = await authorStructuredConfig({ source, workspace: source, draft: JSON.stringify({ apps: { web: { start: 'node app.mjs', port: 3000 } } }), evidence: '', model: 'vendor/chosen-model', apiKey: 'fixture-api-key', services: {} }, model).promise;
    assert.match(result.error!, /Choose a model with structured-output support in Settings/);
    assert.equal(result.terminal, true);
    assert.equal(model.doGenerateCalls.length, 1);
  }
});


test('configuration requests keep Luna and use low reasoning without any model fallback', async () => {
  for (const id of ['openai/gpt-6-luna', 'vendor/explicit-fixture']) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls += 1;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === 'object');
      assert.ok('model' in body);
      assert.equal(body.model, id);
      assert.equal('models' in body, false);
      assert.ok('provider' in body);
      assert.deepEqual(body.provider, { require_parameters: true, sort: 'latency', allow_fallbacks: false });
      if (id === 'openai/gpt-6-luna') {
        assert.ok('reasoning' in body);
        assert.deepEqual(body.reasoning, { effort: 'low' });
      } else assert.equal('reasoning' in body, false);
      return Response.json({ id: 'fixture', model: id, object: 'chat.completion', created: 0,
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    const result = await generateText({ model: configModel(id, 'fixture-api-key', fetch), prompt: 'fixture', maxRetries: 0 });
    assert.equal(result.text, 'done');
    assert.equal(calls, 1);
  }
});
