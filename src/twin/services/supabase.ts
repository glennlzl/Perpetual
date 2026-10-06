import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { relative } from '../paths.ts';
import { bridgeSupabaseImportMaps } from '../supabase-import-maps.ts';
import type { Json } from '../config.ts';
import { idError } from '../options.ts';
import type { ServiceContext, TwinService } from '../registry.ts';

// Official local Supabase through the pinned Supabase CLI.
//
// The CLI cannot run inside a container without the host Docker socket: `supabase start` creates the
// stack's containers itself, and its docs require the socket bind-mounted for that case. Perpetual never
// mounts the socket into a container, so the minimal alternative is the pinned npm release run as a host
// process through `ctx.exec`, with the Docker access the controller already uses for `docker compose`.
// The release is an exact dependency of Perpetual, so package-lock.json locks it, its platform binary and
// its own dependencies with their integrity hashes; nothing is fetched when a twin starts, and no other
// installed host binary is used.
//
// DATABASE_URL preserves the local credentials reported by `supabase status`.
// 2.118.0 includes supabase/cli#6505: prune overlapping Edge Runtime binds before its docker cp bootstrap.
export const CLI_VERSION = '2.118.0';
const CLI_MISSING = `Supabase CLI ${CLI_VERSION} is not installed: run npm run setup in Perpetual.`;
/** The launcher would run whatever binary this names in place of the locked one, so it is always cleared. */
const BINARY_OVERRIDE = 'SUPABASE_CLI_BINARY_OVERRIDE';
const MOUNT_CHECK_IMAGE = 'node:24-bookworm-slim';
/** directory: the repository's supabase directory; functions, users and auth are checked where they are used. */
type Options = { directory?: Json; functions?: Json; users?: Json; auth?: Json };
type Outputs = { url: string; anonKey: string; serviceRoleKey: string; jwtSecret: string; dbUrl: string };
type Context = ServiceContext<Options, Outputs>;
const STATE = new Set(['.branches', '.temp']); // CLI-local state, never source
const PORTS = [['api', 'port', 'api'], ['db', 'port', 'db'], ['db', 'shadow_port', 'shadow'], ['db.pooler', 'port', 'pooler'],
  ['studio', 'port', 'studio'], ['analytics', 'port', 'analytics'], ['analytics', 'vector_port', 'vector'],
  ['edge_runtime', 'inspector_port', 'inspector']];
const MAIL_PORTS = [['port', 'mail'], ['smtp_port', 'smtp'], ['pop3_port', 'pop3']];

const DIRECTORY = 'supabase'; // where `supabase init` puts config.toml
// The CLI cuts project ids to 40 characters (Docker host names) and `stop --project-id` matches the cut id,
// so a longer twin project name keeps its start plus a hash of the whole name, which stays unique per twin.
const PROJECT_ID = 40;
const projectId = ({ project }: { project: string }) => project.length <= PROJECT_ID ? project
  : `${project.slice(0, PROJECT_ID - 9)}-${createHash('sha256').update(project).digest('hex').slice(0, 8)}`;
const workdir = (ctx: Pick<Context, 'dir'>) => join(ctx.dir, 'supabase');
async function healthContainers(ctx: Pick<Context, 'project' | 'dir'>) {
  const invalid = 'Supabase health needs its readable owned project config.', file = join(workdir(ctx), 'supabase/config.toml');
  let config: Record<string, unknown>;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(invalid);
    config = parseToml(await readFile(file, 'utf8'));
  } catch { throw new Error(invalid); }
  const project = projectId(ctx);
  if (config.project_id !== project) throw new Error(invalid);
  const enabled = (name: string) => {
    const section = config[name];
    if (section === undefined) return true;
    if (!object(section) || section.enabled !== undefined && typeof section.enabled !== 'boolean') throw new Error(invalid);
    return section.enabled !== false;
  };
  // CLI 2.118.0 always starts Kong without --exclude; api.enabled only controls PostgREST.
  return ['db', ...(enabled('auth') ? ['auth'] : []), 'kong']
    .map(name => ({ name: `supabase_${name}_${project}`, labels: { 'com.supabase.cli.project': project } }));
}
/** A package's manifest as `require` from `from` finds it, or undefined when it finds none it can read. */
async function installed(from: string | URL, name: string) {
  try {
    const file = createRequire(from).resolve(`${name}/package.json`);
    return { file, ...JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; bin?: { supabase?: unknown }; optionalDependencies?: object } };
  } catch { return undefined; }
}
/**
 * The installed CLI's launcher, as `from` resolves it (Perpetual's own modules by default). The launcher runs the first
 * binary package for this platform that it resolves from its own file, so that package is resolved the same way. Both
 * must be the locked release; otherwise, as with a node_modules older than package.json or a binary package npm skipped
 * when its optional install failed, the error names the command that installs them rather than leaving the launcher to fail.
 */
export async function cliEntry(from: string | URL = import.meta.url) {
  const launcher = await installed(from, 'supabase');
  if (launcher?.version !== CLI_VERSION || typeof launcher.bin?.supabase !== 'string') throw new Error(CLI_MISSING);
  const entry = join(dirname(launcher.file), launcher.bin.supabase);
  // The launcher's candidates, in its order: this platform's package, then on Linux its musl build.
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  for (const name of [`@supabase/cli-${platform}`, `@supabase/cli-${platform}-musl`].filter(item => Object.hasOwn(launcher.optionalDependencies ?? {}, item))) {
    const binary = await installed(entry, name);
    if (binary) { if (binary.version === CLI_VERSION) return entry; break; }
  }
  throw new Error(CLI_MISSING);
}
const cli = async (ctx: Pick<Context, 'dir' | 'exec'>, args: string[], env: Record<string, string> = {}) =>
  ctx.exec(process.execPath, [await cliEntry(), ...args], { cwd: ctx.dir, env: { [BINARY_OVERRIDE]: '', ...env } });
const ENV_REFERENCE = /^env\((.*)\)$/; // a config.toml value the CLI fills from its own environment
/** SUPABASE_ variables that set how the CLI itself runs, never what its stack holds: an image mirror, its home and telemetry. */
const CLI_SETTINGS = new Set(['SUPABASE_INTERNAL_IMAGE_REGISTRY', 'SUPABASE_HOME', 'SUPABASE_TELEMETRY_DISABLED']);
/**
 * The CLI fills each env(NAME) value of config.toml from its environment, which is the controller's, and takes any
 * SUPABASE_ variable there over the config, such as the project id, a port or a provider's secret: every name the copied
 * config references, and every SUPABASE_ variable but the CLI's own settings, is set empty for it, which the CLI reads as
 * unset, so no host variable reaches the stack.
 */
function unsetReferences(toml: string) {
  const names = new Set(Object.keys(process.env).filter(name => STACK_VARIABLE.test(name) && !CLI_SETTINGS.has(name)));
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { const name = ENV_REFERENCE.exec(value)?.[1]; if (name !== undefined && VARIABLE.test(name)) names.add(name); }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) Object.values(value).forEach(visit);
  };
  visit(parseToml(toml));
  return Object.fromEntries([...names].map(name => [name, '']));
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').map(line => line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
  .filter(match => match !== null).map(([, key, value]) => [key, value.startsWith('"') ? String(JSON.parse(value)) : value]));

/**
 * How many of `lines`, a key's line and the rest of its section, the key's value spans: the fewest that parse, as an
 * array or a multi-line string goes on. A value that does not parse within its section is taken as its one line, so a
 * rewrite never reaches another section.
 */
function valueLines(lines: string[]) {
  for (let end = 1; end <= lines.length; end += 1) {
    try { parseToml(lines.slice(0, end).join('\n')); return end; } catch { /* the value goes on */ }
  }
  return 1;
}

// Sets `key = value` in `[section]` ('' is the top level), adding the key or the section when absent. A value the file
// spreads over several lines is replaced whole. Lines are read without the '\r' of a CRLF ending, and those written end
// as the file's lines do: a repository may commit config.toml with CRLF endings, which the snapshot keeps.
export function setToml(text: string, section: string, key: string, value: string | number | boolean | string[]) {
  const lines = text.split('\n'), bare = lines.map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  const cr = text.includes('\r\n') ? '\r' : '', line = `${key} = ${JSON.stringify(value)}`;
  const start = section ? bare.findIndex(l => new RegExp(`^\\s*\\[\\s*${escape(section)}\\s*\\]\\s*(#.*)?$`).test(l)) : -1;
  if (section && start < 0) return `${text.trimEnd()}${cr}\n${cr}\n[${section}]${cr}\n${line}${cr}\n`;
  const next = bare.findIndex((l, i) => i > start && /^\s*\[/.test(l)), end = next < 0 ? lines.length : next;
  const at = bare.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${escape(key)}\\s*=`).test(l));
  if (at >= 0) {
    const count = valueLines(bare.slice(at, end)), ending = lines[at + count - 1].endsWith('\r') ? '\r' : '';
    lines.splice(at, count, line + ending);
    return lines.join('\n');
  }
  let last = end; // append after the section's last non-blank line
  while (last > start + 1 && !bare[last - 1].trim()) last -= 1;
  // In a file with no final line break, a line added last ends the file, where TOML refuses a '\r'.
  lines.splice(last, 0, last < lines.length ? line + cr : line);
  return lines.join('\n');
}

// Auth's Site URL and the other URLs it may redirect to: options.auth { siteUrl?, redirectUrls? }, placeholders allowed.
const AUTH_FIELDS = ['siteUrl', 'redirectUrls'];
const URL_TEXT = /^[^\s\x00-\x1f\x7f]+$/;
function authOptions(input: unknown) {
  const where = 'supabase.auth';
  if (input == null) return {};
  if (!object(input)) throw new Error(`${where} must be an object with ${AUTH_FIELDS.join(', ')}.`);
  const extra = Object.keys(input).filter(key => !AUTH_FIELDS.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported field ${extra.join(', ')}; use ${AUTH_FIELDS.join(', ')}.`);
  if (input.siteUrl != null && (typeof input.siteUrl !== 'string' || !URL_TEXT.test(input.siteUrl))) throw new Error(`${where}.siteUrl must be a URL, such as {{apps.web.publicUrl}}.`);
  const urls = input.redirectUrls;
  // Auth also takes patterns and an app's own scheme here, such as http://127.0.0.1:3000/** or acme://callback.
  if (urls != null && (!Array.isArray(urls) || urls.some(url => typeof url !== 'string' || !URL_TEXT.test(url)))) throw new Error(`${where}.redirectUrls must list URLs, such as {{apps.web.publicUrl}}/auth/callback.`);
  return { ...(typeof input.siteUrl === 'string' ? { siteUrl: input.siteUrl } : {}), ...(urls == null ? {} : { redirectUrls: urls as string[] }) };
}
/** The Site URL a browser follows when a link names no other address: the option, else the twin's app when it has one. */
function siteUrl(ctx: Pick<Context, 'options' | 'apps' | 'app'>) {
  const { siteUrl: site = ctx.apps.length === 1 ? ctx.app(ctx.apps[0]).publicUrl : undefined } = authOptions(ctx.options.auth);
  if (site !== undefined && !/^https?:\/\/[^/?#\s]+/.test(site)) throw new Error('supabase.auth.siteUrl must be an http or https URL.');
  return site;
}

// Gives the copied project this twin's id, allocated ports and a host.docker.internal token issuer, which the
// apps verify tokens against. api.external_url keeps the CLI's default: the CLI health-checks the stack from the
// host through it, and host.docker.internal does not resolve on the host. Auth sends a browser to its Site URL when a
// link names no other address, as a confirmation email does, so the twin's app replaces the repository's development
// address there; auth.redirectUrls replaces its other allowed addresses.
export function twinConfig(text: string, ctx: Pick<Context, 'port' | 'url' | 'project' | 'options' | 'apps' | 'app'>) {
  const mail = /^\s*\[\s*inbucket\s*\]/m.test(text) ? 'inbucket' : 'local_smtp'; // [inbucket] is the older name
  const site = siteUrl(ctx), { redirectUrls } = authOptions(ctx.options.auth);
  let toml = setToml(setToml(text, '', 'project_id', projectId(ctx)), 'auth', 'jwt_issuer', ctx.url('api', '/auth/v1'));
  if (site !== undefined) toml = setToml(toml, 'auth', 'site_url', site);
  if (redirectUrls) toml = setToml(toml, 'auth', 'additional_redirect_urls', redirectUrls);
  return [...PORTS, ...MAIL_PORTS.map(([key, name]) => [mail, key, name])]
    .reduce((current, [section, key, name]) => setToml(current, section, key, ctx.port(name)), toml);
}

// Edge functions: options.functions { directory?, env?, noVerifyJwt? }. `supabase start` serves the copied project's
// supabase/functions, taken from `directory` when the repository keeps them elsewhere, once [edge_runtime] is enabled.
// It reads their variables from supabase/functions/.env; the listed functions accept requests without a JWT, as a
// vendor's webhook sends none. The functions URL is {{services.supabase.url.api}}/functions/v1/<name>, known before setup.
const FUNCTIONS = 'functions';
const FUNCTION_FIELDS = ['directory', 'env', 'noVerifyJwt'];
const FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/; // the CLI's function name pattern
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STACK_VARIABLE = /^SUPABASE_/; // the local stack sets these itself, and the CLI drops them from the env file
const isDirectory = (path: string) => stat(path).then(item => item.isDirectory(), () => false);
const isFile = (path: string) => stat(path).then(item => item.isFile(), () => false);

function functionOptions(input: unknown) {
  const where = 'supabase.functions';
  if (!object(input)) throw new Error(`${where} must be an object with ${FUNCTION_FIELDS.join(', ')}.`);
  const extra = Object.keys(input).filter(key => !FUNCTION_FIELDS.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported field ${extra.join(', ')}; use ${FUNCTION_FIELDS.join(', ')}.`);
  if (input.env != null && !object(input.env)) throw new Error(`${where}.env must map variable names to values.`);
  const env = Object.entries(input.env ?? {}).map(([name, value]) => {
    if (!VARIABLE.test(name)) throw new Error(`${where}.env.${name} is not a valid variable name.`);
    if (STACK_VARIABLE.test(name)) throw new Error(`${where}.env.${name}: the local stack provides SUPABASE_ variables itself.`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${where}.env.${name} must be text.`);
    // The CLI's env file parser takes a single-quoted value literally, up to the first quote that no backslash precedes.
    const text = String(value);
    if (text.includes("'") || text.endsWith('\\')) throw new Error(`${where}.env.${name} cannot contain a single quote or end with a backslash.`);
    return [name, text];
  });
  const names = input.noVerifyJwt ?? [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !FUNCTION_NAME.test(name))) throw new Error(`${where}.noVerifyJwt must list function names.`);
  return { directory: input.directory == null ? null : relative(input.directory, `${where}.directory`), env, noVerifyJwt: [...new Set(names)] };
}

// Puts the functions into the copied project (target) and returns its config with them served.
async function edgeFunctions(ctx: Context, target: string, toml: string) {
  const { directory, env, noVerifyJwt } = functionOptions(ctx.options.functions);
  const dir = join(target, FUNCTIONS), shown = directory ?? `${relative(ctx.options.directory ?? DIRECTORY, 'supabase directory')}/${FUNCTIONS}`;
  if (directory) {
    if (!await isDirectory(join(ctx.source, directory))) throw new Error(`supabase.functions.directory ${directory} is not a directory in the repository.`);
    await rm(dir, { recursive: true, force: true });
    await cp(join(ctx.source, directory), dir, { recursive: true });
  }
  for (const name of noVerifyJwt) if (!await isDirectory(join(dir, name))) throw new Error(`supabase.functions.noVerifyJwt names ${name}, but ${shown} has no function ${name}.`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, '.env');
  await rm(file, { force: true }); // the twin's variables only, never a copied file's
  await writeFile(file, env.map(([name, value]) => `${name}='${value}'\n`).join(''), { mode: 0o600 });
  return noVerifyJwt.reduce((text, name) => setToml(text, `${FUNCTIONS}.${name}`, 'verify_jwt', false), setToml(toml, 'edge_runtime', 'enabled', true));
}

// Twin test accounts: options.users [{ id, email, emailConfirmed = true, metadata }], each created through the
// stack's own Auth admin API with the service role key and a generated password. A user that already exists,
// for example from the project's seed, gets the generated password instead, so creating them is idempotent.
const USER_FIELDS = ['id', 'email', 'emailConfirmed', 'metadata'];
const ACCOUNT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const request = (ctx: Pick<Context, 'fetch'>, url: string, init: RequestInit) => (ctx.fetch ?? fetch)(url, init);
// Lower and upper case letters, digits and a symbol, so any Auth password_requirements setting accepts it.
const generatedPassword = () => `${randomBytes(24).toString('base64url')}aA1!`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function users(options: Options) {
  const list = options.users ?? [], emails = new Set<string>();
  if (!Array.isArray(list)) throw new Error('supabase.users must be a list of { id, email }.');
  return list.map((user: unknown, index: number) => {
    const where = `supabase.users[${index}]`;
    if (!object(user)) throw new Error(`${where} must be an object with id and email.`);
    const extra = Object.keys(user).filter(key => !USER_FIELDS.includes(key));
    if (extra.length) throw new Error(`${where} has unsupported field ${extra.join(', ')}; use ${USER_FIELDS.join(', ')}.`);
    if (typeof user.id !== 'string' || !ACCOUNT_ID.test(user.id)) throw new Error(`${idError(`${where}.id`, user.id)} It names the test account; Auth gives the user its own id, and a fixture finds the user by its email.`);
    if (typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email)) throw new Error(`${where}.email must be an email address.`);
    const email = user.email.toLowerCase();
    if (emails.has(email)) throw new Error(`${where}.email is used by another test account.`);
    emails.add(email);
    if (user.emailConfirmed != null && typeof user.emailConfirmed !== 'boolean') throw new Error(`${where}.emailConfirmed must be true or false.`);
    if (user.metadata != null && !object(user.metadata)) throw new Error(`${where}.metadata must be an object.`);
    return { id: user.id, email, emailConfirmed: user.emailConfirmed ?? true, metadata: user.metadata ?? {} };
  });
}

/** The Auth admin API's reply fields this adapter reads, each checked where it is read. */
type AdminReply = { users?: unknown };

// The controller reaches the stack on the host loopback, where the CLI publishes it.
async function admin(ctx: Context, account: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const key = ctx.outputs.serviceRoleKey;
  // Keep the existing request deadline through body consumption. Fetch implementations can call a
  // timed-out body an AbortError; the signal's reason preserves which boundary actually stopped it.
  const deadline = AbortSignal.timeout(20_000), signal = AbortSignal.any([deadline, ...(ctx.signal ? [ctx.signal] : [])]);
  // IDs may themselves contain private text. Never include account data, query values, remote IDs,
  // request bodies or a server's raw reply in an operation summary.
  const reference = createHash('sha256').update(account).digest('hex').slice(0, 12);
  const route = `/auth/v1/admin/users${method === 'PUT' ? '/:user' : ''}`, started = performance.now();
  let phase = 'not sent', status: number | undefined;
  const failure = (kind: string) => new Error(`Supabase Auth account ${reference}: ${method} ${route}; ${kind}${status === undefined ? '' : ` (HTTP ${status})`}; ${Math.round(performance.now() - started)} ms; phase: ${phase}.${method !== 'GET' && phase !== 'not sent' ? ' Write outcome unknown; the mutation may have committed.' : ''}`);
  let response: Response, text: string;
  try {
    ctx.signal?.throwIfAborted();
    phase = 'awaiting response headers';
    response = await request(ctx, `http://127.0.0.1:${ctx.port('api')}/auth/v1/admin${path}`, {
      method, signal, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    status = response.status;
    phase = 'reading response body';
    text = await response.text();
    phase = 'response received';
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timedOut = signal.aborted ? signal.reason === deadline.reason && deadline.aborted : name === 'TimeoutError';
    throw failure(timedOut ? 'request deadline' : ctx.signal?.aborted || name === 'AbortError' ? 'cancelled' : 'transport failure');
  }
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return { ok: response.ok, status: response.status, data: object(data) ? data as AdminReply : {}, failure: () => failure('HTTP failure') };
}

export async function accounts(ctx: Context) {
  const created = [];
  for (const user of users(ctx.options)) {
    const password = generatedPassword();
    ctx.rememberSecret?.(password);
    ctx.rememberSecret?.(user.email);
    const attributes = { email: user.email, password, email_confirm: user.emailConfirmed, user_metadata: user.metadata };
    let reply = await admin(ctx, user.id, 'POST', '/users', attributes);
    if (reply.status === 422) { // the address is registered already
      const listing = await admin(ctx, user.id, 'GET', `/users?filter=${encodeURIComponent(user.email)}`);
      if (!listing.ok) throw listing.failure();
      const listed = listing.data.users;
      const existing = Array.isArray(listed) ? listed.find((item): item is { id: string } => object(item) && typeof item.id === 'string' && typeof item.email === 'string' && item.email.toLowerCase() === user.email) : undefined;
      if (existing) reply = await admin(ctx, user.id, 'PUT', `/users/${encodeURIComponent(existing.id)}`, attributes);
    }
    if (!reply.ok) throw reply.failure();
    // GoTrue's password grant, which a product's browser sign-in posts to.
    created.push({ id: user.id, label: user.id, username: user.email, password, authEndpoints: [ctx.url('api', '/auth/v1/token')] });
  }
  return created;
}

export default {
  id: 'supabase', title: 'Supabase', fidelity: 'official-sandbox',
  detect: { files: [`${DIRECTORY}/config.toml`], packages: ['@supabase/supabase-js', '@supabase/ssr', 'supabase'], env: [/^SUPABASE_/, /^NEXT_PUBLIC_SUPABASE_/] },
  includes: ['postgres'], // the local stack runs its own PostgreSQL and provides DATABASE_URL
  describe: {
    summary: 'Local Supabase through the official CLI: PostgreSQL, Auth, Storage, Realtime and edge functions, started from the repository\'s supabase project.',
    options: {
      directory: `The repository's Supabase project directory, holding config.toml, migrations and seed.sql; default ${DIRECTORY}.`,
      functions: '{ directory?, env?, noVerifyJwt? }: serves the project\'s edge functions. directory: where they are when not in <project>/functions; env: their variables, placeholders allowed, no SUPABASE_ names; noVerifyJwt: functions that take requests without a JWT, such as a vendor\'s webhook.',
      users: '[{ id, email, emailConfirmed?, metadata? }]: test accounts, created through Auth with a generated password; emailConfirmed defaults to true, metadata is the user metadata.',
      auth: '{ siteUrl?, redirectUrls? }: Auth\'s Site URL, where a browser goes when a sign-in or email link names no other address, default the {{apps.<id>.publicUrl}} of the twin\'s only app, else the project\'s config.toml value; redirectUrls: the other URLs Auth may redirect to, such as {{apps.web.publicUrl}}/auth/callback, in place of the project\'s additional_redirect_urls.',
    },
    provides: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    ports: [...PORTS.map(([, , name]) => name), ...MAIL_PORTS.map(([, name]) => name)],
    notes: ['Starting it applies the project\'s migrations and seed.sql.', 'An edge function\'s URL is {{services.supabase.url.api}}/functions/v1/<name>.'],
  },
  validate: options => {
    relative(options.directory ?? DIRECTORY, 'supabase directory');
    users(options);
    if (options.functions != null) functionOptions(options.functions);
    authOptions(options.auth);
  },
  setup: async ctx => {
    const target = join(workdir(ctx), 'supabase'), config = join(target, 'config.toml');
    // Detection proposes Supabase from a package or variable name too, as for an app that uses a hosted project.
    const directory = relative(ctx.options.directory ?? DIRECTORY, 'supabase directory');
    if (!await isFile(join(ctx.source, directory, 'config.toml'))) throw new Error(`The repository has no Supabase project at ${directory}: set supabase.directory to the folder that holds its config.toml.`);
    await cli(ctx, ['stop', '--no-backup', '--project-id', projectId(ctx)]); // a rebuild starts from an empty database
    await rm(workdir(ctx), { recursive: true, force: true });
    await cp(join(ctx.source, directory), target, { recursive: true, filter: path => !STATE.has(basename(path)) });
    const toml = twinConfig(await readFile(config, 'utf8'), ctx);
    const prepared = ctx.options.functions == null ? toml : await edgeFunctions(ctx, target, toml);
    await bridgeSupabaseImportMaps(target, prepared);
    await writeFile(config, prepared);
    // Docker Desktop can retain a deleted bind ancestor across rebuilds: the CLI's first `docker cp`
    // then fails before its Edge Runtime starts. Read the recreated private tree from a running guest first.
    await ctx.run(MOUNT_CHECK_IMAGE, ['node', '-e', 'require("node:fs").accessSync(process.argv[1])', config], { mounts: 'service-only' });
    const unset = unsetReferences(prepared);
    await cli(ctx, ['start', '--workdir', workdir(ctx)], unset);
    const status = parseEnv((await cli(ctx, ['status', '--output', 'env', '--workdir', workdir(ctx)], unset)).stdout);
    if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY || !status.DB_URL) throw new Error('Supabase status did not report its keys and database URL');
    const db = new URL(status.DB_URL);
    db.hostname = ctx.host; db.port = String(ctx.port('db')); db.searchParams.set('sslmode', 'disable');
    return { url: ctx.url('api'), anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY, jwtSecret: status.JWT_SECRET, dbUrl: db.href };
  },
  containers: () => [], // the CLI owns the stack's containers
  healthContainers,
  diagnosticSecrets: options => users(options).map(user => user.email),
  env: ({ outputs: o }) => ({
    SUPABASE_URL: o.url, SUPABASE_ANON_KEY: o.anonKey, SUPABASE_SERVICE_ROLE_KEY: o.serviceRoleKey, SUPABASE_JWT_SECRET: o.jwtSecret,
    DATABASE_URL: o.dbUrl, NEXT_PUBLIC_SUPABASE_URL: o.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: o.anonKey,
  }),
  accounts,
  teardown: async ctx => { await cli(ctx, ['stop', '--no-backup', '--project-id', projectId(ctx)]); },
} satisfies TwinService<Options, Outputs>;
