import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/validate-repository.ts', import.meta.url));

/** Runs the script from a scratch directory against a repository with one passing configuration test. */
async function checkout(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-validate-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'repo', 'test'), { recursive: true });
  await writeFile(join(directory, 'repo', 'package.json'), JSON.stringify({ name: 'acme-app' }));
  await writeFile(join(directory, 'repo', 'test', 'config.test.mjs'), "import test from 'node:test';\ntest('config parses', () => {});\n");
  const validate = async (name: string, expectations: unknown) => {
    await writeFile(join(directory, `${name}.json`), JSON.stringify(expectations));
    return new Promise<{ code: number; stderr: string }>(resolve => execFile(process.execPath, [script, 'repo', `${name}.json`], { cwd: directory, timeout: 30000 },
      (error, _stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stderr })));
  };
  const report = async (name: string) => JSON.parse(await readFile(join(directory, 'artifacts', `${name}-validation.json`), 'utf8'));
  return { validate, report };
}

test('repository validation refuses expectations that would check nothing', async t => {
  const { validate } = await checkout(t);
  for (const [name, expectations] of Object.entries({
    misspelled: { workflow: ['CI'], deployment: { Vercel: 1 }, keepExistingCi: true },
    empty: {},
    vacuous: { workflows: [], deployments: {}, keepsExistingCi: false },
    'deployment-list': { deployments: [1] },
    'nothing-to-run': { copiedTests: { files: [], run: [] } },
    'misspelled-run': { copiedTests: { files: ['test/config.test.mjs'], runs: ['test/config.test.mjs'] } },
  })) {
    const { code, stderr } = await validate(name, expectations);
    assert.equal(code, 1, name);
    assert.match(stderr, /Expectations (?:must list|assert nothing)/, name);
  }
});

test('copied configuration tests pass only when at least one test passed', async t => {
  const { validate, report } = await checkout(t);
  // node --test exits 0 when a pattern matches no file, which once read as a pass.
  const unmatched = await validate('unmatched', { copiedTests: { files: ['test/config.test.mjs'], run: ['tests/*.test.mjs'] } });
  assert.equal(unmatched.code, 1);
  assert.match(unmatched.stderr, /copiedTests\.run found no passing test: tests\/\*\.test\.mjs\./);
  assert.deepEqual(await validate('copied', { copiedTests: { files: ['test/config.test.mjs'], run: ['test/config.test.mjs'] } }), { code: 0, stderr: '' });
  const { configurationChecks } = await report('copied');
  assert.equal(configurationChecks.status, 'passed');
  assert.match(configurationChecks.output, /^# pass 1$/m);
});
