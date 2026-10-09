import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinRuntime, execCommand } from '../src/twin/runtime.ts';
import { repositoryCache } from '../src/twin/compose.ts';

const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to test real local build reuse.';

test('a new twin restores the exact local build, excludes runtime writes, and rebuilds for changed source or env', { skip, timeout: 300000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-build-test-')));
  const suffix = randomBytes(5).toString('hex'), source = join(dataDir, 'source');
  const repository = `local:acme/app:${suffix}`, repositoryHash = createHash('sha256').update(repository).digest('hex').slice(0, 16);
  const runtime = createTwinRuntime(), ids: string[] = [];
  const docker = (args: string[]) => execCommand('docker', args, { timeoutMs: 30000 });
  t.after(async () => {
    try {
      for (const id of ids) await runtime.destroy({ dataDir, id });
      const archives = (await docker(['volume', 'ls', '--quiet', '--filter', 'label=perpetual.local-build-cache=true', '--filter', `label=perpetual.repository=${repositoryHash}`])).stdout.trim().split('\n').filter(Boolean);
      await docker(['volume', 'rm', '--force', repositoryCache(repository), ...archives]);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'acme-app', version: '1.0.0', private: true }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ name: 'acme-app', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'acme-app', version: '1.0.0' } } }));
  await writeFile(join(source, 'build.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
writeFileSync('built.json', JSON.stringify({ version: readFileSync('version.txt', 'utf8'), color: process.env.COLOR, nonce: randomUUID() }));`);
  await writeFile(join(source, 'server.mjs'), `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
const result = { ...JSON.parse(readFileSync('built.json', 'utf8')), inheritedRuntimeData: existsSync('runtime-data') };
writeFileSync('runtime-data', 'private to this twin');
createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); }).listen(Number(process.env.PORT), '0.0.0.0');`);
  let index = 0;
  const prepare = async (version: string, color: string) => {
    await writeFile(join(source, 'version.txt'), version);
    const id = `build-test-${suffix}-${index++}`; ids.push(id);
    const steps: string[] = [], started = Date.now();
    const ready = await runtime.prepare({ dataDir, id, source, repository,
      buildSource: { revision: createHash('sha1').update(version).digest('hex'), hash: createHash('sha256').update(version).digest('hex') },
      config: { install: { command: 'npm ci' }, apps: { web: { build: 'node build.mjs', start: 'node server.mjs', port: 3000, env: { COLOR: color } } } },
      onStep: step => { steps.push(step); } });
    const response = await fetch(ready.apps[0].url);
    const body = await response.json() as { version: string; color: string; nonce: string; inheritedRuntimeData: boolean };
    t.diagnostic(`${version}/${color}: ${Date.now() - started} ms; ${steps.join(', ')}`);
    assert.equal(body.inheritedRuntimeData, false);
    await runtime.destroy({ dataDir, id }); ids.splice(ids.indexOf(id), 1);
    return { steps, body };
  };
  const first = await prepare('one', 'blue');
  assert.ok(first.steps.includes('Installing dependencies') && first.steps.includes('Building web'));
  const same = await prepare('one', 'blue');
  assert.deepEqual(same.body, first.body);
  assert.ok(same.steps.includes('Reusing local build'));
  assert.equal(same.steps.includes('Installing dependencies') || same.steps.includes('Building web'), false);
  const changedEnv = await prepare('one', 'green');
  assert.ok(changedEnv.steps.includes('Reusing local dependencies') && changedEnv.steps.includes('Building web'));
  assert.equal(changedEnv.body.color, 'green');
  assert.notEqual(changedEnv.body.nonce, first.body.nonce);
  const changedSource = await prepare('two', 'green');
  assert.ok(changedSource.steps.includes('Installing dependencies') && changedSource.steps.includes('Building web'));
  assert.equal(changedSource.body.version, 'two');
});
