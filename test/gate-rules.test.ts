import test from 'node:test';
import assert from 'node:assert/strict';
import { commitStatus, nextGate, productionReady, sameStatus, stageGate, verdict, type Gate, type GateStatus } from '../src/gate/rules.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const gate = (stageId: string, sha: string, status: GateStatus, detectedAt = '2026-09-23T10:00:00.000Z', extra: Partial<Gate> = {}) => ({ stageId, sha, status, detectedAt, updatedAt: detectedAt, context: `perpetual/${stageId}`, ...extra });

test('a run roll-up decides the gate: failed fails, blocked and unreviewed need release, passed passes', () => {
  assert.deepEqual(verdict({ status: 'passed' }), { status: 'passed' });
  assert.deepEqual(verdict({ status: 'failed', results: [{ status: 'passed' }, { status: 'failed' }] }), { status: 'failed', reason: 'A journey failed.' });
  assert.deepEqual(verdict({ status: 'failed', results: [{ status: 'failed', error: 'Milestone check failed: Save.' }] }), { status: 'failed', reason: 'Milestone check failed: Save.' });
  // A run that stopped without a failed journey (a runtime or persistence error) has no journey verdict.
  assert.deepEqual(verdict({ status: 'failed', error: 'Browser runtime did not return results.', results: [] }), { status: 'needs-release', reason: 'Browser runtime did not return results.' });
  assert.deepEqual(verdict({ status: 'failed' }), { status: 'needs-release', reason: 'Journeys did not all pass.' });
  assert.deepEqual(verdict({ status: 'blocked' }), { status: 'needs-release', reason: 'A journey is blocked.' });
  assert.deepEqual(verdict({ status: 'needs_review' }), { status: 'needs-release', reason: 'A journey needs review.' });
  assert.deepEqual(verdict({ status: 'cancelled' }), { status: 'needs-release', reason: 'The run was cancelled.' });
  assert.deepEqual(verdict({ status: 'completed' }), { status: 'needs-release', reason: 'A journey was skipped.' });
  assert.equal(verdict(undefined).status, 'needs-release', 'A missing run is never a pass.');
});

test('commit statuses: pending while running, success for passed or released, failure for failed, pending Needs release', () => {
  const status = (value: GateStatus, extra?: Partial<Gate>) => commitStatus(gate('Beta', A, value, undefined, extra));
  assert.equal(status('queued'), null, 'A queued gate reports nothing, so a superseded commit is never left pending.');
  assert.equal(status('superseded'), null);
  assert.deepEqual(status('rebuilding'), { state: 'pending', context: 'perpetual/Beta', description: 'Running' });
  assert.deepEqual(status('running'), { state: 'pending', context: 'perpetual/Beta', description: 'Running' });
  assert.deepEqual(status('passed'), { state: 'success', context: 'perpetual/Beta', description: 'Passed' });
  assert.deepEqual(status('failed'), { state: 'failure', context: 'perpetual/Beta', description: 'Failed' });
  assert.deepEqual(status('needs-release'), { state: 'pending', context: 'perpetual/Beta', description: 'Needs release' });
  assert.deepEqual(status('released', { releasedBy: 'developer' }), { state: 'success', context: 'perpetual/Beta', description: 'Released by developer' });
  assert.equal(sameStatus(status('rebuilding'), status('running')), true, 'Rebuilding and running report one pending status.');
  assert.equal(sameStatus(status('running'), status('passed')), false);
  assert.equal(sameStatus(status('running'), undefined), false);
});

test('a stage shows its gate at work, else its newest commit, never a superseded one', () => {
  const failed = gate('beta', A, 'failed', '2026-09-23T10:00:00.000Z');
  const queued = gate('beta', B, 'queued', '2026-09-23T10:01:00.000Z');
  const superseded = gate('beta', C, 'superseded', '2026-09-23T10:02:00.000Z');
  assert.equal(stageGate([failed, queued, superseded]), queued);
  const running = gate('beta', A, 'running');
  assert.equal(stageGate([queued, running]), running);
  assert.equal(stageGate([superseded]), null);
  assert.equal(stageGate([]), null);
});

test('the next gate is the queued one furthest along the pipeline, so a commit leaves before another enters', () => {
  const beta = gate('beta', B, 'queued', '2026-09-23T10:01:00.000Z'), gamma = gate('gamma', A, 'queued', '2026-09-23T10:00:00.000Z');
  assert.equal(nextGate([beta, gamma], ['beta', 'gamma']), gamma);
  assert.equal(nextGate([beta, gamma], ['beta']), beta, 'A removed stage never runs.');
  assert.equal(nextGate([gate('beta', A, 'running'), gate('beta', B, 'passed')], ['beta']), null);
});

test('Production is Ready for the newest commit every Sandbox gate passed or released', () => {
  const ids = ['beta', 'gamma'];
  const at = (minute: number) => `2026-09-23T10:0${minute}:00.000Z`;
  assert.equal(productionReady([gate('beta', A, 'passed', at(0))], ids), null, 'Gamma has not passed A.');
  assert.deepEqual(productionReady([gate('beta', A, 'released', at(0)), gate('gamma', A, 'passed', at(0))], ids), { sha: A, status: 'ready' });
  assert.equal(productionReady([gate('beta', A, 'needs-release', at(0)), gate('gamma', A, 'passed', at(0))], ids), null);
  assert.equal(productionReady([gate('beta', A, 'failed', at(0)), gate('gamma', A, 'passed', at(0))], ids), null);
  // A newer commit still running at Beta leaves the older ready commit Ready.
  const gates = [gate('beta', B, 'running', at(1)), gate('beta', A, 'passed', at(0)), gate('gamma', A, 'passed', at(0))];
  assert.deepEqual(productionReady(gates, ids), { sha: A, status: 'ready' });
  gates.push(gate('beta', C, 'passed', at(2)), gate('gamma', C, 'released', at(2)));
  assert.deepEqual(productionReady(gates, ids), { sha: C, status: 'ready' });
  assert.equal(productionReady(gates, []), null, 'Without Sandbox stages nothing is Ready.');
});
