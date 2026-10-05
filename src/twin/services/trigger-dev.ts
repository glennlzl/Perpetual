import { writeStateFile } from '../../store.ts';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import type { Json } from '../config.ts';
import { optionEnv } from '../options.ts';
import { relative } from '../paths.ts';
import { containerLogging } from '../logging.ts';
import type { ServiceContext, TwinService } from '../registry.ts';

// Official local Trigger.dev: one self-hosted webapp stack per machine (Compose project `perpetual-trigger`),
// one Trigger project per twin, and a per-twin `trigger dev` worker that runs the repository's tasks.
// Deploy-only parts of the official stack (registry, supervisor, Docker socket proxy) are left out.
export const VERSION = '4.6.4';
export const PROJECT = 'perpetual-trigger';
export const BOT_EMAIL = 'trigger@perpetual.localhost'; // the only address the instance accepts
const ORG = 'Perpetual';
const IMAGES = { webapp: `ghcr.io/triggerdotdev/trigger.dev:v${VERSION}`, postgres: 'postgres:14', redis: 'redis:7', clickhouse: 'clickhouse/clickhouse-server:26.2' };
const SECRETS = ['SESSION_SECRET', 'MAGIC_LINK_SECRET', 'ENCRYPTION_KEY', 'PROVIDER_SECRET', 'COORDINATOR_SECRET', 'MANAGED_WORKER_SECRET', 'POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD'];
const HEALTH = "http.get('http://localhost:3000/healthcheck', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))";
const LOG_ATTEMPTS = 30;
const FIRST_BOOT = '15m';
/** The CLI must match the repository's SDK exactly. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** version: the CLI, matching the repository's SDK; directory: where its tasks are; env: the worker's own variables. */
type Options = { version?: Json; directory?: Json; env?: Json };
type Outputs = { apiUrl: string; secretKey: string; projectRef: string; accessToken: string };
type Context = ServiceContext<Options, Outputs>;
/** The shared instance's state.json: its host port, the bot's access token and organization slug. */
type Instance = { port: number; token?: string; org?: string };
/** A Trigger.dev API call: its reply is parsed JSON, whose fields are checked where they are read. */
type Api = (method: string, path: string, body?: object) => Promise<unknown>;

// The CLI is installed once per version into a local image layer, so a worker start or restart never downloads it.
// The tag carries the recipe's hash, so a changed recipe builds a new image.
const CLI_RECIPE = 'FROM node:22-bookworm-slim\nARG VERSION\nRUN npm install --global "trigger.dev@$VERSION" && npm cache clean --force\n';
export const cliImage = (version: string) => `perpetual-trigger-cli:${version}-${createHash('sha256').update(CLI_RECIPE).digest('hex').slice(0, 12)}`;

// `trigger dev` signs in only with a personal access token, never a project key, and hands its whole environment
// to every task process. The machine-wide bot token therefore reaches the CLI as its login profile: written 0600
// when the worker starts and removed from the environment before the CLI runs. Tasks get the project's dev key,
// which the CLI adds itself.
export const CREDENTIALS = 'PERPETUAL_TRIGGER_CREDENTIALS';
export const LOGIN = [
  'config="${XDG_CONFIG_HOME:-$HOME/.config}/trigger"',
  `(umask 077 && mkdir -p "$config" && printf %s "$${CREDENTIALS}" > "$config/config.json")`,
  `unset ${CREDENTIALS}`,
  'exec trigger dev "$@"',
].join(' && ');
const profile = ({ apiUrl, accessToken }: { apiUrl: string; accessToken: string }) => JSON.stringify({ version: 2, currentProfile: 'default', profiles: { default: { accessToken, apiUrl } } });

const home = (ctx: Pick<Context, 'shared'>) => ctx.shared;
const compose = (ctx: Pick<Context, 'shared' | 'exec'>, ...args: string[]) => ctx.exec('docker', ['compose', '--project-name', PROJECT, '--project-directory', home(ctx), ...args]);
const request = (ctx: Pick<Context, 'fetch'>, url: string, init?: RequestInit) => (ctx.fetch ?? fetch)(url, init);
const origin = (port: number) => `http://localhost:${port}`;
const projectName = (ctx: Pick<Context, 'project'>) => ctx.project;
const cliVersion = (options: Options) => {
  const version = options.version ?? VERSION;
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) throw new Error('version must be an exact trigger.dev CLI version, such as 4.4.4.');
  return version;
};
const absent = <T>(fallback: T) => (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return fallback; throw error; };
const json = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`Trigger.dev responded ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
};
const fields = (value: unknown) => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
/** A reply's text field, which the adapter needs to go on. */
const text = (reply: unknown, name: string, what: string) => {
  const value = fields(reply)?.[name];
  if (typeof value !== 'string' || !value) throw new Error(`Trigger.dev did not return ${what}`);
  return value;
};
/** A reply that lists items, such as organizations or projects. */
const list = (reply: unknown, what: string) => { if (!Array.isArray(reply)) throw new Error(`Trigger.dev did not list ${what}`); return reply; };
// The instance's saved state, written only by this adapter; the port is checked when it is reserved again.
const savedInstance = async (file: string) => {
  const saved = fields(await readFile(file, 'utf8').then(JSON.parse, () => ({})));
  return { port: saved?.port, ...(typeof saved?.token === 'string' ? { token: saved.token } : {}), ...(typeof saved?.org === 'string' ? { org: saved.org } : {}) };
};
/** Whether the instance refuses the saved token, as a new database does. */
const rejects = async (ctx: Pick<Context, 'fetch'>, state: Instance) => {
  const response = await request(ctx, `${origin(state.port)}/api/v1/orgs`, { headers: { authorization: `Bearer ${state.token}` } });
  await response.body?.cancel().catch(() => {});
  return response.status === 401 || response.status === 403;
};
const api = (ctx: Pick<Context, 'fetch'>, state: Instance): Api => async (method: string, path: string, body?: object) => json(await request(ctx, origin(state.port) + path, {
  method, headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}));

// The webapp's environment. Humans use localhost; containers reach the same port via host.docker.internal,
// including the URLs the server hands back to `trigger dev`.
export function webappEnv(port: number, secrets: Record<string, string>) {
  const inside = `http://host.docker.internal:${port}`, db = `postgresql://postgres:${secrets.POSTGRES_PASSWORD}@postgres:5432/main?schema=public&sslmode=disable`;
  const clickhouse = `http://default:${secrets.CLICKHOUSE_PASSWORD}@clickhouse:8123`;
  return {
    ...secrets, APP_ORIGIN: origin(port), LOGIN_ORIGIN: origin(port), API_ORIGIN: inside, DEV_ENGINE_URL: inside,
    DEV_OTEL_EXPORTER_OTLP_ENDPOINT: `${inside}/otel`, DATABASE_URL: db, DIRECT_URL: db,
    REDIS_HOST: 'redis', REDIS_PORT: '6379', REDIS_TLS_DISABLED: 'true',
    CLICKHOUSE_URL: `${clickhouse}?secure=false`, RUN_REPLICATION_CLICKHOUSE_URL: clickhouse, RUN_REPLICATION_ENABLED: '1',
    DEPLOY_REGISTRY_HOST: 'localhost:5000', // required by the webapp; deploys are not used
    REALTIME_STREAMS_DEFAULT_VERSION: 'v1', TRIGGER_TELEMETRY_DISABLED: '1', POSTHOG_PROJECT_KEY: '',
    WHITELISTED_EMAILS: `^${BOT_EMAIL.replace(/\./g, '\\.')}$`, ORG_CREATION_API_ENABLED: '1', TRIGGER_BOOTSTRAP_ENABLED: '0',
    NODE_MAX_OLD_SPACE_SIZE: '1536',
  };
}

// The stack's .env: single-quoted, so Compose interpolates nothing. Its secrets are read back on every start.
const formatEnv = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => `${key}='${value}'\n`).join('');
const parseEnv = (text: string) => Object.fromEntries([...text.matchAll(/^(\w+)='([^'\n]*)'$/gm)].map(([, key, value]) => [key, value]));
// Each database reads its password from an env file of its own: Compose would fill a `${...}` reference from a variable of
// the same name in the controller's environment before the stack's .env.
const PASSWORDS = { postgres: 'POSTGRES_PASSWORD', clickhouse: 'CLICKHOUSE_PASSWORD' };
const passwordFile = (service: string) => `${service}.env`;

export function stack(port: number) {
  const healthy = Object.fromEntries(['postgres', 'redis', 'clickhouse'].map(name => [name, { condition: 'service_healthy' }]));
  const check = (test: string[]) => ({ test, interval: '5s', timeout: '10s', retries: 60 });
  // The instance outlives any one twin, so it comes back with Docker unless someone stops it.
  const common = { restart: 'unless-stopped', logging: containerLogging() };
  return {
    services: {
      // The first boot applies every database and ClickHouse migration before the server listens.
      webapp: { image: IMAGES.webapp, ...common, env_file: ['.env'], ports: [`127.0.0.1:${port}:3000`], depends_on: healthy,
        extra_hosts: ['host.docker.internal:host-gateway'], healthcheck: { ...check(['CMD', 'node', '-e', HEALTH]), start_period: FIRST_BOOT } },
      postgres: { image: IMAGES.postgres, ...common, command: ['-c', 'wal_level=logical'], env_file: [passwordFile('postgres')],
        volumes: ['postgres:/var/lib/postgresql/data'], healthcheck: check(['CMD', 'pg_isready', '-U', 'postgres']) },
      redis: { image: IMAGES.redis, ...common, volumes: ['redis:/data'], healthcheck: check(['CMD', 'redis-cli', 'ping']) },
      clickhouse: { image: IMAGES.clickhouse, ...common, env_file: [passwordFile('clickhouse')], environment: { CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' },
        ulimits: { nofile: { soft: 262144, hard: 262144 } }, volumes: ['clickhouse:/var/lib/clickhouse'],
        healthcheck: check(['CMD-SHELL', 'clickhouse-client --password "$$CLICKHOUSE_PASSWORD" --query "SELECT 1"']) },
    },
    volumes: { postgres: {}, redis: {}, clickhouse: {} },
  };
}

// The documented self-hosted sign-in, run once per machine (exercised against a live v4.6.4 webapp).
// Without an email transport the webapp logs the magic link; the CLI's authorization-code flow then
// turns that session into the bot's personal access token.
export async function bootstrapToken(ctx: Pick<Context, 'fetch' | 'shared' | 'exec'>, port: number) {
  const cookies = new Map<string, string>();
  const browse = async (path: string, init: RequestInit = {}) => {
    const response = await request(ctx, origin(port) + path, { ...init, redirect: 'manual',
      headers: { ...init.headers, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  const since = new Date().toISOString();
  await browse('/login/magic', { method: 'POST', body: new URLSearchParams({ action: 'send', email: BOT_EMAIL }) });
  let token: string | undefined;
  for (let attempt = 0; !token && attempt < LOG_ATTEMPTS; attempt += 1) {
    if (attempt) await delay(1000);
    token = [...(await compose(ctx, 'logs', '--no-log-prefix', '--since', since, 'webapp')).stdout.matchAll(/\/magic\?token=([^\s"'<>&]+)/g)].at(-1)?.[1];
  }
  if (!token) throw new Error('Trigger.dev did not log a sign-in link');
  await browse(`/magic?token=${token}`);
  const authorizationCode = text(await json(await request(ctx, `${origin(port)}/api/v1/authorization-code`, { method: 'POST' })), 'authorizationCode', 'an authorization code');
  // The consent form's action mints the token; it is a form post like the dashboard's.
  await browse(`/account/authorization-code/${authorizationCode}`, { method: 'POST', body: new URLSearchParams() });
  const issued = fields(await json(await request(ctx, `${origin(port)}/api/v1/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorizationCode }) })))?.token;
  const minted = typeof issued === 'string' ? issued : fields(issued)?.token;
  if (typeof minted !== 'string' || !minted) throw new Error('Trigger.dev did not issue an access token');
  return minted;
}

// Twins set up at the same time share the instance, so it is started, signed in and given its organization one at a time.
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(work: () => Promise<T>) => { const next = turn.then(work); turn = next.catch(() => {}); return next; };

// Starts or updates the shared instance and returns its state: port, bot token and organization slug.
// The port is reserved machine-wide; secrets are generated once; compose.yaml and .env follow this file on every start.
const instance = (ctx: Context) => inTurn(async () => {
  const dir = home(ctx), file = join(dir, 'state.json'), envFile = join(dir, '.env');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const saved = await savedInstance(file);
  const state: Instance = { ...saved, port: await ctx.sharedPort(PROJECT, saved.port) };
  const save = () => writeStateFile(file, JSON.stringify(state));
  const kept = parseEnv(await readFile(envFile, 'utf8').catch(absent('')));
  const secrets = Object.fromEntries(SECRETS.map(name => [name, kept[name] || randomBytes(16).toString('hex')]));
  await writeFile(envFile, formatEnv(webappEnv(state.port, secrets)), { mode: 0o600 });
  for (const [service, name] of Object.entries(PASSWORDS)) await writeFile(join(dir, passwordFile(service)), formatEnv({ [name]: secrets[name] }), { mode: 0o600 });
  await writeFile(join(dir, 'compose.yaml'), stringify(stack(state.port)));
  await save();
  await compose(ctx, 'up', '--detach', '--wait');
  // A saved token belongs to the instance's database. Once its volumes are removed the database starts empty and
  // rejects it, so the bot signs in again and its organization is made again.
  if (state.token && await rejects(ctx, state)) { delete state.token; delete state.org; await save(); }
  if (!state.token) { state.token = await bootstrapToken(ctx, state.port); await save(); }
  if (!state.org) {
    const call = api(ctx, state), [existing] = list(await call('GET', '/api/v1/orgs'), 'organizations');
    state.org = text(existing ?? await call('POST', '/api/v1/orgs', { title: ORG }), 'slug', 'an organization');
    await save();
  }
  const { port, token, org } = state; // signed in and given its organization above
  return { port, token, org };
});

// Builds the pinned CLI image unless this machine already has it.
export async function ensureCli(ctx: Pick<Context, 'shared' | 'exec'>, version: string) {
  const image = cliImage(version);
  if (await ctx.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false)) return;
  const dir = join(home(ctx), 'cli');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'Dockerfile'), CLI_RECIPE);
  await ctx.exec('docker', ['build', '--build-arg', `VERSION=${version}`, '--tag', image, dir]);
}

/** This twin's project in the organization, if it has one; the caller reads its externalRef. */
const findProject = async (ctx: Pick<Context, 'project'>, call: Api, org: string): Promise<unknown> => list(await call('GET', `/api/v1/orgs/${org}/projects`), 'projects').find(project => fields(project)?.name === projectName(ctx));

export default {
  id: 'trigger-dev', title: 'Trigger.dev', fidelity: 'official-sandbox',
  detect: { packages: ['@trigger.dev/sdk', 'trigger.dev'], env: [/^TRIGGER_/] },
  describe: {
    summary: 'Self-hosted Trigger.dev, one instance per machine: each twin gets its own project and a `trigger dev` worker running the repository\'s tasks.',
    options: {
      version: `The exact trigger.dev CLI version, matching the repository's @trigger.dev/sdk; default ${VERSION}.`,
      directory: 'Where the repository\'s trigger.config is; default the repository root.',
      env: 'The worker\'s own variables, which its tasks read, as an app\'s env.',
    },
    provides: ['TRIGGER_API_URL', 'TRIGGER_SECRET_KEY'],
  },
  validate: options => {
    cliVersion(options);
    relative(options.directory ?? '.', 'trigger-dev.directory');
    optionEnv(options.env, 'trigger-dev.env');
  },
  setup: async ctx => {
    const version = cliVersion(ctx.options);
    await ensureCli(ctx, version);
    const state = await instance(ctx), call = api(ctx, state);
    const externalRef = text(await findProject(ctx, call, state.org) ?? await call('POST', `/api/v1/orgs/${state.org}/projects`, { name: projectName(ctx) }), 'externalRef', 'a project reference');
    const apiKey = text(await call('GET', `/api/v1/projects/${externalRef}/dev`), 'apiKey', 'a project key');
    return { apiUrl: `http://${ctx.host}:${state.port}`, secretKey: apiKey, projectRef: externalRef, accessToken: state.token };
  },
  // Runs in the repository's task directory, like an app, with the pinned CLI (or the repo's SDK version).
  containers: ({ options, outputs }) => [{
    name: 'trigger-dev', image: cliImage(cliVersion(options)), directory: relative(options.directory ?? '.', 'trigger-dev.directory'),
    command: ['sh', '-c', LOGIN, 'trigger', '--project-ref', outputs.projectRef, '--skip-update-check'],
    env: { ...optionEnv(options.env, 'trigger-dev.env'), TRIGGER_API_URL: outputs.apiUrl, [CREDENTIALS]: profile(outputs) },
  }],
  env: ({ outputs }) => ({ TRIGGER_API_URL: outputs.apiUrl, TRIGGER_SECRET_KEY: outputs.secretKey }),
  // Soft-deletes this twin's project; the shared instance keeps running for other twins.
  teardown: async ctx => {
    const { port, token, org } = await savedInstance(join(home(ctx), 'state.json'));
    if (!token || !org) return;
    // The port is saved before the token, so a state without one cannot reach the project: a cleanup failure, not nothing to do.
    if (typeof port !== 'number') throw new Error('Trigger.dev instance state has no port');
    const call = api(ctx, { port, token, org }), project = await findProject(ctx, call, org);
    if (project) await call('DELETE', `/api/v1/projects/${text(project, 'externalRef', 'a project reference')}`);
  },
} satisfies TwinService<Options, Outputs>;
