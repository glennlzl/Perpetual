import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateDirectory, readPrivateFile, readStateFile, removeStateFile, writeStateFile } from '../../src/store.ts';

const execFile = promisify(execFileCallback);
const LABEL = 'com.perpetual.connector-broker-trial';
const INVALID = 'The local broker service installation is invalid. Uninstall it before installing again.';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, '../..');
const SERVE = join(HERE, 'serve.ts');
export interface InstallState { schema: 1; envFile: string; servicePath: string; nodePath: string }

function configRoot(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.XDG_CONFIG_HOME;
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.config');
}
function paths(env: NodeJS.ProcessEnv = process.env) {
  const directory = join(configRoot(env), 'perpetual', 'connector-broker-service');
  return { directory, state: join(directory, 'install.json'), out: join(directory, 'service.out.log'), err: join(directory, 'service.err.log'), plist: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`) };
}
function xml(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function checkoutFor(servicePath: string) { return resolve(dirname(servicePath), '../..'); }
export function buildLaunchAgentPlist(state: InstallState, files: ReturnType<typeof paths>) {
  const args = [state.nodePath, `--env-file=${state.envFile}`, state.servicePath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n` +
    `  <key>Label</key><string>${LABEL}</string>\n` +
    `  <key>Comment</key><string>Managed by Perpetual connector broker trial</string>\n` +
    `  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n` +
    `  <key>WorkingDirectory</key><string>${xml(checkoutFor(state.servicePath))}</string>\n` +
    `  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n` +
    `  <key>StandardOutPath</key><string>${xml(files.out)}</string>\n  <key>StandardErrorPath</key><string>${xml(files.err)}</string>\n` +
    `</dict></plist>\n`;
}
export function validInstallState(value: unknown): value is InstallState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.schema === 1 && typeof state.envFile === 'string' && isAbsolute(state.envFile) &&
    typeof state.servicePath === 'string' && isAbsolute(state.servicePath) &&
    typeof state.nodePath === 'string' && isAbsolute(state.nodePath);
}
async function loadState(file: string) {
  const raw = await readStateFile(file, { limit: 8192, invalid: INVALID });
  if (raw === undefined) return undefined;
  if (!validInstallState(raw)) throw new Error(INVALID);
  return raw;
}
async function readOwnedPlist(file: string) {
  let entry;
  try { entry = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) throw new Error(INVALID);
  return await readPrivateFile(file, { limit: 64 * 1024, invalid: INVALID });
}
async function assertPrivateEnvFile(path: string) {
  if (!isAbsolute(path)) throw new Error('Use an absolute path to the private broker configuration file.');
  const file = resolve(path);
  const rel = relative(REPOSITORY, file);
  const insideCheckout = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (insideCheckout) {
    throw new Error('Keep the private broker configuration outside the Perpetual checkout.');
  }
  const entry = await lstat(file).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
    throw new Error('The broker configuration must be a private regular file owned by this user (mode 0600).');
  }
  return file;
}
async function launchctl(args: string[]) {
  try { return await execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }); }
  catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string };
    if (detail.code === 'ENOENT') throw new Error('launchctl is unavailable; this service command requires macOS.');
    throw error;
  }
}
const domain = () => `gui/${typeof process.getuid === 'function' ? process.getuid() : '0'}`;
type LaunchRunner = (args: string[]) => Promise<unknown>;
export async function launchAgentIsLoaded(run: LaunchRunner, target: string) {
  try { await run(['print', target]); return true; }
  catch (error) {
    if ((error as { code?: unknown }).code === 113) return false;
    throw new Error('Could not determine the broker LaunchAgent state.');
  }
}
export function assertLoadedAgentIsOwned(loaded: boolean, hasPriorState: boolean, plistMatches: boolean) {
  if (loaded && (!hasPriorState || !plistMatches)) throw new Error('A LaunchAgent already uses the broker service label and is not owned by this install.');
}
export async function stopLaunchAgent(run: LaunchRunner, target: string) {
  await run(['bootout', target]).catch(() => {});
  if (await launchAgentIsLoaded(run, target)) throw new Error('The broker LaunchAgent is still running; its files were left in place.');
}
async function install(envFile: string) {
  if (process.platform !== 'darwin') throw new Error('The local broker service command currently requires macOS launchd.');
  const privateEnv = await assertPrivateEnvFile(envFile);
  const files = paths();
  await privateDirectory(files.directory, INVALID);
  await mkdir(dirname(files.plist), { recursive: true, mode: 0o755 });
  const next: InstallState = { schema: 1, envFile: privateEnv, servicePath: SERVE, nodePath: process.execPath };
  const prior = await loadState(files.state);
  let existing: string | undefined;
  try { existing = await readOwnedPlist(files.plist); }
  catch { throw new Error(INVALID); }
  const contents = buildLaunchAgentPlist(next, files);
  if (existing !== undefined && existing !== contents) throw new Error('A different LaunchAgent already uses the broker service label. Uninstall it manually after reviewing it.');
  if (!prior && existing !== undefined) throw new Error('A LaunchAgent already uses the broker service label and is not owned by this install.');
  if (prior && (prior.envFile !== next.envFile || prior.servicePath !== next.servicePath || prior.nodePath !== next.nodePath)) {
    throw new Error('The broker service paths changed. Uninstall the existing service before installing it again.');
  }
  const target = `${domain()}/${LABEL}`;
  const loaded = await launchAgentIsLoaded(args => launchctl(args), target);
  assertLoadedAgentIsOwned(loaded, Boolean(prior), existing === contents);
  await writeStateFile(files.state, JSON.stringify(next));
  if (existing === undefined) await writeStateFile(files.plist, contents);
  if (loaded) await launchctl(['kickstart', '-k', `${domain()}/${LABEL}`]).catch(() => { throw new Error('Could not restart the broker LaunchAgent. Check its service logs.'); });
  else await launchctl(['bootstrap', domain(), files.plist]).catch(() => { throw new Error('Could not start the broker LaunchAgent. Check its private configuration and service logs.'); });
  console.log('Broker service installed and started.');
}

async function status() {
  const files = paths(), state = await loadState(files.state);
  if (!state) { console.log('Broker service is not installed.'); return; }
  try { await assertPrivateEnvFile(state.envFile); }
  catch { console.log('Broker service configuration is unavailable or no longer private.'); return; }
  if (state.servicePath !== SERVE || state.nodePath !== process.execPath) {
    console.log('Broker service is installed at an old checkout path. Uninstall it and install again.'); return;
  }
  const result = await launchctl(['print', `${domain()}/${LABEL}`]).then(value => value.stdout, () => '');
  const pid = /^\s*pid = (\d+)\s*$/mu.exec(result)?.[1];
  console.log(pid ? `Broker service is running (pid ${pid}).` : 'Broker service is installed but stopped.');
}

async function uninstall() {
  if (process.platform !== 'darwin') throw new Error('The local broker service command currently requires macOS launchd.');
  const files = paths(), state = await loadState(files.state);
  if (!state) { console.log('Broker service is not installed.'); return; }
  let actual: string | undefined;
  try { actual = await readOwnedPlist(files.plist); }
  catch { throw new Error(INVALID); }
  if (actual === undefined || actual !== buildLaunchAgentPlist(state, files)) throw new Error('The broker LaunchAgent changed and was left in place for review.');
  await stopLaunchAgent(args => launchctl(args), `${domain()}/${LABEL}`);
  await removeStateFile(files.plist, INVALID);
  await removeStateFile(files.state, INVALID);
  console.log('Broker service stopped and uninstalled. Its private state and logs remain in the service directory.');
}

function help() {
  console.log('Usage: npm run service -- install --env-file /absolute/private/server.env | status | uninstall');
}
async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'install') {
    if (rest.length !== 2 || rest[0] !== '--env-file') throw new Error('Install requires --env-file and one absolute path.');
    await install(rest[1]!); return;
  }
  if (command === 'status' && rest.length === 0) { await status(); return; }
  if (command === 'uninstall' && rest.length === 0) { await uninstall(); return; }
  if (!command || command === 'help' || command === '--help') { help(); return; }
  throw new Error('Use install --env-file PATH, status, or uninstall.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Broker service command failed. Check the private configuration and LaunchAgent state.'); process.exitCode = 1; });
}
