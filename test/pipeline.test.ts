import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultPipeline, applyPipelineAction, normalizedPipeline } from '../src/pipeline.ts';
import { fetch, startServer } from './fixtures/controller.ts';
import { STAGE_LIMIT, createStageDataCache, outgoingTransition, sourceProvenance, stageNodeData, statusChanges } from '../client/src/lib/pipeline-nodes.ts';
import { useRememberedOpen } from '../client/src/lib/remembered-open.ts';

test('sandbox stages preserve fixed ordering, can be collapsed and removed without mutating the input', () => {
  const original = defaultPipeline('/repo/alpha');
  const before = structuredClone(original);
  const beta = applyPipelineAction(original, { action: 'add-stage', afterStageId: 'build', name: ' Beta ' });
  assert.deepEqual(original, before);
  assert.deepEqual(beta.stages.map(stage => stage.name), ['Source', 'Build', 'Beta', 'Production']);
  assert.equal(beta.stages[2].kind, 'sandbox');
  const gamma = applyPipelineAction(beta, { action: 'add-stage', afterStageId: beta.stages[2].id, name: 'Gamma' });
  assert.deepEqual(gamma.stages.map(stage => stage.name), ['Source', 'Build', 'Beta', 'Gamma', 'Production']);
  const collapsed = applyPipelineAction(gamma, { action: 'toggle-stage', stageId: 'source' });
  assert.equal(collapsed.stages[0].collapsed, true);
  assert.equal(gamma.stages[0].collapsed, false);
  const removed = applyPipelineAction(collapsed, { action: 'remove-stage', stageId: beta.stages[2].id });
  assert.deepEqual(removed.stages.map(stage => stage.name), ['Source', 'Build', 'Gamma', 'Production']);
});

test('fixed stages cannot be removed or bypassed and stage labels are bounded and unique', () => {
  const pipeline = defaultPipeline('/repo/alpha');
  for (const stageId of ['source', 'build', 'production']) assert.throws(() => applyPipelineAction(pipeline, { action: 'remove-stage', stageId }), /fixed/i);
  for (const afterStageId of ['source', 'production', 'missing']) assert.throws(() => applyPipelineAction(pipeline, { action: 'add-stage', afterStageId, name: 'Beta' }), /production|stage|build/i);
  for (const name of ['', ' ', 'x'.repeat(41), ' SOURCE ']) assert.throws(() => applyPipelineAction(pipeline, { action: 'add-stage', afterStageId: 'build', name }), /name|unique|duplicate/i);
  assert.throws(() => applyPipelineAction(pipeline, { action: 'reorder-stage', stageId: 'source' }), /action/i);
  let full = pipeline;
  for (let index = 0; index < 9; index++) full = applyPipelineAction(full, { action: 'add-stage', afterStageId: 'build', name: `Sandbox ${index}` });
  assert.equal(full.stages.length, 12);
  assert.throws(() => applyPipelineAction(full, { action: 'add-stage', afterStageId: 'build', name: 'One more' }), /12/);
});

test('a pipeline saved while Build was Build & Deploy reads as Build, keeping its state and transitions', () => {
  const saved = { repoPath: '/repo/alpha', stages: [
    { id: 'source', name: 'Source', kind: 'source', collapsed: false },
    { id: 'build-deploy', name: 'Build & Deploy', kind: 'build-deploy', collapsed: true, githubWorkflow: '.github/workflows/ci.yml' },
    { id: 'beta', name: 'Beta', kind: 'sandbox', collapsed: false },
    { id: 'production', name: 'Production', kind: 'production', collapsed: false },
  ], transitions: [{ id: 'build-deploy:beta', source: 'build-deploy', target: 'beta', blocked: true, reason: 'Hold' }] };
  const before = structuredClone(saved);
  const pipeline = normalizedPipeline(saved);
  assert.deepEqual(pipeline.stages[1], { id: 'build', name: 'Build', kind: 'build', collapsed: true, githubWorkflow: '.github/workflows/ci.yml' });
  assert.deepEqual(pipeline.transitions.map(({ id, blocked, reason }) => [id, blocked, reason]), [['source:build', false, ''], ['build:beta', true, 'Hold'], ['beta:production', false, '']]);
  assert.deepEqual(saved, before, 'The saved definition is not mutated.');
  assert.equal(applyPipelineAction(saved, { action: 'toggle-stage', stageId: 'build' }).stages[1].collapsed, false, 'An action on the saved definition finds Build.');
});

test('unknown fields and stale repo inputs are rejected atomically', () => {
  const pipeline = applyPipelineAction(defaultPipeline('/repo/alpha'), { action: 'add-stage', name: 'Beta' });
  const before = structuredClone(pipeline);
  assert.throws(() => applyPipelineAction(pipeline, { action: 'toggle-stage', stageId: 'source', status: 'passed' }), /field/i);
  assert.throws(() => applyPipelineAction(pipeline, { repoPath: '/repo/other', action: 'toggle-stage', stageId: 'source' }), /repository/i);
  assert.deepEqual(pipeline, before);
});

type Reply = { status: number; data: { repo: { path: string }; pipeline: { repoPath: string; stages: { id: string; name: string }[] } } };
async function serverFixture(t: TestContext, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-pipeline-'));
  const repoA = join(root, 'repo-a'), repoB = join(root, 'repo-b'), dataDir = join(root, 'data');
  for (const [repo, name] of [[repoA, 'Alpha'], [repoB, 'Beta']]) { await mkdir(repo); await writeFile(join(repo, 'package.json'), JSON.stringify({ name })); }
  if (legacy) {
    // Retired repair reports, HTTP checks and HTTP test drafts from earlier releases.
    const stages = [['source', 'Source', 'source'], ['build-deploy', 'Build & Deploy', 'build-deploy'], ['legacy-beta', 'Beta', 'sandbox'], ['production', 'Production', 'production']]
      .map(([id, name, kind]) => ({ id, name, kind, collapsed: false, tests: [{ id: `draft-${id}`, kind: 'canary', name: 'Existing check', config: null }] }));
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan: null, providers: [], runs: [{ id: 'prior-report' }], checks: { runs: [], schedules: [] }, pipelines: { [repoA]: { repoPath: repoA, stages } } } }));
  }
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    app = await startServer({ port: 0, repo: repoA, dataDir });
    const { token } = await (await fetch(`${app.url}/api/session`)).json();
    return async (path: string, body?: unknown): Promise<Reply> => {
      const response = await fetch(app!.url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
  }
  return { repoA, repoB, dataDir, request: await start(), restart: async () => { await app!.close(); return start(); } };
}

test('pipeline API isolates repositories, drops retired state and persists stage definitions', async t => {
  const fixture = await serverFixture(t, true);
  let request = fixture.request;
  assert.equal((await request('/api/pipeline')).status, 400);
  const scanA = await request('/api/scan', { path: fixture.repoA });
  const repoA = scanA.data.repo.path;
  let response = await request('/api/pipeline');
  assert.deepEqual(response.data.pipeline.stages.map(stage => stage.id), ['source', 'build', 'legacy-beta', 'production']);
  assert.ok(response.data.pipeline.stages.every(stage => !Object.hasOwn(stage, 'tests')));
  const state = (await request('/api/state')).data;
  assert.equal(Object.hasOwn(state, 'runs'), false);
  assert.equal(Object.hasOwn(state, 'checks'), false);
  response = await request('/api/pipeline/action', { repoPath: repoA, action: 'add-stage', afterStageId: 'legacy-beta', name: 'Gamma' });
  assert.equal(response.status, 200);
  const scanB = await request('/api/scan', { path: fixture.repoB });
  const repoB = scanB.data.repo.path;
  assert.equal((await request('/api/pipeline/action', { repoPath: repoA, action: 'toggle-stage', stageId: 'source' })).status, 409);
  response = await request('/api/pipeline');
  assert.equal(response.data.pipeline.repoPath, repoB);
  assert.equal(response.data.pipeline.stages.length, 3);
  request = await fixture.restart();
  await request('/api/scan', { path: fixture.repoA });
  response = await request('/api/pipeline');
  assert.deepEqual(response.data.pipeline.stages.map(stage => stage.name), ['Source', 'Build', 'Beta', 'Gamma', 'Production']);
  const disk: { pipelines: Record<string, { stages: object[] }> } = JSON.parse(await readFile(join(fixture.dataDir, 'state.json'), 'utf8')).state;
  assert.equal(Object.hasOwn(disk, 'runs'), false);
  assert.equal(Object.hasOwn(disk, 'checks'), false);
  assert.ok(Object.values(disk.pipelines).every(pipeline => pipeline.stages.every(stage => !Object.hasOwn(stage, 'tests'))));
});

test('concurrent pipeline mutations serialize and failed persistence cannot change the visible definition', async t => {
  const fixture = await serverFixture(t);
  const request = fixture.request;
  const scan = await request('/api/scan', { path: fixture.repoA });
  const repoPath = scan.data.repo.path;
  const action = (body: Record<string, unknown>) => request('/api/pipeline/action', { repoPath, ...body });
  const responses = await Promise.all(['Beta', 'Gamma'].map(name => action({ action: 'add-stage', afterStageId: 'build', name })));
  assert.ok(responses.every(response => response.status === 200));
  const before = (await request('/api/pipeline')).data.pipeline;
  assert.equal(before.stages.length, 5);
  const savedState = await readFile(join(fixture.dataDir, 'state.json'));
  await rm(join(fixture.dataDir, 'state.json')); await mkdir(join(fixture.dataDir, 'state.json'));
  assert.equal((await action({ action: 'toggle-stage', stageId: 'source' })).status, 400);
  assert.deepEqual((await request('/api/pipeline')).data.pipeline, before);
  await rm(join(fixture.dataDir, 'state.json'), { recursive: true });
  await writeFile(join(fixture.dataDir, 'state.json'), savedState);
  assert.equal((await action({ action: 'toggle-stage', stageId: 'source' })).status, 200);
  const disk = JSON.parse(await readFile(join(fixture.dataDir, 'state.json'), 'utf8'));
  assert.equal(disk.state.pipelines[repoPath].stages[0].collapsed, true);
});

const SHA = '8f5624170ff12d8c21d8a7d5de59a47550a89058';
const localScan = () => ({ repo: { name: 'storefront', path: '/work/storefront', sha: SHA, remote: 'https://github.com/acme/storefront.git' }, delivery: { source: [{ id: 'repository', provider: 'GitHub' }], build: [], production: [] } });

test('Source status reports the scanned commit and where it came from, never an inferred connection', () => {
  assert.deepEqual(sourceProvenance(localScan()), { origin: 'local', revision: '8f56241' }, 'A GitHub remote alone is a local checkout.');
  assert.deepEqual(sourceProvenance(localScan(), { repository: 'acme/storefront', scanPath: '/work/storefront' }), { origin: 'github', revision: '8f56241' });
  assert.deepEqual(sourceProvenance(localScan(), { repository: 'acme/storefront', scanPath: '/data/sources/other' }), { origin: 'local', revision: '8f56241' }, 'A saved source for another path does not describe this scan.');
  assert.deepEqual(sourceProvenance({ repo: { path: '/work/empty', sha: null } }), { origin: '', revision: '' });
  assert.deepEqual(sourceProvenance(null), { origin: '', revision: '' });
});

test('stage data carries Source provenance as primitives and no rollback entry', () => {
  const pipeline = defaultPipeline('/work/storefront'), [source, , production] = pipeline.stages;
  const reuse = createStageDataCache();
  const data = (scan: ReturnType<typeof localScan>) => stageNodeData(source, { scan, pipeline });
  const scan = localScan(), first = reuse('source', data(scan));
  assert.equal(first.origin, 'local');
  assert.equal(first.revision, '8f56241');
  assert.equal('rollback' in first, false, 'Nothing is deployed to Production, so no stage offers a rollback.');
  assert.equal(reuse('source', data({ ...scan, repo: { ...scan.repo } })), first, 'A new repo record for the same commit keeps the card data.');
  assert.notEqual(reuse('source', data({ ...scan, repo: { ...scan.repo, sha: 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281' } })), first);
  assert.equal(stageNodeData(production, { scan: localScan(), pipeline }).origin, undefined);
});

test('Production finds its deployment targets in the scan alone, never in the deployments GitHub records', () => {
  type Row = { id: string; kind?: string; provider?: string; label?: string; deployments?: Row[] };
  const pipeline = defaultPipeline('/work/storefront'), [, build, production] = pipeline.stages;
  const record: Row = { id: 'deployment-provider:vercel', kind: 'deployment-group', provider: 'Vercel', label: 'Vercel', deployments: [{ id: 'github-deployment:11', kind: 'github-deployment', provider: 'Vercel', label: 'Production' }] };
  const target: Row = { id: 'railway:api', kind: 'deployment', provider: 'Railway', label: '@acme/api deployment' };
  const scan = (rows: Row[]) => ({ repo: { path: '/work/storefront', sha: SHA }, delivery: { source: [], build: [], production: rows } });
  const recorded = stageNodeData<unknown, Row>(production, { scan: scan([]), pipeline, production: [record] });
  assert.deepEqual(recorded.services, [record], 'The recorded deployment joins Production\'s rows.');
  assert.equal(recorded.discovered, false, 'A deployment GitHub records is no deployment target of the repository.');
  assert.equal(stageNodeData<unknown, Row>(production, { scan: scan([target]), pipeline }).discovered, true);
  assert.equal(stageNodeData<unknown, Row>(production, { scan: scan([target]), pipeline, production: [target, record] }).discovered, true);
  assert.equal('discovered' in stageNodeData<unknown, Row>(build, { scan: scan([target]), pipeline }), false, 'Only Production carries it.');
});

test('each stage carries its outgoing transition as primitives for controls rendered after it', () => {
  let pipeline = applyPipelineAction(defaultPipeline('/work/storefront'), { action: 'add-stage', afterStageId: 'build', name: 'Beta' });
  const beta = pipeline.stages[2].id;
  pipeline = applyPipelineAction(pipeline, { action: 'set-transition', sourceStageId: beta, targetStageId: 'production', blocked: true });
  const [source, build, sandbox, production] = pipeline.stages;
  assert.deepEqual(outgoingTransition(source, pipeline), { next: 'build', nextName: 'Build', nextBlocked: false, canInsert: false, atStageLimit: false }, 'Nothing is inserted before Build.');
  assert.deepEqual(outgoingTransition(build, pipeline), { next: beta, nextName: 'Beta', nextBlocked: false, canInsert: true, atStageLimit: false });
  assert.deepEqual(outgoingTransition(sandbox, pipeline), { next: 'production', nextName: 'Production', nextBlocked: true, canInsert: true, atStageLimit: false });
  assert.deepEqual(outgoingTransition(production, pipeline), { next: '', nextName: '', nextBlocked: false, canInsert: false, atStageLimit: false }, 'Production leads nowhere.');
  let full = pipeline;
  while (full.stages.length < STAGE_LIMIT) full = applyPipelineAction(full, { action: 'add-stage', afterStageId: 'build', name: `Sandbox ${full.stages.length}` });
  assert.equal(outgoingTransition(full.stages[1], full).atStageLimit, true);
  const reuse = createStageDataCache(), context = { scan: localScan(), pipeline };
  const first = reuse('build', stageNodeData(build, context));
  assert.equal(first.next, beta);
  assert.equal(reuse('build', stageNodeData(build, { ...context, pipeline: structuredClone(pipeline) })), first, 'An identical reloaded pipeline keeps the card data.');
});

test('remembered disclosures stay open for the page session and start collapsed', () => {
  let setOpen = (_next: SetStateAction<boolean>) => {};
  function Group({ id, defaultOpen }: { id: string; defaultOpen?: boolean }) { const [open, set] = useRememberedOpen(id, defaultOpen); setOpen = set; return createElement('span', null, String(open)); }
  const render = (id: string, defaultOpen?: boolean) => renderToStaticMarkup(createElement(Group, { id, defaultOpen }));
  const key = `/work/storefront\nproduction\ndeployment-provider:railway:${Math.random()}`;
  assert.equal(render(key), '<span>false</span>');
  setOpen(true);
  assert.equal(render(key), '<span>true</span>', 'Returning from Settings remounts the group open.');
  assert.equal(render(`${key}:vercel`), '<span>false</span>', 'Other groups keep their own default.');
  setOpen(open => !open);
  assert.equal(render(`${key}:vercel`), '<span>true</span>');
  assert.equal(render(`${key}:new`, true), '<span>true</span>');
});

// WCAG relative luminance for #rrggbb tokens.
const luminance = (hex: string | undefined) => hex!.match(/[\da-f]{2}/gi)!.map(pair => parseInt(pair, 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a: string | undefined, b: string | undefined) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + 0.05) / (dark + 0.05); };

test('canvas text and paused edges keep their contrast in the light theme', async () => {
  const [index, css] = await Promise.all(['index.css', 'pipeline.css'].map(file => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8')));
  const light = /:root \{([^}]*)\}/.exec(index)![1];
  const token = (source: string, name: string) => new RegExp(`${name}:\\s*(#[\\da-f]{6})`, 'i').exec(source)?.[1];
  const canvas = token(light, '--surface-canvas'), muted = token(light, '--muted-foreground');
  for (const surface of [canvas, token(light, '--surface-field'), token(light, '--muted'), '#ffffff']) assert.ok(contrast(muted, surface) >= 4.5, `${muted} on ${surface}`);
  const edge = token(/\.delivery-app \{([^}]*)\}/.exec(css)![1], '--pipeline-edge-muted');
  assert.ok(edge && contrast(edge, canvas) >= 3, `paused edge ${edge} on ${canvas}`);
  assert.ok(parseFloat(/\.transition-label \{[^}]*font-size: (\d+)px/.exec(css)![1]) >= 12);
});

test('the release canvas keeps keyboard focus on real controls and one heading level per stage', async () => {
  const app = await readFile(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
  const flow = /<ReactFlow [^>]*>/.exec(app)![0];
  for (const prop of ['nodesFocusable={false}', 'edgesFocusable={false}', 'disableKeyboardA11y']) assert.ok(flow.includes(prop), prop);
  assert.match(app, /<h1 id="pipeline-heading" className="sr-only">Release pipeline<\/h1>/, 'The pipeline page has its own h1.');
  assert.match(app, /<BaseNodeHeaderTitle as="h2">/, 'Stage titles sit directly below the page heading.');
  assert.doesNotMatch(app, /<h2 id="pipeline-heading"/);
  // React Flow hard-codes role="application"; the wrapper becomes a labelled region instead.
  assert.match(flow, /ref=\{flowElement\}/);
  assert.match(app, /flowElement\.current\?\.setAttribute\('role', 'region'\)/);
  assert.match(app, /flowElement\.current\?\.setAttribute\('aria-labelledby', 'pipeline-heading'\)/);
  assert.doesNotMatch(app, /<section[^>]*aria-labelledby="pipeline-heading"/, 'One landmark carries the pipeline name.');
  assert.doesNotMatch(app, /className="stage-status"[^>]*role="status"/, 'Every stage badge as a live region announces each poll.');
  assert.doesNotMatch(app, /LockKeyhole/, 'Pause and resume are not locks.');
  // Nothing on the canvas is selectable or deletable, so React Flow's hidden instructions are blank.
  assert.match(flow, /ariaLabelConfig=\{ARIA_LABELS\}/);
  const labels = /const ARIA_LABELS = (\{[^}]*\});/.exec(app)?.[1] || '';
  for (const key of ['node.a11yDescription.default', 'node.a11yDescription.keyboardDisabled', 'edge.a11yDescription.default']) assert.ok(labels.includes(`'${key}': ''`), key);
  assert.equal(app.match(/role="status"/g)?.length, 1, 'One live region speaks for the canvas.');
  assert.match(app, /<p className="sr-only" role="status" aria-atomic="true">\{message\}<\/p>/);
});

test('the canvas announces a stage only when its status text changes', () => {
  const statuses = [{ id: 'source', name: 'Source', text: 'Local' }, { id: 'beta', name: 'Beta', text: 'Creating' }];
  const first = statusChanges(null, statuses);
  assert.equal(first.message, '', 'The first render is silent.');
  const poll = statusChanges(first.seen, structuredClone(statuses));
  assert.equal(poll.message, '', 'A poll that changed nothing says nothing.');
  const ready = statusChanges(poll.seen, [statuses[0], { ...statuses[1], text: 'Ready' }, { id: 'gamma', name: 'Gamma', text: 'Not provisioned' }]);
  assert.equal(ready.message, 'Beta: Ready', 'A new stage is not a status change.');
  assert.equal(statusChanges(ready.seen, [{ id: 'source', name: 'Source', text: 'GitHub' }]).message, 'Source: GitHub', 'Removed stages stay silent.');
  const both = statusChanges(ready.seen, [{ ...statuses[0], text: 'Transition paused' }, { ...statuses[1], text: 'Destroying' }]);
  assert.equal(both.message, 'Source: Transition paused. Beta: Destroying');
});

test('a stage whose status is not known yet is announced neither then nor when it first becomes known', () => {
  const build = (text: string) => [{ id: 'build-deploy', name: 'Build & Deploy', text }];
  const loading = statusChanges(null, build(''));
  const loaded = statusChanges(loading.seen, build('Passed'));
  assert.equal(loaded.message, '', 'The first status after the page loads is not a change.');
  const moved = statusChanges(loaded.seen, build(''));
  assert.equal(moved.message, '', 'Runs still loading for a new commit say nothing.');
  assert.equal(statusChanges(moved.seen, build('Passed')).message, '', 'The same status for the new commit is not a change.');
  assert.equal(statusChanges(moved.seen, build('Running')).message, 'Build & Deploy: Running');
});

const source = async (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const stageNode = (app: string) => app.slice(app.indexOf('function StageNode('), app.indexOf('function TransitionEdge('));

test('transition controls follow their source stage in keyboard order', async () => {
  const app = await source('App.tsx');
  assert.doesNotMatch(app, /EdgeLabelRenderer/, 'Edge labels render before every node, so Tab reached all transitions first.');
  assert.match(stageNode(app), /\{next && <StageTransition /, 'The source card renders its outgoing transition last.');
  const transition = app.slice(app.indexOf('function StageTransition('), app.indexOf('function StageNode('));
  for (const label of ['Add stage between ${stageName} and ${nextName}', '${blocked ? \'Resume\' : \'Pause\'} transition from ${stageName} to ${nextName}']) assert.ok(transition.includes(label), label);
});

test('Build & Deploy shows no status Badge while its runs load, rather than Not run', async () => {
  const app = await source('App.tsx');
  const status = app.slice(app.indexOf('function stageStatus('), app.indexOf('function HealthAge('));
  assert.doesNotMatch(app, /'Not run'/, 'Only githubBuildStatus says Not run, once the current commit\'s runs were read.');
  assert.match(status, /return buildStatus \?\? null;/);
  assert.match(app, /watchedBuildStatus\(github, buildReadError\)/);
  const badge = app.slice(app.indexOf('function StageStatus('), app.indexOf('function StageTransition('));
  assert.match(badge, /status: StageStatusView \| null/);
  assert.ok(badge.indexOf('if (!status) return null;') > badge.indexOf('useState(false)'), 'An unknown status renders no Badge, after its hook ran.');
  assert.match(app, /text: stageStatus\(node\.data\.stage, node\.data\)\?\.text \?\? ''/, 'An unknown status is announced as not known yet.');
});

test('status badges vary their form by kind while staying neutral', async () => {
  const app = await source('App.tsx'), css = stripComments(await source('pipeline.css'));
  assert.match(app, /const STATUS_VARIANTS(?:: [^=]+)? = \{ failed: 'destructive', idle: 'outline', unconfigured: 'outline' \};/);
  assert.match(app, /<Badge variant=\{STATUS_VARIANTS\[status\.kind\] \|\| 'secondary'\} className="stage-status"/, 'Present and ready states stay filled.');
  assert.match(css, /\.stage-status:is\(\[data-tone="idle"\], \[data-tone="unconfigured"\]\) \{ color: var\(--muted-foreground\); \}/);
  assert.match(css, /\.stage-status\[data-tone="blocked"\] \{ background: color-mix/);
  // The fixed stage kind reads quieter than the live status beside it.
  assert.match(stageNode(app), /\{sandbox && <Badge variant="outline" className="stage-kind">Sandbox<\/Badge>\}/);
  const kind = [...css.matchAll(/\.delivery-app \.stage-header \.stage-kind \{([^}]*)\}/g)].map(match => match[1]).join(';');
  assert.match(kind, /color: var\(--muted-foreground\)/);
  assert.match(kind, /font-weight: 400/);
  assert.ok(css.indexOf('.stage-header .stage-kind { color') > css.indexOf('.stage-header :is([data-slot="badge"], .stage-status) { font-weight: 500; }'), 'The kind badge weight follows the shared badge weight.');
});

test('stage headers keep status beside the title while it fits, else wrap it below, inside the card', async () => {
  const css = stripComments(await source('pipeline.css')), node = stageNode(await source('App.tsx'));
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  // The header row wraps as a whole: the status group follows the title in source
  // order, so it can only move to a row below it, never above.
  const header = rule('.delivery-app .stage-header');
  assert.match(header, /display: flex; flex-wrap: wrap;/);
  assert.match(header, /gap: 8px 12px;/);
  assert.ok(node.indexOf('<BaseNodeHeaderTitle as="h2">') < node.indexOf('<div className="stage-header-actions">'), 'Title first, status after.');
  // The title may shrink to the card's content width, and only then does a word
  // break: it shares a row only when both fit whole, so a squeezed column never
  // splits "Source" into "Sourc / e".
  assert.match(rule('.delivery-app .stage-header > div:first-child'), /flex: 1 1 auto; align-items: center; gap: 8px; min-width: 0;/);
  assert.match(rule('.delivery-app .stage-header h2, .delivery-app .stage-header h3'), /overflow-wrap: anywhere;/);
  // Actions never overflow: they sit right-aligned, may shrink, and their badges
  // wrap within their own column while the chevron stays beside them.
  assert.match(rule('.delivery-app .stage-header .stage-header-actions'), /display: flex; flex: 0 1 auto; align-items: center; gap: 6px; min-width: 0; margin-left: auto;/);
  assert.doesNotMatch(rule('.delivery-app .stage-header .stage-header-actions'), /flex-wrap/, 'The chevron never wraps away from its badges.');
  assert.match(rule('.delivery-app .stage-header .stage-badges'), /flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0;/);
  assert.match(node, /<div className="stage-badges">\n\s+<StageStatus /);
  assert.match(node, /className="stage-collapse nodrag"/);
  assert.match(rule('.delivery-app .stage-header .stage-collapse'), /flex: none; width: 32px; height: 32px; margin-right: -8px;/);
  // Touch keeps the drawn chevron and title and reaches 44px through a hit area,
  // so a coarse pointer no longer stacks the badge above a 44px chevron.
  assert.doesNotMatch(css, /\.stage-header button\b/, 'No rule sizes every header button, badges included.');
  const coarse = css.slice(css.indexOf('@media (pointer: coarse) {'), css.indexOf('}\n}', css.indexOf('@media (pointer: coarse) {')) + 1);
  assert.doesNotMatch(coarse, /stage-header[^{]*\{[^}]*min-(?:width|height): 44px/);
  assert.match(coarse, /\.stage-header \.stage-collapse::after \{ content: ""; position: absolute; inset: -6px; \}/, '32 + 2 x 6 = 44px');
  assert.match(coarse, /\.stage-header \.stage-title-button::after \{ content: ""; position: absolute; inset: -8px 0; \}/, '28 + 2 x 8 = 44px');
  assert.match(rule('.delivery-app .stage-header .stage-title-button'), /position: relative;/);
  assert.match(css, /@media \(max-width: 767px\) \{\n  \.delivery-app \.stage-header \.stage-kind \{ display: none; \}/, 'The stage kind is the first thing a narrow card drops.');
});

test('the branch trigger sizes to its branch name between a minimum and a cap', async () => {
  const css = stripComments(await source('pipeline.css'));
  assert.doesNotMatch(css, /\.pipeline-branch-toolbar > \[data-slot="select-trigger"\] \{(?:[^}]*[;{])? *width: 256px/, 'A fixed width truncated names with room to spare.');
  assert.match(css, /\.pipeline-branch-toolbar > \[data-slot="select-trigger"\] \{ width: auto; max-width: min\(480px, 100%\); \}/);
  assert.match(css, /@media \(min-width: 640px\) \{ \.delivery-app \.pipeline-branch-toolbar > \[data-slot="select-trigger"\] \{ min-width: 256px; \} \}/);
  assert.match(css, /\.pipeline-branch-toolbar > \[data-slot=select-trigger\] \{ min-width: 0; flex-shrink: 1; \}/, 'It still gives way before the toolbar buttons on a phone.');
});

test('keyboard focus uses one full-strength ring app-wide', async () => {
  const index = await source('index.css'), css = stripComments(await source('pipeline.css'));
  const unlayered = stripComments(index).replace(/@layer[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  assert.match(unlayered, /:focus-visible:not\(\[tabindex="-1"\]\) \{ outline: 2px solid var\(--ring\); outline-offset: 2px; --tw-ring-shadow: 0 0 #0000; \}/, 'Unlayered, the ring outranks utility classes such as outline-none.');
  assert.doesNotMatch(css, /\.pipeline-stage:has\([^)]*\)[^{]*\{[^}]*outline:/, 'The focused control, not its card, carries the ring.');
  assert.doesNotMatch(css, /\.pipeline-stage:(?:has\([^{]*:focus-visible|focus-within)/, 'A focused control does not also change its card border.');
  assert.doesNotMatch(css, /select-trigger"\] \{[^}]*box-shadow: none/, 'The branch Select keeps a visible indicator.');
  assert.doesNotMatch(css, /:focus-visible \{ outline: 2px solid var\(--pipeline-accent\)/);
  // One class plus :focus-visible is the shared panel ring; the invalid ring outranks it anywhere.
  assert.match(unlayered, /\[aria-invalid="true"\]:focus-visible:not\(\[tabindex="-1"\]\) \{ outline-color: var\(--destructive\); \}/);
});

test('switching theme changes colours in one frame without transitions', async () => {
  const app = await source('App.tsx'), index = stripComments(await source('index.css'));
  const effect = /useEffect\(\(\) => \{\n    const root = document\.documentElement;[\s\S]*?\n  \}, \[theme\]\);/.exec(app)?.[0] || '';
  assert.ok(effect, 'theme effect');
  assert.ok(effect.indexOf("root.classList.add('theme-switching')") < effect.indexOf("root.classList.toggle('dark'"), 'Transitions stop before the theme class changes.');
  assert.match(effect, /void root\.offsetHeight;\n    const frame = requestAnimationFrame\(\(\) => root\.classList\.remove\('theme-switching'\)\);/, 'The new colours are styled before transitions return.');
  assert.match(effect, /return \(\) => \{ cancelAnimationFrame\(frame\); root\.classList\.remove\('theme-switching'\); \};/);
  assert.match(index, /\.theme-switching, \.theme-switching \*, \.theme-switching \*::before, \.theme-switching \*::after \{ transition: none !important; \}/);
});

test('field boundaries and the focus ring keep 3:1 in both themes without louder card borders', async () => {
  const index = await source('index.css');
  const light = /:root \{([^}]*)\}/.exec(index)![1], dark = /\.dark \{([^}]*)\}/.exec(index)![1];
  const token = (block: string, name: string) => new RegExp(`${name}:\\s*(#[\\da-f]{6})`, 'i').exec(block)?.[1];
  for (const [theme, block] of [['light', light], ['dark', dark]]) {
    const surfaces = ['--background', '--card', '--muted', '--surface-canvas', '--surface-panel', '--surface-raised', '--surface-field'].map(name => token(block, name)).filter(Boolean);
    for (const name of ['--input', '--ring']) for (const surface of surfaces) assert.ok(contrast(token(block, name), surface) >= 3, `${theme} ${name} ${token(block, name)} on ${surface}`);
  }
  assert.equal(token(light, '--border'), '#e4e4e7');
  assert.equal(token(dark, '--border'), '#2a2b30');
});

test('a sandbox card offers one Integration tests entry, one Add test and hinted footer actions', async () => {
  const node = stageNode(await source('App.tsx'));
  assert.doesNotMatch(node, /Set up integration tests|Retry test generation/, 'The card promised setup it does not do.');
  assert.equal(node.match(/Add test</g)?.length, 1);
  assert.equal(node.match(/>Integration tests</g)?.length, 1);
  assert.match(node, /gap-2 px-1 text-xs" aria-label=\{`Integration tests, \$\{businessCases\.length\}`\} onClick=\{openTests\}>Integration tests<Badge variant="outline" className="tabular-nums">/, 'The count stands apart from its label and is named with it.');
  const hinted = (text: string) => node.slice(node.indexOf(`<Hint text="${text}"><Button`), node.indexOf('</Hint>', node.indexOf(`<Hint text="${text}"><Button`)));
  assert.ok(hinted('Rename').includes('aria-label={`Rename ${stage.name}`}') && hinted('Rename').includes('<Pencil />'), 'Rename is a hinted pencil, not the overloaded sliders icon.');
  assert.ok(hinted('Delete stage').includes('aria-label={`Delete ${stage.name}`}') && hinted('Delete stage').includes('<Trash2 />'));
  assert.doesNotMatch(node, /caseId: 'new'/, 'Add test opens only New test, not the environment sheet as well.');
  assert.match(node, /data-add-test=\{stage\.id\}.*onClick=\{\(\) => addTest\(stage\.id\)\}><Plus \/>Add test/);
});

test('card Add test opens only New test and returns focus to its trigger', async () => {
  const app = await source('App.tsx');
  const panel = app.slice(app.indexOf('function StageNewTest('), app.indexOf('class PageBoundary'));
  assert.match(panel, /<NewTestDialog draftKey=\{newTestDraftKey\(repoPath, stageId\)\}/);
  assert.match(panel, /tx\.post\('draft', \{ description \}\)/);
  assert.doesNotMatch(panel, /openDialog|setDialog/, 'The environment sheet stays closed.');
  assert.match(app, /document\.querySelector(?:<\w+>)?\(`\[data-add-test="\$\{CSS\.escape\(stageId\)\}"\]`\)\?\.focus\(/);
});

test('the canvas follows the app theme and drops unused styles', async () => {
  const app = await source('App.tsx'), css = await source('pipeline.css');
  assert.match(/<ReactFlow [^>]*>/.exec(app)![0], /colorMode=\{theme\}/);
  for (const dead of ['.pipeline-action', '.stage-empty-configbutton', '.header-breadcrumb', '.pending-spinner', '.is-rollback', '--pipeline-action-surface']) assert.equal(css.includes(dead), false, dead);
  assert.match(css, /\.delivery-app \.flow-viewport \{ position: absolute; inset: 84px 0 0; display: flex; flex-direction: column;/, 'A canvas failure stacks above the flow, and a phone docks the canvas toolbar below it.');
});

test('focusable status badges are named buttons, not bare tab stops', async () => {
  const app = await source('App.tsx'), node = stageNode(app);
  const status = app.slice(app.indexOf('function StageStatus('), app.indexOf('function StageTransition('));
  assert.doesNotMatch(app, /<Badge[^>]*tabIndex=/, 'A focusable span has no role for a screen reader.');
  assert.match(status, /className="stage-status" data-tone=\{status\.kind\} asChild=\{Boolean\(hint\)\}>\n\s+\{hint \? <button type="button">\{content\}<\/button> : content\}/, 'Only a badge with a hint takes focus.');
  assert.match(status, /status\.kind === 'failed' && environment\?\.error \? environment\.error/, 'A failed sandbox’s badge says why it failed.');
  assert.match(status, /<TooltipContent className="max-w-sm break-words">\{hint\}<\/TooltipContent>/, 'A long error wraps.');
  assert.match(node, /<Hint text=\{behind\}><Badge asChild variant="outline" className="stage-behind"><button type="button">Behind<\/button><\/Badge><\/Hint>/);
  assert.match(node, /\{repairHead && <Hint text=\{repairHead\}><Badge asChild variant="outline" className="stage-behind"><button type="button">PR head<\/button><\/Badge><\/Hint>\}/, 'A repair twin names its pull request head.');
  assert.match(app, /const stageEnvironments = useMemo\(\(\) => sourceEnvironments\(environments, scan\?\.repo\?\.path\), \[environments, scan\]\);/);
});

test('a canvas failure is a dismissible Alert above the stages, with Try again only where it repeats', async () => {
  const app = await source('App.tsx'), css = stripComments(await source('pipeline.css'));
  const alert = app.slice(app.indexOf('function CanvasError('), app.indexOf('function PipelineCanvas('));
  assert.match(app, /import \{ Alert, AlertDescription \} from '@\/components\/ui\/alert';/, 'The registry Alert.');
  assert.match(alert, /<Alert variant="destructive" className="canvas-alert">/);
  assert.match(alert, /<Button variant="ghost" size="icon" className="size-8" aria-label="Dismiss" onClick=\{onDismiss\}><X \/><\/Button>/);
  assert.match(alert, /\{error\.retry && <Button variant="outline" size="sm" onClick=\{onRetry\}>Try again<\/Button>\}/);
  assert.doesNotMatch(app + css, /canvas-error/, 'The floating banner covered stage headers.');
  const canvas = app.slice(app.indexOf('function PipelineCanvas('), app.indexOf('function StageNewTest('));
  assert.match(canvas, /<div className="flow-viewport" ref=\{canvas\}>\n\s+\{error && <CanvasError error=\{error\} onRetry=\{onRetryError\} onDismiss=\{onDismissError\} \/>\}\n\s+<ReactFlow /, 'It precedes the flow, pushing the stages down.');
  assert.match(css, /\.delivery-app \.canvas-alert \{ flex: none;/);
  assert.doesNotMatch(css, /\.canvas-alert \{[^}]*position: absolute/);
  // Poll dismissal, recurrence and action retry precedence are exercised on the mounted App in pipeline-sync-ui.test.ts,
  // and the refresh after a stage removal in pipeline-canvas-ui.test.ts.
});

test('the header row never clips the sidebar toggle focus ring', async () => {
  const css = stripComments(await source('pipeline.css'));
  assert.match(css, /\.delivery-app \.workspace-context \{ flex: 1; \}/);
  assert.match(css, /\.delivery-app \.workspace-repo \{ min-width: 0; overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/, 'The repository name still truncates.');
});

test('Settings opened from a dialog hands that dialog back on return to the Pipeline', async () => {
  const app = await source('App.tsx');
  assert.match(app, /const openAppSettings = useCallback\(\(\) => navigate\('settings', \{ dialog, newTest \}\), \[navigate, dialog, newTest\]\);/);
  const show = /const showPage = useCallback\(\(next(?:: \w+)?, from(?:: [^=]+)? = null\) => \{[\s\S]*?\n  \}, \[closeDialog\]\);/.exec(app)?.[0] || '';
  assert.match(show, /const restore = next === 'pipeline' && pageRef\.current === 'settings' \? settingsReturn\.current : null;/);
  assert.match(show, /if \(next !== pageRef\.current\) settingsReturn\.current = from;/, 'Sidebar Settings forgets a stale return; staying on Settings keeps it.');
  assert.match(show, /if \(restore\) \{ setDialog\(restore\.dialog\); setNewTest\(restore\.newTest\); \}\n\s+else \{ closeDialog\(\); setNewTest\(''\); \}/);
  assert.match(app, /if \(next !== pageRef\.current\) showPage\(next\);/, 'The hash change navigate causes does not close the dialog it restored; Back still does.');
});
