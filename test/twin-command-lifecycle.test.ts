import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTwinRuntime, execCommand } from '../src/twin/runtime.ts';
import type { TwinService } from '../src/twin/registry.ts';

test('a twin command deadline stops the process instead of waiting for its work to finish', async () => {
  await assert.rejects(execCommand(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeoutMs: 40 }), { timedOut: true });
});

test('cancelling a twin command waits for its process to exit', async () => {
  const controller = new AbortController();
  let pid = 0;
  const running = execCommand(process.execPath, ['-e', 'console.log(process.pid);setTimeout(()=>{},500)'], {
    signal: controller.signal, onOutput: chunk => { pid ||= Number(chunk.trim()); controller.abort(new Error('Stopped by user.')); },
  });
  await assert.rejects(running, /Stopped by user/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('setup logs are available before Compose exists and hide split secret output', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-setup-log-')), source = join(dataDir, 'source');
  await mkdir(source); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = { id: 'setup', title: 'Setup', fidelity: 'actual', env: () => ({}),
    inputs: [{ name: 'key', label: 'Key', secret: true }],
    setup: async ctx => {
      await ctx.exec(process.execPath, ['-e', `console.log('Downloading packages');process.stdout.write('API_KEY=fixture-');setTimeout(()=>process.stdout.write('secret-value\\n'),20);setTimeout(()=>{},400);`]);
      throw new Error('Fixture setup ends here.');
    },
  } satisfies TwinService;
  const runtime = createTwinRuntime({ services: { setup: service }, isFree: async () => true });
  const running = runtime.prepare({ dataDir, id: 'beta', source, inputs: { setup: { key: 'fixture-secret-value' } }, config: { services: { setup: {} }, apps: {} } });
  const settled = assert.rejects(running, /Fixture setup ends here/);
  let logs = '';
  for (let i = 0; i < 25 && !logs.includes('Downloading packages'); i++) { await delay(10); logs = await runtime.logs({ dataDir, id: 'beta' }); }
  try { assert.match(logs, /Downloading packages/); } finally { await settled; }
  logs = await runtime.logs({ dataDir, id: 'beta' });
  assert.doesNotMatch(logs, /fixture-secret-value|fixture-/);
  assert.match(logs, /API_KEY=\[redacted\]/i);
});

test('setup logs retain a final diagnostic that has no newline', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-setup-tail-')), source = join(dataDir, 'source');
  await mkdir(source); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = { id: 'setup', title: 'Setup', fidelity: 'actual', env: () => ({}), setup: async ctx => {
    await ctx.exec(process.execPath, ['-e', 'process.stdout.write("Final diagnostic without newline")']);
    throw new Error('Setup failed.');
  } } satisfies TwinService;
  const runtime = createTwinRuntime({ services: { setup: service }, isFree: async () => true });
  await assert.rejects(runtime.prepare({ dataDir, id: 'beta', source, config: { services: { setup: {} } } }), /Setup failed/);
  assert.match(await runtime.logs({ dataDir, id: 'beta' }), /Final diagnostic without newline/);
});
