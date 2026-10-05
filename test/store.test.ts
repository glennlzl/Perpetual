import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../src/store.ts';
import { IN_PROGRESS, holdsResources, scopeId } from '../src/environments/usage.ts';

test('a private directory is the controller\'s own: created 0700, never a link, and its real path', async t => {
  const base = await mkdtemp(join(tmpdir(), 'perpetual-store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await privateDirectory(join(base, 'gates'), 'Gate storage must not be a symbolic link.');
  assert.equal(root, await realpath(join(base, 'gates')));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await symlink(join(base, 'gates'), join(base, 'linked'));
  await assert.rejects(privateDirectory(join(base, 'linked'), 'Gate storage must not be a symbolic link.'), /Gate storage must not be a symbolic link/);
  assert.equal(await privateDirectory(join(base, 'kept'), 'x', { resolveAliases: false }), join(base, 'kept'), 'A caller may keep the configured path.');
});

test('a state file reads back as its JSON, is absent as undefined, and is refused as a link, a folder or an oversize file', async t => {
  const base = await mkdtemp(join(tmpdir(), 'perpetual-store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, 'state.json');
  assert.equal(await readStateFile(file, { limit: 100, invalid: 'Invalid state.' }), undefined);
  await writeFile(file, '{"version":1}');
  assert.deepEqual(await readStateFile(file, { limit: 100, invalid: 'Invalid state.' }), { version: 1 });
  await assert.rejects(readStateFile(file, { limit: 5, invalid: 'Invalid state.' }), /Invalid state\./);
  await symlink(file, join(base, 'link.json'));
  await assert.rejects(readStateFile(join(base, 'link.json'), { limit: 100, invalid: 'Invalid state.' }), /Invalid state\./);
  await assert.rejects(readStateFile(base, { limit: 100, invalid: 'Invalid state.' }), /Invalid state\./);
  await writeFile(file, '{oops');
  await assert.rejects(readStateFile(file, { limit: 100, invalid: 'Invalid state.' }), SyntaxError, 'Unreadable JSON is the caller\'s to judge.');
});

test('a state file is written beside itself and renamed into place, private, with no temporary file left', async t => {
  const base = await mkdtemp(join(tmpdir(), 'perpetual-store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, 'state.json');
  await writeStateFile(file, '{"a":1}');
  assert.equal(await readFile(file, 'utf8'), '{"a":1}');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await writeStateFile(file, '{"a":2}', { prefix: '.own-', removeTemporary: true });
  assert.equal(await readFile(file, 'utf8'), '{"a":2}');
  assert.deepEqual(await readdir(base), ['state.json']);
  await assert.rejects(writeStateFile(join(base, 'missing', 'state.json'), '{}'), /ENOENT/, 'A failure is the file system\'s, unchanged.');
});

test('a failed save leaves no temporary file behind and reports its own error', async t => {
  const base = await mkdtemp(join(tmpdir(), 'perpetual-store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  // A folder where the file belongs refuses the rename.
  await mkdir(join(base, 'state.json'));
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(writeStateFile(join(base, 'state.json'), '{}'), { code: 'EISDIR' });
  assert.deepEqual(await readdir(base), ['state.json']);
});

test('a save queue runs saves in order, lets a failed save through and settles idle after the last', async () => {
  const saves = createSaveQueue(), order: string[] = [];
  const first = saves.run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); order.push('first'); return 1; });
  const second = saves.run(async () => { order.push('second'); throw new Error('disk full'); });
  const third = saves.run(async () => { order.push('third'); return 3; });
  assert.equal(await first, 1);
  await assert.rejects(second, /disk full/);
  assert.equal(await third, 3);
  assert.deepEqual(order, ['first', 'second', 'third']);
  await saves.idle();
});

test('the scope id, the in-progress statuses and the owned rule are the ones every manager shares', async () => {
  assert.match(scopeId({ key: '/repo', stageId: 'beta' }), /^[a-f0-9]{64}$/, 'sha256 hex, the key existing data directories use');
  assert.notEqual(scopeId({ key: '/repo', stageId: 'beta' }), scopeId({ key: '/repo', stageId: 'gamma' }));
  assert.deepEqual([...IN_PROGRESS], ['queued', 'creating', 'preparing', 'destroying']);
  const owned = (status: string, sandboxId?: string | null, cleanedAt?: string) => holdsResources({ status, sandboxId, cleanedAt });
  assert.equal(owned('destroyed', 'sb'), false);
  assert.equal(owned('failed', null), false, 'A failure before a sandbox existed holds nothing.');
  assert.equal(owned('failed', 'sb', '2026-09-25T00:00:00.000Z'), false, 'A cleaned-up failure holds nothing.');
  assert.equal(owned('failed', 'sb'), true);
  for (const status of ['ready', 'queued', 'creating', 'preparing', 'destroying', 'cleanup_failed']) assert.equal(owned(status, 'sb'), true, status);
  const { readdir: list, readFile: text } = await import('node:fs/promises');
  const files = (await list(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'environments/usage.ts');
  for (const file of files) {
    const body = await text(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(body, /createHash\('sha256'\)\.update\(`\$\{key\}\\0\$\{stageId\}`\)/, `${file} derives a scope id of its own`);
    assert.doesNotMatch(body, /status ?!== ?'destroyed' ?&& ?!\(/, `${file} restates the owned rule`);
    if (file !== 'store.ts') assert.doesNotMatch(body, /\.isSymbolicLink\(\)\) ?throw new Error\('[A-Za-z ]+ storage must not be a symbolic link\.'\)/, `${file} guards a storage directory itself`);
  }
});
