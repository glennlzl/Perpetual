import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { APP_PORT, detectEnvironmentConfig, snapshotKeeps, snapshotSource } from '../src/environments/plans.ts';
import { validateTwinConfig } from '../src/twin/index.ts';
import { scanRepository } from '../src/scanner.ts';

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perpetual-environment-plan-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = path.join(root, 'repo');
  await mkdir(repoPath);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoPath, name)), { recursive: true });
    await writeFile(path.join(repoPath, name), content);
  }
  return { root, repoPath };
}

const manifest = (name: string, dependencies: Record<string, string>, scripts: Record<string, string> = {}, extra: object = {}) => JSON.stringify({ name, dependencies, scripts, ...extra });
const detect = async (repoPath: string) => detectEnvironmentConfig(await scanRepository(repoPath));
// The fixture's git ignores only what its own .gitignore names.
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
  { cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const filesIn = async (directory: string) => (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();

test('detection proposes the Node.js major the repository asks for', async t => {
  const app = (extra: object = {}) => manifest('web', { express: '1.0.0' }, { start: 'node server.js' }, extra);
  const cases: [Record<string, string>, number][] = [
    [{ 'package.json': app({ engines: { node: '>=24' } }) }, 24],
    [{ 'package.json': app({ engines: { node: '^22.11.0 || ^24' } }) }, 24],
    // A range open above runs on the newest LTS, never on the end-of-life major it starts from.
    [{ 'package.json': app({ engines: { node: '>=18' } }) }, 24],
    // One above every LTS runs on the current release.
    [{ 'package.json': app({ engines: { node: '>24' } }) }, 26],
    [{ 'package.json': app({ engines: { node: '^22.11' } }) }, 22],
    [{ 'package.json': app({ volta: { node: '26.1.0' }, engines: { node: '>=20' } }) }, 26],
    [{ 'package.json': app({ devEngines: { runtime: { name: 'node', version: '^24.3' } } }) }, 24],
    [{ 'package.json': app({ engines: { node: '>=20' } }), '.nvmrc': 'v22.11.0\n' }, 22],
    [{ 'package.json': app(), '.node-version': '26\n' }, 26],
  ];
  for (const [files, node] of cases) {
    const { repoPath } = await fixture(t, files);
    assert.equal((await detect(repoPath)).node, node, JSON.stringify(files));
  }
  // Nothing to go by, or nothing a major can be read from, proposes none: the twin runs on the current LTS.
  const none: Record<string, string>[] = [{ 'package.json': app() }, { 'package.json': app({ engines: { node: '*' } }), '.nvmrc': 'lts/*\n' }];
  for (const files of none) {
    const { repoPath } = await fixture(t, files);
    assert.equal('node' in await detect(repoPath), false, JSON.stringify(files));
  }
});

test('detection proposes apps from the scan and services from paths, manifests and example variable names', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': manifest('web', { vite: '1.0.0' }, { dev: 'vite' }),
    'package-lock.json': '{}',
    'api/package.json': manifest('api', { express: '1.0.0', stripe: '1.0.0' }, { build: 'tsc', start: 'node dist/server.js' }),
    'supabase/config.toml': 'project_id = "fixture"\n',
    'worker/requirements.txt': 'pymongo==4.0  # documents\n-r base.txt\n',
    'tools/pyproject.toml': '[project]\nname = "tools"\ndescription = "uses redis"\ndependencies = [\n  "psycopg[binary]>=3", # database\n]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nlangchain_openai = "^0.1"\n',
    '.env.example': 'SMTP_HOST=mail.example\n',
    // Actual env files and installed packages are never evidence.
    '.env': 'REDIS_URL=redis://user:secret@host\n',
    'node_modules/ioredis/package.json': manifest('ioredis', { ioredis: '1.0.0' }),
  });
  const config = await detect(repoPath);
  // Supabase's local stack includes PostgreSQL, so psycopg adds no separate database.
  assert.deepEqual(Object.keys(config.services).sort(), ['llm', 'mailpit', 'mongodb', 'stripe', 'supabase']);
  assert.deepEqual(config.services.supabase, { directory: 'supabase' });
  // Both apps resolve to the root lockfile, so it installs once instead of in each build.
  assert.deepEqual(config.install, { directory: '.', command: 'npm ci' });
  assert.deepEqual(config.apps, {
    service: { directory: '.', start: `npm run dev -- --host 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-api': { directory: 'api', build: 'npm run build', start: 'npm run start', port: APP_PORT },
  });
  assert.deepEqual(validateTwinConfig(config).apps.service.env, {}, 'A detected config is a valid twin config.');
});

test('test, docs and tooling folders are not service evidence, so an example project never stands in for the product’s', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': manifest('web', { next: '1.0.0', '@supabase/supabase-js': '2.0.0' }, { dev: 'next dev' }),
    'supabase/config.toml': 'project_id = "acme"\n',
    'examples/demo/supabase/config.toml': 'project_id = "demo"\n',
    'examples/demo/.env.example': 'SMTP_HOST=mail.example\n',
    'test/fixtures/sample/package.json': manifest('sample', { mongoose: '8.0.0', ioredis: '5.0.0', stripe: '17.0.0' }),
    'docs/snippets/package.json': manifest('snippets', { nodemailer: '6.0.0' }),
    'src/billing.test.ts': 'import Stripe from "npm:stripe@17";\n',
  });
  assert.deepEqual((await detect(repoPath)).services, { supabase: { directory: 'supabase' } });
});

test('a test folder is the first folder of a scanned package or the repository, so an app route of that name is the product’s evidence', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': manifest('web', { next: '1.0.0' }, { dev: 'next dev' }),
    'app/tests/results/page.tsx': 'import Stripe from "https://esm.sh/stripe@17";\n',
    'tests/fixtures/package.json': manifest('fixture', { mongoose: '8.0.0' }),
    'e2e/package.json': manifest('e2e', { ioredis: '5.0.0' }),
    'src/lib/__mocks__/mail.ts': 'import nodemailer from "npm:nodemailer@6";\n',
  });
  assert.deepEqual(Object.keys((await detect(repoPath)).services), ['stripe']);
});

test('a package’s test folder is no service evidence whatever the package’s language, and neither are Supabase’s and Cypress’s test layouts', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': manifest('web', { next: '1.0.0' }, { dev: 'next dev' }),
    // A Python package the scan does not list: its own tests folder is a test's, as the generated config's evidence has it.
    'backend/pyproject.toml': '[project]\nname = "backend"\ndependencies = ["fastapi"]\n',
    'backend/tests/requirements.txt': 'pytest\nredis\n',
    // Supabase keeps its edge functions' tests beside them, and Cypress its own folder at the package's top.
    'supabase/config.toml': 'project_id = "acme"\n',
    'supabase/functions/tests/hello-world-test.ts': 'import Stripe from "npm:stripe@17";\n',
    'supabase/functions/tests/helpers.ts': 'import { MongoClient } from "npm:mongodb@6";\n',
    'cypress/e2e/login.cy.ts': 'import nodemailer from "npm:nodemailer@6";\n',
    'cypress/package.json': manifest('cypress-support', { ioredis: '5.0.0' }),
  });
  assert.deepEqual((await detect(repoPath)).services, { supabase: { directory: 'supabase' } });
});

test('Deno modules and import maps name their packages in specifiers, which detection reads like dependencies', async t => {
  const { repoPath } = await fixture(t, {
    'supabase/config.toml': 'project_id = "fixture"\n',
    'supabase/functions/billing/index.ts': 'import Stripe from "https://esm.sh/stripe@17?target=denonext";\nimport { Hono } from "jsr:@hono/hono";\n',
    'supabase/functions/mail/index.ts': "import { MongoClient } from 'npm:mongodb@6';\n",
    'worker/deno.json': JSON.stringify({ imports: { redis: 'npm:ioredis@5' } }),
  });
  const config = await detect(repoPath);
  assert.deepEqual(Object.keys(config.services).sort(), ['mongodb', 'redis', 'stripe', 'supabase']);
});

test('app commands install where the nearest lockfile is and skip packages without a safe launcher', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': JSON.stringify({ name: 'workspace', packageManager: 'pnpm@10.0.0', workspaces: ['apps/*'] }),
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'apps/site/package.json': manifest('site', { next: '1.0.0' }, { build: 'next build', start: 'next start' }),
    'apps/library/package.json': manifest('library', { next: '1.0.0' }, { build: 'next build' }),
    'apps/deployer/package.json': manifest('deployer', { express: '1.0.0' }, { dev: 'railway run node server.js' }),
    'apps/local/package.json': manifest('local', { vite: '1.0.0' }, { dev: 'vite' }),
    'apps/local/yarn.lock': '',
  });
  const config = await detect(repoPath);
  assert.equal(config.install, undefined, 'One app per lockfile keeps its install in its build.');
  assert.deepEqual(config.apps, {
    'service-apps-2flocal': { directory: 'apps/local', build: 'yarn install', start: `yarn run dev --host 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-apps-2fsite': { directory: 'apps/site', build: '(cd ../.. && pnpm install --frozen-lockfile) && pnpm run build', start: `pnpm run start --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
  });
  const declared = await fixture(t, { 'package.json': manifest('declared', { express: '1.0.0' }, { dev: 'node server.js' }, { packageManager: 'pnpm@9.0.0' }) });
  assert.deepEqual((await detect(declared.repoPath)).apps, { service: { directory: '.', build: 'pnpm install', start: 'pnpm run dev', port: APP_PORT } });
});

test('apps sharing a workspace lockfile install it once as the twin install', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': JSON.stringify({ name: 'workspace', packageManager: 'pnpm@10.0.0' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - tools/*\n',
    'apps/web/package.json': manifest('web', { next: '1.0.0' }, { build: 'next build', start: 'next start' }),
    'apps/api/package.json': manifest('api', { hono: '1.0.0' }, { dev: 'node --watch server.js' }),
    'apps/docs/package.json': manifest('docs', { vite: '1.0.0' }, { dev: 'vite' }),
    // Its own lockfile keeps its own install, beside the shared one.
    'tools/admin/package.json': manifest('admin', { express: '1.0.0' }, { start: 'node server.js' }),
    'tools/admin/package-lock.json': '{}',
  });
  const config = await detect(repoPath);
  assert.deepEqual(config.install, { directory: '.', command: 'pnpm install --frozen-lockfile' });
  assert.deepEqual(config.apps, {
    'service-apps-2fapi': { directory: 'apps/api', start: 'pnpm run dev', port: APP_PORT },
    'service-apps-2fdocs': { directory: 'apps/docs', start: `pnpm run dev --host 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-apps-2fweb': { directory: 'apps/web', build: 'pnpm run build', start: `pnpm run start --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-tools-2fadmin': { directory: 'tools/admin', build: 'npm ci', start: 'npm run start', port: APP_PORT },
  });
  assert.deepEqual(validateTwinConfig(config).install, config.install);
});

test('a script that reaches a cloud CLI falls back to the next script and is never run', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': JSON.stringify({ name: 'workspace', workspaces: ['apps/*'] }),
    'package-lock.json': '{}',
    'apps/pulled/package.json': manifest('pulled', { next: '1.0.0' }, { dev: 'vercel env pull .env.local && next dev', build: 'next build', start: 'next start' }),
    'apps/linked/package.json': manifest('linked', { express: '1.0.0' }, { dev: 'railway run node --watch server.js', start: 'node server.js' }),
    'apps/cloud/package.json': manifest('cloud', { hono: '1.0.0' }, { dev: 'railway run node server.js', start: 'netlify deploy --prod' }),
  });
  const config = await detect(repoPath);
  assert.deepEqual(config.install, { directory: '.', command: 'npm ci' });
  assert.deepEqual(config.apps, {
    'service-apps-2flinked': { directory: 'apps/linked', start: 'npm run start', port: APP_PORT },
    'service-apps-2fpulled': { directory: 'apps/pulled', build: 'npm run build', start: `npm run start -- --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
  });
  const unbuilt = await fixture(t, { 'package.json': manifest('web', { next: '1.0.0' }, { dev: 'vercel dev', build: 'vercel build && vercel deploy --prebuilt', start: 'next start' }) });
  assert.deepEqual((await detect(unbuilt.repoPath)).apps, {
    service: { directory: '.', build: 'npm install', start: `npm run start -- --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
  }, 'A build that reaches a cloud CLI is left out.');
});

test('a database migration, a release flag or a release folder in a script is no cloud launcher, but a publisher named with a hyphen is', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': JSON.stringify({ name: 'workspace', workspaces: ['apps/*'] }),
    'package-lock.json': '{}',
    'apps/api/package.json': manifest('api', { express: '1.0.0' }, { start: 'prisma migrate deploy && node dist/release/server.js' }),
    'apps/site/package.json': manifest('site', { next: '1.0.0' }, { build: 'prisma generate && prisma migrate deploy && next build', start: 'next start' }),
    'apps/tool/package.json': manifest('tool', { hono: '1.0.0' }, { dev: 'npm run deploy', start: 'node server.js --release --skip-deploy' }),
    // A build that publishes is left out, and a start script that deploys is no app.
    'apps/docs/package.json': manifest('docs', { next: '1.0.0' }, { build: 'next build && semantic-release', start: 'next start' }),
    'apps/admin/package.json': manifest('admin', { express: '1.0.0' }, { start: 'npm run build-and-deploy' }),
  });
  assert.deepEqual((await detect(repoPath)).apps, {
    'service-apps-2fapi': { directory: 'apps/api', start: 'npm run start', port: APP_PORT },
    'service-apps-2fdocs': { directory: 'apps/docs', start: `npm run start -- --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-apps-2fsite': { directory: 'apps/site', build: 'npm run build', start: `npm run start -- --hostname 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT },
    'service-apps-2ftool': { directory: 'apps/tool', start: 'npm run start', port: APP_PORT },
  });
});

test('a package without a web framework runs as an app only through its start script', async t => {
  const { repoPath } = await fixture(t, {
    'package.json': JSON.stringify({ name: 'workspace', workspaces: ['packages/*'] }),
    'packages/server/package.json': manifest('server', { pg: '1.0.0' }, { dev: 'node --watch server.js', start: 'node server.js' }),
    'packages/tool/package.json': manifest('tool', {}, { dev: 'tsc --watch', build: 'tsc' }),
  });
  assert.deepEqual((await detect(repoPath)).apps, {
    'service-packages-2fserver': { directory: 'packages/server', build: 'npm install', start: 'npm run start', port: APP_PORT },
  });
});

test('detection reads no linked file and no evidence outside the repository', async t => {
  const { root, repoPath } = await fixture(t, { 'package.json': manifest('web', { express: '1.0.0' }, { start: 'node server.js' }) });
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(root, 'outside', 'package.json'), manifest('outside', { stripe: '1.0.0' }));
  await writeFile(path.join(root, 'outside', '.env.example'), 'SMTP_HOST=outside\n');
  await symlink(path.join(root, 'outside'), path.join(repoPath, 'linked'));
  await mkdir(path.join(repoPath, 'api'));
  await symlink(path.join(root, 'outside', 'package.json'), path.join(repoPath, 'api', 'package.json'));
  await mkdir(path.join(repoPath, 'lib'));
  await writeFile(path.join(repoPath, 'lib', 'package.json'), '{');
  await writeFile(path.join(repoPath, 'requirements.txt'), 'x'.repeat(1_048_577));
  const config = await detect(repoPath);
  assert.deepEqual(config.services, {});
  assert.deepEqual(Object.keys(config.apps), ['service']);
});

test('a root manifest that does not parse is not evidence, and the scanned apps are still proposed', async t => {
  for (const root of ['﻿{"name":"workspace"}', '{"name":"workspace",}', '<<<<<<< HEAD\n{"name":"workspace"}\n=======\n{"name":"other"}\n>>>>>>> branch\n']) {
    const { repoPath } = await fixture(t, { 'package.json': root, 'apps/web/package.json': manifest('web', { express: '1.0.0' }, { start: 'node server.js' }) });
    assert.deepEqual((await detect(repoPath)).apps, { 'service-apps-2fweb': { directory: 'apps/web', build: 'npm install', start: 'npm run start', port: APP_PORT } }, JSON.stringify(root));
  }
});

test('a folder that cannot be read is left out of detection, and the snapshot names it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  // A database container's bind-mounted data, owned by its own user.
  const { root, repoPath } = await fixture(t, { 'package.json': manifest('web', { express: '1.0.0' }, { start: 'node server.js' }), 'pgdata/PG_VERSION': '16\n' });
  await chmod(path.join(repoPath, 'pgdata'), 0o000);
  try {
    assert.deepEqual(Object.keys((await detect(repoPath)).apps), ['service']);
    await assert.rejects(snapshotSource(repoPath, path.join(root, 'snapshot')), /^Error: The source folder pgdata cannot be read\. Make it readable, or move it out of the checkout or have git ignore it\.$/);
    // A checkout whose git ignores it never opens it.
    await writeFile(path.join(repoPath, '.gitignore'), 'pgdata/\n');
    await git(repoPath, 'init', '--quiet');
    await snapshotSource(repoPath, path.join(root, 'ignored'));
    assert.deepEqual(await filesIn(path.join(root, 'ignored')), ['.gitignore', 'package.json']);
  } finally { await chmod(path.join(repoPath, 'pgdata'), 0o700); }
});

test('a production launcher runs after its build and stays unbuilt in the source snapshot', async t => {
  const { root, repoPath } = await fixture(t, {
    'package.json': manifest('production', { vite: '1.0.0' }, { build: 'vite build', start: 'vite preview' }),
    'dist/index.html': 'existing host build output',
  });
  assert.deepEqual((await detect(repoPath)).apps.service, { directory: '.', build: 'npm install && npm run build', start: `npm run start -- --host 0.0.0.0 --port ${APP_PORT}`, port: APP_PORT });
  const snapshot = path.join(root, 'snapshot');
  await snapshotSource(repoPath, snapshot);
  await assert.rejects(readFile(path.join(snapshot, 'dist/index.html')), { code: 'ENOENT' });
});

test('source snapshot excludes credentials, caches, databases and links while preserving original files', async t => {
  const original = 'console.log("real application");\n';
  const { root, repoPath } = await fixture(t, {
    'src/app.mjs': original, 'package.json': '{}', '.env': 'SECRET=do-not-copy', '.env.test': 'SECRET=do-not-copy',
    '.npmrc': '//registry/:_authToken=do-not-copy', '.ssh/id_rsa': 'private', '.aws/credentials': 'private',
    '.vercel/project.json': 'private', 'state.sqlite': 'private', 'cert.pem': 'private', 'secret.json': 'private',
    'node_modules/dependency/index.js': 'cache', 'dist/app.js': 'cache',
  });
  // Its git metadata is never copied either.
  await git(repoPath, 'init', '--quiet');
  await writeFile(path.join(root, 'outside.txt'), 'outside-credential');
  await symlink(path.join(root, 'outside.txt'), path.join(repoPath, 'linked.txt'));
  await symlink(path.join(repoPath, 'src'), path.join(repoPath, 'linked-directory'));
  const destination = path.join(root, 'snapshot');
  const result = await snapshotSource(repoPath, destination);
  // The package manager's config is kept without its token.
  assert.deepEqual((await readdir(destination)).sort(), ['.npmrc', 'package.json', 'src']);
  assert.equal(await readFile(path.join(destination, '.npmrc'), 'utf8'), '');
  assert.deepEqual(await readdir(path.join(destination, 'src')), ['app.mjs']);
  assert.equal(await readFile(path.join(destination, 'src/app.mjs'), 'utf8'), original);
  assert.equal(result.files, 3);
  assert.equal(result.bytes, Buffer.byteLength(original) + 2);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal((await stat(path.join(destination, 'src/app.mjs'))).mode & 0o777, 0o600);
  const second = await snapshotSource(repoPath, path.join(root, 'snapshot-2'));
  assert.equal(second.hash, result.hash);
  await writeFile(path.join(destination, 'src/app.mjs'), 'changed only in snapshot');
  assert.equal(await readFile(path.join(repoPath, 'src/app.mjs'), 'utf8'), original);
  assert.equal(await readFile(path.join(repoPath, '.env'), 'utf8'), 'SECRET=do-not-copy');
  await writeFile(path.join(repoPath, 'src/app.mjs'), original + '// new revision\n');
  assert.notEqual((await snapshotSource(repoPath, path.join(root, 'snapshot-3'))).hash, result.hash);
});

test('source snapshot identity changes when only an executable bit changes', async t => {
  const { root, repoPath } = await fixture(t, { 'scripts/run.sh': '#!/bin/sh\nexit 0\n' });
  const script = path.join(repoPath, 'scripts/run.sh');
  await chmod(script, 0o644);
  const before = await snapshotSource(repoPath, path.join(root, 'snapshot-before'));
  await chmod(script, 0o755);
  const after = await snapshotSource(repoPath, path.join(root, 'snapshot-after'));
  assert.notEqual(after.hash, before.hash);
});

test('source snapshot identity changes when an empty directory is added', async t => {
  const { root, repoPath } = await fixture(t, { 'app.js': 'application' });
  const before = await snapshotSource(repoPath, path.join(root, 'snapshot-before'));
  await mkdir(path.join(repoPath, 'empty'));
  const after = await snapshotSource(repoPath, path.join(root, 'snapshot-after'));
  assert.notEqual(after.hash, before.hash);
});

test('package manager configs are copied at every depth with their settings and without their credentials', async t => {
  const credentials = ['fixture-npm-token', 'Zml4dHVyZTpmaXh0dXJl', 'fixture-yarn-token', 'fixture-berry-token', 'fixture-password', 'owner@example.test'];
  const files = {
    'package.json': '{}',
    '.npmrc': 'registry=https://registry.npmjs.org/\n@acme:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=fixture-npm-token\nnode-linker=hoisted\nshamefully-hoist=true\n',
    'packages/web/.npmrc': '//registry.npmjs.org/:_auth=Zml4dHVyZTpmaXh0dXJl\nemail=owner@example.test\nlegacy-peer-deps=true\n',
    'legacy/.yarnrc': '"//registry.yarnpkg.com/:_authToken" "fixture-yarn-token"\nyarn-offline-mirror "./offline-cache"\n',
    '.yarnrc.yml': 'nodeLinker: node-modules\nnpmScopes:\n  acme:\n    npmRegistryServer: "https://npm.pkg.github.com"\n    npmAuthToken: fixture-berry-token\nnpmRegistryServer: "https://fixture:fixture-password@registry.example.test"\nyarnPath: .yarn/releases/yarn-4.5.0.cjs\n',
  };
  const { root, repoPath } = await fixture(t, files);
  const destination = path.join(root, 'snapshot');
  await snapshotSource(repoPath, destination);
  assert.deepEqual(await filesIn(destination), ['.npmrc', '.yarnrc.yml', 'legacy/.yarnrc', 'package.json', 'packages/web/.npmrc']);
  assert.equal(await readFile(path.join(destination, '.npmrc'), 'utf8'), 'registry=https://registry.npmjs.org/\n@acme:registry=https://npm.pkg.github.com/\nnode-linker=hoisted\nshamefully-hoist=true\n');
  assert.equal(await readFile(path.join(destination, 'packages/web/.npmrc'), 'utf8'), 'legacy-peer-deps=true\n');
  assert.equal(await readFile(path.join(destination, 'legacy/.yarnrc'), 'utf8'), 'yarn-offline-mirror "./offline-cache"\n');
  assert.equal(await readFile(path.join(destination, '.yarnrc.yml'), 'utf8'), 'nodeLinker: node-modules\nnpmScopes:\n  acme:\n    npmRegistryServer: "https://npm.pkg.github.com"\nyarnPath: .yarn/releases/yarn-4.5.0.cjs\n');
  for (const name of await filesIn(destination)) {
    const copied = await readFile(path.join(destination, name), 'utf8');
    for (const credential of credentials) assert.ok(!copied.includes(credential), `${name} keeps ${credential}`);
  }
  // The checkout keeps its files, and the gate's checkout check counts the configs, which the snapshot copies.
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(repoPath, name), 'utf8'), content);
  assert.deepEqual(Object.keys(files).filter(snapshotKeeps), Object.keys(files));
  // A config without a credential is copied byte for byte, and a credential alone does not change the snapshot.
  const plain = await fixture(t, { '.npmrc': 'legacy-peer-deps=true\n', 'app.mjs': 'export {};\n' });
  const token = await fixture(t, { '.npmrc': 'legacy-peer-deps=true\n//registry.npmjs.org/:_authToken=fixture-npm-token\n', 'app.mjs': 'export {};\n' });
  const [one, other] = [await snapshotSource(plain.repoPath, path.join(plain.root, 'snapshot')), await snapshotSource(token.repoPath, path.join(token.root, 'snapshot'))];
  assert.equal(await readFile(path.join(plain.root, 'snapshot', '.npmrc'), 'utf8'), 'legacy-peer-deps=true\n');
  assert.deepEqual([other.hash, other.bytes], [one.hash, one.bytes]);
});

test('a package manager’s config over 128 KB is left out of the snapshot, and a line over 4 KB is removed from one', async t => {
  const { root, repoPath } = await fixture(t, {
    'package.json': '{}',
    '.npmrc': `legacy-peer-deps=true\nca="${'A'.repeat(5000)}"\n`,
    'packages/web/.yarnrc.yml': `nodeLinker: node-modules\n# ${'x'.repeat(128 * 1024)}\n`,
  });
  const destination = path.join(root, 'snapshot');
  const result = await snapshotSource(repoPath, destination);
  assert.deepEqual(await filesIn(destination), ['.npmrc', 'package.json']);
  assert.equal(await readFile(path.join(destination, '.npmrc'), 'utf8'), 'legacy-peer-deps=true\n');
  assert.deepEqual([result.files, result.bytes], [2, Buffer.byteLength('legacy-peer-deps=true\n') + 2]);
});

test('a git checkout’s snapshot leaves out the local files git ignores, whatever their names', async t => {
  const committed = { '.gitignore': '.envrc\n.dev.vars\nterraform.tfstate\nlocal-dump/\n*.log\n', 'package.json': '{}', 'src/app.mjs': 'export const app = true;\n' };
  const { root, repoPath } = await fixture(t, {
    ...committed,
    '.envrc': 'export TWILIO_AUTH=fixture-local-value\n', '.dev.vars': 'SENDGRID_KEY=fixture-local-value\n', 'terraform.tfstate': '{"resources":[]}\n',
    'local-dump/customers.csv': 'email\njane@example.test\n', 'src/debug.log': 'local output\n',
    // A new file git would commit is source, as the gate's checkout check counts it.
    'src/draft.mjs': 'export const draft = true;\n',
  });
  await git(repoPath, 'init', '--quiet');
  await git(repoPath, 'add', '--', ...Object.keys(committed));
  await git(repoPath, 'commit', '--quiet', '-m', 'fixture');
  const destination = path.join(root, 'snapshot');
  const result = await snapshotSource(repoPath, destination);
  assert.deepEqual(await filesIn(destination), ['.gitignore', 'package.json', 'src/app.mjs', 'src/draft.mjs']);
  assert.equal(result.files, 4);
  // Without git metadata nothing says what is local, so the same files are copied but for the names the snapshot never takes.
  await rm(path.join(repoPath, '.git'), { recursive: true });
  await snapshotSource(repoPath, path.join(root, 'walked'));
  assert.deepEqual(await filesIn(path.join(root, 'walked')), ['.dev.vars', '.envrc', '.gitignore', 'local-dump/customers.csv', 'package.json', 'src/app.mjs', 'src/debug.log', 'src/draft.mjs', 'terraform.tfstate']);
});

test('the snapshot leaves out what each repository inside the checkout ignores, and stops when git cannot list it', async t => {
  const { root, repoPath } = await fixture(t, {
    'package.json': '{}',
    'vendor/lib/.gitignore': '.envrc\nout/\n', 'vendor/lib/.envrc': 'export TWILIO_AUTH=fixture-local-value\n', 'vendor/lib/out/report.txt': 'local output\n', 'vendor/lib/index.js': 'export {};\n',
    'vendor/linked/.gitignore': '.dev.vars\n', 'vendor/linked/.dev.vars': 'SENDGRID_KEY=fixture-local-value\n', 'vendor/linked/index.js': 'export {};\n',
  });
  await git(repoPath, 'init', '--quiet');
  // A nested repository keeps its metadata in a .git folder; a submodule, like a repository whose metadata is elsewhere, in a .git file.
  await git(path.join(repoPath, 'vendor/lib'), 'init', '--quiet');
  await git(path.join(repoPath, 'vendor/linked'), 'init', '--quiet', '--separate-git-dir', path.join(root, 'linked.git'));
  await snapshotSource(repoPath, path.join(root, 'snapshot'));
  assert.deepEqual(await filesIn(path.join(root, 'snapshot')), ['package.json', 'vendor/lib/.gitignore', 'vendor/lib/index.js', 'vendor/linked/.gitignore', 'vendor/linked/index.js']);
  // Git that cannot list them, for a repository moved away from its metadata or a broken index, would copy every file it ignores.
  await writeFile(path.join(repoPath, 'vendor/linked/.git'), `gitdir: ${path.join(root, 'moved.git')}\n`);
  await assert.rejects(snapshotSource(repoPath, path.join(root, 'moved')), /^Error: Git could not list the ignored files in the source folder vendor\/linked: it exited with status 128\. Check that git status works there\.$/);
  await writeFile(path.join(repoPath, '.git', 'index'), 'not an index');
  await assert.rejects(snapshotSource(repoPath, path.join(root, 'broken')), /^Error: Git could not list the ignored files in the source folder \.: it exited with status 128\. Check that git status works there\.$/);
});

test('source snapshot excludes local agent configuration and instructions at every depth', async t => {
  const localOnly = 'synthetic local agent data';
  const excluded = [
    '.codex/config.toml', '.agents/settings.json', '.claude/settings.local.json',
    'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md',
    'src/.codex/config.toml', 'src/.agents/settings.json', 'src/.claude/settings.local.json',
    'src/agents.md', 'src/AGENTS.override.md', 'src/claude.md', 'src/CLAUDE.local.md',
  ];
  const application = 'console.log("real application");\n';
  const { root, repoPath } = await fixture(t, {
    'src/app.mjs': application, 'package.json': '{}', 'README.md': 'Application documentation',
    ...Object.fromEntries(excluded.map(name => [name, localOnly])),
  });
  const destination = path.join(root, 'snapshot');
  const result = await snapshotSource(repoPath, destination);
  assert.deepEqual((await readdir(destination, { recursive: true })).sort(), ['README.md', 'package.json', 'src', 'src/app.mjs']);
  assert.equal(await readFile(path.join(destination, 'src/app.mjs'), 'utf8'), application);
  assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), 'Application documentation');
  assert.equal(result.files, 3);
  for (const name of excluded) assert.equal(await readFile(path.join(repoPath, name), 'utf8'), localOnly, name);
});

test('source snapshot preserves credential-named modules and build routes inside application source', async t => {
  const modules = ['credentials.js', 'credentials.ts', 'secrets.tsx', 'secret.jsx', 'secrets.mjs', 'credentials.cjs', 'credentials.mts', 'secrets.cts', 'credentials.py', 'secrets.pyi'];
  const protectedFiles = ['credentials.json', 'secrets.yaml', 'secret.env', 'src/credentials.json', 'src/secrets.env', 'src/.env.ts', 'src/private.key'];
  const typedApp = 'import { marker } from "./credentials.ts"; export { marker };\n';
  const { root, repoPath } = await fixture(t, {
    'package.json': '{"type":"module"}',
    'src/app.ts': typedApp,
    'src/app.mjs': 'import { marker } from "./credentials.js"; import route from "./routes/build/route.mjs"; export default marker + route;',
    ...Object.fromEntries(modules.map(name => [`src/${name}`, 'export const marker = "application";'])),
    'src/routes/build/route.mjs': 'export default " route";',
    'frontend/src/routes/dist/route.ts': 'export const route = "dist source route";',
    'frontend/src/routes/coverage/route.ts': 'export const route = "coverage source route";',
    ...Object.fromEntries(protectedFiles.map(name => [name, 'synthetic private configuration'])),
    'build/generated.js': 'output', 'frontend/dist/generated.js': 'output', 'coverage/report.json': 'output',
  });
  const destination = path.join(root, 'snapshot');
  await snapshotSource(repoPath, destination);
  assert.equal((await import(pathToFileURL(path.join(destination, 'src/app.mjs')).href)).default, 'application route');
  assert.equal(await readFile(path.join(destination, 'src/app.ts'), 'utf8'), typedApp);
  for (const name of modules) assert.equal(await readFile(path.join(destination, 'src', name), 'utf8'), 'export const marker = "application";', name);
  for (const name of ['frontend/src/routes/dist/route.ts', 'frontend/src/routes/coverage/route.ts']) assert.match(await readFile(path.join(destination, name), 'utf8'), /source route/);
  for (const name of [...protectedFiles, 'build/generated.js', 'frontend/dist/generated.js', 'coverage/report.json']) await assert.rejects(readFile(path.join(destination, name)), { code: 'ENOENT' }, name);
});

test('the snapshot leaves out build output folders but keeps files named build, dist or coverage, as snapshotKeeps says', async t => {
  const files = { 'package.json': '{}', 'script/build': '#!/bin/sh\nnpm run compile\n', 'tools/dist': 'release notes\n', 'coverage': 'thresholds\n',
    'build/generated.js': 'output', 'packages/ui/dist/index.js': 'output' };
  const { root, repoPath } = await fixture(t, files);
  const destination = path.join(root, 'snapshot');
  await snapshotSource(repoPath, destination);
  const kept = await filesIn(destination);
  assert.deepEqual(kept, ['coverage', 'package.json', 'script/build', 'tools/dist']);
  assert.deepEqual(Object.keys(files).filter(snapshotKeeps).sort(), kept, 'The gate’s checkout check counts the files the snapshot copies.');
});

test('snapshot refuses ordinary in-repository destinations and oversized files', async t => {
  const { root, repoPath } = await fixture(t, { 'app.mjs': 'application' });
  await assert.rejects(snapshotSource(repoPath, path.join(repoPath, 'copy')), /outside the source/);
  await assert.rejects(snapshotSource(repoPath, path.join(repoPath, '.git', 'snapshot')), /outside the source/);
  assert.deepEqual(await readdir(repoPath), ['app.mjs']);
  const handle = await open(path.join(repoPath, 'large.bin'), 'w');
  await handle.truncate(32 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(snapshotSource(repoPath, path.join(root, 'copy')), /too large: large.bin/);
  assert.equal(await readFile(path.join(repoPath, 'app.mjs'), 'utf8'), 'application');
});

test('snapshot rejects a destination symlink instead of writing through it', async t => {
  const { root, repoPath } = await fixture(t, { 'app.mjs': 'application' });
  const outside = path.join(root, 'unrelated');
  await mkdir(outside);
  await symlink(outside, path.join(root, 'linked-copy'));
  await assert.rejects(snapshotSource(repoPath, path.join(root, 'linked-copy')), /symbolic link|snapshot destination/i);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(snapshotSource(repoPath, path.join(root, 'linked-copy', 'nested')), /symbolic link|snapshot destination/i);
  assert.deepEqual(await readdir(outside), []);
});

test('snapshots may use dedicated .perpetual storage without recursively copying that storage', async t => {
  const { repoPath } = await fixture(t, { 'app.mjs': 'application', '.perpetual/old/private.txt': 'previous snapshot' });
  const snapshot = await snapshotSource(repoPath, path.join(repoPath, '.perpetual', 'new'));
  assert.equal(snapshot.files, 1);
  assert.deepEqual(await readdir(path.join(repoPath, '.perpetual', 'new')), ['app.mjs']);
  assert.equal(await readFile(path.join(repoPath, 'app.mjs'), 'utf8'), 'application');
  assert.equal(await readFile(path.join(repoPath, '.perpetual/old/private.txt'), 'utf8'), 'previous snapshot');
});
