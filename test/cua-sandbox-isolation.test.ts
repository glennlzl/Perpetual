import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CUA_VERSIONS } from '../src/sandbox/cua.ts';

// The desktop sandbox's isolation checks run against a fake `docker` on PATH, so no container starts.
const exec = promisify(execFile);
const moduleUrl = new URL('../src/sandbox/cua-local.ts', import.meta.url).href;
const integration = fileURLToPath(new URL('../integrations/cua/', import.meta.url));
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const socket = 'unix:///tmp/perpetual-sandbox-isolation-fixture.sock';
const imageId = `sha256:${'a'.repeat(64)}`, containerId = 'c'.repeat(64);
type Call = string[];
type Outcome = { code?: string; message?: string; record?: Record<string, unknown> };

/** A data directory holding one running sandbox record, and a fake Docker engine that reports `container`. */
async function sandboxFixture(t: TestContext, container: (ids: { id: string; ownerId: string }) => object | null, record: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-sandbox-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID(), ownerId = randomUUID(), store = join(directory, 'data', 'sandboxes');
  await mkdir(store, { recursive: true, mode: 0o700 });
  await writeFile(join(store, '.owner.json'), JSON.stringify({ version: 1, ownerId }), { mode: 0o600 });
  await writeFile(join(store, `${id}.json`), JSON.stringify({
    version: 1, id, ownerId, name: `perpetual-cua-${id}`, status: 'running', image: 'example/desktop:1', imageId, containerId,
    apiUrl: 'http://127.0.0.1:41000', desktopUrl: 'http://127.0.0.1:41001/', dockerHost: socket,
    resources: { cpus: 2, memoryMiB: 4096, pids: 1024, shmMiB: 512 }, createdAt: new Date().toISOString(), persistence: 'manual', ...record,
  }), { mode: 0o600 });
  await writeFile(join(directory, 'state.json'), JSON.stringify({ container: container({ id, ownerId }) }));
  await writeFile(join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const statePath = path.join(__dirname, 'state.json'), state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const command = args.slice(2).join(' ');
if (args[0] === 'context' && args[1] === 'inspect') process.stdout.write(JSON.stringify(state.contextHost) + '\\n');
else if (args[0] !== '--host' || args[1] !== ${JSON.stringify(socket)}) process.exitCode = 81;
else if (command === 'info --format {{.OSType}}') process.stdout.write('linux\\n');
else if (command.startsWith('container inspect ')) {
  if (state.container) process.stdout.write(JSON.stringify([state.container]));
  else { process.stderr.write('Error: No such container: ' + args[4] + '\\n'); process.exitCode = 1; }
} else if (command.startsWith('container rm ')) fs.writeFileSync(statePath, JSON.stringify({ ...state, container: null }));
else { process.stderr.write('Unexpected Docker fixture command'); process.exitCode = 82; }
`, { mode: 0o700 });
  /** Runs one adapter operation in a child whose PATH finds the fake engine, and returns its record or error. */
  async function run(operation: 'localDocker' | 'inspectSandbox' | 'destroySandbox', env: NodeJS.ProcessEnv = { DOCKER_HOST: socket }): Promise<Outcome> {
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}:${process.env.PATH}`, ...env };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT']) if (!env[key]) delete environment[key];
    const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `
      const adapter = await import(${JSON.stringify(moduleUrl)});
      const [operation, input] = [process.argv[1], JSON.parse(process.argv[2])];
      try { process.stdout.write(JSON.stringify({ record: await (operation === 'localDocker' ? adapter.localDocker() : adapter[operation](input)) })); }
      catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
    `, operation, JSON.stringify({ dataDir: join(directory, 'data'), id })], { env: environment, timeout: 20000 });
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  }
  const calls = async (): Promise<Call[]> => (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const saved = async () => JSON.parse(await readFile(join(store, `${id}.json`), 'utf8'));
  const state = async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  return { id, run, calls, saved, state, setContextHost: async (host: string) => writeFile(join(directory, 'state.json'), JSON.stringify({ ...await state(), contextHost: host })) };
}

/** A container this sandbox owns, as `docker container inspect` reports it, with its ports bound to loopback. */
const owned = ({ id, ownerId }: { id: string; ownerId: string }, { running = false, published = '127.0.0.1', configured = '127.0.0.1', owner = ownerId } = {}) => ({
  Id: containerId, Name: `/perpetual-cua-${id}`, Image: imageId,
  Config: { Labels: { 'perpetual.managed': 'true', 'perpetual.owner': owner, 'perpetual.sandbox': id } },
  State: { Running: running, Paused: false, Restarting: false },
  NetworkSettings: { Ports: running ? { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '41000' }], '6080/tcp': [{ HostIp: published, HostPort: '41001' }] } : {} },
  HostConfig: {
    Privileged: false, NetworkMode: 'bridge', Binds: null, NanoCpus: 2_000_000_000, Memory: 4096 * 1024 * 1024, PidsLimit: 1024, PublishAllPorts: false,
    PortBindings: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }], '6080/tcp': [{ HostIp: configured, HostPort: '' }] },
  },
  Mounts: [],
});

test('the sandbox adapter refuses a remote Docker endpoint before it sends the engine any command', async t => {
  const fixture = await sandboxFixture(t, ids => owned(ids));
  for (const host of ['tcp://203.0.113.10:2376', 'ssh://builder@example.test']) {
    assert.equal((await fixture.run('localDocker', { DOCKER_HOST: host })).code, 'DOCKER_REMOTE_UNSUPPORTED', host);
  }
  assert.deepEqual(await fixture.calls(), []);
  // A context that names a remote engine is refused the same way, after reading only the context.
  await fixture.setContextHost('ssh://builder@example.test');
  assert.equal((await fixture.run('localDocker', { DOCKER_CONTEXT: 'remote-fixture' })).code, 'DOCKER_REMOTE_UNSUPPORTED');
  assert.deepEqual(await fixture.calls(), [['context', 'inspect', 'remote-fixture', '--format', '{{json .Endpoints.docker.Host}}']]);
});

test('a sandbox record that another data directory owns is refused before Docker is asked', async t => {
  const fixture = await sandboxFixture(t, ids => owned(ids), { ownerId: randomUUID() });
  assert.equal((await fixture.run('inspectSandbox')).code, 'SANDBOX_OWNERSHIP');
  assert.equal((await fixture.run('destroySandbox')).code, 'SANDBOX_OWNERSHIP');
  assert.deepEqual(await fixture.calls(), []);
});

test('destroy leaves a container that carries another owner’s label and records the refusal', async t => {
  const fixture = await sandboxFixture(t, ids => owned(ids, { owner: randomUUID() }));
  const failure = await fixture.run('destroySandbox');
  assert.equal(failure.code, 'SANDBOX_OWNERSHIP');
  assert.ok((await fixture.calls()).every(call => !call.includes('rm')), 'No foreign container is deleted.');
  assert.ok((await fixture.state()).container, 'The foreign container is left in place.');
  const record = await fixture.saved();
  assert.equal(record.status, 'cleanup_failed');
  assert.equal(record.cleanupError, failure.message);
});

test('inspect refuses a desktop whose ports are configured or published beyond loopback', async t => {
  for (const ports of [{ configured: '0.0.0.0' }, { running: true, published: '0.0.0.0' }]) {
    const fixture = await sandboxFixture(t, ids => owned(ids, ports));
    assert.equal((await fixture.run('inspectSandbox')).code, 'SANDBOX_PORTS_INVALID', JSON.stringify(ports));
    assert.equal((await fixture.saved()).apiUrl, 'http://127.0.0.1:41000', 'A refused inspection saves no address.');
  }
});

test('destroy removes exactly the owned container and reports deletion only once Docker no longer has it', async t => {
  const fixture = await sandboxFixture(t, ids => owned(ids));
  const { record } = await fixture.run('destroySandbox');
  const inspect = ['--host', socket, 'container', 'inspect', `perpetual-cua-${fixture.id}`];
  assert.deepEqual(await fixture.calls(), [
    ['--host', socket, 'info', '--format', '{{.OSType}}'], inspect,
    ['--host', socket, 'container', 'rm', '--force', '--volumes', containerId], inspect,
  ]);
  assert.equal(record?.status, 'destroyed');
  assert.equal(record?.apiUrl, undefined, 'A desktop keeps no host address.');
  assert.equal((await fixture.saved()).status, 'destroyed');
});

test('the SDK bridge reaches only a Perpetual desktop container, through the local Docker engine', async t => {
  // Stand-ins for the pinned SDK and httpx, so the bridge's own checks run without either installed.
  const script = `
import asyncio, importlib.metadata, json, sys, types
sys.path.insert(0, sys.argv[1])
import bridge
class Sandbox:
    created = 0
    def __init__(self, transport, name, _telemetry_enabled): Sandbox.created += 1
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return False
class Transport:
    def __init__(self, *args, **kwargs): pass
for name, values in {"httpx": {"Timeout": lambda *args, **kwargs: None}, "cua_sandbox": {"Sandbox": Sandbox},
                     "cua_sandbox.transport": {}, "cua_sandbox.transport.http": {"HTTPTransport": Transport}}.items():
    module = types.ModuleType(name)
    module.__dict__.update(values)
    sys.modules[name] = module
importlib.metadata.version = lambda name: bridge.SDK_VERSION
def outcome(**fields):
    request = {"dockerHost": "unix:///var/run/docker.sock", "containerId": "c" * 64, "name": "perpetual-cua-desktop", "action": {"type": "screenshot"}}
    request.update(fields)
    try: asyncio.run(bridge.dispatch(request)); return "accepted"
    except bridge.BridgeError as error: return str(error)
result = {"engines": [outcome(dockerHost=host) for host in ["tcp://127.0.0.1:2375", "ssh://user@example.test", "unix://docker.sock", "", None]],
          "containers": [outcome(containerId=value) for value in ["", "C" * 64, "c" * 63, "../" + "c" * 61, 5]],
          "name": outcome(name="desktop")}
importlib.metadata.version = lambda name: "0.0.0"
result.update(created=Sandbox.created, version=outcome())
print(json.dumps(result))
`;
  let stdout: string;
  try { ({ stdout } = await exec('python3', ['-c', script, integration], { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20000 })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('python3 is not installed.'); return; } throw error; }
  const result = JSON.parse(stdout) as { engines: string[]; containers: string[]; name: string; created: number; version: string };
  assert.deepEqual(new Set(result.engines), new Set(['A local Docker engine is required.']));
  assert.deepEqual(new Set(result.containers), new Set(['A sandbox container ID is required.']));
  assert.equal(result.name, 'A Perpetual sandbox name is required.');
  assert.equal(result.created, 0, 'A refused request connects to no desktop.');
  // The refusal names the version the adapter pins, so a bump that leaves its text behind fails here.
  assert.ok(result.version.startsWith(`Expected cua-sandbox ${CUA_VERSIONS.sandbox};`), result.version);
});

test('the Cua versions the adapter names are the ones its Python environment, guest image and docs pin', async () => {
  const [pyproject, lock, bridge, dockerfile, docs] = await Promise.all([
    read('integrations/cua/pyproject.toml'), read('integrations/cua/uv.lock'), read('integrations/cua/bridge.py'),
    read('integrations/cua/Dockerfile'), read('docs/desktop-sandbox.md'),
  ]);
  assert.match(pyproject, new RegExp(`"cua-sandbox==${CUA_VERSIONS.sandbox.replaceAll('.', '\\.')}"`));
  assert.equal(/\[\[package\]\]\nname = "cua-sandbox"\nversion = "([^"]+)"/.exec(lock)?.[1], CUA_VERSIONS.sandbox);
  assert.equal(/^SDK_VERSION = "([^"]+)"$/m.exec(bridge)?.[1], CUA_VERSIONS.sandbox);
  assert.equal(/cua-driver==(\S+)/.exec(dockerfile)?.[1], CUA_VERSIONS.guestDriver);
  for (const pin of [`SDK ${CUA_VERSIONS.sandbox}`, `Driver ${CUA_VERSIONS.guestDriver}`, `commit ${CUA_VERSIONS.reviewedCommit}`]) assert.ok(docs.includes(pin), pin);
});
