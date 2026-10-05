import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('../integrations/cua/bridge.py', import.meta.url));
const relay = fileURLToPath(new URL('../integrations/cua/relay.py', import.meta.url));
// The bridge and the relay it runs in the guest need only the standard library; the browser runtime's locked Python
// runs both. The two cua-sandbox 0.8.0 entry points the bridge uses are stood in for below, so its own checks of
// computer-server's replies are what runs.
const python = fileURLToPath(new URL('../integrations/browser-use/.venv/bin/python', import.meta.url));
const GUEST_PYTHON = '/opt/computer-server/venv/bin/python';
const SDK: Record<string, string> = {
  'cua_sandbox-0.8.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: cua-sandbox\nVersion: 0.8.0\n',
  'cua_sandbox/__init__.py': `from types import SimpleNamespace


class Sandbox:
    def __init__(self, transport, name=None, _telemetry_enabled=True):
        self._transport = transport
        self.shell = SimpleNamespace(run=self._run)

    async def __aenter__(self):
        await self._transport.connect()
        return self

    async def __aexit__(self, *_):
        await self._transport.disconnect()

    async def _run(self, command, timeout=30):
        # As the SDK's shell reads a run_command reply.
        result = await self._transport.send("run_command", command=command, timeout=timeout)
        return SimpleNamespace(stdout=result.get("stdout", ""), stderr=result.get("stderr", ""), returncode=result.get("returncode", result.get("return_code", -1)))
`,
  'cua_sandbox/transport/__init__.py': '',
  'cua_sandbox/transport/http.py': `class HTTPTransport:
    def __init__(self, base_url):
        self._base_url, self._client = base_url.rstrip("/"), None

    async def send(self, action, **params):
        result = await self._cmd(action, params or None)
        return result.get("result", result)
`,
};

// A docker CLI stand-in for one desktop: it records each call and runs the guest command on this machine, where the
// computer-server stand-in listens on another port than the guest's 8000.
const dockerStandIn = (port: number) => `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const guest = args.slice(args.indexOf(${JSON.stringify(GUEST_PYTHON)}) + 1);
if (guest[3] === '8000') guest[3] = '${port}';
spawn(${JSON.stringify(python)}, guest, { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));
`;

function runPython(args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = execFile(python, args, { env, timeout: 60000 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout, code: error ? Number(error.code) : 0 });
    });
    child.stdin!.end(input);
  });
}

/** A computer-server stand-in on this machine's loopback; `answer` replies to each request it records. */
async function computerServer(t: TestContext, answer: (response: ServerResponse) => void) {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { requests.push({ method: request.method, url: request.url, body }); answer(response); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, requests };
}

const sse = (reply: object) => (response: ServerResponse) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.end(`data: ${JSON.stringify(reply)}\n\n`);
};
const COMMAND = { method: 'POST', url: '/cmd', body: { command: 'run_command', params: { command: 'make build | tee build.log', timeout: 5 } } };
const sent = (requests: { method?: string; url?: string; body: string }[]) => requests.map(request => ({ ...request, body: JSON.parse(request.body) }));

/** Runs one exec action through the bridge, against a desktop whose computer-server answers with `answer`. */
async function execThroughBridge(t: TestContext, answer: (response: ServerResponse) => void, request: object = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-cua-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(SDK)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const server = await computerServer(t, answer), bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), dockerStandIn(server.port), { mode: 0o700 });
  const dockerHost = `unix://${join(directory, 'docker.sock')}`, containerId = randomBytes(32).toString('hex');
  const input = { name: `perpetual-cua-${randomUUID()}`, dockerHost, containerId, action: { type: 'exec', command: 'make build | tee build.log', timeoutSeconds: 5 }, timeoutSeconds: 30, ...request };
  const { stdout, code } = await runPython([bridge], JSON.stringify(input), { PATH: `${bin}:${process.env.PATH}`, PYTHONPATH: directory, PYTHONDONTWRITEBYTECODE: '1' });
  const calls = await readFile(join(bin, 'calls.jsonl'), 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []);
  return { reply: JSON.parse(stdout), code, requests: server.requests, calls, dockerHost, containerId };
}

test('a guest command that did not finish is never reported as a guest exit', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  // computer-server's answer when it stops a command at its time limit: the shell is killed, its children may still run.
  const { reply, code, requests } = await execThroughBridge(t, sse({ success: false, stdout: '', stderr: 'Command timed out after 5s', return_code: -1 }));
  assert.equal(code, 1);
  assert.deepEqual(reply, { ok: false, error: 'The guest command did not finish, for example at its time limit; its outcome is unknown.' });
  assert.deepEqual(sent(requests), [COMMAND], 'The bridge sends one command and never repeats it');
});

test('a command that exited nonzero in the guest is reported with its exit code, through docker exec', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  const { reply, code, requests, calls, dockerHost, containerId } = await execThroughBridge(t, sse({ success: true, stdout: 'compiled\n', stderr: 'one test failed\n', return_code: 2 }));
  assert.equal(code, 0);
  assert.deepEqual(reply, { ok: true, result: { returncode: 2, stdout: 'compiled\n', stderr: 'one test failed\n', truncated: false } });
  // The relay runs in the desktop as the guest's UID, with computer-server's Python, and reaches it on the guest's port.
  assert.deepEqual(calls, [['--host', dockerHost, 'exec', '-i', '--user', '1000', containerId, GUEST_PYTHON, '-I', '-c', await readFile(relay, 'utf8'), '8000', 'POST', '/cmd', '15.0']]);
  assert.deepEqual(sent(requests), [COMMAND]);
});

test('a command computer-server answers with an error is reported once and never sent again', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  const { reply, code, requests } = await execThroughBridge(t, response => { response.statusCode = 500; response.end(); });
  assert.equal(code, 1);
  assert.deepEqual(reply, { ok: false, error: 'computer-server did not answer inside the desktop. Guest completion may be unknown; inspect it before retrying.' });
  assert.deepEqual(sent(requests), [COMMAND], 'The bridge sends one command and never repeats it');
});

test('the bridge reaches a desktop only through a local Docker engine', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  const { reply, calls, requests } = await execThroughBridge(t, sse({}), { dockerHost: 'tcp://127.0.0.1:2375' });
  assert.deepEqual([reply, calls, requests], [{ ok: false, error: 'A local Docker engine is required.' }, [], []]);
});

test('the guest relay reports readiness only when computer-server answers 200', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  const source = await readFile(relay, 'utf8');
  const status = (port: number) => runPython(['-I', '-c', source, String(port), 'GET', '/status', '3'], '', { PATH: process.env.PATH });
  const ready = await computerServer(t, response => response.end('{"status":"ok"}'));
  const starting = await computerServer(t, response => { response.statusCode = 503; response.end(); });
  assert.deepEqual(await status(ready.port), { stdout: '{"status":"ok"}', code: 0 });
  assert.deepEqual(await status(starting.port), { stdout: '', code: 3 });
  assert.deepEqual([...ready.requests, ...starting.requests].map(({ method, url }) => [method, url]), [['GET', '/status'], ['GET', '/status']]);
  // Nothing listens yet while the desktop starts.
  const vacant = createServer();
  await new Promise<void>(resolve => vacant.listen(0, '127.0.0.1', resolve));
  const address = vacant.address();
  assert.ok(address && typeof address === 'object');
  await new Promise(resolve => vacant.close(resolve));
  assert.deepEqual(await status(address.port), { stdout: '', code: 3 });
});
