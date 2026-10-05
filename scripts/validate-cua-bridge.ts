// Opt-in acceptance for one existing owned guest. Importing never starts work; running it validates one guest:
//   node scripts/validate-cua-bridge.ts --id ID --output DIR [--data DIR]
import { spawn } from 'node:child_process';
import { localDockerEnvironment } from '../src/process.ts';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  executeSandbox, screenshotSandbox, uploadSandboxFile,
  downloadSandboxFile, sandboxMcpCommand,
} from '../src/sandbox/cua.ts';

type BridgeError = Error & { bridgeValidation: true; report?: BridgeReport };
// Guest MCP replies are untrusted: these views name the fields read, and each is checked before its value is used.
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; error?: unknown; result?: unknown };
type ToolSchema = { type?: unknown; required?: unknown; minProperties?: unknown };
type ListedTool = { name?: unknown; inputSchema?: ToolSchema | null; annotations?: unknown };
type ContentItem = { type?: unknown; text?: unknown; data?: unknown };
type ToolResult = { isError?: unknown; structuredContent?: unknown; content?: unknown };
type ScreenSize = { width: number; height: number; scale_factor: number };
interface DiscoveredTool { name: string; inputSchema: ToolSchema; annotations?: unknown }
interface PendingRequest { resolve(result: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }
type McpSession = ReturnType<typeof mcpSession>;
interface ReadOnlyCall {
  name: string; status: 'not-run' | 'failed' | 'passed'; reason?: string; arguments?: Record<string, never>;
  isErrorFieldPresent?: boolean; isError?: boolean; dimensions?: { width: number; height: number; scaleFactor: number }; resultPath?: string;
}
interface McpEvidence { protocolVersion?: string; toolCount?: number; toolNames?: string[]; schemasPath?: string; scope?: string; readOnlyCalls?: ReadOnlyCall[] }
interface BridgeReport {
  status: 'running' | 'passed' | 'failed'; startedAt: string; sandboxId: unknown; output: string; reportPath: string;
  checks: { name: string; status: 'passed' | 'failed'; [detail: string]: unknown }[]; mcp?: McpEvidence; error?: string; cleanupError?: string; completedAt?: string;
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const ownError = (message: string): BridgeError => Object.assign(new Error(message), { bridgeValidation: true as const });
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw ownError(message); }
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const safeFailure = (error: unknown) => (error as Partial<BridgeError> | null | undefined)?.bridgeValidation ? (error as BridgeError).message : 'The owned guest adapter did not complete this check. Inspect its readiness and pinned dependencies.';

function mcpSession(invocation: { command: string; args: string[] }) {
  const child = spawn(invocation.command, invocation.args, { env: localDockerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<unknown, PendingRequest>();
  const decoder = new StringDecoder('utf8');
  let buffer = '', outputBytes = 0, stderrBytes = 0, nextId = 0, failure: BridgeError | undefined, closed = false;
  const ended = new Promise<void>(resolveEnded => child.once('close', () => { closed = true; resolveEnded(); }));

  function fail(message: string) {
    failure ??= ownError(message);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
    pending.clear();
    child.stdin.end();
  }
  function send(message: object) {
    if (failure) throw failure;
    if (closed || child.stdin.destroyed) throw ownError('The guest MCP transport closed unexpectedly.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  child.once('error', () => fail('The guest MCP transport could not start.'));
  child.once('close', () => {
    if (pending.size) fail('The guest MCP transport exited before returning its response.');
  });
  child.stdin.on('error', () => fail('The guest MCP input stream closed unexpectedly.'));
  // Driver diagnostics may contain guest data. Drain them without retaining or
  // printing raw output, while still bounding a noisy process.
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > RESPONSE_LIMIT) fail('The guest MCP diagnostics exceeded their output limit.');
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > RESPONSE_LIMIT) return fail('The guest MCP responses exceeded their output limit.');
    buffer += decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return fail('The guest MCP transport returned invalid JSON.'); }
      const message: JsonRpcMessage | null = parsed !== null && typeof parsed === 'object' ? parsed : null;
      if (!message || message.jsonrpc !== '2.0') return fail('The guest MCP transport returned an invalid JSON-RPC message.');
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          try { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This validation client does not support server requests.' } }); }
          catch { return; }
        }
        continue;
      }
      const request = pending.get(message.id);
      if (!request) return fail('The guest MCP transport returned an unknown response ID.');
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error || !Object.hasOwn(message, 'result')) request.reject(ownError('The guest MCP server rejected a protocol request.'));
      else request.resolve(message.result);
    }
  });
  const lifetime = setTimeout(() => fail('Guest MCP validation exceeded its 45-second limit.'), 45000);
  const waitForExit = (milliseconds: number) => new Promise<boolean>(resolveWait => {
    const timer = setTimeout(() => resolveWait(false), milliseconds);
    ended.then(() => { clearTimeout(timer); resolveWait(true); });
  });
  return {
    notify(method: string) { send({ jsonrpc: '2.0', method }); },
    request(method: string, params: object): Promise<unknown> {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => fail('A guest MCP response exceeded its 15-second limit.'), 15000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    async close() {
      clearTimeout(lifetime);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(ownError('Guest MCP validation closed.')); }
      pending.clear();
      child.stdin.end();
      if (closed || await waitForExit(2000)) return;
      child.kill('SIGTERM');
      if (await waitForExit(1000)) return;
      child.kill('SIGKILL');
      ensure(await waitForExit(1000), 'The guest MCP client process could not be stopped.');
    },
  };
}

function acceptsEmptyArguments(schema: ToolSchema | null | undefined) {
  // Do not infer defaults or satisfy references/conditional schemas by guess.
  return schema?.type === 'object' && (schema.required === undefined
    || Array.isArray(schema.required) && schema.required.length === 0)
    && (schema.minProperties === undefined || schema.minProperties === 0)
    && !['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'].some(key => Object.hasOwn(schema, key));
}

async function validateReadOnlyTools(session: McpSession, tools: DiscoveredTool[], output: string, evidence: McpEvidence) {
  evidence.readOnlyCalls = [];
  for (const name of ['get_screen_size', 'get_desktop_state']) {
    const tool = tools.find(item => item.name === name);
    const entry: ReadOnlyCall = { name, status: 'not-run' };
    evidence.readOnlyCalls.push(entry);
    if (!tool || !acceptsEmptyArguments(tool.inputSchema)) {
      entry.reason = tool ? 'The discovered input schema does not confirm that empty arguments are valid.' : 'The tool was not discovered.';
      ensure(name !== 'get_screen_size', 'Screen-size validation requires a discovered get_screen_size tool with no required arguments.');
      continue;
    }
    entry.arguments = {};
    entry.status = 'failed';
    const result = await session.request('tools/call', { name, arguments: {} }) as ToolResult | null | undefined;
    // The pinned Driver omits isError on successful ToolResult responses.
    // Preserve this distinction; never rewrite an actual tool error as false.
    entry.isErrorFieldPresent = result != null && Object.hasOwn(result, 'isError');
    if (entry.isErrorFieldPresent && typeof result!.isError === 'boolean') entry.isError = result!.isError;
    ensure(result && typeof result === 'object' && !Array.isArray(result)
      && (result.isError === undefined || result.isError === false), 'The guest MCP read-only observation returned a tool error.');
    if (name === 'get_screen_size') {
      const size = result.structuredContent as ScreenSize | null | undefined;
      ensure(size && Number.isSafeInteger(size.width) && size.width > 0
        && Number.isSafeInteger(size.height) && size.height > 0
        && typeof size.scale_factor === 'number' && Number.isFinite(size.scale_factor) && size.scale_factor > 0,
      'The guest MCP screen-size response did not provide valid measured dimensions.');
      entry.dimensions = { width: size.width, height: size.height, scaleFactor: size.scale_factor };
    } else {
      const hasContent = Array.isArray(result.content) && result.content.some((item: ContentItem | null) => item?.type === 'text'
        ? typeof item.text === 'string' && item.text.trim().length > 0
        : item?.type === 'image' && typeof item.data === 'string' && item.data.length > 0);
      const hasState = result.structuredContent && typeof result.structuredContent === 'object'
        && !Array.isArray(result.structuredContent) && Object.keys(result.structuredContent).length > 0;
      ensure(hasContent || hasState, 'The guest MCP desktop observation returned no state or content.');
    }
    entry.resultPath = join(output, `mcp-${name}.json`);
    await writeFile(entry.resultPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    entry.status = 'passed';
  }
}

async function validateMcp(context: Parameters<typeof sandboxMcpCommand>[0], output: string, evidence: McpEvidence) {
  const session = mcpSession(await sandboxMcpCommand(context));
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'perpetual-bridge-validation', version: '0.1.0' },
    }) as { protocolVersion?: unknown; capabilities?: { tools?: unknown } | null } | null;
    ensure(initialized && typeof initialized.protocolVersion === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(initialized.protocolVersion)
      && initialized.capabilities?.tools && typeof initialized.capabilities.tools === 'object',
    'The guest MCP initialization did not advertise a valid tools capability.');
    session.notify('notifications/initialized');
    const names: string[] = [], tools: DiscoveredTool[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await session.request('tools/list', cursor ? { cursor } : {}) as { tools?: unknown; nextCursor?: unknown } | null;
      ensure(result && Array.isArray(result.tools), 'The guest MCP tool list was malformed.');
      for (const tool of result.tools as (ListedTool | null)[]) {
        ensure(tool && typeof tool.name === 'string' && /^[A-Za-z0-9_./:-]{1,200}$/.test(tool.name)
          && tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
          && tool.inputSchema.type === 'object', 'A discovered guest MCP tool had an invalid name or input schema.');
        ensure(!names.includes(tool.name), 'The guest MCP tool list contained duplicate tool names.');
        names.push(tool.name);
        tools.push({ name: tool.name, inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}) });
      }
      ensure(names.length <= 1000, 'The guest MCP tool list exceeded the validation limit.');
      if (result.nextCursor === undefined) {
        ensure(names.length > 0, 'The guest MCP server exposed no tools.');
        Object.assign(evidence, { protocolVersion: initialized.protocolVersion, toolCount: names.length, toolNames: names,
          schemasPath: join(output, 'mcp-tool-schemas.json'),
          scope: 'Protocol initialization, discovered schemas and allowlisted read-only guest observations; no input actions or permission changes.' });
        await writeFile(evidence.schemasPath!, JSON.stringify({ protocolVersion: initialized.protocolVersion, tools }, null, 2), { flag: 'wx', mode: 0o600 });
        await validateReadOnlyTools(session, tools, output, evidence);
        return;
      }
      ensure(typeof result.nextCursor === 'string' && result.nextCursor.length > 0
        && result.nextCursor.length <= 2048 && !cursors.has(result.nextCursor), 'The guest MCP tool pagination cursor was invalid.');
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw ownError('The guest MCP tool list exceeded eight pages.');
  } finally { await session.close(); }
}

/** Validate existing SDK/Driver transports; does not create or destroy a guest. */
export async function validateCuaBridge({ dataDir, id, output }: { dataDir?: unknown; id?: unknown; output?: unknown }) {
  ensure(typeof output === 'string' && output.trim(), 'Choose a bridge validation output directory.');
  await mkdir(resolve(output), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(resolve(output), 'cua-bridge-'));
  const context = { dataDir, id };
  const guestFile = `/tmp/perpetual-bridge-${randomUUID()}.bin`;
  const reportPath = join(directory, 'report.json');
  const report: BridgeReport = { status: 'running', startedAt: new Date().toISOString(), sandboxId: id, output: directory, reportPath, checks: [] };
  let stage = 'SDK shell', guestFileAttempted = false;
  const record = (name: string, details: object = {}) => report.checks.push({ name, status: 'passed', ...details });
  try {
    const shell = await executeSandbox({ ...context, command: "printf 'perpetual-bridge-stdout'; printf 'perpetual-bridge-stderr' >&2", timeoutSeconds: 10 });
    ensure(shell.returncode === 0 && shell.stdout === 'perpetual-bridge-stdout'
      && shell.stderr === 'perpetual-bridge-stderr' && shell.truncated === false,
    'Guest shell did not preserve the expected stdout, stderr and zero exit code.');
    record(stage);

    stage = 'SDK nonzero shell exit';
    const failed = await executeSandbox({ ...context, command: "printf 'perpetual-bridge-exit-seven' >&2; exit 7", timeoutSeconds: 10 });
    ensure(failed.returncode === 7 && failed.stdout === '' && failed.stderr === 'perpetual-bridge-exit-seven'
      && failed.truncated === false, 'Guest shell did not preserve the deliberate exit code 7.');
    record(stage, { returncode: 7 });

    stage = 'SDK single-file roundtrip';
    const content = Buffer.concat([Buffer.from('Perpetual synthetic transfer fixture\n就绪\n'), Buffer.from([0, 1, 127, 128, 255])]);
    const input = join(directory, 'upload.bin'), downloaded = join(directory, 'download.bin');
    await writeFile(input, content, { flag: 'wx', mode: 0o600 });
    guestFileAttempted = true;
    const upload = await uploadSandboxFile({ ...context, input, destination: guestFile });
    ensure(upload.bytes === content.length, 'The guest upload did not confirm the complete file length.');
    await downloadSandboxFile({ ...context, source: guestFile, output: downloaded });
    ensure((await readFile(downloaded)).equals(content), 'The guest single-file roundtrip did not preserve exact bytes.');
    record(stage, { bytes: content.length, sha256: sha256(content), input, downloaded });

    stage = 'SDK guest screenshot';
    const screenshot = await screenshotSandbox({ ...context, output: join(directory, 'guest-screenshot.png') });
    const bytes = await readFile(screenshot.path);
    ensure(bytes.length > 24 && bytes.subarray(0, 8).equals(PNG)
      && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'The guest screenshot did not contain a valid PNG header and dimensions.');
    record(stage, { path: screenshot.path, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

    stage = 'Guest Driver MCP initialization, discovery and read-only observations';
    report.mcp = {};
    await validateMcp(context, directory, report.mcp);
    record(stage, { toolCount: report.mcp.toolCount, readOnlyCalls: report.mcp.readOnlyCalls!.filter(item => item.status === 'passed').map(item => item.name) });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = safeFailure(error);
    report.checks.push({ name: stage, status: 'failed', error: report.error });
  } finally {
    if (guestFileAttempted) {
      try {
        const cleaned = await executeSandbox({ ...context, command: `rm -f -- '${guestFile}' && test ! -e '${guestFile}'`, timeoutSeconds: 10 });
        ensure(cleaned.returncode === 0, 'The guest transfer fixture could not be removed.');
        record('Guest transfer fixture removed');
      } catch (error) { report.cleanupError = safeFailure(error); report.status = 'failed'; }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (report.status !== 'passed') {
    const error = ownError(`Cua bridge validation failed during ${stage}. ${report.error || report.cleanupError}`);
    error.report = report;
    throw error;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
  const id = option('id'), output = option('output');
  if (!id || !output) {
    console.error('Usage: node scripts/validate-cua-bridge.ts --id ID --output DIR [--data DIR]');
    process.exitCode = 1;
  } else {
    validateCuaBridge({ dataDir: resolve(option('data') ?? '.perpetual'), id, output }).then(report => console.log(JSON.stringify(report, null, 2)), (error: BridgeError) => {
      console.error(error.message);
      if (error.report) console.error(`Report: ${error.report.reportPath}`);
      process.exitCode = 1;
    });
  }
}
