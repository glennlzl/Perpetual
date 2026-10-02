import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import trigger, { BOT_EMAIL, CREDENTIALS, PROJECT, VERSION, cliImage, stack } from '../src/twin/services/trigger-dev.ts';

const HOST = 'host.docker.internal';
const SOCKET = /docker\.sock/;
const PORT = 43148;
const LOGGED_LINK = `sendEmail to ${BOT_EMAIL}\nhttp://localhost:${PORT}/magic?token=tok%2Ebot\n`;
const run = promisify(execFile);
const mode = async (file: string) => (await stat(file)).mode & 0o777;
type Ctx = Parameters<typeof trigger.setup>[0];
type Request = { key: string; search: string; port: number; headers: Record<string, string>; body: RequestInit['body']; redirect: RequestInit['redirect'] };
type Command = { command: string; args: string[] };
type Respond = (call: Command) => string | undefined | Promise<string | undefined>;

// A fake self-hosted Trigger.dev webapp: the sign-in flow, the organization and project APIs.
const webapp = ({ issued = { token: { token: 'tr_pat_bot', obfuscatedToken: 'tr_pat_***' } } }: { issued?: { token: unknown } } = {}) => {
  const requests: Request[] = [], projects: { externalRef: string; name: string }[] = [], orgs: { slug: string }[] = [];
  const reply = (body: unknown, init: ResponseInit = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status: 200, ...init });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const { pathname, search, port } = new URL(url), key = `${init.method ?? 'GET'} ${pathname}`, headers = (init.headers ?? {}) as Record<string, string>;
    requests.push({ key, search, port: Number(port), headers, body: init.body, redirect: init.redirect });
    if (key === 'POST /login/magic') return reply(undefined, { status: 302, headers: [['set-cookie', 'magic=pending; Path=/; HttpOnly']] });
    if (key === 'GET /magic') {
      assert.equal(headers.cookie, 'magic=pending');
      return reply(undefined, { status: 302, headers: [['set-cookie', 'session=bot; Path=/; Secure']] });
    }
    if (key === 'POST /api/v1/authorization-code') return reply({ authorizationCode: 'code1', url: 'http://localhost/account/authorization-code/code1' });
    if (key === 'POST /account/authorization-code/code1') {
      assert.match(headers.cookie, /session=bot/);
      assert.ok(init.body instanceof URLSearchParams); // a form post, as the consent form's action reads form data
      return reply(undefined);
    }
    if (key === 'POST /api/v1/token') return reply(issued);
    // A token of an earlier database, as after the instance's volumes were removed.
    if (headers.authorization?.startsWith('Bearer ') && headers.authorization !== 'Bearer tr_pat_bot') return reply({ error: 'Invalid or Missing API key' }, { status: 401 });
    assert.equal(headers.authorization, 'Bearer tr_pat_bot');
    if (key === 'GET /api/v1/orgs') return reply(orgs);
    if (key === 'POST /api/v1/orgs') { orgs.push({ slug: 'perpetual', ...JSON.parse(init.body as string) }); return reply(orgs.at(-1)); }
    if (key === 'GET /api/v1/orgs/perpetual/projects') return reply(projects);
    if (key === 'POST /api/v1/orgs/perpetual/projects') {
      projects.push({ externalRef: `proj_${projects.length + 1}`, ...JSON.parse(init.body as string) });
      return reply(projects.at(-1));
    }
    const dev = pathname.match(/^\/api\/v1\/projects\/(proj_\d+)\/dev$/);
    if (dev) return reply({ apiKey: `tr_dev_${dev[1]}`, apiUrl: 'http://host.docker.internal' });
    if (key.startsWith('DELETE /api/v1/projects/')) return reply({ id: pathname.split('/').at(-1) });
    return reply({ error: 'Not found' }, { status: 404 });
  };
  return { fetch, requests, projects };
};

// A service context whose host commands return canned output; nothing touches Docker. The machine-wide port
// reservation behaves like the runtime's: an existing instance keeps its port, a new one gets `port`.
// Only what Trigger.dev uses: it never asks the context for a port, URL, app or container run.
const context = async ({ server, respond = ({ args }) => args.includes('logs') ? LOGGED_LINK : '', port = PORT, ...values }: {
  server?: ReturnType<typeof webapp>; respond?: Respond; port?: number | ((current: unknown) => number);
} & Partial<Pick<Ctx, 'project' | 'shared' | 'options' | 'outputs' | 'fetch'>> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'twin-trigger-')), calls: (Command & { options?: { cwd?: string } })[] = [], reservations: { name: string; current: unknown }[] = [];
  return {
    project: 'perpetual-beta1', dir: join(root, 'twin'), source: join(root, 'source'), shared: join(root, 'shared', 'trigger-dev'),
    options: {}, inputs: {}, outputs: {}, host: HOST, fetch: server?.fetch,
    sharedPort: async (name: string, current?: unknown) => { reservations.push({ name, current }); return typeof port === 'function' ? port(current) : current as number | undefined ?? port; },
    exec: async (command: string, args: string[], options?: { cwd?: string }) => { calls.push({ command, args, options }); return { stdout: await respond({ command, args }) ?? '' }; },
    calls, reservations, ...values,
  } as Ctx & { calls: typeof calls; reservations: typeof reservations };
};
const composeCall = (ctx: Ctx) => ['compose', '--project-name', PROJECT, '--project-directory', ctx.shared];
const secretLines = (text: string) => text.split('\n').filter(line => /^[A-Z_]+='[0-9a-f]{32}'$/.test(line));

test('Trigger.dev starts one shared instance on its machine-wide port, published on 127.0.0.1 with host.docker.internal API URLs', async () => {
  const server = webapp(), ctx = await context({ server });
  ctx.outputs = await trigger.setup(ctx);
  const home = ctx.shared;
  assert.deepEqual(ctx.reservations, [{ name: PROJECT, current: undefined }]);
  assert.deepEqual(ctx.calls.find(({ args }) => args.includes('up'))?.args, [...composeCall(ctx), 'up', '--detach', '--wait']);
  const file: { services: Record<string, { image: string; restart?: string; ports?: string[]; healthcheck: { start_period: string } }> } = parse(await readFile(join(home, 'compose.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(file.services).sort(), ['clickhouse', 'postgres', 'redis', 'webapp']);
  assert.ok(Object.values(file.services).every(service => service.restart === 'unless-stopped'), 'The instance outlives any twin and comes back with Docker.');
  assert.equal(file.services.webapp.image, `ghcr.io/triggerdotdev/trigger.dev:v${VERSION}`);
  assert.deepEqual(file.services.webapp.ports, [`127.0.0.1:${PORT}:3000`]);
  assert.match(file.services.webapp.healthcheck.start_period, /^\d+m$/); // first boot runs every migration before listening
  assert.ok(Object.values(file.services).every(service => !service.ports || service === file.services.webapp));
  assert.doesNotMatch(await readFile(join(home, 'compose.yaml'), 'utf8'), SOCKET);
  const env = await readFile(join(home, '.env'), 'utf8');
  assert.equal(await mode(join(home, '.env')), 0o600);
  for (const line of [`API_ORIGIN='http://${HOST}:${PORT}'`, `DEV_ENGINE_URL='http://${HOST}:${PORT}'`, `APP_ORIGIN='http://localhost:${PORT}'`,
    "TRIGGER_BOOTSTRAP_ENABLED='0'", "ORG_CREATION_API_ENABLED='1'", "TRIGGER_TELEMETRY_DISABLED='1'", "POSTHOG_PROJECT_KEY=''",
    "WHITELISTED_EMAILS='^trigger@perpetual\\.localhost$'"]) assert.ok(env.includes(`${line}\n`), line);
  for (const name of ['SESSION_SECRET', 'MAGIC_LINK_SECRET', 'ENCRYPTION_KEY', 'POSTGRES_PASSWORD']) assert.match(env, new RegExp(`^${name}='[0-9a-f]{32}'$`, 'm'));
  assert.ok(server.requests.every(request => request.port === PORT));
  assert.deepEqual(trigger.env(ctx), { TRIGGER_API_URL: `http://${HOST}:${PORT}`, TRIGGER_SECRET_KEY: 'tr_dev_proj_1' });
});

test('Trigger.dev bootstraps the bot token once, from the logged magic link and CLI authorization', async () => {
  const server = webapp(), ctx = await context({ server });
  ctx.outputs = await trigger.setup(ctx);
  const keys = server.requests.map(({ key }) => key);
  assert.deepEqual(keys.slice(0, 5), ['POST /login/magic', 'GET /magic', 'POST /api/v1/authorization-code', 'POST /account/authorization-code/code1', 'POST /api/v1/token']);
  assert.equal(new URLSearchParams(server.requests[0].body as URLSearchParams).get('email'), BOT_EMAIL);
  assert.equal(server.requests[1].search, '?token=tok%2Ebot');
  assert.ok(server.requests.slice(0, 2).every(({ redirect }) => redirect === 'manual'));
  assert.ok(ctx.calls.some(({ args }) => args.includes('logs')));
  const state = JSON.parse(await readFile(join(ctx.shared, 'state.json'), 'utf8'));
  assert.deepEqual(state, { port: PORT, token: 'tr_pat_bot', org: 'perpetual' });
  assert.equal(await mode(join(ctx.shared, 'state.json')), 0o600);

  const second = await context({ server, project: 'perpetual-gamma1', shared: ctx.shared });
  second.outputs = await trigger.setup(second);
  assert.deepEqual(second.reservations, [{ name: PROJECT, current: PORT }]);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /login/magic').length, 1);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /api/v1/orgs').length, 1);
  assert.deepEqual(server.projects.map(({ name }) => name), ['perpetual-beta1', 'perpetual-gamma1']);
  assert.equal(second.outputs.secretKey, 'tr_dev_proj_2');
  assert.ok(!second.calls.some(({ args }) => args.includes('logs')));
});

test('Trigger.dev signs the bot in again when the instance rejects its saved token, as after its volumes were removed', async () => {
  const server = webapp(), ctx = await context({ server });
  await mkdir(ctx.shared, { recursive: true });
  await writeFile(join(ctx.shared, 'state.json'), JSON.stringify({ port: PORT, token: 'tr_pat_stale', org: 'gone' }));
  ctx.outputs = await trigger.setup(ctx);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /login/magic').length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(ctx.shared, 'state.json'), 'utf8')), { port: PORT, token: 'tr_pat_bot', org: 'perpetual' });
  assert.equal(ctx.outputs.secretKey, 'tr_dev_proj_1');
});

test('Twins set up at the same time share one sign-in and one organization', async () => {
  const server = webapp(), first = await context({ server });
  const second = await context({ server, project: 'perpetual-gamma1', shared: first.shared });
  const [one, two] = await Promise.all([trigger.setup(first), trigger.setup(second)]);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /login/magic').length, 1);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /api/v1/orgs').length, 1);
  assert.deepEqual([one.accessToken, two.accessToken], ['tr_pat_bot', 'tr_pat_bot']);
  assert.deepEqual(server.projects.map(({ name }) => name).sort(), ['perpetual-beta1', 'perpetual-gamma1']);
});

test('Trigger.dev rewrites stale stack files on every start, keeping the instance secrets and following its reserved port', async () => {
  const server = webapp(), ctx = await context({ server });
  await trigger.setup(ctx);
  const secrets = secretLines(await readFile(join(ctx.shared, '.env'), 'utf8'));
  assert.equal(secrets.length, 8);
  const previous = parse(await readFile(join(ctx.shared, 'compose.yaml'), 'utf8'));
  for (const service of Object.values(previous.services) as Record<string, unknown>[]) delete service.logging;
  await writeFile(join(ctx.shared, 'compose.yaml'), stringify(previous));
  await writeFile(join(ctx.shared, '.env'), `${secrets.join('\n')}\nAPP_ORIGIN='http://localhost:1'\nSTALE='1'\n`);

  const moved = PORT + 100, again = await context({ server, shared: ctx.shared, port: () => moved });
  again.outputs = await trigger.setup(again);
  assert.deepEqual(again.reservations, [{ name: PROJECT, current: PORT }]);
  assert.equal(await readFile(join(ctx.shared, 'compose.yaml'), 'utf8'), stringify(stack(moved)));
  const updated = parse(await readFile(join(ctx.shared, 'compose.yaml'), 'utf8'));
  for (const [name, service] of Object.entries(updated.services) as [string, { logging: unknown; volumes: unknown }][]) {
    assert.deepEqual(service.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }, name);
    assert.deepEqual(service.volumes, previous.services[name].volumes, `${name} keeps its data mounts`);
  }
  assert.deepEqual(updated.volumes, previous.volumes);
  const env = await readFile(join(ctx.shared, '.env'), 'utf8');
  assert.deepEqual(secretLines(env), secrets);
  assert.ok(env.includes(`APP_ORIGIN='http://localhost:${moved}'\n`) && env.includes(`API_ORIGIN='http://${HOST}:${moved}'\n`));
  assert.doesNotMatch(env, /STALE/);
  assert.equal(JSON.parse(await readFile(join(ctx.shared, 'state.json'), 'utf8')).port, moved);
  assert.equal(again.outputs.apiUrl, `http://${HOST}:${moved}`);
  assert.equal(server.requests.filter(({ key }) => key === 'POST /login/magic').length, 1, 'The bot token survives the move.');
});

test('Trigger.dev accepts the issued token as a bare string', async () => {
  const server = webapp({ issued: { token: 'tr_pat_bot' } }), ctx = await context({ server });
  ctx.outputs = await trigger.setup(ctx);
  assert.equal(ctx.outputs.accessToken, 'tr_pat_bot');
});

test('Trigger.dev fails setup when no access token is issued', async () => {
  const server = webapp({ issued: { token: null } }), ctx = await context({ server });
  await assert.rejects(trigger.setup(ctx), /did not issue an access token/);
  assert.ok(!server.requests.some(({ key }) => key === 'GET /api/v1/orgs'));
});

test('Trigger.dev reuses the twin project on rebuild', async () => {
  const server = webapp(), ctx = await context({ server });
  await trigger.setup(ctx);
  ctx.outputs = await trigger.setup(ctx);
  assert.equal(server.projects.length, 1);
  assert.equal(ctx.outputs.projectRef, 'proj_1');
});

test('Trigger.dev fails setup when no sign-in link is logged', async () => {
  let polls = 0;
  const server = webapp(), ctx = await context({ server, respond: ({ args }) => {
    if (args.includes('logs') && (polls += 1) > 1) throw new Error('stop polling');
    return '';
  } });
  await assert.rejects(trigger.setup(ctx), /stop polling|sign-in link/);
  assert.ok(!server.requests.some(({ key }) => key === 'GET /magic'));
});

test('Trigger.dev builds its pinned CLI image once per version, before the instance starts', async () => {
  const images = new Set<string | undefined>();
  const respond: Respond = ({ args }) => {
    if (args[0] === 'image') { if (!images.has(args.at(-1))) throw new Error('No such image'); return ''; }
    if (args[0] === 'build') { images.add(args[args.indexOf('--tag') + 1]); return ''; }
    return args.includes('logs') ? LOGGED_LINK : '';
  };
  const server = webapp(), ctx = await context({ server, respond });
  await trigger.setup(ctx);
  const [inspect, build, up] = ctx.calls;
  assert.deepEqual(inspect.args, ['image', 'inspect', '--format', '{{.Id}}', cliImage(VERSION)]);
  assert.deepEqual(build.args, ['build', '--build-arg', `VERSION=${VERSION}`, '--tag', cliImage(VERSION), join(ctx.shared, 'cli')]);
  assert.ok(up.args.includes('up'));
  const recipe = await readFile(join(ctx.shared, 'cli', 'Dockerfile'), 'utf8');
  assert.match(recipe, /^FROM node:22-bookworm-slim\n/);
  assert.match(recipe, /npm install --global "trigger\.dev@\$VERSION"/);

  const rebuild = await context({ server, respond, shared: ctx.shared });
  await trigger.setup(rebuild);
  assert.ok(!rebuild.calls.some(({ args }) => args[0] === 'build'), 'The image is reused, not rebuilt.');

  const sdk = await context({ server, respond, shared: ctx.shared, options: { version: '4.4.4' } });
  await trigger.setup(sdk);
  assert.match(cliImage('4.4.4'), /^perpetual-trigger-cli:4\.4\.4-[0-9a-f]{12}$/);
  assert.deepEqual(sdk.calls.find(({ args }) => args[0] === 'build')?.args.slice(1, 5), ['--build-arg', 'VERSION=4.4.4', '--tag', cliImage('4.4.4')]);
});

test('Trigger.dev stops before the instance when its CLI image cannot be built or its version is not exact', async () => {
  const server = webapp();
  const failing = await context({ server, respond: ({ args }) => { if (args[0] !== 'compose') throw new Error(`${args[0]} failed`); return ''; } });
  await assert.rejects(trigger.setup(failing), /build failed/);
  assert.ok(!failing.calls.some(({ args }) => args[0] === 'compose'));
  for (const version of ['latest', '^4.4.4', '4.4', 4]) {
    const ctx = await context({ server, options: { version } });
    await assert.rejects(trigger.setup(ctx), /exact trigger\.dev CLI version/);
    assert.deepEqual(ctx.calls, []);
  }
  assert.deepEqual(server.requests, []);
});

test('Trigger.dev runs a per-twin dev worker from the pinned CLI image, with the bot token only in its login profile', async t => {
  const outputs = { apiUrl: `http://${HOST}:${PORT}`, secretKey: 'tr_dev_1', projectRef: 'proj_1', accessToken: 'tr_pat_bot' };
  const ctx = await context({ options: { directory: 'jobs', env: { DATABASE_URL: 'postgresql://db' } }, outputs });
  const [worker] = trigger.containers(ctx);
  assert.equal(worker.directory, 'jobs');
  assert.equal(worker.image, cliImage(VERSION));
  assert.deepEqual(worker.command.slice(0, 2), ['sh', '-c']);
  assert.deepEqual(worker.command.slice(3), ['trigger', '--project-ref', 'proj_1', '--skip-update-check']);
  assert.deepEqual(Object.keys(worker.env), ['DATABASE_URL', 'TRIGGER_API_URL', CREDENTIALS]);
  assert.deepEqual(Object.entries(worker.env).filter(([, value]) => value.includes('tr_pat_bot')).map(([name]) => name), [CREDENTIALS]);
  assert.ok(!Object.values(worker).flat().some(value => SOCKET.test(String(value))));
  ctx.options.version = '4.4.4';
  assert.equal(trigger.containers(ctx)[0].image, cliImage('4.4.4'));
  // Options are JSON until used: the worker's variables must be text and its directory a repository path.
  const invalid: [Ctx['options'], RegExp][] = [[{ env: ['DATABASE_URL'] }, /trigger-dev\.env must map variable names/], [{ env: { DATABASE_URL: { url: 'x' } } }, /trigger-dev\.env\.DATABASE_URL must be text/], [{ directory: 7 }, /trigger-dev\.directory must be a path/]];
  for (const [options, message] of invalid) assert.throws(() => trigger.containers({ ...ctx, options }), message);

  // The worker command itself, run by a real shell with a stand-in `trigger` that reports what the CLI would see.
  const root = await mkdtemp(join(tmpdir(), 'twin-trigger-login-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), out = join(root, 'out');
  await mkdir(bin); await mkdir(out);
  await writeFile(join(bin, 'trigger'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT/args"\nenv > "$OUT/env"\n');
  await chmod(join(bin, 'trigger'), 0o755);
  const login = async (env: Record<string, string>) => {
    await run(worker.command[0], worker.command.slice(1), { env: { PATH: `${bin}:${process.env.PATH}`, OUT: out, ...worker.env, ...env } });
    return { args: await readFile(join(out, 'args'), 'utf8'), env: await readFile(join(out, 'env'), 'utf8') };
  };
  const expected = { version: 2, currentProfile: 'default', profiles: { default: { accessToken: 'tr_pat_bot', apiUrl: outputs.apiUrl } } };

  const home = join(root, 'home'), seen = await login({ HOME: home });
  assert.equal(seen.args, 'dev\n--project-ref\nproj_1\n--skip-update-check\n');
  assert.doesNotMatch(seen.env, /tr_pat_bot|TRIGGER_ACCESS_TOKEN/, 'Task processes inherit this environment.');
  assert.match(seen.env, /^DATABASE_URL=postgresql:\/\/db$/m);
  const profile = join(home, '.config', 'trigger', 'config.json');
  assert.deepEqual(JSON.parse(await readFile(profile, 'utf8')), expected);
  assert.equal(await mode(profile), 0o600);
  assert.equal(await mode(join(home, '.config', 'trigger')), 0o700);

  const xdg = join(root, 'xdg');
  await login({ HOME: home, XDG_CONFIG_HOME: xdg });
  assert.deepEqual(JSON.parse(await readFile(join(xdg, 'trigger', 'config.json'), 'utf8')), expected);
});

test('Trigger.dev teardown deletes only the twin project', async () => {
  const server = webapp(), ctx = await context({ server });
  await trigger.setup(ctx);
  const before = ctx.calls.length;
  await trigger.teardown(ctx);
  assert.equal(server.requests.at(-1)?.key, 'DELETE /api/v1/projects/proj_1');
  assert.equal(ctx.calls.length, before); // the shared instance keeps running

  const fresh = await context({ fetch: () => assert.fail('no instance, nothing to delete') });
  await trigger.teardown(fresh);
});
