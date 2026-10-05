import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type StageRemoval } from '../client/src/lib/test-workspace.ts';
import type { BrowserCase } from '../contract/browser.ts';
import type { Controller } from '../client/src/lib/api.ts';
import { defaultPipeline, applyPipelineAction } from '../src/pipeline.ts';

test('a rejected graph skip reaches the graph error projection without an open inspector', async () => {
  const workspace = createTestWorkspace({pollInterval:0,controller:async()=>{throw new Error('Journey no longer exists');}});
  workspace.activate({path:'/repo',branch:'main'},{browserTests:{beta:{cases:[],runs:[]}}});
  try {
    await assert.rejects(workspace.stage('beta').perform('browser','skip',tx=>tx.post('skip',{id:'run',caseId:'journey'})),/no longer exists/);
    assert.match(workspace.getSnapshot().error,/no longer exists/);
  } finally { workspace.dispose(); }
});

test('the page shows the latest stage error, so an earlier action failure never hides a later one', async t => {
  let readFails = false;
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async path => {
    if (path.startsWith('/api/browser/run')) throw new Error('Beta could not start its run.');
    if (path.startsWith('/api/browser/skip')) throw new Error('Journey no longer exists.');
    if (readFails) throw new Error('Beta could not be read.');
    return { cases: [], runs: [] };
  } });
  t.after(() => workspace.dispose());
  workspace.activate({ path: '/repo', branch: 'main' }, { browserTests: { beta: { cases: [], runs: [] }, gamma: { cases: [], runs: [] } } });
  const beta = workspace.stage('beta'), gamma = workspace.stage('gamma');
  await assert.rejects(beta.perform('browser', 'run', tx => tx.post('run')), /could not start/);
  assert.equal(workspace.getSnapshot().error, 'Beta could not start its run.');
  await assert.rejects(gamma.perform('browser', 'skip', tx => tx.post('skip', { id: 'run', caseId: 'journey' })), /no longer exists/);
  assert.equal(workspace.getSnapshot().error, 'Journey no longer exists.', 'A later failure on a following stage is shown.');
  readFails = true; await beta.refresh('browser');
  assert.equal(workspace.getSnapshot().error, 'Beta could not be read.', 'So is a later poll failure beside an older action error.');
  readFails = false; await beta.refresh('browser');
  assert.equal(workspace.getSnapshot().error, 'Journey no longer exists.');
});

const source = { path: '/project', branch: 'main' };
const pipelineStages = (ids: string[]) => ids.map(id => ({ id, name: id, kind: id === 'source' ? 'source' : 'sandbox' }));

test('source polling publishes stages added or renamed in another tab without replacing local drafts', async t => {
  const initial = defaultPipeline(source.path);
  let pipeline = applyPipelineAction(initial, { action: 'add-stage', name: 'Beta' });
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async () => ({ scan: { repo: source }, pipeline, browserTests: {}, environments: [] }) });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: initial, browserTests: {} });
  workspace.stage('build').edit('note', 'unsaved');
  await workspace.refreshSource();
  assert.deepEqual(workspace.getSnapshot().pipeline?.stages.map(stage => stage.name), ['Source', 'Build', 'Beta', 'Production']);
  const unchanged = workspace.getSnapshot().pipeline;
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().pipeline, unchanged, 'Unchanged polls do not lay out the canvas again.');
  const beta = pipeline.stages.find(stage => stage.name === 'Beta')!;
  pipeline = applyPipelineAction(pipeline, { action: 'rename-stage', stageId: beta.id, name: 'Gamma' });
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().pipeline?.stages[2].name, 'Gamma');
  assert.equal(workspace.stage('build').getSnapshot().drafts.note, 'unsaved');
});

test('pipeline writes keep earlier polls from restoring the graph before the write', async t => {
  const initial = defaultPipeline(source.path), saved = applyPipelineAction(initial, { action: 'add-stage', name: 'Beta' });
  const old = deferred();
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (_path, input) => input ? { pipeline: saved } : old.promise });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: initial, browserTests: {} });
  const reading = workspace.refreshSource();
  await workspace.changePipeline({ action: 'add-stage', afterStageId: 'build', name: 'Beta' });
  old.resolve({ scan: { repo: source }, pipeline: initial, browserTests: {} });
  await reading;
  assert.deepEqual(workspace.getSnapshot().pipeline?.stages.map(stage => stage.name), ['Source', 'Build', 'Beta', 'Production']);
});

test('a late pipeline read from the previous branch cannot change the new source graph', async t => {
  const old = deferred(), initial = defaultPipeline(source.path);
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async () => old.promise });
  t.after(() => workspace.dispose());
  workspace.activate(source, { pipeline: initial, browserTests: {} });
  const reading = workspace.refreshSource();
  const next = applyPipelineAction(initial, { action: 'add-stage', name: 'Gamma' });
  workspace.activate({ ...source, branch: 'feature' }, { pipeline: next, browserTests: {} });
  old.resolve({ scan: { repo: source }, pipeline: initial, browserTests: {} });
  await reading;
  assert.deepEqual(workspace.getSnapshot().pipeline?.stages.map(stage => stage.name), ['Source', 'Build', 'Gamma', 'Production']);
});
const scenario: BrowserCase = { steps: [], isolation: 'shared', evidence: [], id: 'journey', name: 'Complete checkout', goal: 'Buy a product', expectedOutcomes: ['Order saved'], preconditions: [], assertions: [], needsReview: true, selected: false };
const deferred = () => { let resolve = (_value: unknown) => {}; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t: TestContext, controller: Controller) {
  const workspace = createTestWorkspace({ controller, pollInterval: 0 });
  workspace.activate(source, { browserTests: { beta: { cases: [scenario], runs: [] } } });
  t.after(() => workspace.dispose());
  return { workspace, stage: workspace.stage('beta') };
}

test('review save updates graph and inspector together; an earlier read cannot restore the draft', async t => {
  const old = deferred(); let reads = 0;
  const reviewed = { ...scenario, needsReview: false, selected: true };
  const { workspace, stage } = fixture(t, async (path, input) => {
    if (input) return { cases: input.cases };
    if (reads++ === 0) return old.promise;
    return { cases: [reviewed], runs: [] };
  });
  const refresh = stage.refresh('browser');
  await stage.saveBrowserCase(reviewed);
  old.resolve({ cases: [scenario], runs: [] }); await refresh;
  assert.deepEqual(stage.getSnapshot().browser.cases, [reviewed]);
  assert.deepEqual(workspace.getSnapshot().browserTests.beta.cases, [reviewed]);
});

test('remote refresh preserves dirty configuration and a saved draft clears only its own revision', async t => {
  const save = deferred();
  const { stage } = fixture(t, async (path, input) => input ? save.promise : { config: { targetUrl: 'https://remote.test', scope: 'remote' }, cases: [] });
  stage.edit('config', { targetUrl: 'https://local.test', scope: 'unsaved', requirements: '', maxSteps: 60 });
  await stage.refresh('browser');
  assert.equal(stage.getSnapshot().drafts.config?.scope, 'unsaved');
  const saving = stage.perform('browser', 'config', tx => tx.save('config', { config: stage.getSnapshot().drafts.config }));
  stage.edit('config', { targetUrl: 'https://local.test', scope: 'new edit', requirements: '', maxSteps: 60 });
  save.resolve({ config: { targetUrl: 'https://local.test', scope: 'unsaved' } }); await saving;
  assert.equal(stage.getSnapshot().drafts.config?.scope, 'new edit');
  assert.equal(stage.getSnapshot().dirty.config, true);
});

test('switching branches invalidates old reads and operations even when repository path is unchanged', async t => {
  const old = deferred();
  const { workspace, stage } = fixture(t, () => old.promise);
  const reading = stage.refresh('browser');
  workspace.activate({ ...source, branch: 'preview' }, { browserTests: { beta: { cases: [], runs: [] } } });
  old.resolve({ cases: [scenario], runs: [] }); await reading;
  assert.deepEqual(workspace.getSnapshot().browserTests.beta.cases, []);
  await assert.rejects(stage.saveBrowserCase(scenario), /source changed/i);
});

test('reads and subscriptions never generate cases or execute tests; disposal rejects late replies', async t => {
  const old = deferred(); const requests: { path: string; input?: Record<string, unknown> }[] = [];
  const { workspace, stage } = fixture(t, (path, input) => { requests.push({ path, input }); return old.promise; });
  const stop = stage.observe(['browser']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, undefined);
  assert.match(requests[0].path, /^\/api\/browser\?/);
  const before = workspace.getSnapshot();
  stop(); workspace.dispose(); old.resolve({ cases: [], runs: [] }); await old.promise; await Promise.resolve();
  assert.equal(workspace.getSnapshot(), before);
});

test('environment updates share the graph projection and unsaved plans survive inspector reopen', async t => {
  const environment = { id: 'env', stageId: 'beta', status: 'ready' };
  const { workspace, stage } = fixture(t, async () => ({ environments: [environment], plan: { services: [] } }));
  stage.edit('plan', { services: [{ id: 'api', name: 'Edited service' }] });
  const stop = stage.observe(['environment']); stop();
  await stage.refresh('environment');
  assert.deepEqual(workspace.getSnapshot().environments, [environment]);
  assert.deepEqual(workspace.stage('beta').getSnapshot().drafts.plan, { services: [{ id: 'api', name: 'Edited service' }] });
});

test('a stale graph summary cannot replace a saved review and keeps full inspector configuration', async t => {
  const summary = deferred();
  const reviewed = { ...scenario, needsReview: false };
  const { workspace, stage } = fixture(t, async (path, input) => {
    if (path === '/api/state') return summary.promise;
    if (input) return { cases: input.cases };
    return { config: { targetUrl: 'https://app.test' }, cases: [reviewed] };
  });
  const reading = workspace.refreshSource();
  await stage.saveBrowserCase(reviewed);
  summary.resolve({ scan: { repo: source }, browserTests: { beta: { cases: [scenario], runs: [] } }, environments: [] }); await reading;
  assert.equal(workspace.getSnapshot().browserTests.beta.cases[0].needsReview, false);
  assert.equal(stage.getSnapshot().browser.config.targetUrl, 'https://app.test');
});

test('source summaries expose generated drafts after environment readiness without opening the inspector', async t => {
  const { workspace } = fixture(t, async () => ({ scan: { repo: source }, browserTests: { beta: { cases: [scenario], preparation: { status: 'completed' } } }, environments: [{ id: 'ready', stageId: 'beta', status: 'ready' }] }));
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().browserTests.beta.preparation?.status, 'completed');
  assert.equal(workspace.getSnapshot().environments[0].status, 'ready');
});

test('a graph summary begun during an inspector read cannot overwrite its newer reply', async t => {
  const detail = deferred(), summary = deferred();
  const { workspace, stage } = fixture(t, path => path === '/api/state' ? summary.promise : detail.promise);
  const reading = stage.refresh('browser');
  const graphReading = workspace.refreshSource();
  detail.resolve({ cases: [{ ...scenario, name: 'New journey' }] }); await reading;
  summary.resolve({ scan: { repo: source }, browserTests: { beta: { cases: [scenario] } } }); await graphReading;
  assert.equal(workspace.getSnapshot().browserTests.beta.cases[0].name, 'New journey');
});

test('successful environment reads cannot clear a browser read failure', async t => {
  let browserFails = true;
  const { workspace, stage } = fixture(t, async path => {
    if (path.startsWith('/api/browser') && browserFails) throw new Error('Browser controller unavailable');
    return {};
  });
  await stage.refresh('browser');
  await stage.refresh('environment');
  assert.equal(stage.getSnapshot().pollError, 'Browser controller unavailable');
  assert.equal(workspace.getSnapshot().error, 'Browser controller unavailable');
  browserFails = false;
  await stage.refresh('browser');
  assert.equal(stage.getSnapshot().pollError, '');
});

test('graph creation provisions the stage\'s saved twin config without posting a plan', async t => {
  const posted: string[] = [];
  const { workspace, stage } = fixture(t, async (path, input) => {
    if (input) { posted.push(path); return { environment: { id: 'new-env', stageId: 'beta', status: 'creating' } }; }
    return { plan: { services: {}, apps: {} }, environments: [{ id: 'new-env', stageId: 'beta', status: 'creating' }] };
  });
  stage.edit('plan', { services: { postgres: {} }, apps: {} });
  await workspace.stage('beta').createEnvironment();
  assert.deepEqual(posted.map(path => path.split('?')[0]), ['/api/environments/create']);
  assert.equal(workspace.getSnapshot().environments[0].id, 'new-env');
});

test('source subscribers receive removal progress without an open inspector', async t => {
  const removal = { id: 'remove-beta', stageId: 'beta', status: 'cleaning' };
  const { workspace } = fixture(t, async () => ({ scan: { repo: source }, stageRemovals: [{ ...removal, status: 'completed' }] }));
  workspace.activate(source, { browserTests: {}, stageRemovals: [removal] });
  assert.deepEqual(workspace.getSnapshot().stageRemovals, [removal]);
  const updates: StageRemoval[][] = [];
  const unsubscribe = workspace.subscribe(() => updates.push(workspace.getSnapshot().stageRemovals));
  // Graph summary polling continues independently of any open inspector.
  await workspace.refreshSource();
  unsubscribe();
  assert.equal(updates.at(-1)![0].status, 'completed');
});

test('stage removal summaries cannot leak from a previous source', async t => {
  const old = deferred();
  const { workspace } = fixture(t, () => old.promise);
  const reading = workspace.refreshSource();
  workspace.activate({ ...source, branch: 'preview' }, { browserTests: {} });
  old.resolve({ scan: { repo: source }, stageRemovals: [{ id: 'old-removal', stageId: 'beta', status: 'completed' }] });
  await reading;
  assert.deepEqual(workspace.getSnapshot().stageRemovals, []);
});

test('scanned preview URLs follow the active source and keep their identity across polls', async t => {
  const scan = { repo: source, nodes: [{ id: 'vercel:app', provider: 'Vercel', label: 'app preview', previewAlias: 'app-git-preview.vercel.app' }] };
  const { workspace } = fixture(t, async () => ({ scan, stageRemovals: [] }));
  workspace.activate(source, { browserTests: {}, scan });
  const previews = workspace.getSnapshot().previews;
  assert.deepEqual(previews, [{ url: 'https://app-git-preview.vercel.app', label: 'app preview' }]);
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().previews, previews);
  workspace.activate({ ...source, branch: 'preview' }, { browserTests: {} });
  assert.deepEqual(workspace.getSnapshot().previews, []);
});

test('drafts of a stage that left the pipeline are pruned on activation and on each source refresh', async t => {
  const pruned: [string, string[]][] = [];
  let stages = pipelineStages(['source', 'beta', 'gamma']);
  const workspace = createTestWorkspace({ pollInterval: 0, pruneDrafts: (repoPath, ids) => pruned.push([repoPath, ids]), controller: async () => ({ scan: { repo: source }, pipeline: { repoPath: source.path, stages, transitions: [] }, stageRemovals: [] }) });
  t.after(() => workspace.dispose());
  workspace.activate(source, { browserTests: {}, pipeline: { repoPath: source.path, stages, transitions: [] } });
  assert.deepEqual(pruned, [['/project', ['source', 'beta', 'gamma']]]);
  stages = pipelineStages(['source', 'beta']);
  await workspace.refreshSource();
  assert.deepEqual(pruned.at(-1), ['/project', ['source', 'beta']], 'A deleted Gamma stage no longer keeps its drafts');
  const before = pruned.length;
  workspace.activate(source, { browserTests: {} });
  workspace.activate(source, { browserTests: {}, pipeline: { repoPath: '/elsewhere', stages: [], transitions: [] } });
  assert.equal(pruned.length, before, 'An unknown or foreign pipeline prunes nothing');
});

test('a poll that races a stage deletion is not the page error, and the deleted stage is read no more', async t => {
  let stages = pipelineStages(['source', 'beta']), reads = 0;
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async path => {
    if (path === '/api/state') return { scan: { repo: source }, pipeline: { repoPath: source.path, stages, transitions: [] }, stageRemovals: [] };
    reads++;
    throw new Error('Choose a Sandbox stage.');
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { browserTests: { beta: { cases: [], runs: [] } }, pipeline: { repoPath: source.path, stages, transitions: [] } });
  await workspace.stage('beta').refresh('browser');
  assert.match(workspace.getSnapshot().error, /Sandbox stage/, 'A listed stage still reports its read failure');
  stages = pipelineStages(['source']);
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().error, '', 'The deleted stage no longer reports the failure');
  const before = reads;
  await workspace.stage('beta').refresh('browser');
  assert.equal(reads, before, 'A deleted stage is not read again');
});

test('the scanned branch follows the active source', t => {
  const { workspace } = fixture(t, async () => ({ scan: { repo: source } }));
  assert.equal(workspace.getSnapshot().branch, 'main');
  workspace.activate({ ...source, branch: 'preview' }, { browserTests: {} });
  assert.equal(workspace.getSnapshot().branch, 'preview');
});

test('a reopened inspector reads its stage again before its view counts as loaded', async t => {
  let read = deferred();
  const { stage } = fixture(t, () => read.promise);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let stop = stage.observe(['browser']);
  read.resolve({ cases: [scenario], runs: [], accounts: [], config: { targetUrl: 'http://127.0.0.1:3000/' } }); await flush();
  assert.equal(stage.getSnapshot().loading.browser, false);
  stop();
  // While no inspector observes the stage, a new twin moves its target and adds a test account.
  read = deferred();
  stop = stage.observe(['browser']);
  assert.equal(stage.getSnapshot().loading.browser, true, 'Configuration, accounts and capabilities read while closed may be out of date.');
  read.resolve({ cases: [scenario], runs: [], accounts: [{ id: 'admin', label: 'Admin', username: 'admin@example.test' }], config: { targetUrl: 'http://127.0.0.1:4000/' } }); await flush();
  assert.equal(stage.getSnapshot().loading.browser, false);
  assert.equal(stage.getSnapshot().browser.config.targetUrl, 'http://127.0.0.1:4000/');
  assert.deepEqual(stage.getSnapshot().browser.accounts?.map(account => account.id), ['admin']);
  stop();
});

test('a source another window switched to is reported once a second poll names it, instead of a silently frozen graph', async t => {
  let branch = 'main';
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async () => ({ scan: { repo: { path: source.path, branch } }, browserTests: {} }) });
  t.after(() => workspace.dispose());
  workspace.activate(source, { browserTests: {} });
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().error, '');
  branch = 'feature';
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().error, '', 'One reply may race this window\'s own source change.');
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().error, 'The source changed. Reload the pipeline.');
  workspace.activate({ ...source, branch: 'feature' }, { browserTests: {} });
  assert.equal(workspace.getSnapshot().error, '');
  await workspace.refreshSource();
  assert.equal(workspace.getSnapshot().error, '');
});

test('a case conflict inside a one-off run or a replacing Generate reads the changed list at once', async t => {
  let cases = [{ ...scenario, name: 'Before' }];
  const workspace = createTestWorkspace({ pollInterval: 0, controller: async (path, input) => {
    if (input) throw Object.assign(new Error('Tests changed. Reopen Generate and try again.'), { statusCode: 409 });
    return { cases, runs: [] };
  } });
  t.after(() => workspace.dispose());
  workspace.activate(source, { browserTests: { beta: { cases, runs: [] } } });
  const stage = workspace.stage('beta');
  for (const [mode, name] of [['run', 'After a run'], ['discover', 'After Generate']]) {
    cases = [{ ...scenario, name }];
    await assert.rejects(stage.perform('browser', mode, tx => tx.post('cases', { cases: [], baseCases: [] })), /Tests changed/);
    assert.equal(stage.getSnapshot().browser.cases[0].name, name, `${mode}: a retry starts from the controller's list`);
  }
});
