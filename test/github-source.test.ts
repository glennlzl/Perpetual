import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureGitHubHistory, listGitHubBranches, listGitHubRepositories, prepareGitHubSource, updateGitHubSource } from '../src/github-source.ts';
import { readGitHistory } from '../src/git-history.ts';
import { startServer } from '../src/server.ts';
import type { SourceReply } from '../contract/pipeline.ts';

const exec = promisify(execFile);

/**
 * GitHub, played on disk. gh answers each API read from `replies`, by endpoint, and git clones and fetches
 * https://github.com/ from bare repositories under origin/ through an insteadOf rule that only those two commands see,
 * so a managed copy keeps GitHub's address and the real fetch flags run. `commit` pushes acme/app's main branch.
 */
async function github(t: TestContext, replies: Record<string, unknown> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-github-source-')));
  const bin = join(dir, 'bin'), work = join(dir, 'work'), origin = join(dir, 'origin/acme/app.git'), repliesFile = join(dir, 'replies.json');
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await mkdir(bin);
  await writeFile(join(bin, 'git'), [
    '#!/bin/sh', 'network=',
    'for arg do', '  shift', '  case "$arg" in', '    clone|fetch) network=1 ;;', '    protocol.file.allow=never) arg=protocol.file.allow=always ;;', '  esac', '  set -- "$@" "$arg"', 'done',
    `if [ -n "$network" ]; then exec "${realGit}" -c "url.file://${dir}/origin/.insteadOf=https://github.com/" "$@"; fi`,
    `exec "${realGit}" "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  await writeFile(join(bin, 'gh'), [
    `#!${process.execPath}`,
    `const replies = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(repliesFile)}, 'utf8')), endpoint = process.argv.at(-1);`,
    `if (!Object.hasOwn(replies, endpoint)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }`,
    `process.stdout.write('HTTP/2.0 200 OK\\n\\n' + JSON.stringify(replies[endpoint]));`, '',
  ].join('\n'), { mode: 0o755 });
  const answer = (next: Record<string, unknown>) => writeFile(repliesFile, JSON.stringify(next));
  await answer(replies);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(async () => { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); });
  const git = (...args: string[]) => exec(realGit, ['-c', 'user.name=Perpetual', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, ...args]);
  await git('init', '--quiet', '--bare', origin);
  await git('-C', origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await git('init', '--quiet', '--initial-branch', 'main', work);
  /** Writes (or, with null, removes) files in the working repository, commits them and pushes main; the new commit. */
  const commit = async (files: Record<string, string | null>) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) await rm(join(work, name), { recursive: true, force: true });
      else { await mkdir(dirname(join(work, name)), { recursive: true }); await writeFile(join(work, name), content); }
    }
    await git('-C', work, 'add', '--all');
    await git('-C', work, 'commit', '--quiet', '--allow-empty', '-m', `commit ${Object.keys(files).join(', ')}`);
    await git('-C', work, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
    return (await git('-C', work, 'rev-parse', 'HEAD')).stdout.trim();
  };
  return { dir, dataDir: join(dir, 'data'), commit, push: (...args: string[]) => git('-C', work, 'push', '--quiet', origin, ...args), git: (...args: string[]) => git('-C', work, ...args) };
}

/** The controller signed in to GitHub as developer, with `state` saved, for `work`; it closes before GitHub's fixture goes. */
async function withController(t: TestContext, state: object, work: (controller: { dataDir: string; connect(input: object): Promise<{ status: number; body: SourceReply }> }) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-github-controller-'))), dataDir = join(dir, 'data');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan: null, providers: [], pipelines: {}, githubConnection: { login: 'developer', connectedAt: '2026-09-25T09:00:00.000Z' }, ...state } }));
  const app = await startServer({ port: 0, repo: dir, dataDir });
  try {
    const { token } = await (await fetch(`${app.url}/api/session`)).json();
    await work({ dataDir, async connect(input) {
      const response = await fetch(`${app.url}/api/source/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    } });
  } finally { await app.close(); }
}

test('a row GitHub lists that cannot be chosen is left out of its page instead of failing it', async t => {
  await github(t, {
    'user/repos?per_page=100&page=1&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member': [
      { full_name: 'acme/app', name: 'app', private: true, default_branch: 'main' },
      { full_name: 'mona_acme/dotfiles', name: 'dotfiles', private: false, default_branch: 'main' },
      { full_name: '../etc' }, { full_name: 42 }, null,
    ],
    'repos/acme/app': { default_branch: 'main' },
    'repos/acme/app/branches?per_page=100&page=1': [{ name: 'main' }, { name: 'release./next' }, { name: 'bad..name' }, { name: 'a branch' }, {}],
  });
  assert.deepEqual(await listGitHubRepositories(), { nextPage: null, repositories: [
    { fullName: 'acme/app', name: 'app', private: true, defaultBranch: 'main' },
    { fullName: 'mona_acme/dotfiles', name: 'dotfiles', private: false, defaultBranch: 'main' },
  ] }, 'An Enterprise Managed User\'s repository is listed beside the others.');
  assert.deepEqual(await listGitHubBranches({ repository: 'acme/app' }), { branches: [{ name: 'main' }, { name: 'release./next' }], nextPage: null, defaultBranch: 'main' });
});

test('connecting a source clones only its branch, scans a root without links, and leaves nothing behind when it fails', async t => {
  const hub = await github(t, { 'repos/acme/app/branches/main': { name: 'main' }, 'repos/acme/app/branches/release': { name: 'release' } });
  await hub.commit({ 'apps/web/package.json': '{}\n' });
  await symlink('web', join(hub.dir, 'work/apps/linked'));
  const head = await hub.commit({});
  // GitHub also holds another branch and a tag, which a copy of main never does.
  await hub.push(`${head}:refs/heads/feature`);
  await hub.git('tag', 'v1');
  await hub.push('refs/tags/v1');
  const connect = (branch: string, rootDirectory: string) => prepareGitHubSource({ repository: 'acme/app', branch, rootDirectory, dataDir: hub.dataDir });
  const source = await connect('main', 'apps/web/');
  assert.deepEqual([source.repository, source.branch, source.rootDirectory, source.sha, source.scanPath], ['acme/app', 'main', '/apps/web', head, join(source.checkoutPath, 'apps', 'web')]);
  const copy = (...args: string[]) => exec('git', ['-C', source.checkoutPath, ...args]).then(({ stdout }) => stdout.trim());
  assert.deepEqual([await copy('config', '--get', 'remote.origin.url'), await copy('symbolic-ref', '--short', 'HEAD'), await copy('rev-parse', '--is-shallow-repository')], ['https://github.com/acme/app.git', 'main', 'true']);
  assert.deepEqual((await copy('for-each-ref', '--format=%(refname)')).split('\n'), ['refs/heads/main', 'refs/remotes/origin/main'], 'The copy holds its branch alone.');
  const sources = join(hub.dataDir, 'sources'), kept = await readdir(sources);
  await assert.rejects(connect('main', '/apps/linked'), /without symbolic links/);
  await assert.rejects(connect('main', '/apps/none'), /does not exist in this branch/);
  // GitHub names release a branch, but the repository holds only a tag of that name: clone would check the tag out.
  await hub.git('tag', 'release');
  await hub.push('refs/tags/release');
  await assert.rejects(connect('release', '/'));
  await assert.rejects(connect('v1', '/'), /unavailable to your GitHub account/, 'A name GitHub does not list as a branch is never cloned.');
  assert.deepEqual(await readdir(sources), kept, 'A failed connection removes its private checkout.');
});

test('after the copy moves to a pushed commit, its branch graph reaches that commit without a refresh', async t => {
  const hub = await github(t, { 'repos/acme/app/branches/main': { name: 'main' } });
  const first = await hub.commit({ 'README.md': 'one\n' });
  const source = await prepareGitHubSource({ repository: 'acme/app', branch: 'main', dataDir: hub.dataDir });
  const graph = async () => {
    await ensureGitHubHistory({ source, dataDir: hub.dataDir });
    const history = await readGitHistory({ repo: { path: source.scanPath, remote: 'https://github.com/acme/app.git', name: 'app' } }, { scope: 'current', currentRef: 'refs/remotes/origin/main' });
    return history.commits.map(commit => commit.hash);
  };
  assert.deepEqual(await graph(), [first]);
  const second = await hub.commit({ 'README.md': 'two\n' });
  assert.deepEqual(await updateGitHubSource({ source, dataDir: hub.dataDir, sha: second }), { sha: second });
  assert.deepEqual(await graph(), [second, first], 'The scanned commit heads the graph.');
});

test('a commit that removes the root directory never strands the copy before a commit that restores it', async t => {
  const hub = await github(t, { 'repos/acme/app/branches/main': { name: 'main' } });
  await hub.commit({ 'apps/web/package.json': '{}\n' });
  const source = await prepareGitHubSource({ repository: 'acme/app', branch: 'main', rootDirectory: '/apps/web', dataDir: hub.dataDir });
  const removed = await hub.commit({ 'apps/web': null, 'apps/site/package.json': '{}\n' });
  await assert.rejects(updateGitHubSource({ source, dataDir: hub.dataDir, sha: removed }), /root directory does not exist in this branch/);
  const restored = await hub.commit({ 'apps/web/package.json': '{"name":"web"}\n' });
  assert.deepEqual(await updateGitHubSource({ source, dataDir: hub.dataDir, sha: restored }), { sha: restored });
  assert.equal(await readFile(join(source.scanPath, 'package.json'), 'utf8'), '{"name":"web"}\n');
  // A commit that turns the root into a link is refused at that commit, before anything reads through it.
  await rm(join(hub.dir, 'work/apps/web'), { recursive: true });
  await symlink('site', join(hub.dir, 'work/apps/web'));
  await assert.rejects(updateGitHubSource({ source, dataDir: hub.dataDir, sha: await hub.commit({}) }), /without symbolic links/);
});

test('a root directory typed in another letter case is saved as the checkout spells it', async t => {
  const hub = await github(t, { 'repos/acme/app/branches/main': { name: 'main' } });
  await hub.commit({ 'Backend/api/package.json': '{}\n' });
  if (!await lstat(join(hub.dir, 'WORK')).then(() => true, () => false)) return t.skip('The file system distinguishes letter case.');
  const source = await prepareGitHubSource({ repository: 'acme/app', branch: 'main', rootDirectory: '/backend/API', dataDir: hub.dataDir });
  // A repair's host copy builds the scan path from the saved root, so the two must agree.
  assert.deepEqual([source.rootDirectory, source.scanPath], ['/Backend/api', join(source.checkoutPath, 'Backend', 'api')]);
});

test('a connection whose save fails removes the copy it made', async t => {
  const hub = await github(t, { user: { login: 'developer' }, 'repos/acme/app/branches/main': { name: 'main' } });
  await hub.commit({ 'README.md': 'one\n' });
  await withController(t, {}, async ({ dataDir, connect }) => {
    // The state file can no longer be replaced, so the save fails after the copy is cloned and scanned.
    await rm(join(dataDir, 'state.json'));
    await mkdir(join(dataDir, 'state.json', 'kept'), { recursive: true });
    assert.equal((await connect({ repository: 'acme/app', branch: 'main', rootDirectory: '/' })).status, 400);
    assert.deepEqual(await readdir(join(dataDir, 'sources')), [], 'A copy that was never saved does not stay behind.');
  });
});
