import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from '../src/twin/services/postgres.ts';
import redis from '../src/twin/services/redis.ts';
import mongodb from '../src/twin/services/mongodb.ts';
import mailpit from '../src/twin/services/mailpit.ts';
import llm from '../src/twin/services/llm.ts';
import emulate, { emulated, official } from '../src/twin/services/emulate.ts';
import type { InputValues, Pattern, ServiceContainer, ServiceContext, ServiceOptions, TwinService } from '../src/twin/registry.ts';

const services = { postgres, redis, mongodb, mailpit, llm, emulate };
const HOST = 'host.docker.internal';

// A context for any of these services, whose options and outputs are the test's: none of them runs a command.
const context = ({ options = {}, inputs = {}, outputs = {}, dir = '/twins/beta' }: { options?: object; inputs?: InputValues; outputs?: object; dir?: string } = {}) => {
  const ports = new Map<string, number>();
  const port = (name: string) => { if (!ports.has(name)) ports.set(name, 43100 + ports.size); return ports.get(name)!; };
  const ctx: ServiceContext<object, object> = {
    options, inputs, outputs, dir, host: HOST, port, project: 'perpetual-beta', shared: '/twins/shared', source: '/twins/source',
    url: (name, path = '') => `http://${HOST}:${port(name)}${path}`,
    apps: [], app: id => ({ url: `http://${HOST}:${port(`app:${id}`)}`, publicUrl: `http://127.0.0.1:${port(`app:${id}`)}`, port: port(`app:${id}`) }),
    run: async () => { throw new Error('No service in this file runs a CLI image'); },
    exec: async () => { throw new Error('No service in this file runs a host command'); },
    sharedPort: async () => { throw new Error('No service in this file shares an instance'); },
  };
  return ctx as ServiceContext<never, never>;
};
const prepared = async <O extends ServiceOptions<O>, X>(service: { setup(ctx: ServiceContext<O, X>): Promise<X> }, options: object = {}) => {
  const ctx: ServiceContext<O, X> = context({ options });
  ctx.outputs = await service.setup(ctx);
  return ctx;
};
type Detected = { id: string; detect: { packages: string[]; env: Pattern[] } };
const detects = (service: Detected, { packages = [], env = [] }: { packages?: string[]; env?: string[] }) =>
  packages.some(name => service.detect.packages.includes(name)) || env.some(name => service.detect.env.some(pattern => pattern instanceof RegExp ? pattern.test(name) : pattern === name));

test('Each service exports the twin service shape with pinned images', async () => {
  for (const [id, service] of Object.entries(services)) {
    assert.equal(service.id, id);
    assert.ok(service.title);
    assert.ok(['actual', 'official-sandbox', 'emulate'].includes(service.fidelity));
    assert.ok(service.detect.packages.every(name => typeof name === 'string'));
    assert.ok(service.detect.env.length && service.detect.env.every(pattern => pattern instanceof RegExp));
    assert.equal(typeof service.env, 'function');
  }
  const ctx = context({ options: { services: ['github'] }, outputs: { password: 'secret' } });
  const withContainers: { containers(ctx: ServiceContext<never, never>): ServiceContainer[] }[] = [postgres, redis, mongodb, mailpit, emulate];
  const images = withContainers.flatMap(service => service.containers(ctx)).map(({ image }) => image);
  for (const image of images) assert.match(image, /^[\w./-]+:v?\d+\.\d+(\.\d+)?(-[\w.-]+)?$/);
});

test('Detection matches each service by package or environment variable', () => {
  const cases: [Detected, { packages?: string[]; env?: string[] }][] = [
    [postgres, { packages: ['pg'] }], [postgres, { env: ['PGHOST'] }], [postgres, { env: ['POSTGRES_PASSWORD'] }],
    [redis, { packages: ['ioredis'] }], [redis, { env: ['REDIS_URL'] }],
    [mongodb, { packages: ['mongoose'] }], [mongodb, { env: ['MONGODB_URI'] }], [mongodb, { env: ['MONGO_URL'] }],
    [mailpit, { packages: ['nodemailer'] }], [mailpit, { env: ['SMTP_HOST'] }],
    [llm, { packages: ['openai'] }], [llm, { env: ['OPENROUTER_API_KEY'] }], [llm, { env: ['OPENAI_BASE_URL'] }],
    [emulate, { packages: ['@octokit/rest'] }], [emulate, { env: ['AUTH_GOOGLE_ID'] }], [emulate, { env: ['AWS_ACCESS_KEY_ID'] }],
  ];
  for (const [service, signals] of cases) assert.ok(detects(service, signals), `${service.id} ${JSON.stringify(signals)}`);
  assert.equal(detects(postgres, { env: ['REDIS_URL'], packages: ['mongoose'] }), false);
  assert.equal(detects(mongodb, { env: ['DATABASE_URL'] }), false);
  assert.equal(detects(emulate, { packages: ['stripe', 'twilio', '@clerk/nextjs', 'resend', '@slack/web-api'], env: ['STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'RESEND_API_KEY', 'SLACK_BOT_TOKEN'] }), false);
});

test('Postgres generates a password and provides the standard connection variables', async () => {
  const first = await postgres.setup(context()), second = await postgres.setup(context());
  assert.match(first.password, /^[0-9a-f]{48}$/);
  assert.notEqual(first.password, second.password);
  assert.deepEqual(await postgres.setup(context({ options: { password: 'chosen' } })), { password: 'chosen' });

  const ctx = await prepared(postgres, { user: 'app', password: 'p@ss/word' });
  const [container] = postgres.containers(ctx);
  assert.deepEqual(container.ports, { postgres: 5432 });
  assert.deepEqual(container.env, { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'p@ss/word', POSTGRES_DB: 'app' });
  assert.deepEqual(container.health.command, ['pg_isready', '-h', '127.0.0.1', '-U', 'app', '-d', 'app']);
  const port = ctx.port('postgres');
  assert.deepEqual(postgres.env(ctx), {
    DATABASE_URL: `postgresql://app:p%40ss%2Fword@${HOST}:${port}/app`,
    POSTGRES_HOST: HOST, POSTGRES_PORT: String(port), POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'p@ss/word', POSTGRES_DB: 'app',
  });
  assert.match(postgres.env(await prepared(postgres)).DATABASE_URL, /^postgresql:\/\/postgres:[0-9a-f]{48}@host\.docker\.internal:\d+\/postgres$/);
});

test('Redis requires the generated password and provides REDIS_URL', async () => {
  const ctx = await prepared(redis);
  const [container] = redis.containers(ctx);
  assert.deepEqual(container.ports, { redis: 6379 });
  assert.deepEqual(container.env, { REDISCLI_AUTH: ctx.outputs.password });
  assert.ok(!container.command.join(' ').includes(ctx.outputs.password), 'the password stays out of the command');
  assert.match(container.command.at(-1)!, /redis-server --requirepass "\$REDISCLI_AUTH"$/);
  assert.equal(container.health.command, 'redis-cli ping | grep -q PONG');
  assert.deepEqual(redis.env(ctx), { REDIS_URL: `redis://:${ctx.outputs.password}@${HOST}:${ctx.port('redis')}` });
});

test('MongoDB creates the root user and provides MONGODB_URI and MONGO_URL', async () => {
  const ctx = await prepared(mongodb);
  const [container] = mongodb.containers(ctx);
  assert.deepEqual(container.ports, { mongodb: 27017 });
  assert.deepEqual(container.env, { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: ctx.outputs.password });
  assert.equal(container.health.command[0], 'mongosh');
  const uri = `mongodb://root:${ctx.outputs.password}@${HOST}:${ctx.port('mongodb')}`;
  assert.deepEqual(mongodb.env(ctx), { MONGODB_URI: uri, MONGO_URL: uri });

  const named = await prepared(mongodb, { user: 'app', password: 'secret', database: 'shop' });
  assert.equal(mongodb.env(named).MONGODB_URI, `mongodb://app:secret@${HOST}:${named.port('mongodb')}/shop?authSource=admin`);
});

test('Mailpit provides SMTP and its web address, with credentials only when configured', () => {
  const [container] = mailpit.containers();
  assert.deepEqual(container.ports, { smtp: 1025, web: 8025 });
  assert.deepEqual(container.health.command, ['/mailpit', 'readyz']);
  assert.equal(container.env.MP_SMTP_AUTH_ACCEPT_ANY, '1');
  const ctx = context();
  assert.deepEqual(mailpit.env(ctx), { SMTP_HOST: HOST, SMTP_PORT: String(ctx.port('smtp')), MAILPIT_URL: `http://${HOST}:${ctx.port('web')}` });
  const withUser = context({ options: { user: 'mailer', password: 'any' } });
  assert.deepEqual([mailpit.env(withUser).SMTP_USER, mailpit.env(withUser).SMTP_PASSWORD], ['mailer', 'any']);
});

test('LLM uses the actual model from supplied inputs without containers', async () => {
  assert.equal((llm as TwinService).containers, undefined);
  assert.deepEqual(llm.inputs.map(({ name }) => name), ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL']);
  const [baseUrl, key, model] = llm.inputs;
  assert.ok(key.secret && !baseUrl.secret && !model.secret);
  assert.ok(baseUrl.pattern.test('https://api.example.test/v1') && !baseUrl.pattern.test('api.example.test'));
  assert.ok(!key.pattern.test('') && !model.pattern.test('two words'));

  assert.deepEqual(await llm.setup(context({ options: { source: 'app' } })), { source: 'app' });
  assert.deepEqual(await llm.setup(context()), { source: 'settings' });
  await assert.rejects(llm.setup(context({ options: { source: 'emulate' } })), /llm source must be one of: app, settings/);

  const inputs = { OPENAI_BASE_URL: 'https://api.example.test/v1', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'vendor/model' };
  assert.deepEqual(llm.env(context({ inputs })), inputs);
});

test('Emulate rejects vendors with official test modes and names the alternative', async () => {
  for (const [name, alternative] of Object.entries(official)) {
    const message = `emulate does not replace ${name}: use ${alternative}`;
    assert.throws(() => emulate.containers(context({ options: { services: ['github', name] } })), { message });
    assert.throws(() => emulate.env(context({ options: { services: ['github'], seed: { [name]: {} } } })), { message });
  }
  assert.deepEqual(Object.keys(official).sort(), ['auth0', 'clerk', 'microsoft', 'mongoatlas', 'okta', 'resend', 'slack', 'stripe', 'twilio']);
  assert.deepEqual(Object.keys(emulated).sort(), ['apple', 'aws', 'github', 'google', 'linear', 'vercel']);
  for (const services of [[], ['supabase'], ['constructor'], 'github', [7], null]) {
    assert.throws(() => emulate.env(context({ options: { services } })), /emulate services must be chosen from: github, google/);
  }
  for (const seed of ['github', ['github'], { github: 'users' }]) {
    assert.throws(() => emulate.containers(context({ options: { services: ['github'], seed } })), /emulate seed(\.github)? must/);
  }
});

test('Emulate runs the pinned CLI with a seed from its environment and provides documented variables', () => {
  const seed = { tokens: { admin_token: { login: 'admin' } }, github: { users: [{ login: 'octocat' }], port: 9999, baseUrl: 'http://localhost:9999' } };
  const ctx = context({ options: { services: ['github', 'google', 'github'], seed } });
  const [container] = emulate.containers(ctx);
  assert.equal(container.image, 'node:22.23.3-bookworm-slim');
  assert.deepEqual(container.ports, { github: 4000, google: 4001 });
  assert.deepEqual(JSON.parse(container.env.EMULATE_SEED), {
    tokens: seed.tokens,
    github: { users: [{ login: 'octocat' }], port: 4000, baseUrl: ctx.url('github') },
    google: { port: 4001, baseUrl: ctx.url('google') },
  });
  assert.deepEqual(container.command.slice(0, 2), ['sh', '-c']);
  assert.equal(container.command[2], `printf '%s' "$EMULATE_SEED" > /tmp/emulate-seed.json && exec npx --yes emulate@0.11.2 start --service github,google --seed /tmp/emulate-seed.json`);
  assert.match(container.health.command.at(-1)!, /\[4000,4001\]/);
  assert.deepEqual(emulate.env(ctx), { GITHUB_EMULATOR_URL: ctx.url('github'), GOOGLE_EMULATOR_URL: ctx.url('google') });
});
