import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { scanRepository, createPreviewPlan } from '../src/scanner.ts';

// The generated starter as the tests read it back.
type StarterStep = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; 'working-directory'?: string };
type Starter = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { steps: StarterStep[] }> };
const starter = (workflow: string | undefined) => parse(workflow!) as Starter;

async function fixture(t: TestContext, files: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'perpetual-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

test('discovers existing monorepo CI and provider clues without claiming authenticated deployments', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'example', private: true, packageManager: 'pnpm@10.33.0' },
    'pnpm-workspace.yaml': 'packages:\n  - frontend\n  - backend/api\n  - packages/*\n',
    'frontend/package.json': { name: 'frontend', scripts: { build: 'next build', test: 'vitest run' }, dependencies: { next: '16', '@supabase/ssr': '1' } },
    'backend/api/package.json': { name: 'api', scripts: { build: 'tsc', test: 'vitest run' }, dependencies: { hono: '4', '@langchain/langgraph': '1', '@composio/core': '1' } },
    'railway.toml': '[build]\nbuilder = "dockerfile"\ndockerfilePath = "backend/api/Dockerfile"\n[deploy]\nhealthcheckPath = "/health"\n',
    'backend/api/Dockerfile': 'FROM node:22-alpine\nCOPY . /app\n',
    '.github/workflows/ci.yml': 'name: Checks\non:\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm test }]\n  gate:\n    needs: test\n    runs-on: ubuntu-latest\n',
    '.github/workflows/aliases.yml': 'name: Vercel preview aliases\non: push\njobs:\n  aliases:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/vercel-point-git-preview-aliases.mjs\n',
    'scripts/vercel-point-git-preview-aliases.mjs': 'const PROJECTS = [{name:"primary",id:"prj_one",previewAlias:"one.vercel.app"},{name:"secondary",id:"prj_two",previewAlias:"two.vercel.app"}];\n',
  });
  const scan = await scanRepository(root);
  assert.equal(scan.repo.name, 'example');
  assert.deepEqual(scan.workflows.find(w => w.name === 'Checks')!.triggers, ['pull_request']);
  assert.deepEqual(scan.workflows.find(w => w.name === 'Checks')!.jobs.find(j => j.id === 'gate')!.needs, ['test']);
  assert.equal(scan.services.find(s => s.path === 'frontend')!.framework, 'Next.js');
  assert.equal(scan.services.find(s => s.path === 'backend/api')!.provider, 'Railway');
  assert.equal(scan.nodes.filter(n => n.provider === 'Vercel' && n.kind === 'deployment').length, 1);
  assert.ok(scan.nodes.filter(n => n.provider === 'Vercel').every(n => !n.previewAlias && !n.deployBranches), 'custom JavaScript does not establish project or deployed-branch identity');
  assert.ok(scan.nodes.some(n => n.label === 'LangGraph'));
  assert.ok(scan.nodes.some(n => n.label === 'Composio'));
  assert.ok(scan.edges.some(e => e.label.includes('API') && e.confidence === 'inferred'));
  assert.ok(scan.edges.some(e => e.label === 'needs'));
  assert.ok(scan.nodes.every(n => ['configured', 'inferred'].includes(n.status)));
  assert.ok(scan.nodes.every(n => n.evidence.length > 0));
  assert.equal(scan.plan.workflow, undefined, 'must reuse existing CI rather than generate a competing workflow');
  assert.ok(scan.warnings.some(w => /health.*business|business.*health/i.test(w)));
  const plan = createPreviewPlan(scan, 'beta');
  assert.match(plan.title, /beta/i);
  assert.ok(plan.steps.some(s => /existing|reuse/i.test(s)));
  assert.ok(plan.steps.some(s => /credentials|connect|authoriz/i.test(s)));
});

test('deployment configuration in a directory without a package manifest is a Production target', async t => {
  // A Next.js frontend on Vercel, and a Python API and a worker each deployed from their own directory.
  const root = await fixture(t, {
    'frontend/package.json': { name: 'web', scripts: { build: 'next build' }, dependencies: { next: '16' } },
    'frontend/vercel.json': { framework: 'nextjs' },
    'backend/railway.toml': '[build]\nbuilder = "dockerfile"\ndockerfilePath = "Dockerfile"\n',
    'backend/Dockerfile': 'FROM python:3.13-slim\nCOPY . /app\n',
    'backend/requirements.txt': 'fastapi\n',
    'worker/vercel.json': {},
  });
  const scan = await scanRepository(root);
  assert.deepEqual(scan.nodes.filter(node => node.kind === 'deployment').map(node => [node.provider, node.label, node.evidence.map(item => item.file)]), [
    ['Railway', 'backend deployment', ['backend/railway.toml', 'backend/Dockerfile']],
    ['Vercel', 'web deployment', ['frontend/vercel.json']],
    ['Vercel', 'worker deployment', ['worker/vercel.json']],
  ]);
  assert.deepEqual(scan.delivery.production.map(entry => 'deployments' in entry ? [entry.provider, entry.deployments.length] : entry.id), [['Railway', 1], ['Vercel', 2]]);
  assert.deepEqual(scan.services.map(service => service.path), ['frontend'], 'a deployment directory is not promoted to a service');
});

test('a scanned subdirectory keeps the workflows GitHub reads at the repository top level', async t => {
  const root = await fixture(t, {
    'apps/web/package.json': { name: 'web', scripts: { build: 'next build' }, dependencies: { next: '16' } },
    '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm ci }]\n',
    '.github/workflows/deploy.yml': 'name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: [{ run: npx vercel deploy --prod }]\n',
    'apps/web/.github/workflows/ignored.yml': 'name: Ignored\non: push\njobs:\n  nothing:\n    runs-on: ubuntu-latest\n',
  });
  execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
  const scan = await scanRepository(path.join(root, 'apps/web'));
  assert.deepEqual(scan.workflows.map(workflow => [workflow.file, workflow.jobs.map(job => job.id)]), [['.github/workflows/ci.yml', ['build']], ['.github/workflows/deploy.yml', ['deploy']]]);
  assert.equal(scan.plan.workflow, undefined, 'must reuse existing CI rather than generate a competing workflow');
  assert.deepEqual(scan.nodes.filter(node => node.kind === 'deployment').map(node => [node.provider, node.evidence.map(item => item.file)]), [['Vercel', ['.github/workflows/deploy.yml']]]);
  assert.deepEqual(scan.delivery.build.map(entry => entry.label), ['GitHub Actions']);
});

test('proposes a bounded starter using detected pnpm workspace rather than fabricated commands', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'workspace', packageManager: 'pnpm@10.33.0' },
    'pnpm-workspace.yaml': 'packages: [apps/*]\n',
    'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    'apps/web/package.json': { name: 'web', scripts: { build: 'next build', test: 'vitest run' }, dependencies: { next: '16' } },
  });
  const scan = await scanRepository(root);
  const workflow = starter(scan.plan.workflow);
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = Object.values(workflow.jobs).flatMap(j => j.steps);
  assert.ok(steps.some(s => s.uses?.startsWith('pnpm/action-setup@')));
  assert.ok(steps.some(s => /pnpm install --frozen-lockfile/.test(s.run || '')));
  assert.ok(steps.some(s => /pnpm.*build/.test(s.run || '')));
  assert.ok(steps.some(s => /pnpm.*test/.test(s.run || '')));
  assert.ok(!steps.some(s => /deploy|publish|lint|--prod/.test(s.run || '')));
  assert.ok(!scan.plan.workflow!.includes('secrets.'));
  assert.equal(createPreviewPlan(scan).workflow, scan.plan.workflow);
  assert.equal((await readdir(root)).includes('.github'), false, 'a proposed workflow must not be written to the scanned repository');
});

test('uses npm without requiring a nonexistent lockfile or inventing missing checks', async t => {
  const root = await fixture(t, { 'package.json': { name: 'single', scripts: { test: 'node --test' } } });
  const scan = await scanRepository(root);
  const workflow = starter(scan.plan.workflow);
  const runs = Object.values(workflow.jobs).flatMap(j => j.steps).map(s => s.run).filter((run): run is string => Boolean(run));
  assert.ok(runs.some(r => r.startsWith('npm install')));
  assert.ok(runs.some(r => /npm run test/.test(r)));
  assert.ok(!runs.some(r => /npm ci|build|lint/.test(r)));
});

test('does not follow symlinks, inspect ignored trees, leak script secrets, or execute repository scripts', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'safe', scripts: { build: 'TOKEN=private-test-value node -e "require(\'fs\').writeFileSync(\'EXECUTED\',\'bad\')"' } },
    '.env.local': 'DO_NOT_LEAK=environment-secret-value',
    'node_modules/hidden/package.json': { name: 'forbidden-node-module' },
    '.git/hooks/package.json': { name: 'forbidden-git-hook' },
    'a/b/c/d/e/package.json': { name: 'too-deep' },
  });
  const outside = await fixture(t, { 'package.json': { name: 'forbidden-symlink' } });
  await symlink(outside, path.join(root, 'linked'), 'dir');
  await mkdir(path.join(root, 'apps'), { recursive: true });
  await symlink(path.join(outside, 'package.json'), path.join(root, 'apps/package.json'));
  const before = await readFile(path.join(root, 'package.json'), 'utf8');
  const scan = await scanRepository(root);
  const result = JSON.stringify(scan);
  assert.equal(scan.services.length, 1);
  assert.doesNotMatch(result, /private-test-value|environment-secret-value|forbidden|too-deep/);
  assert.deepEqual(scan.services[0].commands, { build: 'npm run build' });
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
  assert.equal((await readdir(root)).includes('EXECUTED'), false);
  await assert.rejects(scanRepository(path.join(root, 'linked')), /symlink/i);
});

test('keeps partial evidence when a manifest or workflow is malformed', async t => {
  const root = await fixture(t, {
    'package.json': '{broken json',
    'apps/api/package.json': { name: 'api', dependencies: { hono: '4' } },
    '.github/workflows/bad.yaml': 'jobs: [not: valid',
  });
  const scan = await scanRepository(root);
  assert.equal(scan.services.length, 1);
  assert.ok(scan.warnings.some(w => w.includes('package.json')));
  assert.ok(scan.warnings.some(w => w.includes('bad.yaml')));
  assert.equal(scan.plan.workflow, undefined, 'malformed existing workflow is not permission to replace it');
});

test('returns read-only git identity without remote credentials', async t => {
  const root = await fixture(t, { 'package.json': { name: 'git-example' } });
  execFileSync('git', ['init', '--initial-branch=feature/demo', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'remote.origin.url', 'https://someone:credential-do-not-output@github.com/org/repo.git?token=hidden']);
  const scan = await scanRepository(root);
  assert.equal(scan.repo.branch, 'feature/demo');
  assert.equal(scan.repo.remote, 'https://github.com/org/repo.git');
  assert.doesNotMatch(JSON.stringify(scan), /credential-do-not-output|someone|token=hidden/);
});

test('a GitHub remote is GitHub however git spells it, and a host that merely mentions github.com is not', async t => {
  const root = await fixture(t, { 'package.json': { name: 'app' } });
  execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
  for (const [url, remote, provider] of [
    ['ssh://git@github.com/acme/app.git', 'https://github.com/acme/app.git', 'GitHub'],
    ['ssh://git@ssh.github.com:443/acme/app.git', 'https://github.com/acme/app.git', 'GitHub'],
    ['git@github.com:acme/app.git', 'https://github.com/acme/app.git', 'GitHub'],
    ['github.com:acme/app.git', 'https://github.com/acme/app.git', 'GitHub'],
    ['http://github.com/acme/app', 'https://github.com/acme/app', 'GitHub'],
    ['https://gitlab.com/acme/github.com-mirror.git', 'https://gitlab.com/acme/github.com-mirror.git', 'Git'],
    ['https://github.com.example.test/acme/app.git', 'https://github.com.example.test/acme/app.git', 'Git'],
  ]) {
    execFileSync('git', ['-C', root, 'config', 'remote.origin.url', url]);
    const scan = await scanRepository(root);
    assert.deepEqual([scan.repo.remote, scan.nodes.find(node => node.id === 'repository')!.provider, scan.delivery.build.length], [remote, provider, provider === 'GitHub' ? 1 : 0], url);
  }
});

test('a git that gives no answer fails the scan instead of erasing its branch and commit', async t => {
  const root = await fixture(t, { 'package.json': { name: 'app' } });
  // A git killed before it answers, as a timeout leaves it.
  const bin = await fixture(t, { git: '#!/bin/sh\nkill -KILL $$\n' });
  await chmod(path.join(bin, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  await assert.rejects(scanRepository(root), /Could not read the repository's branch and commit/);
  await writeFile(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n');
  const { repo } = await scanRepository(root);
  assert.deepEqual([repo.branch, repo.sha, repo.remote], [null, null, null], 'Git answering that there is no repository leaves them absent.');
});

test('withholds guessed install commands for unrelated nested packages without a root workspace', async t => {
  const root = await fixture(t, {
    'apps/a/package.json': { name: 'a', packageManager: 'pnpm@10.33.0', scripts: { test: 'vitest run' } },
    'apps/b/package.json': { name: 'b', scripts: { test: 'node --test' } },
  });
  const scan = await scanRepository(root);
  assert.equal(scan.plan.workflow, undefined);
  assert.ok(scan.warnings.some(w => /install.*topology|workspace.*confirm/i.test(w)));
  assert.throws(() => createPreviewPlan(scan, 'alpha\nproduction'), /environment name/i);
});

test('the starter uses the current action majors and the Node.js version the repository asks for', async t => {
  const setup = async (files: Record<string, unknown>) => {
    const steps = starter((await scanRepository(await fixture(t, { 'package-lock.json': '{}', ...files }))).plan.workflow).jobs.validate.steps;
    return { uses: steps.filter(step => step.uses).map(step => step.uses), node: steps.find(step => step.uses?.startsWith('actions/setup-node@'))!.with };
  };
  const app = (extra: object = {}) => ({ name: 'app', scripts: { test: 'node --test' }, ...extra });
  const engines = await setup({ 'package.json': app({ engines: { node: '>=24' } }) });
  assert.deepEqual(engines, { uses: ['actions/checkout@v7', 'actions/setup-node@v7'], node: { 'node-version-file': 'package.json' } });
  assert.deepEqual((await setup({ 'package.json': app({ engines: { node: '>=24' } }), '.nvmrc': '22\n' })).node, { 'node-version-file': '.nvmrc' });
  assert.deepEqual((await setup({ 'package.json': app(), '.node-version': '26\n' })).node, { 'node-version-file': '.node-version' });
  assert.deepEqual((await setup({ 'package.json': app({ volta: { node: '24.11.1' } }) })).node, { 'node-version-file': 'package.json' });
  // Without evidence, the current LTS.
  assert.deepEqual((await setup({ 'package.json': app() })).node, { 'node-version': '24' });
  const pnpm = await setup({ 'package.json': app({ packageManager: 'pnpm@10.33.0' }), 'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n' });
  assert.ok(pnpm.uses.includes('pnpm/action-setup@v6'), JSON.stringify(pnpm.uses));
});

test('a Yarn starter disables installation scripts and does not persist checkout credentials', async t => {
  const root = await fixture(t, { 'package.json': { name: 'yarn-app', packageManager: 'yarn@4.9.0', scripts: { test: 'vitest run' } } });
  const workflow = starter((await scanRepository(root)).plan.workflow);
  const steps = workflow.jobs.validate.steps;
  assert.equal(steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with!['persist-credentials'], false);
  assert.equal(steps.find(s => s.run?.startsWith('yarn install'))!.env!.YARN_ENABLE_SCRIPTS, 'false');
});

test('starter checks only declared workspace members, excluding unrelated examples', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'repo', packageManager: 'pnpm@10.33.0' },
    'pnpm-workspace.yaml': 'packages: [apps/*, "!apps/excluded"]\n',
    'apps/web/package.json': { name: 'web', scripts: { test: 'node --test' } },
    'apps/excluded/package.json': { name: 'excluded', scripts: { test: 'node --test' } },
    'examples/demo/package.json': { name: 'example', scripts: { test: 'node --test' } },
  });
  const workflow = starter((await scanRepository(root)).plan.workflow);
  assert.deepEqual(workflow.jobs.validate.steps.filter(s => s.run === 'pnpm run test').map(s => s['working-directory']), ['apps/web']);
});

test('custom helper paths and object fields never establish a Vercel project identity', async t => {
  for (const helper of ['scripts/vercel-preview-alias.mjs', 'tools/deploy.mjs']) await t.test(helper, async () => {
    const root = await fixture(t, {
      'package.json': { name: 'app' },
      'vercel.json': { framework: 'vite' },
      '.github/workflows/deploy.yml': `name: Vercel deploy\non:\n  push:\n    branches: [preview]\njobs:\n  deploy:\n    steps:\n      - run: node ${helper}\n`,
      [helper]: 'const unused = [{name:"web",previewAlias:"web.vercel.app"}];\n',
    });
    const scan = await scanRepository(root);
    const targets = scan.nodes.filter(node => node.kind === 'deployment' && node.provider === 'Vercel');
    assert.equal(targets.length, 2, 'standard configuration and unidentified workflow evidence stay visible');
    assert.ok(targets.every(node => node.projectName === null && !node.previewAlias && !node.deployBranches), 'a custom object and a push filter do not identify a deployed project or branch');
    assert.deepEqual(targets.flatMap(node => node.evidence.map(item => item.file)).sort(), ['.github/workflows/deploy.yml', 'vercel.json']);
    assert.equal(scan.workflows.length, 1, 'the workflow remains with the Build runner');
  });
});
