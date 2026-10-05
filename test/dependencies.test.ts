import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
