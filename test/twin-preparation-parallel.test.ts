import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTwinRuntime, type Exec } from '../src/twin/runtime.ts';
import type { ServiceContext, TwinService } from '../src/twin/registry.ts';

test('independent service setup overlaps source preparation while placeholder consumers wait for providers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-parallel-')), source = join(dataDir, 'source');
  await mkdir(source); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let sourceStarted!: () => void, releaseSource!: () => void;
  const sourceReady = new Promise<void>(resolve => { sourceStarted = resolve; });
  const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
  const active = new Set<string>(), events: string[] = [];
  const setup = (id: string, run: (ctx: ServiceContext) => Promise<void>) => ({
    id, title: id, fidelity: 'actual' as const, describe: { summary: 'Parallel setup fixture.', provides: [`TOKEN_${id.toUpperCase()}`], options: { value: 'text' } },
    setup: async (ctx: ServiceContext) => { active.add(id); events.push(`${id}:start`); await run(ctx); events.push(`${id}:end`); active.delete(id); return {}; },
    env: () => ({ [`TOKEN_${id.toUpperCase()}`]: id }),
  });
  const services = {
    first: setup('first', async () => { await sourceReady; await new Promise(resolve => setTimeout(resolve, 20)); }),
    second: setup('second', async () => { await sourceReady; releaseSource(); await new Promise(resolve => setTimeout(resolve, 20)); }),
    consumer: setup('consumer', async ctx => { assert.equal(ctx.options.value, 'first'); assert.ok(events.includes('first:end')); }),
  } satisfies Record<string, TwinService>;
  const exec: Exec = async (_file, args) => {
    if (args[0] === 'compose' && args.includes('--profile') && args.includes('source') && args.includes('run')) {
      sourceStarted(); await sourceGate; return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const runtime = createTwinRuntime({ exec, services, isFree: async () => true });
  const pending = runtime.prepare({ dataDir, source, id: 'beta', config: {
    services: { first: {}, second: {}, consumer: { value: '{{first.TOKEN_FIRST}}' } },
    apps: { web: { directory: '.', start: 'node app.js', port: 3000 } },
  } });
  await pending;
  assert.ok(events.indexOf('first:start') < events.indexOf('first:end'));
  assert.ok(events.indexOf('second:start') < events.indexOf('first:end'), 'Independent setup was active concurrently.');
  assert.ok(events.indexOf('consumer:start') > events.indexOf('first:end'), 'A placeholder consumer waited for its provider.');
});

test('a service failure cancels and joins sibling setup, retaining cleanup uncertainty', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-join-')), source = join(dataDir, 'source');
  await mkdir(source); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let siblingFinished = false;
  const first = { id: 'first', title: 'First', fidelity: 'actual' as const, describe: { summary: 'Fixture.', options: {}, provides: [] },
    setup: async () => { await delay(10); throw new Error('primary setup failure'); }, env: () => ({}) } satisfies TwinService;
  const sibling = { id: 'sibling', title: 'Sibling', fidelity: 'actual' as const, describe: { summary: 'Fixture.', options: {}, provides: [] },
    setup: async ctx => { await ctx.exec('sibling-command', []); return {}; }, env: () => ({}) } satisfies TwinService;
  const exec: Exec = async (file, args, options) => {
    if (file === 'sibling-command') return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { setTimeout(() => { siblingFinished = true; reject(Object.assign(new Error('sibling cleanup failed'), { cleanupIncomplete: true })); }, 25); }, { once: true });
    });
    if (args[0] === 'compose' && args.includes('--profile') && args.includes('source') && args.includes('run')) return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const runtime = createTwinRuntime({ exec, services: { first, sibling }, isFree: async () => true });
  const started = Date.now();
  await assert.rejects(runtime.prepare({ dataDir, source, id: 'beta', config: {
    services: { first: {}, sibling: {} }, apps: { web: { directory: '.', start: 'node app.js', port: 3000 } },
  } }), (error: Error & { cleanupIncomplete?: true }) => {
    assert.match(error.message, /primary setup failure/);
    assert.equal(error.cleanupIncomplete, true);
    return true;
  });
  assert.ok(siblingFinished, 'The failed preparation waited for sibling cleanup to settle.');
  assert.ok(Date.now() - started >= 25);
});

test('a service-only workspace provisions its repository cache before copying source', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-service-workspace-')), source = join(dataDir, 'source');
  await mkdir(source); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const worker = { id: 'worker', title: 'Worker', fidelity: 'actual' as const, describe: { summary: 'Fixture.', options: {}, provides: [] },
    env: () => ({}), containers: () => [{ name: 'worker', image: 'alpine', directory: '.' }] } satisfies TwinService;
  const runtime = createTwinRuntime({ services: { worker }, isFree: async () => true, exec: async (_file, args) => { calls.push(args); return { stdout: '', stderr: '' }; } });
  await runtime.prepare({ dataDir, source, repository: 'acme/app', id: 'beta', config: { services: { worker: {} } } });
  const cacheCreation = calls.findIndex(args => args[0] === 'volume' && args[1] === 'create');
  const sourceCopy = calls.findIndex(args => args[0] === 'compose' && args.includes('--profile') && args.includes('source') && args.includes('run'));
  assert.ok(cacheCreation >= 0 && sourceCopy > cacheCreation, 'The external cache volume exists before the workspace copy mounts it.');
});
