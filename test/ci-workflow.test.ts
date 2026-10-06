import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

type Defaults = { defaults?: { run?: { shell?: string } } };
type Workflow = Defaults & { jobs: Record<string, Defaults & { steps: { name?: string; run?: string; shell?: string }[] }> };

// How GitHub runs a step's script on Linux. A step that names no shell gets bash without pipefail.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell
const SHELLS: Record<string, string[]> = { unnamed: ['bash', '-e'], bash: ['bash', '--noprofile', '--norc', '-eo', 'pipefail'], sh: ['sh', '-e'] };

test('the runtime tests with the real worker fail their CI step when a test fails or skips', async t => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as Workflow;
  const job = workflow.jobs['browser-runtime'];
  const step = job.steps.find(step => step.name === 'Runtime tests with the real worker');
  const file = /\btest\/[\w-]+\.test\.ts\b/.exec(step?.run ?? '')?.[0];
  assert.ok(step?.run && file, 'The step runs a test file.');
  const shell = SHELLS[step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell ?? 'unnamed'];
  assert.ok(shell, 'A shell GitHub documents.');
  // The step's own script, run as GitHub runs it, against a stand-in for the test file it names.
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-ci-step-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'test'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(directory, 'step.sh'), step.run);
  const outcome = async (body: string) => {
    await writeFile(join(directory, file), `import test from 'node:test';\n${body}\n`);
    return new Promise<number>((resolve, reject) => execFile(shell[0], [...shell.slice(1), 'step.sh'], {
      cwd: directory, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: directory }, timeout: 30000,
    }, error => error && typeof error.code !== 'number' ? reject(error) : resolve(error ? Number(error.code) : 0)));
  };
  assert.equal(await outcome("test('passes', () => {});"), 0);
  // tee exits 0 whatever the tests did, and a run with a failure still prints `# skipped 0`.
  assert.notEqual(await outcome("test('fails', () => { throw new Error('fixture'); });"), 0, 'A failing test fails the step.');
  assert.notEqual(await outcome("test('skips', t => { t.skip('fixture'); });"), 0, 'A skipped test fails the step.');
});
