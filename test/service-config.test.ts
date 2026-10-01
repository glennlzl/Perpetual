import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readGitHubActions, readServiceConfig } from '../src/service-config.ts';
import type { Scan, ScanNode } from '../src/scanner.ts';

test('configuration file links remain available when workflow or Railway contents cannot be parsed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-config-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const fixture of [
    { file: '.github/workflows/build.yml', provider: 'GitHub Actions', kind: 'workflow', content: 'jobs: [invalid' },
    { file: 'railway.json', provider: 'Railway', kind: 'deployment', content: '{"deploy": ' },
    { file: 'railway.toml', provider: 'Railway', kind: 'deployment', content: '[deploy]\nstartCommand = "npm start"' },
  ]) await t.test(fixture.file, async () => {
    await mkdir(dirname(join(root, fixture.file)), { recursive: true });
    await writeFile(join(root, fixture.file), fixture.content);
    const node: ScanNode = { id: 'config', label: 'Configuration', kind: fixture.kind, provider: fixture.provider, status: 'configured', detail: '', evidence: [{ file: fixture.file, summary: 'Repository configuration' }] };
    const scan: Pick<Scan, 'repo' | 'nodes' | 'services'> = { repo: { path: root, name: 'app', branch: 'main', sha: null, remote: null }, nodes: [node], services: [] };
    assert.deepEqual(await readServiceConfig(scan, node.id), { nodeId: node.id, provider: fixture.provider, files: [{ path: fixture.file }], sections: [] });
  });
  const actions = await readGitHubActions({ repo: { path: root, name: 'app', branch: 'main', sha: null, remote: null }, workflows: [{ file: '.github/workflows/build.yml', name: 'Build', triggers: [], jobs: [] }] });
  assert.equal(actions.workflows[0].error, 'Could not parse this workflow file.', 'The actual workflow rail still reports invalid YAML.');
});

test('Vercel configuration retains the read-only fields its drawer displays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-config-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'vercel.json'), JSON.stringify({ framework: 'vite', buildCommand: 'npm run build' }));
  const node: ScanNode = { id: 'preview', label: 'Preview', kind: 'deployment', provider: 'Vercel', status: 'configured', detail: '', configFile: 'vercel.json', evidence: [{ file: 'vercel.json', summary: 'Repository configuration' }] };
  const result = await readServiceConfig({ repo: { path: root, name: 'app', branch: 'main', sha: null, remote: null }, nodes: [node], services: [] }, node.id);
  assert.deepEqual(result.files, [{ path: 'vercel.json' }]);
  assert.deepEqual(result.sections.flatMap(section => section.fields.map(({ key, value }) => [key, value])), [['framework', 'vite'], ['buildCommand', 'npm run build']]);
});

test('a legacy helper node keeps its file link without interpreting custom JavaScript as provider configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-config-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = 'scripts/vercel-preview-alias.mjs';
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), 'const unused = [{name:"web",previewAlias:"web.vercel.app"}];');
  const node: ScanNode = { id: 'vercel:web', label: 'Web', kind: 'deployment', provider: 'Vercel', status: 'configured', detail: '', projectName: 'web', previewAlias: 'web.vercel.app', configFile: file, evidence: [{ file, summary: 'Legacy discovery' }] };
  const result = await readServiceConfig({ repo: { path: root, name: 'app', branch: 'main', sha: null, remote: null }, nodes: [node], services: [] }, node.id);
  assert.deepEqual(result.files, [{ path: file }]);
  assert.deepEqual(result.sections, []);
});
