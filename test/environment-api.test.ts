import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {fetch, startServer} from './fixtures/controller.ts';
import type {ManagedRuntime} from '../src/environments/manager.ts';
import {createEnvironmentRuntime} from '../src/environments/runtime.ts';
import {createTwinRuntime} from '../src/twin/runtime.ts';

type Plan = {services: Record<string, Record<string, unknown>>; apps: Record<string, {directory: string; start: string; port: number; env: Record<string, string>}>; fixtures: unknown[]};
// The fields these routes answer with.
type Body = {token: string; error?: string; logs?: string; environment: Record<string, unknown>; plan: Plan; environments: Record<string, unknown>[]; pipeline: {stages: {id: string; name: string}[]};
  scan: {repo: {path: string}}; generated?: boolean};
const plan = (): Plan => ({services: {mailpit: {}}, apps: {web: {directory: '.', start: 'node app.mjs', port: 3000, env: {MODE: 'test'}}}, fixtures: []});
const legacyPlan = () => ({version: 1, services: [{id: 'web', name: 'Fixture app', directory: '.', installCommand: '', startCommand: 'node app.mjs', port: 3000, readyPath: '/health', env: {MODE: 'test'}}]});
// Detected from each fixture repository's Express package and its dev script.
const detected = {services: {}, apps: {service: {directory: '.', build: 'npm install', start: 'npm run dev', port: 3000}}};

async function controller(t: TestContext, runtime?: ManagedRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-environment-api-'));
  const dataDir = join(directory, 'controller-data');
  const repos = [join(directory, 'source-a'), join(directory, 'source-b')];
  for (const [index, repo] of repos.entries()) {
    await mkdir(repo);
    await writeFile(join(repo, 'package.json'), JSON.stringify({name: `fixture-${index}`, scripts: {dev: 'node app.mjs'}, dependencies: {express: 'fixture-only'}}));
    await writeFile(join(repo, 'app.mjs'), "// Plan fixture; this file is never executed.\napp.get('/health', (req, res) => res.json({status: 'ok'}));\n");
  }
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let token: string;
  t.after(async () => { try { await app?.close(); } finally { await rm(directory, {recursive: true, force: true}); } });
  async function request(path: string, {method = 'GET', body, headers = {}, session = true}: {method?: string; body?: unknown; headers?: Record<string, string>; session?: boolean} = {}): Promise<{status: number; headers: Headers; body: Body}> {
    const response = await fetch(`${app!.url}${path}`, {method, headers: {
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(session && method === 'POST' ? {'X-Perpetual-Token': token} : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
  }
  async function start() {
    app = await startServer({port: 0, repo: repos[0], dataDir, ...(runtime ? {environments: {runtime}} : {})});
    assert.ok(![4317, 4318].includes(Number(new URL(app!.url).port)));
    token = (await request('/api/session')).body.token;
  }
  async function scan(repo = repos[0]) {
    const result = await request('/api/scan', {method: 'POST', body: {path: repo}});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function stage(name: string, repo = repos[0]) {
    const result = await request('/api/pipeline/action', {method: 'POST', body: {repoPath: repo, action: 'add-stage', name}});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.pipeline.stages.find(item => item.name === name)!.id;
  }
  const query = (repoPath: string, stageId: string) => new URLSearchParams({repoPath, stageId}).toString();
  const view = (stageId: string, repoPath = repos[0]) => request(`/api/environments?${query(repoPath, stageId)}`);
  const post = (operation: string, stageId: string, body: object = {}, repoPath = repos[0]) => request(`/api/environments/${operation}`, {method: 'POST', body: {repoPath, stageId, ...body}});
  await start();
  await scan();
  const beta = await stage('Beta');
  const gamma = await stage('Gamma');
  return {request, view, post, scan, stage, query, repos, beta, gamma, dataDir,
    get token() { return token; }, get url() { return app!.url; },
    async restart(editState?: (state: {plans: Record<string, unknown>; detected?: Record<string, string>; environments: unknown[]}) => void | Promise<void>) {
      await app!.close();
      if (editState) {
        const file = join(dataDir, 'environments', 'state.json');
        const state = JSON.parse(await readFile(file, 'utf8'));
        await editState(state);
        await writeFile(file, JSON.stringify(state), {mode: 0o600});
      }
      await start();
    },
  };
}

test('environment API enforces same-origin session tokens before every mutation', async t => {
  const f = await controller(t);
  const initial = await f.view(f.beta);
  for (const operation of ['plan', 'create', 'cancel', 'destroy', 'logs']) {
    for (const token of [undefined, 'wrong-token']) {
      const denied = await f.request(`/api/environments/${operation}`, {method: 'POST', session: false, headers: token ? {'X-Perpetual-Token': token} : {}, body: {repoPath: f.repos[0], stageId: f.beta}});
      assert.equal(denied.status, 403, operation);
    }
  }
  const edited = plan(); edited.apps.web.port = 3100;
  const body = {repoPath: f.repos[0], stageId: f.beta, plan: edited};
  const crossSite: Record<string, string>[] = [{Origin: 'https://unrelated.example'}, {'Sec-Fetch-Site': 'cross-site'}];
  for (const headers of crossSite) {
    assert.equal((await f.request('/api/environments/plan', {method: 'POST', body, headers})).status, 403, JSON.stringify(headers));
  }
  // fetch normalizes Host; use the HTTP client to exercise an actual wrong host.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.url}/api/environments?${f.query(f.repos[0], f.beta)}`, {headers: {Host: 'unrelated.example'}}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request(`/api/environments?${f.query(f.repos[0], f.beta)}`, {headers: {Origin: 'https://unrelated.example'}})).status, 403);
  assert.equal((await f.request('/api/environments/plan', {method: 'POST', body, headers: {Origin: f.url}})).status, 200);
  const current = await f.view(f.beta);
  assert.equal(current.body.plan.apps.web.port, 3100);
  assert.deepEqual(current.body.environments, initial.body.environments);
});

test('environment plans are isolated by active source and Sandbox stage', async t => {
  const f = await controller(t);
  const edited = plan(); edited.apps.web.port = 3100;
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 200);
  assert.deepEqual((await f.view(f.beta)).body.plan, edited);
  assert.deepEqual((await f.view(f.gamma)).body.plan, detected);
  assert.equal((await f.request('/api/environments')).status, 409);
  assert.equal((await f.view('production')).status, 400);
  assert.equal((await f.view('missing-stage')).status, 400);
  await f.scan(f.repos[1]);
  assert.equal((await f.view(f.beta)).status, 409);
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 409);
  const betaB = await f.stage('Beta', f.repos[1]);
  assert.deepEqual((await f.view(betaB, f.repos[1])).body.plan, detected);
  await f.scan(f.repos[0]);
  assert.deepEqual((await f.view(f.beta)).body.plan, edited);
});

test('a source change deletes the outgoing source’s twins, and a rescan of the same source keeps them', async t => {
  const destroyed: string[] = [];
  const runtime: ManagedRuntime = {
    async prepareEnvironment({environment, onUpdate}) { await onUpdate({sandboxId: environment.id}); return {status: 'ready', services: [], apps: [{id: 'web', url: 'http://host.docker.internal:50123'}]}; },
    async destroySandbox({environment}) { destroyed.push(environment.id); }, environmentHealth: async () => ({status: 'ready'}), environmentLogs: async () => '',
  };
  const f = await controller(t, runtime);
  await f.post('plan', f.beta, {plan: plan()});
  const id = String((await f.post('create', f.beta)).body.environment.id);
  const status = async () => (await f.view(f.beta)).body.environments.find(item => item.id === id)?.status;
  const until = async (done: () => Promise<boolean> | boolean, what: string) => {
    for (const deadline = Date.now() + 10_000; !await done();) {
      assert.ok(Date.now() < deadline, what);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await until(async () => await status() === 'ready', 'The twin becomes ready.');
  // The same checkout scanned again is the same source, whose pipeline still lists its twin; the manager's own tests show
  // that the active source's twins stay through every pass.
  await f.scan(f.repos[0]);
  assert.equal(await status(), 'ready');
  await f.scan(f.repos[1]);
  await until(() => destroyed.includes(id), 'The outgoing source’s twin is deleted.');
  await f.scan(f.repos[0]);
  await until(async () => await status() === 'destroyed', 'Its record says it was deleted.');
});

test('Stop is scoped and accepted before its owned cleanup completes', async t => {
  let entered!: () => void, releaseCleanup!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const runtime: ManagedRuntime = {
    async prepareEnvironment({environment, signal, onUpdate}) {
      await onUpdate({status: 'preparing', step: 'Setting up dependency', sandboxId: environment.id}); entered();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
      throw new Error('Unreachable');
    },
    async destroySandbox() { await cleanup; }, environmentHealth: async () => ({status: 'ready'}), environmentLogs: async () => 'Preparing dependency\n',
  };
  const f = await controller(t, runtime);
  await f.post('plan', f.beta, {plan: plan()});
  const created = await f.post('create', f.beta); await started;
  const id = created.body.environment.id;
  try {
    assert.equal((await f.request('/api/environments/cancel', {method: 'POST', session: false, body: {repoPath: f.repos[0], stageId: f.beta, id}})).status, 403);
    assert.equal((await f.post('cancel', f.gamma, {id})).status, 400);
    assert.equal((await f.post('cancel', f.beta, {id}, f.repos[1])).status, 409);
    assert.equal((await f.view(f.beta)).body.environments[0].cancellationRequestedAt, undefined);
    const stopped = await f.post('cancel', f.beta, {id});
    assert.equal(stopped.status, 202); assert.ok(stopped.body.environment.cancellationRequestedAt);
    assert.equal(stopped.body.environment.step, 'Stopping'); assert.equal(stopped.body.environment.cleanedAt, undefined);
    assert.equal((await f.post('cancel', f.beta, {id})).status, 202, 'A repeated Stop is idempotent.');
    assert.equal((await f.post('destroy', f.beta, {id})).status, 409, 'The accepted stop still owns its cleanup.');
  } finally { releaseCleanup(); }
  let final: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    final = (await f.view(f.beta)).body.environments[0];
    if (final.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(final.step, 'Stopped'); assert.equal(final.status, 'failed'); assert.ok(final.cleanedAt);
});

test('live and persisted setup diagnostics redact a vendor secret printed before setup returns', {timeout: 10000}, async t => {
  const secret = 'whsec_fixture_generated_before_setup_return_123';
  let entered!: () => void, releaseSetup!: () => void, cleaning!: () => void, releaseCleanup!: () => void;
  const printed = new Promise<void>(resolve => { entered = resolve; }), setup = new Promise<void>(resolve => { releaseSetup = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { cleaning = resolve; }), cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  t.after(() => { releaseSetup(); releaseCleanup(); });
  // Keep the real Stripe service, twin runtime, files, manager and HTTP routes; only Docker's CLI is controlled.
  const twin = createTwinRuntime({isFree: async () => true, exec: async (_file, args, options) => {
    if (args.includes('--print-secret')) {
      options?.onOutput?.(secret.slice(0, 12), 'stdout'); options?.onOutput?.(secret.slice(12) + '\n', 'stdout'); entered();
      await setup; throw Object.assign(new Error('Listener setup failed.'), {stdout: secret + '\n'});
    }
    if (args[0] === 'ps') { cleaning(); await cleanup; }
    return {stdout: '', stderr: ''};
  }});
  const runtime = createEnvironmentRuntime({twin, inputs: async () => ({stripe: {secretKey: 'sk_test_neutral_fixture_key', publishableKey: 'pk_test_neutral_fixture_key'}})});
  const f = await controller(t, runtime), configured = plan();
  configured.services = {stripe: {webhook: '{{apps.web.url}}/webhook'}};
  await f.post('plan', f.beta, {plan: configured});
  const created = await f.post('create', f.beta), id = String(created.body.environment.id); await printed;
  const live = (await f.post('logs', f.beta, {id})).body.logs!;
  assert.doesNotMatch(live, /whsec_fixture/); assert.match(live, /\[REDACTED\]/);
  releaseSetup(); await cleanupStarted;
  const persisted = await readFile(join(f.dataDir, 'environments', id, 'twin', 'setup.log'), 'utf8');
  assert.doesNotMatch(persisted, /whsec_fixture/); assert.match(persisted, /\[REDACTED\]/);
  releaseCleanup();
  let final: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    final = (await f.view(f.beta)).body.environments[0]; if (final.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(final.status, 'failed');
  assert.doesNotMatch(JSON.stringify(final) + (await f.post('logs', f.beta, {id})).body.logs, /whsec_fixture/);
});

test('saved plans survive controller restart and the environment view exposes only environments and plan', async t => {
  const f = await controller(t);
  const edited = plan(); edited.apps.web.env.MODE = 'restart';
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 200);
  const before = (await f.view(f.beta)).body;
  assert.deepEqual(Object.keys(before).sort(), ['environments', 'plan']);
  const oldToken = f.token;
  await f.restart();
  assert.notEqual(f.token, oldToken);
  assert.equal((await f.request('/api/environments/plan', {method: 'POST', headers: {'X-Perpetual-Token': oldToken}, body: {repoPath: f.repos[0], stageId: f.beta, plan: plan()}})).status, 403);
  assert.deepEqual((await f.view(f.beta)).body, before);
  const state = (await f.request('/api/state')).body;
  assert.equal(state.scan.repo.path, f.repos[0]);
  assert.equal(Object.hasOwn(state, 'capabilities'), false, 'Environments are Compose twins, not a Cua sandbox: the state claims no sandbox capability.');
});

test('invalid plans and environment requests are rejected before any environment work', async t => {
  const f = await controller(t);
  const initial = (await f.view(f.beta)).body;
  for (const mutate of [
    input => { input.apps.web.port = 0; },
    input => { input.apps.web.directory = '../outside'; },
    input => { input.apps.web.env['A-B'] = 'value'; },
    input => { input.services.unknown = {}; },
    input => { input.services.mailpit.webhook = '{{apps.missing.url}}'; },
    // @ts-expect-error a pre-twin plan listed its services
    input => { input.services = [{id: 'web'}]; },
  ] satisfies ((input: Plan) => void)[]) {
    const invalid = plan(); mutate(invalid);
    assert.equal((await f.post('plan', f.beta, {plan: invalid})).status, 400);
  }
  assert.deepEqual((await f.view(f.beta)).body.plan, initial.plan);
  for (const operation of ['cancel', 'destroy', 'logs']) assert.equal((await f.post(operation, f.beta, {id: randomUUID()})).status, 400, operation);
  // Scripted scenarios, fixture Twins, run evidence and the desktop view no longer exist.
  for (const operation of ['analyze', 'cases', 'run', 'schedule', 'schedule/stop', 'reset', 'snapshot', 'state', 'not-an-operation']) {
    assert.equal((await f.post(operation, f.beta, {id: randomUUID()})).status, 404, operation);
  }
  for (const path of [`runs/${randomUUID()}`, `artifacts/${randomUUID()}/evidence.json`, 'desktop']) {
    assert.equal((await f.request(`/api/environments/${path}?${f.query(f.repos[0], f.beta)}`)).status, 404, path);
  }
  assert.equal((await f.post('plan', f.beta, {plan: {services: {mailpit: {}}}})).status, 200);
  const create = await f.post('create', f.beta);
  assert.equal(create.status, 400);
  assert.match(create.body.error!, /Add an app/);
  assert.deepEqual((await f.view(f.beta)).body.environments, []);
});

test('saved environments load without removed scenario, Twin and pre-twin plan state, stay scoped and never expose their plan', async t => {
  const f = await controller(t);
  const environmentId = randomUUID();
  const scope = createHash('sha256').update(`${f.repos[0]}\0${f.beta}`).digest('hex');
  const report = join(f.dataDir, 'environments', 'runs', randomUUID(), 'report.json');
  await mkdir(join(report, '..'), {recursive: true});
  await writeFile(report, JSON.stringify({results: []}));
  await f.restart(state => {
    state.plans[scope] = {...legacyPlan(), twins: [{id: 'mail', kind: 'mail'}]};
    state.environments.push({id: environmentId, scope, pipelineKey: f.repos[0], stageId: f.beta, repoPath: f.repos[0], status: 'failed', logs: 'Fixture preparation failed before Docker.',
      twinsToken: 'synthetic-secret-not-for-api', activeOperation: {operation: 'reset'}, desktopUrl: 'http://127.0.0.1:56080/', plan: {...legacyPlan(), twins: []}});
    Object.assign(state, {analyses: {[scope]: {mode: 'source'}}, cases: {[scope]: [{id: 'legacy-case'}]},
      runs: [{id: randomUUID(), scope, environmentId, status: 'running'}], schedules: [{id: randomUUID(), scope, environmentId, active: true}]});
  });
  const beta = (await f.view(f.beta)).body;
  assert.deepEqual(Object.keys(beta).sort(), ['environments', 'plan']);
  assert.deepEqual(beta.plan, detected, 'A pre-twin plan is replaced by a fresh detection.');
  assert.equal(beta.environments[0].id, environmentId);
  assert.equal(beta.environments[0].status, 'failed', 'A legacy active run does not change the environment.');
  for (const key of ['scope', 'plan', 'twinsToken', 'activeOperation', 'desktopUrl']) assert.equal(beta.environments[0][key], undefined, key);
  assert.ok(!JSON.stringify((await f.request('/api/state')).body).includes('synthetic-secret-not-for-api'));
  assert.deepEqual((await f.view(f.gamma)).body.environments, []);
  assert.equal((await f.post('logs', f.beta, {id: environmentId})).body.logs, 'Fixture preparation failed before Docker.');
  assert.equal((await f.post('logs', f.gamma, {id: environmentId})).status, 400);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'environments', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['detected', 'drafts', 'environments', 'plans', 'version']);
  assert.ok(!JSON.stringify(saved).includes('synthetic-secret-not-for-api'));
  assert.ok(!JSON.stringify(saved).includes('twins'));
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {results: []}, 'Saved run evidence stays on disk.');
});

test('a generated plan exposes its provenance, and only its stage’s Services say it is generated', async t => {
  const f = await controller(t);
  const services = (stageId: string) => f.request(`/api/twin/services?${f.query(f.repos[0], stageId)}`);
  assert.equal((await services(f.beta)).body.generated, false, 'A detected plan.');
  const scope = createHash('sha256').update(`${f.repos[0]}\0${f.beta}`).digest('hex');
  const provenance = {generatedAt: '2026-09-24T12:00:00.000Z', harness: 'opencode@1.18.32', model: 'openrouter/anthropic/claude-sonnet-5', attempts: 2};
  await f.restart(state => { state.plans[scope] = {...plan(), provenance}; delete state.detected?.[scope]; });
  assert.deepEqual((await f.view(f.beta)).body.plan, {...plan(), provenance});
  assert.equal((await services(f.beta)).body.generated, true);
  assert.equal((await services(f.gamma)).body.generated, false);
  // A person's save replaces it with their own config.
  assert.equal((await f.post('plan', f.beta, {plan: plan()})).status, 200);
  assert.deepEqual((await f.view(f.beta)).body.plan, plan());
  assert.equal((await services(f.beta)).body.generated, false);
});
