import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubDeploymentsReader, deploymentProvider, normalizeDeploymentStatus, normalizeDeployments } from '../src/github-deployments.ts';
import type { GitHubResponse } from '../src/github-runs.ts';

type Route = [RegExp, (endpoint: string, etag: string | null) => GitHubResponse];

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
const REPO = 'acme/storefront';
const LOGIN = 'octocat';
// Trimmed from the shapes GitHub returns for GET /repos/{owner}/{repo}/deployments and /deployments/{id}/statuses.
const deployment = (id: number, extra: object = {}) => ({
  id, node_id: 'DE_kwDO', sha: SHA, ref: SHA, task: 'deploy', payload: {}, original_environment: 'Production – storefront', environment: 'Production – storefront', description: null,
  creator: { login: 'vercel[bot]', id: 35613825, type: 'Bot', site_admin: false }, created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:00:00Z',
  url: `https://api.github.com/repos/${REPO}/deployments/${id}`, statuses_url: `https://api.github.com/repos/${REPO}/deployments/${id}/statuses`, repository_url: `https://api.github.com/repos/${REPO}`,
  transient_environment: false, production_environment: true, ...extra,
});
const status = (state: string, extra: object = {}) => ({
  id: 7, node_id: 'DS_kwDO', state, creator: { login: 'vercel[bot]', type: 'Bot' }, description: '', environment: 'Production – storefront', target_url: '', log_url: `https://vercel.com/acme/storefront/deploy/1`, environment_url: 'https://storefront-abc123-acme.vercel.app',
  created_at: '2026-09-23T10:02:00Z', updated_at: '2026-09-23T10:02:00Z', ...extra,
});

function recorder(routes: Route[]) {
  const calls: { endpoint: string; etag: string | null }[] = [];
  const request = async (endpoint: string, etag: string | null) => {
    calls.push({ endpoint, etag });
    const route = routes.find(([pattern]) => pattern.test(endpoint));
    if (!route) throw new Error(`Unexpected endpoint ${endpoint}`);
    return route[1](endpoint, etag);
  };
  return { calls, request };
}

test('normalizes only current-commit deployments, naming the provider from the app that recorded them', () => {
  const records = normalizeDeployments([
    deployment(11),
    deployment(12, { sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567' }),
    deployment(13, { environment: 'storefront-workflow / production', creator: { login: 'railway-app[bot]', type: 'Bot' }, production_environment: 'yes', transient_environment: null, ref: 'main' }),
    deployment(14, { environment: null, creator: null }),
    deployment(15, { sha: SHA.toUpperCase(), creator: { login: 'acme-deploy[bot]', type: 'Bot' } }),
  ], SHA);
  assert.deepEqual(records[0], {
    id: '11', environment: 'Production – storefront', provider: 'Vercel', creator: 'vercel[bot]', production: true, transient: false, ref: SHA, task: 'deploy',
    createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', state: null, stateAt: null, url: null, logUrl: null,
  });
  assert.deepEqual(records.map(record => record.id), ['11', '13', '14', '15'], 'A deployment of another commit never describes the current one.');
  assert.deepEqual([records[1].provider, records[1].production, records[1].transient, records[1].ref], ['Railway', null, null, 'main']);
  assert.deepEqual([records[2].environment, records[2].provider, records[2].creator], ['Deployment', 'GitHub', null]);
  assert.equal(records[3].provider, 'Acme Deploy', 'An unknown app is named from its login.');
  assert.deepEqual(normalizeDeployments({ deployments: [deployment(11)] }, SHA), []);
  assert.deepEqual(['vercel[bot]', 'Railway-App[bot]', 'netlify[bot]', 'github-pages[bot]', 'octocat', '', undefined].map(deploymentProvider), ['Vercel', 'Railway', 'Netlify', 'GitHub Pages', 'Octocat', 'GitHub', 'GitHub']);
});

test('the newest status gives the state and https addresses only', () => {
  assert.deepEqual(normalizeDeploymentStatus([status('success'), status('in_progress')]), { state: 'success', stateAt: '2026-09-23T10:02:00Z', url: 'https://storefront-abc123-acme.vercel.app/', logUrl: `https://vercel.com/acme/storefront/deploy/1` });
  assert.deepEqual(normalizeDeploymentStatus([status('surprising', { environment_url: 'javascript:alert(1)', log_url: 'http://vercel.com/log', target_url: 'https://vercel.com/target' })]), { state: null, stateAt: '2026-09-23T10:02:00Z', url: null, logUrl: 'https://vercel.com/target' });
  assert.deepEqual(normalizeDeploymentStatus([]), { state: null, stateAt: null, url: null, logUrl: null });
  assert.deepEqual(normalizeDeploymentStatus({ state: 'success' }), { state: null, stateAt: null, url: null, logUrl: null });
});

test('reads current-commit deployments with each status, once per settled record', async () => {
  let active = true;
  const { calls, request } = recorder([
    [/deployments\?/, () => ({ status: 200, etag: 'W/"deployments"', data: [deployment(11), deployment(12, { creator: { login: 'railway-app[bot]' }, environment: 'storefront-workflow / production' })] })],
    [/deployments\/11\/statuses/, () => ({ status: 200, etag: null, data: [status(active ? 'in_progress' : 'success')] })],
    [/deployments\/12\/statuses/, () => ({ status: 200, etag: null, data: [status('success', { environment_url: 'https://storefront.up.railway.app' })] })],
  ]);
  let time = 0;
  const reader = createGitHubDeploymentsReader({ request, ttl: 4000, now: () => time });
  const first = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.deepEqual(Object.keys(first), ['repository', 'sha', 'deployments']);
  assert.equal(first.sha, SHA);
  assert.equal(calls[0].endpoint, `repos/${REPO}/deployments?sha=${SHA}&per_page=50`);
  assert.deepEqual(first.deployments.map(record => [record.id, record.provider, record.state, record.url]), [['11', 'Vercel', 'in_progress', 'https://storefront-abc123-acme.vercel.app/'], ['12', 'Railway', 'success', 'https://storefront.up.railway.app/']]);
  time = 1000; await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(calls.length, 3, 'Concurrent polls within the cache window share one read.');
  time = 5000; active = false; await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.deepEqual(calls.slice(3).map(call => call.endpoint.replace(`repos/${REPO}/`, '')), [`deployments?sha=${SHA}&per_page=50`, 'deployments/11/statuses?per_page=1'], 'The settled record 12 is not re-read; the pending 11 gets its final status once.');
  time = 10000; const settled = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(calls.length, 6, 'Settled records reuse their final status.');
  assert.equal(settled.deployments[0].state, 'success');
});

test('statuses of many deployments are read a few at a time, and each is still read', async () => {
  let running = 0, most = 0;
  const reader = createGitHubDeploymentsReader({ request: async endpoint => {
    if (!endpoint.includes('/statuses')) return { status: 200, data: Array.from({ length: 20 }, (_, index) => deployment(index + 1)) };
    most = Math.max(most, ++running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    return { status: 200, data: [status('in_progress')] };
  } });
  const result = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.equal(result.deployments.filter(record => record.state === 'in_progress').length, 20);
  assert.ok(most > 1 && most <= 6, `${most} status reads at once`);
});

test('conditional requests reuse the cached body on 304', async () => {
  let version = 1;
  const { calls, request } = recorder([
    [/deployments\?/, (endpoint, etag) => etag === `W/"v${version}"` ? { status: 304 } : { status: 200, etag: `W/"v${version}"`, data: [deployment(11, { environment: `Production v${version}` })] }],
    [/statuses/, () => ({ status: 200, etag: 'W/"status"', data: [] })],
  ]);
  let time = 0;
  const reader = createGitHubDeploymentsReader({ request, ttl: 0, now: () => time++ });
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).deployments[0].environment, 'Production v1');
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).deployments[0].environment, 'Production v1');
  assert.equal(calls.filter(call => call.endpoint.includes('?sha=')).at(-1)!.etag, 'W/"v1"');
  version = 2;
  assert.equal((await reader.read({ repository: REPO, sha: SHA, login: LOGIN })).deployments[0].environment, 'Production v2');
});

test('missing commits and invalid repositories never reach GitHub', async () => {
  const { calls, request } = recorder([]);
  const reader = createGitHubDeploymentsReader({ request });
  assert.deepEqual(await reader.read({ repository: REPO, sha: null, login: LOGIN }), { repository: REPO, sha: null, deployments: [] });
  assert.deepEqual(await reader.read({ repository: REPO, sha: 'main', login: LOGIN }), { repository: REPO, sha: null, deployments: [] });
  await assert.rejects(reader.read({ repository: 'owner/repo/../../user', sha: SHA, login: LOGIN }), /GitHub repository/);
  await assert.rejects(reader.read({ repository: REPO, sha: SHA, login: '' }), /GitHub account/);
  assert.equal(calls.length, 0);
});

test('a failed read is not cached and a failed status read leaves that record without a state', async () => {
  let fail = true;
  const { request } = recorder([
    [/deployments\?/, () => { if (fail) throw new Error('GitHub has temporarily limited requests.'); return { status: 200, etag: null, data: [deployment(11)] }; }],
    [/statuses/, () => { throw new Error('Reading GitHub failed.'); }],
  ]);
  const reader = createGitHubDeploymentsReader({ request, ttl: 60000 });
  await assert.rejects(reader.read({ repository: REPO, sha: SHA, login: LOGIN }), /limited/);
  fail = false;
  const result = await reader.read({ repository: REPO, sha: SHA, login: LOGIN });
  assert.deepEqual(result.deployments.map(record => [record.id, record.state, record.url]), [['11', null, null]]);
});
