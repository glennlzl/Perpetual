// A repair box double: a private host folder holding a copy of the source, where the box's commands run as they would
// in the container, with only PATH, HOME and LANG. It records every command and its output. No Docker runs.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { capture, captureBytes, DIFF_SCRIPT, type RepairBox, type RepairBoxes } from '../../src/repair/box.ts';

export type BoxCall = { argv: string[]; stdin?: string };

export async function hostBox(source: string, { image = 'host' }: { image?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-repair-box-')));
  await cp(source, root, { recursive: true, verbatimSymlinks: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1' };
  const calls: BoxCall[] = [], outputs: string[] = [];
  let removed = false;
  const box: RepairBox = {
    root, image,
    async exec(argv, { timeoutMs = 120_000, stdin, signal, limit, keep } = {}) {
      calls.push({ argv: [...argv], ...(stdin === undefined ? {} : { stdin }) });
      const result = await capture(argv[0], argv.slice(1), { cwd: root, env, stdin, timeoutMs, signal, limit, keep, group: true });
      outputs.push(result.stdout + result.stderr);
      return result;
    },
    async diff(base) {
      const result = await captureBytes('sh', ['-c', DIFF_SCRIPT, 'sh', base], { cwd: root, env, limit: 10 * 1024 * 1024 });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8'));
      return result.stdout;
    },
    async remove() { removed = true; await rm(root, { recursive: true, force: true }); },
  };
  return { box, root, calls, outputs, removed: () => removed };
}

/** Boxes over host folders; records each box's image and whether it was removed. */
export function hostBoxes({ unavailable = null as string | null } = {}) {
  const created: Awaited<ReturnType<typeof hostBox>>[] = [], images: string[] = [];
  let leftovers = 0;
  const owned = new Map<string, RepairBox>();
  const boxes: RepairBoxes = {
    async available() { return unavailable; },
    async create({ id, image, source }) { images.push(image); const made = await hostBox(source, { image }); created.push(made); owned.set(id, made.box); return made.box; },
    async remove(id) { await owned.get(id)?.remove(); owned.delete(id); },
    async removeLeftovers() { leftovers += 1; },
  };
  return { boxes, created, images, leftovers: () => leftovers };
}

// No detached maintenance: a commit's automatic gc would repack the repository while a box copies it.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

// A repository of files, committed once; returns its commit.
async function repository(directory: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); }
  git(directory, 'init', '--quiet');
  git(directory, 'add', '-A');
  git(directory, 'commit', '--quiet', '-m', 'Add a check');
  return git(directory, 'rev-parse', 'HEAD');
}
const nodeWorkflow = (steps: string) => `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n${steps}`;

/** A tiny repository whose `node check.js` fails because add() subtracts; its CI runs that check on Node 22. */
export const brokenRepository = (directory: string) => repository(directory, {
  'package.json': JSON.stringify({ name: 'app', private: true, scripts: { check: 'node check.js' } }, null, 2),
  'add.js': 'module.exports = (a, b) => a - b;\n',
  'check.js': "const add = require('./add.js');\nconst sum = add(2, 3);\nif (sum !== 5) { console.error(`Error: add(2, 3) returned ${sum}, expected 5`); process.exit(1); }\nconsole.log('ok');\n",
  '.github/workflows/ci.yml': nodeWorkflow('      - name: Check\n        run: node check.js\n'),
});

/**
 * A tiny TypeScript repository with a real type error: add() returns a string where its type says number, so its CI's
 * Typecheck step, `npm run typecheck` (tsc) after installing TypeScript, fails with TS2322 on Node 22.
 */
export const typeErrorRepository = (directory: string) => repository(directory, {
  'package.json': JSON.stringify({ name: 'app', private: true, scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '5.6.3' } }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler' }, include: ['src'] }, null, 2),
  'src/add.ts': 'export const add = (a: number, b: number): number => `${a + b}`;\n',
  '.gitignore': 'node_modules/\n',
  '.github/workflows/ci.yml': nodeWorkflow('      - run: npm install --no-package-lock\n      - name: Typecheck\n        run: npm run typecheck\n'),
});

/**
 * A managed source copy as the controller keeps one, <dataDir>/sources/github-x/app on branch main with GitHub as its
 * origin, holding the broken repository or another; nothing is fetched while it has the commit.
 */
export async function managedCopy(dataDir: string, build: (directory: string) => Promise<string> = brokenRepository) {
  const checkoutPath = join(await realpath(dataDir), 'sources', 'github-fixture', 'app');
  await mkdir(checkoutPath, { recursive: true });
  const sha = await build(checkoutPath);
  git(checkoutPath, 'remote', 'add', 'origin', 'https://github.com/owner/app.git');
  return { checkoutPath, sha };
}
export { git as fixtureGit };
