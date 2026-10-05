import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cloneGitHubSourceCommit } from '../src/github-source.ts';
import { REJECTED, checkChanges } from '../src/repair/changes.ts';
import { createRepairHost } from '../src/repair/clone.ts';
import type { Repair } from '../src/repair/manager.ts';
import { brokenRepository, fixtureGit, hostBox, managedCopy } from './fixtures/repair-box.ts';

async function copy(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-clone-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { checkoutPath, sha } = await managedCopy(dataDir);
  await mkdir(join(dataDir, 'repairs', 'r1'), { recursive: true, mode: 0o700 });
  return { dataDir, checkoutPath, sha, source: { repository: 'owner/app', branch: 'main', rootDirectory: '/', checkoutPath, scanPath: checkoutPath } };
}

test('a repair clones the failing commit from the managed source copy, with no remote and no credential in its config', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  assert.deepEqual(await cloneGitHubSourceCommit({ source: f.source, dataDir: f.dataDir, sha: f.sha, directory, branch: `perpetual/repair/${f.sha.slice(0, 7)}` }), { path: directory, sha: f.sha });
  assert.equal(fixtureGit(directory, 'rev-parse', '--abbrev-ref', 'HEAD'), `perpetual/repair/${f.sha.slice(0, 7)}`);
  assert.equal(fixtureGit(directory, 'remote'), '');
  assert.doesNotMatch(await readFile(join(directory, '.git', 'config'), 'utf8'), /url|credential|github\.com|sources/);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(directory, 'add.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  assert.equal(fixtureGit(f.checkoutPath, 'status', '--porcelain'), '', 'The managed copy is unchanged.');
});

// A repair usually follows a head pushed after the scanned commit, so the copy's HEAD is another commit; its history
// has the failing one once synced, and nothing is fetched from GitHub for it.
test('a repair clones a failing commit the managed copy holds behind its HEAD, from the copy itself', async t => {
  const f = await copy(t);
  await writeFile(join(f.checkoutPath, 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fixtureGit(f.checkoutPath, 'commit', '--quiet', '-am', 'Fix add');
  assert.notEqual(fixtureGit(f.checkoutPath, 'rev-parse', 'HEAD'), f.sha);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  assert.deepEqual(await cloneGitHubSourceCommit({ source: f.source, dataDir: f.dataDir, sha: f.sha, directory, branch: `perpetual/repair/${f.sha.slice(0, 7)}` }), { path: directory, sha: f.sha });
  assert.equal(await readFile(join(directory, 'add.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n');
  assert.equal(fixtureGit(directory, 'remote'), '');
  assert.doesNotMatch(await readFile(join(directory, '.git', 'config'), 'utf8'), /url|credential|github\.com|sources/);
});

test('a user\'s own checkout is never cloned for a repair', async t => {
  const f = await copy(t);
  const own = await mkdtemp(join(tmpdir(), 'perpetual-own-checkout-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const sha = await brokenRepository(own);
  fixtureGit(own, 'remote', 'add', 'origin', 'https://github.com/owner/app.git');
  await assert.rejects(cloneGitHubSourceCommit({ source: { ...f.source, checkoutPath: own, scanPath: own }, dataDir: f.dataDir, sha, directory: join(f.dataDir, 'repairs', 'r1', 'clone'), branch: 'perpetual/repair/x' }), /managed GitHub checkout/);
  await assert.rejects(cloneGitHubSourceCommit({ source: f.source, dataDir: f.dataDir, sha: 'main', directory: join(f.dataDir, 'repairs', 'r1', 'clone'), branch: 'perpetual/repair/x' }), /Choose a commit/);
});

test('the host copy stages a diff against the failing commit, and commits each attempt on top of the last', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  const repair = { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair;
  const host = createRepairHost({ dataDir: f.dataDir });
  await host.clone({ repair, directory });
  const author = { name: 'developer', email: '1234+developer@users.noreply.github.com' };
  const diff = (from: string, to: string, path = 'add.js') => Buffer.from(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`);
  assert.deepEqual((await host.stage({ directory, diff: diff('module.exports = (a, b) => a - b;', 'module.exports = (a, b) => a + b;'), base: f.sha })).paths, ['add.js']);
  const first = await host.commit({ directory, parent: f.sha, message: 'Fix the failed CI build', author });
  assert.match(first ?? '', /^[a-f\d]{40}$/);
  await writeFile(join(directory, 'stray.txt'), 'left by a failed apply');
  const second = diff('module.exports = (a, b) => a - b;', 'module.exports = (a, b) => b + a;');
  assert.deepEqual((await host.stage({ directory, diff: second, base: f.sha })).paths, ['add.js'], 'Each stage starts from the failing commit.');
  const next = await host.commit({ directory, parent: first!, message: 'Second attempt', author });
  assert.equal(fixtureGit(directory, 'rev-parse', `${next}^`), first);
  assert.equal(fixtureGit(directory, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', next!), `${author.name} <${author.email}>|${author.name} <${author.email}>`);
  await host.stage({ directory, diff: second, base: f.sha });
  assert.equal(await host.commit({ directory, parent: next!, message: 'Same', author }), null, 'A change equal to the last push commits nothing.');
  await assert.rejects(host.stage({ directory, diff: diff('not in the file', 'x'), base: f.sha }), /does not apply/);
  await assert.rejects(host.push({ directory, repository: 'owner/app', branch: 'main', sha: next!, lease: '' }), /only its perpetual\/repair branch/);
});

// A case-only rename is a delete and an add, which a case-insensitive worktree such as macOS's cannot hold.
test('the host copy stages a case-only rename into its index, whatever the host filesystem', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  const trace = join(f.dataDir, 'git-events.jsonl'), exec = promisify(execFile);
  const host = createRepairHost({ dataDir: f.dataDir, run: (file, args, options) => exec(file, args, { ...options, env: { ...options.env, GIT_TRACE2_EVENT: trace } }) });
  await host.clone({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair, directory });
  assert.equal(fixtureGit(directory, 'config', 'core.ignorecase'), 'false', 'The copy the box gets reads names with their case, as Linux does.');
  await assert.rejects(stat(join(directory, '.git', 'logs')), { code: 'ENOENT' }, 'The copy the box gets keeps no reflog naming the host\'s user and hostname.');
  const rename = ['diff --git a/add.js b/add.js', 'deleted file mode 100644', '--- a/add.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-module.exports = (a, b) => a - b;',
    'diff --git a/Add.js b/Add.js', 'new file mode 100644', '--- /dev/null', '+++ b/Add.js', '@@ -0,0 +1 @@', '+module.exports = (a, b) => a + b;', ''].join('\n');
  const staged = await host.stage({ directory, diff: Buffer.from(rename), base: f.sha });
  assert.deepEqual([...staged.paths].sort(), ['Add.js', 'add.js']);
  const sha = await host.commit({ directory, parent: f.sha, message: 'Rename', author: { name: 'developer', email: '1234+developer@users.noreply.github.com' } });
  assert.deepEqual(fixtureGit(directory, 'ls-tree', '--name-only', sha!).split('\n').filter(name => name.endsWith('.js')), ['Add.js', 'check.js']);
  const children = (await readFile(trace, 'utf8')).trim().split('\n').flatMap(line => {
    const event: unknown = JSON.parse(line);
    return event && typeof event === 'object' && 'event' in event && event.event === 'child_start' && 'argv' in event && Array.isArray(event.argv) ? [event.argv] : [];
  });
  assert.ok(children.every(args => !args.includes('maintenance') && !args.includes('gc')), 'A repair command must not leave automatic maintenance writing its private clone.');
});

// Git diffs a Latin-1 file as text; its bytes must reach the commit unchanged.
test('the box\'s change reaches the host copy byte for byte, even in a file that is not UTF-8', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  const host = createRepairHost({ dataDir: f.dataDir });
  await host.clone({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair, directory });
  const made = await hostBox(directory);
  t.after(() => made.box.remove());
  const latin1 = Buffer.from('greeting=caf\xe9\nname=na\xefve\n', 'latin1');
  await writeFile(join(made.root, 'messages.properties'), latin1);
  const staged = await host.stage({ directory, diff: await made.box.diff(f.sha), base: f.sha });
  assert.deepEqual(staged.paths, ['messages.properties']);
  const sha = await host.commit({ directory, parent: f.sha, message: 'Messages', author: { name: 'developer', email: '1234+developer@users.noreply.github.com' } });
  const committed = await promisify(execFile)('git', ['-C', directory, 'cat-file', 'blob', `${sha}:messages.properties`], { encoding: 'buffer' });
  assert.deepEqual(committed.stdout, latin1);
});

// A file git treats as binary carries its content in a binary patch, which the box's diff text does not show.
test('what the host copy staged is returned as git\'s text diff, binary files included, for the credential rule', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  const host = createRepairHost({ dataDir: f.dataDir });
  await host.clone({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair, directory });
  const made = await hostBox(directory);
  t.after(() => made.box.remove());
  await writeFile(join(made.root, '.gitattributes'), '*.env binary\n');
  await writeFile(join(made.root, 'deploy.env'), 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  const diff = await made.box.diff(f.sha);
  assert.match(diff.toString('utf8'), /GIT binary patch/);
  assert.deepEqual(checkChanges(diff.toString('utf8')).rejected, [], 'The binary patch hides the token from the diff text.');
  const staged = await host.stage({ directory, diff, base: f.sha });
  assert.deepEqual(checkChanges(staged.text).rejected, [REJECTED.credential]);
});

test('the host copy names each manifest whose checks the staged change changed, read from both of its versions', async t => {
  const f = await copy(t);
  const directory = join(f.dataDir, 'repairs', 'r1', 'clone');
  const host = createRepairHost({ dataDir: f.dataDir });
  await host.clone({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair, directory });
  const made = await hostBox(directory);
  t.after(() => made.box.remove());
  const manifest = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'app', private: true, scripts, ...extra }, null, 2);
  await writeFile(join(made.root, 'package.json'), manifest({ check: 'node check.js' }, { dependencies: { zod: '4.0.0' } }));
  assert.deepEqual((await host.stage({ directory, diff: await made.box.diff(f.sha), base: f.sha })).checks, [], 'A dependency is not a check.');
  await writeFile(join(made.root, 'package.json'), manifest({ check: 'exit 0' }));
  await mkdir(join(made.root, 'web'));
  await writeFile(join(made.root, 'web', 'package.json'), manifest({ test: 'exit 0' }));
  const staged = await host.stage({ directory, diff: await made.box.diff(f.sha), base: f.sha });
  assert.deepEqual([staged.paths, staged.checks], [['package.json', 'web/package.json'], ['package.json']], 'A new package loosens no check that ran.');
});

// The pull request head's checkout for its journey gates: the host copy's worktree stays at the failing commit, so the
// gates scan a checkout of the commit it pushed, or of one only GitHub has, such as GitHub's update of the branch.
test('a pull request head is checked out for its gates from the host copy, or from GitHub when the copy lacks it', async t => {
  const f = await copy(t);
  const clone = join(f.dataDir, 'repairs', 'r1', 'clone'), branch = `perpetual/repair/${f.sha.slice(0, 7)}`;
  const repair = { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair;
  const exec = promisify(execFile);
  const bare = join(f.dataDir, 'github.git'), calls: string[][] = [];
  await exec('git', ['init', '--quiet', '--bare', bare]);
  // Real git, with GitHub's URL answered by a local bare repository.
  const host = createRepairHost({ dataDir: f.dataDir, run: (file, args, options) => { calls.push(args); return exec(file, args.map(arg => arg === 'https://github.com/owner/app.git' ? bare : arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg), options) as Promise<{ stdout: string }>; } });
  await host.clone({ repair, directory: clone });
  await host.stage({ directory: clone, diff: Buffer.from('diff --git a/add.js b/add.js\n--- a/add.js\n+++ b/add.js\n@@ -1 +1 @@\n-module.exports = (a, b) => a - b;\n+module.exports = (a, b) => a + b;\n'), base: f.sha });
  const pushed = (await host.commit({ directory: clone, parent: f.sha, message: 'Fix', author: { name: 'developer', email: '1234+developer@users.noreply.github.com' } }))!;
  assert.equal(await readFile(join(clone, 'add.js'), 'utf8'), 'module.exports = (a, b) => a - b;\n', 'The host copy\'s worktree stays at the failing commit.');
  const gate = join(f.dataDir, 'repairs', 'r1', `gate-${pushed.slice(0, 7)}`);
  assert.equal(await host.checkout({ directory: gate, clone, repository: 'owner/app', branch, sha: pushed, rootDirectory: '/' }), gate);
  assert.equal(await readFile(join(gate, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.deepEqual([fixtureGit(gate, 'rev-parse', 'HEAD'), fixtureGit(gate, 'rev-parse', '--abbrev-ref', 'HEAD'), fixtureGit(gate, 'remote')], [pushed, branch, '']);
  assert.doesNotMatch(await readFile(join(gate, '.git', 'config'), 'utf8'), /url|credential|github\.com|repairs/);
  assert.equal((await stat(gate)).mode & 0o777, 0o700);
  assert.equal(calls.some(args => args.includes('https://github.com/owner/app.git')), false, 'The host copy\'s commit is never fetched from GitHub.');
  // GitHub's merge of the target branch into the repair branch exists only there.
  const work = join(f.dataDir, 'work');
  await exec('git', ['clone', '--quiet', f.checkoutPath, work]);
  await writeFile(join(work, 'README.md'), 'Merged on GitHub.\n');
  fixtureGit(work, 'add', 'README.md');
  fixtureGit(work, 'commit', '--quiet', '-m', 'Merge main into the repair branch');
  const updated = fixtureGit(work, 'rev-parse', 'HEAD');
  await exec('git', ['-C', work, 'push', '--quiet', bare, `${updated}:refs/heads/${branch}`]);
  const later = join(f.dataDir, 'repairs', 'r1', `gate-${updated.slice(0, 7)}`);
  assert.equal(await host.checkout({ directory: later, clone, repository: 'owner/app', branch, sha: updated, rootDirectory: '/' }), later);
  assert.equal(await readFile(join(later, 'README.md'), 'utf8'), 'Merged on GitHub.\n');
  const fetched = calls.find(args => args.includes('https://github.com/owner/app.git'))!;
  assert.ok(fetched.includes('credential.helper=!gh auth git-credential') && fetched.includes('--depth') && fetched.at(-1) === updated, 'The fallback fetches the commit alone through gh\'s credential helper.');
  await assert.rejects(host.checkout({ directory: join(f.dataDir, 'repairs', 'r1', 'gate-missing'), clone, repository: 'owner/app', branch, sha: 'c'.repeat(40), rootDirectory: '/' }), /Could not fetch the pull request head/);
});

test('a pull request checkout returns its root directory, refuses one that is missing or a link, and names only the repair branch', async t => {
  const f = await copy(t);
  const clone = join(f.dataDir, 'repairs', 'r1', 'clone'), branch = `perpetual/repair/${f.sha.slice(0, 7)}`, calls: string[][] = [];
  const exec = promisify(execFile);
  const host = createRepairHost({ dataDir: f.dataDir, run: (file, args, options) => { calls.push(args); return exec(file, args, options) as Promise<{ stdout: string }>; } });
  await host.clone({ repair: { repository: 'owner/app', branch: 'main', sha: f.sha, rootDirectory: '/', checkoutPath: f.checkoutPath } as Repair, directory: clone });
  const gate = join(f.dataDir, 'repairs', 'r1', 'gate');
  await assert.rejects(host.checkout({ directory: gate, clone, repository: 'owner/app', branch, sha: f.sha, rootDirectory: '/web' }), /root directory is not in the pull request head/);
  assert.equal(await host.checkout({ directory: gate, clone, repository: 'owner/app', branch, sha: f.sha, rootDirectory: '/.github' }), join(gate, '.github'), 'A checkout replaces the one before it.');
  // A root directory that is a link in the pull request head is refused, wherever it points.
  await host.stage({ directory: clone, diff: Buffer.from('diff --git a/web b/web\nnew file mode 120000\n--- /dev/null\n+++ b/web\n@@ -0,0 +1 @@\n+.github\n\\ No newline at end of file\n'), base: f.sha });
  const linked = (await host.commit({ directory: clone, parent: f.sha, message: 'Link', author: { name: 'developer', email: '1234+developer@users.noreply.github.com' } }))!;
  await assert.rejects(host.checkout({ directory: gate, clone, repository: 'owner/app', branch, sha: linked, rootDirectory: '/web' }), /root directory is not in the pull request head/);
  const before = calls.length;
  for (const input of [{ branch: 'main' }, { sha: 'main' }, { repository: 'owner/..' }]) {
    await assert.rejects(host.checkout({ directory: gate, clone, repository: 'owner/app', branch, sha: f.sha, rootDirectory: '/', ...input }), /perpetual\/repair branch|Invalid pull request head|Choose a GitHub repository/);
  }
  assert.equal(calls.length, before, 'Another branch, a branch name as the head or another repository is refused before git runs.');
});
