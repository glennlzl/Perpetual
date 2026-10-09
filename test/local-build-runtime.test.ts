import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime, type Exec } from '../src/twin/runtime.ts';
import type { TwinService } from '../src/twin/registry.ts';

const checksum = createHash('sha256').update('acme/app build archive').digest('hex');
const sourceRevision = 'a'.repeat(40), sourceHash = 'b'.repeat(64);
const image = { Id: `sha256:${'c'.repeat(64)}`, Os: 'linux', Architecture: 'arm64' };
const appConfig = (origin = 'https://app.example.test') => ({
  install: { directory: '.', command: 'npm ci' },
  apps: { web: { directory: '.', build: 'npm run build', start: 'npm start', port: 3000, env: { PUBLIC_ORIGIN: origin } } },
});

async function fixture(t: test.TestContext, { failBuilds = 0, corruptRestore = false, failReset = false, deleteLockAfterRestore = false, services = {} as Record<string, TwinService> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-local-build-runtime-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const source = join(dataDir, 'source');
  await mkdir(source);
  await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(source, 'app.js'), 'export const value = 1;\n');
  const calls: string[][] = [], volumes = new Map<string, Record<string, string>>();
  let failedBuilds = failBuilds;
  let failedReset = failReset;
  let removeLockAfterRestore = deleteLockAfterRestore;
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${JSON.stringify(image)}\n`, stderr: '' };
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1)!, labels: Record<string, string> = {};
      for (let index = 2; index < args.length - 1; index += 2) {
        const [label, ...value] = args[index + 1]!.split('='); labels[label!] = value.join('=');
      }
      volumes.set(name, labels); return { stdout: `${name}\n`, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const labels = volumes.get(args.at(-1)!);
      if (!labels) throw Object.assign(new Error('No such volume'), { code: 1 });
      return { stdout: `${JSON.stringify(labels)}\n`, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]!); return { stdout: '', stderr: '' }; }
    if (args[0] === 'run' && args.includes('--network') && args.includes('none')) {
      const command = args.at(-1) ?? '';
      if (command.includes('find /workspace -mindepth 1') && failedReset) throw Object.assign(new Error('workspace reset failed'), { code: 1 });
      if (command.includes('sha256sum -c')) {
        if (corruptRestore) throw Object.assign(new Error('archive checksum mismatch'), { code: 1, stdout: '', stderr: '' });
        if (removeLockAfterRestore) { removeLockAfterRestore = false; await rm(join(source, 'package-lock.json'), { force: true }); }
        return { stdout: '', stderr: '' };
      }
      if (command.includes('sha256sum /cache/archive.tar')) return { stdout: `${checksum}  /cache/archive.tar\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'ps') return { stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('--profile') && args.includes('build-web') && args.includes('run') && failedBuilds > 0) {
      failedBuilds--;
      throw Object.assign(new Error('Build failed'), { code: 1, stdout: 'build failed\n', stderr: '' });
    }
    return { stdout: '', stderr: '' };
  };
  const runtime = createTwinRuntime({ exec, services, owner: 'owner-neutral', isFree: async () => true });
  const prepare = (id: string, config = appConfig(), sourceInfo = { revision: sourceRevision, hash: sourceHash }, onStep?: (step: string) => unknown) => runtime.prepare({
    dataDir, id, source, config, repository: 'acme/app', buildSource: sourceInfo, ...(onStep ? { onStep } : {}),
  });
  return { dataDir, source, calls, volumes, prepare,
    setCorruptRestore: (value: boolean) => { corruptRestore = value; },
    setFailReset: (value: boolean) => { failedReset = value; },
    setRemoveLockAfterRestore: (value: boolean) => { removeLockAfterRestore = value; } };
}

const commands = (calls: string[][]) => ({
  installs: calls.filter(args => args[0] === 'compose' && args.includes('--profile') && args.includes('install') && args.includes('run')),
  builds: calls.filter(args => args[0] === 'compose' && args.includes('--profile') && args.includes('build-web') && args.includes('run')),
  appStarts: calls.filter(args => args[0] === 'compose' && args.at(-2) === 'up' && args.at(-1) === '--wait'),
  sourceCopies: calls.filter(args => args[0] === 'compose' && args.includes('--profile') && args.includes('source') && args.includes('run')),
  resets: calls.filter(args => args[0] === 'run' && args.some(arg => arg.includes('find /workspace -mindepth 1'))),
});

test('An exact build archive skips install and build on a fresh twin while the app starts for each twin', async t => {
  const f = await fixture(t);
  await f.prepare('beta');
  const progress: { step: string; callIndex: number }[] = [];
  await f.prepare('gamma', appConfig(), undefined, step => { progress.push({ step, callIndex: f.calls.length }); });
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 1);
  assert.equal(observed.builds.length, 1);
  assert.equal(observed.appStarts.length, 2);
  assert.ok(f.volumes.size >= 2, 'Successful install and build archives persist outside either twin.');
  const reuse = progress.find(item => item.step === 'Preparing source and services');
  const extraction = f.calls.findIndex(args => args[0] === 'run' && args.at(-1)?.includes('sha256sum -c'));
  assert.ok(reuse && extraction >= reuse.callIndex, 'Source and dependency preparation starts before archive extraction.');
});

test('A failed reuse progress update stops before extraction and preserves the cache', async t => {
  const f = await fixture(t);
  await f.prepare('beta');
  await assert.rejects(f.prepare('gamma', appConfig(), undefined, step => {
    if (step === 'Reusing local build') throw new Error('progress write failed');
  }), /Could not save local build cache progress/);
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 1);
  assert.equal(observed.builds.length, 1, 'The failed update does not fall back to rebuilding.');
  assert.ok(f.volumes.size >= 2, 'The verified cache remains available.');
});

test('Changing app environment reuses locked dependencies but rebuilds output', async t => {
  const f = await fixture(t);
  await f.prepare('beta', appConfig('https://first.example.test'));
  await f.prepare('gamma', appConfig('https://second.example.test'));
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 1);
  assert.equal(observed.builds.length, 2);
  assert.equal(observed.appStarts.length, 2);
});

test('Changing the copied source invalidates both dependency and build archives', async t => {
  const f = await fixture(t);
  await f.prepare('beta');
  await writeFile(join(f.source, 'app.js'), 'export const value = 2;\n');
  await f.prepare('gamma', appConfig(), { revision: 'd'.repeat(40), hash: 'e'.repeat(64) });
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 2);
  assert.equal(observed.builds.length, 2);
});

test('A configured service keeps install reuse but forces a fresh build for every twin', async t => {
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}) } satisfies TwinService;
  const f = await fixture(t, { services: { probe } });
  const config = { ...appConfig(), services: { probe: {} } };
  await f.prepare('beta', config);
  await f.prepare('gamma', config);
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 1);
  assert.equal(observed.builds.length, 2);
});

test('A failed app build never publishes a reusable build archive', async t => {
  const f = await fixture(t, { failBuilds: 1 });
  await assert.rejects(f.prepare('beta'), /Build "npm run build" of app web failed/);
  await f.prepare('gamma');
  const observed = commands(f.calls);
  assert.equal(observed.installs.length, 1, 'The successful install remains reusable.');
  assert.equal(observed.builds.length, 2, 'The failed build is attempted again.');
  assert.equal([...f.volumes.keys()].filter(name => /-build-[a-f0-9]{32}$/.test(name)).length, 1,
    'Only the later successful build is retained.');
});

test('A corrupt archive resets the workspace and reloads source before rebuilding', async t => {
  const f = await fixture(t);
  await f.prepare('beta');
  f.setCorruptRestore(true);
  await f.prepare('gamma');
  const observed = commands(f.calls);
  assert.ok(observed.resets.length >= 1);
  assert.ok(observed.sourceCopies.length >= 3, 'The failed restore is followed by a clean source copy.');
  assert.equal(observed.builds.length, 2, 'A corrupt archive falls back to the real build.');
});

test('A failed install-archive recovery stops instead of building from an empty workspace', async t => {
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}) } satisfies TwinService;
  const f = await fixture(t, { services: { probe } });
  const config = { ...appConfig(), services: { probe: {} } };
  await f.prepare('beta', config);
  f.setCorruptRestore(true);
  f.setFailReset(true);
  await assert.rejects(f.prepare('gamma', config), /workspace reset failed/);
  assert.equal(commands(f.calls).installs.length, 1, 'A failed reset never proceeds to a build without installed dependencies.');
});

test('An early install hit without a final identity cannot start builds or apps', async t => {
  const probe = { id: 'probe', title: 'Probe', fidelity: 'actual', env: () => ({}) } satisfies TwinService;
  const f = await fixture(t, { services: { probe } });
  const config = { ...appConfig(), services: { probe: {} } };
  await f.prepare('beta', config);
  f.setRemoveLockAfterRestore(true);
  await assert.rejects(f.prepare('gamma', config), /could not be matched to the final build configuration/);
  const observed = commands(f.calls);
  assert.equal(observed.builds.length, 1, 'No build starts under an unverified install identity.');
  assert.equal(observed.appStarts.length, 1, 'No app starts under an unverified install identity.');
});
