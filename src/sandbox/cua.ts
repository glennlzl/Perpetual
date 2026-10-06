import { execFile, spawn, type ExecFileException } from 'node:child_process';
import { localDockerEnvironment } from '../process.ts';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { requireRunningSandbox } from './cua-local.ts';

export { createSandbox, listSandboxes, inspectSandbox, startSandbox, destroySandbox } from './cua-local.ts';

const execute = promisify(execFile);
const integrationDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/cua');
const byteLimit = 8 * 1024 * 1024;
export const CUA_VERSIONS = Object.freeze({sandbox: '0.8.0', guestDriver: '0.28.2', reviewedCommit: '912a4550b72a770f3a21e1f3453961a9eca9de08'});

type Target = {dataDir?: unknown; id?: unknown};
/** An action as the CLI or a caller supplies it; bridge.py checks each field for its action type. */
export interface SandboxActionInput {type?: unknown; timeoutSeconds?: unknown; [field: string]: unknown}
// bridge.py validates the guest's answer before it replies, so each action's result has this shape.
export interface CommandResult {returncode: number; stdout: string; stderr: string; truncated: boolean}
interface FileContent {contentBase64: string; mimeType?: string}
export interface UploadResult {bytes: number}
interface BridgeReply {ok?: unknown; error?: unknown; result?: unknown}

function pythonEnvironment() {
  // The bridge reaches the guest only through a docker CLI pinned to the local engine with --host, so it needs no SDK
  // credentials or proxy variables, and the ambient Docker endpoint never applies.
  const env: Record<string, string | undefined> = {};
  for (const key of ['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return localDockerEnvironment({...env, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1'});
}

const dockerEnvironment = () => localDockerEnvironment();

export async function sandboxAction({dataDir, id, action: input}: Target & {action?: unknown}): Promise<unknown> {
  if (!input || typeof input !== 'object' || !('type' in input) || !(['exec', 'screenshot', 'click', 'type', 'keypress', 'upload', 'download'] as unknown[]).includes(input.type)) {
    throw new Error('Unsupported sandbox action.');
  }
  const action: SandboxActionInput = input;
  const timeoutSeconds = action.type === 'exec' ? (action.timeoutSeconds ?? 30) : 30;
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('Use a timeout from 1 to 300 seconds.');
  const sandbox = await requireRunningSandbox({dataDir, id});
  const python = process.env.PERPETUAL_CUA_PYTHON || join(integrationDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!isAbsolute(python)) throw new Error('PERPETUAL_CUA_PYTHON must be an absolute interpreter path.');
  // The desktop publishes no port: the bridge reaches its computer-server through docker exec into this verified container.
  const request = JSON.stringify({name: sandbox.name, dockerHost: sandbox.dockerHost, containerId: sandbox.containerId, action, timeoutSeconds: timeoutSeconds + 20});
  if (Buffer.byteLength(request) > 12 * 1024 * 1024) throw new Error('Sandbox request exceeds the 12 MiB limit.');
  // execFile's promisified wrapper cannot pass stdin. Keep stderr private:
  // upstream SDK logs may include guest data. Only bridge JSON is returned.
  const result = await new Promise((resolveResult, reject) => {
    const child = execFile(python, [join(integrationDir, 'bridge.py')], {
      env: pythonEnvironment(), timeout: (timeoutSeconds + 25) * 1000,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error?.code === 'ENOENT') return reject(new Error('Cua Python environment is missing. Run uv sync --project integrations/cua --frozen.'));
      if (error?.killed || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(new Error('Cua request exceeded its limit. Guest completion is unknown; inspect before retrying.'));
      }
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { return reject(new Error('Cua bridge failed. Verify the pinned SDK installation.')); }
      // A JSON null or scalar is no reply either; reading its fields would throw outside this promise.
      if (!parsed || typeof parsed !== 'object') return reject(new Error('Cua bridge failed. Verify the pinned SDK installation.'));
      const response: BridgeReply = parsed;
      if (!response.ok || error) return reject(new Error(typeof response.error === 'string' && response.error ? response.error : 'Cua request failed.'));
      resolveResult(response.result);
    });
    child.stdin!.on('error', () => {}); // Process startup failure is handled above.
    child.stdin!.end(request);
  });
  return result;
}

export async function executeSandbox({dataDir, id, command, timeoutSeconds = 30}: Target & {command?: unknown; timeoutSeconds?: unknown}) {
  return sandboxAction({dataDir, id, action: {type: 'exec', command, timeoutSeconds}}) as Promise<CommandResult>;
}

async function saveArtifact(path: string, content: Buffer) {
  if (!path) throw new Error('Choose an output file. Existing files are never overwritten.');
  const output = resolve(path);
  await writeFile(output, content, {flag: 'wx', mode: 0o600});
  return {path: output, bytes: content.length};
}

export async function screenshotSandbox({dataDir, id, output}: Target & {output?: string}) {
  if (!output) throw new Error('Choose a PNG output path.');
  const result = await sandboxAction({dataDir, id, action: {type: 'screenshot'}}) as FileContent;
  return saveArtifact(output, Buffer.from(result.contentBase64, 'base64'));
}

export async function uploadSandboxFile({dataDir, id, input, destination}: Target & {input?: string; destination?: unknown}) {
  if (!input) throw new Error('Choose one local file to upload.');
  const path = resolve(input), metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > byteLimit) throw new Error('Choose a regular file no larger than 8 MiB.');
  const content = await readFile(path);
  if (content.length > byteLimit) throw new Error('File exceeds the 8 MiB limit.');
  return sandboxAction({dataDir, id, action: {type: 'upload', path: destination, contentBase64: content.toString('base64')}}) as Promise<UploadResult>;
}

export async function downloadSandboxFile({dataDir, id, source, output}: Target & {source?: unknown; output?: string}) {
  if (!output) throw new Error('Choose an output file.');
  const result = await sandboxAction({dataDir, id, action: {type: 'download', path: source}}) as FileContent;
  return saveArtifact(output, Buffer.from(result.contentBase64, 'base64'));
}

export async function sandboxMcpCommand({dataDir, id, driverPath = '/usr/local/bin/cua-driver', user = '1000'}: Target & {driverPath?: unknown; user?: unknown}) {
  const sandbox = await requireRunningSandbox({dataDir, id});
  if (typeof driverPath !== 'string' || !driverPath.startsWith('/') || driverPath.includes('\0') || driverPath.length > 4096) throw new Error('Use an absolute guest Driver path.');
  if (typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(user)) throw new Error('Use a guest username or UID.');
  // Pin the same local Docker endpoint inspected by the lifecycle adapter.
  // No host Driver and no user-supplied container identifiers are accepted.
  const args = ['--host', sandbox.dockerHost!, 'exec', '-i', '--user', user,
    '--env', 'CUA_DRIVER_PERMISSION_MODE=standard', sandbox.containerId!, driverPath];
  const install = `Install Cua Driver ${CUA_VERSIONS.guestDriver} at the selected path inside the guest image. Host Driver fallback is disabled.`;
  let version: string;
  try {
    ({stdout: version} = await execute('docker', [...args, '--version'], {env: dockerEnvironment(), timeout: 15000, maxBuffer: 16384}));
  } catch (error) {
    const failure = error as ExecFileException;
    if (failure.killed) throw new Error('The guest Driver check timed out. Inspect the sandbox, then retry.');
    if (/unable to find user|no matching entries in passwd/i.test(String(failure.stderr))) throw new Error(`The guest has no user ${user}. Choose --user with a guest username or UID.`);
    // docker exec exits 126 or 127 when the guest cannot run the Driver path.
    if (failure.code === 126 || failure.code === 127) throw new Error(install);
    throw new Error('The guest Driver check failed. Inspect the sandbox, then retry.');
  }
  version = version.trim();
  if (version !== `cua-driver ${CUA_VERSIONS.guestDriver}`) throw new Error(/^cua-driver [\w.+-]{1,40}$/.test(version) ? `The guest has ${version}. ${install}` : install);
  return {command: 'docker', args: [...args, 'mcp']};
}

export async function runSandboxMcp(options: Parameters<typeof sandboxMcpCommand>[0]) {
  const invocation = await sandboxMcpCommand(options);
  // Transparent persistent stdio: the agent speaks MCP directly to Cua Driver.
  // The client must negotiate tools and check tool errors/video_active itself.
  return new Promise<number>((resolveCode, reject) => {
    const child = spawn(invocation.command, invocation.args, {stdio: 'inherit', env: dockerEnvironment()});
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const removeSignals = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', () => { removeSignals(); reject(new Error('Could not start guest MCP transport.')); });
    child.once('close', code => { removeSignals(); resolveCode(code ?? 1); });
  });
}
