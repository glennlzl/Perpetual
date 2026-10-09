import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, startServer } from './fixtures/controller.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';

const SHA = 'a'.repeat(40), time = '2026-09-29T10:00:00.000Z';

test('release API scopes requests to the current managed repository and requires gate evidence before a deployment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-release-api-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const source = { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: dir, checkoutPath: dir, sha: SHA, connectedAccount: 'tester', savedAt: time };
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: SHA, branch: 'main', remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: time };
  const stages = [{ id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' }, { id: 'beta', name: 'Beta', kind: 'sandbox' }, { id: 'production', name: 'Production', kind: 'production' }].map(stage => ({ ...stage, collapsed: false }));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, source, providers: [], pipelines: { 'github:acme/app:/': { repoPath: dir, stages, productionBranch: 'main' } }, githubConnection: { login: 'tester', connectedAt: time } } }));
  const app = await startServer({ port: 0, repo: dir, dataDir, github: {
    auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: { async session() { return { available: true, authenticated: true as const, account: { login: 'tester', name: null } }; }, async read(input) { return { repository: String(input.repository), sha: String(input.sha), runs: [] }; } },
    async head() { return { status: 200 as const, sha: SHA, etag: null }; },
    async build() { return { status: 'waiting' as const, reason: 'CI pending.' }; },
    async status() {},
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const post = async (path: string, input: unknown, authorized = true) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-perpetual-token': token } : {}) }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const response = await fetch(`${app.url}/api/releases?${new URLSearchParams({ repoPath: dir })}`);
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.repoPath, dir);
  assert.equal(view.sha, SHA);
  assert.equal(view.canDeploy, false);
  assert.match(view.blockedReason, /Sandbox|gate/i);
  assert.equal((await post('/api/releases/deploy', { repoPath: dir, sha: SHA })).status, 409);
  assert.equal((await post('/api/releases/deploy', { repoPath: '/another/source', sha: SHA })).status, 409);
  assert.equal((await post('/api/releases/deploy', { repoPath: dir, sha: SHA }, false)).status, 403);
  assert.equal((await post('/api/releases/configure', { repoPath: dir, target: { environment: 'preview' } })).status, 400);
  // Abandon names one release of the current source, and needs the launch token like every write.
  assert.deepEqual(await post('/api/releases/abandon', { repoPath: dir, id: 'release-elsewhere' }), { status: 404, body: { error: 'Release not found.' } });
  assert.equal((await post('/api/releases/abandon', { repoPath: dir, id: 'release-elsewhere' }, false)).status, 403);
  assert.equal((await post('/api/releases/abandon', { repoPath: '/another/source', id: 'release-elsewhere' })).status, 409);
  assert.equal((await fetch(`${app.url}/api/releases?repoPath=other`)).status, 409);
});

test('GitHub unreachable answers the release with why, never as a missing source, until GitHub answers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-release-api-')), dataDir = join(dir, 'data'), timedOut = 'Reading GitHub timed out. Check your connection and try again.';
  await mkdir(dataDir);
  const source = { repository: 'acme/app', branch: 'main', rootDirectory: '/', scanPath: dir, checkoutPath: dir, sha: SHA, connectedAccount: 'tester', savedAt: time };
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: SHA, branch: 'main', remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: time };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, source, pipelines: {}, githubConnection: { login: 'tester', connectedAt: time } } }));
  let reachable = false;
  const app = await startServer({ port: 0, repo: dir, dataDir, github: {
    auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: {
      async session() { return reachable ? { available: true, authenticated: true as const, account: { login: 'tester', name: null } } : { available: true, authenticated: false as const, account: null, message: timedOut, unreachable: true as const }; },
      async read(input) { return { repository: String(input.repository), sha: String(input.sha), runs: [] }; },
    },
    async head() { return { status: 200 as const, sha: SHA, etag: null }; },
    async build() { return { status: 'waiting' as const, reason: 'CI pending.' }; },
    async status() {},
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const view = async () => { const response = await fetch(`${app.url}/api/releases?${new URLSearchParams({ repoPath: dir })}`); return { status: response.status, body: await response.json() }; };
  assert.deepEqual(await view(), { status: 502, body: { error: timedOut } });
  reachable = true;
  const answered = await view();
  assert.deepEqual([answered.status, answered.body.sha, answered.body.blockedReason], [200, SHA, 'Choose a Production branch in Pipelines before deploying.']);
});
