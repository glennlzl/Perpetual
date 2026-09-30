import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
// process through `ctx.exec` (`npx supabase@<pin>`), with the Docker access the controller already uses
// for `docker compose`. No installed host binary is used.
//
// DATABASE_URL preserves the local credentials reported by `supabase status`.
// 2.118.0 includes supabase/cli#6505: prune overlapping Edge Runtime binds before its docker cp bootstrap.
export const CLI = 'supabase@2.118.0';
const MOUNT_CHECK_IMAGE = 'node:24-bookworm-slim';
/** directory: the repository's supabase directory; functions and users are checked where they are used. */
type Options = { directory?: Json; functions?: Json; users?: Json };
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
const cli = (ctx: Pick<Context, 'dir' | 'exec'>, ...args: string[]) => ctx.exec('npx', ['--yes', CLI, ...args], { cwd: ctx.dir });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').map(line => line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
  .filter(match => match !== null).map(([, key, value]) => [key, value.startsWith('"') ? String(JSON.parse(value)) : value]));

// Sets `key = value` in `[section]` ('' is the top level), adding the key or the section when absent.
export function setToml(text: string, section: string, key: string, value: string | number | boolean) {
  const lines = text.split('\n'), line = `${key} = ${JSON.stringify(value)}`;
  const start = section ? lines.findIndex(l => new RegExp(`^\\s*\\[\\s*${escape(section)}\\s*\\]\\s*(#.*)?$`).test(l)) : -1;
  if (section && start < 0) return `${text.trimEnd()}\n\n[${section}]\n${line}\n`;
  const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  const at = lines.findIndex((l, i) => i > start && (end < 0 || i < end) && new RegExp(`^\\s*${escape(key)}\\s*=`).test(l));
  if (at >= 0) { lines[at] = line; return lines.join('\n'); }
  let last = end < 0 ? lines.length : end; // append after the section's last non-blank line
  while (last > start + 1 && !lines[last - 1].trim()) last -= 1;
  lines.splice(last, 0, line);
  return lines.join('\n');
}

// Gives the copied project this twin's id, allocated ports and a host.docker.internal token issuer, which the
// apps verify tokens against. api.external_url keeps the CLI's default: the CLI health-checks the stack from the
// host through it, and host.docker.internal does not resolve on the host.
export function twinConfig(text: string, ctx: Pick<Context, 'port' | 'url' | 'project'>) {
  const mail = /^\s*\[\s*inbucket\s*\]/m.test(text) ? 'inbucket' : 'local_smtp'; // [inbucket] is the older name
  return [...PORTS, ...MAIL_PORTS.map(([key, name]) => [mail, key, name])]
    .reduce((toml, [section, key, name]) => setToml(toml, section, key, ctx.port(name)),
      setToml(setToml(text, '', 'project_id', projectId(ctx)), 'auth', 'jwt_issuer', ctx.url('api', '/auth/v1')));
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
type AdminReply = { users?: unknown; msg?: unknown; message?: unknown; error_description?: unknown };

// The controller reaches the stack on the host loopback, where the CLI publishes it.
async function admin(ctx: Context, method: string, path: string, body?: unknown) {
  const key = ctx.outputs.serviceRoleKey;
  const response = await request(ctx, `http://127.0.0.1:${ctx.port('api')}/auth/v1/admin${path}`, {
    method, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { msg: text.slice(0, 200) }; }
  return { ok: response.ok, status: response.status, data: object(data) ? data as AdminReply : {} };
}

export async function accounts(ctx: Context) {
  const created = [];
  for (const user of users(ctx.options)) {
    const password = generatedPassword();
    const attributes = { email: user.email, password, email_confirm: user.emailConfirmed, user_metadata: user.metadata };
    let reply = await admin(ctx, 'POST', '/users', attributes);
    if (reply.status === 422) { // the address is registered already
      const listed = (await admin(ctx, 'GET', `/users?filter=${encodeURIComponent(user.email)}`)).data.users;
      const existing = Array.isArray(listed) ? listed.find((item): item is { id: string } => object(item) && typeof item.id === 'string' && typeof item.email === 'string' && item.email.toLowerCase() === user.email) : undefined;
      if (existing) reply = await admin(ctx, 'PUT', `/users/${encodeURIComponent(existing.id)}`, attributes);
    }
    const { msg, message, error_description: description } = reply.data;
    if (!reply.ok) throw new Error(`Supabase Auth did not create test account ${user.id}: ${msg ?? message ?? description ?? `status ${reply.status}`}`);
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
    },
    provides: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    ports: [...PORTS.map(([, , name]) => name), ...MAIL_PORTS.map(([, name]) => name)],
    notes: ['Starting it applies the project\'s migrations and seed.sql.', 'An edge function\'s URL is {{services.supabase.url.api}}/functions/v1/<name>.'],
  },
  validate: options => {
    relative(options.directory ?? DIRECTORY, 'supabase directory');
    users(options);
    if (options.functions != null) functionOptions(options.functions);
  },
  setup: async ctx => {
    const target = join(workdir(ctx), 'supabase'), config = join(target, 'config.toml');
    await cli(ctx, 'stop', '--no-backup', '--project-id', projectId(ctx)); // a rebuild starts from an empty database
    await rm(workdir(ctx), { recursive: true, force: true });
    await cp(join(ctx.source, relative(ctx.options.directory ?? DIRECTORY, 'supabase directory')), target, { recursive: true, filter: path => !STATE.has(basename(path)) });
    const toml = twinConfig(await readFile(config, 'utf8'), ctx);
    const prepared = ctx.options.functions == null ? toml : await edgeFunctions(ctx, target, toml);
    await bridgeSupabaseImportMaps(target, prepared);
    await writeFile(config, prepared);
    // Docker Desktop can retain a deleted bind ancestor across rebuilds: the CLI's first `docker cp`
    // then fails before its Edge Runtime starts. Read the recreated private tree from a running guest first.
    await ctx.run(MOUNT_CHECK_IMAGE, ['node', '-e', 'require("node:fs").accessSync(process.argv[1])', config], { mounts: 'service-only' });
    await cli(ctx, 'start', '--workdir', workdir(ctx));
    const status = parseEnv((await cli(ctx, 'status', '--output', 'env', '--workdir', workdir(ctx))).stdout);
    if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY || !status.DB_URL) throw new Error('Supabase status did not report its keys and database URL');
    const db = new URL(status.DB_URL);
    db.hostname = ctx.host; db.port = String(ctx.port('db')); db.searchParams.set('sslmode', 'disable');
    return { url: ctx.url('api'), anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY, jwtSecret: status.JWT_SECRET, dbUrl: db.href };
  },
  containers: () => [], // the CLI owns the stack's containers
  env: ({ outputs: o }) => ({
    SUPABASE_URL: o.url, SUPABASE_ANON_KEY: o.anonKey, SUPABASE_SERVICE_ROLE_KEY: o.serviceRoleKey, SUPABASE_JWT_SECRET: o.jwtSecret,
    DATABASE_URL: o.dbUrl, NEXT_PUBLIC_SUPABASE_URL: o.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: o.anonKey,
  }),
  accounts,
  teardown: async ctx => { await cli(ctx, 'stop', '--no-backup', '--project-id', projectId(ctx)); },
} satisfies TwinService<Options, Outputs>;
