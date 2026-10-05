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
  const read = (options: { scope?: string; limit?: number } = {}) => readGitHistory({ repo: { path, remote: 'https://github.com/acme/app.git', name: 'app' } }, options);
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
  const clone = join(origin.dir, 'clone');
  await exec('git', ['clone', '--quiet', '--depth', '1', `file://${origin.path}`, clone]);
  const history = await readGitHistory({ repo: { path: clone, remote: null, name: 'app' } }, { scope: 'current' });
  assert.deepEqual([history.shallow, history.repository, history.commits.map(commit => [commit.hash, commit.parents])], [true, 'app', [[c2, []]]]);
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
