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

test('AGENTS.md lists the gate document\'s steps, beginning with the wait for Build and naming its two states', async () => {
  // The numbered steps after the line that ends "the controller:" or "the Perpetual controller:".
  const steps = async (file: string) => (/controller:\n+((?:[ \t]*\d+\. .+\n)+)/.exec(await readFile(join(root, file), 'utf8'))?.[1] ?? '')
    .trim().split('\n').map(line => line.trim().replace(/^\d+\. /, ''));
  const [agents, gate] = await Promise.all([steps('AGENTS.md'), steps('docs/gate.md')]);
  assert.equal(agents.length, gate.length, agents.join('\n'));
  for (const list of [agents, gate]) assert.match(list[0], /^waits for GitHub Actions Build to pass at that exact (?:branch )?commit/);
  // An agent then reads a gate waiting for Build, or stopped by it, as the gate's own state rather than a defect.
  for (const status of ['waiting-build', 'build-failed']) assert.ok(agents[0].includes(`\`${status}\``), status);
});

test('no current document says Perpetual renews a provisioned sandbox: only a person provisions one again', async () => {
  // In each paragraph or top-level list item about a provision or a Stripe sandbox, every clause that renews or
  // recreates one says it never does. Elsewhere the words are free.
  for (const file of ['CHANGELOG.md', 'README.md', 'CONTEXT.md', ...await documents('docs')]) {
    const blocks = (await readFile(join(root, file), 'utf8')).split(/\n(?=(?:[-*]|\d+\.) )|\n\s*\n/).filter(block => /provision|Stripe sandbox/i.test(block));
    const affirmed = blocks.flatMap(block => block.split(/[.,;:]\s|\n/)).filter(clause => /renew|recreat/i.test(clause) && !/\b(?:never|not|without)\b.*(?:renew|recreat)/i.test(clause));
    assert.deepEqual(affirmed, [], file);
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
