import { execFile, type ExecFileException } from 'node:child_process';
import { localDockerEnvironment } from '../process.ts';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface SandboxResources { cpus: number; memoryMiB: number; pids: number; shmMiB: number }
export type SandboxStatus = 'creating' | 'running' | 'paused' | 'restarting' | 'stopped' | 'missing' | 'destroyed' | 'failed' | 'cleanup_failed';
export interface SandboxRecord {
  version: 1; id: string; ownerId: string; name: string; status: SandboxStatus;
  image: string; imageId: string | null; containerId: string | null; apiUrl: string | null; desktopUrl: string | null; dockerHost: string | null;
  resources: SandboxResources; createdAt: string; persistence: 'manual'; updatedAt?: string; publishedPorts?: Record<string, number>;
  readyAt?: string; inspectedAt?: string; destroyedAt?: string; cleanedAt?: string; error?: string; errorCode?: string; cleanupError?: string;
}
export interface LocalDocker { host: string; command(args: string[], operation: string, timeout?: number, maxOutputBytes?: number): Promise<string> }
interface Store { directory: string; ownerId: string }
interface Lease { pid: number; token: string; choosing: boolean; ticket: number }
// Stored records are read back as records of unknown fields and validated before use.
type Fields = { readonly [key: string]: unknown };
// Docker inspection output, as far as it is read here; each value is still checked before it is trusted.
interface DockerPortBinding { HostIp?: string; HostPort?: string }
type DockerPorts = Record<string, DockerPortBinding[] | null>;
interface DockerContainer {
  Id?: string; Name?: string; Image?: string;
  Config?: { Labels?: Record<string, string> | null } | null;
  State?: { Paused?: boolean; Running?: boolean; Restarting?: boolean } | null;
  NetworkSettings?: { Ports?: DockerPorts | null } | null;
  HostConfig?: {
    Privileged?: boolean; NetworkMode?: string; Binds?: unknown[] | null; VolumesFrom?: unknown[] | null; Devices?: unknown[] | null; CapAdd?: unknown[] | null;
    PidMode?: string; IpcMode?: string; NanoCpus?: number; Memory?: number; PidsLimit?: number | null; PortBindings?: DockerPorts | null; PublishAllPorts?: boolean;
  } | null;
  Mounts?: { Type?: string }[] | null;
}
type OwnedContainer = DockerContainer & { Id: string };

const DEFAULT_IMAGE = 'public.ecr.aws/k5j5w0x5/cua-ubuntu-24.04:docker-latest';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const LABELS = { managed: 'perpetual.managed', owner: 'perpetual.owner', id: 'perpetual.sandbox' };
const COMMAND_TIMEOUT = 30_000;
const READINESS_TIMEOUT = 120_000;
const LOCK_TIMEOUT = 15_000;
// The Cua guest image publishes computer-server (API) and noVNC (desktop) on these ports.
const GUEST_PORTS = { api: 8000, desktop: 6080 };
const tcp = (port: number) => `${port}/tcp`;
const PUBLISHED_PORTS = Object.values(GUEST_PORTS).map(tcp);
// Failures that leave the local engine unconsulted, so they say nothing about a sandbox's container.
const UNCONSULTED = new Set(['DOCKER_UNAVAILABLE', 'DOCKER_REMOTE_UNSUPPORTED', 'DOCKER_CONTEXT_INVALID', 'DOCKER_CONTEXT_MISMATCH', 'DOCKER_LINUX_REQUIRED']);

class SandboxError extends Error {
  declare code: string;
  declare sandboxId?: string;
  declare record?: SandboxRecord;
  constructor(message: string, code = 'SANDBOX_ERROR') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

function sandboxId(id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new SandboxError('Choose a valid sandbox ID.', 'SANDBOX_INVALID_ID');
  return id;
}

function containerName(id: unknown) { return `perpetual-cua-${sandboxId(id)}`; }

function imageName(image: unknown) {
  if (typeof image !== 'string' || image.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(image)) {
    throw new SandboxError('Choose a valid Cua Linux image reference.', 'SANDBOX_INVALID_IMAGE');
  }
  return image;
}

function resourceLimits(cpus: unknown, memoryMiB: unknown): SandboxResources {
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.25 || cpus > 64
    || typeof memoryMiB !== 'number' || !Number.isInteger(memoryMiB) || memoryMiB < 1024 || memoryMiB > 131072) {
    throw new SandboxError('Use 0.25–64 CPUs and 1024–131072 MiB of memory.', 'SANDBOX_INVALID_LIMITS');
  }
  return { cpus, memoryMiB, pids: 1024, shmMiB: 512 };
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SandboxError('Sandbox storage must be a regular directory.', 'SANDBOX_STORAGE_INVALID');
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function jsonFile(file: string, missingCode = 'SANDBOX_STORAGE_INVALID'): Promise<Fields> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error('Invalid record');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    // A JSON null or scalar is an invalid record too, not a later TypeError.
    if (!value || typeof value !== 'object') throw new Error('Invalid record');
    return value as Fields;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SandboxError('Sandbox record not found.', missingCode);
    throw new SandboxError('Sandbox storage contains an invalid record.', 'SANDBOX_STORAGE_INVALID');
  }
}

async function temporaryJson(directory: string, value: unknown) {
  const path = join(directory, `.tmp-${randomUUID()}`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  await file.close();
  return path;
}

async function storeFor(dataDir: unknown): Promise<Store> {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) {
    throw new SandboxError('A local data directory is required.', 'SANDBOX_STORAGE_INVALID');
  }
  const root = await privateDirectory(resolve(dataDir));
  const directory = await privateDirectory(join(root, 'sandboxes'));
  const ownerPath = join(directory, '.owner.json');
  const temporary = await temporaryJson(directory, { version: 1, ownerId: randomUUID() });
  try {
    // Hard-linking a complete file publishes the owner atomically without replacing it.
    try { await link(temporary, ownerPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  const owner = await jsonFile(ownerPath);
  if (owner.version !== 1 || typeof owner.ownerId !== 'string' || !UUID.test(owner.ownerId)) throw new SandboxError('Sandbox storage owner is invalid.', 'SANDBOX_STORAGE_INVALID');
  await chmod(ownerPath, 0o600);
  return { directory, ownerId: owner.ownerId };
}

const STATUSES: Record<SandboxStatus, true> = { creating: true, running: true, paused: true, restarting: true, stopped: true, missing: true, destroyed: true, failed: true, cleanup_failed: true };
const textOrNull = (value: unknown) => value === null || typeof value === 'string';
const isResources = (value: unknown): value is SandboxResources => Boolean(value) && typeof value === 'object'
  && (['cpus', 'memoryMiB', 'pids', 'shmMiB'] as const).every(field => typeof (value as Fields)[field] === 'number');
// Every field this adapter reads, in the types it saves them with.
const validRecord = (record: Fields): record is Fields & SandboxRecord => record.version === 1 && typeof record.id === 'string' && typeof record.ownerId === 'string'
  && typeof record.status === 'string' && Object.hasOwn(STATUSES, record.status)
  && typeof record.image === 'string' && typeof record.createdAt === 'string' && record.persistence === 'manual' && isResources(record.resources)
  && (['imageId', 'containerId', 'apiUrl', 'desktopUrl', 'dockerHost'] as const).every(field => textOrNull(record[field]));

async function readRecord(store: Store, id: unknown): Promise<SandboxRecord> {
  const record = await jsonFile(join(store.directory, `${sandboxId(id)}.json`), 'SANDBOX_NOT_FOUND');
  if (record.version !== 1 || record.id !== id || record.ownerId !== store.ownerId
    || (record.containerId != null && !CONTAINER_ID.test(String(record.containerId)))
    || (record.imageId != null && !IMAGE_ID.test(String(record.imageId)))) {
    throw new SandboxError('Sandbox record does not belong to this instance.', 'SANDBOX_OWNERSHIP');
  }
  if (!validRecord(record)) throw new SandboxError('Sandbox storage contains an invalid record.', 'SANDBOX_STORAGE_INVALID');
  return { ...record, name: containerName(id) };
}

async function saveRecord(store: Store, record: SandboxRecord): Promise<SandboxRecord> {
  const next = { ...record, name: containerName(record.id), updatedAt: new Date().toISOString() };
  const temporary = await temporaryJson(store.directory, next);
  try { await rename(temporary, join(store.directory, `${record.id}.json`)); }
  finally { await unlink(temporary).catch(() => {}); }
  return next;
}

async function withLock<T>(store: Store, id: unknown, work: () => Promise<T>): Promise<T> {
  const directory = await privateDirectory(join(store.directory, `.${sandboxId(id)}.locks`));
  const token = randomUUID();
  const leasePath = join(directory, `lease-${process.pid}-${token}.json`);
  const lease: Lease = { pid: process.pid, token, choosing: true, ticket: 0 };
  const deadline = Date.now() + LOCK_TIMEOUT;
  async function publish(value: Lease) {
    const temporary = await temporaryJson(directory, value);
    try { await rename(temporary, leasePath); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function activeLeases() {
    const result: Lease[] = [];
    for (const name of await readdir(directory)) {
      if (!/^lease-\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const path = join(directory, name);
      let entry: Fields;
      try { entry = await jsonFile(path, 'SANDBOX_LEASE_GONE'); }
      catch (error) { if ((error as SandboxError).code === 'SANDBOX_LEASE_GONE') continue; throw error; }
      if (!Number.isSafeInteger(entry.pid) || (entry.pid as number) < 1 || !UUID.test(String(entry.token || ''))
        || name !== `lease-${entry.pid}-${entry.token}.json` || typeof entry.choosing !== 'boolean'
        || !Number.isSafeInteger(entry.ticket) || (entry.ticket as number) < 0 || (!entry.choosing && entry.ticket === 0)) {
        throw new SandboxError('A sandbox operation lease is invalid.', 'SANDBOX_STORAGE_INVALID');
      }
      const valid = entry as Fields & Lease;
      try { process.kill(valid.pid, 0); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          // Each lease has a never-reused UUID path. Concurrent recovery cannot
          // unlink a replacement lock belonging to a new, live operation.
          try { await unlink(path); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
          continue;
        }
        if (code !== 'EPERM') throw error;
      }
      result.push(valid);
    }
    return result;
  }
  try {
    // Publish the choosing phase before reading tickets (Lamport's bakery
    // protocol). A late contender receives a higher ticket, even while the
    // earlier operation is waiting through a long image pull.
    await publish(lease);
    lease.ticket = 1 + Math.max(0, ...(await activeLeases()).map(entry => entry.ticket));
    if (!Number.isSafeInteger(lease.ticket)) throw new SandboxError('Sandbox operation queue is full.', 'SANDBOX_BUSY');
    lease.choosing = false;
    await publish(lease);
    while (true) {
      const blocked = (await activeLeases()).some(entry => entry.token !== token
        && (entry.choosing || entry.ticket < lease.ticket || (entry.ticket === lease.ticket && entry.token < token)));
      if (!blocked) break;
      if (Date.now() >= deadline) throw new SandboxError('Another operation is using this sandbox.', 'SANDBOX_BUSY');
      await delay(150);
    }
    return await work();
  } finally {
    await unlink(leasePath).catch(() => {});
  }
}

const dockerEnvironment = () => localDockerEnvironment();

function dockerFailure(error: ExecFileException | SandboxError, operation: string) {
  if (error instanceof SandboxError) return error;
  if (error.code === 'ENOENT') return new SandboxError('Docker is unavailable. Install Docker and start its local engine.', 'DOCKER_UNAVAILABLE');
  if (error.killed || error.code === 'ETIMEDOUT') return new SandboxError(`${operation} timed out.`, 'DOCKER_TIMEOUT');
  const detail = String(error.stderr || '').toLowerCase();
  if (/no space left on device/.test(detail)) {
    return new SandboxError(`${operation} failed because Docker storage is full. Free space used by Docker or increase its disk allocation, then retry.`, 'DOCKER_DISK_FULL');
  }
  if (/no such (?:container|object):/.test(detail)) return new SandboxError('The sandbox container no longer exists.', 'DOCKER_CONTAINER_MISSING');
  if (/no such image:/.test(detail)) return new SandboxError('The sandbox image is not available locally.', 'DOCKER_IMAGE_MISSING');
  if (/cannot connect|is the docker daemon running|error during connect|connection refused/.test(detail)) {
    return new SandboxError('The local Docker engine is unavailable.', 'DOCKER_UNAVAILABLE');
  }
  return new SandboxError(`${operation} failed. Check the local Docker engine.`, 'DOCKER_ERROR');
}

async function dockerCommand(args: string[], operation: string, timeout = COMMAND_TIMEOUT, maxOutputBytes = 4 * 1024 * 1024) {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 4096 || maxOutputBytes > 12 * 1024 * 1024) throw new SandboxError('Invalid Docker output limit.');
  try {
    const { stdout } = await exec('docker', args, {
      env: dockerEnvironment(), encoding: 'utf8', timeout, maxBuffer: maxOutputBytes, windowsHide: true,
    });
    return stdout.trim();
  } catch (error) { throw dockerFailure(error as ExecFileException, operation); }
}

function localDockerHost(host: unknown) {
  // A TCP/SSH daemon may bind ports on another machine, making loopback URLs unsafe.
  if (typeof host !== 'string' || host.includes('\0') || (!/^unix:\/\/\/[^\r\n]+$/.test(host)
    && !/^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(host))) {
    throw new SandboxError('Choose a local Docker socket; remote Docker contexts are not supported.', 'DOCKER_REMOTE_UNSUPPORTED');
  }
  return host;
}

export async function localDocker(expectedHost?: string | null): Promise<LocalDocker> {
  let configured: unknown;
  if (process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST) {
    const context = process.env.DOCKER_CONTEXT || await dockerCommand(['context', 'show'], 'Reading Docker context');
    if (!context || context.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(context)) throw new SandboxError('Docker context is invalid.', 'DOCKER_CONTEXT_INVALID');
    const raw = await dockerCommand(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], 'Reading Docker context');
    try { configured = JSON.parse(raw); }
    catch { throw new SandboxError('Docker context does not expose a local engine.', 'DOCKER_CONTEXT_INVALID'); }
  } else configured = process.env.DOCKER_HOST;
  const host = localDockerHost(configured);
  if (expectedHost && expectedHost !== host) throw new SandboxError('Select the local Docker context used to create this sandbox.', 'DOCKER_CONTEXT_MISMATCH');
  const command = (args: string[], operation: string, timeout?: number, maxOutputBytes?: number) => dockerCommand(['--host', host, ...args], operation, timeout, maxOutputBytes);
  const os = await command(['info', '--format', '{{.OSType}}'], 'Connecting to Docker');
  if (os !== 'linux') throw new SandboxError('Cua requires a local Docker engine running Linux containers.', 'DOCKER_LINUX_REQUIRED');
  return { host, command };
}

function dockerJson(raw: string): object {
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object') throw new Error('Invalid inspection');
    return items[0];
  } catch { throw new SandboxError('Docker returned an unreadable inspection result.', 'DOCKER_INVALID_RESPONSE'); }
}

async function resolveImage(docker: LocalDocker, image: string) {
  let data: { Id?: unknown; Os?: unknown };
  try { data = dockerJson(await docker.command(['image', 'inspect', image], 'Inspecting sandbox image')); }
  catch (error) {
    if ((error as SandboxError).code !== 'DOCKER_IMAGE_MISSING') throw error;
    await docker.command(['image', 'pull', image], 'Downloading sandbox image', 600_000);
    data = dockerJson(await docker.command(['image', 'inspect', image], 'Inspecting sandbox image'));
  }
  if (typeof data.Id !== 'string' || !IMAGE_ID.test(data.Id) || data.Os !== 'linux') throw new SandboxError('Choose a Linux image with the Cua computer-server protocol.', 'SANDBOX_INVALID_IMAGE');
  return data.Id;
}

async function lookupContainer(docker: LocalDocker, record: SandboxRecord): Promise<OwnedContainer | null> {
  let container: DockerContainer;
  try { container = dockerJson(await docker.command(['container', 'inspect', containerName(record.id)], 'Inspecting sandbox')); }
  catch (error) {
    if ((error as SandboxError).code === 'DOCKER_CONTAINER_MISSING') return null;
    throw error;
  }
  const labels: Record<string, string> = container.Config?.Labels || {};
  if (!CONTAINER_ID.test(container.Id || '') || container.Name !== `/${containerName(record.id)}`
    || labels[LABELS.managed] !== 'true' || labels[LABELS.owner] !== record.ownerId || labels[LABELS.id] !== record.id
    || (record.containerId && record.containerId !== container.Id)) {
    throw new SandboxError('The container does not belong to this sandbox. No changes were made.', 'SANDBOX_OWNERSHIP');
  }
  return container as OwnedContainer;
}

function exposedPorts(container: DockerContainer) {
  const ports: DockerPorts = container.NetworkSettings?.Ports || {};
  const allocated: Record<string, number> = {};
  for (const [port, bindings] of Object.entries(ports)) {
    if (bindings == null) continue;
    if (!PUBLISHED_PORTS.includes(port) || !Array.isArray(bindings) || bindings.length !== 1) {
      throw new SandboxError('Sandbox port bindings do not match the local-only configuration.', 'SANDBOX_PORTS_INVALID');
    }
    const binding = bindings[0];
    if (binding?.HostIp !== '127.0.0.1' || !/^\d{1,5}$/.test(binding.HostPort || '')
      || Number(binding.HostPort) < 1 || Number(binding.HostPort) > 65535) {
      throw new SandboxError('Sandbox ports must be bound to 127.0.0.1.', 'SANDBOX_PORTS_INVALID');
    }
    allocated[port] = Number(binding.HostPort);
  }
  const api = allocated[tcp(GUEST_PORTS.api)], desktop = allocated[tcp(GUEST_PORTS.desktop)];
  if (!api || !desktop) throw new SandboxError('Sandbox API or desktop port is not available.', 'SANDBOX_PORTS_INVALID');
  return {
    publishedPorts: Object.fromEntries(Object.entries(allocated).map(([key, value]) => [key.split('/')[0], value])),
    apiUrl: `http://127.0.0.1:${api}`,
    desktopUrl: `http://127.0.0.1:${desktop}/`,
  };
}

function validateContainer(container: DockerContainer, record: SandboxRecord) {
  const config: NonNullable<DockerContainer['HostConfig']> = container.HostConfig || {};
  const limits = record.resources;
  if (container.Image !== record.imageId || config.Privileged || !['default', 'bridge'].includes(config.NetworkMode ?? '')
    || config.Binds?.length || config.VolumesFrom?.length || config.Devices?.length || config.CapAdd?.length
    || config.PidMode === 'host' || config.IpcMode === 'host'
    || (container.Mounts || []).some(mount => mount.Type === 'bind')
    || !limits || config.NanoCpus !== Math.round(limits.cpus * 1_000_000_000)
    || config.Memory !== limits.memoryMiB * 1024 * 1024 || config.PidsLimit !== limits.pids) {
    throw new SandboxError('Sandbox isolation or resource settings have changed.', 'SANDBOX_CONFIG_CHANGED');
  }
  const bindings: DockerPorts = config.PortBindings || {};
  if (config.PublishAllPorts || Object.keys(bindings).length !== PUBLISHED_PORTS.length || PUBLISHED_PORTS.some(port => {
    const values = bindings[port];
    return !Array.isArray(values) || values.length !== 1 || values[0]?.HostIp !== '127.0.0.1'
      || (values[0].HostPort !== '' && (!/^\d{1,5}$/.test(values[0].HostPort || '')
        || Number(values[0].HostPort) < 1 || Number(values[0].HostPort) > 65535));
  })) throw new SandboxError('Sandbox ports must use the local-only configuration.', 'SANDBOX_PORTS_INVALID');
}

function statusOf(container: DockerContainer) {
  if (container.State?.Paused) return 'paused';
  if (container.State?.Running && !container.State?.Restarting) return 'running';
  if (container.State?.Restarting) return 'restarting';
  return 'stopped';
}

function apiReady(apiUrl: string) {
  return new Promise<boolean>(resolveReady => {
    const request = get(`${apiUrl}/status`, { agent: false, timeout: 3000 }, response => {
      response.resume();
      resolveReady(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveReady(false));
  });
}

async function waitUntilReady(docker: LocalDocker, record: SandboxRecord) {
  const deadline = Date.now() + READINESS_TIMEOUT;
  while (Date.now() < deadline) {
    const container = await lookupContainer(docker, record);
    if (!container || statusOf(container) !== 'running') throw new SandboxError('The sandbox exited before its API was ready.', 'SANDBOX_START_FAILED');
    validateContainer(container, record);
    const urls = exposedPorts(container);
    if (await apiReady(urls.apiUrl)) return { container, urls };
    await delay(1500);
  }
  throw new SandboxError('The Cua computer-server did not become ready.', 'SANDBOX_NOT_READY');
}

async function removeOwnedContainer(docker: LocalDocker, record: SandboxRecord) {
  const container = await lookupContainer(docker, record);
  if (!container) return;
  try { await docker.command(['container', 'rm', '--force', '--volumes', container.Id], 'Deleting sandbox', 90_000); }
  catch (error) {
    // A racing external deletion can make rm fail; only a fresh inspection proves absence.
    if (await lookupContainer(docker, record)) throw error;
    return;
  }
  if (await lookupContainer(docker, record)) throw new SandboxError('Docker still reports the sandbox container.', 'SANDBOX_CLEANUP_FAILED');
}

/** Create a persistent local sandbox. Only explicit destroy removes a healthy sandbox. */
export async function createSandbox({ dataDir, image = DEFAULT_IMAGE, cpus = 2, memoryMiB = 4096 }: { dataDir?: unknown; image?: string; cpus?: number; memoryMiB?: number } = {}): Promise<SandboxRecord> {
  image = imageName(image);
  const resources = resourceLimits(cpus, memoryMiB);
  const store = await storeFor(dataDir);
  const id = randomUUID();
  return withLock(store, id, async () => {
    let record = await saveRecord(store, {
      version: 1, id, ownerId: store.ownerId, name: containerName(id), status: 'creating',
      image, imageId: null, containerId: null, apiUrl: null, desktopUrl: null, dockerHost: null,
      resources, createdAt: new Date().toISOString(), persistence: 'manual',
    });
    let docker: LocalDocker | undefined;
    let creationAttempted = false;
    try {
      docker = await localDocker();
      record = await saveRecord(store, { ...record, dockerHost: docker.host });
      const imageId = await resolveImage(docker, image);
      record = await saveRecord(store, { ...record, imageId });
      creationAttempted = true;
      const containerId = await docker.command([
        'container', 'create', '--name', containerName(id),
        '--label', `${LABELS.managed}=true`, '--label', `${LABELS.owner}=${store.ownerId}`, '--label', `${LABELS.id}=${id}`,
        '--cpus', String(resources.cpus), '--memory', `${resources.memoryMiB}m`, '--memory-swap', `${resources.memoryMiB}m`,
        '--pids-limit', String(resources.pids), '--shm-size', `${resources.shmMiB}m`, '--restart', 'no',
        ...PUBLISHED_PORTS.flatMap(port => ['--publish', `127.0.0.1::${port}`]), imageId,
      ], 'Creating sandbox', 120_000);
      if (!CONTAINER_ID.test(containerId)) throw new SandboxError('Docker did not return a valid sandbox ID.', 'DOCKER_INVALID_RESPONSE');
      record = await saveRecord(store, { ...record, containerId });
      const created = await lookupContainer(docker, record);
      if (!created) throw new SandboxError('The created sandbox is missing.', 'SANDBOX_START_FAILED');
      validateContainer(created, record);
      await docker.command(['container', 'start', created.Id], 'Starting sandbox', 60_000);
      const { container, urls } = await waitUntilReady(docker, record);
      return await saveRecord(store, { ...record, ...urls, containerId: container.Id, status: 'running', readyAt: new Date().toISOString() });
    } catch (error) {
      let cleanupError: unknown;
      if (creationAttempted) {
        try { await removeOwnedContainer(docker!, record); }
        catch (failure) { cleanupError = failure; }
      }
      const failure = error instanceof SandboxError ? error : new SandboxError('Sandbox creation failed.', 'SANDBOX_CREATE_FAILED');
      record = await saveRecord(store, {
        ...record, status: cleanupError ? 'cleanup_failed' : 'failed', apiUrl: null, desktopUrl: null,
        error: failure.message, errorCode: failure.code,
        ...(cleanupError ? { cleanupError: cleanupError instanceof SandboxError ? cleanupError.message : 'Sandbox cleanup failed.' } : { cleanedAt: new Date().toISOString() }),
      });
      const reported = new SandboxError(cleanupError ? 'Sandbox creation failed; its container may remain. Run sandbox destroy.' : failure.message,
        cleanupError ? 'SANDBOX_CLEANUP_FAILED' : failure.code);
      reported.sandboxId = id;
      reported.record = record;
      throw reported;
    }
  });
}

/** Return saved records without contacting Docker or changing any container. */
export async function listSandboxes({ dataDir }: { dataDir?: unknown } = {}): Promise<SandboxRecord[]> {
  const store = await storeFor(dataDir);
  const files = await readdir(store.directory);
  const records = await Promise.all(files.filter(file => file.endsWith('.json') && UUID.test(file.slice(0, -5)))
    .map(file => readRecord(store, file.slice(0, -5))));
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function inspectedRecord(store: Store, record: SandboxRecord, { requireRunning = false } = {}) {
  const docker = await localDocker(record.dockerHost);
  const container = await lookupContainer(docker, record);
  if (!container) {
    if (requireRunning) throw new SandboxError('The sandbox container is missing.', 'SANDBOX_NOT_RUNNING');
    return saveRecord(store, { ...record, status: ['destroyed', 'failed'].includes(record.status) ? record.status : 'missing', apiUrl: null, desktopUrl: null });
  }
  validateContainer(container, record);
  const status = statusOf(container);
  if (requireRunning && status !== 'running') throw new SandboxError('The sandbox is not running.', 'SANDBOX_NOT_RUNNING');
  const urls = status === 'running' || status === 'paused' ? exposedPorts(container) : { apiUrl: null, desktopUrl: null };
  if (requireRunning && !await apiReady(urls.apiUrl!)) throw new SandboxError('The Cua computer-server is not ready.', 'SANDBOX_NOT_READY');
  return saveRecord(store, { ...record, ...urls, status, containerId: container.Id, inspectedAt: new Date().toISOString() });
}

export async function inspectSandbox({ dataDir, id }: { dataDir?: unknown; id?: unknown } = {}): Promise<SandboxRecord> {
  sandboxId(id);
  const store = await storeFor(dataDir);
  return withLock(store, id, async () => inspectedRecord(store, await readRecord(store, id)));
}

export async function requireRunningSandbox({ dataDir, id }: { dataDir?: unknown; id?: unknown } = {}): Promise<SandboxRecord> {
  sandboxId(id);
  const store = await storeFor(dataDir);
  return withLock(store, id, async () => inspectedRecord(store, await readRecord(store, id), { requireRunning: true }));
}

export async function destroySandbox({ dataDir, id }: { dataDir?: unknown; id?: unknown } = {}): Promise<SandboxRecord> {
  sandboxId(id);
  const store = await storeFor(dataDir);
  return withLock(store, id, async () => {
    let record = await readRecord(store, id);
    try {
      const docker = await localDocker(record.dockerHost);
      await removeOwnedContainer(docker, record);
      const { error, errorCode, cleanupError, ...retained } = record;
      return await saveRecord(store, { ...retained, status: 'destroyed', apiUrl: null, desktopUrl: null, destroyedAt: new Date().toISOString() });
    } catch (error) {
      const failure = error instanceof SandboxError ? error : new SandboxError('Sandbox deletion failed.', 'SANDBOX_CLEANUP_FAILED');
      // A cleanup already confirmed through Docker stays confirmed when the local engine cannot be consulted again.
      if (!(['destroyed', 'failed'].includes(record.status) && UNCONSULTED.has(failure.code))) {
        record = await saveRecord(store, { ...record, status: 'cleanup_failed', apiUrl: null, desktopUrl: null, cleanupError: failure.message });
      }
      failure.sandboxId = record.id;
      failure.record = record;
      throw failure;
    }
  });
}
