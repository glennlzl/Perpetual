import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { gitReadOnly } from '../src/process.ts';

type Locked = { dev?: boolean; optional?: boolean; devOptional?: boolean; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

/** Where Node.js finds `name` from the package at `path`: its own node_modules, each enclosing one, then the root's. */
function lookups(path: string, name: string) {
  const paths: string[] = [];
  for (let base = path; ; ) {
    paths.push(`${base}/node_modules/${name}`);
    const cut = base.lastIndexOf('/node_modules/');
    if (cut < 0) break;
    base = base.slice(0, cut);
  }
  return [...paths, `node_modules/${name}`];
}

type Manifest = { engines: { node: string }; dependencies: Record<string, string>; devDependencies: Record<string, string> };
const manifest = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;
const major = (range: string) => Number(/\d+/.exec(range)?.[0]);
const minor = (range: string) => /\d+\.\d+/.exec(range)?.[0];

test('Node types match the oldest Node the controller supports, so typecheck refuses a newer API it lacks', async () => {
  const { engines, devDependencies } = await manifest();
  // A matching major alone let 24.19 types pass code that the supported 24.12 lacks at run time.
  assert.equal(minor(devDependencies['@types/node']), minor(engines.node));
  assert.match(devDependencies['@types/node'], /^\d+\.\d+\.\d+$/, 'Pinned exactly.');
});

test('the client merges class names with one engine: cn, which the utils alias re-exports for registry components', async () => {
  const { dependencies, devDependencies } = await manifest();
  // The client's packages are devDependencies, since Vite bundles them.
  assert.deepEqual(['clsx', 'tailwind-merge'].filter(name => Object.hasOwn(dependencies, name) || Object.hasOwn(devDependencies, name)), []);
  assert.match(await readFile(new URL('../client/src/lib/utils.ts', import.meta.url), 'utf8'), /^export \{ cn \} from 'cn';$/m);
});

test('one Chromium serves both Playwright packages: the Node and Python browser runtime pins agree', async () => {
  const { dependencies } = await manifest();
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [lock, pyproject, uvLock, runner] = await Promise.all([read('package-lock.json'), read('integrations/browser-use/pyproject.toml'),
    read('integrations/browser-use/uv.lock'), read('integrations/browser-use/runner.py')]);
  const { packages } = JSON.parse(lock) as { packages: Record<string, { version?: string }> };
  const pinned = (name: string) => new RegExp(`"${name}==([^"]+)"`).exec(pyproject)?.[1];
  const locked = (name: string) => new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(uvLock)?.[1];
  const checked = JSON.parse(/^VERSIONS = (\{.*\})$/m.exec(runner)?.[1] ?? '{}') as Record<string, string>;
  const playwright = dependencies['@playwright/test'];
  assert.match(playwright, /^\d+\.\d+\.\d+$/, 'Pinned exactly.');
  // Setup installs Chromium with node_modules/playwright only; the Python worker finds it only at the same version.
  assert.deepEqual([packages['node_modules/playwright']?.version, pinned('playwright'), locked('playwright'), checked.playwright], Array(4).fill(playwright));
  assert.deepEqual([locked('browser-use'), checked['browser-use']], Array(2).fill(pinned('browser-use')));
});

test('the shadcn CLI, which only adds components, runs through npx at a pinned version instead of installing with every setup', async () => {
  const { dependencies, devDependencies } = await manifest();
  assert.ok(!Object.hasOwn(dependencies, 'shadcn') && !Object.hasOwn(devDependencies, 'shadcn'), 'Nothing imports it, and its tree was most of the install.');
  assert.match(await readFile(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8'), /`npx shadcn@\d+\.\d+\.\d+ add <component>`/);
});

test('zod, which only the model packages\' peers need, is on the newest major every one of them accepts', async () => {
  const { dependencies } = await manifest();
  const { packages } = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, Locked> };
  const ranges = Object.values(packages).flatMap(locked => locked.peerDependencies?.zod ?? []);
  assert.ok(ranges.length && ranges.every(range => /\^4|>=\s*4|\|\|\s*4/.test(range)), ranges.join('; '));
  assert.equal(major(dependencies.zod), 4);
  assert.match(dependencies.zod, /^\d+\.\d+\.\d+$/, 'Pinned exactly.');
});

test('a production install has every package production code loads: each production package’s required peers are production packages', async () => {
  const { packages } = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, Locked> };
  const missing: string[] = [];
  for (const [path, locked] of Object.entries(packages)) {
    if (!path || locked.dev || locked.optional || locked.devOptional) continue;
    for (const peer of Object.keys(locked.peerDependencies ?? {})) {
      if (locked.peerDependenciesMeta?.[peer]?.optional) continue;
      const found = lookups(path, peer).find(candidate => packages[candidate]);
      // npm ci --omit=dev leaves out a package the lockfile marks dev, so a peer marked so is missing in production.
      if (!found || packages[found].dev) missing.push(`${path.replace(/^.*node_modules\//, '')} needs ${peer}`);
    }
  }
  assert.deepEqual(missing, []);
});

type Update = { 'package-ecosystem': string; directory?: string; directories?: string[]; schedule: { interval: string }; ignore?: { 'dependency-name': string; 'update-types'?: string[] }[] };
// The bench corpus's repositories are fixtures: their pins are the cases a repair agent is scored on.
const FIXTURES = 'bench/repair/corpus/';

/**
 * The directories where the repository at `root` tracks `file`, named as Dependabot names them (`/`, `/bench/repair`),
 * the fixtures aside. Dependabot reads only what is committed, so no untracked file counts: neither installed packages
 * nor the copies of the corpus that a bench run leaves in its ignored results.
 */
async function holding(file: string, root = fileURLToPath(new URL('..', import.meta.url))): Promise<string[]> {
  const { stdout } = await gitReadOnly(root, ['ls-files', '-z', '--', `:(glob)**/${file}`]);
  return stdout.split('\0').filter(path => path && !path.startsWith(FIXTURES)).map(path => posix.dirname(`/${path}`));
}

test('a lockfile counts only where git tracks it, so the corpus copies a bench run leaves in its results never do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-lockfiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracked = ['package-lock.json', 'apps/web/package-lock.json', `${FIXTURES}acme-case/repo/package-lock.json`];
  // A bench run copies each case's repository, lockfile included, under bench/repair/results, which git ignores.
  const untracked = ['bench/repair/results/2026-01-01T00-00-00Z/cases/acme-case/snapshot/package-lock.json', 'node_modules/acme/package-lock.json'];
  for (const path of [...tracked, ...untracked]) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), '{}\n');
  }
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', root, '-c', 'init.defaultBranch=main', ...args]);
  await git('init', '--quiet');
  await git('add', '--force', '--', ...tracked);
  assert.deepEqual((await holding('package-lock.json', root)).sort(), ['/', '/apps/web']);
});

test('Dependabot proposes weekly updates for the workflows\' actions and every npm and uv lockfile, the bench corpus\'s fixtures aside', async () => {
  const { version, updates } = YAML.parse(await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')) as { version: number; updates: Update[] };
  assert.equal(version, 2);
  assert.deepEqual(updates.filter(update => update.schedule.interval !== 'weekly'), []);
  const covered = (ecosystem: string) => updates.filter(update => update['package-ecosystem'] === ecosystem).flatMap(update => update.directories ?? [update.directory]).sort();
  assert.deepEqual(covered('github-actions'), ['/']);
  assert.deepEqual(covered('npm'), (await holding('package-lock.json')).sort());
  assert.deepEqual(covered('uv'), (await holding('uv.lock')).sort());
  // The root's Node types stay on the minor of the oldest Node the controller supports, which the Node types test above
  // checks, so their minor and major updates could never pass.
  const root = updates.find(update => update['package-ecosystem'] === 'npm' && update.directory === '/');
  assert.deepEqual(root?.ignore, [{ 'dependency-name': '@types/node', 'update-types': ['version-update:semver-major', 'version-update:semver-minor'] }]);
});

test('every workflow pins its actions by commit with the release on the same line, where Dependabot updates both', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url), uses: string[] = [];
  for (const file of (await readdir(directory)).filter(name => /\.ya?ml$/.test(name))) {
    for (const [, reference] of (await readFile(new URL(file, directory), 'utf8')).matchAll(/^[ \t-]*uses:[ \t]*(.*)$/gm)) uses.push(`${file}: ${reference}`);
  }
  assert.ok(uses.length > 0);
  // A release named on a line of its own would still name the old one once Dependabot moves the commit.
  assert.deepEqual(uses.filter(use => !/: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(use)), []);
});
