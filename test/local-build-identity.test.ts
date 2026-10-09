import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TwinConfig } from '../src/twin/config.ts';
import { localBuildKeys as deriveLocalBuildKeys } from '../src/twin/local-build-identity.ts';

const source = { revision: 'a'.repeat(40), hash: 'b'.repeat(64) };
const image = { id: `sha256:${'c'.repeat(64)}`, os: 'linux', architecture: 'arm64', variant: 'v8' };
const config = (): TwinConfig => ({
  services: {}, install: { directory: '.', command: 'pnpm install --frozen-lockfile' },
  apps: { web: { directory: '.', build: 'pnpm build', start: 'pnpm start', port: 3000, env: { MODE: 'test' } } },
  fixtures: [], node: 24,
});
const localBuildKeys = (input: Omit<Parameters<typeof deriveLocalBuildKeys>[0], 'buildCommands'> & { buildCommands?: (string | string[] | undefined)[] }) =>
  deriveLocalBuildKeys({ ...input, buildCommands: input.buildCommands ?? ['node app.js'] });

test('local build keys are stable and bind source, install, image, app order and resolved environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-build-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
  const base = { source, config: config(), image, env: { API_TOKEN: 'secret-a', PORT: '3000' }, sourceDirectory: root };
  const keys = await localBuildKeys(base);
  assert.match(keys.install!, /^[a-f0-9]{64}$/);
  assert.match(keys.build!, /^[a-f0-9]{64}$/);
  assert.deepEqual(await localBuildKeys(base), keys);
  assert.notEqual((await localBuildKeys({ ...base, source: { ...source, revision: 'd'.repeat(40) } })).install, keys.install);
  assert.notEqual((await localBuildKeys({ ...base, source: { ...source, hash: 'e'.repeat(64) } })).install, keys.install);
  assert.notEqual((await localBuildKeys({ ...base, config: { ...config(), install: { directory: '.', command: 'pnpm install' } } })).install, keys.install);
  assert.notEqual((await localBuildKeys({ ...base, image: { ...image, architecture: 'amd64' } })).install, keys.install);
  assert.notEqual((await localBuildKeys({ ...base, env: { API_TOKEN: 'secret-b', PORT: '3000' } })).build, keys.build);
  const changedBuild = await localBuildKeys({ ...base, buildCommands: ['node app.js --production'] });
  assert.equal(changedBuild.install, keys.install);
  assert.notEqual(changedBuild.build, keys.build);
  const reordered = { ...config(), apps: { api: { directory: '.', start: 'node api.js', port: 3001, env: {} }, ...config().apps } };
  const reorderedAgain = { ...config(), apps: { ...config().apps, api: { directory: '.', start: 'node api.js', port: 3001, env: {} } } };
  assert.notEqual((await localBuildKeys({ ...base, config: reordered })).build, (await localBuildKeys({ ...base, config: reorderedAgain })).build);
});

test('unversioned sources and missing lockfiles cannot produce reusable keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-build-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { source, config: config(), image, env: {}, sourceDirectory: root };
  assert.deepEqual(await localBuildKeys({ ...base, source: { ...source, revision: 'main' } }), {});
  assert.deepEqual(await localBuildKeys({ ...base, source: { ...source, hash: 'no-hash' } }), {});
  assert.deepEqual(await localBuildKeys(base), {});
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'package-lock.json'), '{}');
  assert.deepEqual(await localBuildKeys({ ...base, config: { ...config(), install: { directory: '.', command: 'npm install' } } }), {});
});

test('install reuse requires an exact frozen command and its matching lockfile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-build-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['npm ci', 'package-lock.json'],
    ['npm ci', 'npm-shrinkwrap.json'],
    ['pnpm install --frozen-lockfile', 'pnpm-lock.yaml'],
    ['bun install --frozen-lockfile', 'bun.lock'],
    ['bun install --frozen-lockfile', 'bun.lockb'],
  ] as const;
  for (let index = 0; index < cases.length; index++) {
    const [command, lockfile] = cases[index]!;
    const directory = join(root, String(index));
    await mkdir(directory);
    await writeFile(join(directory, lockfile), 'lock');
    const eligible = await localBuildKeys({ source, config: { ...config(), install: { directory: '.', command } }, image,
      env: {}, sourceDirectory: directory });
    assert.ok(eligible.install, `${command} with ${lockfile}`);
  }

  const wrongManager = join(root, 'wrong-manager');
  await mkdir(wrongManager);
  await writeFile(join(wrongManager, 'package-lock.json'), 'lock');
  assert.deepEqual(await localBuildKeys({ source, config: { ...config(), install: { directory: '.', command: 'pnpm install --frozen-lockfile' } },
    image, env: {}, sourceDirectory: wrongManager }), {});

  const mutable = join(root, 'mutable');
  await mkdir(mutable);
  await writeFile(join(mutable, 'package-lock.json'), 'lock');
  for (const command of ['npm install', 'npm ci && echo done', 'npm ci --ignore-scripts']) {
    assert.deepEqual(await localBuildKeys({ source, config: { ...config(), install: { directory: '.', command } }, image,
      env: {}, sourceDirectory: mutable }), {}, command);
  }
  const yarn = join(root, 'yarn');
  await mkdir(yarn);
  await writeFile(join(yarn, 'yarn.lock'), 'lock');
  for (const command of ['yarn install --immutable', 'yarn install --frozen-lockfile']) {
    assert.deepEqual(await localBuildKeys({ source, config: { ...config(), install: { directory: '.', command } }, image,
      env: {}, sourceDirectory: yarn }), {}, `Yarn cache disabled: ${command}`);
  }
});

test('build reuse is disabled when configured services or fixtures mutate sandbox state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-build-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bun.lock'), 'lock');
  const base = { source, config: { ...config(), install: { directory: '.', command: 'bun install --frozen-lockfile' } }, image, env: {}, sourceDirectory: root };
  assert.ok((await localBuildKeys({ ...base, config: { ...base.config, services: { database: {} } } })).install);
  assert.equal((await localBuildKeys({ ...base, config: { ...base.config, services: { database: {} } } })).build, undefined);
  assert.equal((await localBuildKeys({ ...base, config: { ...base.config, fixtures: [{ service: 'db', query: 'select 1' }] } })).build, undefined);
});
