import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { GITHUB_MESSAGES } from '../src/github-cli.ts';
import { getGitHubSession, listGitHubRepositories } from '../src/github-source.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import { fetch, startServer } from './fixtures/controller.ts';

test('repository choices expose only text display metadata while retaining validated identity and pagination', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-github-replies-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  const body = [
    { full_name: 'acme/ordinary', name: 'ordinary', private: true, default_branch: 'main' },
    { full_name: 'acme/unreadable', name: { unexpected: 'object' }, private: false, default_branch: ['main'] },
    { full_name: 'acme/absent' },
  ];
  const response = 'HTTP/2.0 200 OK\nLink: <https://api.github.com/user/repos?page=2>; rel="next"\n\n' + JSON.stringify(body);
  await writeFile(join(directory, 'gh'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(response)});\n`, { mode: 0o755 });
  process.env.PATH = directory + delimiter + (previousPath ?? '');
  assert.deepEqual(await listGitHubRepositories(), {
    repositories: [
      { fullName: 'acme/ordinary', name: 'ordinary', private: true, defaultBranch: 'main' },
      { fullName: 'acme/unreadable', name: null, private: false, defaultBranch: null },
      { fullName: 'acme/absent', name: null, private: false, defaultBranch: null },
    ],
    nextPage: 2,
  });
});

/** A GitHub CLI on PATH that answers the account check as the returned function last said: an account, or what gh prints when it fails. */
async function accountCheck(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-github-session-')), answer = join(directory, 'answer');
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'gh'), [
    `#!${process.execPath}`,
    `const answer = require('node:fs').readFileSync(${JSON.stringify(answer)}, 'utf8');`,
    `if (answer.startsWith('{')) process.stdout.write('HTTP/2.0 200 OK\\n\\n' + answer);`,
    'else { process.stderr.write(answer); process.exitCode = 1; }', '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = directory + delimiter + (previousPath ?? '');
  return (reply: string | object) => writeFile(answer, typeof reply === 'string' ? reply : JSON.stringify(reply));
}
const OFFLINE = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n';
const FAILED = 'Reading GitHub failed. Check your network connection and GitHub CLI account, then try again.';

test('an account check GitHub does not answer is unreachable, never signed out', async t => {
  const answer = await accountCheck(t);
  const session = async (reply: string | object) => { await answer(reply); return getGitHubSession(); };
  const unreachable = (message: string) => ({ available: true, authenticated: false, account: null, message, unreachable: true });
  assert.deepEqual(await session(OFFLINE), unreachable(FAILED));
  assert.deepEqual(await session('HTTP 502: Bad Gateway (https://api.github.com/user)\n'), unreachable(FAILED));
  assert.deepEqual(await session('gh: API rate limit exceeded for user ID 1. (HTTP 403)\n'), unreachable(GITHUB_MESSAGES['rate-limit']));
  // A CLI that is signed out, or whose token GitHub refuses, has no account: that is never unreachable.
  for (const signedOut of ['gh: Bad credentials (HTTP 401)\n', 'To get started with GitHub CLI, please run:  gh auth login\n']) {
    assert.deepEqual(await session(signedOut), { available: true, authenticated: false, account: null, message: GITHUB_MESSAGES.unauthenticated }, signedOut);
  }
  assert.deepEqual(await session({ login: 'octocat', name: 'Mona' }), { available: true, authenticated: true, account: { login: 'octocat', name: 'Mona' } });
});

test('a connection GitHub cannot verify for now is unreachable, not disconnected, a Disconnect stays not connected, and Connect waits for GitHub', async t => {
  const answer = await accountCheck(t);
  await answer(OFFLINE);
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-github-connection-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: 'a'.repeat(40), branch: 'main', remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-10-05T10:00:00.000Z' };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, pipelines: {}, githubConnection: { login: 'octocat', connectedAt: '2026-10-05T09:00:00.000Z' } } }));
  const app = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const connection = async () => { const { connected, unreachable, message } = await (await fetch(`${app.url}/api/github/connection`)).json(); return { connected, unreachable, message }; };
  assert.deepEqual(await connection(), { connected: false, unreachable: true, message: FAILED });
  const branches = await fetch(`${app.url}/api/github/branches?${new URLSearchParams({ repository: 'acme/app' })}`);
  assert.deepEqual([branches.status, (await branches.json()).error], [502, FAILED], 'A read that needs the account refuses as unreachable.');
  await answer({ login: 'octocat', name: null });
  assert.deepEqual(await connection(), { connected: true, unreachable: undefined, message: undefined }, 'The same connection, verified once GitHub answers.');
  await answer(OFFLINE);
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const post = async (action: string) => { const response = await fetch(`${app.url}/api/github/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: '{}' }); return { status: response.status, body: await response.json() }; };
  const disconnected = (await post('disconnect')).body;
  assert.deepEqual([disconnected.connected, disconnected.unreachable], [false, undefined], 'A deliberate Disconnect is not connected, whatever GitHub answers.');
  assert.deepEqual(await connection(), { connected: false, unreachable: undefined, message: FAILED });
  const refused = await post('connect');
  assert.deepEqual([refused.status, refused.body.error], [502, FAILED], 'Connect refuses as unreachable while GitHub does not answer.');
  assert.deepEqual(await connection(), { connected: false, unreachable: undefined, message: FAILED }, 'And connects nothing.');
  await answer({ login: 'octocat', name: null });
  const connected = await post('connect');
  assert.deepEqual([connected.status, connected.body.connected, connected.body.account?.login], [200, true, 'octocat']);
});
