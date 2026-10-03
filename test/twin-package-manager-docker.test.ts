import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localDockerEnvironment } from '../src/process.ts';
import { appCommand } from '../src/twin/compose.ts';

const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to verify package managers in official Node images.';
const exec = promisify(execFile);
const socket = process.platform === 'darwin' ? join(homedir(), '.docker/run/docker.sock') : '/var/run/docker.sock';
const docker = (args: string[]) => exec('docker', ['--host', `unix://${socket}`, ...args], { env: localDockerEnvironment(), timeout: 120000, maxBuffer: 1024 * 1024 });

for (const node of [26, 25, 24]) test(`Node ${node} runs the repository-pinned package manager and stops when bootstrap fails`, { skip, timeout: 180000 }, async t => {
  const name = `perpetual-package-test-${randomBytes(6).toString('hex')}`;
  t.after(async () => {
    const found = (await docker(['ps', '-aq', '--filter', `name=^${name}$`])).stdout.trim();
    if (found) await docker(['rm', '-f', name]);
  });
  const probe = `mkdir /workspace && cd /workspace && printf '%s' '{"name":"acme-app","packageManager":"pnpm@10.18.0"}' > package.json && ${appCommand("pnpm --version", "printf 'APP_COMMAND_COMPLETED\\n'")}`;
  const result = await docker(['run', '--rm', '--name', name, `node:${node}-bookworm-slim`, 'sh', '-c', probe]);
  assert.match(result.stdout, /(?:^|\n)10\.18\.0\r?\n/);
  assert.match(result.stdout, /APP_COMMAND_COMPLETED/);
  // No network is needed for a bundled Corepack. Failure to download a missing one must fail closed.
  const offline = await docker(['run', '--rm', '--network', 'none', '--name', name,
    '-e', 'npm_config_fetch_retries=0', '-e', 'npm_config_fetch_timeout=1000',
    `node:${node}-bookworm-slim`, 'sh', '-c', appCommand("printf 'APP_COMMAND_COMPLETED\\n'")]).then(
    value => ({ ok: true, ...value }), error => ({ ok: false, stdout: String(error.stdout), stderr: String(error.stderr) }),
  );
  assert.equal(offline.ok, node === 24, 'Bundled Corepack works offline; missing Corepack cannot silently skip setup.');
  assert.equal(offline.stdout.includes('APP_COMMAND_COMPLETED'), node === 24);
});
