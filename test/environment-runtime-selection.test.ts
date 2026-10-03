import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanRepository } from '../src/scanner.ts';
import { detectEnvironmentConfig } from '../src/environments/plans.ts';
import { createEnvironmentRuntime } from '../src/environments/runtime.ts';
import { createEnvironmentManager } from '../src/environments/manager.ts';

const nodeApp = JSON.stringify({ name: 'site', scripts: { start: 'node server.js' } });
const django = {
  'pyproject.toml': '[project]\nname = "acme-app"\nversion = "1.0.0"\ndependencies = ["Django>=5"]\n',
  'product/wsgi.py': 'from django.core.wsgi import get_wsgi_application\napplication = get_wsgi_application()\n',
};

async function setup(t: TestContext, files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-runtime-selection-'))), repoPath = join(root, 'repo');
  await mkdir(repoPath);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(repoPath, file)), { recursive: true });
    await writeFile(join(repoPath, file), text);
  }
  const scan = await scanRepository(repoPath), plan = await detectEnvironmentConfig(scan);
  let builds = 0, authors = 0;
  const runtime = createEnvironmentRuntime({
    author: () => { authors++; throw new Error('The model must not start for an unsupported runtime.'); },
    inputs: async () => ({}), answers: async () => 200,
    twin: {
      prepare: async () => { builds++; return { services: [], apps: Object.keys(plan.apps).map(id => ({ id, url: 'http://127.0.0.1:3000/' })) }; },
      health: async () => ({ status: 'ready', containers: [] }), logs: async () => '', destroy: async () => {},
    },
  });
  const create = (generate = false) => runtime.prepareEnvironment({ dataDir: root, repoPath, directory: join(root, generate ? 'generated' : 'direct'),
    environment: { id: 'fixture', plan }, cancelled: () => false, onUpdate: async () => {},
    ...(generate ? { generate: { model: { apiKey: 'fixture-key', model: 'fixture/model' }, draft: JSON.stringify(plan) } } : {}),
  });
  return { root, scan, runtime, plan, create, calls: () => ({ builds, authors }) };
}

test('a Node auxiliary site cannot make a Python web product ready or start paid authoring', async t => {
  // Renaming the ancillary folder must not change application identity.
  for (const directory of ['docs', 'handbook']) {
    const f = await setup(t, { ...django, [`${directory}/package.json`]: nodeApp });
    for (const generate of [false, true]) {
      await assert.rejects(f.create(generate), error => error instanceof Error && /Python/.test(error.message)
        && /product\/wsgi.py/.test(error.message) && /existing application URL/.test(error.message));
    }
    assert.deepEqual(f.calls(), { builds: 0, authors: 0 });
  }
});

test('documentation products, multiple Node apps and Python build helpers remain runnable', async t => {
  const cases: Record<string, string>[] = [
    { 'docs/package.json': nodeApp },
    { 'web/package.json': nodeApp, 'api/package.json': nodeApp, 'docs/package.json': nodeApp },
    { 'package.json': nodeApp, 'tools/pyproject.toml': '[project]\nname = "assets"\ndependencies = ["Pillow"]\n', 'tools/assets.py': 'print("build assets")\n' },
    { 'package.json': nodeApp, 'pyproject.toml': '[dependency-groups]\ntest = ["Django"]\n', 'examples/wsgi.py': django['product/wsgi.py'] },
    { ...django, 'package.json': nodeApp, 'product/wsgi.py': `"""Example configuration:\n${django['product/wsgi.py']}"""\n` },
    { ...django, 'package.json': nodeApp, 'product/pyproject.toml': '[project]\nname = "example"\ndependencies = []\n' },
    { 'package.json': nodeApp, 'requirements-dev.txt': 'Flask==3\n', 'tools/server.py': 'from flask import Flask\napp = Flask(__name__)\n' },
    { 'package.json': nodeApp, 'pyproject.toml': '[project.optional-dependencies]\ntest = ["Flask"]\n', 'tools/server.py': 'from flask import Flask\napp = Flask(__name__)\n' },
  ];
  for (const files of cases) {
    const f = await setup(t, files);
    const result = await f.create();
    assert.equal(result.status, 'ready');
    assert.equal(result.apps.length, Object.keys(files).filter(file => file.endsWith('package.json')).length);
    assert.equal(f.calls().builds, 1);
  }
});

test('other declared Python web entrypoints and import aliases cannot be silently omitted', async t => {
  const cases: Record<string, string>[] = [
    { 'backend/requirements.txt': 'fastapi==0.115\n', 'backend/app.py': 'from fastapi import FastAPI as WebApp\napp = WebApp()\n' },
    { 'backend/pyproject.toml': '[tool.poetry.dependencies]\nflask = "^3"\n', 'backend/app.py': 'from flask import Flask\napp = Flask(__name__)\n' },
    { 'backend/pyproject.toml': django['pyproject.toml'], 'backend/app.py': 'from django.core.asgi import get_asgi_application as application_factory\napplication = application_factory()\n' },
    { 'backend/requirements.txt': 'fastapi==0.115\n', 'backend/app.py': 'from fastapi import FastAPI, Depends\napp = FastAPI()\n' },
    { 'backend/requirements.txt': 'fastapi==0.115\n', 'backend/app.py': 'import fastapi as api\napp = api.FastAPI()\n' },
  ];
  for (const files of cases) {
    const f = await setup(t, { ...files, 'web/package.json': nodeApp });
    await assert.rejects(f.create(), /Python.*backend\/app.py/);
    assert.deepEqual(f.calls(), { builds: 0, authors: 0 });
  }
});

test('a person can explicitly select a Node product that ships a separate Python tutorial', async t => {
  const f = await setup(t, { 'package.json': nodeApp, 'examples/server/pyproject.toml': django['pyproject.toml'], 'examples/server/wsgi.py': django['product/wsgi.py'] });
  const manager = await createEnvironmentManager({ dataDir: join(f.root, 'controller'), runtime: f.runtime, authoringModel: async () => null });
  try {
    const context = { key: 'acme/app', stageId: 'beta', scan: f.scan };
    // Automatic selection is ambiguous; the same repository becomes runnable only after a person saves the selection.
    const { environment: automatic } = await manager.create(context);
    assert.equal((await manager.awaitIdle(automatic.id)).status, 'failed');
    assert.deepEqual(f.calls(), { builds: 0, authors: 0 });
    await manager.savePlan(context, f.plan);
    const { environment: selected } = await manager.create(context);
    assert.equal((await manager.awaitIdle(selected.id)).status, 'ready');
    assert.equal(f.calls().builds, 1);
  } finally { await manager.close(); }
});
