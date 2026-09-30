import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { autopilotMode, autopilotStages, autopilotView, repairChange } from '../src/repair/view.ts';
import { repairOffer } from '../client/src/lib/pipeline-autopilot.ts';
import type { PublicRepair, RepairView } from '../src/repair/manager.ts';
import type { AutopilotChange } from '../contract/autopilot.ts';

// The repair manager's view (src/repair/manager.ts) as the pipeline's Autopilot reads it (contract/autopilot.ts): one
// change per repair, with the steps the interface shows. No controller runs.
const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281', OLDER = 'a'.repeat(40), MERGED = 'e'.repeat(40), HEAD = 'f'.repeat(40);
const CI = '.github/workflows/ci.yml', LINT = '.github/workflows/lint.yml';
const RUN = { id: '41', name: 'CI', path: CI, url: 'https://github.com/acme/app/actions/runs/41' };
const PULL = { number: 7, url: 'https://github.com/acme/app/pull/7' };
const repair = (status: PublicRepair['status'], extra: Partial<PublicRepair> = {}): PublicRepair => ({ id: `repair-${status}`, branch: 'main', sha: SHA, status, trigger: 'push', runs: [RUN], createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:01:00.000Z', ...extra });
const marks = (change: AutopilotChange) => change.steps.map(step => `${step.name}: ${step.status}`);
const names = (id: string) => ({ beta: 'Beta', gamma: 'Gamma' })[id] ?? id;
const source = (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');

test('a repair under way is a running change whose steps follow the manager\'s status', () => {
  const triaging = repairChange(repair('triaging'), 'build');
  assert.deepEqual([triaging.id, triaging.stageId, triaging.kind, triaging.title, triaging.status, triaging.startedAt, triaging.endedAt, triaging.reason], ['repair-triaging', 'build', 'fix', 'Fixing build', 'running', '2026-09-25T10:00:00.000Z', undefined, undefined]);
  assert.deepEqual(marks(triaging), ['Read the failure: active', 'Diagnose: pending', 'Change: pending', 'Verify: pending', 'Merge: pending']);
  assert.deepEqual(triaging.steps[0].detail, [{ text: 'CI', href: RUN.url }, ' failed at ', { text: 'cb9292c' }]);
  const rerunning = repairChange(repair('rerunning', { category: 'availability' }), 'build');
  assert.deepEqual([rerunning.title, rerunning.kind, marks(rerunning)[1], rerunning.steps[1].detail], ['Rerunning build', 'rerun', 'Diagnose: active', ['A network or deadline error: rerunning the failed jobs.']]);
  const repairing = repairChange(repair('repairing', { category: 'build', attempts: [{ number: 1, model: 'openai/gpt-6-luna', cost: 0.0031 }, { number: 2, model: 'openai/gpt-6-luna', cost: 0.0042 }] }), 'build');
  assert.deepEqual(marks(repairing), ['Read the failure: done', 'Diagnose: done', 'Change: active', 'Verify: pending', 'Merge: pending']);
  assert.deepEqual([repairing.steps[1].detail, repairing.steps[2].detail], [['The build does not compile.'], ['Attempt 2 with ', { text: 'openai/gpt-6-luna' }, ', ', '$0.0073']]);
  const ci = repairChange(repair('verifying-ci', { category: 'build', attempts: [{ number: 1, model: 'm' }], pullRequest: { ...PULL, draft: true } }), 'build');
  assert.deepEqual([marks(ci)[2], marks(ci)[3], ci.pullRequest, ci.steps[2].detail, ci.steps[3].detail], ['Change: done', 'Verify: active', PULL, ['Attempt 1 with ', { text: 'm' }, ', ', 'pull request ', { text: '#7', href: PULL.url }], ['CI on ', { text: '#7', href: PULL.url }]]);
  const gates = repairChange(repair('verifying-gates', { pullRequest: { ...PULL, draft: false }, gates: [{ stageId: 'beta', sha: HEAD, status: 'passed' }, { stageId: 'gamma', sha: HEAD, status: 'running' }] }), 'build', names);
  assert.deepEqual(gates.steps[3].detail, ['CI on ', { text: '#7', href: PULL.url }, ', ', { text: 'Beta' }, ' passed at ', { text: 'fffffff' }, ', ', { text: 'Gamma' }, ' running at ', { text: 'fffffff' }]);
});

test('a finished repair is merged, passed, under review or not merged, and says why at the step it stopped at', () => {
  const merged = repairChange(repair('merged', { pullRequest: { ...PULL, draft: false }, merged: MERGED, completedAt: '2026-09-25T11:00:00.000Z' }), 'build');
  assert.deepEqual([merged.status, marks(merged), merged.endedAt, merged.steps[4].detail], ['merged', ['Read the failure: done', 'Diagnose: done', 'Change: done', 'Verify: done', 'Merge: done'], '2026-09-25T11:00:00.000Z', ['Merged ', { text: '#7', href: PULL.url }, ' into ', { text: 'main' }, ' as ', { text: 'eeeeeee' }]]);
  const flaky = repairChange(repair('flaky', { category: 'availability', completedAt: '2026-09-25T10:30:00.000Z' }), 'build');
  assert.deepEqual([flaky.status, flaky.title, marks(flaky), flaky.steps[1].detail], ['passed', 'Rerunning build', ['Read the failure: done', 'Diagnose: done'], ['A network or deadline error: the rerun passed.']]);
  const ready = repairChange(repair('ready', { pullRequest: { ...PULL, draft: false }, reason: 'Auto-merge is off.', holds: ['The change touches tests.'] }), 'build');
  assert.deepEqual([ready.status, marks(ready)[4], ready.reason, ready.steps[4].detail, ready.steps[2].detail], ['needs-review', 'Merge: waiting', 'Auto-merge is off.', ['Auto-merge is off.'], ['pull request ', { text: '#7', href: PULL.url }, ', ', 'held: The change touches tests.']]);
  const failed = repairChange(repair('failed', { category: 'build', attempts: [{ number: 4, model: 'm', failure: 'The model stopped without calling done.' }], reason: 'The build was not fixed in 4 attempts.' }), 'build');
  assert.deepEqual([failed.status, marks(failed), failed.steps[2].detail], ['not-merged', ['Read the failure: done', 'Diagnose: done', 'Change: failed', 'Verify: pending', 'Merge: pending'], ['Attempt 4 with ', { text: 'm' }, ' ', 'The build was not fixed in 4 attempts.']]);
  const failedCi = repairChange(repair('failed', { attempts: [{ number: 4, model: 'm' }], pullRequest: { ...PULL, draft: true }, reason: 'The build was not fixed in 4 attempts.' }), 'build');
  assert.deepEqual([failedCi.status, marks(failedCi)[3]], ['not-merged', 'Verify: failed'], 'A draft that failed CI is not under review.');
  const person = repairChange(repair('needs-person', { category: 'configuration', reason: 'Credentials or permissions need attention.' }), 'build');
  assert.deepEqual([person.status, marks(person)[1], person.steps[1].detail], ['not-merged', 'Diagnose: waiting', ['Credentials or permissions need a person.', ' ', 'Credentials or permissions need attention.']]);
  const unstarted = repairChange(repair('needs-person', { category: 'build', startedAt: '2026-09-25T10:00:30.000Z', reason: 'Add an OpenRouter API key in Settings.' }), 'build');
  assert.deepEqual([unstarted.status, marks(unstarted)[2], unstarted.steps[2].detail], ['not-merged', 'Change: waiting', ['Add an OpenRouter API key in Settings.']], 'An agent that could not start is the Change step\'s wait.');
  const interrupted = repairChange(repair('needs-person', { pullRequest: { ...PULL, draft: true }, reason: 'Interrupted by a controller restart.' }), 'build');
  assert.deepEqual([interrupted.status, marks(interrupted)[3]], ['needs-review', 'Verify: waiting'], 'An open pull request waits for a person.');
  const stopped = repairChange(repair('cancelled'), 'build');
  assert.deepEqual([stopped.status, stopped.reason, marks(stopped)[0], stopped.steps[0].detail], ['not-merged', 'Stopped.', 'Read the failure: waiting', [{ text: 'CI', href: RUN.url }, ' failed at ', { text: 'cb9292c' }, ' ', 'Stopped.']]);
  const superseded = repairChange(repair('superseded', { pullRequest: { ...PULL, draft: true, closed: true }, reason: 'Superseded by ddddddd.' }), 'build');
  assert.deepEqual([superseded.status, marks(superseded)[3]], ['not-merged', 'Verify: waiting'], 'A closed pull request is not under review.');
});

test('only a managed source\'s Build carries Autopilot: its mode is the auto-merge switch, and the head\'s failed runs are offered while nothing repairs it', () => {
  const head = { sha: HEAD, branch: 'main', failed: [RUN] };
  assert.deepEqual(autopilotStages({ repairs: [] }, 'build'), {}, 'A local checkout has no switch, so no Autopilot.');
  assert.deepEqual(autopilotStages({ repairs: [], autoMerge: true, head }, null), {}, 'Without a Build stage there is nothing to carry it.');
  assert.deepEqual(autopilotStages({ repairs: [], autoMerge: true }, 'build'), { build: { mode: 'merge', changes: [] } }, 'A disconnected account watches no head.');
  assert.deepEqual(autopilotStages({ repairs: [], autoMerge: false, head }, 'build'), { build: { mode: 'ask', changes: [], failed: { sha: HEAD, runs: [RUN] } } });
  for (const status of ['triaging', 'repairing', 'verifying-gates', 'ready', 'merged'] as const) {
    assert.deepEqual(autopilotStages({ repairs: [repair(status, { sha: HEAD })], autoMerge: true, head }, 'build').build.failed, { sha: HEAD, runs: [] }, `A ${status} repair of the head is not started again.`);
  }
  for (const status of ['needs-person', 'failed', 'cancelled', 'flaky', 'superseded'] as const) {
    assert.deepEqual(autopilotStages({ repairs: [repair(status, { sha: HEAD })], autoMerge: true, head }, 'build').build.failed, { sha: HEAD, runs: [RUN] }, `A ${status} repair of the head may start again.`);
  }
  assert.deepEqual(autopilotStages({ repairs: [repair('ready')], autoMerge: true, head }, 'build').build.failed, { sha: HEAD, runs: [RUN] }, 'The scanned commit\'s fix never holds back the head\'s Repair.');
  const view: RepairView = { repairs: [repair('ready', { pullRequest: PULL }), repair('flaky', { sha: OLDER, category: 'availability' })], autoMerge: true, head, watchError: 'Could not read main from GitHub.' };
  const stages = [{ id: 'build', name: 'Build' }, { id: 'beta', name: 'Beta' }];
  assert.deepEqual(autopilotView(view, { repoPath: '/work/app', stageId: 'build', stages }), {
    repoPath: '/work/app', watchError: 'Could not read main from GitHub.',
    stages: { build: { mode: 'merge', changes: [repairChange(view.repairs[0], 'build'), repairChange(view.repairs[1], 'build')], failed: { sha: HEAD, runs: [RUN] } } },
  });
  assert.deepEqual(autopilotView({ repairs: [repair('verifying-gates', { gates: [{ stageId: 'beta', sha: HEAD, status: 'passed' }] })], autoMerge: true }, { repoPath: '/work/app', stageId: 'build', stages }).stages!.build.changes[0].steps[3].detail, [{ text: 'Beta' }, ' passed at ', { text: 'fffffff' }], 'A gate names its stage.');
  assert.deepEqual(['merge', 'ask'].map(autopilotMode), ['merge', 'ask']);
  for (const value of ['off', true, 1, null, undefined]) assert.throws(() => autopilotMode(value), /Choose Merge changes or Ask before merging\./);
});

test('Repair names the head\'s own failed run of the workflow, with the head\'s short commit when the runs shown are another commit\'s', () => {
  const stage = { failed: { sha: SHA, runs: [RUN, { id: '42', name: 'Lint', path: `${LINT}@refs/heads/main`, url: null }] } };
  assert.deepEqual(repairOffer(stage, CI, SHA), { runId: '41' });
  assert.deepEqual(repairOffer(stage, LINT, SHA), { runId: '42' }, 'A path with a ref suffix names its file.');
  assert.deepEqual(repairOffer(stage, CI, OLDER), { runId: '41', commit: 'cb9292c' }, 'A head newer than the scanned commit is named.');
  assert.deepEqual(repairOffer(stage, CI, null), { runId: '41', commit: 'cb9292c' });
  assert.equal(repairOffer(stage, '.github/workflows/deploy.yml', SHA), null, 'A workflow without a failed run at the head offers nothing.');
  assert.equal(repairOffer({ failed: { sha: SHA, runs: [] } }, CI, SHA), null);
  assert.equal(repairOffer({}, CI, SHA), null, 'No watched head, no Repair.');
  assert.equal(repairOffer(null, CI, SHA), null);
});

test('Repair is a Button on the failed workflow row, Stop a Button on the change under way, and the mode replaces any switch', async () => {
  const card = await source('GitHubActionsCard.tsx');
  assert.match(card, /import \{ repairOffer, startRepair, type StageAutopilot \} from '@\/lib\/pipeline-autopilot\.ts';/);
  assert.match(card, /offer && <Button type="button" variant="outline" size="sm"[^>]*onClick=\{\(\) => void repair\(\)\}><Wrench \/>Repair\{offer\.commit && <span className="font-mono font-normal">\{offer\.commit\}<\/span>\}<\/Button>/);
  assert.match(card, /await startRepair\(api, \{ repoPath, stageId, runId: offer\.runId \}\);/);
  assert.match(card, /offer=\{repairOffer\(autopilot, workflow\.file, runs\?\.sha\)\}/);
  assert.doesNotMatch(card, /stopChange|<Square|repairs\.ts|Switch/, 'The card offers Repair alone; Stop is on the change.');
  const changes = await source('StageChanges.tsx');
  assert.match(changes, /\{changeActive\(change\) && repoPath && <StopChange repoPath=\{repoPath\} change=\{change\} \/>\}/);
  assert.match(changes, /await stopChange\(api, \{ repoPath, stageId: change\.stageId, id: change\.id \}\);/);
  assert.match(changes, /<Button type="button" variant="ghost" size="sm"[^>]*onClick=\{\(\) => void stop\(\)\}><Square \/>Stop<\/Button>/);
  assert.match(changes, /passed: CircleCheck/);
  const app = await source('App.tsx');
  assert.match(app, /<GitHubActionsCard repoPath=\{repoPath\} scannedAt=\{scannedAt\} scannedSha=\{sha\} runs=\{github\} readError=\{data\.buildReadError\} stageId=\{stage\.id\} autopilot=\{autopilot\} \/>/);
  assert.doesNotMatch(app, /AutoMergeFixes/);
  assert.doesNotMatch(await source('pipeline.css'), /stage-setting-footer/);
  for (const retired of ['AutoMergeFixes.tsx', 'lib/repairs.ts']) assert.equal(await access(new URL(`../client/src/${retired}`, import.meta.url)).then(() => true, () => false), false, `${retired} is retired.`);
});
