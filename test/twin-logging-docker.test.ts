import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { localDockerEnvironment } from '../src/process.ts';
import { APP_IMAGE, composeTwin } from '../src/twin/compose.ts';
import { validateTwinConfig } from '../src/twin/config.ts';
import { stack } from '../src/twin/services/trigger-dev.ts';

const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to verify log rotation on the local Docker engine.';
const exec = promisify(execFile);
const socket = process.platform === 'darwin' ? join(homedir(), '.docker/run/docker.sock') : '/var/run/docker.sock';
const docker = (args: string[]) => exec('docker', ['--host', `unix://${socket}`, ...args], { env: localDockerEnvironment(), timeout: 60000, maxBuffer: 40 * 1024 * 1024 });

// Use the generated policy unchanged, but run an isolated output probe instead of a vendor database.
// The image must already exist: this check downloads nothing and touches only its own Compose project.
test('generated twin and Trigger logs rotate in Docker, retaining recent output and data through recreation', { skip, timeout: 180000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-logs-')), project = `perpetual-logs-${randomBytes(6).toString('hex')}`;
  const file = join(dir, 'compose.yaml');
  const compose = (...args: string[]) => docker(['compose', '--project-name', project, '--file', file, ...args]);
  t.after(async () => {
    // Do not erase the recovery file if Docker cannot confirm cleanup.
    await compose('down', '--volumes', '--remove-orphans');
    await rm(dir, { recursive: true, force: true });
  });
  const config = validateTwinConfig({ apps: { web: { start: 'node server.js', port: 3000 } } });
  const twin = composeTwin({ project, owner: 'log-rotation-test', environment: project, source: '/unused', config, services: [], ports: { 'apps.web': 43100 } });
  const policies = { app: twin.compose.services.web.logging, trigger: stack(43148).services.clickhouse.logging };
  const base = { image: APP_IMAGE, network_mode: 'none', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  const volumes = { app: {}, trigger: {} };
  const old = Object.fromEntries(Object.keys(policies).map(name => [name, {
    ...base, volumes: [`${name}:/data`], logging: { driver: 'json-file' },
    command: ['node', '-e', "require('node:fs').writeFileSync('/data/kept', 'kept'); setInterval(()=>{}, 1000)"],
    healthcheck: { test: ['CMD', 'node', '-e', "if(require('node:fs').readFileSync('/data/kept','utf8')!=='kept') process.exit(1)"], interval: '1s', timeout: '5s', retries: 30 },
  }]));
  await writeFile(file, stringify({ services: old, volumes }));
  await compose('up', '--detach', '--wait', '--pull', 'never', '--no-build');
  const before = (await compose('ps', '--all', '--quiet')).stdout.trim().split('\n');
  assert.equal(before.length, 2);
  // 45 MiB of line-delimited output exceeds the real production policy's three 10 MiB files.
  const output = "const fs=require('node:fs'); fs.writeSync(1,'EARLIEST_LOG_MARKER\\n'); const line='x'.repeat(1023)+'\\n'; for(let i=0;i<45*1024;i++) fs.writeSync(1,line); fs.writeSync(1,'LATEST_LOG_MARKER:'+fs.readFileSync('/data/kept','utf8')+'\\n');";
  await writeFile(file, stringify({ services: Object.fromEntries(Object.entries(policies).map(([name, logging]) => [name, {
    ...base, volumes: [`${name}:/data`], logging, command: ['node', '-e', output],
  }])), volumes }));
  await compose('up', '--detach', '--pull', 'never', '--no-build');
  const after = (await compose('ps', '--all', '--quiet')).stdout.trim().split('\n');
  assert.equal(after.length, 2);
  assert.ok(after.every(id => !before.includes(id)), 'Compose applies the new policy by recreating the containers.');
  for (const id of after) {
    assert.equal((await docker(['wait', id])).stdout.trim(), '0');
    assert.deepEqual(JSON.parse((await docker(['inspect', '--format', '{{json .HostConfig.LogConfig}}', id])).stdout), {
      Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' },
    });
    const logs = (await docker(['logs', id])).stdout;
    assert.doesNotMatch(logs, /EARLIEST_LOG_MARKER/);
    assert.match(logs, /LATEST_LOG_MARKER:kept\n$/);
    assert.ok(Buffer.byteLength(logs) < 31 * 1024 * 1024, 'Docker retains bounded output after sustained writes.');
    assert.match((await docker(['logs', '--tail', '1', id])).stdout, /LATEST_LOG_MARKER:kept/);
  }
});
