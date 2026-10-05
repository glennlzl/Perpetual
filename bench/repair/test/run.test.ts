// The runner's own files without Docker: the boxes list cleanup reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScopes } from '../run.ts';

// A run killed while it rewrote boxes.json leaves it empty or cut off; resume and cleanup still read what it names.
test('the boxes list is read whole, torn or missing', async t => {
  const out = await mkdtemp(join(tmpdir(), 'bench-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const file = join(out, 'boxes.json'), [a, b] = ['0123456789abcdef', 'fedcba9876543210'];
  assert.deepEqual(await readScopes(file), [], 'A run that made no box has none.');
  await writeFile(file, JSON.stringify([a, b], null, 2));
  assert.deepEqual(await readScopes(file), [a, b]);
  await writeFile(file, `[\n  "${a}",\n  "${b.slice(0, 5)}`);
  assert.deepEqual(await readScopes(file), [a], 'A torn list keeps the scopes it still names whole.');
  await writeFile(file, '');
  assert.deepEqual(await readScopes(file), []);
});
