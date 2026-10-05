// Runs the pinned test MCP server for code generation behind a filter of what OpenCode sends it. Its
// generator_setup_page reads whatever file a call names as seedFile, wherever it is, and generator_read_log then hands
// that text to the model, so a setup call that names anything but the workspace's seed project and seed file is
// answered with a tool error and never reaches the server. Everything else passes unchanged, both ways, one JSON-RPC
// message per line as the MCP stdio transport frames it.
// Usage: node mcp-guard.ts <seed project> <seed file> <script> [...args], which runs `node <script> [...args]`.
import { spawn } from 'node:child_process';

const [project, seedFile, ...command] = process.argv.slice(2);
const SETUP = 'generator_setup_page';
const REFUSED = `${SETUP} sets up only project ${JSON.stringify(project)} with seedFile ${JSON.stringify(seedFile)}.`;
const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const server = spawn(process.execPath, command, { stdio: ['pipe', 'pipe', 'inherit'] });

// Each complete line of a stream; a partial line when it ends is no message.
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) { onLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  });
}
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

// The server receives exactly the message this filter judged: one JSON object, serialized again.
lines(process.stdin, line => {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  const request = record(message), params = record(request?.params), args = record(params?.arguments);
  if (!request) return;
  if (request.method === 'tools/call' && params?.name === SETUP && (args?.project !== project || args?.seedFile !== seedFile)) {
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: REFUSED }], isError: true } });
    return;
  }
  server.stdin.write(`${JSON.stringify(request)}\n`);
});
// Whole lines only, so a refusal never lands inside one of the server's messages.
lines(server.stdout, line => { process.stdout.write(`${line}\n`); });
process.stdin.on('end', () => server.stdin.end());
server.stdin.on('error', () => {});
process.stdout.on('error', () => {});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.kill(signal); });
server.on('error', () => { process.exitCode = 1; process.stdin.destroy(); });
server.on('close', code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
