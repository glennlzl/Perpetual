import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import type { Exec } from '../src/twin/runtime.ts';

const PROJECT = 'perpetual-beta';
const names = ['supabase_db_perpetual-beta', 'supabase_auth_perpetual-beta', 'supabase_kong_perpetual-beta'];
type Observed = { name: string; state: string; health: string | null; exitCode: number; labels: Record<string, string> };
const healthy = (): Observed[] => names.map(name => ({ name: `/${name}`, state: 'running', health: 'healthy', exitCode: 0,
  labels: { 'com.supabase.cli.project': PROJECT } }));

async function fixture(t: test.TestContext, { records = healthy(), output, error, config = `project_id = "${PROJECT}"\n`, stored = true, composeOutput = JSON.stringify({ Service: 'web', State: 'running', Health: 'healthy', ExitCode: 0 }) }: {
  records?: readonly Observed[]; output?: string; error?: string; config?: string | null; stored?: boolean; composeOutput?: string;
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'twin-external-health-')), dir = join(dataDir, 'environments/beta/twin');
  await mkdir(join(dir, 'services/supabase/supabase/supabase'), { recursive: true });
  if (config !== null) await writeFile(join(dir, 'services/supabase/supabase/supabase/config.toml'), config);
  await writeFile(join(dir, 'compose.yaml'), 'services:\n  web:\n    image: node:24-bookworm-slim\n');
  await writeFile(join(dir, 'twin.json'), JSON.stringify({ id: 'beta', project: PROJECT, owner: 'test-owner', source: join(dataDir, 'source'),
    block: [43100], ports: {}, services: stored ? [{ id: 'supabase', options: {}, outputs: {} }] : [], secrets: ['test-secret-must-stay-private'] }));
  const before = await readFile(join(dir, 'twin.json'), 'utf8'), calls: { file: string; args: string[]; timeoutMs?: number }[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options?.timeoutMs });
    if (args[0] === 'compose' && args.includes('ps')) return { stdout: composeOutput };
    if (args[0] === 'inspect') {
      if (error) throw new Error(error);
      return { stdout: output ?? records.map(record => JSON.stringify(record)).join('\n') };
    }
    throw new Error('Health must only read Compose status and inspect owned containers.');
  };
  const health = () => createTwinRuntime({ exec }).health({ dataDir, id: 'beta' });
  t.after(async () => {
    try { assert.equal(await readFile(join(dir, 'twin.json'), 'utf8'), before, 'health preserves stored resource ownership'); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  return { health, calls };
}

for (const role of [0, 1, 2]) test(`Healthy apps are not Ready when owned Supabase ${['database', 'Auth', 'gateway'][role]} has stopped`, async t => {
  const records = healthy();
  Object.assign(records[role], { state: 'exited', health: 'unhealthy', exitCode: 1 });
  const { health } = await fixture(t, { records });
  const result = await health();
  assert.equal(result.status, 'failed');
  assert.ok(result.containers.some(item => item.name === names[role] && item.state === 'exited'));
});

test('A healthy owned Supabase stack joins app health through a bounded exact-name read', async t => {
  const { health, calls } = await fixture(t);
  const result = await health();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.containers.map(item => item.name), ['web', ...names]);
  const inspection = calls.find(call => call.args[0] === 'inspect')!;
  assert.deepEqual(inspection.args.slice(-3), names);
  assert.equal(inspection.file, 'docker');
  assert.ok(inspection.args.includes('--type') && inspection.args.includes('container'));
  assert.ok(inspection.timeoutMs! > 0 && inspection.timeoutMs! <= 20_000);
});

test('Healthy Supabase cannot make a configured app Ready when its Compose containers are absent', async t => {
  const { health } = await fixture(t, { composeOutput: '[]' });
  assert.equal((await health()).status, 'stopped');
});

for (const [description, options] of [
  ['missing database', { records: healthy().slice(1) }],
  ['missing Docker container', { error: 'No such container' }],
  ['unreadable Docker state', { error: 'Docker unavailable: test-secret-must-stay-private' }],
  ['malformed Docker state', { output: '{broken' }],
  ['missing health observation', { records: healthy().map((record, index) => index ? record : { ...record, health: null }) }],
  ['unknown container state', { records: healthy().map((record, index) => index ? record : { ...record, state: 'unknown' }) }],
  ['missing ownership label', { records: healthy().map((record, index) => index ? record : { ...record, labels: {} }) }],
  ['unrelated project label', { records: healthy().map((record, index) => index ? record : { ...record, labels: { 'com.supabase.cli.project': 'perpetual-other' } }) }],
  ['unrelated container name', { records: healthy().map((record, index) => index ? record : { ...record, name: '/supabase_db_perpetual-other' }) }],
  ['duplicate container', { records: [...healthy(), healthy()[0]] }],
] as const) test(`Supabase health fails closed for ${description}`, async t => {
  const { health } = await fixture(t, options);
  await assert.rejects(health(), (error: Error) => { assert.ok(!error.message.includes('test-secret-must-stay-private')); return true; });
});

test('Restarting Supabase is not Ready while healthy apps still answer', async t => {
  const records = healthy();
  Object.assign(records[0], { state: 'restarting', health: 'starting', exitCode: 1 });
  const { health } = await fixture(t, { records });
  assert.equal((await health()).status, 'starting');
});

test('A running but unhealthy Supabase gateway fails the environment', async t => {
  const records = healthy();
  records[2].health = 'unhealthy';
  const { health } = await fixture(t, { records });
  assert.equal((await health()).status, 'failed');
});

for (const [disabled, indices] of [['auth', [0, 2]], ['api', [0, 1, 2]], ['both', [0, 2]]] as const) test(`Disabled ${disabled} configuration keeps the gateway and only omits disabled Auth`, async t => {
  const config = `project_id = "${PROJECT}"\n${disabled !== 'api' ? '[auth]\nenabled = false\n' : ''}${disabled !== 'auth' ? '[api]\nenabled = false\n' : ''}`;
  const { health, calls } = await fixture(t, { config, records: indices.map(index => healthy()[index]) });
  assert.equal((await health()).status, 'ready');
  assert.deepEqual(calls.find(call => call.args[0] === 'inspect')?.args.slice(-indices.length), indices.map(index => names[index]));
});

test('Supabase still requires its missing gateway when the Data API is disabled', async t => {
  const { health } = await fixture(t, { config: `project_id = "${PROJECT}"\n[api]\nenabled = false\n`, records: healthy().slice(0, 2) });
  await assert.rejects(health(), /every owned service container/);
});

test('A stopped Supabase gateway fails health when the Data API is disabled', async t => {
  const records = healthy();
  Object.assign(records[2], { state: 'exited', health: 'unhealthy', exitCode: 1 });
  const { health } = await fixture(t, { config: `project_id = "${PROJECT}"\n[api]\nenabled = false\n`, records });
  assert.equal((await health()).status, 'failed');
});

for (const config of [null, 'bad = [', 'project_id = "perpetual-other"\n', `project_id = "${PROJECT}"\n[auth]\nenabled = "false"\n`]) {
  test(`Unreadable or invalid copied Supabase config cannot produce Ready: ${config === null ? 'missing' : config.slice(0, 25)}`, async t => {
    const { health, calls } = await fixture(t, { config });
    await assert.rejects(health());
    assert.ok(!calls.some(call => call.args[0] === 'inspect'));
  });
}

test('A blocked service without owned resources is not probed', async t => {
  const { health, calls } = await fixture(t, { stored: false, config: null });
  assert.equal((await health()).status, 'ready');
  assert.ok(!calls.some(call => call.args[0] === 'inspect'));
});
