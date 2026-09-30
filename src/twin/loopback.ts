// Runs in the app's existing Node image, before the repository's build and server. The
// compiler supplies only this twin's explicitly referenced public ports. TCP forwarding
// preserves the application's HTTP, streaming, cookies and TLS without replacing an API.
// Keep this standalone JavaScript: no guest mount or copy of the controller is required.
const SUPERVISOR = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const ports = JSON.parse(process.argv[1]);
const command = process.argv[2];
if (!Array.isArray(ports) || ports.length > 48 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535) || typeof command !== 'string') {
  console.error('Invalid twin public URL ports.'); process.exit(1);
}
const listeners = [], sockets = new Set();
let child, stopping = false;
function signalGroup(signal) {
  if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const server of listeners) server.close();
  for (const socket of sockets) socket.destroy();
  try { signalGroup(signal); } catch { code = 1; }
  if (!child?.pid) process.exit(code);
  // Also stop descendants when their shell exits first. Bound shutdown fits Docker's
  // stop grace period; the container namespace is removed after this supervisor exits.
  const deadline = setTimeout(() => {
    try { signalGroup('SIGKILL'); } catch { code = 1; }
    process.exit(code);
  }, 2000);
  const exited = setInterval(() => {
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { clearTimeout(deadline); clearInterval(exited); process.exit(code); } }
  }, 25);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(128 + constants.signals[signal], signal));
async function start() {
  for (const port of new Set(ports)) {
    if (stopping) return;
    const server = net.createServer({ allowHalfOpen: true }, local => {
      if (stopping) { local.destroy(); return; }
      const upstream = net.createConnection({ host: 'host.docker.internal', port, allowHalfOpen: true });
      sockets.add(local); sockets.add(upstream);
      const close = () => { local.destroy(); upstream.destroy(); };
      local.on('error', close); upstream.on('error', close);
      local.on('close', () => { sockets.delete(local); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); local.destroy(); });
      upstream.setTimeout(10000, close);
      upstream.once('connect', () => upstream.setTimeout(0));
      local.pipe(upstream); upstream.pipe(local);
    });
    listeners.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error('Cannot bind twin public URL on 127.0.0.1:' + port + '. Check app port conflicts.')));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    server.on('error', () => { console.error('Twin public URL listener failed.'); stop(1); });
  }
  if (stopping) return;
  child = spawn('sh', ['-c', command], { stdio: 'inherit', detached: true });
  child.once('error', () => { console.error('Twin app command could not start.'); stop(1); });
  child.once('exit', (code, signal) => stop(code ?? 128 + (constants.signals[signal] ?? 1)));
}
start().catch(error => { console.error(error.message); stop(1); });
`;

/** Only explicitly resolved publicUrl addresses may be passed here, never literal env URLs. */
export function loopbackCommand(command: string, publicPorts: Iterable<number>, appPort: number): string[] {
  const ports = [...new Set(publicPorts)];
  if (!ports.length) return ['sh', '-c', command];
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || ports.length > 48) throw new Error('Invalid twin public URL ports.');
  if (ports.includes(appPort)) throw new Error(`Twin public URL port ${appPort} conflicts with the app's listening port. Rebuild the twin to allocate new ports.`);
  return ['node', '-e', SUPERVISOR, JSON.stringify(ports), command];
}
