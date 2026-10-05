// The corpus lint, without Docker: every meta.json is valid; every workflow is one job on one toolchain, Node 22 with
// npm, Python 3.13 with unittest or Go 1.26, whose setup action picks the box image; no holdout, meta or
// agent-instruction file sits in a snapshot; holdout tests live where the toolchain's test run finds them; the reference
// patch and every decoy apply to the materialized snapshot; materializing gives the same commit every time; and the
// product's change rules decide each patch as its meta states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkChanges } from '../../../src/repair/changes.ts';
import { workflowJob } from '../ci.ts';
import { applies, listFiles, loadCases, materialize, parseMeta } from '../corpus.ts';
import { changeRules } from '../judge.ts';

const cases = await loadCases();
/** The setup actions a corpus workflow may use, and the version each must set up. */
const TOOLCHAINS = {
  'actions/setup-node@v4': { tool: 'node', key: 'node-version', version: 22 },
  'actions/setup-python@v5': { tool: 'python', key: 'python-version', version: '3.13' },
  'actions/setup-go@v5': { tool: 'go', key: 'go-version', version: '1.26' },
} as const;
/** What a snapshot must not hold: meta, agent instructions and holdout tests. */
const HIDDEN = /(^|\/)(meta\.json|AGENTS\.md|CLAUDE\.md|opencode\.jsonc?|\.opencode|reference\.patch|holdout_test\.go|test_holdout_\w*\.py)$|(^|\/)holdout\//;
const manifest = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as { scripts?: Record<string, string>; workspaces?: unknown };

test('the corpus has its twenty failure classes, each with valid meta', () => {
  assert.deepEqual(cases.map(c => c.name), [
    'config-merge-far-cause', 'dep-major-bump', 'esm-cjs-mismatch', 'esm-import-path', 'go-error-wrapping', 'go-vet-and-test', 'lint-real-bugs', 'lock-drift', 'logic-tier-boundary',
    'npm-peer-eresolve', 'paging-boundary-shift', 'python-asyncio-single-flight', 'python-circular-import', 'quadratic-merge-budget', 'test-trap', 'ts-path-alias-runtime', 'ts-refactor-rename',
    'ts-strict-flag', 'tz-calendar-dates', 'workspace-money-units',
  ]);
  assert.equal(new Set(cases.map(c => c.meta.repository)).size, cases.length);
  for (const c of cases) assert.ok(!c.meta.repository.includes(c.name) && !c.meta.repository.includes(c.meta.class), `${c.name}'s repository names no class.`);
  const meta = { repository: 'acme/x', class: 'x', commitMessage: 'x', failingStep: 'x', expect: { logRegex: 'x', diagnosis: 'x' }, notes: 'x' };
  assert.throws(() => parseMeta({ repository: 'acme/x' }), /expect/);
  assert.throws(() => parseMeta({ ...meta, repository: 'nope' }), /owner\/name/);
  assert.throws(() => parseMeta({ ...meta, lock: true }), /lock may only be false/);
  assert.throws(() => parseMeta({ ...meta, lock: false, lockFrom: {} }), /lock may only be false/);
  assert.throws(() => parseMeta({ ...meta, vendorAlso: ['../x.tgz'] }), /vendorAlso/);
});

test('each snapshot has one CI job on one toolchain, holdout tests its test run finds and nothing the agent must not see', async () => {
  for (const c of cases) {
    const yaml = await readFile(join(c.repo, '.github/workflows/ci.yml'), 'utf8'), workflow = parse(yaml) as { jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }> };
    const setups = Object.values(workflow.jobs)[0].steps.filter(step => step.uses?.startsWith('actions/setup-')), uses = setups[0]?.uses ?? '';
    assert.ok(setups.length === 1 && Object.hasOwn(TOOLCHAINS, uses), `${c.name} sets up one toolchain: Node, Python or Go.`);
    const { tool, key, version } = TOOLCHAINS[uses as keyof typeof TOOLCHAINS];
    assert.equal(setups[0].with?.[key], version, `${c.name} sets up ${tool} ${version}.`);
    const job = workflowJob(yaml), runs = job.steps.map(step => step.run.trim());
    assert.ok(job.steps.some(step => step.name === c.meta.failingStep), `${c.name}'s failing step is one of its steps.`);
    const files = await listFiles(c.repo), holdout = await listFiles(c.holdout);
    assert.deepEqual(files.filter(path => HIDDEN.test(path)), [], `${c.name} hides nothing in its snapshot.`);
    assert.ok(holdout.length, `${c.name} has holdout tests.`);
    const ignored = (await readFile(join(c.repo, '.gitignore'), 'utf8').catch(() => '')).split('\n').map(line => line.trim());
    if (tool === 'node') {
      if (c.meta.lock === false) {
        assert.match(runs[0], /^npm install\b/, `${c.name} installs without a lockfile.`);
        assert.ok(!files.includes('package-lock.json') && ignored.includes('package-lock.json'), `${c.name} commits no lockfile and ignores the one npm install writes.`);
      } else {
        assert.equal(runs[0], 'npm ci', `${c.name} installs with npm ci.`);
        assert.ok(files.includes('package-lock.json'), `${c.name} has a lockfile.`);
      }
      assert.equal(runs.at(-1), 'npm test');
      const root = await manifest(join(c.repo, 'package.json'));
      assert.equal(root.scripts?.test, root.workspaces ? 'npm test --workspaces' : 'node --test', `${c.name}'s test script is node --test, or runs every workspace's.`);
      for (const path of holdout) {
        const folder = /^((?:[\w-]+\/)*)test\/holdout\/[\w-]+\.test\.js$/.exec(path)?.[1];
        assert.ok(folder !== undefined, `${c.name}'s holdout test ${path} lives in a package's test/holdout.`);
        assert.equal((await manifest(join(c.repo, folder ?? '', 'package.json'))).scripts?.test, 'node --test', `${c.name}'s holdout test ${path} runs with its package's node --test.`);
      }
    } else if (tool === 'python') {
      assert.ok(runs.some(run => run.startsWith('python -m unittest discover -s tests ')), `${c.name} runs unittest discovery over tests.`);
      assert.ok(files.includes('tests/__init__.py'), `${c.name}'s tests are a package that discovery imports.`);
      assert.ok(ignored.includes('__pycache__/'), `${c.name} ignores the bytecode its tests write, which would read as a test change.`);
      assert.ok(holdout.every(path => /^tests\/test_holdout_\w+\.py$/.test(path)), `${c.name}'s holdout tests live in tests as test_holdout_*.py.`);
    } else {
      assert.ok(runs.includes('go test ./...'), `${c.name} runs go test ./....`);
      assert.match(await readFile(join(c.repo, 'go.mod'), 'utf8'), new RegExp(`^go ${String(version).replace('.', '\\.')}(\\.\\d+)?$`, 'm'), `${c.name}'s go.mod asks for no newer Go than the image's.`);
      for (const path of holdout) {
        const folder = /^((?:[\w-]+\/)*)holdout_test\.go$/.exec(path)?.[1];
        assert.ok(folder !== undefined && files.some(file => file.startsWith(folder) && /^[\w-]+\.go$/.test(file.slice(folder.length)) && !file.endsWith('_test.go')), `${c.name}'s ${path} joins a package of the snapshot.`);
      }
    }
  }
});

test('reference patches and decoys apply to the materialized snapshot, whose commit is the same every time', async t => {
  for (const c of cases) {
    const first = await mkdtemp(join(tmpdir(), 'bench-lint-')), second = await mkdtemp(join(tmpdir(), 'bench-lint-'));
    t.after(async () => { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); });
    assert.equal(await materialize(c, first), await materialize(c, second), `${c.name} materializes to one commit.`);
    assert.ok(await applies(first, c.reference), `${c.name}'s reference patch applies.`);
    for (const decoy of c.meta.decoys) assert.ok(await applies(first, join(c.dir, decoy.patch)), `${c.name}'s ${decoy.patch} applies.`);
    const reference = await readFile(c.reference, 'utf8');
    for (const path of await listFiles(c.holdout)) assert.ok(!reference.includes(path), `${c.name}'s reference patch adds no holdout test.`);
  }
});

// The judge applies the product's rules before anything runs, so a change to them can move a verdict the self-check in
// Docker states: a reference patch must pass them, and only the decoys meta says fail at them may.
test('the product\'s change rules pass every reference patch and fail each decoy at the rules exactly as its meta states', async () => {
  const verdict = async (patch: string) => {
    const diff = await readFile(patch, 'utf8'), rules = changeRules(diff, { paths: checkChanges(diff).paths, text: diff });
    return rules.rejected.length ? 'rule' : rules.testChanged ? 'test-changed' : 'later';
  };
  for (const c of cases) {
    assert.equal(await verdict(c.reference), 'later', `${c.name}'s reference patch passes the rules.`);
    for (const decoy of c.meta.decoys) {
      assert.equal(await verdict(join(c.dir, decoy.patch)), decoy.fails === 'rule' || decoy.fails === 'test-changed' ? decoy.fails : 'later', `${c.name}'s ${decoy.patch} fails as ${decoy.fails}.`);
    }
  }
});
