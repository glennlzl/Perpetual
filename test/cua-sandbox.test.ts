import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSandbox, destroySandbox, inspectSandbox, listSandboxes, sandboxMcpCommand, startSandbox } from '../src/sandbox/cua.ts';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const relay = fileURLToPath(new URL('../integrations/cua/relay.py', import.meta.url));
const GUEST_PYTHON = '/opt/computer-server/venv/bin/python';

// A docker CLI stand-in for one owned desktop on a local socket. It keeps its engine's state in state.json; no container
// starts. An exec of computer-server's Python is the readiness check, answered as state.computerServer says; any other
// exec is the Driver's, answered as state.exec says. With state.exits, a started container stops again at once.
const DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const file = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = (message, code = 1) => { process.stderr.write(message + '\\n'); process.exit(code); };
const args = process.argv.slice(2);
if (args[0] !== '--host' || args[1] !== state.socket) fail('Unexpected Docker endpoint', 81);
if (state.down) fail('Cannot connect to the Docker daemon at ' + state.socket + '. Is the docker daemon running?');
if (state.error) fail(state.error);
const [command, ...rest] = args.slice(2);
const option = name => rest[rest.indexOf(name) + 1];
const container = state.container;
if (command === 'info') process.stdout.write('linux\\n');
else if (command === 'image' && rest[0] === 'inspect') process.stdout.write(JSON.stringify([{ Id: state.imageId, Os: 'linux' }]));
else if (command === 'container' && rest[0] === 'create') {
  const labels = Object.fromEntries(rest.flatMap((arg, index) => arg === '--label' ? [rest[index + 1].split('=')] : []));
  state.container = { Id: randomBytes(32).toString('hex'), Name: '/' + option('--name'), Image: rest.at(-1), Config: { Labels: labels }, running: false,
    cpus: Number(option('--cpus')), memoryMiB: parseInt(option('--memory'), 10), pids: Number(option('--pids-limit')), created: rest };
  save();
  process.stdout.write(state.container.Id + '\\n');
} else if (command === 'container' && rest[0] === 'inspect') {
  if (!container || (rest[1] !== container.Id && '/' + rest[1] !== container.Name)) fail('Error response from daemon: No such container: ' + rest[1]);
  // The image exposes these ports; they are bound only for a desktop that publishes them, as earlier versions did.
  const published = state.published ? [{ HostIp: '127.0.0.1', HostPort: '49152' }] : null, requested = state.published ? [{ HostIp: '127.0.0.1', HostPort: '' }] : null;
  process.stdout.write(JSON.stringify([{ Id: container.Id, Name: container.Name, Image: container.Image, Config: container.Config,
    State: { Running: container.running, Paused: Boolean(container.paused), Restarting: false },
    NetworkSettings: { Ports: container.running ? { '8000/tcp': published, '6080/tcp': published } : {} },
    HostConfig: { NetworkMode: 'bridge', NanoCpus: container.cpus * 1e9, Memory: container.memoryMiB * 1024 * 1024, PidsLimit: container.pids,
      PortBindings: requested ? { '8000/tcp': requested, '6080/tcp': requested } : {} }, Mounts: [] }]));
} else if (command === 'container' && rest[0] === 'start') {
  if (container.paused) fail('Error response from daemon: cannot start a paused container, try unpause instead');
  container.running = !state.exits; save();
} else if (command === 'container' && rest[0] === 'unpause') { container.paused = false; save(); }
else if (command === 'container' && rest[0] === 'rm') { if (state.rmError) fail(state.rmError); delete state.container; save(); }
else if (command === 'exec') {
  const readiness = rest.includes(${JSON.stringify(GUEST_PYTHON)});
  if (readiness) { state.readiness = args.slice(2); save(); }
  const reply = readiness ? state.computerServer : state.exec;
  process.stdout.write(reply.stdout || '');
  process.stderr.write(reply.stderr || '');
  process.exit(reply.code || 0);
} else fail('Unexpected Docker fixture command', 82);
`;

async function localEngine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-cua-sandbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = `unix://${join(directory, 'docker.sock')}`, state = join(directory, 'state.json');
  await writeFile(state, JSON.stringify({ socket, imageId: `sha256:${'a'.repeat(64)}`, computerServer: { stdout: '{"status":"ok"}' }, exec: { stdout: 'cua-driver 0.28.2\n' } }));
  await writeFile(join(directory, 'docker'), DOCKER, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.DOCKER_HOST = socket;
  delete process.env.DOCKER_CONTEXT;
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  return {
    dataDir: join(directory, 'data'),
    async read() { return JSON.parse(await readFile(state, 'utf8')); },
    async set(change: object) { await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, 'utf8')), ...change })); },
  };
}

test('destroying a sandbox again while Docker is unreachable keeps its confirmed cleanup', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const created = await createSandbox({ dataDir });
  assert.equal(created.status, 'running');
  assert.equal((await destroySandbox({ dataDir, id: created.id })).status, 'destroyed');
  await engine.set({ down: true });
  await assert.rejects(destroySandbox({ dataDir, id: created.id }), { code: 'DOCKER_UNAVAILABLE' });
  // A creation that failed before any container existed is confirmed clean as well.
  await assert.rejects(createSandbox({ dataDir }), { code: 'DOCKER_UNAVAILABLE' });
  const failed = (await listSandboxes({ dataDir })).find(record => record.status === 'failed');
  assert.ok(failed?.cleanedAt);
  await assert.rejects(destroySandbox({ dataDir, id: failed.id }), { code: 'DOCKER_UNAVAILABLE' });
  const records = new Map((await listSandboxes({ dataDir })).map(record => [record.id, record]));
  assert.deepEqual([records.get(created.id)?.status, records.get(created.id)?.cleanupError], ['destroyed', undefined]);
  assert.deepEqual([records.get(failed.id)?.status, records.get(failed.id)?.cleanupError], ['failed', undefined]);
  await engine.set({ down: false });
  assert.equal((await inspectSandbox({ dataDir, id: created.id })).status, 'destroyed');
});

test('a confirmed cleanup is given up only when its owned container is found again', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const created = await createSandbox({ dataDir });
  const { container } = await engine.read();
  await destroySandbox({ dataDir, id: created.id });
  // An engine that answers with an error of another kind says nothing about the container either.
  await engine.set({ error: 'Error response from daemon: an internal error occurred' });
  await assert.rejects(destroySandbox({ dataDir, id: created.id }), { code: 'DOCKER_ERROR' });
  assert.deepEqual((await listSandboxes({ dataDir })).map(record => [record.status, record.cleanupError]), [['destroyed', undefined]]);
  await engine.set({ error: null, container, rmError: 'Error response from daemon: removal of the container is already in progress' });
  await assert.rejects(destroySandbox({ dataDir, id: created.id }), { code: 'DOCKER_ERROR' });
  assert.equal((await listSandboxes({ dataDir }))[0].status, 'cleanup_failed');
});

test('the guest Driver check says what failed', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const { id } = await createSandbox({ dataDir });
  for (const [exec, message] of [
    [{ stderr: 'Error response from daemon: unable to find user perpetual: no matching entries in passwd file', code: 126 }, /^The guest has no user perpetual\./],
    [{ stdout: 'cua-driver 0.27.0\n' }, /^The guest has cua-driver 0\.27\.0\. Install Cua Driver 0\.28\.2 /],
    [{ stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "/usr/local/bin/cua-driver": stat /usr/local/bin/cua-driver: no such file or directory: unknown', code: 127 }, /^Install Cua Driver 0\.28\.2 /],
    // The desktop stopped after its inspection.
    [{ stderr: 'Error response from daemon: container is not running', code: 1 }, /^The guest Driver check failed\./],
  ] as const) {
    await engine.set({ exec });
    await assert.rejects(sandboxMcpCommand({ dataDir, id, user: 'perpetual' }), { message }, JSON.stringify(exec));
  }
  await engine.set({ exec: { stdout: 'cua-driver 0.28.2\n' } });
  const invocation = await sandboxMcpCommand({ dataDir, id });
  assert.deepEqual(invocation.args.slice(-3), [(await listSandboxes({ dataDir }))[0].containerId, '/usr/local/bin/cua-driver', 'mcp']);
});

const ENDPOINTS = ['apiUrl', 'desktopUrl', 'publishedPorts'];

test('a desktop publishes no port, and its computer-server is checked inside it', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const created = await createSandbox({ dataDir });
  assert.deepEqual(ENDPOINTS.filter(key => key in created), []);
  const { container, readiness } = await engine.read();
  assert.deepEqual(container.created.filter((arg: string) => /^(?:-p|-P|--publish)/.test(arg)), [], 'No port is published');
  assert.deepEqual(readiness, ['exec', '--user', '1000', created.containerId, GUEST_PYTHON, '-I', '-c', await readFile(relay, 'utf8'), '8000', 'GET', '/status', '3']);
  // A command still waits until computer-server answers inside the guest.
  await engine.set({ computerServer: { code: 3 } });
  await assert.rejects(sandboxMcpCommand({ dataDir, id: created.id }), { code: 'SANDBOX_NOT_READY' });
});

test('a desktop that publishes ports, as earlier versions created, is refused until it is destroyed', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const { id } = await createSandbox({ dataDir });
  // The record and the container as an earlier version left them.
  const file = join(dataDir, 'sandboxes', `${id}.json`);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')),
    apiUrl: 'http://127.0.0.1:49152', desktopUrl: 'http://127.0.0.1:49153/', publishedPorts: { 8000: 49152, 6080: 49153 } }));
  await engine.set({ published: true });
  const [listed] = await listSandboxes({ dataDir });
  assert.deepEqual(ENDPOINTS.filter(key => key in listed), [], 'Former endpoints are not reported');
  await assert.rejects(inspectSandbox({ dataDir, id }), { code: 'SANDBOX_PORTS_INVALID', message: /Destroy it and create a new one\.$/ });
  await assert.rejects(sandboxMcpCommand({ dataDir, id }), { code: 'SANDBOX_PORTS_INVALID' });
  const destroyed = await destroySandbox({ dataDir, id });
  assert.deepEqual([destroyed.status, ENDPOINTS.filter(key => key in destroyed), (await engine.read()).container], ['destroyed', [], undefined]);
});

test('a desktop image that cannot run the guest relay fails creation at once', { timeout: 30_000 }, async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  await engine.set({ computerServer: { code: 127,
    stderr: `OCI runtime exec failed: exec failed: unable to start container process: exec: "${GUEST_PYTHON}": stat ${GUEST_PYTHON}: no such file or directory: unknown` } });
  await assert.rejects(createSandbox({ dataDir }),
    { code: 'SANDBOX_INVALID_IMAGE', message: `The sandbox image cannot run ${GUEST_PYTHON}, which reaches its computer-server.` });
  const [failed] = await listSandboxes({ dataDir });
  assert.deepEqual([failed.status, failed.errorCode, Boolean(failed.cleanedAt), (await engine.read()).container], ['failed', 'SANDBOX_INVALID_IMAGE', true, undefined]);
});

test('a stopped desktop starts again in its own container, and a paused one resumes, once computer-server answers inside it', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const created = await createSandbox({ dataDir });
  // Docker restarted: the desktop's container stopped, with its disk.
  await engine.set({ container: { ...(await engine.read()).container, running: false }, readiness: null });
  await assert.rejects(sandboxMcpCommand({ dataDir, id: created.id }), { code: 'SANDBOX_NOT_RUNNING', message: 'The sandbox is not running. Run sandbox start.' });
  const started = await startSandbox({ dataDir, id: created.id });
  const { container, readiness } = await engine.read();
  assert.deepEqual([started.status, started.containerId, container.Id, container.running], ['running', created.containerId, created.containerId, true]);
  assert.deepEqual(readiness, ['exec', '--user', '1000', created.containerId, GUEST_PYTHON, '-I', '-c', await readFile(relay, 'utf8'), '8000', 'GET', '/status', '3']);
  // Docker refuses to start a paused container, so it is resumed.
  await engine.set({ container: { ...container, paused: true } });
  await assert.rejects(sandboxMcpCommand({ dataDir, id: created.id }), { code: 'SANDBOX_NOT_RUNNING' });
  assert.equal((await startSandbox({ dataDir, id: created.id })).status, 'running');
  assert.equal((await engine.read()).container.paused, false);
  // A running desktop is only checked.
  assert.equal((await startSandbox({ dataDir, id: created.id })).status, 'running');
  assert.deepEqual((await sandboxMcpCommand({ dataDir, id: created.id })).args.slice(-3), [created.containerId, '/usr/local/bin/cua-driver', 'mcp']);
});

test('a desktop that exits as it starts, publishes ports or no longer exists is not started, and its record stays as it was', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const { id } = await createSandbox({ dataDir });
  const file = join(dataDir, 'sandboxes', `${id}.json`), saved = await readFile(file, 'utf8');
  await engine.set({ container: { ...(await engine.read()).container, running: false }, exits: true });
  await assert.rejects(startSandbox({ dataDir, id }), { code: 'SANDBOX_START_FAILED' });
  // A desktop that publishes ports, as earlier versions created, is refused before Docker runs it.
  await engine.set({ exits: false, published: true });
  await assert.rejects(startSandbox({ dataDir, id }), { code: 'SANDBOX_PORTS_INVALID' });
  assert.equal((await engine.read()).container.running, false);
  await engine.set({ published: false, container: null });
  await assert.rejects(startSandbox({ dataDir, id }), { code: 'DOCKER_CONTAINER_MISSING', message: 'The sandbox container no longer exists. Create a new sandbox.' });
  assert.equal(await readFile(file, 'utf8'), saved);
});

test('a desktop started after a failed destroy keeps no stale failure in its record', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const { id } = await createSandbox({ dataDir });
  await engine.set({ down: true });
  await assert.rejects(destroySandbox({ dataDir, id }), { code: 'DOCKER_UNAVAILABLE' });
  assert.deepEqual((await listSandboxes({ dataDir })).map(record => [record.status, record.cleanupError]), [['cleanup_failed', 'The local Docker engine is unavailable.']]);
  // Docker came back without the desktop running.
  await engine.set({ down: false, container: { ...(await engine.read()).container, running: false } });
  const started = await startSandbox({ dataDir, id });
  assert.deepEqual([started.status, 'cleanupError' in started, (await listSandboxes({ dataDir }))[0].status], ['running', false, 'running']);
});

test('the CLI names sandbox start for a stopped desktop, and start prints the running desktop', async t => {
  const engine = await localEngine(t), dataDir = engine.dataDir;
  const { id } = await createSandbox({ dataDir });
  await engine.set({ container: { ...(await engine.read()).container, running: false } });
  // The CLI inherits this process's PATH and DOCKER_HOST, so it reaches the same stand-in engine.
  const sandbox = (action: string) => exec(process.execPath, [CLI, 'sandbox', action, '--id', id, '--data', dataDir], { timeout: 60_000 });
  await assert.rejects(sandbox('mcp'), { code: 1, stderr: 'The sandbox is not running. Run sandbox start.\n' });
  const { stdout } = await sandbox('start');
  assert.deepEqual([JSON.parse(stdout).id, JSON.parse(stdout).status, (await engine.read()).container.running], [id, 'running', true]);
});
