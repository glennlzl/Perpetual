import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubDeploymentsPoller, deploymentMark, deploymentsActive, isRecordedDeployment, moreDeployments, productionRows } from '../client/src/lib/pipeline-deployments.ts';
import type { DeploymentGroupRow, GitHubDeployment, GitHubDeployments } from '../client/src/lib/pipeline-deployments.ts';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
type Target = { id: string; kind?: string; provider?: string; label?: string };
// Shapes returned by GET /api/github/deployments (src/github-deployments.ts).
const deployment = (id: string, provider: string, environment: string, state: string | null, extra: Partial<GitHubDeployment> = {}): GitHubDeployment => ({
  id, environment, provider, creator: `${provider.toLowerCase()}[bot]`, production: null, transient: null, ref: null, task: null, createdAt: null, updatedAt: null,
  state, stateAt: null, url: `https://${environment.replace(/\W+/g, '-').toLowerCase()}.example.test`, logUrl: null, ...extra,
});
const result = (deployments: GitHubDeployment[], sha = SHA): GitHubDeployments => ({ repository: 'acme/storefront', sha, deployments });
// Production rows as the delivery projection supplies them.
const railway: DeploymentGroupRow<Target> = { id: 'deployment-provider:railway', kind: 'deployment-group', provider: 'Railway', label: 'Railway', deployments: [{ id: 'railway:api', kind: 'deployment', provider: 'Railway', label: '@acme/api deployment' }] };
const custom: Target = { id: 'custom:deploy', kind: 'deployment', provider: 'Acme Cloud', label: 'Acme deploy' };
const ROWS: readonly (Target | DeploymentGroupRow<Target>)[] = [railway, custom];

test('deployment states map to marks, and only queued or in-progress records are active', () => {
  assert.deepEqual(['pending', 'queued', 'in_progress', 'success', 'failure', 'error', 'inactive', 'surprising', null].map(state => deploymentMark({ state })), ['queued', 'queued', 'deploying', 'deployed', 'failed', 'failed', 'inactive', null, null]);
  assert.equal(deploymentMark(null), null);
  assert.equal(deploymentsActive(result([deployment('1', 'Vercel', 'Production – web', 'in_progress')])), true);
  assert.equal(deploymentsActive(result([deployment('1', 'Vercel', 'Production – web', 'success'), deployment('2', 'Vercel', 'Preview – web', 'inactive')])), false);
  assert.equal(deploymentsActive(null), false);
});

test('recorded deployments join the provider group discovery supplied, or form one after it', () => {
  const rows = productionRows(ROWS, result([
    deployment('11', 'Vercel', 'Production – web', 'success'),
    deployment('12', 'Railway', 'acme-workflow / production', 'success', { url: null }),
    deployment('13', 'Vercel', 'Production – web', 'inactive'),
  ]), SHA);
  assert.deepEqual(rows.map(row => row.id), ['deployment-provider:railway', 'custom:deploy', 'deployment-provider:vercel'], 'Supplied rows keep their order; a new provider follows them.');
  const [railwayRows, , vercelRows] = rows as DeploymentGroupRow<Target>[];
  assert.deepEqual(railwayRows.deployments.map(row => [row.id, row.label]), [['railway:api', '@acme/api deployment'], ['github-deployment:12', 'acme-workflow / production']], 'The discovered target stays first in its group.');
  assert.deepEqual(vercelRows, { id: 'deployment-provider:vercel', kind: 'deployment-group', provider: 'Vercel', label: 'Vercel', deployments: [{ id: 'github-deployment:11', kind: 'github-deployment', provider: 'Vercel', label: 'Production – web', deployment: deployment('11', 'Vercel', 'Production – web', 'success') }] });
  assert.equal(vercelRows.deployments.length, 1, 'One row per environment keeps the newest record.');
  assert.ok(isRecordedDeployment(vercelRows.deployments[0]));
  assert.equal(isRecordedDeployment(railwayRows.deployments[0]), false);
  assert.deepEqual(railway.deployments.length, 1, 'The supplied group is not mutated.');
});

test('a reply that says older records exist links to the repository\'s deployments on GitHub; a complete one links nowhere', () => {
  const records = [deployment('11', 'Vercel', 'Production – web', 'success')];
  assert.equal(moreDeployments({ ...result(records), more: true }), 'https://github.com/acme/storefront/deployments');
  assert.equal(moreDeployments(result(records)), null);
  assert.equal(moreDeployments(null), null);
});

test('records for another commit, or none, leave the supplied rows as they are', () => {
  assert.equal(productionRows(ROWS, result([deployment('11', 'Vercel', 'Production – web', 'success')], '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'), SHA), ROWS);
  assert.equal(productionRows(ROWS, result([]), SHA), ROWS);
  assert.equal(productionRows(ROWS, null, SHA), ROWS);
  assert.equal(productionRows(ROWS, result([deployment('11', 'Vercel', 'Production – web', 'success')]), null), ROWS);
  const alone = productionRows<Target>([], result([deployment('11', 'Netlify', 'Production', 'success')]), SHA);
  assert.deepEqual(alone.map(row => [row.id, (row as DeploymentGroupRow<Target>).deployments.length]), [['deployment-provider:netlify', 1]], 'A repository without discovered targets still lists its recorded deployments.');
});

type TimerHandle = { callback: () => unknown; delay: number };
function harness() {
  const timers: { queue: TimerHandle[]; setTimeout(callback: () => unknown, delay: number): TimerHandle; clearTimeout(handle: unknown): void } = { queue: [], setTimeout(callback, delay) { const handle = { callback, delay }; this.queue.push(handle); return handle; }, clearTimeout(handle) { this.queue = this.queue.filter(item => item !== handle); } };
  const document = Object.assign(new EventTarget(), { hidden: false });
  return { timers, document, next: () => timers.queue.at(-1)!, fire: async () => { const handle = timers.queue.shift()!; await handle.callback(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a read refused while a source change saves keeps the recorded deployments', async () => {
  const h = harness(), changes: (GitHubDeployments | null)[] = [];
  let busy = false;
  const poller = createGitHubDeploymentsPoller({ controller: async () => {
    if (busy) throw Object.assign(new Error('A source change is still being saved. Please wait.'), { statusCode: 409, sourceBusy: true });
    return result([deployment('11', 'Vercel', 'Production – web', 'success')]);
  }, repoPath: '/repo', onChange: value => changes.push(value), document: h.document, timers: h.timers });
  await flush();
  busy = true; await h.fire();
  assert.equal(changes.length, 1, 'Production keeps its recorded rows.');
  assert.ok(changes[0]?.deployments.length);
  busy = false; await h.fire();
  assert.equal(changes.length, 1, 'The same records read again change nothing.');
  poller.stop();
});

test('the poller reads every 5 seconds while a deployment is in progress, otherwise every 60', async () => {
  const h = harness(), requests: string[] = [], changes: (GitHubDeployments | null)[] = [];
  let response = result([deployment('11', 'Vercel', 'Production – web', 'in_progress')]);
  const poller = createGitHubDeploymentsPoller({ controller: async path => { requests.push(path); return structuredClone(response); }, repoPath: '/repo', onChange: value => changes.push(value), document: h.document, timers: h.timers });
  await flush();
  assert.deepEqual(requests, ['/api/github/deployments?repoPath=%2Frepo']);
  assert.equal(h.next().delay, 5000);
  await h.fire();
  assert.equal(changes.length, 1, 'An unchanged result is not republished.');
  response = result([deployment('11', 'Vercel', 'Production – web', 'success')]);
  await h.fire();
  assert.equal(changes.length, 2);
  assert.equal(h.next().delay, 60000);
  poller.stop();
  assert.equal(h.timers.queue.length, 0);
});
