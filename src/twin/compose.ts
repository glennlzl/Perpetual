import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { APPS, INSTALL, PORT_VARIABLE, SOURCE, VARIABLE, fail, placeholders, resolvePlaceholders } from './config.ts';
import { relative } from './paths.ts';
import { loopbackCommand } from './loopback.ts';
import { containerLogging } from './logging.ts';
import type { Placeholder, TwinConfig } from './config.ts';
import type { Fidelity, ServiceContainer } from './registry.ts';

// Pure: resolved services + apps + allocated host ports -> compose.yaml object and .env map.
// Every environment value lives in .env; compose.yaml only references it, so it holds no secret.

export const HOST = 'host.docker.internal';
export const HOST_GATEWAY = `${HOST}:host-gateway`;
export const LOOPBACK = '127.0.0.1';
/** The Node.js majors in long-term support, still maintained, newest first. */
export const NODE_LTS = [24, 22];
/** The newest Node.js major released, maintained as the current release before any LTS. */
export const NODE_CURRENT = 26;
/** The image apps run on when their twin config names no Node.js major: the newest LTS. */
export const APP_IMAGE = `node:${NODE_LTS[0]}-bookworm-slim`;
/** The image of a twin config's Node.js major, else the default. */
export const nodeImage = (config: Pick<TwinConfig, 'node'>, fallback = APP_IMAGE) => config.node === undefined ? fallback : `node:${config.node}-bookworm-slim`;
export const WORKSPACE = '/workspace';
export const LABELS = { owner: 'perpetual.owner', environment: 'perpetual.environment' };
// Node 25+ no longer bundles Corepack. Keep the bundled version where present; this pin
// also supports Node 25, unlike the newer Corepack line requiring Node 26 or an LTS.
// Official images may already have Yarn binaries: replace those shims inside this container.
const PACKAGE_MANAGERS = '(command -v corepack >/dev/null 2>&1 || npm install --global --force corepack@0.34.7) && corepack enable || exit $?';
/**
 * Where package managers keep downloads, and Corepack the package managers it installs, so a rebuilt twin installs from
 * cache: one external volume per repository, which Perpetual owns, the repository's twins share and deleting a twin keeps.
 * It is named from a digest of the repository's identity, so another repository's twins never mount it.
 */
export const repositoryCache = (repository: string) => `perpetual-package-cache-${createHash('sha256').update(repository).digest('hex').slice(0, 16)}`;
/** A twin's own package cache, a volume of its project like its workspace: empty at first, and removed with the twin. */
export const OWN_CACHE_VOLUME = 'package-cache';
const CACHE = '/perpetual-cache';
/** A `docker run` volume that mounts a package cache where package managers look for it. */
export const cacheMount = (volume: string) => `${volume}:${CACHE}`;
// Each manager's documented cache location. pnpm needs its store named: on another filesystem than the
// project it would otherwise make one at the project's root, inside the workspace.
export const PACKAGE_CACHE_ENV = { COREPACK_HOME: `${CACHE}/corepack`, npm_config_cache: `${CACHE}/npm`, npm_config_store_dir: `${CACHE}/pnpm-store`, XDG_CACHE_HOME: `${CACHE}/xdg-cache`, YARN_CACHE_FOLDER: `${CACHE}/yarn`, BUN_INSTALL_CACHE_DIR: `${CACHE}/bun` };
// The config names these, so its validation keeps every app off them.
export { PORT_VARIABLE, SOURCE };
/** The twin's own volume holding its source, dependencies and build output; removed with the twin. */
export const WORKSPACE_VOLUME = 'workspace';
const SERVICE_HEALTH = { interval: '2s', timeout: '5s', retries: 90 };
const APP_HEALTH = { interval: '5s', timeout: '5s', retries: 3, start_period: '30m' };

/** A service after setup: ready with its variables and containers, or blocked on the inputs it misses. */
export type ResolvedService = { id: string; fidelity: Fidelity } & ({ status: 'ready'; env: Record<string, string>; containers: ServiceContainer[] } | { status: 'blocked'; missing: string[] });
export type ServiceSummary = { id: string; fidelity: Fidelity; status: 'ready' | 'blocked'; missing?: string[] };
export interface ComposeVolume { type: 'volume' | 'bind'; source: string; target: string; read_only?: boolean }
export interface ComposeHealthcheck { test: string[]; interval: string; timeout: string; retries: number; start_period?: string }
export interface ComposeService {
  image: string; command?: string | string[]; environment?: Record<string, string>; ports?: string[]; working_dir?: string; volumes?: ComposeVolume[];
  extra_hosts: string[]; labels: Record<string, string>; healthcheck?: ComposeHealthcheck; depends_on?: Record<string, { condition: string }>; profiles?: string[];
  logging: ReturnType<typeof containerLogging>;
}
export interface ComposeFile { name: string; services: Record<string, ComposeService>; volumes?: Record<string, { external?: boolean }> }
/** Host ports by portKey, e.g. { 'apps.web': 43100, 'mail.smtp': 43101 }. */
export type HostPorts = Record<string, number>;

export const portKey = (owner: string, name: string) => `${owner}.${name}`;
/** The host port a URL placeholder names, an app's or a service's named port; null for a variable placeholder. */
export function addressKey(ref: Exclude<Placeholder, { service: string }>): string;
export function addressKey(ref: Placeholder): string | null;
export function addressKey(ref: Placeholder) { return ref.app ? portKey(APPS, ref.app) : ref.addressOf ? portKey(ref.addressOf, ref.port) : null; }
export const hostUrl = (port: number, path = '') => `http://${HOST}:${port}${path}`;
/** An allocated address has explicit browser or container reachability; variable names do not choose it. */
export const addressUrl = (ref: Exclude<Placeholder, { service: string }>, port: number) => `http://${ref.public ? LOOPBACK : HOST}:${port}`;
/** Shell command run in the app image, with the repository's package manager available. */
export const appCommand = (...steps: (string | undefined)[]) => `${PACKAGE_MANAGERS}; ${steps.filter(Boolean).join(' && ')}`;
const literal = (value: string) => String(value).replaceAll('$', () => '$$');
const containerName = (service: string, name: string) => name === service ? service : `${service}-${name}`;

/** Env map from a service or setup result: drops empty values, checks names. */
export function variables(input: Readonly<Record<string, unknown>> | null | undefined, where: string) {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value != null).map(([name, value]) => {
    if (!VARIABLE.test(name)) fail(`${where} returned an invalid variable name ${name}.`);
    return [name, String(value)];
  }));
}

/** .env text: double-quoted with escapes, so no value is interpolated by Compose. */
export const formatEnv = (env: Record<string, string>) => Object.entries(env).map(([key, value]) =>
  `${key}="${String(value).replace(/[\\"$]/g, '\\$&').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"\n`).join('');

function environment(name: string, values: Record<string, string>, dotenv: Record<string, string>) {
  const prefix = name.toUpperCase().replaceAll('-', '_');
  return Object.fromEntries(Object.entries(values).map(([variable, value]) => {
    const key = `${prefix}__${variable}`;
    dotenv[key] = value;
    return [variable, `\${${key}}`];
  }));
}

function healthcheck(container: ServiceContainer, where: string): ComposeHealthcheck | null {
  const { http, command } = container.health ?? {};
  if (http) {
    const port = typeof http.port === 'number' ? http.port : container.ports?.[http.port] ?? fail(`${where} health names an unknown port ${http.port}.`);
    const url = `http://${LOOPBACK}:${port}${http.path ?? '/'}`;
    return { test: ['CMD-SHELL', literal(`wget -q -O /dev/null ${url} || curl -fsS -o /dev/null ${url}`)], ...SERVICE_HEALTH };
  }
  if (command) return { test: Array.isArray(command) ? ['CMD', ...command.map(literal)] : ['CMD-SHELL', literal(command)], ...SERVICE_HEALTH };
  return null;
}

/**
 * services: [{ id, fidelity, status: 'ready'|'blocked', missing?, env?, containers? }], in config order.
 * A container is { name, image, command?, env?, ports?: { name: containerPort }, health?, directory? };
 * `directory` runs it in that snapshot directory, like an app; `workspace` lists those containers, which need the install first.
 * ports: { '<service>.<port name>' | 'apps.<id>': hostPort }. source: absolute snapshot path.
 * cache: the repository's package cache (repositoryCache), which its twins share; without one, the twin's own.
 */
export function composeTwin({ project, owner, environment: id, source, config, services, ports, appImage: fallback = APP_IMAGE, cache }: {
  project: string; owner: string; environment: string; source: string; config: TwinConfig; services: ResolvedService[]; ports: HostPorts; appImage?: string; cache?: string;
}) {
  const appImage = nodeImage(config, fallback), cacheVolume = cache ?? OWN_CACHE_VOLUME;
  const dotenv: Record<string, string> = {}, compose: ComposeFile = { name: project, services: {} }, dependsOn: Record<string, { condition: string }> = {}, inWorkspace: string[] = [];
  const common = { extra_hosts: [HOST_GATEWAY], labels: { [LABELS.owner]: owner, [LABELS.environment]: id }, logging: containerLogging() };
  const hostPort = (key: string) => ports[key] ?? fail(`No host port was allocated for ${key}.`);
  // Repository code runs from a Docker volume, not a host bind mount: installs and builds write many small files,
  // which a host mount makes several times slower on Docker Desktop. A directory is config text, so Compose keeps it literal.
  const workspace = (directory: string): Pick<ComposeService, 'working_dir' | 'volumes'> => ({ working_dir: literal(posix.join(WORKSPACE, directory)), volumes: [{ type: 'volume', source: WORKSPACE_VOLUME, target: WORKSPACE }, { type: 'volume', source: cacheVolume, target: CACHE }] });
  const ready = services.filter(service => service.status === 'ready');
  const blocked = new Set<string | undefined>(services.filter(service => service.status !== 'ready').map(service => service.id));
  const provided = Object.fromEntries(ready.map(service => [service.id, service.env ?? {}]));

  for (const service of ready) for (const container of service.containers ?? []) {
    const name = containerName(service.id, container.name), where = `${service.id} container ${container.name}`;
    const health = healthcheck(container, where);
    compose.services[name] = {
      image: container.image,
      ...(container.command == null ? {} : { command: Array.isArray(container.command) ? container.command.map(literal) : literal(container.command) }),
      environment: { ...(container.directory == null ? {} : PACKAGE_CACHE_ENV), ...environment(name, variables(container.env, where), dotenv) },
      ports: Object.entries(container.ports ?? {}).map(([port, target]) => `${LOOPBACK}:${hostPort(portKey(service.id, port))}:${target}`),
      ...(container.directory == null ? {} : workspace(relative(container.directory, `${where} directory`))),
      ...common, ...(health ? { healthcheck: health } : {}),
    };
    dependsOn[name] = { condition: health ? 'service_healthy' : 'service_started' };
    if (container.directory != null) inWorkspace.push(name);
  }

  // A one-shot service under a profile of its own name, so a plain `up` never starts it; the runtime runs it once.
  if (config.install) {
    if (compose.services[INSTALL]) fail(`A service container is named ${INSTALL}, which the install step uses.`);
    compose.services[INSTALL] = { image: appImage, ...workspace(config.install.directory), command: ['sh', '-c', literal(appCommand(config.install.command))], environment: { ...PACKAGE_CACHE_ENV }, profiles: [INSTALL], ...common };
  }

  const offered: Record<string, Map<string, string>> = {};
  for (const service of ready) for (const [variable, value] of Object.entries(provided[service.id])) (offered[variable] ??= new Map()).set(service.id, value);
  const apps: { id: string; url: string; directory: string }[] = [];
  for (const [appId, app] of Object.entries(config.apps)) {
    if (Object.hasOwn(compose.services, appId)) fail(`App "${appId}" has the same name as a service container; rename the app.`);
    const automatic: Record<string, string> = {};
    for (const [variable, sources] of Object.entries(offered)) {
      if (Object.hasOwn(app.env, variable)) continue;
      if (new Set(sources.values()).size > 1) fail(`${variable} is provided by ${[...sources.keys()].join(' and ')}; map it in apps.${appId}.env.`);
      automatic[variable] = sources.values().next().value!; // every offered variable has a source
    }
    const explicit: Record<string, string> = {}, publicPorts = new Set<number>();
    for (const [variable, value] of Object.entries(app.env)) {
      const where = `apps.${appId}.env.${variable}`;
      const refs = placeholders(value, where);
      if (refs.some(ref => blocked.has(ref.service) || blocked.has(ref.addressOf))) continue;
      // A placeholder is an address, which has a port key, or a service variable.
      explicit[variable] = resolvePlaceholders(value, ref => ref.service === undefined ? addressUrl(ref, hostPort(addressKey(ref)))
        : provided[ref.service]?.[ref.variable] ?? fail(`${where}: ${ref.service} does not provide ${ref.variable}.`), where);
      for (const ref of refs) if (ref.public) publicPorts.add(hostPort(addressKey(ref)));
    }
    const port = hostPort(portKey(APPS, appId));
    compose.services[appId] = {
      image: appImage,
      ...workspace(app.directory),
      command: loopbackCommand(appCommand(app.build, app.start), publicPorts, app.port).map(literal),
      environment: { ...PACKAGE_CACHE_ENV, ...environment(appId, { ...automatic, [PORT_VARIABLE]: String(app.port), ...explicit }, dotenv) },
      ports: [`${LOOPBACK}:${port}:${app.port}`],
      ...common,
      // A redirect is an answer, as the controller's check counts it, and is never followed: it may lead off the twin.
      healthcheck: { test: ['CMD', 'node', '-e', `fetch('http://${LOOPBACK}:${app.port}/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`], ...APP_HEALTH },
      ...(Object.keys(dependsOn).length ? { depends_on: { ...dependsOn } } : {}),
    };
    // App links are opened on the host; each env placeholder explicitly chooses browser or container reachability.
    apps.push({ id: appId, url: `http://${LOOPBACK}:${port}`, directory: app.directory });
  }

  // The workspace volume and a twin's own cache are the twin's, which tearing it down (down --volumes) removes; a
  // repository's cache is external, so that keeps it.
  if (Object.values(compose.services).some(service => service.volumes?.some(volume => volume.source === WORKSPACE_VOLUME))) {
    if (compose.services[SOURCE]) fail(`A service container is named ${SOURCE}, which copying the source uses.`);
    // The copy, the twin's first container, also mounts the twin's own cache, so Compose creates that volume before a
    // command fixture mounts it by name.
    const ownCache: ComposeVolume[] = cache ? [] : [{ type: 'volume', source: OWN_CACHE_VOLUME, target: CACHE }];
    compose.services[SOURCE] = { image: appImage, volumes: [{ type: 'bind', source: literal(source), target: '/snapshot', read_only: true }, { type: 'volume', source: WORKSPACE_VOLUME, target: WORKSPACE }, ...ownCache],
      command: ['sh', '-c', `cp -a /snapshot/. ${WORKSPACE}/`], profiles: [SOURCE], ...common };
    compose.volumes = { [WORKSPACE_VOLUME]: {}, [cacheVolume]: cache ? { external: true } : {} };
  }
  const summary = services.map((service): ServiceSummary => ({ id: service.id, fidelity: service.fidelity, status: service.status, ...(service.status === 'ready' ? {} : { missing: service.missing }) }));
  return { compose, env: dotenv, services: summary, apps, workspace: inWorkspace };
}
