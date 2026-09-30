import test from 'node:test';
import assert from 'node:assert/strict';
import type { CheckRow } from '../client/src/lib/journey-steps.ts';
import { assignStepIds, buildJourneySteps, checkRow, earlierCaptures, nextCaptureName, reviewedStepError, stepRow } from '../client/src/lib/journey-steps.ts';

const original = [{ id:'login', title:'Sign in' }, { id:'step-3', title:'Run a workflow' }, { id:'credits', title:'Verify credits decreased' }];
const rows = (titles: string[]) => titles.map(title => stepRow({ title }));

test('step IDs follow titles when rows are reordered', () => {
  assert.deepEqual(assignStepIds(rows(['Verify credits decreased', 'Sign in', 'Run a workflow']), original), ['credits', 'login', 'step-3']);
});
test('new lines mint unused IDs instead of colliding with generated ones', () => {
  assert.deepEqual(assignStepIds(rows(['Sign in', 'Open billing', 'Run a workflow', 'Refund']), original), ['login', 'step-1', 'step-3', 'step-2']);
  assert.deepEqual(assignStepIds(rows(['A', 'B', 'C']), [{ id:'step-1', title:'Old' }]), ['step-2', 'step-3', 'step-4']);
});
test('a renamed row keeps its own ID unless another row claims it by title', () => {
  const edited = original.map(stepRow);
  edited[1].title = 'Run the onboarding workflow';
  assert.deepEqual(assignStepIds(edited, original), ['login', 'step-3', 'credits']);
  const swapped = original.map(stepRow);
  swapped[0].title = 'Verify credits decreased'; swapped[2].title = 'Refund';
  assert.deepEqual(assignStepIds(swapped, original), ['credits', 'step-3', 'step-1']);
});

test('steps are built with contract-shaped checks and no empty check lists', () => {
  const edited = [stepRow({ title:' Record credits ' }), stepRow({ title:'Run workflow' }), stepRow({ title:'' })];
  edited[0].checks = [checkRow({ type:'read-number', label:'Credits', name:'creditsBefore', value:'ignored' })];
  edited[1].checks = [checkRow({ type:'compare-number', label:'Credits', name:'creditsAfter', op:'<', than:'creditsBefore' }), checkRow({ type:'text-visible', value:' Run complete ' })];
  const { steps, error } = buildJourneySteps(edited, []);
  assert.equal(error, '');
  assert.deepEqual(steps, [
    { id:'step-1', title:'Record credits', checks:[{ type:'read-number', label:'Credits', name:'creditsBefore' }] },
    { id:'step-2', title:'Run workflow', checks:[{ type:'compare-number', label:'Credits', name:'creditsAfter', op:'<', than:'creditsBefore' }, { type:'text-visible', value:'Run complete' }] },
  ]);
});
test('a check that names the run token as {run} is kept as written', () => {
  const row = stepRow({ title:'Reopen the profile' });
  row.checks = [checkRow({ type:'text-visible', value:' QA {run} ' }), checkRow({ type:'url-contains', value:'/items/{run}' }), checkRow({ type:'read-number', label:'Tasks for QA {run}', name:'tasks' })];
  assert.deepEqual(buildJourneySteps([row], []), { steps:[{ id:'step-1', title:'Reopen the profile', checks:[{ type:'text-visible', value:'QA {run}' }, { type:'url-contains', value:'/items/{run}' }, { type:'read-number', label:'Tasks for QA {run}', name:'tasks' }] }], error:'' });
});
test('check validation rejects incomplete or unordered captures', () => {
  const errorFor = (checks: Partial<CheckRow>[]) => { const row = stepRow({ title:'Verify' }); row.checks = checks.map(checkRow); return buildJourneySteps([row], []).error; };
  assert.equal(errorFor([{ type:'text-visible', value:' ' }]), 'Complete each step check.');
  assert.equal(errorFor([{ type:'read-number', label:'Credits', name:'Credits before' }]), 'Use a check name such as creditsBefore.');
  assert.equal(errorFor([{ type:'compare-number', label:'Credits', name:'after', op:'<', than:'before' }]), 'Compare with a number read earlier.');
  assert.equal(errorFor([{ type:'compare-number', label:'Credits', name:'after', op:'≈', than:'before' }]), 'Complete each step check.');
  assert.equal(errorFor(Array.from({ length:7 }, () => ({ type:'text-visible', value:'x' }))), 'Use at most 6 checks per step.');
  assert.equal(errorFor([{ type:'read-number', label:'Credits', name:'before' }, { type:'compare-number', label:'Credits', name:'after', op:'<', than:'before' }]), '');
  const untitled = stepRow({ title:'' }); untitled.checks = [checkRow({ type:'text-visible', value:'x' })];
  assert.equal(buildJourneySteps([untitled], []).error, 'Name each business step.');
  assert.equal(buildJourneySteps(rows(Array.from({ length:13 }, (_, index) => `Step ${index}`)), []).error, 'Use at most 12 business steps.');
  assert.equal(buildJourneySteps(rows(['x'.repeat(241)]), []).error, 'Use at most 240 characters per step.');
});
test('compare checks offer only captures read earlier in the journey', () => {
  const edited = [stepRow({ title:'A' }), stepRow({ title:'B' })];
  edited[0].checks = [checkRow({ type:'read-number', label:'Credits', name:'before' })];
  edited[1].checks = [checkRow({ type:'compare-number', label:'Credits', name:'after', than:'before' }), checkRow({ type:'read-number', label:'Plan', name:'plan' })];
  assert.deepEqual(earlierCaptures(edited, 1, 0), ['before']);
  assert.deepEqual(earlierCaptures(edited, 1, 2), ['before', 'plan']);
  assert.deepEqual(earlierCaptures(edited, 0, 0), []);
});
test('reviewed journeys need 2–12 milestones unless an unchanged legacy case is kept', () => {
  assert.equal(reviewedStepError([{ id:'a', title:'A' }]), 'Add 2–12 business steps.');
  assert.equal(reviewedStepError([]), 'Add 2–12 business steps.');
  assert.equal(reviewedStepError([], { legacyUnchanged:true }), '');
  assert.equal(reviewedStepError([{ id:'a', title:'A' }, { id:'b', title:'B' }]), '');
});
test('new number checks get an unused capture name', () => {
  const edited = [stepRow({ title:'A', checks:[{ type:'read-number', label:'Credits', name:'reading1' }, { type:'compare-number', label:'Credits', name:'reading3', op:'<', than:'reading1' }] })];
  assert.equal(nextCaptureName(edited), 'reading2');
  assert.equal(nextCaptureName([]), 'reading1');
});


test('unsupported local editor check types never serialize as a normalized comparison', () => {
  const row = stepRow({ title: 'Verify the changed balance' });
  row.checks = [{ ...checkRow({ type: 'compare-number', label: 'Credits', name: 'after', op: '<', than: 'before' }), type: 'unsupported' }];
  assert.deepEqual(buildJourneySteps([row]), { steps: [], error: 'Complete each step check.' });
});
