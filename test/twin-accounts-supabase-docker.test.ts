import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { allocatePorts } from '../src/twin/runtime.ts';
import supabase, { cliEntry, setToml } from '../src/twin/services/supabase.ts';
import type { Json } from '../src/twin/config.ts';

const exec = promisify(execFile);
// Opt-in: starts one disposable official local Supabase stack, perpetual-smoke-*, with the pinned CLI on the local Docker engine.
const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.';
const PORTS = [['api', 'port'], ['db', 'port'], ['db', 'shadow_port'], ['db.pooler', 'port'], ['studio', 'port'], ['analytics', 'port'],
  ['analytics', 'vector_port'], ['edge_runtime', 'inspector_port'], ['local_smtp', 'port'], ['local_smtp', 'smtp_port'], ['local_smtp', 'pop3_port']];
const OPTIONAL = ['realtime', 'studio', 'storage', 'edge_runtime', 'analytics', 'local_smtp'];
const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').map(line => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(match => match !== null).map(([, key, value]) => [key, value]));

test('the Supabase accounts hook creates users that sign in on the official local stack, and renews them idempotently', { skip, timeout: 600000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-smoke-')));
  const project = `perpetual-smoke-${randomBytes(4).toString('hex')}`;
  const cli = async (...args: string[]) => exec(process.execPath, [await cliEntry(), ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  t.after(async () => {
    try { await cli('stop', '--no-backup', '--project-id', project); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  // A stock `supabase init` project on free ports, with the strictest password policy; unused optional services stay off.
  await cli('init');
  const file = join(dir, 'supabase', 'config.toml'), ports = await allocatePorts({ count: PORTS.length, start: 47100 });
  let toml = setToml(setToml(await readFile(file, 'utf8'), '', 'project_id', project), 'auth', 'password_requirements', 'lower_upper_letters_digits_symbols');
  PORTS.forEach(([section, key], index) => { toml = setToml(toml, section, key, ports[index]); });
  for (const section of OPTIONAL) toml = setToml(toml, section, 'enabled', false);
  await writeFile(file, toml);
  await cli('start', '--workdir', dir);
  const status = parseEnv((await cli('status', '--output', 'env', '--workdir', dir)).stdout);
  const api = `http://127.0.0.1:${ports[0]}`;
  const signIn = async (email: string, password: string) => {
    const response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return { status: response.status, body: await response.json() };
  };

  // Only what accounts() reads: the users, the service role key and the API port.
  const users: Json = [{ id: 'owner', email: 'Owner@Example.test', metadata: { full_name: 'Owner' } }, { id: 'viewer', email: 'viewer@example.test' }];
  const ctx = { options: { users },
    outputs: { serviceRoleKey: status.SERVICE_ROLE_KEY }, port: (name: string) => { assert.equal(name, 'api'); return ports[0]; },
    url: (name: string, path = '') => `http://host.docker.internal:${ctx.port(name)}${path}` } as Parameters<typeof supabase.accounts>[0];
  const first = await supabase.accounts(ctx);
  assert.deepEqual(first.map(({ id, label, username }) => [id, label, username]), [['owner', 'owner', 'owner@example.test'], ['viewer', 'viewer', 'viewer@example.test']]);
  assert.deepEqual(first[0].authEndpoints, [`http://host.docker.internal:${ports[0]}/auth/v1/token`]);
  for (const account of first) {
    const reply = await signIn(account.username, account.password);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.user.email, account.username);
  }
  assert.equal((await signIn('owner@example.test', first[0].password)).body.user.user_metadata.full_name, 'Owner');

  // A rebuild that finds the users registered gives them new passwords; the old ones stop working.
  const second = await supabase.accounts(ctx);
  assert.notEqual(second[0].password, first[0].password);
  assert.equal((await signIn('owner@example.test', second[0].password)).status, 200);
  assert.equal((await signIn('owner@example.test', first[0].password)).status, 400);
});
