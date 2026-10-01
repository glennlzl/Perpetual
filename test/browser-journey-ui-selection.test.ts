import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUN_CASES, createRunSelection, oneOffSelection, restoreSelection } from '../client/src/lib/run-selection.ts';
import { createTestWorkspace } from '../client/src/lib/test-workspace.ts';
import { browserCaseFixture } from './fixtures/browser-view.ts';

const reviewed = (id: string, selected = false) => ({ id, name:id, selected, needsReview:false });
const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};

test('a one-off run selects only its own unselected case', () => {
  const cases = [reviewed('a', true), reviewed('b'), reviewed('c')];
  const { added, cases: next, error } = oneOffSelection(cases, ['b']);
  assert.equal(error, undefined);
  assert.deepEqual(added, ['b']);
  assert.deepEqual(next.map(item => item.selected), [true, true, false]);
  assert.deepEqual(oneOffSelection(cases, ['a']), { added:[], cases });
});
test('a one-off run never pushes the saved selection past the run limit', () => {
  const full = Array.from({ length:MAX_RUN_CASES }, (_, index) => reviewed(`s${index}`, true));
  const cases = [...full, reviewed('extra')];
  const result = oneOffSelection(cases, ['extra']);
  assert.equal(result.error, 'Deselect a test to run this one.');
  assert.equal(result.cases, cases);
  assert.equal(oneOffSelection(cases, ['s0']).error, undefined);
  assert.equal(oneOffSelection(cases.slice(1), ['extra']).cases.filter(item => item.selected).length, MAX_RUN_CASES);
});
test('restoring deselects only the cases the run added', () => {
  const cases = [reviewed('a', true), reviewed('b', true)];
  assert.deepEqual(restoreSelection(cases, ['b'])!.map(item => item.selected), [true, false]);
  assert.equal(restoreSelection([reviewed('a', true), reviewed('b')], ['b']), null);
});
test('restoration waits for an idle stage and retains ownership through a failed save', async () => {
  const owner = createRunSelection('/acme/app', 'beta');
  let cases = [reviewed('a', true), reviewed('b')], saves = 0, runs = 0;
  const save = async (next: typeof cases) => { saves++; cases = next; };
  await owner.start(cases, ['b'], save, async () => { runs++; });
  await owner.restore(cases, save, { active: true });
  assert.deepEqual(cases.map(item => item.selected), [true, true]);
  assert.equal(saves, 1);
  await assert.rejects(owner.restore(cases, async () => { saves++; throw new Error('Save failed'); }), /Save failed/);
  assert.deepEqual(owner.getSnapshot().caseIds, ['b']);
  await owner.restore(cases, save);
  assert.equal(saves, 2, 'A rejected restoration cannot create a tight automatic retry loop.');
  await owner.restore(cases, save, { retry: true });
  assert.deepEqual(cases.map(item => item.selected), [true, false]);
  assert.deepEqual(owner.getSnapshot().caseIds, []);
  assert.equal(runs, 1);
});

test('failed run start and failed rollback keep restoration ownership', async () => {
  const owner = createRunSelection('/acme/app', 'beta');
  let cases = [reviewed('a', true), reviewed('b'), reviewed('c')], saves = 0;
  await assert.rejects(owner.start(cases, ['b'], async next => {
    if (++saves === 2) throw new Error('Rollback failed');
    cases = next;
  }, async () => { throw new Error('Run refused'); }), /Run refused/);
  assert.match(owner.getSnapshot().error, /Rollback failed/);
  assert.deepEqual(owner.getSnapshot().caseIds, ['b']);
  // Another controller edit affects unrelated choices. Restoring uses its latest values as the conflict base.
  cases = cases.map(item => ({ ...item, selected: item.id !== 'a', name: `${item.name} edited` }));
  const current = cases;
  await owner.restore(cases, async (next, base) => { assert.equal(base, current); cases = next; }, { retry: true });
  assert.deepEqual(cases.map(item => [item.name, item.selected]), [['a edited', false], ['b edited', false], ['c edited', true]]);
});

test('ownership is recorded before the temporary write and survives a reload in the same tab', async () => {
  const session = storage(), owner = createRunSelection('/acme/app', 'beta', () => session);
  let cases = [reviewed('b')], writes = 0;
  await owner.start(cases, ['b'], async next => {
    assert.deepEqual(createRunSelection('/acme/app', 'beta', () => session).getSnapshot().caseIds, ['b']);
    writes++; cases = next;
  }, async () => {});
  const reloaded = createRunSelection('/acme/app', 'beta', () => session);
  assert.deepEqual(createRunSelection('/acme/app', 'gamma', () => session).getSnapshot().caseIds, []);
  assert.deepEqual(createRunSelection('/acme/other', 'beta', () => session).getSnapshot().caseIds, []);
  await reloaded.restore(cases, async next => { writes++; cases = next; });
  assert.equal(writes, 2);
  assert.equal(cases[0].selected, false);
  assert.deepEqual(createRunSelection('/acme/app', 'beta', () => session).getSnapshot().caseIds, []);
});

test('observed deselection and successful user choices relinquish their IDs', async () => {
  const owner = createRunSelection('/acme/app', 'beta');
  let cases = [reviewed('b'), reviewed('c')], saves = 0;
  const save = async (next: typeof cases) => { saves++; cases = next; };
  await owner.start(cases, ['b', 'c'], save, async () => {});
  cases = cases.map(item => item.id === 'b' ? { ...item, selected: false } : item);
  await owner.restore(cases, save, { active: true });
  assert.deepEqual(owner.getSnapshot().caseIds, ['c']);
  owner.keep(['c']);
  cases = cases.map(item => ({ ...item, selected: true }));
  await owner.restore(cases, save);
  assert.equal(saves, 1, 'The user’s later selection is not undone.');
  assert.deepEqual(cases.map(item => item.selected), [true, true]);
});

test('a storage failure stops before any temporary selection or run request', async () => {
  const owner = createRunSelection('/acme/app', 'beta', () => { throw new Error('Storage denied'); });
  let requests = 0;
  await assert.rejects(owner.start([reviewed('b')], ['b'], async () => { requests++; }, async () => { requests++; }), /Select the test manually/);
  assert.equal(requests, 0);
  assert.deepEqual(owner.getSnapshot().caseIds, []);
});

test('an unconfirmed temporary write cannot be forgotten from its old unselected snapshot', async () => {
  const owner = createRunSelection('/acme/app', 'beta'), original = [reviewed('b')];
  let saved = original, runs = 0;
  await assert.rejects(owner.start(original, ['b'], async next => { saved = next; throw new Error('Reply lost'); }, async () => { runs++; }), /Reply lost/);
  await owner.restore(original, async () => { throw new Error('No automatic retry'); });
  assert.deepEqual(owner.getSnapshot().caseIds, ['b']);
  // A retry with an old base must reach the controller's conflict guard, never clear the owner locally.
  const save = async (next: typeof saved, base: typeof saved) => {
    if (JSON.stringify(base) !== JSON.stringify(saved)) throw new Error('Tests changed');
    saved = next;
  };
  await assert.rejects(owner.restore(original, save, { retry: true }), /Tests changed/);
  assert.deepEqual(owner.getSnapshot().caseIds, ['b']);
  await owner.restore(saved, save, { retry: true });
  assert.equal(saved[0].selected, false);
  assert.equal(runs, 0);
});

test('a rejected initial selection never takes ownership of another controller writer’s choice', async () => {
  const owner = createRunSelection('/acme/app', 'beta'), original = [reviewed('b')];
  let cases = original, runs = 0, restores = 0;
  await assert.rejects(owner.start(original, ['b'], async () => {
    cases = [reviewed('b', true)];
    throw Object.assign(new Error('Tests changed'), { statusCode: 409 });
  }, async () => { runs++; }), /Tests changed/);
  assert.deepEqual(owner.getSnapshot().caseIds, []);
  await owner.restore(cases, async next => { restores++; cases = next; }, { retry: true });
  assert.equal(cases[0].selected, true);
  assert.equal(restores, 0); assert.equal(runs, 0);
});

test('overlapping observers send one restore and a conflict keeps its retry based on current cases', async () => {
  const owner = createRunSelection('/acme/app', 'beta');
  let cases = [reviewed('b')], saves = 0;
  await owner.start(cases, ['b'], async next => { cases = next; }, async () => {});
  const held = Promise.withResolvers<void>();
  const first = owner.restore(cases, async () => { saves++; await held.promise; throw new Error('Tests changed'); });
  await owner.restore(cases, async () => { saves++; });
  assert.equal(saves, 1);
  held.resolve(); await assert.rejects(first, /Tests changed/);
  cases = [{ ...cases[0], name: 'New reviewed name' }];
  await owner.restore(cases, async (next, base) => { assert.equal(base[0].name, 'New reviewed name'); cases = next; }, { retry: true });
  assert.deepEqual(cases.map(item => [item.name, item.selected]), [['New reviewed name', false]]);
});

test('a source switch cannot send a queued run or rollback through the old stage transaction', async t => {
  const held = Promise.withResolvers<void>(), requested = Promise.withResolvers<void>();
  const requests: Record<string, unknown>[] = [], cases = [browserCaseFixture({ id: 'b' })];
  const workspace = createTestWorkspace({ document: null, pollInterval: 0, controller: async (path, input) => {
    if (input) { requests.push({ path, ...input }); requested.resolve(); await held.promise; return { cases: input.cases }; }
    return { cases: [], runs: [] };
  } });
  t.after(() => workspace.dispose());
  workspace.activate({ path: '/acme/first', branch: 'main' }, { browserTests: { beta: { cases } } });
  const owner = createRunSelection('/acme/first', 'beta'), stage = workspace.stage('beta');
  const start = stage.perform('browser', 'run', tx => owner.start(cases, ['b'], (next, baseCases) => tx.post('cases', { cases: next, baseCases }), () => tx.post('run', { caseIds: ['b'] })));
  await requested.promise;
  workspace.activate({ path: '/acme/other', branch: 'main' }, { browserTests: { beta: { cases: [] } } });
  held.resolve(); await assert.rejects(start, /source changed/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].repoPath, '/acme/first');
  assert.equal(requests[0].path, '/api/browser/cases');
  assert.deepEqual(owner.getSnapshot().caseIds, ['b'], 'An uncertain old write keeps its original owner.');
  assert.deepEqual(workspace.stage('beta').getSnapshot().browser.cases, []);
});
