import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentUsage } from '../src/environments/usage.ts';
import { createGateManager } from '../src/gate/manager.ts';
import { createGateSteps, createReadiness } from '../src/gate/steps.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('a health check that takes the previous twin during gate admission delays rebuilding without requiring release', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-gate-health-'));
  const usage = createEnvironmentUsage(), readiness = createReadiness(), entered = deferred(), health = deferred();
  const context = { key: 'acme/app', stageId: 'beta', scan: { repo: { path: '/acme/app', branch: 'main', sha: 'a'.repeat(40) }, services: [] } };
  let runs = 0, nextPort = 45000;
  const environments = await createEnvironmentManager({ dataDir, usage, onReady: async (_context, environment) => readiness.done(environment.id), runtime: {
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); return { status: 'ready', apps: [{ id: 'web', url: `http://127.0.0.1:${nextPort++}/` }], services: [] }; },
    environmentHealth: async () => { entered.resolve(); await health.promise; return { status: 'ready' }; },
    environmentLogs: async () => '', destroySandbox: async () => {},
  } });
  await environments.savePlan(context, { services: {}, apps: { web: { start: 'node app.mjs', port: 3000 } } });
  const { environment: old } = await environments.create(context); await environments.awaitIdle(old.id);
  const browser = {
    isActive: () => false, summary: () => ({ cases: [{ selected: true, needsReview: false }] }),
    view: async () => ({ config: { targetUrl: environments.summaries(context.key).find(item => item.status === 'ready')?.apps[0]?.url } }),
    // The browser admits the run against the environment the configured URL resolves to.
    run: async () => { runs++; return { run: { id: 'journey-run', environmentId: environments.summaries(context.key).find(item => item.status === 'ready')?.id } }; },
    runProgress: async () => ({ run: { id: 'journey-run', status: 'passed', results: [{ status: 'passed' }] } }),
  };
  let ticking: Promise<void> | undefined, checkedOut = false;
  const steps = createGateSteps({ environments, browser, readiness, interval: 1, checkout: async () => {
    // Start after prepare's initial admission checks: checking only the initial lease is insufficient.
    if (!checkedOut) { checkedOut = true; ticking = environments.tick(); await entered.promise; }
    return context;
  } });
  const gates = await createGateManager({ dataDir, source: () => ({ key: context.key, branch: 'main', sha: context.scan.repo.sha, stages: [{ id: 'beta', name: 'Beta', kind: 'sandbox' }] }),
    github: { connection: async () => null, head: async () => ({ status: 304 }), post: async () => {} }, steps, retryInterval: 5 });
  t.after(async () => { health.resolve(); await ticking; await gates.close(); await environments.close(); await rm(dataDir, { recursive: true, force: true }); });
  await gates.run({ stageId: 'beta' }); await gates.idle();
  assert.equal(gates.view().stages.beta.status, 'queued', 'A health probe gives no business verdict and needs no manual release.');
  assert.equal(runs, 0);
  assert.equal(environments.summaries(context.key).find(item => item.id === old.id)?.status, 'ready');
  health.resolve(); await ticking;
  for (let attempt = 0; attempt < 100 && gates.view().stages.beta.status !== 'passed'; attempt++) await delay(5);
  assert.equal(gates.view().stages.beta.status, 'passed');
  assert.equal(runs, 1, 'The journey executes once, after the probe releases the old twin.');
  assert.equal(environments.summaries(context.key).find(item => item.id === old.id)?.status, 'destroyed');
});
