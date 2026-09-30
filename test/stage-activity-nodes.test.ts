import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageDataCache, stageNodeData, stageServices } from '../client/src/lib/pipeline-nodes.ts';
import { createHealthBeats } from '../client/src/lib/pipeline-health.ts';
import type { BuildSummary, BuildReply } from '../client/src/lib/pipeline-github.ts';
import type { BrowserView, Environment } from '../client/src/lib/test-workspace.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
const stages = [
  { id: 'source', kind: 'source', name: 'Source' }, { id: 'build', kind: 'build', name: 'Build' },
  { id: 'beta', kind: 'sandbox', name: 'Beta' }, { id: 'gamma', kind: 'sandbox', name: 'Gamma' }, { id: 'production', kind: 'production', name: 'Production' },
];
const pipeline = { stages, transitions: stages.slice(1).map((stage, index) => ({ id: `${stages[index].id}-${stage.id}`, source: stages[index].id, target: stage.id, blocked: false })) };
const callbacks = { openDialog() {}, toggleStage() {}, addTest() {}, createSandbox() {} };
// Shapes follow /api/state as structurally shared by the test workspace.
type Row = { id: string; label?: string; kind?: string; provider?: string };
type Scan = { repo: { path: string; sha: string }; scannedAt: string; workflows: { file: string }[]; delivery: { source: Row[]; build: Row[]; production: Row[] } };
const scanFixture = (): Scan => ({ repo: { path: '/work/storefront', sha: SHA }, scannedAt: '2026-09-23T10:00:00.000Z', workflows: [{ file: '.github/workflows/ci.yml' }], delivery: { source: [{ id: 'repo', label: 'storefront' }], build: [{ id: 'github', kind: 'github-actions', provider: 'GitHub' }], production: [] } });
const betaEnvironment: Environment = { id: 'env-beta', stageId: 'beta', status: 'ready', step: 'Ready', sourceRevision: SHA, health: { checkedAt: '2026-09-23T10:00:30.000Z', ok: true, consecutiveFailures: 0 } };
const betaTests: Partial<BrowserView> = { cases: [{ id: 'create-and-run', name: 'Create, save and run a workflow' }], runs: [], preparation: { status: 'completed' } };
const gammaTests = (progress: number): Partial<BrowserView> => ({ cases: [{ id: 'checkout', name: 'Buy credits and run a workflow' }], runs: [{ id: 'run-gamma', mode: 'run', status: 'running', progress: { revision: progress, cases: [{ id: 'checkout', status: 'running' }] } }], preparation: null });

function context({ scan = scanFixture(), environments = [betaEnvironment], browserTests = { beta: betaTests, gamma: gammaTests(1) }, build = null, github = null, arrivals = {}, healthBeat = createHealthBeats() }: {
  scan?: Scan; environments?: Environment[]; browserTests?: Record<string, Partial<BrowserView>>; build?: BuildSummary | null; github?: BuildReply | null; arrivals?: Record<string, string>; healthBeat?: (environment: Environment | undefined) => string;
} = {}) {
  const latest = Object.fromEntries(stages.map(stage => [stage.id, environments.find(item => item.stageId === stage.id)]));
  return { scan, pipeline, sha: SHA, latest, snapshot: { environments, browserTests, stageRemovals: [] }, arrivals, healthBeat, build, github, selection: null, selectedStageId: null, busyStages: [], busy: false, ...callbacks };
}

test('stages without delivery rows share one frozen empty list across scans', () => {
  const first = scanFixture(), second = scanFixture();
  for (const stage of stages.filter(item => ['sandbox', 'production'].includes(item.kind))) {
    assert.equal(stageServices(first, stage), stageServices(second, stage), stage.id);
    assert.equal(Object.isFrozen(stageServices(first, stage)), true);
  }
  assert.equal(stageServices({}, stages[0]), stageServices(null, stages[1]), 'A scan without delivery rows reuses the same empty list.');
  assert.equal(stageServices(first, stages[1]), first.delivery.build);
});

test('an unrelated poll keeps the sandbox and Production node data identity', () => {
  const reuse = createStageDataCache(), healthBeat = createHealthBeats();
  const gammaCreating: Environment = { id: 'env-gamma', stageId: 'gamma', status: 'creating', step: 'Creating sandbox', sourceRevision: SHA };
  const first = context({ environments: [betaEnvironment, gammaCreating], build: { status: 'running', sha: 'cb9292c' }, healthBeat });
  const before = Object.fromEntries(stages.map(stage => [stage.id, reuse(stage.id, stageNodeData(stage, first))]));
  // Another stage's browser progress, its environment step, GitHub status and a
  // reloaded scan all change; Beta's own records keep their identity.
  const second = context({
    scan: scanFixture(), environments: [betaEnvironment, { ...gammaCreating, step: 'Preparing application' }],
    browserTests: { beta: betaTests, gamma: gammaTests(2) }, build: { status: 'passed', sha: 'cb9292c' }, arrivals: { gamma: 'env-gamma:2026-09-23T10:01:00.000Z' }, healthBeat,
  });
  const after = Object.fromEntries(stages.map(stage => [stage.id, reuse(stage.id, stageNodeData(stage, second))]));
  assert.equal(after.beta, before.beta, 'Beta, with its journey list, does not re-render for Gamma or GitHub changes.');
  assert.equal(after.production, before.production);
  assert.notEqual(after.gamma, before.gamma);
  assert.notEqual(after.build, before.build);
  assert.equal(after.build.build?.status, 'passed');
  assert.equal(before.beta.build, undefined, 'Only Build carries GitHub status.');
});

test('a sandbox gets new node data when its own records change', () => {
  const reuse = createStageDataCache(), healthBeat = createHealthBeats(), beta = stages[2];
  const first = reuse('beta', stageNodeData(beta, context({ healthBeat })));
  assert.equal(first.beat, '', 'The check seen first stays still.');
  const checked = { ...betaEnvironment, health: { ...betaEnvironment.health, checkedAt: '2026-09-23T10:01:00.000Z' } };
  const next = reuse('beta', stageNodeData(beta, context({ environments: [checked], healthBeat })));
  assert.notEqual(next, first);
  assert.equal(next.beat, '2026-09-23T10:01:00.000Z');
  assert.equal(reuse('beta', stageNodeData(beta, context({ environments: [checked], healthBeat }))), next, 'The same check does not change the data again.');
  const running = reuse('beta', stageNodeData(beta, context({ environments: [checked], browserTests: { beta: { ...betaTests, runs: [{ id: 'run-beta', mode: 'run', status: 'running' }] } }, healthBeat })));
  assert.notEqual(running, next);
  assert.equal(running.activity, 'testing');
});

test('Production says whether a Sandbox gates it, and takes its merged rows over the scan\'s', () => {
  const production = stages.at(-1)!;
  assert.equal(stageNodeData(production, context()).gated, true);
  const ungated = { ...pipeline, stages: stages.filter(stage => stage.kind !== 'sandbox') };
  assert.equal(stageNodeData(production, { ...context(), pipeline: ungated }).gated, false);
  assert.equal(stageNodeData(stages[1], context()).gated, undefined, 'Only Production carries it.');
  const merged: Row[] = [{ id: 'deployment-provider:vercel', kind: 'deployment-group', provider: 'Vercel' }];
  assert.equal(stageNodeData(production, { ...context(), production: merged }).services, merged, 'Rows with recorded deployments replace the scan\'s for Production.');
  const scan = scanFixture();
  assert.equal(stageNodeData(stages[1], { ...context({ scan }), production: merged }).services, scan.delivery.build, 'Build keeps its own rows.');
  assert.equal(stageNodeData(production, { ...context({ scan }), production: null }).services, stageServices(scan, production));
});

test('every stage but Source carries its Autopilot record, and none without a view', () => {
  const build = { mode: 'merge' as const, changes: [] }, autopilot = { repoPath: '/work/storefront', stages: { build } };
  assert.equal(stageNodeData(stages[1], { ...context(), autopilot }).autopilot, build, 'The stage\'s own record, by identity.');
  assert.equal(stageNodeData(stages[2], { ...context(), autopilot }).autopilot, null, 'A stage the view omits carries null.');
  assert.equal(stageNodeData(stages[0], { ...context(), autopilot }).autopilot, undefined, 'Source carries nothing.');
  assert.equal(stageNodeData(stages[1], context()).autopilot, null);
});

test('a Sandbox card names the pull request head its repair twin runs instead of reading it as behind', () => {
  const beta = stages[2], repaired: Environment = { ...betaEnvironment, id: 'env-pr', repair: 'r1', sourceBranch: 'perpetual/repair/cb9292c', sourceRevision: 'f'.repeat(40) };
  const data = stageNodeData(beta, context({ environments: [repaired] }));
  assert.deepEqual([data.behind, data.repairHead], ['', 'perpetual/repair/cb9292c · fffffff']);
  const older = stageNodeData(beta, context({ environments: [{ ...betaEnvironment, sourceRevision: 'a'.repeat(40) }] }));
  assert.deepEqual([older.behind, older.repairHead], ['aaaaaaa → cb9292c', '']);
});
