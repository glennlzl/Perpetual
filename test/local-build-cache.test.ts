import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalBuildCache } from '../src/twin/local-build-cache.ts';

const key = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-local-build-cache-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const volumes = new Map<string, Record<string, string>>(), dockerCalls: string[][] = [], helperCalls: { image: string; args: string[]; mounts: string[] }[] = [];
  let exportFails = false, restoreFails = false;
  const docker = async (args: string[]) => {
    dockerCalls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1)!; const labels: Record<string, string> = {};
      for (let i = 2; i < args.length - 1; i += 2) labels[args[i + 1]!.split('=')[0]] = args[i + 1]!.split('=').slice(1).join('=');
      volumes.set(name, labels); return { stdout: `${name}\n` };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const labels = volumes.get(args.at(-1)!);
      if (!labels) throw Object.assign(new Error('no such volume'), { code: 1 });
      return { stdout: `${JSON.stringify(labels)}\n` };
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]!); return { stdout: '' }; }
    throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
  };
  const helper = async (image: string, args: string[], mounts: string[]) => {
    helperCalls.push({ image, args, mounts });
    if (args[2]?.includes('sha256sum -c')) {
      if (restoreFails) throw new Error('checksum failed');
      return { stdout: '' };
    }
    if (exportFails) throw new Error('export failed');
    return { stdout: `${key('archive')}  /cache/archive.tar\n` };
  };
  const cache = createLocalBuildCache({ dataDir, owner: 'neutral-owner', repository: 'acme/app', docker, helper });
  return { dataDir, cache, volumes, docker, helper, dockerCalls, helperCalls, setExportFails: (value: boolean) => { exportFails = value; }, setRestoreFails: (value: boolean) => { restoreFails = value; } };
}

test('Local build archives miss before save and restore only for the exact key and phase', async t => {
  const f = await fixture(t), cacheKey = key('source-config-runtime');
  let restoreSteps = 0;
  assert.equal(await f.cache.restore(cacheKey, 'build', 'perpetual-beta_workspace', 'sha256:image'), 'miss');
  await f.cache.save(cacheKey, 'build', 'perpetual-beta_workspace', 'sha256:image');
  const save = f.helperCalls.at(-1)!;
  assert.match(save.mounts[0]!, /dst=\/workspace,readonly$/);
  assert.doesNotMatch(save.mounts[1]!, /readonly/);
  assert.equal(await f.cache.restore(cacheKey, 'build', 'perpetual-gamma_workspace', 'sha256:image', () => {
    restoreSteps++;
    assert.equal(f.helperCalls.length, 1, 'Progress is published before archive extraction starts.');
  }), 'hit');
  assert.equal(restoreSteps, 1);
  assert.equal(await f.cache.restore(key('different-inputs'), 'build', 'perpetual-gamma_workspace', 'sha256:image', () => { restoreSteps++; }), 'miss');
  assert.equal(await f.cache.restore(cacheKey, 'install', 'perpetual-gamma_workspace', 'sha256:image'), 'miss');
  assert.equal(restoreSteps, 1, 'A miss never reports a cache hit.');
  const restore = f.helperCalls.at(-1)!;
  assert.doesNotMatch(restore.mounts[0]!, /readonly/);
  assert.match(restore.mounts[1]!, /dst=\/cache,readonly$/);
  assert.match(restore.args[2]!, /sha256sum -c - && find \/workspace .*tar -C \/workspace -xf/);
});

test('A failed restore progress publication leaves a verified archive intact', async t => {
  const f = await fixture(t), cacheKey = key('inputs');
  await f.cache.save(cacheKey, 'install', 'perpetual-beta_workspace', 'sha256:image');
  const volume = [...f.volumes.keys()][0]!;
  const helperCount = f.helperCalls.length;
  await assert.rejects(f.cache.restore(cacheKey, 'install', 'perpetual-gamma_workspace', 'sha256:image', () => {
    throw new Error('state write failed');
  }), /state write failed/);
  assert.equal(f.helperCalls.length, helperCount, 'Extraction does not start after progress publication fails.');
  assert.equal(f.volumes.has(volume), true);
});

test('A failed export does not publish metadata and removes its fresh cache volume', async t => {
  const f = await fixture(t); f.setExportFails(true);
  await assert.rejects(f.cache.save(key('inputs'), 'install', 'perpetual-beta_workspace', 'sha256:image'), /export failed/);
  assert.equal(await f.cache.restore(key('inputs'), 'install', 'perpetual-beta_workspace', 'sha256:image'), 'miss');
  assert.equal(f.volumes.size, 0);
});

test('Cancellation after volume creation or during export still cleans up without the cancelled command signal', async t => {
  for (const duringCreate of [true, false]) {
    const f = await fixture(t), controller = new AbortController();
    const cache = createLocalBuildCache({ dataDir: f.dataDir, owner: 'neutral-owner', repository: 'acme/app',
      docker: async args => {
        controller.signal.throwIfAborted();
        const result = await f.docker(args);
        if (duringCreate && args[1] === 'create') { controller.abort(); controller.signal.throwIfAborted(); }
        return result;
      },
      cleanupDocker: f.docker,
      helper: async () => { controller.abort(); controller.signal.throwIfAborted(); return { stdout: '' }; },
    });
    await assert.rejects(cache.save(key('inputs'), 'install', 'perpetual-beta_workspace', 'sha256:image'), { name: 'AbortError' });
    assert.equal(f.volumes.size, 0);
    assert.equal(await f.cache.restore(key('inputs'), 'install', 'perpetual-beta_workspace', 'sha256:image'), 'miss');
  }
});

test('A corrupt archive is a miss and is invalidated before it can be extracted', async t => {
  const f = await fixture(t), cacheKey = key('inputs');
  await f.cache.save(cacheKey, 'build', 'perpetual-beta_workspace', 'sha256:image');
  f.setRestoreFails(true);
  assert.equal(await f.cache.restore(cacheKey, 'build', 'perpetual-gamma_workspace', 'sha256:image'), 'damaged');
  assert.equal(f.volumes.size, 0);
  const root = join(f.dataDir, 'local-build-cache'), scope = (await readdir(root))[0]!;
  await assert.rejects(readFile(join(root, scope, 'build.json'), 'utf8'), { code: 'ENOENT' });
});

test('A wrong-owner volume is never mounted or removed', async t => {
  const f = await fixture(t), cacheKey = key('inputs');
  await f.cache.save(cacheKey, 'install', 'perpetual-beta_workspace', 'sha256:image');
  const volume = [...f.volumes.keys()][0]!;
  f.volumes.get(volume)!['perpetual.owner'] = key('someone-else');
  assert.equal(await f.cache.restore(cacheKey, 'install', 'perpetual-gamma_workspace', 'sha256:image'), 'miss');
  assert.equal(f.volumes.has(volume), true);
  assert.equal(f.helperCalls.length, 1, 'Only the archive export ran; the untrusted volume was never mounted.');
});

test('Persisted cache metadata contains only hashes, phase state and an owned volume name', async t => {
  const f = await fixture(t);
  await f.cache.save(key('inputs'), 'build', 'perpetual-beta_workspace', 'sha256:image');
  const root = join(f.dataDir, 'local-build-cache');
  const scope = (await readdir(root))[0]!;
  const saved = JSON.parse(await readFile(join(root, scope, 'build.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved).sort(), ['key', 'phase', 'repository', 'schema', 'sha256', 'volume']);
  assert.equal(JSON.stringify(saved).includes('neutral-owner'), false);
  assert.equal(JSON.stringify(saved).includes('acme/app'), false);
});

test('Docker inspection failures are not mistaken for missing cache volumes', async t => {
  const f = await fixture(t), cacheKey = key('inputs');
  await f.cache.save(cacheKey, 'build', 'perpetual-beta_workspace', 'sha256:image');
  const failingInspect = createLocalBuildCache({ dataDir: f.dataDir, owner: 'neutral-owner', repository: 'acme/app',
    docker: async args => args[0] === 'volume' && args[1] === 'inspect' ? Promise.reject(new Error('Docker daemon unavailable')) : f.docker(args),
    helper: f.helper,
  });
  await assert.rejects(failingInspect.restore(cacheKey, 'build', 'perpetual-gamma_workspace', 'sha256:image'), /Docker daemon unavailable/);

  const failingCleanup = createLocalBuildCache({ dataDir: f.dataDir, owner: 'neutral-owner', repository: 'acme/app', docker: f.docker,
    cleanupDocker: async args => args[0] === 'volume' && args[1] === 'inspect' ? Promise.reject(new Error('cleanup inspect unavailable')) : f.docker(args),
    helper: async (_image, args) => args[2]?.includes('sha256sum -c') ? Promise.reject(new Error('archive checksum mismatch')) : f.helper(_image, args, []),
  });
  await assert.rejects(failingCleanup.restore(cacheKey, 'build', 'perpetual-gamma_workspace', 'sha256:image'), (error: Error & { cleanupIncomplete?: boolean }) => {
    assert.equal(error.cleanupIncomplete, true);
    assert.match(error.message, /cleanup inspect unavailable/);
    return true;
  });
});
