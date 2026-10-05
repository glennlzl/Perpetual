import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import { services } from '../src/twin/registry.ts';
import supabase from '../src/twin/services/supabase.ts';
import type { Json } from '../src/twin/config.ts';
import type { CommandOutput, TwinService } from '../src/twin/registry.ts';

type AuthService = TwinService<{ users?: Json }, { adminKey: string }>;
type AuthContext = Parameters<AuthService['env']>[0];
type Respond = (args: string[]) => Partial<CommandOutput> | Promise<Partial<CommandOutput>>;

// A service that runs a container and signs up the users its options name, in the service file shape.
let generation = 0;
const auth = {
  id: 'auth', title: 'Auth', fidelity: 'actual',
  containers: () => [{ name: 'auth', image: 'auth/server:1.0', ports: { api: 9999 } }],
  setup: async () => ({ adminKey: 'admin-key-fixture' }),
  env: ctx => ({ AUTH_URL: ctx.url('api') }),
  // setup() below gives the hook the test's call list.
  accounts: async (ctx: AuthContext & { calls: unknown[][] }) => {
    ctx.calls.push(['accounts', ctx.outputs.adminKey, ctx.port('api')]);
    return (Array.isArray(ctx.options.users) ? ctx.options.users.map(String) : []).map(id => ({ id, label: id, username: `${id}@example.test`, password: `pw-${id}-${++generation}-fixture` }));
  },
} satisfies AuthService;

async function setup(t: TestContext, { service = auth, respond = () => ({}) }: { service?: AuthService; respond?: Respond } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-accounts-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(source);
  const calls: unknown[][] = [], steps: string[] = [];
  const exec = async (file: string, args: string[]) => { calls.push(args); return { stdout: '', stderr: '', ...await respond(args) }; };
  // The accounts hook logs into the same call list, so its place among the Docker commands is visible.
  const logged: AuthService = { ...service, accounts: service.accounts && ((ctx: AuthContext) => service.accounts!(Object.assign(ctx, { calls }))) };
  const runtime = createTwinRuntime({ exec, services: { [service.id]: logged }, owner: 'owner-1', isFree: async () => true });
  const config = (fixtures: object[] = []) => ({ services: { [service.id]: { users: ['owner', 'viewer'] } }, apps: { web: { start: 'node server.js', port: 3000 } }, fixtures });
  const prepare = (input: unknown = config()) => runtime.prepare({ dataDir, id: 'beta', config: input, source, onStep: step => steps.push(step) });
  return { dataDir, runtime, calls, steps, config, prepare, dir: join(dataDir, 'environments', 'beta', 'twin') };
}
const compose = (args: unknown[]) => args[0] === 'compose' ? args.slice(args.indexOf('--env-file') + 2) : args;

test('A service creates its test accounts once its containers run, before fixtures and apps', async t => {
  const f = await setup(t);
  const result = await f.prepare(f.config([{ service: 'auth', command: 'pnpm seed' }]));
  assert.deepEqual(f.steps, ['Setting up Auth', 'Loading source', 'Starting services', 'Creating test accounts', 'Loading fixture 1 of 1', 'Starting twin']);
  const [copy, up, accounts, , all] = f.calls.map(compose);
  assert.deepEqual(copy,['--progress', 'quiet', '--profile', 'source', 'run', '--rm', '--no-TTY', 'source']);
  assert.deepEqual(up, ['up', '--wait', 'auth']);
  assert.deepEqual(accounts.slice(0, 2), ['accounts', 'admin-key-fixture'], 'The hook sees the setup outputs.');
  assert.equal(typeof accounts[2], 'number');
  assert.deepEqual(all, ['up', '--wait']);
  // The result, which becomes the environment view, names each account without its password.
  assert.deepEqual(result.accounts, [
    { id: 'owner', label: 'owner', username: 'owner@example.test' },
    { id: 'viewer', label: 'viewer', username: 'viewer@example.test' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /pw-/);
});

test('Accounts come before the shared install, which comes before fixtures that need its dependencies', async t => {
  const f = await setup(t);
  await f.prepare({ ...f.config([{ service: 'auth', command: 'pnpm seed' }]), install: { directory: '.', command: 'npm ci' } });
  assert.deepEqual(f.steps, ['Setting up Auth', 'Loading source', 'Starting services', 'Creating test accounts', 'Installing dependencies', 'Loading fixture 1 of 1', 'Starting twin']);
  const calls = f.calls.map(args => compose(args)[0] === 'accounts' ? 'accounts' : compose(args).includes('install') ? 'install' : String(args.at(-1)).endsWith('pnpm seed') ? 'fixture' : compose(args));
  assert.deepEqual(calls, [['--progress', 'quiet', '--profile', 'source', 'run', '--rm', '--no-TTY', 'source'], ['up', '--wait', 'auth'], 'accounts', 'install', 'fixture', ['up', '--wait']]);
});

test('Services start for their accounts even without fixtures or an install', async t => {
  const f = await setup(t);
  await f.prepare();
  assert.deepEqual(f.steps, ['Setting up Auth', 'Loading source', 'Starting services', 'Creating test accounts', 'Starting twin']);
  assert.deepEqual(f.calls.map(args => compose(args)[0] === 'accounts' ? 'accounts' : compose(args)), [['--progress', 'quiet', '--profile', 'source', 'run', '--rm', '--no-TTY', 'source'], ['up', '--wait', 'auth'], 'accounts', ['up', '--wait']]);
});

test('Passwords stay in the private twin state, where only account() reads them, and logs redact them', async t => {
  const passwords: string[] = [];
  const f = await setup(t, { respond: args => args.includes('logs') ? { stdout: `auth | signed in ${passwords.join(' ')}\n` } : {} });
  await f.prepare();
  const state = JSON.parse(await readFile(join(f.dir, 'twin.json'), 'utf8'));
  assert.equal((await stat(join(f.dir, 'twin.json'))).mode & 0o777, 0o600);
  const accounts: { service: string; id: string; username: string; password: string }[] = state.accounts;
  assert.deepEqual(accounts.map(({ service, id, username }) => [service, id, username]), [['auth', 'owner', 'owner@example.test'], ['auth', 'viewer', 'viewer@example.test']]);
  passwords.push(...accounts.map(account => account.password));
  assert.deepEqual(await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'viewer' }), { username: 'viewer@example.test', password: passwords[1], authEndpoints: [] });
  assert.equal(await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'nobody' }), null);
  assert.equal(await f.runtime.account({ dataDir: f.dataDir, id: 'gamma', accountId: 'owner' }), null, 'A twin that does not exist has no accounts.');
  for (const name of ['compose.yaml', '.env']) for (const password of passwords) assert.ok(!(await readFile(join(f.dir, name), 'utf8')).includes(password), name);
  const logs = await f.runtime.logs({ dataDir: f.dataDir, id: 'beta' });
  assert.equal(logs, 'auth | signed in [redacted] [redacted]\n');
});

test('Rebuilding a twin replaces its accounts and their passwords', async t => {
  const f = await setup(t);
  await f.prepare();
  const before = await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'owner' });
  await f.prepare();
  const after = await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'owner' });
  assert.equal(after!.username, before!.username);
  assert.notEqual(after!.password, before!.password);
  await f.runtime.destroy({ dataDir: f.dataDir, id: 'beta' });
  assert.equal(await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'owner' }), null);
});

test('Invalid or duplicate accounts stop prepare without revealing a password', async t => {
  const leaky = { ...auth, accounts: async () => [{ id: 'Owner!', label: 'Owner', username: 'owner@example.test', password: 'pw-leak-fixture' }] };
  const invalid = await setup(t, { service: leaky });
  await assert.rejects(invalid.prepare(), (error: Error) => {
    assert.equal(error.message, 'Auth: auth accounts[0] needs an id, label, username and password.');
    return true;
  });
  const twice = { ...auth, accounts: async () => ['owner', 'owner'].map((id, index) => ({ id, label: id, username: `${id}${index}@example.test`, password: `pw-${index}-fixture` })) };
  const duplicate = await setup(t, { service: twice });
  await assert.rejects(duplicate.prepare(), /^Error: Auth: Test account "owner" is defined twice\.$/);
  for (const value of [null, {}, 'owner']) {
    const f = await setup(t, { service: { ...auth, accounts: async () => value } });
    await assert.rejects(f.prepare(), /Auth: auth accounts must be a list\./);
  }
  const blankPassword = await setup(t, { service: { ...auth, accounts: async () => [{ id: 'owner', label: 'owner', username: 'owner@example.test', password: '' }] } });
  await assert.rejects(blankPassword.prepare(), /needs an id, label, username and password/);
});

test('A blocked service is not asked for accounts, and a twin without accounts reports none', async t => {
  const gated = { ...auth, inputs: [{ name: 'AUTH_KEY', label: 'Auth test key', secret: true }] };
  const f = await setup(t, { service: gated });
  const result = await f.prepare();
  assert.equal(result.status, 'blocked');
  assert.equal(f.calls.some(args => args[0] === 'accounts'), false);
  assert.equal('accounts' in result, false);
  assert.equal(await f.runtime.account({ dataDir: f.dataDir, id: 'beta', accountId: 'owner' }), null);
});

// A stand-in for the local Auth (GoTrue) admin API, answering like v2 does: 422 for a registered
// address, `filter` on the user list, and PUT to update a user.
type AuthUser = { id: string; email: string; password?: string };
type AuthBody = Partial<AuthUser> & { email: string };
function authAdmin({ registered = [], failure }: { registered?: string[]; failure?: string } = {}) {
  const users = new Map<string, AuthUser>(registered.map(email => [email, { id: randomUUID(), email, password: 'seeded-password' }]));
  const requests: { origin: string; method?: string; path: string; filter: string | null; headers: RequestInit['headers']; body: AuthBody | undefined }[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const address = new URL(url), body: AuthBody | undefined = init.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ origin: address.origin, method: init.method, path: address.pathname, filter: address.searchParams.get('filter'), headers: init.headers, body });
    if (failure) return reply(500, { code: 500, msg: failure });
    if (address.pathname === '/auth/v1/admin/users' && init.method === 'POST' && body) {
      if (users.has(body.email)) return reply(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      const user = { id: randomUUID(), ...body };
      users.set(body.email, user);
      return reply(200, { id: user.id, email: user.email });
    }
    if (address.pathname === '/auth/v1/admin/users' && init.method === 'GET') {
      return reply(200, { aud: 'authenticated', users: [...users.values()].filter(user => user.email.includes(address.searchParams.get('filter') ?? '')).map(({ id, email }) => ({ id, email })) });
    }
    const user = [...users.values()].find(item => address.pathname === `/auth/v1/admin/users/${item.id}`);
    if (user && init.method === 'PUT') { Object.assign(user, body); return reply(200, { id: user.id, email: user.email }); }
    return reply(404, { message: 'no Route matched with those values' });
  };
  return { fetch, requests, users };
}
// Only what accounts() reads: the users, the service role key, the API port and fetch.
const supabaseContext = (server: ReturnType<typeof authAdmin>, users?: Json) => {
  const ports = new Map<string, number>();
  const port = (name: string) => { if (!ports.has(name)) ports.set(name, 43100 + ports.size); return ports.get(name)!; };
  return { options: { users }, outputs: { serviceRoleKey: 'service-role.jwt' }, port, host: 'host.docker.internal', url: (name: string, path = '') => `http://host.docker.internal:${port(name)}${path}`, fetch: server.fetch } as Parameters<typeof supabase.accounts>[0];
};

test('Supabase creates each configured user through the local Auth admin API with a generated password', async () => {
  const server = authAdmin();
  const ctx = supabaseContext(server, [{ id: 'owner', email: 'Owner@Example.test', metadata: { full_name: 'Owner' } }, { id: 'viewer', email: 'viewer@example.test', emailConfirmed: false }]);
  const accounts = await supabase.accounts(ctx);
  const signIn = [`http://host.docker.internal:${ctx.port('api')}/auth/v1/token`];
  assert.deepEqual(accounts.map(({ password, ...account }) => account), [
    { id: 'owner', label: 'owner', username: 'owner@example.test', authEndpoints: signIn }, { id: 'viewer', label: 'viewer', username: 'viewer@example.test', authEndpoints: signIn }]);
  assert.deepEqual(server.requests.map(({ origin, method, path }) => [origin, method, path]), [
    [`http://127.0.0.1:${ctx.port('api')}`, 'POST', '/auth/v1/admin/users'], [`http://127.0.0.1:${ctx.port('api')}`, 'POST', '/auth/v1/admin/users']]);
  for (const request of server.requests) assert.deepEqual(request.headers, { apikey: 'service-role.jwt', authorization: 'Bearer service-role.jwt', 'content-type': 'application/json' });
  assert.deepEqual(server.requests.map(request => request.body), [
    { email: 'owner@example.test', password: accounts[0].password, email_confirm: true, user_metadata: { full_name: 'Owner' } },
    { email: 'viewer@example.test', password: accounts[1].password, email_confirm: false, user_metadata: {} },
  ]);
  assert.notEqual(accounts[0].password, accounts[1].password);
  for (const { password } of accounts) {
    assert.ok(password.length >= 32);
    for (const kind of [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]) assert.match(password, kind, 'Any password policy accepts it.');
  }
});

test('Supabase gives an already registered user the generated password, so account creation is idempotent', async () => {
  const server = authAdmin({ registered: ['owner@example.test'] });
  const ctx = supabaseContext(server, [{ id: 'owner', email: 'owner@example.test' }]);
  const first = await supabase.accounts(ctx);
  const second = await supabase.accounts(ctx);
  const user = server.users.get('owner@example.test')!;
  assert.equal(server.users.size, 1);
  assert.equal(user.password, second[0].password);
  assert.notEqual(first[0].password, second[0].password);
  assert.deepEqual(server.requests.slice(0, 3).map(({ method, path, filter }) => [method, path, filter]), [
    ['POST', '/auth/v1/admin/users', null], ['GET', '/auth/v1/admin/users', 'owner@example.test'], ['PUT', `/auth/v1/admin/users/${user.id}`, null]]);
  assert.deepEqual(server.requests[2].body, { email: 'owner@example.test', password: first[0].password, email_confirm: true, user_metadata: {} });
});

test('Supabase reports Auth errors and checks its users before any request', async () => {
  const failing = authAdmin({ failure: 'Database error saving new user' });
  await assert.rejects(supabase.accounts(supabaseContext(failing, [{ id: 'owner', email: 'owner@example.test' }])),
    /Supabase Auth account [a-f0-9]{12}: POST \/auth\/v1\/admin\/users; HTTP failure \(HTTP 500\).*phase: response received.*outcome unknown/);
  for (const [users, message] of [
    [{ id: 'owner' }, /supabase\.users must be a list/],
    [[{ id: 'Owner', email: 'owner@example.test' }], /users\[0\]\.id must use lowercase letters/],
    [[{ id: 'owner' }], /users\[0\]\.email must be an email address/],
    [[{ id: 'owner', email: 'owner@example.test', password: 'chosen' }], /users\[0\] has unsupported field password/],
    [[{ id: 'owner', email: 'owner@example.test', emailConfirmed: 'yes' }], /emailConfirmed must be true or false/],
    [[{ id: 'owner', email: 'owner@example.test', metadata: ['admin'] }], /metadata must be an object/],
    [[{ id: 'owner', email: 'owner@example.test' }, { id: 'admin', email: 'OWNER@example.test' }], /users\[1\]\.email is used by another test account/],
  ] satisfies [Json, RegExp][]) {
    const server = authAdmin();
    await assert.rejects(supabase.accounts(supabaseContext(server, users)), message);
    assert.equal(server.requests.length, 0);
  }
  const quiet = authAdmin();
  assert.deepEqual(await supabase.accounts(supabaseContext(quiet, undefined)), []);
  assert.equal(quiet.requests.length, 0);
});

test('Supabase provides the accounts hook', () => {
  assert.equal(services.supabase.accounts, supabase.accounts);
  assert.equal(typeof supabase.accounts, 'function');
});
