import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentUsage } from '../src/environments/usage.ts';
import { createHealthBeats, healthLabel, healthWarning, relativeAge } from '../client/src/lib/pipeline-health.ts';
import type { HealthBeat, ManagedRuntime } from '../src/environments/manager.ts';

type Health = () => ReturnType<ManagedRuntime['environmentHealth']>;
// A runtime with only the calls a test expects; any other call fails as it would without it.
const only = (calls: Partial<ManagedRuntime>) => calls as ManagedRuntime;

const context = { key: 'heartbeat-fixture', stageId: 'beta', scan: { repo: { path: '/fixture/app', sha: 'cb9292c' }, services: [] } };

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-heartbeat-'));
  const usage = createEnvironmentUsage();
  let time = Date.parse('2026-09-23T10:00:00.000Z'), health: Health = async () => ({ status: 'ready' });
  t.mock.method(Date, 'now', () => time);
  const runtime = only({
    prepareEnvironment: async ({ environment, onUpdate }) => { await onUpdate({ sandboxId: environment.id }); return { status: 'ready', step: 'Ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:50124' }] }; },
    environmentHealth: async () => health(),
    destroySandbox: async () => {},
  });
  const manager = await createEnvironmentManager({ dataDir, usage, runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.savePlan(context, { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const { environment } = await manager.create(context);
  await manager.awaitIdle(environment.id);
  return { manager, usage, environment, dataDir, advance: (ms: number) => { time += ms; }, setHealth: (operation: Health) => { health = operation; }, current: () => manager.summaries(context.key)[0] };
}

test('a ready environment exposes its last monitor check without persisting it', async t => {
  const f = await fixture(t);
  assert.equal(f.current().health, undefined, 'No check has run yet.');
  await f.manager.tick();
  assert.deepEqual(f.current().health, { checkedAt: '2026-09-23T10:00:00.000Z', ok: true, consecutiveFailures: 0 });
  assert.deepEqual((await f.manager.view(context)).environments[0].health, f.current().health);
  f.advance(10000); await f.manager.tick();
  assert.equal(f.current().health?.checkedAt, '2026-09-23T10:00:00.000Z', 'Checks keep their 30 second interval.');
  f.advance(20000); await f.manager.tick();
  assert.equal(f.current().health?.checkedAt, '2026-09-23T10:00:30.000Z');
  await f.manager.close();
  const saved = JSON.parse(await readFile(join(f.dataDir, 'environments/state.json'), 'utf8'));
  assert.equal(saved.environments[0].health, undefined);
});

test('failed checks report consecutive failures while the environment stays ready', async t => {
  const f = await fixture(t);
  f.setHealth(async () => ({ status: 'failed', error: 'Frontend is not responding' }));
  await f.manager.tick();
  assert.deepEqual(f.current().health, { checkedAt: '2026-09-23T10:00:00.000Z', ok: false, consecutiveFailures: 1 });
  assert.equal(f.current().status, 'ready');
  f.advance(30000); await f.manager.tick();
  assert.equal(f.current().health?.consecutiveFailures, 2);
  f.setHealth(async () => ({ status: 'ready' }));
  f.advance(30000); await f.manager.tick();
  assert.deepEqual(f.current().health, { checkedAt: '2026-09-23T10:01:00.000Z', ok: true, consecutiveFailures: 0 });
});

test('a due check skipped while the environment is in use records when it was skipped', async t => {
  const f = await fixture(t);
  await f.manager.tick();
  f.advance(30000);
  const release = f.usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: f.environment.id, operation: 'browser-run' });
  await f.manager.tick();
  assert.equal(f.current().health?.skippedInUseAt, '2026-09-23T10:00:30.000Z');
  f.advance(5000); await f.manager.tick();
  assert.equal(f.current().health?.skippedInUseAt, '2026-09-23T10:00:30.000Z', 'Repeated skips keep the first skipped time.');
  release();
  f.advance(1000); await f.manager.tick();
  assert.equal(f.current().health?.checkedAt, '2026-09-23T10:00:36.000Z', 'The check runs as soon as the environment is free.');
  assert.equal(healthLabel(f.current().health, Date.parse('2026-09-23T10:00:48.000Z')), 'Checked 12s ago');
});

test('a twin in use from the moment it is ready records its first skipped check', async t => {
  const f = await fixture(t);
  // Discovery or a gate's run takes the twin before the monitor's first check.
  const release = f.usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: f.environment.id, operation: 'browser-run' });
  await f.manager.tick();
  assert.deepEqual(f.current().health, { skippedInUseAt: '2026-09-23T10:00:00.000Z' });
  assert.equal(healthLabel(f.current().health, Date.parse('2026-09-23T10:00:05.000Z')), 'In use');
  f.advance(5000); await f.manager.tick();
  assert.equal(f.current().health?.skippedInUseAt, '2026-09-23T10:00:00.000Z', 'Repeated skips keep the first skipped time.');
  release();
  f.advance(1000); await f.manager.tick();
  assert.deepEqual(f.current().health, { checkedAt: '2026-09-23T10:00:06.000Z', ok: true, consecutiveFailures: 0, skippedInUseAt: '2026-09-23T10:00:00.000Z' });
  assert.equal(healthLabel(f.current().health, Date.parse('2026-09-23T10:00:10.000Z')), 'Checked 4s ago');
});

test('heartbeat labels use relative time and never describe a test result', () => {
  const now = Date.parse('2026-09-23T10:05:00.000Z');
  assert.equal(healthLabel({ checkedAt: '2026-09-23T10:04:48.000Z', ok: true, consecutiveFailures: 0 }, now), 'Checked 12s ago');
  assert.equal(healthLabel({ checkedAt: '2026-09-23T10:02:00.000Z', ok: false, consecutiveFailures: 1 }, now), 'Check failed 3m ago');
  assert.equal(healthLabel({ checkedAt: '2026-09-23T10:04:00.000Z', ok: true, consecutiveFailures: 0, skippedInUseAt: '2026-09-23T10:04:30.000Z' }, now), 'In use');
  assert.equal(healthLabel({ skippedInUseAt: '2026-09-23T10:04:30.000Z' }, now), 'In use');
  assert.equal(healthLabel({ checkedAt: '2026-09-23T10:05:02.000Z', ok: true }, now), 'Checked 0s ago');
  assert.equal(healthLabel(undefined, now), '');
  assert.deepEqual([0, 59999, 60000, 3599999, 7200000].map(relativeAge), ['0s', '59s', '1m', '59m', '2h']);
  assert.equal(healthWarning({ ok: true, consecutiveFailures: 0 }), false);
  assert.equal(healthWarning({ ok: true, consecutiveFailures: 1 }), true);
  assert.equal(healthWarning({ ok: false, consecutiveFailures: 0 }), true);
});

test('the Ready heartbeat beats once per new check, including the first check after readiness', () => {
  const beat = createHealthBeats();
  const ready = (health?: HealthBeat, id = 'env-beta') => ({ id, stageId: 'beta', status: 'ready', ...(health ? { health } : {}) });
  assert.equal(beat(ready()), '', 'No check yet: the heart stays still.');
  assert.equal(beat(ready({ checkedAt: '2026-09-23T10:00:30.000Z', ok: true, consecutiveFailures: 0 })), '2026-09-23T10:00:30.000Z', 'The first check after the environment was seen unchecked beats.');
  assert.equal(beat(ready({ checkedAt: '2026-09-23T10:00:30.000Z', ok: true, consecutiveFailures: 0 })), '2026-09-23T10:00:30.000Z', 'Re-reading the same check keeps the same beat key, so it never replays.');
  assert.equal(beat(ready({ checkedAt: '2026-09-23T10:01:00.000Z', ok: false, consecutiveFailures: 1 })), '2026-09-23T10:01:00.000Z');
  assert.equal(beat(ready({ skippedInUseAt: '2026-09-23T10:01:10.000Z' })), '', 'A skipped check is not a beat.');
  assert.equal(beat(ready({ checkedAt: '2026-09-23T09:59:00.000Z' }, 'env-seen-checked')), '', 'A check already present when first observed stays still.');
  assert.equal(beat(ready({ checkedAt: '2026-09-23T10:00:00.000Z' }, 'env-seen-checked')), '2026-09-23T10:00:00.000Z');
  assert.equal(beat(null), '');
  assert.equal(beat({ status: 'ready', health: { checkedAt: '2026-09-23T10:00:00.000Z' } }), '', 'An environment without an id never beats.');
});
