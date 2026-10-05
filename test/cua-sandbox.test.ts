import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, destroySandbox, inspectSandbox, listSandboxes, sandboxMcpCommand } from '../src/sandbox/cua.ts';

// A docker CLI stand-in for one owned desktop on a local socket. It keeps its engine's state in state.json; no container
// starts. Its computer-server is a local HTTP server that answers the readiness check.
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
const [command, ...rest] = args.slice(2);
const option = name => rest[rest.indexOf(name) + 1];
const container = state.container;
if (command === 'info') process.stdout.write('linux\\n');
else if (command === 'image' && rest[0] === 'inspect') process.stdout.write(JSON.stringify([{ Id: state.imageId, Os: 'linux' }]));
else if (command === 'container' && rest[0] === 'create') {
  const labels = Object.fromEntries(rest.flatMap((arg, index) => arg === '--label' ? [rest[index + 1].split('=')] : []));
  state.container = { Id: randomBytes(32).toString('hex'), Name: '/' + option('--name'), Image: rest.at(-1), Config: { Labels: labels }, running: false,
    cpus: Number(option('--cpus')), memoryMiB: parseInt(option('--memory'), 10), pids: Number(option('--pids-limit')) };
  save();
  process.stdout.write(state.container.Id + '\\n');
} else if (command === 'container' && rest[0] === 'inspect') {
  if (!container || (rest[1] !== container.Id && '/' + rest[1] !== container.Name)) fail('Error response from daemon: No such container: ' + rest[1]);
  const published = { HostIp: '127.0.0.1', HostPort: String(state.apiPort) }, requested = { HostIp: '127.0.0.1', HostPort: '' };
  process.stdout.write(JSON.stringify([{ Id: container.Id, Name: container.Name, Image: container.Image, Config: container.Config,
    State: { Running: container.running, Paused: false, Restarting: false },
    NetworkSettings: { Ports: container.running ? { '8000/tcp': [published], '6080/tcp': [published] } : {} },
    HostConfig: { NetworkMode: 'bridge', NanoCpus: container.cpus * 1e9, Memory: container.memoryMiB * 1024 * 1024, PidsLimit: container.pids,
      PortBindings: { '8000/tcp': [requested], '6080/tcp': [requested] } }, Mounts: [] }]));
} else if (command === 'container' && rest[0] === 'start') { container.running = true; save(); }
else if (command === 'container' && rest[0] === 'rm') { delete state.container; save(); }
else if (command === 'exec') {
  process.stdout.write(state.exec.stdout || '');
  process.stderr.write(state.exec.stderr || '');
  process.exit(state.exec.code || 0);
} else fail('Unexpected Docker fixture command', 82);
`;

async function localEngine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-cua-sandbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = createServer((request, response) => { response.statusCode = request.url === '/status' ? 200 : 404; response.end(); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => api.close());
  const address = api.address();
  assert.ok(address && typeof address === 'object');
  const socket = `unix://${join(directory, 'docker.sock')}`, state = join(directory, 'state.json');
  await writeFile(state, JSON.stringify({ socket, apiPort: address.port, imageId: `sha256:${'a'.repeat(64)}`, exec: { stdout: 'cua-driver 0.28.2\n' } }));
  await writeFile(join(directory, 'docker'), DOCKER, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.DOCKER_HOST = socket;
  delete process.env.DOCKER_CONTEXT;
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  return {
    dataDir: join(directory, 'data'),
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
