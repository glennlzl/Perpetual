import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import type { Exec } from '../src/twin/runtime.ts';

const names = ['supabase_db_perpetual-beta', 'supabase_auth_perpetual-beta', 'supabase_kong_perpetual-beta'];
const ids = names.map((_name, index) => String(index + 1).repeat(64));
const credential = 'generated-password-must-be-hidden';
async function fixture(t: test.TestContext, options: { wrongLabel?: boolean; missing?: boolean; unavailable?: boolean; large?: boolean; cleanupFails?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'twin-diagnostics-')), dir = join(dataDir, 'environments/beta/twin');
  await mkdir(join(dir, 'services/supabase/supabase/supabase'), { recursive: true });
  await writeFile(join(dir, 'services/supabase/supabase/supabase/config.toml'), 'project_id = "perpetual-beta"\n');
  await writeFile(join(dir, 'compose.yaml'), 'services: {}\n');
  await writeFile(join(dir, 'twin.json'), JSON.stringify({ id: 'beta', project: 'perpetual-beta', owner: 'test-owner', source: join(dataDir, 'source'), block: [43100], ports: {},
    services: [{ id: 'supabase', options: {}, outputs: {} }], secrets: [credential] }));
  const calls: { file: string; args: string[]; timeoutMs?: number }[] = [];
  const exec: Exec = async (file, args, options_) => {
    calls.push({ file, args, timeoutMs: options_?.timeoutMs });
    if (args[0] === 'inspect') {
      const name = args.at(-1)!, index = names.indexOf(name);
      assert.notEqual(index, -1, 'inspect only declared exact names');
      if (options.missing && index === 0) throw new Error('No such container');
      return { stdout: JSON.stringify({ id: ids[index], name: `/${name}`, labels: { 'com.supabase.cli.project': options.wrongLabel && index === 0 ? 'perpetual-other' : 'perpetual-beta' } }) };
    }
    if (args[0] === 'logs') {
      const id = args.at(-1)!;
      assert.ok(ids.includes(id), 'use the verified immutable ID, never a re-used name');
      if (options.unavailable) throw new Error(`Logs unavailable ${credential}`);
      return { stdout: `${options.large ? 'λ'.repeat(100_000) : ''}vendor-${ids.indexOf(id)}: ${credential}\nAuthorization: Bearer eyJfixture.payload.signature\n` };
    }
    if (args[0] === 'compose' && args.includes('logs')) return { stdout: `app: ${credential}\n` };
    if (args.includes('down') && options.cleanupFails) throw new Error('cleanup unavailable');
    return { stdout: '' };
  };
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = createTwinRuntime({ exec });
  return { runtime, dataDir, dir, calls, logs: () => runtime.logs({ dataDir, id: 'beta' }) };
}

test('Diagnostics include vendor-owned database, Auth and gateway logs with secrets removed', async t => {
  const f = await fixture(t);
  const logs = await f.logs();
  for (let index = 0; index < names.length; index++) assert.match(logs, new RegExp(`vendor-${index}`));
  assert.match(logs, /app:/);
  assert.doesNotMatch(logs, /generated-password-must-be-hidden|eyJfixture/);
  assert.equal(f.calls.filter(call => call.args[0] === 'logs').length, 3);
  assert.ok(f.calls.every(call => call.timeoutMs! > 0 && call.timeoutMs! <= 20_000));
});

for (const option of ['wrongLabel', 'missing'] as const) test(`Diagnostics reject ${option} ownership without reading unrelated logs`, async t => {
  const f = await fixture(t, { [option]: true }), logs = await f.logs();
  assert.match(logs, /unavailable/i);
  assert.ok(!f.calls.some(call => call.args[0] === 'logs' && call.args.at(-1) === ids[0]));
  assert.match(logs, /vendor-1/);
});

test('Unavailable vendor logs remain visible without exposing secrets or blocking cleanup', async t => {
  const f = await fixture(t, { unavailable: true }), logs = await f.logs();
  assert.match(logs, /unavailable/i);
  assert.doesNotMatch(logs, new RegExp(credential));
  await f.runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
  assert.ok(f.calls.some(call => call.args.includes('stop')));
});

for (const stream of ['stdout', 'stderr'] as const) for (const timedOut of [false, true]) {
  test(`Failed ${stream} log output is redacted before tailing (deadline: ${timedOut})`, async t => {
    const f = await fixture(t);
    const privateBlock = '-----BEGIN PRIVATE KEY-----\n' + 'PRIVATE-KEY-BODY-FIXTURE\n'.repeat(40) + '-----END PRIVATE KEY-----\n';
    const runtime = createTwinRuntime({ exec: async (_file, args) => {
      if (args[0] === 'inspect') return { stdout: JSON.stringify({ id: ids[0], name: `/${args.at(-1)}`, labels: { 'com.supabase.cli.project': 'perpetual-beta' } }) };
      throw Object.assign(new Error('Log read failed'), { [stream]: privateBlock, ...(timedOut ? { timedOut: true } : {}) });
    } });
    const logs = await runtime.logs({ dataDir: f.dataDir, id: 'beta' });
    assert.match(logs, /Compose logs unavailable/);
    assert.match(logs, /supabase_auth_perpetual-beta logs unavailable/);
    assert.doesNotMatch(logs, /PRIVATE-KEY-BODY-FIXTURE|BEGIN PRIVATE KEY|END PRIVATE KEY/);
    assert.match(logs, /REDACTED/);
  });
}

test('Diagnostic output is byte-bounded after redaction and cleanup failure keeps ownership', async t => {
  const f = await fixture(t, { large: true, cleanupFails: true }), logs = await f.logs();
  assert.ok(Buffer.byteLength(logs) <= 128 * 1024);
  assert.doesNotMatch(logs, new RegExp(credential));
  assert.match(logs, /vendor-2/);
  await assert.rejects(f.runtime.destroy({ dataDir: f.dataDir, id: 'beta' }), /cleanup failed/);
  assert.ok(await readFile(join(f.dir, 'twin.json'), 'utf8'));
});

test('Older twin records hide account usernames and configured emails before retaining vendor logs', async t => {
  const f = await fixture(t), file = join(f.dir, 'twin.json'), state = JSON.parse(await readFile(file, 'utf8'));
  state.accounts = [{ service: 'supabase', id: 'owner', label: 'Owner', username: 'old-owner@example.test', password: 'old-password-fixture' }];
  state.services[0].options.users = [{ id: 'viewer', email: 'old-viewer@example.test' }];
  await writeFile(file, JSON.stringify(state));
  const runtime = createTwinRuntime({ exec: async (_file, args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ id: ids[0], name: `/${args.at(-1)}`, labels: { 'com.supabase.cli.project': 'perpetual-beta' } }) };
    return { stdout: 'old-owner@example.test old-viewer@example.test old-password-fixture' };
  } });
  const logs = await runtime.logs({ dataDir: f.dataDir, id: 'beta' });
  assert.doesNotMatch(logs, /old-owner|old-viewer|old-password/);
});

test('A spent collection deadline stops scheduling Docker reads while leaving cleanup available', async t => {
  const f = await fixture(t);
  let reads = 0;
  t.mock.method(Date, 'now', () => reads++ === 0 ? 1000 : 21_001);
  const logs = await f.logs();
  assert.match(logs, /20-second deadline/);
  assert.equal(f.calls.length, 0);
  t.mock.restoreAll();
  await f.runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
  assert.ok(f.calls.some(call => call.args.includes('down')));
});
