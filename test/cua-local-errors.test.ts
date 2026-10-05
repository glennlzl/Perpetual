import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const moduleUrl = new URL('../src/sandbox/cua-local.ts', import.meta.url).href;
const socket = 'unix:///tmp/perpetual-docker-error-fixture.sock';
const secret = 'synthetic-do-not-expose-docker-stderr';

async function dockerFailureFixture(t: TestContext, failure: { exitCode: number; stderr: string; stdout?: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-docker-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(failure));
  await writeFile(join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] !== '--host' || args[1] !== ${JSON.stringify(socket)}) process.exit(81);
if (JSON.stringify(args.slice(2)) === JSON.stringify(['info', '--format', '{{.OSType}}'])) {
  process.stdout.write('linux\\n');
} else if (JSON.stringify(args.slice(2)) === JSON.stringify(['build', '--tag', 'perpetual-test:fixture', '.'])) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
  process.stderr.write(fixture.stderr);
  process.stdout.write(fixture.stdout || '');
  process.exitCode = fixture.exitCode;
} else {
  process.stderr.write('Unexpected Docker fixture command');
  process.exitCode = 82;
}
`, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DOCKER_HOST: socket };
  delete environment.DOCKER_CONTEXT;
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { localDocker } from ${JSON.stringify(moduleUrl)};
    try {
      const docker = await localDocker();
      const output = await docker.command(['build', '--tag', 'perpetual-test:fixture', '.'], 'Preparing sandbox image');
      process.stdout.write(JSON.stringify({ output }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ name: error.name, code: error.code, message: error.message, detail: { ...error } }));
    }
  `], { env: environment, timeout: 20000 });
  assert.equal(stderr, '', 'Raw Docker stderr must not escape to the caller');
  assert.doesNotMatch(stdout, new RegExp(secret));
  const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [
    ['--host', socket, 'info', '--format', '{{.OSType}}'],
    ['--host', socket, 'build', '--tag', 'perpetual-test:fixture', '.'],
  ], 'The public command must use the selected local socket without retrying the failed build');
  return JSON.parse(stdout);
}

test('local Docker reports actionable disk exhaustion without exposing build stderr', async t => {
  const failure = await dockerFailureFixture(t, {
    exitCode: 1,
    stderr: `failed to register layer: write /usr/share/doc/nodejs/api/all.html: no space left on device\nAuthorization: Bearer ${secret}\n`,
  });
  assert.equal(failure.code, 'DOCKER_DISK_FULL');
  assert.match(failure.message, /Docker.*(?:storage|disk).*full/i);
  assert.match(failure.message, /free.*(?:space|storage)|increase.*(?:space|storage|disk)/i);
  assert.match(failure.message, /retry/i);
  assert.doesNotMatch(failure.message, /api\/all\.html|Authorization|Check the local Docker engine/i);
});

test('local Docker preserves unavailable daemon classification', async t => {
  const failure = await dockerFailureFixture(t, {
    exitCode: 1, stderr: `Cannot connect to the Docker daemon at ${socket}. Is the docker daemon running?\n${secret}`,
  });
  assert.equal(failure.code, 'DOCKER_UNAVAILABLE');
  assert.equal(failure.message, 'The local Docker engine is unavailable.');
});

test('local Docker preserves the generic permission failure without leaking stderr', async t => {
  const failure = await dockerFailureFixture(t, {
    exitCode: 1, stderr: `permission denied while trying to connect to the Docker daemon socket\n${secret}`,
  });
  assert.equal(failure.code, 'DOCKER_ERROR');
  assert.equal(failure.message, 'Preparing sandbox image failed. Check the local Docker engine.');
});

test('local Docker returns successful command output even when progress mentions disk space', async t => {
  const result = await dockerFailureFixture(t, {
    exitCode: 0, stderr: 'Checking available disk space\n', stdout: '  sha256:completed-build  \n',
  });
  assert.deepEqual(result, { output: 'sha256:completed-build' });
});
