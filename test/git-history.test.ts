import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readGitHistory, type GitHistory } from '../src/git-history.ts';

const exec = promisify(execFile);

/** A small real repository on disk, read through the Git graph reader as a local checkout of acme/app. */
async function repository(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-git-history-')), path = join(dir, 'app');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec('git', ['-c', 'user.name=Perpetual', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-C', path, ...args])).stdout.trim();
  await mkdir(path);
  await git('init', '--quiet', '--initial-branch', 'main');
  const commit = async (message: string) => { await git('commit', '--quiet', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const read = (options: { scope?: string; limit?: number; cursor?: string | null } = {}) => readGitHistory({ repo: { path, remote: 'https://github.com/acme/app.git', name: 'app' } }, options);
  return { dir, path, git, commit, read };
}
const byHash = (history: GitHistory) => Object.fromEntries(history.commits.map(commit => [commit.hash, commit]));

test('the graph holds the real commits, their parents, branch heads and tags peeled through nested annotated tags', async t => {
  const repo = await repository(t);
  const c1 = await repo.commit('one'), c2 = await repo.commit('two');
  await repo.git('tag', 'v1', c1);
  await repo.git('tag', '--annotate', '--message', 'release', 'v2', c2);
  await repo.git('tag', '--annotate', '--message', 'release of a release', 'v2-final', 'v2');
  await repo.git('switch', '--quiet', '--create', 'feature', c1);
  const f1 = await repo.commit('feature');
  await repo.git('switch', '--quiet', 'main');
  const c3 = await repo.commit('three');
  const all = await repo.read({ scope: 'all' }), commits = byHash(all);
  assert.deepEqual(Object.keys(commits).sort(), [c1, c2, c3, f1].sort());
  assert.deepEqual([c3, c2, f1, c1].map(hash => [commits[hash].message, commits[hash].parents, commits[hash].refs, commits[hash].tag]), [
    ['three', [c2], ['main'], undefined], ['two', [c1], undefined, 'v2, v2-final'], ['feature', [c1], ['feature'], undefined], ['one', [], undefined, 'v1'],
  ]);
  assert.deepEqual([all.branch, all.localBranchCount, all.remoteBranchCount, all.shallow, all.hasMore, all.repository, all.source], ['main', 2, 0, false, false, 'acme/app', 'local']);
  assert.deepEqual((await repo.read({ scope: 'current' })).commits.map(commit => commit.hash), [c3, c2, c1], 'Current branch leaves the other branch out.');
});

test('a detached HEAD is labelled and followed by Current branch', async t => {
  const repo = await repository(t);
  const c1 = await repo.commit('one');
  await repo.commit('two');
  await repo.git('switch', '--quiet', '--detach', c1);
  const history = await repo.read({ scope: 'current' });
  assert.deepEqual([history.branch, history.commits.map(commit => [commit.hash, commit.refs])], [null, [[c1, ['HEAD']]]]);
});

test('a shallow clone is marked, and its boundary commit keeps only the parents Git has', async t => {
  const origin = await repository(t);
  await origin.commit('one');
  const c2 = await origin.commit('two');
  await origin.git('tag', 'v2', c2);
  const clone = join(origin.dir, 'clone');
  await exec('git', ['clone', '--quiet', '--depth', '1', `file://${origin.path}`, clone]);
  const history = await readGitHistory({ repo: { path: clone, remote: null, name: 'app' } }, { scope: 'current' });
  assert.deepEqual([history.shallow, history.repository, history.commits.map(commit => [commit.hash, commit.parents, commit.tag])], [true, 'app', [[c2, [], 'v2']]]);
});

test('an empty repository has no commits, and a longer history stops at its limit', async t => {
  const repo = await repository(t);
  assert.deepEqual([(await repo.read()).commits, (await repo.read()).hasMore], [[], false]);
  const stream = Array.from({ length: 101 }, (_, index) => `commit refs/heads/main\nmark :${index + 1}\ncommitter Perpetual <test@example.test> ${1_800_000_000 + index} +0000\ndata ${String(index).length}\n${index}\n${index ? `from :${index}\n` : ''}`).join('\n');
  execFileSync('git', ['-C', repo.path, 'fast-import', '--quiet'], { input: stream });
  const first = await repo.read({ scope: 'current' }), all = await repo.read({ scope: 'current', limit: 200 });
  assert.deepEqual([first.commits.length, first.hasMore, first.commits[0].message, all.commits.length, all.hasMore], [100, true, '100', 101, false]);
  await assert.rejects(repo.read({ limit: 99 }), /history limit between 100 and 500/);
});

test('history pages pass 500 commits without gaps or duplicates when the branch advances', async t => {
  const repo = await repository(t);
  const stream = Array.from({ length: 601 }, (_, index) => `commit refs/heads/main\nmark :${index + 1}\ncommitter Perpetual <test@example.test> ${1_800_000_000 + index} +0000\ndata ${String(index).length}\n${index}\n${index ? `from :${index}\n` : ''}`).join('\n');
  execFileSync('git', ['-C', repo.path, 'fast-import', '--quiet'], { input: stream });
  let page = await repo.read({ scope: 'current' });
  const commits = [...page.commits];
  const newTip = await repo.commit('new push');
  let pages = 1;
  while (page.nextCursor) {
    assert.ok(pages++ < 8, 'Pagination must terminate.');
    page = await repo.read({ scope: 'current', cursor: page.nextCursor });
    assert.ok(page.commits.length <= 100);
    assert.deepEqual(commits.at(-1)?.parents, [page.commits[0].hash], 'The actual parent joins the next page.');
    commits.push(...page.commits);
  }
  assert.equal(pages, 7);
  assert.deepEqual(commits.map(commit => commit.message), Array.from({ length: 601 }, (_, i) => String(600 - i)));
  assert.equal(new Set(commits.map(commit => commit.hash)).size, 601);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal((await repo.read({ scope: 'current' })).commits[0].hash, newTip, 'A refresh follows the new tip.');
});

test('untrusted history cursors cannot become Git options or invalid offsets', async t => {
  const repo = await repository(t);
  const tip = await repo.commit('one');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['', '!invalid', 'a'.repeat(513), encode({ tip, skip: 100 }), encode(['--all', 100]), encode([tip, -1]), encode([tip, 1.5]), encode([tip, Number.MAX_SAFE_INTEGER + 1])]) {
    await assert.rejects(repo.read({ scope: 'current', cursor }), /Invalid history page/);
  }
  await assert.rejects(repo.read({ scope: 'all', cursor: encode([tip, 100]) }), /History pages follow the current branch/);
});

test('a directory that is not a repository has no history to read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-git-history-none-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(readGitHistory({ repo: { path: dir, remote: null, name: 'app' } }), /Cannot read local Git history/);
});

test('tags label commits without counting toward the branch reference limit', async t => {
  const repo = await repository(t);
  const c1 = await repo.commit('one');
  execFileSync('git', ['-C', repo.path, 'update-ref', '--stdin'], { input: Array.from({ length: 2001 }, (_, index) => `create refs/tags/v${index} ${c1}\n`).join('') });
  const history = await repo.read({ scope: 'current' });
  assert.deepEqual([history.commits.length, history.commits[0].tag?.split(', ').length, history.refCount], [1, 2001, 1]);
});

test('Current branch follows its own ref past the branch head bound, which only All branches refuses', async t => {
  const repo = await repository(t);
  const c1 = await repo.commit('one'), c2 = await repo.commit('two');
  // 2,001 branch heads on a commit outside main's history, and the remote branch Current branch follows, listed after them.
  const side = await repo.git('commit-tree', '-m', 'side', `${c1}^{tree}`);
  execFileSync('git', ['-C', repo.path, 'update-ref', '--stdin'], { input: [...Array.from({ length: 2001 }, (_, index) => `create refs/heads/topic/${index} ${side}\n`), `create refs/remotes/origin/main ${c2}\n`].join('') });
  await repo.git('reset', '--quiet', '--hard', c1);
  const history = await readGitHistory({ repo: { path: repo.path, remote: 'https://github.com/acme/app.git', name: 'app' } }, { scope: 'current', currentRef: 'refs/remotes/origin/main' });
  assert.deepEqual(history.commits.map(commit => [commit.hash, commit.refs]), [[c2, ['origin/main']], [c1, ['main']]], 'Labels name the branches at the displayed commits, wherever they sort.');
  await assert.rejects(repo.read({ scope: 'all' }), /too many references/);
});

test('tags are read for the displayed commits only, however many the repository holds', async t => {
  const repo = await repository(t);
  const c1 = await repo.commit('one');
  await repo.git('tag', 'v1', c1);
  // More tags than one listing of every tag can carry, on a commit outside the displayed history.
  const side = await repo.git('commit-tree', '-m', 'side', `${c1}^{tree}`), name = ['a', 'b', 'c'].map(letter => letter.repeat(240)).join('/');
  execFileSync('git', ['-C', repo.path, 'update-ref', '--stdin'], { input: Array.from({ length: 5600 }, (_, index) => `create refs/tags/${name}/${index} ${side}\n`).join('') });
  assert.deepEqual((await repo.read({ scope: 'current' })).commits.map(commit => [commit.hash, commit.tag]), [[c1, 'v1']]);
});
