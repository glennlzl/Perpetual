import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { githubMark, combinedMark, githubBuildSummary, githubBuildStatus, githubRunsActive, workflowRuns, jobRuns, stepMark, workflowMark, jobMark, actionLabel, actionText, createGitHubRunsPoller } from '../client/src/lib/pipeline-github.ts';
import type { GitHubJob, GitHubRun, GitHubRuns, GitHubStep } from '../client/src/lib/pipeline-github.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
// Shapes returned by GET /api/github/runs (src/github-runs.ts).
const step = (name: string, status: string, conclusion: string | null = null): GitHubStep => ({ number: 1, name, status, conclusion });
const job = (name: string, status: string, conclusion: string | null, steps: GitHubStep[] = []): GitHubJob => ({ id: name, name, status, conclusion, startedAt: null, completedAt: null, url: null, steps });
const run = (id: string, path: string | null, status: string, conclusion: string | null, jobs: GitHubJob[] | null = null): GitHubRun => ({ id, name: 'CI', path, event: 'push', status, conclusion, attempt: 1, sha: SHA, branch: null, url: null, createdAt: null, startedAt: null, updatedAt: null, jobs });
const result = (runs: GitHubRun[]): GitHubRuns => ({ repository: 'acme/storefront', sha: SHA, runs });
// Scanned .github/workflows files, the same set the Build rail lists.
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/lint.yml', '.github/workflows/release.yml'];

test('GitHub statuses and conclusions map to neutral status marks', () => {
  assert.deepEqual(['requested', 'pending', 'queued', 'waiting', 'in_progress'].map(status => githubMark({ status })), ['queued', 'queued', 'queued', 'waiting', 'running']);
  assert.deepEqual(['success', 'failure', 'timed_out', 'startup_failure', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale', null].map(conclusion => githubMark({ status: 'completed', conclusion })), ['passed', 'failed', 'failed', 'failed', 'cancelled', 'skipped', 'passed', 'waiting', 'cancelled', null]);
  assert.equal(githubMark(null), null);
  assert.equal(combinedMark(['passed', 'failed', 'running']), 'running');
  assert.equal(combinedMark(['passed', 'failed']), 'failed');
  assert.equal(combinedMark(['skipped', 'passed']), 'passed');
  assert.equal(combinedMark([null]), null);
});

test('the Build summary uses current-commit runs only and never claims deployment', () => {
  assert.deepEqual(githubBuildSummary(result([run('1', '.github/workflows/ci.yml', 'in_progress', null), run('2', '.github/workflows/lint.yml', 'completed', 'failure')]), SHA, WORKFLOWS), { status: 'running', sha: 'cb9292c' });
  assert.deepEqual(githubBuildSummary(result([run('1', '.github/workflows/ci.yml', 'completed', 'success')]), SHA, WORKFLOWS), { status: 'passed', sha: 'cb9292c' });
  assert.deepEqual(githubBuildSummary(result([run('1', '.github/workflows/ci.yml', 'completed', 'failure')]), SHA, WORKFLOWS), { status: 'failed', sha: 'cb9292c' });
  assert.equal(githubBuildSummary(result([run('1', '.github/workflows/ci.yml', 'completed', 'success')]), '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567', WORKFLOWS), null, 'A result for another commit is ignored.');
  assert.equal(githubBuildSummary(result([]), SHA, WORKFLOWS), null);
  assert.equal(githubBuildSummary(null, SHA, WORKFLOWS), null);
  assert.equal(githubRunsActive(result([run('1', '.github/workflows/ci.yml', 'queued', null)]), WORKFLOWS), true);
  assert.equal(githubRunsActive(result([run('1', '.github/workflows/ci.yml', 'waiting', null)]), WORKFLOWS), false, 'Waiting for approval is not active work.');
  assert.equal(githubRunsActive(null, WORKFLOWS), false);
});

test('the Build status claims nothing until the current commit\'s runs are read, and Not run only once none ran for it', () => {
  const passed = result([run('1', '.github/workflows/ci.yml', 'completed', 'success')]);
  assert.equal(githubBuildStatus(undefined, SHA, WORKFLOWS), null, 'Runs still loading show no status.');
  assert.equal(githubBuildStatus(null, SHA, WORKFLOWS), null, 'A read that failed shows no status.');
  assert.equal(githubBuildStatus({ ...passed, sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567' }, SHA, WORKFLOWS), null, 'The previous commit\'s runs, just after the source moved, show no status.');
  assert.equal(githubBuildStatus(passed, null, WORKFLOWS), null);
  assert.deepEqual(githubBuildStatus(result([]), SHA, WORKFLOWS), { kind: 'idle', text: 'Not run' });
  assert.deepEqual(githubBuildStatus(result([run('7', 'dynamic/pages/pages-build-deployment', 'completed', 'success')]), SHA, WORKFLOWS), { kind: 'idle', text: 'Not run' }, 'Only a listed workflow runs the stage.');
  assert.deepEqual(githubBuildStatus(passed, SHA, WORKFLOWS), { kind: 'passed', text: 'Passed', sha: 'cb9292c' });
  assert.deepEqual(githubBuildStatus(result([run('1', '.github/workflows/ci.yml', 'in_progress', null)]), SHA, WORKFLOWS), { kind: 'working', text: 'Running', sha: 'cb9292c' });
  assert.deepEqual(githubBuildStatus(result([run('1', '.github/workflows/ci.yml', 'queued', null)]), SHA, WORKFLOWS), { kind: 'working', text: 'Queued', sha: 'cb9292c' });
  assert.deepEqual(githubBuildStatus(result([run('1', '.github/workflows/ci.yml', 'completed', 'failure')]), SHA, WORKFLOWS), { kind: 'failed', text: 'Failed', sha: 'cb9292c' });
  assert.deepEqual(githubBuildStatus(result([run('1', '.github/workflows/ci.yml', 'completed', 'cancelled')]), SHA, WORKFLOWS), { kind: 'idle', text: 'Cancelled', sha: 'cb9292c' });
});

test('runs without a rail row never set the Build status or activity', () => {
  // Dynamic runs report paths such as dynamic/pages/pages-build-deployment or
  // dynamic/github-code-scanning/codeql; none is a scanned workflow file.
  const dynamic = [
    run('7', 'dynamic/pages/pages-build-deployment', 'completed', 'failure'),
    run('8', 'dynamic/github-code-scanning/codeql', 'in_progress', null),
    run('9', 'dynamic/dependabot/dependabot-updates', 'queued', null),
  ];
  assert.equal(githubBuildSummary(result(dynamic), SHA, WORKFLOWS), null, 'Only unlisted runs leave the stage unrun.');
  assert.equal(githubRunsActive(result(dynamic), WORKFLOWS), false, 'An unlisted running run neither animates Source to Build nor pulses GitHub.');
  const listed = run('1', '.github/workflows/ci.yml@refs/heads/main', 'completed', 'success');
  assert.deepEqual(githubBuildSummary(result([...dynamic, listed]), SHA, WORKFLOWS), { status: 'passed', sha: 'cb9292c' }, 'A failed Pages run cannot mark a passing rail as failed.');
  assert.equal(githubBuildSummary(result([listed]), SHA, []), null, 'With no scanned workflows there is no rail to summarise.');
  assert.equal(githubBuildSummary(result([listed]), SHA), null);
  assert.equal(githubRunsActive(result([run('10', null, 'in_progress', null)]), ['']), false, 'A run without a path never matches a row.');
});

test('rail rows match runs by workflow path, jobs by name, and steps by name', () => {
  const data = result([
    run('1', '.github/workflows/ci.yml', 'in_progress', null, [
      job('Test (ubuntu-latest, 22)', 'completed', 'success', [step('Run actions/checkout@v4', 'completed', 'success'), step('Unit tests', 'completed', 'success')]),
      job('Test (ubuntu-latest, 24)', 'in_progress', null, [step('Run actions/checkout@v4', 'completed', 'success'), step('Unit tests', 'in_progress')]),
      job('lint', 'completed', 'failure', [step('Lint', 'completed', 'failure')]),
      job('Deploy / publish', 'queued', null),
    ]),
    run('2', '.github/workflows/release.yml', 'completed', 'success'),
  ]);
  assert.deepEqual(workflowRuns(data, '.github/workflows/ci.yml').map(item => item.id), ['1']);
  assert.equal(workflowMark(data, '.github/workflows/ci.yml'), 'running');
  assert.equal(workflowMark(data, '.github/workflows/release.yml'), 'passed');
  assert.equal(workflowMark(data, '.github/workflows/unknown.yml'), null);
  const runs = workflowRuns(data, '.github/workflows/ci.yml');
  assert.equal(jobRuns(runs, { id: 'test', name: 'Test' }).length, 2, 'Matrix jobs share their configured name.');
  assert.equal(jobMark(runs, { id: 'test', name: 'Test' }), 'running');
  assert.equal(jobMark(runs, { id: 'lint', name: 'lint' }), 'failed');
  assert.equal(jobMark(runs, { id: 'deploy', name: 'Deploy' }), 'queued', 'Reusable workflow jobs are prefixed by their caller.');
  assert.equal(jobMark(runs, { id: 'build', name: 'Build ${{ matrix.os }}' }), null, 'An unmatched job has no mark.');
  const tests = jobRuns(runs, { id: 'test', name: 'Test' });
  assert.equal(stepMark(tests, { name: 'actions/checkout@v4' }), 'passed');
  assert.equal(stepMark(tests, { name: 'Unit tests' }), 'running');
  assert.equal(stepMark(tests, { name: 'Run command' }), null);
  assert.equal(stepMark(null, { name: 'Unit tests' }), null);
});

test('rail labels shorten action refs and unevaluated expressions without changing matching', () => {
  // Scanned names from GET /api/github-actions: unnamed `uses:` steps carry the full reference.
  assert.deepEqual(actionLabel('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5'), { text: 'actions/checkout', ref: '34e1148', contexts: [] });
  assert.deepEqual(actionLabel('github/codeql-action/init@v3'), { text: 'github/codeql-action/init', ref: 'v3', contexts: [] }, 'A tag ref is kept whole.');
  assert.deepEqual(actionLabel(`docker://ghcr.io/acme/tool@sha256:${'ab'.repeat(32)}`), { text: 'docker://ghcr.io/acme/tool', ref: 'abababa', contexts: [] });
  assert.deepEqual(actionLabel('./.github/actions/setup'), { text: './.github/actions/setup', ref: null, contexts: [] });
  assert.deepEqual(actionLabel('Frontend Tests (${{ matrix.shard }}/2)', 'frontend-tests'), { text: 'Frontend Tests', ref: null, contexts: ['matrix'] });
  assert.deepEqual(actionLabel('Build on ${{ matrix.os }}'), { text: 'Build', ref: null, contexts: ['matrix'] });
  assert.deepEqual(actionLabel('Deploy to ${{ github.event.inputs.environment }}'), { text: 'Deploy', ref: null, contexts: ['github'] }, 'Only the root context is named.');
  assert.deepEqual(actionLabel('${{ matrix.name }}', 'build'), { text: 'build', ref: null, contexts: ['matrix'] }, 'An expression-only name falls back to the job id.');
  assert.deepEqual(actionLabel("${{ format('{0}', 1) }} build"), { text: 'build', ref: null, contexts: ['expression'] });
  assert.deepEqual(actionLabel('Run command'), { text: 'Run command', ref: null, contexts: [] });
  assert.equal(actionText('Frontend Tests (${{ matrix.shard }}/2)'), 'Frontend Tests (matrix)');
  assert.equal(actionText('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5'), 'actions/checkout 34e1148');
  const runs = [run('1', '.github/workflows/ci.yml', 'in_progress', null, [job('Frontend Tests (1/2)', 'completed', 'success', [step('Run actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5', 'completed', 'success')])])];
  assert.equal(jobMark(runs, { id: 'frontend-tests', name: 'Frontend Tests' }), 'passed');
  assert.equal(stepMark(jobRuns(runs, { id: 'frontend-tests', name: 'Frontend Tests' }), { name: 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5' }), 'passed', 'Steps still match by their original name.');
});

type TimerHandle = { callback: () => unknown; delay: number };
function harness() {
  const timers: { queue: TimerHandle[]; setTimeout(callback: () => unknown, delay: number): TimerHandle; clearTimeout(handle: unknown): void } = { queue: [], setTimeout(callback, delay) { const handle = { callback, delay }; this.queue.push(handle); return handle; }, clearTimeout(handle) { this.queue = this.queue.filter(item => item !== handle); } };
  const document = Object.assign(new EventTarget(), { hidden: false });
  // Each test schedules a read before it looks at or fires the next one.
  return { timers, document, next: () => timers.queue.at(-1)!, fire: async () => { const handle = timers.queue.shift()!; await handle.callback(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the poller reads every 5 seconds while a current-commit run is active, otherwise every 60', async () => {
  const h = harness(), requests: string[] = [], changes: (GitHubRuns | null)[] = [];
  let response = result([run('1', '.github/workflows/ci.yml', 'in_progress', null)]);
  const poller = createGitHubRunsPoller({ controller: async path => { requests.push(path); return structuredClone(response); }, repoPath: '/repo', workflows: WORKFLOWS, onChange: value => changes.push(value), document: h.document, timers: h.timers });
  await flush();
  assert.deepEqual(requests, ['/api/github/runs?repoPath=%2Frepo']);
  assert.equal(h.next().delay, 5000);
  await h.fire();
  assert.equal(changes.length, 1, 'An unchanged result is not republished.');
  response = result([run('1', '.github/workflows/ci.yml', 'completed', 'success')]);
  await h.fire();
  assert.equal(changes.length, 2);
  assert.equal(h.next().delay, 60000);
  poller.stop();
  assert.equal(h.timers.queue.length, 0);
});

test('a running run without a rail row does not speed up polling', async () => {
  const h = harness();
  const poller = createGitHubRunsPoller({ controller: async () => result([run('8', 'dynamic/github-code-scanning/codeql', 'in_progress', null)]), repoPath: '/repo', workflows: WORKFLOWS, onChange: () => {}, document: h.document, timers: h.timers });
  await flush();
  assert.equal(h.next().delay, 60000);
  poller.stop();
});

test('the poller pauses while hidden and reads immediately when visible again', async () => {
  const h = harness(), requests: string[] = [];
  const poller = createGitHubRunsPoller({ controller: async path => { requests.push(path); return result([]); }, repoPath: '/repo', onChange: () => {}, document: h.document, timers: h.timers });
  await flush();
  h.document.hidden = true;
  await h.fire();
  assert.equal(requests.length, 1, 'A timer that fires while hidden does not read.');
  assert.equal(h.timers.queue.length, 0, 'No read is scheduled while the page is hidden.');
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(h.next().delay, 60000);
  poller.stop();
  h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(requests.length, 2, 'A stopped poller ignores visibility.');
});

test('a hidden page does not start reading, and an unavailable gate clears the result', async () => {
  const h = harness(), changes: (GitHubRuns | null)[] = [];
  h.document.hidden = true;
  let fail = false;
  const poller = createGitHubRunsPoller({ controller: async () => { if (fail) throw new Error('Connect your GitHub account'); return result([run('1', 'ci', 'queued', null)]); }, repoPath: '/repo', onChange: value => changes.push(value), document: h.document, timers: h.timers });
  await flush();
  assert.equal(changes.length, 0);
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(changes.length, 1);
  fail = true; await h.fire();
  assert.deepEqual(changes.at(-1), null);
  assert.equal(h.next().delay, 60000);
  poller.stop();
});

test('configuration files without a GitHub edit URL stay plain local paths', async () => {
  const source = await readFile(new URL('../client/src/ServiceSettings.tsx', import.meta.url), 'utf8');
  const [linked, plain] = source.slice(source.indexOf('configuration.files.map(')).split(/\n\s*: <div key=\{file\.path\}/);
  assert.match(linked, /file\.editUrl\s*\?/);
  assert.match(linked, /href=\{file\.editUrl\}/);
  const row = plain.slice(0, plain.indexOf('</div>)}'));
  assert.doesNotMatch(row, /<a\b|href=|asChild/, 'A branch that is not on GitHub never gets an edit link.');
  assert.match(row, /font-mono[^"]*">\{file\.path\}/);
  assert.match(row, /\{file\.local && <Badge[^>]*>Local<\/Badge>\}/);
});

test('Git graph refs show their last segment and details stay inside the sheet', async () => {
  const source = await readFile(new URL('../client/src/components/commit-graph.tsx', import.meta.url), 'utf8');
  assert.match(source, /<span aria-hidden="true">\{refLabel\(ref\)\}<\/span>\s*<span className="sr-only">\{ref\}<\/span>/, 'The pill keeps the full ref for assistive technology.');
  assert.match(source, /<p title=\{row\.commit\.message\}[^>]*truncate/);
  assert.match(source, /side="bottom"/);
  assert.doesNotMatch(source, /side="right"/);
  assert.match(source, /collisionBoundary=\{boundary\}/);
  assert.match(source, /closest\('\[role="dialog"\]'\)/);
});

const clientSource = (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
// Evaluates a function sliced out of a client module: its types are stripped first, as Node does when it runs TypeScript.
const evaluate = (code: string, name: string, ...parameters: string[]) => (...values: unknown[]): unknown => new Function(...parameters, `${stripTypeScriptTypes(code)}\nreturn ${name};`)(...values);
type CatalogModel = { id: string; name: string; provider: string };

test('model groups use the catalog vendor names and merge slugs case-insensitively', async () => {
  const source = await clientSource('AppSettings.tsx');
  const start = source.indexOf('const providerNames');
  const end = source.indexOf('\n}\n', source.indexOf('function modelGroups(')) + 2;
  const modelGroups = evaluate(source.slice(start, end), 'modelGroups')() as (models: CatalogModel[], current: string) => { label: string; models: CatalogModel[] }[];
  const model = (id: string, name: string): CatalogModel => ({ id, name, provider: id.split('/')[0] });
  const groups = modelGroups([
    model('amazon/nova-pro', 'Amazon: Nova Pro 1.0'),
    model('bytedance-seed/seed-1.6', 'ByteDance Seed: Seed 1.6'),
    model('meta/muse-spark', 'Meta: Muse Spark 1.1'),
    model('meta-llama/llama-4-scout', 'Meta: Llama 4 Scout'),
    model('moonshotai/kimi-k2.5', 'MoonshotAI: Kimi K2.5'),
    model('moonshot/kimi-k3', 'Moonshotai: Kimi K3'),
    model('openai/gpt-5.4-mini', 'OpenAI: GPT-5.4 Mini'),
    model('openai/gpt-4.1', 'OpenAI: GPT-4.1'),
    model('openrouter/auto', 'Auto Router'),
    model('stealth/space-bunny', 'Space Bunny Alpha'),
    model('x-ai/grok-4.5', 'SpaceXAI: Grok 4.5'),
  ], 'openai/gpt-5.4-mini');
  assert.deepEqual(groups.map(group => group.label), ['Amazon', 'ByteDance Seed', 'Meta', 'MoonshotAI', 'OpenAI', 'OpenRouter', 'SpaceXAI', 'Stealth'], 'Readable labels, sorted, with no raw slugs or duplicate vendors.');
  assert.deepEqual(groups.find(group => group.label === 'Meta')!.models.map(item => item.id), ['meta-llama/llama-4-scout', 'meta/muse-spark']);
  assert.equal(groups.find(group => group.label === 'MoonshotAI')!.models.length, 2, 'Labels differing only in case share one group.');
  assert.deepEqual(groups.find(group => group.label === 'OpenAI')!.models.map(item => item.id), ['openai/gpt-4.1'], 'The pinned Current/Default model is not repeated in its vendor group.');
  assert.match(source, /<PinnedGroup label=\{pinnedLabel\}>\{modelOption\(pinned\)\}/);
  assert.match(source, /<ModelSelect id="openrouter-model" value=\{model\} models=\{models\} pinned=\{pinnedModel\} pinnedLabel=\{savedModel === serverModel \? 'Current' : 'Default'\}/);
  assert.match(source, /<Label htmlFor="openrouter-escalation-model"[^>]*>Escalation model<\/Label>/, 'The escalation model is a second Select beside the model.');
  assert.match(source, /<ModelSelect id="openrouter-escalation-model" value=\{escalationModel\} models=\{models\} pinned=\{pinnedEscalation\} pinnedLabel=\{savedEscalation === serverEscalation \? 'Current' : 'Default'\}/);
  assert.match(source, /<SelectItem value=\{item\.id\} key=\{item\.id\} textValue=\{item\.name\}>/, 'Typeahead keeps the full catalog name.');
});

test('invalid fields stay red inside scoped sheets and dialogs', async () => {
  const css = await clientSource('workspace.css');
  const fieldRule = css.indexOf('[data-slot="select-trigger"]) {\n  background: var(--workspace-field);');
  const focusRule = css.indexOf(':where(a[href], button, input, textarea, select, summary, [role="tab"]):focus-visible');
  const scope = ':is(.app-settings, .pipeline-inspector, .git-graph-inspector, [data-slot="dialog-content"], [data-slot="alert-dialog-content"])';
  const border = css.indexOf(`${scope} :is([data-slot="input"], [data-slot="textarea"], [data-slot="select-trigger"])[aria-invalid="true"] { border-color: var(--destructive); }`);
  const outline = css.indexOf(`${scope} [aria-invalid="true"]:focus-visible { outline-color: var(--destructive); }`);
  assert.ok(fieldRule > 0 && focusRule > fieldRule, 'The scoped field and focus rules exist.');
  assert.ok(border > focusRule && outline > focusRule, 'The invalid overrides follow the scoped rules they must outrank.');
  assert.match(css, /\.new-test-composer:has\(\.new-test-description\[aria-invalid="true"\]\) \{ border-color: var\(--destructive\); \}/, 'The borderless composer shows the invalid state on its frame.');
});

test('stage dialogs share one compact pattern and read-only drawers close from the header', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  const settings = await clientSource('StageSettingsDialog.tsx');
  assert.match(settings, /<DialogTitle>Rename stage<\/DialogTitle>/);
  assert.doesNotMatch(settings, /Stage settings/);
  assert.match(dialogs, /if \(dialog\?\.type === 'stage'\) return <NewStageDialog /, 'New stage opens a Dialog, not the 560px Sheet.');
  const newStage = dialogs.slice(dialogs.indexOf('function NewStageDialog('), dialogs.indexOf('function DialogForm('));
  assert.match(newStage, /<Dialog open /);
  assert.match(newStage, /<DialogTitle>New stage<\/DialogTitle>/);
  assert.match(newStage, /onAction\(\{ action: 'add-stage', afterStageId, name: trimmedName \}\)/);
  assert.match(newStage, /focusOrigin\.current\.focus\(\{ preventScroll: true \}\)/, 'Closing returns focus to the + that opened it.');
  const form = dialogs.slice(dialogs.indexOf('function DialogForm('), dialogs.indexOf('export default function PipelineDialogs'));
  assert.doesNotMatch(form, /'stage'|add-stage/, 'The Sheet form no longer carries the stage fields.');
  assert.match(form, /\{type !== 'service' && <SheetFooter/, 'A read-only service drawer has no footer Close beside the header X.');
  assert.doesNotMatch(form, />\{type === 'service' \? 'Close'/);
  const graph = await clientSource('GitGraphPanel.tsx');
  assert.doesNotMatch(graph, />Close<\/Button>/);
  assert.match(graph, /\{history && <SheetFooter/);
});

test('non-modal sheets let Tab leave at their edges instead of looping', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  assert.match(dialogs, /<Sheet modal=\{false\}/);
  assert.match(dialogs, /onInteractOutside=\{event => event\.preventDefault\(\)\} onKeyDownCapture=\{event => releaseTabAtEdges\(event, focusOrigin\.current\)\}>/);
  assert.match(dialogs, /onEscapeKeyDown=\{event => \{ if \(locked\) event\.preventDefault\(\); \}\}/, 'Escape still closes the sheet.');
});

// A minimal document: elements in preorder, a TreeWalker honouring REJECT/SKIP, and focus.
function tabDocument() {
  type TreeWalker = { readonly currentNode: Element | undefined; nextNode(): Element | null };
  type TabDocument = { activeElement: Element | null; body?: Element; createTreeWalker?(root: Element, show: number, filter: { acceptNode(node: Element): number }): TreeWalker };
  type ElementOptions = { tabIndex?: number; visible?: boolean; disabled?: boolean; guard?: boolean; children?: Element[] };
  const FILTER = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  const doc: TabDocument = { activeElement: null };
  class Element {
    declare name: string; declare tabIndex: number; declare visible: boolean; declare disabled: boolean; declare guard: boolean; declare children: Element[];
    declare parent: Element | null; declare hidden: boolean; declare inert: boolean;
    constructor(name: string, { tabIndex = 0, visible = true, disabled = false, guard = false, children = [] }: ElementOptions = {}) {
      Object.assign(this, { name, tabIndex, visible, disabled, guard, children, parent: null, hidden: false, inert: false });
      for (const child of children) child.parent = this;
    }
    get isConnected() { let node: Element = this; while (node.parent) node = node.parent; return node === doc.body; }
    matches() { return this.disabled; }
    hasAttribute(name: string) { return name === 'data-radix-focus-guard' && this.guard; }
    checkVisibility() { return this.visible; }
    contains(node: Element | null) { for (let item = node; item; item = item.parent) if (item === this) return true; return false; }
    compareDocumentPosition(other: Element) {
      const order: Element[] = [];
      const visit = (node: Element) => { order.push(node); node.children.forEach(visit); };
      visit(doc.body!);
      if (other === this) return 0;
      if (this.contains(other)) return 4 | 16;
      if (other.contains(this)) return 2 | 8;
      return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
    }
    focus() { doc.activeElement = this; }
  }
  doc.createTreeWalker = (root, _show, { acceptNode }) => {
    const order: Element[] = [];
    const visit = (node: Element) => { for (const child of node.children) { const verdict = acceptNode(child); if (verdict === FILTER.FILTER_REJECT) continue; if (verdict === FILTER.FILTER_ACCEPT) order.push(child); visit(child); } };
    visit(root);
    let index = -1;
    return { get currentNode() { return order[index]; }, nextNode: () => order[++index] ?? null };
  };
  const el = (name: string, options?: ElementOptions) => new Element(name, options);
  const nodes: Record<string, Element> = {
    sidebar: el('sidebar'), before: el('before'), opener: el('opener'), after: el('after'),
    disabled: el('disabled', { disabled: true }), hidden: el('hidden', { visible: false }), last: el('last'),
    close: el('close'), link: el('link'), startGuard: el('guard', { guard: true }), endGuard: el('guard', { guard: true }),
  };
  nodes.sheet = el('sheet', { tabIndex: -1, children: [nodes.close, nodes.link] });
  nodes.empty = el('empty sheet', { tabIndex: -1 });
  doc.body = el('body', { tabIndex: -1, children: [nodes.startGuard, el('root', { tabIndex: -1, children: [nodes.sidebar, el('canvas', { tabIndex: -1, children: [nodes.before, nodes.opener, nodes.after, nodes.disabled, nodes.hidden] }), nodes.last] }), nodes.sheet, nodes.empty, nodes.endGuard] });
  return { doc, nodes, FILTER, Element };
}

test('Tab at a sheet edge continues from its opener in document order, never on a focus guard', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  const source = dialogs.slice(dialogs.indexOf('const visible = '), dialogs.indexOf('function NewStageDialog('));
  const { doc, nodes, FILTER, Element } = tabDocument();
  type TabNode = InstanceType<typeof Element>;
  type TabEvent = { key: string; shiftKey: boolean; ctrlKey?: boolean; currentTarget: TabNode; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void };
  const releaseTabAtEdges = evaluate(source, 'releaseTabAtEdges', 'document', 'NodeFilter', 'Node', 'Element')(doc, FILTER, { DOCUMENT_POSITION_FOLLOWING: 4 }, Element) as (event: TabEvent, origin: TabNode | null) => void;
  const press = (focused: TabNode, origin: TabNode | null, { shiftKey = false, sheet = nodes.sheet, ...keys }: { shiftKey?: boolean; sheet?: TabNode; ctrlKey?: boolean } = {}) => {
    doc.activeElement = focused;
    const event: TabEvent = { key: 'Tab', shiftKey, ...keys, currentTarget: sheet, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    releaseTabAtEdges(event, origin);
    return { focused: doc.activeElement!.name, prevented: event.prevented, stopped: event.stopped };
  };
  assert.deepEqual(press(nodes.link, nodes.opener), { focused: 'after', prevented: true, stopped: true }, 'Tab past the last control reaches the element after the opener.');
  assert.deepEqual(press(nodes.close, nodes.opener, { shiftKey: true }), { focused: 'before', prevented: true, stopped: true }, 'Shift+Tab past the first control reaches the element before the opener.');
  assert.equal(press(nodes.sheet, nodes.opener, { shiftKey: true }).focused, 'before', 'Shift+Tab from the focused sheet itself also leaves before the opener.');
  assert.deepEqual(press(nodes.close, nodes.opener), { focused: 'close', prevented: false, stopped: false }, 'Inside the sheet the browser moves focus.');
  assert.deepEqual(press(nodes.sheet, nodes.opener), { focused: 'sheet', prevented: false, stopped: false }, 'Tab from the sheet itself enters its first control.');
  assert.equal(press(nodes.link, nodes.after).focused, 'last', 'Disabled and invisible controls are skipped.');
  assert.equal(press(nodes.link, nodes.last).focused, 'sidebar', 'Past the last page control focus wraps to the first, not the trailing guard.');
  assert.equal(press(nodes.link, null).focused, 'sidebar', 'Without an opener the sheet stands at the end of the page.');
  assert.equal(press(nodes.close, new Element('removed opener'), { shiftKey: true }).focused, 'last', 'A disconnected opener falls back to the sheet position.');
  assert.equal(press(nodes.empty, nodes.opener, { sheet: nodes.empty }).focused, 'after', 'A sheet without controls hands Tab to the element after its opener.');
  assert.deepEqual(press(nodes.link, nodes.opener, { ctrlKey: true }), { focused: 'link', prevented: false, stopped: false }, 'Modified Tab is left alone.');
});

test('a new stage proposes the Greek letter that fits its position, always unique', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  type StagePipeline = { stages: { id: string; name: string; kind: string }[] };
  const nextStageName = evaluate(dialogs.slice(dialogs.indexOf('const GREEK = '), dialogs.indexOf('function InspectorMark(')), 'nextStageName')() as (pipeline: StagePipeline, afterStageId: string) => string;
  const pipeline = (...names: string[]): StagePipeline => ({ stages: [{ id: 'source', name: 'Source', kind: 'source' }, { id: 'build', name: 'Build', kind: 'build' }, ...names.map(name => ({ id: name.toLowerCase(), name, kind: 'sandbox' })), { id: 'production', name: 'Production', kind: 'production' }] });
  assert.equal(nextStageName(pipeline('Beta'), 'build'), 'Alpha', 'Before Beta proposes Alpha, not Gamma.');
  assert.equal(nextStageName(pipeline('Beta'), 'beta'), 'Gamma');
  assert.equal(nextStageName(pipeline('Beta', 'Gamma'), 'gamma'), 'Delta', 'After the last sandbox, the next letter.');
  assert.equal(nextStageName(pipeline('Alpha', 'Delta'), 'alpha'), 'Beta', 'Between two letters, the first unused one between them.');
  assert.equal(nextStageName(pipeline(), 'build'), 'Beta', 'The first sandbox is Beta, as the docs name it.');
  assert.equal(nextStageName(pipeline('Alpha', 'Beta'), 'alpha'), 'Sandbox', 'No letter fits between Alpha and Beta.');
  assert.equal(nextStageName(pipeline('Alpha', 'Beta', 'Sandbox'), 'build'), 'Sandbox 2');
  assert.equal(nextStageName(pipeline('Staging'), 'staging'), 'Beta', 'Renamed sandboxes do not bound the sequence.');
  assert.equal(nextStageName(pipeline('BETA'), 'build'), 'Alpha', 'Letters match case-insensitively.');
  assert.equal(nextStageName(pipeline('Omega'), 'omega'), 'Sandbox');
  for (const names of [['Beta'], ['Alpha', 'Beta', 'Gamma'], ['Gamma', 'Beta'], ['Sandbox', 'Alpha', 'Beta']]) {
    const current = pipeline(...names);
    for (const stage of current.stages.slice(1, -1)) {
      const name = nextStageName(current, stage.id);
      assert.ok(!current.stages.some(item => item.name.toLowerCase() === name.toLowerCase()), `${name} is unique after ${stage.name}`);
    }
  }
  const newStage = dialogs.slice(dialogs.indexOf('function NewStageDialog('), dialogs.indexOf('function DialogForm('));
  assert.match(newStage, /useState\(\(\) => nextStageName\(pipeline, afterStageId\)\)/);
  assert.match(newStage, /if \(name === nextStageName\(pipeline, afterStageId\)\) setName\(nextStageName\(pipeline, value\)\);/, 'An untouched name follows a changed placement.');
});

test('stage dialogs close from the same header X as the other dialogs', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  const settings = await clientSource('StageSettingsDialog.tsx');
  const newStage = dialogs.slice(dialogs.indexOf('function NewStageDialog('), dialogs.indexOf('function DialogForm('));
  assert.match(newStage, /<DialogContent [^>]*showCloseButton=\{!locked\}/);
  assert.match(settings, /<DialogContent \{\.\.\.modalProps\} aria-describedby=\{undefined\} showCloseButton=\{!closeLocked\}>/);
  assert.doesNotMatch(newStage + settings, /showCloseButton=\{false\}/);
});

test('App Settings names the saved key state and enabled light fields do not look disabled', async () => {
  const source = await clientSource('AppSettings.tsx');
  assert.match(source, /\{capabilities && <Badge id="openrouter-api-key-state" variant=\{hasSavedKey \? 'secondary' : 'outline'\}>\{hasSavedKey \? 'Saved' : 'Not set'\}<\/Badge>\}/);
  assert.match(source, /aria-describedby=\{capabilities \? 'openrouter-api-key-state' : undefined\}/);
  const css = await clientSource('workspace.css');
  assert.match(css, /:root \{[^}]*--workspace-field: var\(--background\);/, 'Light fields share the panel background.');
  assert.match(css, /\.dark \{[^}]*--workspace-field: var\(--surface-field\);/, 'Dark fields keep their raised surface.');
  assert.match(css, /background: var\(--workspace-field\);\n  border-color: var\(--input\);/, 'The 3:1 --input border still bounds every field.');
});

test('the commit list is one tab stop with arrow-key row navigation', async () => {
  const source = await readFile(new URL('../client/src/components/commit-graph.tsx', import.meta.url), 'utf8');
  assert.match(source, /tabIndex=\{i === tabbableRow \? 0 : -1\}\s*onFocus=\{\(\) => setActiveRow\(i\)\}/);
  assert.match(source, /role="group" aria-label="Commits" onKeyDown=\{moveBetweenRows\}/);
  const move = source.slice(source.indexOf('function moveBetweenRows('), source.indexOf('return (', source.indexOf('function moveBetweenRows(')));
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.match(move, new RegExp(`${key}:`));
  assert.match(move, /if \(index < 0\) return/, 'Keys from the portalled commit detail are ignored.');
  assert.doesNotMatch(move, /Enter|" "/, 'Enter and Space stay with the row button.');
  const css = await clientSource('components/commit-graph.css');
  assert.match(css, /\[data-slot="commit-entry"\]:focus-visible \{\n  outline: 2px solid var\(--muted-foreground\);\n  outline-offset: -2px;/, 'The inset focus ring stays.');
  const panel = await clientSource('GitGraphPanel.tsx');
  assert.match(panel, /focusAfterLoad\.current = history\.commits\.length; setLimit/, 'Load more resumes focus on the first new commit.');
});

test('a preview alias deploying another branch carries the Test settings mismatch mark', async () => {
  const dialogs = await clientSource('PipelineDialogs.tsx');
  assert.match(dialogs, /<ServiceSettings nodeId=\{dialog\.nodeId\} repoPath=\{scan\?\.repo\?\.path\} deployBranches=\{node\?\.deployBranches\} branch=\{scan\?\.repo\?\.branch\} \/>/);
  const source = await clientSource('ServiceSettings.tsx');
  assert.match(source, /const mismatch = branch && branches\.length && !branches\.includes\(branch\) \? \{ branches, branch \} : null;/, 'Only a scanned deploy branch list that omits the scanned branch is flagged.');
  assert.match(source, /mismatch=\{field\.key === 'previewAlias' \? mismatch : null\}/);
  const mark = source.slice(source.indexOf('function BranchMismatch('), source.indexOf('function ConfigField('));
  assert.match(mark, /<GitBranch aria-hidden="true"/);
  assert.match(mark, /text-\(--warning\)/);
  assert.match(mark, /<TooltipContent>\{branchMismatchNote\(branches, branch\)\}<\/TooltipContent>/, 'The Tooltip shares the Test settings wording.');
  assert.match(mark, /tabIndex=\{0\}/, 'Keyboard users can reach the Tooltip.');
});
