import { idError } from './options.ts';
import { relative } from './paths.ts';
import { services as registry } from './registry.ts';
import type { TwinServices } from './registry.ts';

// A twin config is data: { services: { <id>: options }, install?: { directory, command }, apps: { <id>: app }, fixtures: [...],
// node?: <major> }, node naming the Node.js major its install, apps and command fixtures run on.
// Strings may reference {{<service>.<VARIABLE>}} (a variable a service provides), {{apps.<id>.url}} or
// {{services.<id>.url.<port>}} (a service's address on one of its named ports). publicUrl in place of url selects
// the host browser's loopback address; url keeps the container address. Variable placeholders in service
// options decide the setup order; addresses come from port allocation before any setup, so they order nothing.

export const APPS = 'apps';
const SERVICES = 'services';
/** Service options named env are environments, like an app's. */
const ENV = 'env';
/** The optional install step apps share, e.g. one workspace install; no app may take its name. */
export const INSTALL = 'install';
const APP_URL = 'url';
const PUBLIC_URL = 'publicUrl';
export const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g, HAS_PLACEHOLDER = new RegExp(PLACEHOLDER.source);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const FIELDS = { config: ['services', INSTALL, 'apps', 'fixtures', 'node'], install: ['directory', 'command'], app: ['directory', 'build', 'start', 'port', 'env'], fixture: ['service', 'sql', 'query', 'command'] };

export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface TwinInstall { directory: string; command: string }
export interface TwinApp { directory: string; build?: string; start: string; port: number; env: Record<string, string> }
/** Exactly one of sql (a repository file), query (inline SQL) or command. */
export type TwinFixture = { service: string; sql: string; query?: never; command?: never }
  | { service: string; query: string; sql?: never; command?: never } | { service: string; command: string; sql?: never; query?: never };
/** A validated twin config. */
export interface TwinConfig { services: Record<string, JsonObject>; install?: TwinInstall; apps: Record<string, TwinApp>; fixtures: TwinFixture[]; node?: number }
/** A parsed placeholder: an app's URL, a service's address on a named port, or a variable a service provides. */
export type Placeholder = { app: string; public?: true; addressOf?: never; port?: never; service?: never; variable?: never }
  | { addressOf: string; port: string; public?: true; app?: never; service?: never; variable?: never }
  | { service: string; variable: string; public?: never; app?: never; addressOf?: never; port?: never };
export type PlaceholderAt = Placeholder & { where: string };

export const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const fail: (message: string) => never = message => { throw new Error(message); };

function fields(value: object, allowed: string[], where: string) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`${where} has unsupported field ${extra.join(', ')}; use ${allowed.join(', ')}.`);
}

function json(value: unknown, where: string): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value as Json;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${where}[${index}]`));
  if (!plain(value)) fail(`${where} must contain JSON values only.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (RESERVED.has(key)) fail(`${where} uses the reserved key ${key}.`);
    return [key, json(item, `${where}.${key}`)];
  }));
}

// A command runs as written: placeholders are resolved in service options and app env only.
function command(value: unknown, where: string) {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty command.`);
  if (HAS_PLACEHOLDER.test(value)) fail(`${where} holds a placeholder; placeholders go in service options and app env, and a command reads the variables they fill as $VARIABLE.`);
  return value.trim();
}


function parse(expression: string, where: string): Placeholder {
  const parts = expression.split('.');
  const address = parts[2] === APP_URL || parts[2] === PUBLIC_URL, publicAddress = parts[2] === PUBLIC_URL ? { public: true as const } : {};
  if (parts[0] === APPS && parts.length === 3 && ID.test(parts[1]) && address) return { app: parts[1], ...publicAddress };
  if (parts[0] === SERVICES && parts.length === 4 && ID.test(parts[1]) && address && ID.test(parts[3])) return { addressOf: parts[1], port: parts[3], ...publicAddress };
  if (parts[0] !== APPS && parts.length === 2 && ID.test(parts[0]) && VARIABLE.test(parts[1])) return { service: parts[0], variable: parts[1] };
  // {{services.<service>.<VARIABLE>}} names the same variable, as an author may write by analogy with a service's address;
  // only an upper-case name, since a lower-case one is more likely a port missing its url.
  if (parts[0] === SERVICES && parts.length === 3 && ID.test(parts[1]) && /^[A-Z_][A-Z0-9_]*$/.test(parts[2])) return { service: parts[1], variable: parts[2] };
  return fail(`${where}: {{${expression}}} is not a placeholder; use {{<service>.<VARIABLE>}}, {{${APPS}.<id>.${APP_URL}}}, {{${APPS}.<id>.${PUBLIC_URL}}}, {{${SERVICES}.<id>.${APP_URL}.<port>}} or {{${SERVICES}.<id>.${PUBLIC_URL}.<port>}}.`);
}

/** The placeholder text of a service address reference, for messages. */
export const addressText = (ref: { addressOf?: string; port?: string; public?: true }) => `{{${SERVICES}.${ref.addressOf}.${ref.public ? PUBLIC_URL : APP_URL}.${ref.port}}}`;

/** Every placeholder referenced anywhere inside a JSON value, with where it appears. */
export function placeholders(value: unknown, where = 'value'): PlaceholderAt[] {
  if (typeof value === 'string') return [...value.matchAll(PLACEHOLDER)].map(match => ({ ...parse(match[1], where), where }));
  if (Array.isArray(value)) return value.flatMap((item, index) => placeholders(item, `${where}[${index}]`));
  if (plain(value)) return Object.entries(value).flatMap(([key, item]) => placeholders(item, `${where}.${key}`));
  return [];
}

/** Replaces placeholders in every string; lookup(ref) returns the value or throws. */
export function resolvePlaceholders(value: string, lookup: (ref: Placeholder) => unknown, where?: string): string;
export function resolvePlaceholders(value: JsonObject, lookup: (ref: Placeholder) => unknown, where?: string): JsonObject;
export function resolvePlaceholders(value: Json, lookup: (ref: Placeholder) => unknown, where?: string): Json;
export function resolvePlaceholders(value: Json, lookup: (ref: Placeholder) => unknown, where = 'value'): Json {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_, expression) => String(lookup(parse(expression, where))));
  if (Array.isArray(value)) return value.map((item, index) => resolvePlaceholders(item, lookup, `${where}[${index}]`));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, lookup, `${where}.${key}`)]));
  return value;
}

/** Service options without the env entries that reference a blocked service: like an app's variables, they are left
 * out, while any other option that references a blocked service blocks its service. */
export function leaveOutBlocked(value: JsonObject, blocked: (service: string | undefined) => boolean, env?: boolean): JsonObject;
export function leaveOutBlocked(value: Json, blocked: (service: string | undefined) => boolean, env?: boolean): Json;
export function leaveOutBlocked(value: Json, blocked: (service: string | undefined) => boolean, env = false): Json {
  if (Array.isArray(value)) return value.map(item => leaveOutBlocked(item, blocked));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => !env || !placeholders(item).some(ref => blocked(ref.service)))
    .map(([key, item]) => [key, leaveOutBlocked(item, blocked, key === ENV)]));
}

/** Service ids in the order their option placeholders imply; config order breaks ties. */
export function setupOrder(config: Pick<TwinConfig, 'services'>) {
  const order: string[] = [], state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') fail(`Circular placeholders: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}.`);
    state.set(id, 'visiting');
    for (const ref of placeholders(config.services[id], `services.${id}`)) if (ref.service) visit(ref.service, [...path, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of Object.keys(config.services)) visit(id, []);
  return order;
}

/**
 * The problems of each service section as its service reads it: an option its description does not name, or what its
 * own validate refuses, with placeholders counting as text. Then each placeholder in service options and app env that
 * names a variable or port its described service does not declare: its standard variables, those its options add, and
 * its named ports. A variable known only at setup, as a repository file's, is checked then. Empty when all is valid.
 */
export function serviceOptionErrors(config: Pick<TwinConfig, 'services'> & Partial<Pick<TwinConfig, 'apps'>>, { services = registry }: { services?: TwinServices } = {}): string[] {
  const options = Object.entries(config.services).flatMap(([id, section]) => {
    const service = services[id], known = Object.keys(service?.describe?.options ?? {});
    const extra = service?.describe ? Object.keys(section).filter(name => !known.includes(name)) : [];
    if (extra.length) return [`services.${id} has unsupported option ${extra.join(', ')}; ${known.length ? `use ${known.join(', ')}` : 'it takes no options'}.`];
    try { service?.validate?.(section); return []; }
    catch (error) { return [`services.${id}: ${(error as Error).message}`]; }
  });
  const references = [...Object.entries(config.services).flatMap(([id, section]) => placeholders(section, `${SERVICES}.${id}`)),
    ...Object.entries(config.apps ?? {}).flatMap(([id, app]) => placeholders(app.env, `${APPS}.${id}.${ENV}`))].flatMap(ref => {
    const id = ref.service ?? ref.addressOf, service = id === undefined ? undefined : services[id], describe = service?.describe;
    if (!id || !service || !describe) return [];
    if (ref.service !== undefined) {
      const options = config.services[id] ?? {}, added = describe.optionProvides?.(options) ?? [];
      return [...describe.provides, ...added].includes(ref.variable) || describe.setupProvides?.(options, ref.variable) ? [] : [`${ref.where}: ${id} does not provide ${ref.variable}.`];
    }
    return ref.port === undefined || !describe.ports || describe.ports.includes(ref.port) ? [] : [`${ref.where} references ${addressText(ref)}, but ${service.title} has no port ${ref.port}.`];
  });
  // Generated values are only for the application's own secrets. A credential the catalog's
  // service supplies must come from that service, even when the author omitted it from the config.
  const generated = services.secrets?.describe?.optionProvides?.(config.services.secrets ?? {}) ?? [];
  const credentials = generated.flatMap(name => Object.values(services).filter(service => service.id !== 'secrets'
    && [...(service.describe?.owns ?? []), ...(service.describe?.provides ?? []), ...(service.describe?.optionProvides?.(config.services[service.id] ?? {}) ?? [])].includes(name)).map(service =>
    `Generated secret ${name} belongs to ${service.title}; use {{${service.id}.${name}}} from that service instead of a random value.`));
  return [...options, ...references, ...credentials];
}

export function validateTwinConfig(input: unknown, { services = registry }: { services?: TwinServices } = {}): TwinConfig {
  if (!plain(input)) fail('A twin config must be an object with services, apps and fixtures.');
  // A service written beside services, as authors do, is named with where it belongs.
  const misplaced = Object.keys(input).filter(key => !FIELDS.config.includes(key) && Object.hasOwn(services, key));
  if (misplaced.length) fail(`The twin config has ${misplaced.join(', ')} beside services; ${misplaced.length > 1 ? 'they are services' : 'it is a service'}: move ${misplaced.map(key => `"${key}"`).join(', ')} into "services".`);
  fields(input, FIELDS.config, 'The twin config');
  const config: TwinConfig = { services: {}, apps: {}, fixtures: [] };
  const declared = input.services ?? {}, apps = input.apps ?? {}, fixtures = input.fixtures ?? [];
  if (!plain(declared)) fail('services must map service ids to options.');
  for (const [id, options] of Object.entries(declared)) {
    if (!Object.hasOwn(services, id)) fail(`Unknown service "${id}"; supported services are ${Object.keys(services).join(', ') || 'none'}.`);
    if (options != null && !plain(options)) fail(`services.${id} must be an object of options.`);
    config.services[id] = json(options ?? {}, `services.${id}`) as JsonObject; // an object of options, checked above
  }
  if (input.node != null) {
    if (typeof input.node !== 'number' || !Number.isInteger(input.node) || input.node < 18 || input.node > 99) fail('node must be a Node.js major version of 18 or later, such as 24.');
    config.node = input.node;
  }
  if (input.install != null) {
    if (!plain(input.install)) fail(`${INSTALL} must be an object with directory and command.`);
    fields(input.install, FIELDS.install, INSTALL);
    config.install = { directory: relative(input.install.directory ?? '.', `${INSTALL}.directory`), command: command(input.install.command, `${INSTALL}.command`) };
  }
  if (!plain(apps)) fail('apps must map app ids to apps.');
  for (const [id, app] of Object.entries(apps)) {
    const where = `apps.${id}`;
    if (!ID.test(id)) fail(idError(`App id "${id}"`, id));
    if (Object.hasOwn(config.services, id)) fail(`App "${id}" has the same id as a service; rename the app.`);
    if (config.install && id === INSTALL) fail(`App "${id}" has the same name as the install step; rename the app.`);
    if (!plain(app)) fail(`${where} must be an object.`);
    fields(app, FIELDS.app, where);
    if (typeof app.port !== 'number' || !Number.isInteger(app.port) || app.port < 1 || app.port > 65535) fail(`${where}.port must be the port the app listens on (1-65535).`);
    if (app.env != null && !plain(app.env)) fail(`${where}.env must map variable names to values.`);
    const env = Object.fromEntries(Object.entries(app.env ?? {}).map(([name, value]) => {
      if (!VARIABLE.test(name)) fail(`${where}.env.${name} is not a valid variable name.`);
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`${where}.env.${name} must be text.`);
      return [name, String(value)];
    }));
    config.apps[id] = { directory: relative(app.directory ?? '.', `${where}.directory`),
      ...(app.build == null ? {} : { build: command(app.build, `${where}.build`) }), start: command(app.start, `${where}.start`), port: app.port, env };
  }
  if (!Array.isArray(fixtures)) fail('fixtures must be a list.');
  config.fixtures = fixtures.map((fixture: unknown, index: number): TwinFixture => {
    const where = `fixtures[${index}]`;
    if (!plain(fixture)) fail(`${where} must be an object.`);
    fields(fixture, FIELDS.fixture, where);
    if (typeof fixture.service !== 'string' || !Object.hasOwn(config.services, fixture.service)) fail(`${where}.service must be one of the configured services.`);
    // sql is a repository file; query is inline SQL kept with the twin config, so a twin needs no files in the product's repository.
    if (['sql', 'query', 'command'].filter(key => fixture[key] != null).length !== 1) fail(`${where} needs exactly one of sql, query or command.`);
    if (fixture.sql != null) return { service: fixture.service, sql: relative(fixture.sql, `${where}.sql`) };
    if (fixture.query != null) return { service: fixture.service, query: command(fixture.query, `${where}.query`) };
    return { service: fixture.service, command: command(fixture.command, `${where}.command`) };
  });
  const check = (value: unknown, where: string) => {
    for (const ref of placeholders(value, where)) {
      if (ref.app && !Object.hasOwn(config.apps, ref.app)) fail(`${ref.where} references {{${APPS}.${ref.app}.${ref.public ? PUBLIC_URL : APP_URL}}}, but no app "${ref.app}" is configured.`);
      if (ref.service && !Object.hasOwn(config.services, ref.service)) fail(`${ref.where} references {{${ref.service}.${ref.variable}}}, but service "${ref.service}" is not configured.`);
      if (ref.addressOf && !Object.hasOwn(config.services, ref.addressOf)) fail(`${ref.where} references ${addressText(ref)}, but service "${ref.addressOf}" is not configured.`);
    }
  };
  for (const [id, options] of Object.entries(config.services)) check(options, `services.${id}`);
  for (const [id, app] of Object.entries(config.apps)) check(app.env, `apps.${id}.env`);
  setupOrder(config);
  return config;
}
