import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_LABELS } from '../client/src/lib/stage-gate.ts';

// Current documentation names files the repository has. Dated plans and specs under docs/superpowers record history
// and keep the paths of their day; a current document marks such a path as history in words, not as a live link.
const root = fileURLToPath(new URL('..', import.meta.url));
const exists = (path: string) => access(path).then(() => true, () => false);

async function documents(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() && entry.name !== 'superpowers' ? documents(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith('.md') ? [join(directory, entry.name)] : [])));
  return nested.flat();
}

test('current documents link only to files the repository has, and name no retired file as present', async () => {
  const missing: string[] = [];
  for (const file of ['README.md', 'CONTEXT.md', ...await documents('docs')]) {
    const text = await readFile(join(root, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const path = join(root, dirname(file), decodeURIComponent(target.split('#')[0]));
      if (!await exists(path)) missing.push(`${file} -> ${relative(root, path)}`);
    }
  }
  assert.deepEqual(missing, []);
  // The retired standalone icon helper is not described as kept.
  assert.doesNotMatch(await readFile(join(root, 'docs/ASSETS.md'), 'utf8'), /public\/icons\.js|\/icons\.js/);
});

test('the gate documents name every gate Badge the pipeline shows, Build admission included', async () => {
  for (const file of ['docs/gate.md', 'docs/architecture/twins-and-gate.md', 'docs/pipeline-ui.md']) {
    const text = await readFile(join(root, file), 'utf8');
    assert.deepEqual([...new Set(Object.values(GATE_LABELS))].filter(label => !text.includes(`\`${label}\``)), [], file);
  }
});

test('no current document says Perpetual renews a provisioned sandbox: only a person provisions one again', async () => {
  for (const file of ['CHANGELOG.md', 'README.md', ...await documents('docs')]) {
    assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /(?<!never )\brenews\b/, file);
  }
});

test('the contributor guide, the CLI guide and the CI workflow name every variable that lets a test start Docker', async () => {
  const names = new Set<string>();
  for (const file of (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.ts'))) {
    for (const [name] of (await readFile(join(root, 'test', file), 'utf8')).matchAll(/\bPERPETUAL_\w*DOCKER_TESTS\b/g)) names.add(name);
  }
  assert.ok(names.size >= 2, [...names].join(', '));
  for (const file of ['CONTRIBUTING.md', 'docs/cli.md', '.github/workflows/ci.yml']) {
    const text = await readFile(join(root, file), 'utf8');
    assert.deepEqual([...names].filter(name => !text.includes(name)), [], file);
  }
});
