import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeStateFile } from '../../src/store.ts';
import { trialRequest } from './client.ts';

async function clientFile() {
  const directory = await mkdtemp(join(tmpdir(), 'broker-client-'));
  const file = join(directory, 'client.json');
  await writeStateFile(file, JSON.stringify({ brokerUrl: 'http://127.0.0.1:43179', token: 'a'.repeat(43) }));
  return { file, close: () => rm(directory, { recursive: true, force: true }) };
}

test('accepts a bounded JSON broker response', async t => {
  const client = await clientFile(), original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; await client.close(); });
  globalThis.fetch = async () => Response.json({ status: 'connected' });
  assert.deepEqual(await trialRequest(client.file, 'status'), { status: 'connected' });
});

test('sends an empty POST to disconnect and validates the not-connected reply', async t => {
  const client = await clientFile(), original = globalThis.fetch;
  let sent: { url?: string; method?: string; body?: BodyInit | null } = {};
  t.after(async () => { globalThis.fetch = original; await client.close(); });
  globalThis.fetch = async (input, init) => {
    sent = { url: String(input), method: init?.method, body: init?.body };
    return Response.json({ status: 'not-connected' });
  };
  assert.deepEqual(await trialRequest(client.file, 'disconnect'), { status: 'not-connected' });
  assert.equal(sent.url, 'http://127.0.0.1:43179/trial/disconnect');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body, '{}');
});

test('rejects and cancels a chunked broker response once it exceeds 32 KiB', async t => {
  const client = await clientFile(), original = globalThis.fetch;
  let cancelled = false;
  t.after(async () => { globalThis.fetch = original; await client.close(); });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(40 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(trialRequest(client.file, 'status'), /Invalid broker response/u);
  assert.equal(cancelled, true);
});

test('rejects a declared oversize response before reading its body', async t => {
  const client = await clientFile(), original = globalThis.fetch;
  let cancelled = false;
  t.after(async () => { globalThis.fetch = original; await client.close(); });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
    headers: { 'content-type': 'application/json', 'content-length': String(40 * 1024) },
  });
  await assert.rejects(trialRequest(client.file, 'status'), /Invalid broker response/u);
  assert.equal(cancelled, true);
});
