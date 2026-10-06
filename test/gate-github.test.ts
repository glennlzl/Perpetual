import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { postCommitStatus, readBranchHead } from '../src/gate/github.ts';
import { ensureGitHubHistory, updateGitHubSource } from '../src/github-source.ts';

const exec = promisify(execFile);

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';

test('the branch head is read conditionally and reports only a valid commit', async () => {
  const calls: [string, string | null][] = [];
  const request = async (endpoint: string, etag: string | null) => { calls.push([endpoint, etag]); return { status: 200, etag: '"e1"', data: { name: 'feature/gate', commit: { sha: SHA.toUpperCase() } } }; };
  assert.deepEqual(await readBranchHead({ repository: 'owner/app', branch: 'feature/gate', etag: null }, { request }), { status: 200, sha: SHA, etag: '"e1"' });
  assert.deepEqual(calls, [['repos/owner/app/branches/feature%2Fgate', null]]);
  assert.deepEqual(await readBranchHead({ repository: 'owner/app', branch: 'main', etag: '"e1"' }, { request: async (_, etag) => (assert.equal(etag, '"e1"'), { status: 304 }) }), { status: 304 });
  await assert.rejects(readBranchHead({ repository: 'owner/app', branch: 'main' }, { request: async () => ({ status: 200, data: { commit: { sha: 'nope' } } }) }), /no commit for main/);
  await assert.rejects(readBranchHead({ repository: 'owner/app', branch: 'main' }, { request: async () => { throw new Error('token ghp_secret leaked'); } }), (error: Error) => error.message === 'Could not read main from GitHub.');
  await assert.rejects(readBranchHead({ repository: '../etc', branch: 'main' }, { request }), /Connect a GitHub repository/);
});

test('a commit status is posted through gh api with raw fields', async () => {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  await postCommitStatus({ repository: 'owner/app', sha: SHA, state: 'pending', context: 'perpetual/Beta', description: 'Needs release' }, { run: async (file, args, options) => { calls.push({ file, args, env: options.env }); return { stdout: '{}' }; } });
  assert.equal(calls[0].file, 'gh');
  assert.deepEqual(calls[0].args, ['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', `repos/owner/app/statuses/${SHA}`, '-f', 'state=pending', '-f', 'context=perpetual/Beta', '-f', 'description=Needs release']);
  assert.equal(calls[0].env?.GH_PROMPT_DISABLED, '1');
});

test('invalid statuses are refused before gh runs, and gh failures return fixed messages', async () => {
  let ran = false;
  const run = async () => { ran = true; };
  for (const input of [
    { repository: 'owner/app', sha: 'short', state: 'pending', context: 'perpetual/Beta', description: 'Running' },
    { repository: 'owner/app', sha: SHA, state: 'queued', context: 'perpetual/Beta', description: 'Running' },
    { repository: 'owner/app', sha: SHA, state: 'pending', context: 'perpetual/Beta\n', description: 'Running' },
    { repository: 'owner/app', sha: SHA, state: 'pending', context: 'perpetual/Beta', description: 'x'.repeat(141) },
    // @ts-expect-error Deliberately invalid statuses, including the unknown state 'queued'.
  ]) await assert.rejects(postCommitStatus(input, { run }), /Invalid commit status/);
  assert.equal(ran, false);
  const denied = Object.assign(new Error('failed'), { stderr: 'HTTP 403: Resource not accessible by integration (token gho_secret)' });
  await assert.rejects(postCommitStatus({ repository: 'owner/app', sha: SHA, state: 'success', context: 'perpetual/Beta', description: 'Passed' }, { run: async () => { throw denied; } }),
    (error: Error) => error.message === 'GitHub denied the commit status. Check write access to this repository, then run the gate again.');
});

test('a refusal GitHub would repeat is marked refused; a rate limit, a timeout or a server error is not', async () => {
  const post = (failure: object) => postCommitStatus({ repository: 'owner/app', sha: SHA, state: 'pending', context: 'perpetual/Beta', description: 'Running' }, { run: async () => { throw Object.assign(new Error('failed'), failure); } })
    .then(() => assert.fail('The report must fail.'), (error: Error & { refused?: unknown }) => [error.message, error.refused === true]);
  const denied = 'GitHub denied the commit status. Check write access to this repository, then run the gate again.';
  assert.deepEqual(await post({ stderr: 'gh: Validation Failed (HTTP 422)' }), ['GitHub refused the commit status. Check that the commit is on GitHub, then run the gate again.', true]);
  assert.deepEqual(await post({ stderr: 'gh: Resource not accessible by integration (HTTP 403)' }), [denied, true]);
  assert.deepEqual(await post({ stderr: 'gh: Not Found (HTTP 404)' }), [denied, true]);
  assert.deepEqual(await post({ stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)' }), ['GitHub has temporarily limited requests. Wait before trying again.', false]);
  assert.deepEqual(await post({ killed: true }), ['Reporting the commit status timed out.', false]);
  assert.deepEqual(await post({ stderr: 'gh: Server Error (HTTP 502)' }), ['Reporting the commit status failed.', false]);
});

test('only a managed clone can be moved to a commit; the user checkout never is', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-gate-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = { repository: 'owner/app', branch: 'main', rootDirectory: '/', checkoutPath: dir, scanPath: dir };
  await assert.rejects(updateGitHubSource({ source, dataDir: join(dir, 'data'), sha: 'main' }), /Choose a commit/);
  await assert.rejects(updateGitHubSource({ source, dataDir: join(dir, 'data'), sha: SHA }), /managed GitHub checkout/);
});

test('a managed clone moves to a commit in place, one git operation at a time with its history sync', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-gate-source-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data'), checkoutPath = join(dataDir, 'sources', 'github-1', 'app'), log = join(dir, 'fetches.log');
  await mkdir(checkoutPath, { recursive: true });
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const git = (...args: string[]) => exec(realGit, ['-c', 'user.name=Perpetual', '-c', 'user.email=test@example.test', ...args], { cwd: checkoutPath });
  await git('init', '--quiet', '--initial-branch', 'main');
  await git('remote', 'add', 'origin', 'https://github.com/owner/app.git');
  const commit = async (text: string) => { await writeFile(join(checkoutPath, 'app.txt'), text); await git('add', 'app.txt'); await git('commit', '--quiet', '-m', text); return (await git('rev-parse', 'HEAD')).stdout.trim(); };
  const first = await commit('first'), second = await commit('second');
  // Git itself runs every local step; only the network fetch is replaced, and it records when it overlaps another.
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = fetch ]; then echo start >> "$PERPETUAL_TEST_FETCHES"; sleep 0.2; echo end >> "$PERPETUAL_TEST_FETCHES"; exit 0; fi\ndone\nexec "$PERPETUAL_TEST_GIT" "$@"\n');
  await chmod(join(bin, 'git'), 0o755);
  const saved = { PATH: process.env.PATH };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, PERPETUAL_TEST_FETCHES: log, PERPETUAL_TEST_GIT: realGit });
  t.after(() => { process.env.PATH = saved.PATH; delete process.env.PERPETUAL_TEST_FETCHES; delete process.env.PERPETUAL_TEST_GIT; });

  const source = { repository: 'owner/app', branch: 'main', rootDirectory: '/', checkoutPath, scanPath: checkoutPath };
  const [, moved] = await Promise.all([ensureGitHubHistory({ source, dataDir, refresh: true }), updateGitHubSource({ source, dataDir, sha: first })]);
  assert.deepEqual(moved, { sha: first });
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['start', 'end', 'start', 'end'], 'The history sync and the move never overlap.');
  assert.equal(await readFile(join(checkoutPath, 'app.txt'), 'utf8'), 'first');
  assert.equal((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim(), 'main', 'The clone stays on its branch at the same path.');
  assert.deepEqual(await updateGitHubSource({ source, dataDir, sha: second.toUpperCase() }), { sha: second });
  assert.equal(await readFile(join(checkoutPath, 'app.txt'), 'utf8'), 'second');
});
