import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { loopbackCommand } from '../src/twin/loopback.ts';
import { composeTwin } from '../src/twin/compose.ts';
import { validateTwinConfig } from '../src/twin/config.ts';
import { services } from '../src/twin/index.ts';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (code: string) => `${quote(process.execPath)} -e ${quote(code)}`;
async function listening() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: (server.address() as AddressInfo).port };
}
async function freePort() {
  const { server, port } = await listening();
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function assertReleased(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function run(t: TestContext, code: string, ports: number[]) {
  const [file, ...args] = loopbackCommand(command(code), ports, 1);
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); await done; });
  return { child, done, output: () => ({ stdout, stderr }) };
}

test('The public URL listener is ready before the app starts, and an app failure releases it', { timeout: 10000 }, async t => {
  const port = await freePort();
  const process = run(t, `const net = require('node:net');
    const probe = net.createServer();
    probe.once('error', error => { if (error.code === 'EADDRINUSE') { console.log('relay ready before app'); process.exit(17); } else process.exit(2); });
    probe.listen(${port}, '127.0.0.1', () => process.exit(3));`, [port, port]);
  assert.equal(await process.done, 17, process.output().stderr);
  assert.equal(process.output().stdout.trim(), 'relay ready before app');
  await assertReleased(port);
});

test('A failed relay bind starts no app and releases listeners already bound', { timeout: 10000 }, async t => {
  const port = await freePort(), busy = await listening();
  t.after(() => new Promise<void>(resolve => busy.server.close(() => resolve())));
  const process = run(t, `console.log('APP_STARTED')`, [port, busy.port]);
  assert.equal(await process.done, 1);
  assert.equal(process.output().stdout, '');
  assert.match(process.output().stderr, /Cannot bind twin public URL/);
  await assertReleased(port);
});

test('Stopping the supervisor terminates an app group that ignores SIGTERM and releases its public URL', { timeout: 10000 }, async t => {
  const port = await freePort();
  const job = run(t, `const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    descendant.stdout.once('data', () => console.log(JSON.stringify({ app: process.pid, descendant: descendant.pid }))); setInterval(() => {}, 1000);`, [port]);
  while (!job.output().stdout.includes('\n')) {
    assert.equal(job.child.exitCode, null, job.output().stderr);
    await delay(10, undefined, { signal: t.signal });
  }
  const pids = JSON.parse(job.output().stdout) as { app: number; descendant: number };
  job.child.kill('SIGTERM');
  assert.equal(await job.done, 143);
  await assertReleased(port);
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Only explicit public references get relays; private, literal and blocked addresses do not', () => {
  const config = validateTwinConfig({ services: { supabase: {}, stripe: {} }, apps: {
    web: { start: 'node app.js', port: 3000, env: {
      PUBLIC_API: '{{apps.api.publicUrl}}', PUBLIC_API_AGAIN: '{{apps.api.publicUrl}}/path',
      PUBLIC_DB: '{{services.supabase.publicUrl.api}}', PRIVATE_DB: '{{services.supabase.url.db}}',
      EXTERNAL: 'http://127.0.0.1:49999', BLOCKED: '{{services.stripe.publicUrl.api}}',
    } }, api: { start: 'node api.js', port: 8080 },
  } }, { services });
  const result = composeTwin({ project: 'acme-loopback', owner: 'acme', environment: 'beta', source: '/acme/source', config,
    ports: { 'apps.web': 47100, 'apps.api': 47101, 'supabase.api': 47102, 'supabase.db': 47103, 'stripe.api': 47104 },
    services: [{ id: 'supabase', fidelity: 'official-sandbox', status: 'ready', env: {}, containers: [] },
      { id: 'stripe', fidelity: 'official-sandbox', status: 'blocked', missing: ['test key'] }] });
  const argv = result.compose.services.web.command as string[];
  assert.equal(argv[0], 'node');
  assert.deepEqual(JSON.parse(argv[3]), [47101, 47102]);
  assert.equal(result.env.WEB__EXTERNAL, 'http://127.0.0.1:49999');
  assert.equal(result.env.WEB__BLOCKED, undefined);
  assert.deepEqual(result.compose.services.api.command, ['sh', '-c', 'corepack enable && node api.js']);
  assert.deepEqual(result.compose.services.web.ports, ['127.0.0.1:47100:3000']);
  assert.throws(() => loopbackCommand('node app.js', [3000], 3000), /conflicts with the app's listening port/);
});
