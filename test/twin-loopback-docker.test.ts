import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import { failureText, redact } from '../src/redaction.ts';

const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to test public URLs on Docker Desktop.';

// Actual Supabase, reached through exactly the same URL by the build, SSR and host browser.
// The second app covers public app-to-app addresses without any service-specific routing.
test('public URLs reach actual Supabase and another app from both host and app containers', { skip, timeout: 600000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-loopback-'))), source = join(dataDir, 'source');
  const id = `loopback-${randomBytes(4).toString('hex')}`, runtime = createTwinRuntime({ portBase: 49100 });
  let preparing: ReturnType<typeof runtime.prepare> | undefined;
  t.after(async () => {
    await preparing?.catch(() => {});
    await runtime.destroy({ dataDir, id });
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(source, 'supabase'), { recursive: true });
  await writeFile(join(source, 'supabase', 'config.toml'), `project_id = "acme-loopback"
[api]
enabled = true
[db]
major_version = 17
[db.migrations]
enabled = false
[db.seed]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[edge_runtime]
enabled = false
[local_smtp]
enabled = false
`);
  await writeFile(join(source, 'build.mjs'), `import { writeFile } from 'node:fs/promises';
try {
  const reply = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL + '/auth/v1/health', { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY } });
  if (!reply.ok) throw new Error('Auth health ' + reply.status);
  await writeFile('build.json', JSON.stringify({ status: reply.status }));
} catch (error) { console.error('Build public URL failed:', error.cause?.code ?? error.message); process.exit(1); }
`);
  await writeFile(join(source, 'api.mjs'), `import { createServer } from 'node:http';
createServer((request, response) => response.end('acme-api')).listen(Number(process.env.PORT), '0.0.0.0');
`);
  await writeFile(join(source, 'web.mjs'), `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
createServer(async (request, response) => {
  if (request.url === '/') return response.end('ready');
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (request.url === '/signin') {
      const parts = []; for await (const part of request) parts.push(part);
      const result = await fetch(url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: Buffer.concat(parts) });
      const body = await result.json();
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ email: body.user?.email }));
    }
    const health = await fetch(url + '/auth/v1/health', { headers: { apikey: key } });
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    const api = await (await fetch(apiUrl)).text();
    const self = await (await fetch(process.env.PUBLIC_SELF_URL)).text();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ url, key, apiUrl, api, self, status: health.status, build: JSON.parse(await readFile('build.json', 'utf8')) }));
  } catch (error) { response.writeHead(500); response.end(error.cause?.code ?? error.message); }
}).listen(Number(process.env.PORT), '0.0.0.0');
`);
  try {
    preparing = runtime.prepare({ dataDir, id, source, signal: t.signal, config: { services: { supabase: { users: [{ id: 'owner', email: 'owner@example.test' }] } }, apps: {
      web: { build: 'node build.mjs', start: 'node web.mjs', port: 3000, env: {
        NEXT_PUBLIC_SUPABASE_URL: '{{services.supabase.publicUrl.api}}', NEXT_PUBLIC_API_URL: '{{apps.api.publicUrl}}',
        PUBLIC_SELF_URL: '{{apps.web.publicUrl}}',
      } }, api: { start: 'node api.mjs', port: 8080 },
    } } });
    const ready = await preparing;
    assert.equal(ready.status, 'ready');
    const reply = await fetch(`${ready.apps.find(app => app.id === 'web')!.url}/shared`, { signal: t.signal });
    assert.equal(reply.status, 200, await reply.clone().text());
    const body = await reply.json();
    assert.equal(body.status, 200, 'SSR reaches actual Supabase.');
    assert.equal(body.build.status, 200, 'Build reaches the service before the app starts.');
    assert.equal(body.api, 'acme-api');
    assert.equal(body.self, 'ready', 'An app can reach its own public URL from SSR.');
    assert.equal(new URL(body.url).hostname, '127.0.0.1');
    assert.equal(new URL(body.apiUrl).hostname, '127.0.0.1');
    assert.equal((await fetch(`${body.url}/auth/v1/health`, { headers: { apikey: body.key }, signal: t.signal })).status, 200);
    assert.equal(await (await fetch(body.apiUrl, { signal: t.signal })).text(), 'acme-api');
    const account = await runtime.account({ dataDir, id, accountId: 'owner' });
    assert.ok(account);
    const credentials = JSON.stringify({ email: account.username, password: account.password });
    const signin = await fetch(`${ready.apps.find(app => app.id === 'web')!.url}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials, signal: t.signal });
    assert.equal(signin.status, 200, 'SSR posts credentials to the actual Supabase Auth service.');
    assert.equal((await signin.json()).email, 'owner@example.test');
    const direct = await fetch(`${body.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: body.key, 'Content-Type': 'application/json' }, body: credentials, signal: t.signal });
    assert.equal(direct.status, 200, 'The host uses the exact same public URL to sign in.');
    assert.equal((await direct.json()).user.email, 'owner@example.test');
    assert.equal((await runtime.health({ dataDir, id })).status, 'ready');
  } catch (error) {
    const logs = await runtime.logs({ dataDir, id }).catch(failure => failureText(failure, 2000));
    throw new Error(redact(`${failureText(error, 2000)}\nTwin logs:\n${logs}`));
  }
});
