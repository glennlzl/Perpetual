import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryFacts } from '../src/environments/evidence.ts';
import { readLocal, repositoryWalk } from '../src/environments/plans.ts';
import { gitReadOnly } from '../src/process.ts';

// These tests stop actual I/O boundaries, before a scan can continue or turn cancellation into partial evidence.
test('a cancelled facts scan, walk or file read never starts filesystem work', async () => {
  const reason = new Error('Configuration deadline reached.');
  const signal = AbortSignal.abort(reason), missing = join(tmpdir(), 'perpetual-no-such-source');
  for (const pending of [repositoryFacts({ source: missing, signal }), repositoryWalk(missing, undefined, { signal }), readLocal(missing, 'app.js', undefined, { signal })]) {
    await assert.rejects(pending, error => error === reason);
  }
  let started = false;
  assert.throws(() => gitReadOnly(missing, ['ls-files'], { signal, run: async () => { started = true; return { stdout: '', stderr: '' }; } }), error => error === reason);
  assert.equal(started, false);
});

test('a cancelled git listing stops instead of falling back to a directory scan', async t => {
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), 'perpetual-cancel-git-')));
  t.after(() => filesystem.rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), started = join(root, 'started');
  await filesystem.mkdir(repo); await filesystem.mkdir(bin);
  await filesystem.writeFile(join(repo, 'app.js'), 'const value = process.env.APP_VALUE;');
  // Directly executed Node process, so cancelling execFile leaves no shell or sleep child behind.
  await filesystem.writeFile(join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const controller = new AbortController(), reason = new Error('Configuration deadline reached.');
  const pending = repositoryFacts({ source: repo, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error === reason);
  try {
    const deadline = Date.now() + 5000;
    while (!await filesystem.stat(started).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, 'The git fixture must start.');
      await delay(10);
    }
  } finally { controller.abort(reason); }
  await rejected;
});

test('cancellation during a source file open closes the handle and stops the facts reader', async t => {
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), 'perpetual-cancel-read-')));
  t.after(() => filesystem.rm(root, { recursive: true, force: true }));
  await filesystem.writeFile(join(root, 'a.js'), 'const first = process.env.FIRST_VALUE;');
  await filesystem.writeFile(join(root, 'b.js'), 'const second = process.env.SECOND_VALUE;');
  const controller = new AbortController(), reason = new Error('Configuration deadline reached.');
  const originalOpen = filesystem.open, opened: filesystem.FileHandle[] = [], names: string[] = [];
  // Built-in exports are synchronized so readLocal's named import observes the delayed open as well.
  const fs = (await import('node:fs/promises')).default;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    names.push(String(args[0])); opened.push(handle);
    controller.abort(reason);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(repositoryFacts({ source: root, signal: controller.signal }), error => error === reason);
  assert.deepEqual(names, [join(root, 'a.js')], 'The reader must not continue to another module.');
  assert.ok(opened.every(handle => handle.fd === -1), 'Every opened file handle is closed before rejection.');
});

test('cancellation during a fallback directory read prevents descent', async t => {
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), 'perpetual-cancel-walk-')));
  t.after(() => filesystem.rm(root, { recursive: true, force: true }));
  await filesystem.mkdir(join(root, 'nested'));
  await filesystem.writeFile(join(root, 'nested', 'app.js'), 'const value = process.env.APP_VALUE;');
  const controller = new AbortController(), reason = new Error('Configuration deadline reached.');
  const fs = (await import('node:fs/promises')).default, originalReaddir = fs.readdir;
  let reads = 0;
  const mocked = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof originalReaddir>) => {
    const entries = await originalReaddir(...args);
    reads += 1; controller.abort(reason);
    return entries;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(repositoryFacts({ source: root, signal: controller.signal }), error => error === reason);
  assert.equal(reads, 1);
});
