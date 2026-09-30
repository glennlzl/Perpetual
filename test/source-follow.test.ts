import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateManager, type GateStage, type SourceHead } from '../src/gate/manager.ts';
import { startServer } from '../src/server.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import type { BranchHead, BranchHeadInput } from '../src/gate/github.ts';
import type { GitHubSession } from '../src/github-source.ts';
import { fixtureGit, managedCopy } from './fixtures/repair-box.ts';

// A pipeline without a Sandbox stage has no gate to move its managed source, so the source follows the watched head.
// GitHub, the source move and the scan are injected; nothing reaches GitHub.
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const KEY = 'github:owner/app:/';
const PLAIN: GateStage[] = [{ id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' }, { id: 'production', name: 'Production', kind: 'production' }];
const BETA: GateStage[] = [...PLAIN.slice(0, 2), { id: 'beta', name: 'Beta', kind: 'sandbox' }, PLAIN[2]];
const busy = () => Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409 });

async function harness(t: TestContext, { stages = PLAIN, heads = [], saved, outcomes = [] }: { stages?: GateStage[]; heads?: (BranchHead | ((input: BranchHeadInput) => BranchHead))[]; saved?: unknown; outcomes?: (Error | null)[] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-follow-'));
  if (saved) { await mkdir(join(dataDir, 'gates')); await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify(saved)); }
  const current = { key: KEY, branch: 'main' as string | null, sha: A as string | null, repository: 'owner/app' as string | null, stages };
  const follows: SourceHead[] = [], headCalls: BranchHeadInput[] = [], log: string[] = [];
  let connected = true;
  const manager = await createGateManager({
    // A fresh record per read, as the controller's is, so a change during a watch is visible to it.
    dataDir, source: () => ({ ...current }), retryInterval: 5,
    github: {
      connection: async () => (connected ? { login: 'glennlzl', repository: 'owner/app' } : null),
      async head(input) { headCalls.push(input); const next = heads.shift() ?? { status: 304 as const }; return typeof next === 'function' ? next(input) : next; },
      async post() {},
      async build() { return { status: 'passed' as const }; },
    },
    steps: { async prepare(gate) { log.push(`prepare ${gate.stageId} ${gate.sha[0]}`); return gate; }, journeys: () => 0, async rebuild() { return null; }, async run() { return null; } },
    // The controller moves the managed copy and rescans it, so the scanned commit becomes the head.
    async follow(head) { follows.push(head); const outcome = outcomes.shift(); if (outcome) throw outcome; current.sha = head.sha; },
  });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const gates = async () => JSON.parse(await readFile(join(dataDir, 'gates', 'state.json'), 'utf8')).gates;
  return { manager, current, follows, headCalls, log, gates, disconnect() { connected = false; } };
}

test('without a Sandbox stage the source follows each watched head that differs from its scanned commit, and no gate is queued', async t => {
  const h = await harness(t, { heads: [{ status: 200, sha: B, etag: '"1"' }, { status: 304 }, { status: 200, sha: C, etag: '"2"' }] });
  await h.manager.watch();
  assert.deepEqual(h.follows, [{ key: KEY, branch: 'main', sha: B }], 'The first head seen is followed: it is not a push, but it is the branch.');
  assert.equal(h.current.sha, B);
  await h.manager.watch();
  assert.equal(h.follows.length, 1, 'A head the source is already at moves nothing.');
  await h.manager.watch();
  assert.deepEqual(h.follows.map(head => head.sha), [B, C]);
  await h.manager.idle();
  assert.deepEqual(await h.gates(), []);
  assert.deepEqual(h.log, []);
  assert.equal(h.manager.view().watchError, undefined);
});

test('after a restart the saved head is followed although GitHub answers 304 for it', async t => {
  const h = await harness(t, { saved: { version: 1, gates: [], heads: { [KEY]: { branch: 'main', login: 'glennlzl', sha: B, etag: '"1"' } } } });
  await h.manager.watch();
  assert.equal(h.headCalls[0].etag, '"1"', 'The saved ETag is sent.');
  assert.deepEqual(h.follows, [{ key: KEY, branch: 'main', sha: B }]);
  await h.manager.watch();
  assert.equal(h.follows.length, 1);
});

test('a follow that cannot start now waits for the next poll silently; one that fails stays the watch error until one succeeds', async t => {
  const h = await harness(t, { heads: [{ status: 200, sha: B, etag: '"1"' }], outcomes: [busy(), new Error('Fetching the commit failed. Try again.'), new Error('Fetching the commit failed. Try again.'), null] });
  await h.manager.watch();
  assert.deepEqual([h.follows.length, h.manager.view().watchError], [1, undefined], 'A source change under way is not an error.');
  await h.manager.watch();
  assert.deepEqual([h.follows.length, h.manager.view().watchError], [2, 'Fetching the commit failed. Try again.']);
  await h.manager.watch();
  assert.deepEqual([h.follows.length, h.manager.view().watchError], [3, 'Fetching the commit failed. Try again.']);
  await h.manager.watch();
  assert.deepEqual([h.follows.length, h.current.sha, h.manager.view().watchError], [4, B, undefined]);
  await h.manager.watch();
  assert.equal(h.follows.length, 4);
});

test('with a Sandbox stage the watcher never moves the source: a new head queues the first Sandbox gate as before', async t => {
  const h = await harness(t, { stages: BETA, heads: [{ status: 200, sha: B, etag: '"1"' }, { status: 200, sha: C, etag: '"2"' }] });
  await h.manager.watch();
  assert.deepEqual(await h.gates(), [], 'The first head is a baseline.');
  await h.manager.watch();
  await h.manager.idle();
  assert.deepEqual((await h.gates()).map((gate: { stageId: string; sha: string }) => [gate.stageId, gate.sha]), [['beta', C]]);
  assert.deepEqual(h.log, ['prepare beta c']);
  assert.deepEqual(h.follows, [], 'Only a gate checking out a commit moves the source.');
  assert.equal(h.current.sha, A);
});

test('a source that changed, or gained a Sandbox stage, while its head was read is not moved; neither is an unmanaged or disconnected one', async t => {
  const h = await harness(t, { heads: [
    () => { h.current.branch = 'release'; return { status: 200, sha: B, etag: '"1"' }; },
    () => { h.current.stages = BETA; return { status: 304 }; },
  ] });
  await h.manager.watch();
  assert.deepEqual(h.follows, [], 'A head read for main is never followed on release.');
  h.current.branch = 'main';
  await h.manager.watch();
  assert.deepEqual(h.follows, [], 'A Sandbox stage added meanwhile leaves the move to its gate.');
  h.current.stages = PLAIN;
  await h.manager.watch();
  assert.deepEqual(h.follows, [{ key: KEY, branch: 'main', sha: B }], 'The head saved for main is followed.');
  h.current.sha = A;
  h.current.repository = null;
  await h.manager.watch();
  h.current.repository = 'owner/app';
  h.disconnect();
  await h.manager.watch();
  assert.equal(h.follows.length, 1, 'A local checkout or a disconnected account never moves.');
});

// The controller as it runs: a managed copy under the data directory at commit A, its branch main at a later commit on
// GitHub, and the copy's move injected as a local reset; the account, head and statuses are fakes.
const SESSION: GitHubSession = { available: true, authenticated: true, account: { login: 'glennlzl', name: null } };
async function controller(t: TestContext, { stages, head, failing = false }: { stages?: GateStage[]; head?: 'saved'; failing?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-follow-controller-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const { checkoutPath, sha } = await managedCopy(dataDir);
  await writeFile(join(checkoutPath, 'README.md'), 'A calculator.\n');
  fixtureGit(checkoutPath, 'add', 'README.md');
  fixtureGit(checkoutPath, 'commit', '--quiet', '-m', 'Describe the calculator');
  const next = fixtureGit(checkoutPath, 'rev-parse', 'HEAD');
  fixtureGit(checkoutPath, 'reset', '--quiet', '--hard', sha);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: checkoutPath, name: 'app', sha, branch: 'main', remote: 'https://github.com/owner/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-25T10:00:00.000Z' };
  const source = { scanPath: checkoutPath, checkoutPath, repository: 'owner/app', branch: 'main', rootDirectory: '/', sha, connectedAccount: 'glennlzl', savedAt: '2026-09-25T09:00:00.000Z' };
  const pipelines = stages ? { [KEY]: { repoPath: checkoutPath, stages: stages.map(stage => ({ ...stage, collapsed: false })) } } : {};
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, providers: [], pipelines, githubConnection: { login: 'glennlzl', connectedAt: '2026-09-25T09:00:00.000Z' }, source } }));
  // The head the watcher saved before a restart, whose ETag GitHub answers with 304.
  if (head === 'saved') { await mkdir(join(dataDir, 'gates')); await writeFile(join(dataDir, 'gates', 'state.json'), JSON.stringify({ version: 1, gates: [], heads: { [KEY]: { branch: 'main', login: 'glennlzl', sha: next, etag: `"${next}"` } } })); }
  const moves: string[] = [], heads: BranchHeadInput[] = [];
  app = await startServer({
    port: 0, repo: dir, dataDir, gate: { pollInterval: 20 },
    github: {
      auth: { isPending: () => false, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
      runs: { async session() { return SESSION; }, async read() { throw new Error('unused'); } },
      async head(input) { heads.push(input); return input.etag === `"${next}"` ? { status: 304 } : { status: 200, sha: next, etag: `"${next}"` }; },
      async status() {},
      async update(input) {
        const target = String(input?.sha);
        moves.push(target);
        if (failing) throw new Error('Fetching the commit failed. Try again.');
        fixtureGit(checkoutPath, 'reset', '--quiet', '--hard', target);
        return { sha: target };
      },
    },
  });
  const { url } = app;
  const read = async (path: string) => (await fetch(`${url}${path}`)).json();
  async function until<T>(path: string, check: (body: T) => unknown) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) { const body = await read(path) as T; if (check(body)) return body; await new Promise(done => setTimeout(done, 5)); }
    throw new Error(`${path} did not settle.`);
  }
  return { sha, next, checkoutPath, moves, heads, read, until, recover() { failing = false; } };
}
type GateBody = { repoPath: string; sha: string | null; watchError?: string };
type StateBody = { scan: { repo: { sha: string } }; source: { sha: string } };

test('the controller moves a managed source without a Sandbox stage to its branch head and rescans it', async t => {
  const c = await controller(t);
  const view = await c.until<GateBody>('/api/gate', body => body.sha === c.next);
  assert.equal(view.repoPath, c.checkoutPath, 'The managed copy moves in place.');
  assert.deepEqual(c.moves, [c.next]);
  assert.equal(fixtureGit(c.checkoutPath, 'rev-parse', 'HEAD'), c.next);
  const state = await c.read('/api/state') as StateBody;
  assert.deepEqual([state.scan.repo.sha, state.source.sha], [c.next, c.next], 'Source and Build show the rescanned commit.');
});

test('after a restart the controller follows the saved head that GitHub answers with 304', async t => {
  const c = await controller(t, { head: 'saved' });
  await c.until<GateBody>('/api/gate', body => body.sha === c.next);
  assert.ok(c.heads.some(input => input.etag === `"${c.next}"`), 'The watcher sent its saved ETag.');
  assert.deepEqual(c.moves, [c.next]);
});

test('a move that fails is the gate view\'s watch error and is tried again at the next poll', async t => {
  const c = await controller(t, { failing: true });
  const failed = await c.until<GateBody>('/api/gate', body => body.watchError && c.moves.length >= 2);
  assert.deepEqual([failed.sha, failed.watchError], [c.sha, 'Fetching the commit failed. Try again.'], 'The error stays while each poll fails again.');
  c.recover();
  const moved = await c.until<GateBody>('/api/gate', body => body.sha === c.next);
  assert.equal(moved.watchError, undefined);
  const tries = c.moves.length;
  assert.ok(c.moves.every(sha => sha === c.next));
  assert.equal((await c.until<GateBody>('/api/gate', () => c.heads.length > tries + 3)).sha, c.next);
  assert.equal(c.moves.length, tries, 'A source at the head moves no more.');
});

test('with a Sandbox stage the controller\'s watcher leaves the source at its scanned commit', async t => {
  const c = await controller(t, { stages: BETA });
  // Head reads with the saved ETag show the watcher polled after its baseline.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && c.heads.filter(input => input.etag === `"${c.next}"`).length < 3;) await new Promise(done => setTimeout(done, 5));
  assert.ok(c.heads.filter(input => input.etag === `"${c.next}"`).length >= 3);
  assert.deepEqual(c.moves, []);
  assert.equal(((await c.read('/api/gate')) as GateBody).sha, c.sha);
});
