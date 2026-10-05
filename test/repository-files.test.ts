import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_PATH, hasRepositoryFile, readRepositoryFile } from '../src/repository-files.ts';

test('a repository file is read only when no link, no climb and no oversize is on its way', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps', 'web'), { recursive: true });
  await writeFile(join(root, 'apps', 'web', 'package.json'), '{"name":"web"}');
  await writeFile(join(root, 'large.txt'), 'x'.repeat(2049));
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE');
  await symlink(join(root, 'outside.txt'), join(root, 'apps', 'link.txt'));
  await symlink(join(root, 'apps'), join(root, 'linked'));
  assert.equal(await readRepositoryFile(root, 'apps/web/package.json'), '{"name":"web"}');
  assert.equal(await readRepositoryFile(root, 'apps\\web\\package.json'), '{"name":"web"}', 'Backslashes are separators.');
  assert.equal(await readRepositoryFile(root, 'apps/link.txt'), null, 'A linked file is never read.');
  assert.equal(await readRepositoryFile(root, 'linked/web/package.json'), null, 'A linked folder is never crossed.');
  assert.equal(await readRepositoryFile(root, 'large.txt', { limit: 2048 }), null, 'A file over the limit is not read.');
  assert.equal(await readRepositoryFile(root, 'large.txt', { limit: 2049 }), 'x'.repeat(2049));
  for (const escape of ['../outside.txt', 'apps/../outside.txt', join(root, 'outside.txt'), 'apps//web/package.json', 'apps/./web/package.json', '', 'C:/x']) assert.equal(await readRepositoryFile(root, escape), null, escape);
  assert.equal(await readRepositoryFile(root, 'apps'), null, 'A directory is not a file.');
  assert.equal(await readRepositoryFile(root, 'missing.txt'), null);
  assert.equal(await hasRepositoryFile(root, 'apps/web/package.json'), true);
  assert.equal(await hasRepositoryFile(root, 'apps/link.txt'), false);
  assert.equal(await hasRepositoryFile(root, 'large.txt', { limit: 10 }), false);
});

test('a repository file saved with a byte order mark reads as its text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '\uFEFF{"name":"web"}');
  assert.deepEqual(JSON.parse((await readRepositoryFile(root, 'package.json'))!), { name: 'web' });
});

test('SECRET_PATH names env files, tool state, credential files and key material anywhere on a path', () => {
  for (const secret of ['.env', '.env.local', 'config/.env.production', '.git/config', '.ssh/id_rsa', '.aws/credentials', '.npmrc', 'ops/.netrc', 'credentials.json', 'secrets/config.ts', 'keys/signing.txt', 'certs/server.pem', 'store.jks', 'a/b/private.key']) assert.match(secret, SECRET_PATH, secret);
  for (const open of ['package.json', 'src/credentials-form.tsx', 'docs/secrets-policy.md', '.github/workflows/ci.yml', 'keyboard.ts', 'monkeys.ts', 'src/app.ts']) assert.doesNotMatch(open, SECRET_PATH, open);
});

test('the secret path pattern and the bounded reader are written once', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'repository-files.ts');
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /credentials\?\(\?:\\\.\[\^\/\]\*\)\?/, `${file} spells the secret path pattern`);
    assert.doesNotMatch(text, /Buffer\.alloc\(MAX_BYTES \+ 1\)/, `${file} keeps a bounded reader of its own`);
  }
});
