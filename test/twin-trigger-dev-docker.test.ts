import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execCommand } from '../src/twin/runtime.ts';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import trigger, { VERSION, cliImage, ensureCli } from '../src/twin/services/trigger-dev.ts';
import { desktopSkip } from './fixtures/docker-engine.ts';

// Opt-in: builds the pinned CLI image and runs the dev worker command in a disposable perpetual-smoke-* container.
// A local listener stands in for the webapp only to observe the CLI's first sign-in request, then refuses it.
const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.';
const desktopOnly = desktopSkip(skip);
const docker = (...args: string[]) => execCommand('docker', args);
const TOKEN = `tr_pat_${randomBytes(20).toString('hex')}`;

test('the dev worker runs the CLI from its pinned image, which signs in from its login profile without the bot token in its environment', { skip, timeout: 900000 }, async t => {
  const version = process.env.PERPETUAL_TRIGGER_CLI_VERSION ?? VERSION, image = cliImage(version);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-smoke-'))), name = `perpetual-smoke-${randomBytes(4).toString('hex')}`;
  const existed = await docker('image', 'inspect', image).then(() => true, () => false);
  let pending: ServerResponse | null | undefined, signIn!: (authorization: string | undefined) => void;
  const signedIn = new Promise<string | undefined>(done => { signIn = done; });
  const server = createServer((request, response) => {
    if (request.url !== '/api/v2/whoami') { response.writeHead(404).end(); return; }
    signIn(request.headers.authorization);
    pending = response;
  });
  const refuse = () => { pending?.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid or Missing Access Token"}'); pending = null; };
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    refuse();
    server.close();
    server.closeAllConnections();
    await docker('rm', '--force', name).catch(() => {});
    if (!existed) await docker('image', 'rm', image).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  await ensureCli({ shared: dir, exec: (file, args) => execCommand(file, args) }, version);
  const offline = await docker('run', '--rm', '--network', 'none', image, 'trigger', '--version');
  assert.match(offline.stdout, new RegExp(version.replaceAll('.', '\\.')), 'The CLI is in the image; starting it downloads nothing.');
  // From here the worker reaches the listener on the host's loopback through host.docker.internal, which only Docker Desktop routes.
  if (desktopOnly) return t.skip(desktopOnly);

  const outputs = { apiUrl: `http://host.docker.internal:${(server.address() as AddressInfo).port}`, secretKey: 'tr_dev_smoke', projectRef: 'proj_smoke', accessToken: TOKEN };
  // The worker container reads only its options and outputs.
  const [worker] = trigger.containers({ options: { version }, outputs } as Parameters<typeof trigger.containers>[0]);
  await execCommand('docker', ['run', '--detach', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
    ...Object.keys(worker.env).flatMap(key => ['--env', key]), worker.image, ...worker.command], { env: worker.env });
  const authorization = await Promise.race([signedIn, delay(120000, null, { ref: false }).then(() => assert.fail('The CLI never signed in.'))]);
  assert.equal(authorization, `Bearer ${TOKEN}`, 'The CLI signs in with the token from its login profile.');

  const environ = (await docker('exec', name, 'cat', '/proc/1/environ')).stdout.split('\0');
  assert.match((await docker('exec', name, 'cat', '/proc/1/cmdline')).stdout.replaceAll('\0', ' '), /trigger dev --project-ref proj_smoke/);
  assert.ok(environ.includes(`TRIGGER_API_URL=${outputs.apiUrl}`));
  assert.ok(!environ.some(entry => entry.includes(TOKEN)), 'Task processes inherit the CLI environment, which holds no bot token.');
  assert.equal((await docker('exec', name, 'stat', '-c', '%a', '/root/.config/trigger/config.json')).stdout.trim(), '600');

  refuse();
  for (let attempt = 0; attempt < 60 && (await docker('inspect', '--format', '{{.State.Running}}', name)).stdout.trim() === 'true'; attempt += 1) await delay(1000);
  assert.equal((await docker('inspect', '--format', '{{.State.ExitCode}}', name)).stdout.trim(), '1', 'A refused token stops the CLI.');
});
