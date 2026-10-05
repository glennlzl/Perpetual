import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { detectEnvironmentConfig } from '../src/environments/plans.ts';
import { createEnvironmentRuntime } from '../src/environments/runtime.ts';
import { scanRepository } from '../src/scanner.ts';
import { repositoryCache } from '../src/twin/compose.ts';
import type { DetectedConfig } from '../src/twin/detect.ts';

type Environment = { id: string; sandboxId?: string; plan?: DetectedConfig; pipelineKey?: string };

const exec = promisify(execFile);
// Opt-in: starts one disposable Compose project, perpetual-smoke-*, on the local Docker engine.
const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.';

// The app reaches Mailpit through the address the twin gives it, from inside its own container.
const SERVER = `import { createServer } from 'node:http';
createServer(async (request, response) => {
  const mail = await fetch(process.env.MAILPIT_URL + '/api/v1/info').then(reply => reply.status, error => error.message);
  console.log('request', request.url);
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ smtp: process.env.SMTP_HOST + ':' + process.env.SMTP_PORT, mail }));
}).listen(Number(process.env.PORT), '0.0.0.0');
`;

test('a Beta environment runs its app and Mailpit as a Compose twin, then removes them', { skip, timeout: 300000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-smoke-')));
  const id = `smoke-${randomBytes(4).toString('hex')}`, repoPath = join(dataDir, 'repo'), directory = join(dataDir, 'environments', id);
  const runtime = createEnvironmentRuntime();
  const environment: Environment = { id, plan: { services: { mailpit: {} }, apps: { web: { directory: '.', start: 'node server.mjs', port: 3000 } } } };
  const project = () => exec('docker', ['ps', '--all', '--quiet', '--filter', `label=perpetual.environment=${id}`]).then(({ stdout }) => stdout.trim());
  const volumes = () => exec('docker', ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=perpetual-${id}`]).then(({ stdout }) => stdout.trim().split('\n').filter(Boolean));
  t.after(async () => {
    try { if (environment.sandboxId) await runtime.destroySandbox({ dataDir, environment }); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  await mkdir(repoPath); await mkdir(directory, { recursive: true });
  await writeFile(join(repoPath, 'server.mjs'), SERVER);

  const steps: string[] = [];
  const ready = await runtime.prepareEnvironment({ dataDir, environment, repoPath, directory, cancelled: () => false,
    onUpdate: async update => { Object.assign(environment, update); if (update.step) steps.push(update.step); } });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.services, [{ id: 'mailpit', title: 'Mailpit', fidelity: 'actual', status: 'ready', missing: [] }]);
  assert.deepEqual(steps, ['Copying source', 'Preparing twin', 'Setting up Mailpit', 'Loading source', 'Starting twin', 'Checking apps']);
  const url = new URL(ready.apps[0].url);
  assert.equal(url.hostname, '127.0.0.1');
  const reply = await (await fetch(new URL('/journey', url))).json();
  assert.match(reply.smtp, /^host\.docker\.internal:\d+$/);
  assert.equal(reply.mail, 200, 'The app reached Mailpit through its twin address.');
  assert.deepEqual(await runtime.environmentHealth({ dataDir, environment }), { status: 'ready' });
  assert.match(await runtime.environmentLogs({ dataDir, environment }), /request \/journey/);
  // Built for no repository, the twin's package cache is its own, a volume of its project beside its workspace.
  assert.ok((await volumes()).includes(`perpetual-${id}_package-cache`));

  assert.notEqual(await project(), '');
  await runtime.destroySandbox({ dataDir, environment });
  delete environment.sandboxId;
  assert.equal(await project(), '', 'Deletion removes every container of the twin.');
  assert.deepEqual(await volumes(), [], 'Deletion removes the twin\'s own package cache with its workspace.');
});

// Two npm workspace apps share the root package-lock.json; each reports whether the shared install ran.
const WORKSPACE_SERVER = `import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ app: process.env.npm_package_name, installed: existsSync('../../node_modules/.package-lock.json'),
    linked: ['api', 'web'].every(name => existsSync(\`../../node_modules/\${name}/package.json\`)) }));
}).listen(Number(process.env.PORT), '0.0.0.0');
`;
const WORKSPACE = {
  'package.json': { name: 'smoke', private: true, workspaces: ['apps/*'] },
  'package-lock.json': { name: 'smoke', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'smoke', workspaces: ['apps/*'] }, 'apps/api': { version: '1.0.0' }, 'apps/web': { version: '1.0.0' },
    'node_modules/api': { resolved: 'apps/api', link: true }, 'node_modules/web': { resolved: 'apps/web', link: true } } },
  'apps/api/package.json': { name: 'api', version: '1.0.0', scripts: { start: 'node server.mjs' } },
  'apps/web/package.json': { name: 'web', version: '1.0.0', scripts: { start: 'node server.mjs' } },
  'apps/api/server.mjs': WORKSPACE_SERVER,
  'apps/web/server.mjs': WORKSPACE_SERVER,
};

test('apps sharing a workspace lockfile start after one shared install in a Compose twin', { skip, timeout: 300000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-smoke-')));
  const id = `smoke-${randomBytes(4).toString('hex')}`, repoPath = join(dataDir, 'repo'), directory = join(dataDir, 'environments', id);
  const runtime = createEnvironmentRuntime();
  const containers = () => exec('docker', ['ps', '--all', '--quiet', '--filter', `label=perpetual.environment=${id}`]).then(({ stdout }) => stdout.trim());
  // A repository no other twin builds, so the package cache its twins share is this test's to remove.
  const pipelineKey = `local:${dataDir}`, environment: Environment = { id, pipelineKey }, cache = repositoryCache(pipelineKey);
  t.after(async () => {
    try { if (environment.sandboxId) await runtime.destroySandbox({ dataDir, environment }); }
    finally { await exec('docker', ['volume', 'rm', '--force', cache]).catch(() => {}); await rm(dataDir, { recursive: true, force: true }); }
  });
  for (const [name, content] of Object.entries(WORKSPACE)) {
    await mkdir(dirname(join(repoPath, name)), { recursive: true });
    await writeFile(join(repoPath, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  await mkdir(directory, { recursive: true });

  environment.plan = await detectEnvironmentConfig(await scanRepository(repoPath));
  assert.deepEqual(environment.plan.install, { directory: '.', command: 'npm ci' });
  assert.deepEqual(Object.values(environment.plan.apps).map(app => [app.directory, app.build]), [['apps/api', undefined], ['apps/web', undefined]]);

  const steps: string[] = [];
  const ready = await runtime.prepareEnvironment({ dataDir, environment, repoPath, directory, cancelled: () => false,
    onUpdate: async update => { Object.assign(environment, update); if (update.step) steps.push(update.step); } });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(steps, ['Copying source', 'Preparing twin', 'Loading source', 'Installing dependencies', 'Starting twin', 'Checking apps']);
  const file = YAML.parse(await readFile(join(dataDir, 'environments', id, 'twin', 'compose.yaml'), 'utf8'));
  assert.deepEqual(file.services.install.profiles, ['install']);
  for (const app of Object.keys(environment.plan.apps)) assert.equal(file.services[app].command.join(' ').includes('npm ci'), false, app);
  const replies = await Promise.all(ready.apps.map(async app => (await fetch(app.url)).json()));
  assert.deepEqual(replies, [{ app: 'api', installed: true, linked: true }, { app: 'web', installed: true, linked: true }]);
  assert.deepEqual(await runtime.environmentHealth({ dataDir, environment }), { status: 'ready' });

  await runtime.destroySandbox({ dataDir, environment });
  delete environment.sandboxId;
  assert.equal(await containers(), '', 'Deletion removes every container of the twin.');
  assert.equal((await exec('docker', ['volume', 'inspect', '--format', '{{.Name}}', cache])).stdout.trim(), cache, 'Deletion keeps the repository\'s package cache for its next twin.');
});
