import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Exercise the persisted lifecycle, replacing only external Docker/model work.
// This does not establish real-model discovery or a passing business test.
test('new ready environments prepare scoped drafts once without turning setup failures into environment failures', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-browser-preparation-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const repoPath = join(dataDir, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'app.js'), 'export const title = "Workspace";');
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import {readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {setTimeout as delay} from 'node:timers/promises';
    const input = JSON.parse(process.argv[1]);
    const unexpected = async () => {throw new Error('Unexpected external operation');};
    mock.module(input.environmentRuntime, {namedExports: {
      prepareEnvironment: async ({environment}) => ({status: 'ready', services: [], apps: Object.keys(environment.plan.apps).map(id => ({id, url: 'http://127.0.0.1:45123/'}))}),
      environmentHealth: unexpected,
      environmentLogs: unexpected, destroySandbox: unexpected,
    }});
    const {createEnvironmentManager} = await import(input.environmentManager);
    const {createBrowserManager} = await import(input.browserManager);
    let modelConfigured = true, capabilityReads = 0, started = 0, releaseDiscovery;
    const runtime = {
      async capabilities() {capabilityReads++;return {runtimeInstalled: true, browserInstalled: true, modelConfigured};},
      start(request, event) {
        assert.equal(request.mode, 'discover');
        assert.equal(request.targetUrl, 'http://127.0.0.1:45123/');
        started++;
        const ready = started === 2 ? new Promise(resolve => {releaseDiscovery = resolve;}) : delay(5);
        return {cancel() {}, promise: ready.then(() => event({type: 'discovery', cases: [{id: 'journey', name: 'Create workspace', goal: 'Create and reopen a workspace', steps: [{id: 'create', title: 'Create a workspace'}, {id: 'reopen', title: 'Reopen the saved workspace'}], expectedOutcomes: ['The saved workspace reopens'], assertions: [], selected: true, needsReview: false}]}))};
      },
    };
    let browser = await createBrowserManager({dataDir: input.dataDir, runtime});
    const context = {key: 'repo', stageId: 'beta', controllerOrigin: 'http://127.0.0.1:4317', scan: {repo: {path: input.repoPath, sha: 'source-a'}, services: [{id: 'frontend', framework: 'Vite'}]}};
    const plan = {services: {}, apps: {frontend: {directory: '.', start: 'node app.js', port: 3000}}};
    let callbacks = 0;
    let environments = await createEnvironmentManager({dataDir: input.dataDir, onReady: async (captured, environment) => {
      callbacks++;
      const persisted = JSON.parse(await readFile(join(input.dataDir, 'environments', 'state.json'), 'utf8'));
      assert.equal(persisted.environments.find(item => item.id === environment.id).status, 'ready');
      await browser.prepareEnvironment(captured, environment);
    }});
    // The suite runs its files at once, so a loaded runner takes seconds where a quiet one takes milliseconds.
    const WAIT = 10000;
    async function prepared(stage) {
      for (const deadline = Date.now() + WAIT;; await delay(5)) {
        const summary = browser.summary(stage);
        if (summary.preparation && !['preparing', 'discovering'].includes(summary.preparation.status)) return summary;
        if (Date.now() > deadline) throw new Error('Preparation did not finish');
      }
    }
    await environments.savePlan(context, plan);
    const {environment} = await environments.create(context);
    const first = await prepared(context);
    assert.equal(first.preparation.status, 'completed');
    assert.equal(first.cases.length, 1);
    assert.equal(first.cases[0].selected, false);
    assert.equal(first.cases[0].needsReview, true);
    assert.equal(first.runs[0].mode, 'discover');
    assert.equal(first.runs[0].status, 'completed');
    assert.equal(first.runs[0].approvedCases, undefined);
    assert.equal(first.runs[0].discovery, undefined);
    assert.equal(first.runs[0].scope, undefined);
    const probes = capabilityReads;
    for (let i = 0; i < 3; i++) browser.summary(context);
    assert.equal(capabilityReads, probes);
    await browser.prepareEnvironment(context, {...environment, status: 'ready'});
    assert.equal(started, 1);
    assert.equal(browser.summary({...context, key: 'other-source'}).cases.length, 0);
    const reviewed = {...first.cases[0], name: 'Reviewed workspace journey', assertions: [{type: 'text-visible', value: 'Workspace saved'}], selected: true, needsReview: false};
    await browser.saveCases(context, [reviewed]);
    await browser.saveConfig(context, {targetUrl: 'https://preview.example/product', scope: 'Workspaces', requirements: 'Retain this requirement', maxSteps: 42});
    await browser.prepareEnvironment(context, {id: 'second-environment', stageId: 'beta', status: 'ready', services: []});
    assert.deepEqual(browser.summary(context).cases, [reviewed]);
    const saved = await browser.view(context);
    assert.equal(saved.config.targetUrl, 'https://preview.example/product');
    assert.equal(saved.config.requirements, 'Retain this requirement');
    assert.equal(started, 1);
    modelConfigured = false;
    const gamma = {...context, stageId: 'gamma'};
    await environments.savePlan(gamma, plan);
    const createdGamma = await environments.create(gamma);
    assert.equal((await prepared(gamma)).preparation.status, 'needs_setup');
    assert.match(browser.summary(gamma).preparation.error, /model API key/i);
    assert.equal(environments.summaries(context.key).find(item => item.id === createdGamma.environment.id).status, 'ready');
    // Saving other settings must not convert an automatic URL into an explicit
    // target and silently reuse it for the next environment.
    await browser.saveConfig(gamma, {targetUrl: 'http://127.0.0.1:45123/', scope: 'Saved focus'});
    await browser.prepareEnvironment(gamma, {id: 'gamma-without-frontend', stageId: 'gamma', status: 'ready', services: []});
    assert.equal(browser.summary(gamma).preparation.status, 'needs_setup');
    assert.equal((await browser.view(gamma)).config.targetUrl, '');
    assert.equal((await browser.view(gamma)).config.scope, 'Saved focus');
    const ambiguous = {...context, stageId: 'ambiguous'};
    // Neither app is a known web frontend, and there is more than one, so no URL is guessed.
    await browser.prepareEnvironment(ambiguous, {id: 'ambiguous-environment', stageId: 'ambiguous', status: 'ready', apps: [{id: 'api', url: 'http://127.0.0.1:45000/'}, {id: 'admin', url: 'http://127.0.0.1:45001/'}]});
    assert.equal(browser.summary(ambiguous).preparation.status, 'needs_setup');
    assert.equal((await browser.view(ambiguous)).config.targetUrl, '');
    await browser.saveConfig(ambiguous, {targetUrl: 'http://127.0.0.1:45001/'});
    assert.equal(browser.summary(ambiguous).preparation, null, 'A saved target settles the setup it asked for');
    assert.equal(started, 1, 'Saving a target starts no discovery');
    // A generated twin may name its apps otherwise than the scan; the web frontend's directory still identifies it.
    const generated = {...context, stageId: 'generated', scan: {...context.scan, services: [{id: 'service-web', path: 'web', framework: 'Next.js'}, {id: 'service-api', path: 'api', framework: 'Express'}]}};
    await browser.prepareEnvironment(generated, {id: 'generated-environment', stageId: 'generated', status: 'ready', apps: [{id: 'backend', url: 'http://127.0.0.1:45000/', directory: 'api'}, {id: 'site', url: 'http://127.0.0.1:45123/', directory: './web/'}]});
    assert.equal((await browser.view(generated)).config.targetUrl, 'http://127.0.0.1:45123/');
    assert.match(browser.summary(generated).preparation.error, /model API key/i, 'Only the missing model stops it');
    const stale = {...context, stageId: 'stale'};
    await browser.prepareEnvironment(stale, {id: 'stale-environment', stageId: 'stale', status: 'ready', services: []}, {isCurrent: () => false});
    assert.equal(browser.summary(stale).preparation.status, 'needs_setup');
    assert.match(browser.summary(stale).preparation.error, /source changed/i);
    modelConfigured = true;
    let current = true;
    const changed = {...context, stageId: 'changed'};
    await browser.prepareEnvironment(changed, {id: 'changed-environment', stageId: 'changed', status: 'ready', apps: [{id: 'frontend', url: 'http://127.0.0.1:45123/'}]}, {isCurrent: () => current});
    // A branch may change while the model is still exploring. Its stale
    // proposals must not enter that pipeline stage's shared case collection.
    for (const deadline = Date.now() + WAIT; !releaseDiscovery && Date.now() < deadline;) await delay(1);
    assert.equal(typeof releaseDiscovery, 'function');
    current = false;releaseDiscovery();
    const rejected = await prepared(changed);
    assert.equal(rejected.preparation.status, 'failed');
    assert.match(rejected.preparation.error, /source changed/i);
    assert.equal(rejected.cases.length, 0);
    await environments.close();await browser.close();
    environments = await createEnvironmentManager({dataDir: input.dataDir, onReady: unexpected});
    browser = await createBrowserManager({dataDir: input.dataDir, runtime});
    assert.equal(callbacks, 2);
    assert.equal(started, 2);
    assert.equal(browser.summary(context).cases[0].name, 'Reviewed workspace journey');
    assert.equal(browser.summary(gamma).preparation.status, 'needs_setup');
    await browser.prepareEnvironment(gamma, {...createdGamma.environment, status: 'ready'});
    assert.equal(started, 2);
    await environments.close();await browser.close();
  `;
  const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script, JSON.stringify({dataDir, repoPath,
    environmentRuntime: new URL('../src/environments/runtime.ts', import.meta.url).href,
    environmentManager: new URL('../src/environments/manager.ts', import.meta.url).href,
    browserManager: new URL('../src/browser/manager.ts', import.meta.url).href,
  })], {timeout: 10000, maxBuffer: 64 * 1024});
  assert.equal(result.stdout, '');
});
