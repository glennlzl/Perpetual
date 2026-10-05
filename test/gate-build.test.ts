import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateManager, type BuildVerdict, type GateSource } from '../src/gate/manager.ts';
import type { CommitStatusPost } from '../src/gate/github.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), P = 'f'.repeat(40);
type Build = BuildVerdict;
const until = async (condition: () => boolean) => {
  for (let count = 0; count < 200 && !condition(); count++) await delay(5);
  assert.ok(condition(), 'The expected gate state must arrive.');
};

async function harness(t: TestContext, { managed = true, dataDir: existing, retryInterval = 10 }: { managed?: boolean; dataDir?: string; retryInterval?: number } = {}) {
  const dataDir = existing ?? await mkdtemp(join(tmpdir(), 'perpetual-build-gate-'));
  const state = {
    source: { key: 'github:acme/app:/', branch: 'main', sha: A, repository: managed ? 'acme/app' : null, stages: [{ id: 'beta', name: 'Beta', kind: 'sandbox' }] } as GateSource,
    head: A, build: { status: 'waiting', reason: 'CI is running.' } as Build, journeys: 1, failPost: false,
    read: null as null | (() => Promise<Build>),
  };
  const work: string[] = [], reads: { repository: string; branch: string | null; sha: string; login: string }[] = [], posts: CommitStatusPost[] = [];
  const github = {
    connection: async () => ({ repository: state.source.repository || 'acme/app', login: 'tester' }),
    head: async () => ({ status: 200 as const, sha: state.head, etag: null }),
    post: async (input: CommitStatusPost) => { if (state.failPost) throw new Error('Status write unavailable.'); posts.push(input); },
    build: async (input: typeof reads[number]) => { reads.push(input); return state.read ? state.read() : state.build; },
  };
  const manager = await createGateManager({ dataDir, source: () => state.source, github, retryInterval,
    steps: {
      prepare: async gate => { work.push(`prepare ${gate.sha}`); return gate; },
      journeys: () => state.journeys,
      rebuild: async gate => { work.push(`rebuild ${gate.sha}`); return { id: 'twin' }; },
      run: async gate => { work.push(`run ${gate.sha}`); return { status: 'passed' }; },
    },
  });
  t.after(async () => { await manager.close(); if (!existing) await rm(dataDir, { recursive: true, force: true }); });
  return { manager, state, work, reads, posts, dataDir, github };
}

// Without admission before prepare, the first assertion catches source movement and twin work while CI is pending.
test('a managed manual gate waits for its exact branch commit build before any source or twin work', async t => {
  const h = await harness(t);
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.deepEqual(h.work, []);
  assert.equal(h.manager.view().stages.beta.status, 'waiting-build');
  assert.equal(h.manager.view().production, null);
  assert.deepEqual(h.reads[0], { repository: 'acme/app', branch: 'main', sha: A, login: 'tester' });
  assert.ok(h.posts.some(post => post.sha === A && post.state === 'pending'));
  h.state.build = { status: 'passed' };
  await until(() => h.manager.view().stages.beta.status === 'passed');
  await h.manager.idle();
  assert.deepEqual(h.work, [`prepare ${A}`, `rebuild ${A}`, `run ${A}`]);
});

test('a failed build cannot be manually released and a successful same-commit rerun admits it automatically', async t => {
  const h = await harness(t);
  h.state.build = { status: 'blocked', reason: 'CI failed.' };
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.deepEqual(h.work, []);
  assert.equal(h.manager.view().stages.beta.status, 'build-failed');
  assert.ok(h.posts.some(post => post.state === 'failure'));
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: A, login: 'tester' }), /build|does not need release/i);
  h.state.build = { status: 'passed' };
  await until(() => h.manager.view().stages.beta.status === 'passed');
  assert.equal(h.work.filter((step: string) => step.startsWith('run')).length, 1);
});

test('a GitHub read error remains waiting and cannot become a releasable journey verdict', async t => {
  const h = await harness(t);
  h.state.read = async () => { throw new Error('GitHub is unavailable.'); };
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'waiting-build');
  assert.match(h.manager.view().stages.beta.reason!, /GitHub is unavailable/);
  assert.deepEqual(h.work, []);
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: A, login: 'tester' }));
});

test('a newer push supersedes a build wait even when the older build read returns passed later', async t => {
  const h = await harness(t);
  const reading = Promise.withResolvers<void>(), finish = Promise.withResolvers<Build>();
  h.state.read = async () => { reading.resolve(); return finish.promise; };
  await h.manager.run({ stageId: 'beta' });
  await reading.promise;
  h.state.head = B;
  await h.manager.watch();
  h.state.read = null;
  h.state.build = { status: 'passed' };
  finish.resolve({ status: 'passed' });
  await h.manager.idle();
  assert.deepEqual(h.work, [`prepare ${B}`, `rebuild ${B}`, `run ${B}`]);
  const saved = JSON.parse(await readFile(join(h.dataDir, 'gates/state.json'), 'utf8'));
  assert.equal(saved.gates.find((gate: { sha: string }) => gate.sha === A).status, 'superseded');
});

test('a baseline head supersedes an older gate still waiting at the first stage, so it never moves the source back', async t => {
  const h = await harness(t);
  await h.manager.watch(); // baseline A
  h.state.head = B;
  await h.manager.watch(); // push B while its Build runs
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'waiting-build');
  const main = h.state.source;
  h.state.source = { ...main, branch: 'release' };
  await h.manager.watch(); // the other branch's first head is a baseline
  h.state.source = main;
  h.state.head = C;
  h.state.build = { status: 'passed' };
  await h.manager.watch(); // back on main at C, a baseline again; B's Build has passed meanwhile
  await h.manager.idle();
  assert.deepEqual(h.work, []);
  const saved = JSON.parse(await readFile(join(h.dataDir, 'gates/state.json'), 'utf8'));
  assert.deepEqual(saved.gates.map((gate: { sha: string; status: string }) => [gate.sha, gate.status]), [[B, 'superseded']]);
  assert.equal(h.manager.view().stages.beta, undefined);
});

test('a source switch during build evidence reading cannot prepare either source from stale evidence', async t => {
  const h = await harness(t);
  const reading = Promise.withResolvers<void>(), finish = Promise.withResolvers<Build>();
  h.state.read = async () => { reading.resolve(); return finish.promise; };
  await h.manager.run({ stageId: 'beta' });
  await reading.promise;
  h.state.source = { ...h.state.source, key: 'github:acme/other:/', repository: 'acme/other' };
  finish.resolve({ status: 'passed' });
  await h.manager.idle();
  assert.deepEqual(h.work, []);
  assert.deepEqual(h.manager.view().stages, {});
});

test('build waits resume after restart without becoming manually releasable', async t => {
  const first = await harness(t, { retryInterval: 60_000 });
  await first.manager.run({ stageId: 'beta' });
  await first.manager.idle();
  assert.equal(first.manager.view().stages.beta.status, 'waiting-build');
  await first.manager.close();
  const second = await harness(t, { dataDir: first.dataDir });
  assert.equal(second.manager.view().stages.beta.status, 'waiting-build');
  second.state.build = { status: 'passed' };
  second.manager.start();
  await second.manager.idle();
  assert.equal(second.manager.view().stages.beta.status, 'passed');
});

test('a repair gate can verify its PR while the target branch is blocked on a failed build', async t => {
  const h = await harness(t);
  h.state.build = { status: 'blocked', reason: 'CI failed.' };
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  const result = await h.manager.runRepair({ key: h.state.source.key, repair: 'repair-1', branch: 'perpetual/repair/aaaaaaa', sha: P, snapshot: join(h.dataDir, 'repair') });
  assert.equal(result.gates[0].status, 'passed');
  assert.deepEqual(h.work, [`prepare ${P}`, `rebuild ${P}`, `run ${P}`]);
  assert.equal(h.reads.some(read => read.sha === P), false, 'Repair CI admission belongs to the repair controller.');
  assert.equal(h.manager.view().production, null);
});

test('a local checkout still supports a gate without GitHub CI', async t => {
  const h = await harness(t, { managed: false });
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'passed');
  assert.deepEqual(h.reads, []);
});

test('missing Build verification wiring never defaults to a successful managed build', async t => {
  const h = await harness(t);
  Reflect.deleteProperty(h.github, 'build');
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'waiting-build');
  assert.match(h.manager.view().stages.beta.reason!, /unavailable/);
  assert.deepEqual(h.work, []);
});

test('manual release rechecks CI without rerunning an already finished journey', async t => {
  const h = await harness(t);
  h.state.build = { status: 'passed' };
  h.state.journeys = 0;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.view().stages.beta.status, 'needs-release');
  h.state.build = { status: 'blocked', reason: 'CI failed.' };
  await assert.rejects(h.manager.release({ stageId: 'beta', sha: A, login: 'tester' }), /CI failed/);
  assert.equal(h.manager.view().production, null);
  assert.equal(h.manager.view().stages.beta.status, 'needs-release');
  assert.deepEqual(h.work, [`prepare ${A}`]);
});

test('release evidence requires every current Sandbox gate for the exact commit and its successful GitHub report', async t => {
  const h = await harness(t);
  h.state.build = { status: 'passed' };
  h.state.failPost = true;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.equal(h.manager.releaseEvidence(A), null, 'A local pass whose status failed to report cannot deploy.');
  h.state.failPost = false;
  h.manager.start();
  await h.manager.idle();
  const evidence = h.manager.releaseEvidence(A);
  assert.ok(evidence);
  assert.deepEqual([evidence.key, evidence.repository, evidence.branch, evidence.sha], ['github:acme/app:/', 'acme/app', 'main', A]);
  assert.equal(evidence.stages[0].context, 'perpetual/Beta');
  assert.equal(evidence.stages[0].status, 'passed');
  assert.equal(evidence.stages[0].gateId, h.manager.view().stages.beta.id);
  assert.equal(h.manager.releaseEvidence(B), null);
  h.state.source.stages = [...h.state.source.stages, { id: 'gamma', name: 'Gamma', kind: 'sandbox' }];
  assert.equal(h.manager.releaseEvidence(A), null, 'A new Sandbox stage must have its own gate.');
  h.state.source.stages = [];
  assert.equal(h.manager.releaseEvidence(A), null, 'No stages is not release evidence.');
});

test('release evidence records manual decisions and preserves the context actually reported before a rename', async t => {
  const h = await harness(t);
  h.state.build = { status: 'passed' };
  h.state.journeys = 0;
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  await h.manager.release({ stageId: 'beta', sha: A, login: 'tester' });
  await h.manager.idle();
  h.state.source.stages = [{ id: 'beta', name: 'Acceptance', kind: 'sandbox' }];
  const evidence = h.manager.releaseEvidence(A);
  assert.ok(evidence);
  assert.equal(evidence.stages[0].name, 'Acceptance');
  assert.equal(evidence.stages[0].context, 'perpetual/Beta');
  assert.equal(evidence.stages[0].releasedBy, 'tester');
  assert.ok(evidence.stages[0].releasedAt);
  evidence.stages[0].status = 'passed';
  assert.equal(h.manager.releaseEvidence(A)?.stages[0].status, 'released', 'Callers cannot change a stored gate through the evidence.');
});

test('a previous passed commit stops being deployable when a newer watched head is waiting for Build', async t => {
  const h = await harness(t);
  h.state.build = { status: 'passed' };
  await h.manager.run({ stageId: 'beta' });
  await h.manager.idle();
  assert.ok(h.manager.releaseEvidence(A));
  h.state.build = { status: 'waiting', reason: 'CI is running.' };
  h.state.head = B;
  await h.manager.watch();
  await h.manager.idle();
  assert.equal(h.state.source.sha, A, 'Build admission has not moved the source copy.');
  assert.equal(h.manager.view().stages.beta.sha, B);
  assert.equal(h.manager.releaseEvidence(A), null, 'Historical passes are not the latest release candidate.');
  assert.equal(h.manager.releaseEvidence(B), null, 'The new head has not passed its gates.');
});
