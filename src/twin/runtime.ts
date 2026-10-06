import type { ExecFileException } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, posix, resolve } from 'node:path';
import YAML from 'yaml';
import { APPS, ID, INSTALL, SOURCE, SQL_URL, addressText, fail, leaveOutBlocked, placeholders, resolvePlaceholders, serviceOptionErrors, setupOrder, validateTwinConfig } from './config.ts';
import { APP_IMAGE, nodeImage, HOST, HOST_GATEWAY, LABELS, LOOPBACK, OWN_CACHE_VOLUME, PACKAGE_CACHE_ENV, WORKSPACE, WORKSPACE_VOLUME, addressKey, addressUrl, appCommand, cacheMount, composeTwin, formatEnv, hostUrl, portKey, repositoryCache, variables } from './compose.ts';
import { missingInputs } from './inputs.ts';
import { services as registry } from './registry.ts';
import type { JsonObject, TwinFixture } from './config.ts';
import type { HostPorts, ResolvedService } from './compose.ts';
import type { CommandOutput, InputValues, ServiceContext, ServiceHealthContainer, ServiceOutputs, TwinServices } from './registry.ts';
import { failureText, hide, openBlock, redact as redactSecrets } from '../redaction.ts';
import { diagnosticText } from '../environments/diagnostics.ts';
import { superviseWorker } from '../browser/runtime.ts';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';

// A twin is <dataDir>/environments/<id>/twin/{compose.yaml,.env,twin.json}: service setup in
// placeholder order; once services are up, their test accounts, the shared install, fixtures and
// each app's build; then `docker compose up --wait` starts the apps and the services that run
// repository code.

export const PORT_BASE = 43100;
export const PORT_BLOCK = 48;
const ANY_ADDRESS = '0.0.0.0';
const ENVIRONMENTS = 'environments';
const TWIN = 'twin';
/** Per-machine state a service shares across twins, e.g. one self-hosted instance. */
const SHARED = 'twin-services';
const TWIN_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SQL_CLIENT = 'postgres:17-alpine';
const SECRET_NAME = /secret|token|passw|private|credential|key$/i;
/** Read by the docker CLI itself, so never passed through its environment. */
const CLI_VARIABLE = /^(?:DOCKER_\w*|PATH|HOME)$/;
const MIN_SECRET = 4;
const REDACTED = '[redacted]';
/** Trailing lines of a failed command's output kept in its error; progress comes first, the error last. */
const ERROR_OUTPUT = 30;
const tail = (text: string) => text.trim().split('\n').slice(-ERROR_OUTPUT).join('\n');

/** exec(file, args, { env, cwd }) -> { stdout, stderr }; rejects on a non-zero exit. */
export type ExecOptions = { env?: Record<string, string>; cwd?: string; signal?: AbortSignal; timeoutMs?: number; outputLimitBytes?: number; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void };
export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<CommandOutput>;
export type IsFree = (port: number) => Promise<boolean>;
const COMMAND_TIMEOUT_MS = 15 * 60_000, CLEANUP_TIMEOUT_MS = 120_000, READ_TIMEOUT_MS = 20_000, ENGINE_TIMEOUT_MS = 15_000, LOG_LIMIT = 32_000;
/**
 * Completion joins the CLI's owned process group. Docker resources still belong to the twin's teardown, so a CLI killed
 * after ignoring its stop signal, as `docker run` does while its guest ignores it, leaves no cleanup once its group is gone.
 */
export const execCommand: Exec = async (file, args, { env, cwd, signal, timeoutMs = COMMAND_TIMEOUT_MS, outputLimitBytes = 64 * 1024 * 1024, onOutput } = {}) => {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('A twin command needs a positive time limit.');
  const output = { stdout: '', stderr: '' };
  let outputLimited = false, exitCode: number | undefined;
  const job = superviseWorker({ command: file, args, cwd, env: { ...process.env, ...env }, timeoutMs, cleanupGraceMs: 5000, groupOnly: true,
    unavailable: `${file} could not start.`, onLifecycle(event) { if (event.name === 'worker-exit') exitCode = event.code; }, onOutput(chunk, stream) {
      output[stream] += chunk;
      if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > outputLimitBytes) {
        outputLimited = true; output.stdout = ''; output.stderr = '';
        throw new Error('Twin command output exceeded its size limit.');
      }
      onOutput?.(chunk, stream);
    } });
  const stop = () => job.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try { await job.promise; return output; }
  catch (error) {
    const detail = error as Error & { timedOut?: true; cleanupIncomplete?: true };
    const message = outputLimited ? 'Twin command output exceeded its size limit; output discarded.' : signal?.aborted ? String(signal.reason?.message || 'Twin command stopped.') : detail.timedOut ? `Twin command exceeded its ${timeoutMs / 1000}-second limit.` : detail.message.replaceAll('Browser runtime', 'Twin command').replaceAll('Browser operation', 'Twin command');
    throw Object.assign(new Error(message), outputLimited ? { stdout: '', stderr: '' } : output, ...(detail.timedOut ? [{ timedOut: true }] : []), ...(detail.cleanupIncomplete ? [{ cleanupIncomplete: true }] : []),
      ...(exitCode ? [{ code: exitCode }] : []));
  } finally { signal?.removeEventListener('abort', stop); }
};

const listens = (port: number, host: string) => new Promise<boolean>(done => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
});
export const portFree: IsFree = async port => await listens(port, LOOPBACK) && await listens(port, ANY_ADDRESS);

/** The first `count` free host ports from `start` upward, skipping other twins' blocks. */
export async function allocatePorts({ count = PORT_BLOCK, start = PORT_BASE, reserved = new Set(), isFree = portFree }: { count?: number; start?: number; reserved?: ReadonlySet<unknown>; isFree?: IsFree } = {}) {
  const ports: number[] = [];
  for (let port = start; ports.length < count; port += 1) {
    if (port > 65535) fail('No free host ports are left for this twin.');
    if (!reserved.has(port) && await isFree(port)) ports.push(port);
  }
  return ports;
}

/** Replaces every secret the twin has seen with its marker: longest first, and values shorter than MIN_SECRET never. */
export const redactor = (secrets: Iterable<string>) => hide(secrets, { marker: REDACTED, minLength: MIN_SECRET });

const secretValues = (values: Readonly<Record<string, unknown>> | null | undefined) => Object.entries(values ?? {}).filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string').map(([, value]) => value as string);
const ACCOUNT_TEXT: Record<string, number> = { label: 120, username: 320, password: 1024 };
/** A twin's test account; the password stays in the twin's private state. */
export interface TwinAccount { id: string; label: string; username: string; password: string; authEndpoints?: string[] }
/** One service's setup, kept so its accounts and teardown see the same options and outputs. */
interface ServiceRecord { id: string; options: JsonObject; outputs: ServiceOutputs }
/** twin.json, written by this runtime: what the twin owns, and the secrets its output is redacted of. */
interface TwinState {
  id: string; project: string; owner: string; source: string; block: number[]; ports: HostPorts; services: ServiceRecord[]; secrets: string[];
  accounts?: (TwinAccount & { service: string })[];
}
export interface ContainerStatus { name: string; state: string; health: string | null; exitCode: number | null }
export type TwinHealth = { status: 'stopped' | 'failed' | 'ready' | 'starting'; containers: ContainerStatus[] };
/** An entry of `docker compose ps --format json`. */
interface ComposePs { Service?: unknown; State?: unknown; Health?: unknown; ExitCode?: unknown }
type Redact = (text: unknown) => string;
type Ready = ResolvedService & { status: 'ready' };

/** What a service's accounts(ctx) returns: [{ id, label, username, password, authEndpoints? }], checked before it is stored.
 * authEndpoints are the URLs the product's own sign-in posts to, so read-only discovery can let exactly that request through. */
function testAccounts(list: unknown, where: string): TwinAccount[] {
  if (!Array.isArray(list)) fail(`${where} must be a list.`);
  return list.map((account: { [name: string]: unknown } | null | undefined, index: number) => {
    const text = (name: string) => typeof account?.[name] === 'string' && account[name].trim() && account[name].length <= ACCOUNT_TEXT[name] && !/[\x00-\x1f\x7f]/.test(account[name]);
    if (typeof account?.id !== 'string' || !ID.test(account.id) || !Object.keys(ACCOUNT_TEXT).every(text)) fail(`${where}[${index}] needs an id, label, username and password.`);
    const endpoints = account.authEndpoints ?? [];
    if (!Array.isArray(endpoints) || endpoints.length > 3 || endpoints.some(url => typeof url !== 'string' || !/^https?:\/\/[^/?#]+\/[^?#]+$/.test(url))) fail(`${where}[${index}].authEndpoints must list at most 3 absolute URLs with a path.`);
    return { id: account.id, label: account.label, username: account.username, password: account.password, ...(endpoints.length ? { authEndpoints: endpoints } : {}) } as TwinAccount;
  });
}
const exists = (path: string) => access(path).then(() => true, () => false);
// Some CLIs report progress on stderr and their final error on stdout, so both are kept, stdout last.
const errorText = (error: unknown, redact: Redact = String) => { const failed = error as Partial<ExecFileException> | null | undefined;
  // A multiline credential needs its opening marker to remain visible to the redactor.
  return tail(redactSecrets(redact([failed?.stderr, failed?.stdout].filter((text): text is string => typeof text === 'string' && Boolean(text.trim())).map(text => text.trim()).join('\n') || String(failed?.message || error)))); };

const fields = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const STATE_LIMIT = 32 * 1024 * 1024, SHARED_PORTS_LIMIT = 1024 * 1024;
const INVALID_STATE = 'Invalid twin state; its files are kept for manual recovery.';
const INVALID_PORTS = 'Invalid shared port state; recover its reservations before creating a twin.';
const PRIVATE_STORAGE = 'Twin storage must not be a symbolic link.';
const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
const portMap = (value: unknown): value is HostPorts => fields(value) !== null && Object.values(value as Record<string, unknown>).every(isPort);

/** Missing storage stays missing. Existing storage is private; parent aliases keep their lexical paths and owner labels. */
async function storedJson(file: string, limit: number, invalid: string): Promise<unknown> {
  try { await lstat(dirname(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  await privateDirectory(dirname(file), PRIVATE_STORAGE, { resolveAliases: false });
  try { return await readStateFile(file, { limit, invalid }); }
  catch { return fail(invalid); }
}

/** Absent is different from unreadable: cleanup must never discard ownership after a refused read. */
async function readState(file: string): Promise<TwinState | null> {
  const saved = await storedJson(file, STATE_LIMIT, INVALID_STATE);
  if (saved === undefined) return null;
  const state = fields(saved);
  if (!state || typeof state.id !== 'string' || !TWIN_ID.test(state.id)
    || !['project', 'owner', 'source'].every(name => typeof state[name] === 'string' && state[name])
    || !Array.isArray(state.block) || !state.block.every(isPort) || !portMap(state.ports)
    || !Array.isArray(state.services) || !Array.isArray(state.secrets) || !state.secrets.every(value => typeof value === 'string')) fail(INVALID_STATE);
  for (const record of state.services) {
    const service = fields(record);
    if (!service || typeof service.id !== 'string' || !ID.test(service.id) || !fields(service.options)
      || (service.outputs !== undefined && !fields(service.outputs))) fail(INVALID_STATE);
  }
  if (state.accounts !== undefined) {
    if (!Array.isArray(state.accounts) || state.accounts.some(value => { const account = fields(value); return !account || typeof account.service !== 'string' || !ID.test(account.service); })) fail(INVALID_STATE);
    try { testAccounts(state.accounts, 'Saved accounts'); } catch { fail(INVALID_STATE); }
  }
  return state as unknown as TwinState;
}

// Host ports belong to the machine: a twin reads the other twins' saved blocks and the ports of shared
// instances, and saves its own block in one turn, so twins prepared at the same time never share a port.
const reservations = createSaveQueue();
/** Ports of services' machine-wide instances, { '<service>.<name>': port }, kept beside their shared state. */
const SHARED_PORTS = 'ports.json';

async function sharedPorts(dataDir: string): Promise<HostPorts> {
  const saved = await storedJson(join(resolve(dataDir), SHARED, SHARED_PORTS), SHARED_PORTS_LIMIT, INVALID_PORTS);
  if (saved === undefined) return {};
  if (!portMap(saved)) fail(INVALID_PORTS);
  return saved;
}

async function reservedPorts(dataDir: string, id?: string) {
  const root = resolve(dataDir), environments = join(root, ENVIRONMENTS);
  const entries = await readdir(environments).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  // Controller metadata and atomic-save files share this directory; only accepted twin ids own reservations.
  const states = await Promise.all(entries.filter(entry => entry !== id && TWIN_ID.test(entry)).map(entry => readState(join(environments, entry, TWIN, 'twin.json'))));
  return new Set([...states.flatMap(state => state?.block ?? []), ...Object.values(await sharedPorts(root))]);
}

/** The host port of a machine-wide instance: reserved once, outside every twin's block, and never given to a twin.
 * `current` keeps the port an existing instance already publishes. */
const reserveSharedPort = (dataDir: string, key: string, current: unknown, { start, isFree }: { start: number; isFree: IsFree }) => reservations.run(async () => {
  const dir = join(resolve(dataDir), SHARED), file = join(dir, SHARED_PORTS), ports = await sharedPorts(dataDir);
  const reserved = ports[key];
  if (isPort(reserved)) return reserved;
  const port = isPort(current) ? current : (await allocatePorts({ count: 1, start, reserved: await reservedPorts(dataDir), isFree }))[0];
  ports[key] = port;
  const content = `${JSON.stringify(ports, null, 2)}\n`;
  if (Buffer.byteLength(content) > SHARED_PORTS_LIMIT) fail('Shared port state exceeds 1 MiB; no new port was reserved.');
  await privateDirectory(dir, PRIVATE_STORAGE, { resolveAliases: false });
  await writeStateFile(file, content, { removeTemporary: true });
  return port;
});

/** The services a plain `up` starts: those of the twin's compose.yaml outside a profile, as the install and the source copy are. */
async function upServices(file: string) {
  const invalid = 'Invalid twin compose file; its services could not be read.', info = await lstat(file);
  if (!info.isFile() || info.size > STATE_LIMIT) fail(invalid);
  const services = fields(fields(YAML.parse(await readFile(file, 'utf8')))?.services) ?? fail(invalid);
  return Object.keys(services).filter(name => fields(services[name])?.profiles === undefined);
}

const parsePs = (stdout: unknown): ComposePs[] => {
  const text = String(stdout).trim();
  if (!text) return [];
  const entries: unknown = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return (Array.isArray(entries) ? entries : []).map(entry => fields(entry) ?? {});
};

// Inspect only named resources, and return no environment, health-command output or other private configuration.
const HEALTH_FORMAT = '{"name":{{json .Name}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"exitCode":{{json .State.ExitCode}},"labels":{{json .Config.Labels}}}';
function inspectedHealth(stdout: string, expected: ServiceHealthContainer[]): ContainerStatus[] {
  const invalid = 'Docker did not report health for every owned service container.';
  let entries: unknown[];
  try { entries = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown); }
  catch { return fail(invalid); }
  const remaining = new Map(expected.map(item => [`/${item.name}`, item]));
  if (remaining.size !== expected.length || entries.length !== expected.length) fail(invalid);
  const containers = entries.map(entry => {
    const value = fields(entry), owned = typeof value?.name === 'string' ? remaining.get(value.name) : undefined, labels = fields(value?.labels);
    if (!value || !owned || !labels || Object.entries(owned.labels).some(([name, content]) => labels[name] !== content)
      || typeof value.state !== 'string' || !['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'].includes(value.state)
      || typeof value.health !== 'string' || !['starting', 'healthy', 'unhealthy'].includes(value.health)
      || typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode)) return fail(invalid);
    remaining.delete(value.name as string);
    return { name: owned.name, state: value.state, health: value.health, exitCode: value.exitCode };
  });
  if (remaining.size) fail(invalid);
  return containers;
}

/** The state of a Compose service whose container is gone, as a prune removes a stopped one: it never comes back by itself. */
const REMOVED = 'removed';
const overall = (containers: ContainerStatus[]): TwinHealth['status'] => !containers.length ? 'stopped'
  : containers.some(item => ['exited', 'dead', REMOVED].includes(item.state) || item.health === 'unhealthy') ? 'failed'
  : containers.every(item => item.state === 'running' && [null, 'healthy'].includes(item.health)) ? 'ready' : 'starting';

export function createTwinRuntime({ exec = execCommand, services = registry, isFree = portFree, portBase = PORT_BASE, appImage = APP_IMAGE, owner }: {
  exec?: Exec; services?: TwinServices; isFree?: IsFree; portBase?: number; appImage?: string; owner?: string;
} = {}) {
  const operations = new AsyncLocalStorage<{ signal?: AbortSignal; timeoutMs?: number; outputLimitBytes?: number; output?: (text: string) => void }>();
  const setupLogs = new Map<string, string>();
  // Keep the current operation's values available to diagnostics and teardown even if saving
  // twin.json fails. These are redaction inputs, never a second account or ownership authority.
  const diagnosticSecrets = new Map<string, Set<string>>();
  const locate = (dataDir: string, id: unknown) => {
    if (typeof id !== 'string' || !TWIN_ID.test(id)) fail('A twin id must use lowercase letters, digits, hyphens or underscores.');
    const dir = join(resolve(dataDir), ENVIRONMENTS, id, TWIN);
    return { id, dir, root: resolve(dataDir), shared: join(resolve(dataDir), SHARED), project: `perpetual-${id}`, owner: owner ?? createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16),
      state: join(dir, 'twin.json'), compose: join(dir, 'compose.yaml'), env: join(dir, '.env'), log: join(dir, 'setup.log') };
  };
  type Twin = ReturnType<typeof locate>;
  const composeArgs = (twin: Twin, ...args: string[]) => ['compose', '--project-name', twin.project, '--project-directory', twin.dir, '--file', twin.compose, '--env-file', twin.env, ...args];

  async function host(file: string, args: string[], { env, cwd, redact = String }: { env?: Record<string, string>; cwd?: string; redact?: Redact } = {}) {
    const operation = operations.getStore(), lines = { stdout: '', stderr: '' };
    operation?.signal?.throwIfAborted();
    const output = operation?.output;
    try { return await exec(file, args, { ...(env && { env }), ...(cwd && { cwd }), signal: operation?.signal, timeoutMs: operation?.timeoutMs, outputLimitBytes: operation?.outputLimitBytes,
      ...(output ? { onOutput(chunk: string, stream: 'stdout' | 'stderr') {
        lines[stream] += chunk;
        const end = lines[stream].lastIndexOf('\n');
        // A private key's lines can come in several chunks: they wait for the end of its block, or of the stream.
        if (end >= 0 && !openBlock(lines[stream].slice(0, end + 1))) { output(redactSecrets(redact(lines[stream].slice(0, end + 1)))); lines[stream] = lines[stream].slice(end + 1); }
        // A CLI without newlines cannot retain unlimited memory or reveal partial secrets.
        if (lines[stream].length > LOG_LIMIT) lines[stream] = '';
      } } : {}) }); }
    catch (error) {
      const failed = error as Error & { cleanupIncomplete?: true; timedOut?: true; code?: unknown; stdout?: string; stderr?: string };
      const message = failed.timedOut || operation?.signal?.aborted ? [failed.message, errorText(error, redact)].filter((text, index, all) => all.indexOf(text) === index).join('\n') : errorText(error, redact);
      throw Object.assign(new Error(redactSecrets(redact(message))), {
        ...(failed.cleanupIncomplete ? { cleanupIncomplete: true } : {}), ...(failed.timedOut ? { timedOut: true } : {}),
        ...(failed.code !== undefined ? { code: failed.code } : {}), stdout: redactSecrets(redact(failed.stdout ?? '')), stderr: redactSecrets(redact(failed.stderr ?? '')),
      });
    } finally { if (output) for (const line of Object.values(lines)) if (line) output(`${redactSecrets(redact(line))}\n`); }
  }
  const docker = (args: string[], options?: { env?: Record<string, string>; redact?: Redact }) => host('docker', args, options);

  // Values travel in the child's environment and `--env NAME`, never on the command line.
  const dockerRun = (twin: Twin, image: string, args: string[], { env = {}, volumes = [], workdir, redact }: { env?: Record<string, string>; volumes?: string[]; workdir?: string; redact: Redact }) => {
    for (const name of Object.keys(env)) if (CLI_VARIABLE.test(name)) fail(`${name} cannot be passed to a container run.`);
    return docker(['run', '--rm', '--add-host', HOST_GATEWAY, '--label', `${LABELS.owner}=${twin.owner}`, '--label', `${LABELS.environment}=${twin.id}`,
      ...volumes.flatMap(volume => ['--volume', volume]), ...(workdir ? ['--workdir', workdir] : []), ...Object.keys(env).flatMap(name => ['--env', name]), image, ...args], { env, redact });
  };

  function context(twin: Twin, { service, options, inputs, outputs, ports, take, source, redact, rememberSecret }: {
    service: string; options: JsonObject; inputs: InputValues; outputs: ServiceOutputs; ports: HostPorts; take: (key: string) => number; source: string; redact: Redact; rememberSecret?: (value: string) => void;
  }): ServiceContext {
    const dir = join(twin.dir, 'services', service);
    const port = (name: string) => take(portKey(service, name));
    return {
      options, inputs, outputs, host: HOST, project: twin.project, dir, shared: join(twin.shared, service), source, signal: operations.getStore()?.signal, rememberSecret,
      port, url: (name, path = '') => hostUrl(port(name), path),
      // A port for this service's machine-wide instance, the same for every twin and outside all their blocks.
      sharedPort: (name, current) => reserveSharedPort(twin.root, portKey(service, name), current, { start: portBase, isFree }),
      // Every app's port is allocated before any setup, so its key names each app.
      apps: Object.keys(ports).flatMap(key => key.startsWith(`${APPS}.`) ? [key.slice(APPS.length + 1)] : []),
      app: id => { const appPort = ports[portKey(APPS, id)] ?? fail(`No app "${id}" is configured.`); return { url: hostUrl(appPort), publicUrl: addressUrl({ app: id, public: true }, appPort), port: appPort }; },
      run: (image, args, { env, mounts } = {}) => dockerRun(twin, image, args, { env: variables(env, `${service} run`),
        volumes: mounts === 'service-only' ? [`${dir}:${dir}:ro`] : [`${dir}:${dir}`, `${source}:${source}:ro`], workdir: dir, redact }),
      // A pinned CLI on the host, for tools that drive Docker themselves; the Docker socket is never mounted into a container.
      exec: (file, args, { cwd = dir, env } = {}) => host(file, args, { cwd, env, redact }),
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(READ_TIMEOUT_MS), ...(operations.getStore()?.signal ? [operations.getStore()!.signal!] : []), ...(init?.signal ? [init.signal] : [])]) }),
    };
  }

  /**
   * Runs a one-shot Compose service once, as the install and each app's build are: a command of its own, so it has its own
   * time limit and exit code. Package managers and builds report on stdout or stderr, so its error keeps the end of both;
   * a time limit or Stop is the cause, so it leads.
   */
  async function oneShot(twin: Twin, service: string, what: string, redact: Redact) {
    try { await host('docker', composeArgs(twin, '--progress', 'quiet', '--profile', service, 'run', '--rm', '--no-TTY', service), { redact }); }
    catch (error) {
      const failed = error as Partial<ExecFileException> & { timedOut?: true };
      const output = tail(`${failed.stdout ?? ''}${failed.stderr ?? ''}`);
      const detail = failed.timedOut || operations.getStore()?.signal?.aborted ? [String(failed.message).split('\n')[0], output].filter(Boolean).join('\n') : output || errorText(error);
      throw Object.assign(new Error(redact(`${what} failed${Number.isInteger(failed.code) ? ` with exit code ${failed.code}` : ''}: ${detail}`)), (error as { cleanupIncomplete?: true }).cleanupIncomplete ? { cleanupIncomplete: true } : {});
    }
  }

  const sqlEnv = (fixture: TwinFixture, env: Record<string, string>) => ({ [SQL_URL]: env[SQL_URL] ?? fail(`${fixture.service} does not provide ${SQL_URL}, which SQL fixtures use.`) });
  const loadFixture = (twin: Twin, fixture: TwinFixture, env: Record<string, string>, source: string, redact: Redact, workspace: boolean, image: string, cache: string | undefined) => fixture.sql
    ? dockerRun(twin, SQL_CLIENT, ['sh', '-c', `exec psql "$${SQL_URL}" -v ON_ERROR_STOP=1 -f "$1"`, 'fixture', posix.join(WORKSPACE, fixture.sql)],
      { env: sqlEnv(fixture, env), volumes: [`${source}:${WORKSPACE}:ro`], redact })
    : fixture.query ? dockerRun(twin, SQL_CLIENT, ['sh', '-c', `exec psql "$${SQL_URL}" -v ON_ERROR_STOP=1 -c "$1"`, 'fixture', fixture.query], { env: sqlEnv(fixture, env), redact })
    // A command fixture runs where the install put the dependencies: the twin's workspace volume when it has one.
    : dockerRun(twin, image, ['sh', '-c', appCommand(fixture.command)], { env: { ...PACKAGE_CACHE_ENV, ...env }, volumes: [workspace ? `${twin.project}_${WORKSPACE_VOLUME}:${WORKSPACE}` : `${source}:${WORKSPACE}`, ...(cache ? [cacheMount(cache)] : [])], workdir: WORKSPACE, redact });

  /**
   * inputs: { <service id>: { <input name>: value } }, e.g. from createTwinInputs().values(). repository: the identity of
   * the repository the twin builds, whose twins share one package cache; without one, as for a pull request head no
   * person has reviewed, the twin's cache is its own, empty and removed with it, so nothing it writes reaches a later twin.
   */
  async function prepareTwin({ dataDir, id, config: input, source, inputs = {}, repository, onStep = () => {} }: {
    dataDir: string; id: string; config: unknown; source: string; inputs?: Record<string, InputValues>; repository?: string; onStep?: (step: string) => unknown; signal?: AbortSignal;
  }) {
    const config = validateTwinConfig(input, { services });
    const invalid = serviceOptionErrors(config, { services });
    if (invalid.length) fail(invalid.join('\n'));
    const twin = locate(dataDir, id);
    if (typeof source !== 'string' || !await exists(source)) fail('A source snapshot directory is required.');
    source = resolve(source);
    if (await readState(twin.state)) await destroy({ dataDir, id, inputs });
    await privateDirectory(twin.dir, PRIVATE_STORAGE, { resolveAliases: false });
    const free: number[] = [], secrets = new Set<string>();
    diagnosticSecrets.set(twin.dir, secrets);
    const state: TwinState = { id, project: twin.project, owner: twin.owner, source, block: [], ports: {}, services: [], secrets: [] };
    const redact = (text: unknown) => redactor(secrets)(text);
    const save = async (failure?: Error & { cleanupIncomplete?: true }) => {
      try {
        state.secrets = [...secrets];
        const content = `${JSON.stringify(state, null, 2)}\n`;
        // Setup may already have created resources whose teardown needs these outputs. Keep all of
        // them even when the read budget is exceeded, then require recovery instead of losing ownership.
        await writeStateFile(twin.state, content, { removeTemporary: true });
        if (Buffer.byteLength(content) > STATE_LIMIT) fail('Twin state exceeds 32 MiB; its complete teardown data is kept for manual recovery.');
      } catch (error) {
        if (!failure) throw error;
        // A final save failure must report the storage problem without losing an owned process's
        // unconfirmed cleanup. Its caller is already unwinding the service failure.
        throw Object.assign(new Error(`${failure.message} Twin state could not be saved: ${redact((error as Error).message)}`, { cause: error }),
          failure.cleanupIncomplete ? { cleanupIncomplete: true as const } : {});
      }
    };
    const take = (key: string) => state.ports[key] ??= free.shift() ?? fail(`This twin needs more than ${PORT_BLOCK} host ports.`);
    // Service addresses are allocated before any setup, so a service may reference one whose setup needs its own variables.
    const addresses = [...placeholders(config.services, 'services'), ...placeholders(config.apps, APPS)].filter(ref => ref.addressOf !== undefined);
    const own = new Set<string>(); // ports services take themselves
    await reservations.run(async () => {
      const reserved = await reservedPorts(dataDir, id);
      // Public URL relays share each app's network namespace with its own listener.
      for (const app of Object.values(config.apps)) reserved.add(app.port);
      state.block = await allocatePorts({ start: portBase, reserved, isFree });
      free.push(...state.block);
      for (const app of Object.keys(config.apps)) take(portKey(APPS, app));
      for (const ref of addresses) take(addressKey(ref));
      await save();
    });

    const resolved: Record<string, ResolvedService> = {};
    for (const serviceId of setupOrder(config)) {
      const definition = services[serviceId], values = inputs[serviceId] ?? {}, base = { id: serviceId, fidelity: definition.fidelity };
      for (const item of definition.inputs ?? []) if (item.secret && typeof values[item.name] === 'string') secrets.add(values[item.name]);
      const blocked = (service: string | undefined) => service !== undefined && resolved[service]?.status === 'blocked';
      const declared = leaveOutBlocked(config.services[serviceId], blocked);
      const upstream = placeholders(declared).filter(ref => blocked(ref.service)).flatMap(ref => (resolved[ref.service!] as ResolvedService & { status: 'blocked' }).missing);
      const missing = [...new Set([...missingInputs(definition, values), ...upstream])];
      if (missing.length) { resolved[serviceId] = { ...base, status: 'blocked', missing }; continue; }
      await onStep(`Setting up ${definition.title}`);
      const where = `services.${serviceId}`;
      // An address has a port key; a service a placeholder names was set up first and, as this one is not blocked, is ready.
      const options = resolvePlaceholders(declared, ref => ref.service === undefined ? addressUrl(ref, state.ports[addressKey(ref)])
        : (resolved[ref.service] as Ready).env[ref.variable] ?? fail(`${where}: ${ref.service} does not provide ${ref.variable}.`), where);
      const ctx = context(twin, { service: serviceId, options, inputs: values, outputs: {}, ports: state.ports, take: key => { own.add(key); return take(key); }, source, redact });
      const record: ServiceRecord = { id: serviceId, options, outputs: {} };
      state.services.push(record);
      let failure: (Error & { cleanupIncomplete?: true }) | undefined;
      try {
        await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
        await save();
        ctx.outputs = record.outputs = { ...(definition.setup ? await definition.setup(ctx) : {}) };
        secretValues(ctx.outputs).forEach(value => secrets.add(value));
        const env = variables(definition.env(ctx), `${serviceId} env`);
        const containers = definition.containers?.(ctx) ?? [];
        for (const container of containers) for (const name of Object.keys(container.ports ?? {})) ctx.port(name);
        [env, ...containers.map(container => container.env)].flatMap(secretValues).forEach(value => secrets.add(value));
        resolved[serviceId] = { ...base, status: 'ready', env, containers };
      } catch (error) {
        failure = Object.assign(new Error(`${definition.title}: ${redact((error as Error).message)}`), (error as { cleanupIncomplete?: true }).cleanupIncomplete ? { cleanupIncomplete: true as const } : {});
        throw failure;
      } finally { await save(failure); }
      for (const ref of addresses) if (ref.addressOf === serviceId && !own.has(addressKey(ref))) fail(`${ref.where} references ${addressText(ref)}, but ${definition.title} has no port ${ref.port}.`);
    }

    const cache = repository ? repositoryCache(repository) : undefined;
    const result = composeTwin({ project: twin.project, owner: twin.owner, environment: id, source, config, appImage, cache,
      services: Object.keys(config.services).map(serviceId => resolved[serviceId]), ports: state.ports });
    await writeStateFile(twin.env, formatEnv(result.env), { removeTemporary: true });
    await writeStateFile(twin.compose, YAML.stringify(result.compose, { aliasDuplicateObjects: false }), { removeTemporary: true });
    await save();
    // A repository's package cache outlives every twin; creating it again is a no-op. A twin's own is Compose's to create.
    if (cache && (result.compose.volumes?.[cache] || config.fixtures.some(fixture => fixture.command))) await docker(['volume', 'create', '--label', 'perpetual.shared=package-cache', cache], { redact });
    // Repository code runs from the twin's workspace volume, filled once from the snapshot before anything uses it.
    const workspace = Boolean(result.compose.services[SOURCE]);
    if (workspace) {
      await onStep('Loading source');
      await docker(composeArgs(twin, '--progress', 'quiet', '--profile', SOURCE, 'run', '--rm', '--no-TTY', SOURCE), { redact });
    }
    // Service containers that run repository code, like apps, wait for the install; the others start first. One-shot
    // services, the install, the source copy and the builds, never start with them.
    const oneShots = new Set([INSTALL, SOURCE, ...result.builds.map(build => build.service)]);
    const names = Object.keys(result.compose.services).filter(name => !oneShots.has(name));
    const serviceNames = names.filter(name => !Object.hasOwn(config.apps, name) && !result.workspace.includes(name));
    const fixtures = config.fixtures.filter(fixture => resolved[fixture.service].status === 'ready');
    const withAccounts = state.services.filter(record => services[record.id].accounts);
    // Builds, like fixtures, may read the services, such as a page rendered from the database while it builds.
    if ((fixtures.length || config.install || withAccounts.length || result.builds.length) && serviceNames.length) {
      await onStep('Starting services');
      await docker(composeArgs(twin, 'up', '--wait', ...serviceNames), { redact });
    }
    // Test accounts, once their services run and before fixtures, which may give them data. Their
    // passwords stay in this private state and are redacted like every other secret.
    state.accounts = [];
    if (withAccounts.length) await onStep('Creating test accounts');
    for (const record of withAccounts) {
      const definition = services[record.id];
      const ctx = context(twin, { service: record.id, options: record.options, inputs: inputs[record.id] ?? {}, outputs: record.outputs, ports: state.ports, take, source, redact, rememberSecret: value => { secrets.add(value); } });
      let failure: (Error & { cleanupIncomplete?: true }) | undefined;
      try {
        for (const account of testAccounts(await definition.accounts!(ctx), `${record.id} accounts`)) {
          secrets.add(account.password);
          if (state.accounts.some(item => item.id === account.id)) fail(`Test account "${account.id}" is defined twice.`);
          state.accounts.push({ service: record.id, ...account });
        }
      } catch (error) {
        failure = Object.assign(new Error(`${definition.title}: ${redact((error as Error).message)}`), (error as { cleanupIncomplete?: true }).cleanupIncomplete ? { cleanupIncomplete: true as const } : {});
        throw failure;
      } finally { await save(failure); }
    }
    // Command fixtures, such as seed scripts, run with the workspace dependencies the install provides.
    if (config.install) {
      await onStep('Installing dependencies');
      await oneShot(twin, INSTALL, `Install "${config.install.command}" in ${config.install.directory}`, redact);
    }
    // Command fixtures share the twin's package cache: the repository's, or the twin's own, which Compose made with the
    // source copy. A twin without a workspace has no cache of its own, so a fixture's container keeps one, removed with it.
    const fixtureCache = cache ?? (workspace ? `${twin.project}_${OWN_CACHE_VOLUME}` : undefined);
    for (const [index, fixture] of fixtures.entries()) {
      await onStep(`Loading fixture ${index + 1} of ${fixtures.length}`);
      await loadFixture(twin, fixture, (resolved[fixture.service] as Ready).env, source, redact, workspace, nodeImage(config, appImage), fixtureCache);
    }
    // Each app's build runs once, in config order, after the install and fixtures and before any app starts; its output
    // stays in the workspace the app starts from.
    for (const build of result.builds) {
      await onStep(`Building ${build.app}`);
      await oneShot(twin, build.service, `Build "${build.command}" of app ${build.app}`, redact);
    }
    if (names.length) {
      await onStep('Starting twin');
      await docker(composeArgs(twin, 'up', '--wait'), { redact });
    }
    // Accounts go out without their passwords; account() reads one for a run.
    const accounts = state.accounts.map(({ id: accountId, label, username }) => ({ id: accountId, label, username }));
    return { status: result.services.some(service => service.status === 'blocked') ? 'blocked' : 'ready', services: result.services, apps: result.apps, ...(accounts.length ? { accounts } : {}) };
  }

  async function prepare(options: Parameters<typeof prepareTwin>[0]) {
    const twin = locate(options.dataDir, options.id);
    setupLogs.set(twin.dir, '');
    return operations.run({ signal: options.signal, output: text => setupLogs.set(twin.dir, ((setupLogs.get(twin.dir) ?? '') + text).slice(-LOG_LIMIT)) }, async () => {
      let failed = false;
      try { return await prepareTwin(options); }
      catch (error) { failed = true; throw error; }
      finally {
        try { if (await exists(twin.dir)) {
          await privateDirectory(twin.dir, PRIVATE_STORAGE, { resolveAliases: false });
          await writeStateFile(twin.log, setupLogs.get(twin.dir) ?? '', { removeTemporary: true });
        } }
        catch (error) { if (!failed) throw error; } // A log write must not replace an owned-process cleanup failure.
      }
    });
  }

  /** One test account's username, password and sign-in endpoints, for the controller's own runs; null when the twin has no such account. */
  async function account({ dataDir, id, accountId }: { dataDir: string; id: string; accountId: string }) {
    const found = (await readState(locate(dataDir, id).state))?.accounts?.find(item => item.id === accountId);
    return found ? { username: found.username, password: found.password, authEndpoints: found.authEndpoints ?? [] } : null;
  }

  async function health({ dataDir, id }: { dataDir: string; id: string }): Promise<TwinHealth> {
    const twin = locate(dataDir, id);
    if (!await exists(twin.compose)) return { status: 'stopped', containers: [] };
    const state = await readState(twin.state);
    const redact = redactor([...(state?.secrets ?? []), ...(diagnosticSecrets.get(twin.dir) ?? [])]);
    const { stdout } = await operations.run({ timeoutMs: READ_TIMEOUT_MS }, () => docker(composeArgs(twin, 'ps', '--all', '--format', 'json'), { redact }));
    const containers = parsePs(stdout).map(item => ({ name: String(item.Service), state: String(item.State), health: typeof item.Health === 'string' && item.Health ? item.Health : null, exitCode: typeof item.ExitCode === 'number' ? item.ExitCode : null }));
    // A separate service stack cannot supply the twin's missing Compose containers.
    if (!containers.length) return { status: 'stopped', containers };
    // Nor can the containers left supply a removed one, which is named so its environment says which service is gone.
    const listed = new Set(containers.map(item => item.name));
    containers.push(...(await upServices(twin.compose)).filter(name => !listed.has(name)).map(name => ({ name, state: REMOVED, health: null, exitCode: null })));
    // Blocked services have no resource record. A restarted controller reads the same owned names from the adapter.
    for (const record of state?.services ?? []) {
      const definition = services[record.id];
      if (!definition?.healthContainers) continue;
      try {
        const expected = await definition.healthContainers({ project: twin.project, dir: join(twin.dir, 'services', record.id) });
        if (!expected.length) continue;
        const inspected = await operations.run({ timeoutMs: READ_TIMEOUT_MS }, () => docker(['inspect', '--type', 'container', '--format', HEALTH_FORMAT, ...expected.map(item => item.name)], { redact }));
        containers.push(...inspectedHealth(inspected.stdout, expected));
      } catch (error) { throw new Error(`${definition.title}: ${redactSecrets(redact((error as Error).message))}`); }
    }
    return { status: overall(containers), containers };
  }

  async function logs({ dataDir, id, service, tail = 200 }: { dataDir: string; id: string; service?: string | null; tail?: number }) {
    const twin = locate(dataDir, id);
    if (!Number.isInteger(tail) || tail < 1) fail('tail must be a positive whole number.');
    if (service != null && !ID.test(service)) fail('Choose a service or app of this twin.');
    const setup = setupLogs.get(twin.dir) ?? await readFile(twin.log, 'utf8').catch(() => '');
    const state = await readState(twin.state);
    // Older twins predate registration at the request boundary; their validated private state
    // still supplies account values and the adapter knows which configured values are private.
    const secrets = [...(state?.secrets ?? []), ...(diagnosticSecrets.get(twin.dir) ?? []), ...(state?.accounts ?? []).flatMap(account => [account.username, account.password])];
    for (const record of state?.services ?? []) {
      try { secrets.push(...(services[record.id]?.diagnosticSecrets?.(record.options) ?? [])); }
      catch { throw new Error('Service logs unavailable: private account values could not be read safely.'); }
    }
    const redact = redactor(secrets), parts = [diagnosticText(redact(setup), LOG_LIMIT)];
    const deadline = Date.now() + READ_TIMEOUT_MS, signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const read = (args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Log collection reached its 20-second deadline.');
      return operations.run({ signal, timeoutMs: remaining, outputLimitBytes: 1024 * 1024 }, () => docker(args, { redact }));
    };
    const unavailable = (name: string, error: unknown) => `${name} logs unavailable: ${failureText(redact((error as Error)?.message ?? error), 600)}`;
    if (await exists(twin.compose)) {
      try {
        const { stdout = '', stderr = '' } = await read(composeArgs(twin, 'logs', '--no-color', '--tail', String(Math.min(tail, 200)), ...(service ? [service] : [])));
        parts.push(diagnosticText(redact(`${stdout}${stderr}`), LOG_LIMIT));
      } catch (error) { parts.push(unavailable('Compose', error)); }
    }
    // CLI-owned services live outside Compose. Verify each exact name and its ownership label,
    // then use its immutable ID for logs so a name reused between inspect and logs cannot leak data.
    let count = 0;
    for (const record of state?.services ?? []) {
      const definition = services[record.id];
      if (!definition?.healthContainers || service && service !== record.id) continue;
      try {
        const expected = await definition.healthContainers({ project: twin.project, dir: join(twin.dir, 'services', record.id) });
        for (const container of expected) {
          if (++count > 8) { parts.push('Further service logs omitted: container limit reached.'); break; }
          try {
            const observed = await read(['inspect', '--type', 'container', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}', container.name]);
            const value = fields(JSON.parse(observed.stdout) as unknown), labels = fields(value?.labels);
            if (!value || value.name !== `/${container.name}` || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
              || !labels || !Object.keys(container.labels).length || Object.entries(container.labels).some(([name, content]) => labels[name] !== content)) throw new Error('Container ownership could not be verified.');
            const { stdout = '', stderr = '' } = await read(['logs', '--tail', String(Math.min(tail, 200)), value.id]);
            parts.push(`${container.name}\n${diagnosticText(redact(`${stdout}${stderr}`), 8000)}`);
          } catch (error) { parts.push(unavailable(container.name, error)); }
        }
      } catch (error) { parts.push(unavailable(definition.title, error)); }
      if (count > 8) break;
    }
    return diagnosticText(redact(parts.filter(Boolean).join('\n')));
  }

  /** Compose down --volumes, then each service's teardown in reverse setup order. Failures keep the files. */
  async function destroyTwin({ dataDir, id, inputs = {} }: { dataDir: string; id: string; inputs?: Record<string, InputValues> }) {
    const twin = locate(dataDir, id);
    const state = await readState(twin.state);
    const redact = redactor([...(state?.secrets ?? []), ...(diagnosticSecrets.get(twin.dir) ?? [])]), failures: string[] = [];
    if (await exists(twin.compose)) {
      try { await docker(composeArgs(twin, 'down', '--volumes', '--remove-orphans'), { redact }); }
      catch (error) { failures.push(`Compose: ${(error as Error).message}`); }
    }
    for (const record of [...(state?.services ?? [])].reverse()) {
      const definition = services[record.id];
      if (!definition?.teardown) continue;
      // A service record comes from the state, so the state is there.
      const take = (key: string) => state!.ports[key] ?? fail(`No host port was allocated for ${key}.`);
      const ctx = context(twin, { service: record.id, options: record.options, inputs: inputs[record.id] ?? {}, outputs: record.outputs ?? {}, ports: state!.ports, take, source: state!.source, redact });
      try { await definition.teardown(ctx); }
      catch (error) { failures.push(`${definition.title}: ${redact((error as Error).message)}`); }
    }
    // Stopping a docker CLI does not stop a `docker run` guest. One-shot fixtures and
    // service CLIs carry both labels; remove only this twin's remaining containers.
    if (state) {
      try {
        const remaining = async () => {
          const { stdout } = await docker(['ps', '--all', '--quiet', '--filter', `label=${LABELS.environment}=${twin.id}`, '--filter', `label=${LABELS.owner}=${twin.owner}`], { redact });
          const ids = stdout.trim().split(/\s+/).filter(Boolean);
          if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) fail('Docker returned invalid owned container ids.');
          return ids;
        };
        const ids = await remaining();
        if (ids.length) {
          await docker(['rm', '--force', ...ids], { redact });
          if ((await remaining()).length) fail('Owned containers are still present.');
          // Compose only warns about a volume such a guest still mounted, so its down runs again now the guest is gone.
          if (await exists(twin.compose)) await docker(composeArgs(twin, 'down', '--volumes', '--remove-orphans'), { redact });
        }
      } catch (error) { failures.push(`Owned containers: ${redact((error as Error).message)}`); }
      try {
        const { stdout } = await docker(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${twin.project}`], { redact });
        if (stdout.trim()) fail('The twin\'s volumes are still present.');
      } catch (error) { failures.push(`Owned volumes: ${redact((error as Error).message)}`); }
    }
    if (failures.length) fail(`Twin cleanup failed; its files are kept for another attempt. ${failures.join(' ')}`);
    await rm(twin.dir, { recursive: true, force: true });
    setupLogs.delete(twin.dir);
    diagnosticSecrets.delete(twin.dir);
    return { status: 'destroyed' };
  }

  const destroy = (options: Parameters<typeof destroyTwin>[0]) => operations.run({ timeoutMs: CLEANUP_TIMEOUT_MS }, () => destroyTwin(options));

  /**
   * Why Docker cannot build a twin now, such as an engine that is not running, or null when its engine answers: one
   * bounded `docker version`, run as every twin command is, so it reaches the same engine.
   */
  async function available(): Promise<string | null> {
    try {
      const { stdout } = await operations.run({ timeoutMs: ENGINE_TIMEOUT_MS, outputLimitBytes: 1024 * 1024 }, () => docker(['version', '--format', '{{.Server.Version}}']));
      return stdout.trim() ? null : 'Docker is not available. Its engine reported no version.';
    } catch (error) {
      const failed = error as Error & { timedOut?: true };
      return `Docker is not available. ${failed.timedOut ? `It did not answer within ${ENGINE_TIMEOUT_MS / 1000} seconds.` : failed.message.trim().split('\n')[0]}`;
    }
  }

  return { prepare, health, logs, destroy, account, available };
}
export type TwinRuntime = ReturnType<typeof createTwinRuntime>;
/** What prepare returns: the twin's status, service summaries, app URLs and test accounts without passwords. */
export type PreparedTwin = Awaited<ReturnType<TwinRuntime['prepare']>>;
