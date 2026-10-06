import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_IMAGE, HOST_GATEWAY, LABELS, hostUrl } from '../src/twin/compose.ts';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import { cliEntry, setToml } from '../src/twin/services/supabase.ts';

const exec = promisify(execFile);
// Opt-in: prepares one disposable twin, perpetual-smoke-*, whose official local Supabase stack serves an edge function.
const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.';
const UNUSED = ['realtime', 'studio', 'storage', 'analytics', 'local_smtp'];
// Read literally by the function: no expansion, quotes, comments or escapes.
const GREETING = 'whsec_$HOME "twin" #1 \\n end';
const HANDLER = `Deno.serve(async req => Response.json({ method: req.method, greeting: Deno.env.get('GREETING'), body: await req.text() }));\n`;
// A webhook sender in another container: it knows only host.docker.internal and sends no JWT. The first request boots the worker.
const POST = `const [url] = process.argv.slice(1);
for (let attempt = 0; ; attempt += 1) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'evt_1' }).catch(error => ({ status: 0, text: async () => String(error) }));
  if (![0, 502, 503, 504].includes(response.status) || attempt === 60) { console.log(JSON.stringify({ status: response.status, body: await response.text() })); break; }
  await new Promise(done => setTimeout(done, 2000));
}`;

test('a Supabase twin serves an edge function that takes a webhook POST through host.docker.internal', { skip, timeout: 1200000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-smoke-')));
  const id = `smoke-${randomBytes(4).toString('hex')}`, project = `perpetual-${id}`, source = join(dataDir, 'source');
  const runtime = createTwinRuntime({ portBase: 47400 });
  t.after(async () => {
    try { await runtime.destroy({ dataDir, id }); }
    finally {
      await exec(process.execPath, [await cliEntry(), 'stop', '--no-backup', '--project-id', project], { cwd: dataDir }).catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // A stock project with two functions; unused optional services stay off.
  await mkdir(source);
  await exec(process.execPath, [await cliEntry(), 'init'], { cwd: source });
  const file = join(source, 'supabase', 'config.toml');
  await writeFile(file, UNUSED.reduce((toml, section) => setToml(toml, section, 'enabled', false), await readFile(file, 'utf8')));
  for (const name of ['hello', 'private']) {
    await mkdir(join(source, 'supabase', 'functions', name), { recursive: true });
    await writeFile(join(source, 'supabase', 'functions', name, 'index.ts'), HANDLER);
  }

  const config = { services: { supabase: { functions: { env: { GREETING }, noVerifyJwt: ['hello'] } } } };
  assert.equal((await runtime.prepare({ dataDir, id, config, source })).status, 'ready');
  // What {{services.supabase.url.api}} resolves to.
  const api = hostUrl(JSON.parse(await readFile(join(dataDir, 'environments', id, 'twin', 'twin.json'), 'utf8')).ports['supabase.api']);
  const post = async (name: string) => JSON.parse((await exec('docker', ['run', '--rm', '--add-host', HOST_GATEWAY, '--label', `${LABELS.environment}=${id}`,
    APP_IMAGE, 'node', '--input-type=module', '-e', POST, `${api}/functions/v1/${name}`], { timeout: 300000 })).stdout);

  const hello = await post('hello');
  assert.equal(hello.status, 200, hello.body);
  assert.deepEqual(JSON.parse(hello.body), { method: 'POST', greeting: GREETING, body: 'evt_1' });
  assert.equal((await post('private')).status, 401, 'functions not listed in noVerifyJwt keep the JWT check');

  await runtime.destroy({ dataDir, id });
  const { stdout } = await exec('docker', ['ps', '--all', '--quiet', '--filter', `name=${project}`]);
  assert.equal(stdout.trim(), '', 'teardown removes the stack');
});
