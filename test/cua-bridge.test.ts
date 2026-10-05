import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('../integrations/cua/bridge.py', import.meta.url));
// The bridge needs only httpx from its SDK environment, which the browser runtime also locks. The two cua-sandbox
// 0.8.0 entry points it uses are stood in for below, so its own checks of computer-server's replies are what runs.
const python = fileURLToPath(new URL('../integrations/browser-use/.venv/bin/python', import.meta.url));
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
  'cua_sandbox/transport/http.py': `import httpx


class HTTPTransport:
    def __init__(self, base_url):
        self._base_url, self._client = base_url.rstrip("/"), None

    async def connect(self):
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=30)

    async def disconnect(self):
        await self._client.aclose()

    async def send(self, action, **params):
        result = await self._cmd(action, params or None)
        return result.get("result", result)
`,
};

/** Runs one exec through the bridge against a computer-server stand-in that answers run_command with `reply`. */
async function execThroughBridge(t: TestContext, reply: object) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-cua-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(SDK)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const commands: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      commands.push(JSON.parse(body));
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(reply)}\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = { name: `perpetual-cua-${randomUUID()}`, apiUrl: `http://127.0.0.1:${address.port}`, action: { type: 'exec', command: 'make build | tee build.log', timeoutSeconds: 5 }, timeoutSeconds: 30 };
  const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = execFile(python, [bridge], { env: { PATH: process.env.PATH, PYTHONPATH: directory, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60000 }, (error, output) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: output, code: error ? Number(error.code) : 0 });
    });
    child.stdin!.end(JSON.stringify(request));
  });
  assert.deepEqual(commands, [{ command: 'run_command', params: { command: request.action.command, timeout: 5 } }], 'The bridge sends one command and never repeats it');
  return { reply: JSON.parse(stdout), code };
}

test('a guest command that did not finish is never reported as a guest exit', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  // computer-server's answer when it stops a command at its time limit: the shell is killed, its children may still run.
  const { reply, code } = await execThroughBridge(t, { success: false, stdout: '', stderr: 'Command timed out after 5s', return_code: -1 });
  assert.equal(code, 1);
  assert.deepEqual(reply, { ok: false, error: 'The guest command did not finish, for example at its time limit; its outcome is unknown.' });
});

test('a command that exited nonzero in the guest is reported with its exit code', async t => {
  try { await access(python); } catch { t.skip('Optional local Python browser runtime is not installed.'); return; }
  const { reply, code } = await execThroughBridge(t, { success: true, stdout: 'compiled\n', stderr: 'one test failed\n', return_code: 2 });
  assert.equal(code, 0);
  assert.deepEqual(reply, { ok: true, result: { returncode: 2, stdout: 'compiled\n', stderr: 'one test failed\n', truncated: false } });
});
