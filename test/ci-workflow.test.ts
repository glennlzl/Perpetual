import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { TWINS_NEED_DESKTOP } from '../scripts/setup.ts';
import { desktopSkip } from './fixtures/docker-engine.ts';

type Defaults = { defaults?: { run?: { shell?: string } } };
type Env = { env?: Record<string, unknown> };
type Workflow = Defaults & Env & { on: Record<string, unknown>; jobs: Record<string, Defaults & Env & { steps: (Env & { name?: string; run?: string; shell?: string })[] }> };

// How GitHub runs a step's script on Linux. A step that names no shell gets bash without pipefail.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell
const SHELLS: Record<string, string[]> = { unnamed: ['bash', '-e'], bash: ['bash', '--noprofile', '--norc', '-eo', 'pipefail'], sh: ['sh', '-e'] };
const workflow = async (file: string) => YAML.parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')) as Workflow;

/** A step's own script, run as GitHub runs it, in a scratch directory against stand-ins for the test files it runs. */
async function stepScript(t: TestContext, file: string, jobId: string, name: string) {
  const parsed = await workflow(file), job = parsed.jobs[jobId];
  const step = job.steps.find(step => step.name === name);
  assert.ok(step?.run, 'The step runs a script.');
  const shell = SHELLS[step.shell ?? job.defaults?.run?.shell ?? parsed.defaults?.run?.shell ?? 'unnamed'];
  assert.ok(shell, 'A shell GitHub documents.');
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-ci-step-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(directory, 'step.sh'), step.run);
  return {
    run: step.run,
    /** The script's exit code when the test files are these, each path with the tests it holds, in place of the last run's. */
    async outcome(files: Record<string, string>) {
      await rm(join(directory, 'test'), { recursive: true, force: true });
      await mkdir(join(directory, 'test'));
      for (const [path, body] of Object.entries(files)) await writeFile(join(directory, path), `import test from 'node:test';\n${body}\n`);
      return new Promise<number>((resolve, reject) => execFile(shell[0], [...shell.slice(1), 'step.sh'], {
        cwd: directory, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: directory }, timeout: 30000,
      }, error => error && typeof error.code !== 'number' ? reject(error) : resolve(error ? Number(error.code) : 0)));
    },
  };
}

test('the runtime tests with the real worker fail their CI step when a test fails or skips', async t => {
  const step = await stepScript(t, 'ci.yml', 'browser-runtime', 'Runtime tests with the real worker');
  const file = /\btest\/[\w-]+\.test\.ts\b/.exec(step.run)?.[0];
  assert.ok(file, 'The step runs a test file.');
  const outcome = (body: string) => step.outcome({ [file]: body });
  assert.equal(await outcome("test('passes', () => {});"), 0);
  // tee exits 0 whatever the tests did, and a run with a failure still prints `# skipped 0`.
  assert.notEqual(await outcome("test('fails', () => { throw new Error('fixture'); });"), 0, 'A failing test fails the step.');
  assert.notEqual(await outcome("test('skips', t => { t.skip('fixture'); });"), 0, 'A skipped test fails the step.');
});

test('the Docker tests run every night and on demand, never for a pull request or a push, so no required check waits for them', async () => {
  const { on } = await workflow('docker.yml');
  assert.deepEqual(Object.keys(on).sort(), ['schedule', 'workflow_dispatch']);
  const schedule = on.schedule as { cron: string }[];
  assert.equal(schedule.length, 1);
  assert.match(schedule[0].cron, /^\d+ \d+ \* \* \*$/, 'Once a day.');
});

test('the Docker tests job sets every opt-in a test reads and runs every test file that reads one', async () => {
  const { env, jobs } = await workflow('docker.yml');
  const step = jobs.docker.steps.find(step => step.name === 'Docker tests');
  const set = { ...env, ...jobs.docker.env, ...step?.env }, names = new Set<string>(), files: string[] = [];
  for (const file of (await readdir(new URL('./', import.meta.url))).filter(name => name.endsWith('.test.ts'))) {
    const read = [...(await readFile(new URL(file, import.meta.url), 'utf8')).matchAll(/process\.env\.(PERPETUAL_\w*DOCKER_TESTS)\b/g)].map(([, name]) => name);
    if (read.length) files.push(file);
    for (const name of read) names.add(name);
  }
  assert.ok(names.size >= 2, [...names].join(', '));
  assert.deepEqual([...names].filter(name => String(set[name]) !== '1'), [], 'The job sets each opt-in.');
  assert.ok(step?.run?.includes('test/*-docker.test.ts'), 'The job runs test/*-docker.test.ts.');
  assert.deepEqual(files.filter(file => !file.endsWith('-docker.test.ts')), [], 'Each file that reads an opt-in is one the job runs.');
});

test('the Docker tests step fails on a failed test, on one skipped for want of its opt-in and on a run where nothing passed', async t => {
  const step = await stepScript(t, 'docker.yml', 'docker', 'Docker tests');
  const run = (...bodies: string[]) => step.outcome(Object.fromEntries(bodies.map((body, index) => [`test/stand-in-${index}-docker.test.ts`, body])));
  const passes = "test('passes', () => {});", desktopOnly = `test('reaches the host', t => t.skip(${JSON.stringify(TWINS_NEED_DESKTOP)}));`;
  assert.equal(await run(passes, desktopOnly), 0, 'On the runner\'s native Linux engine the parts that need Docker Desktop skip.');
  // As in the Mailpit twin's test, which runs on every engine but for the part that reaches the host.
  const part = (skip: string) => `test('starts a twin', async t => { await t.test('reaches the host', { skip: ${JSON.stringify(skip)} }, () => {}); });`;
  assert.equal(await run(part(TWINS_NEED_DESKTOP)), 0, 'A test whose part that needs Docker Desktop skips still passes.');
  assert.notEqual(await run(part('fixture')), 0, 'A part skipped for any other reason fails the step.');
  assert.notEqual(await run(passes, "test('fails', () => { throw new Error('fixture'); });"), 0, 'A failing test fails the step.');
  assert.notEqual(await run(passes, "test('opted out', { skip: 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.' }, () => {});"), 0,
    'A test the job did not opt into fails the step.');
  assert.notEqual(await run(desktopOnly), 0, 'A run in which nothing passed fails the step.');
});

test('a twin test\'s part that needs Docker Desktop skips on a native Linux engine with setup\'s note, asking Docker only once opted in', () => {
  const asked: string[] = [], engine = (system: string) => () => { asked.push(system); return system; };
  const optIn = 'Set PERPETUAL_DOCKER_TESTS=1 to run against the local Docker engine.';
  assert.equal(desktopSkip(optIn, 'linux', engine('Ubuntu 24.04.3 LTS\n')), optIn);
  assert.deepEqual(asked, [], 'A test that is not opted in asks Docker nothing.');
  // `docker info --format {{.OperatingSystem}}` names the distribution on a native engine.
  assert.equal(desktopSkip(false, 'linux', engine('Ubuntu 24.04.3 LTS\n')), TWINS_NEED_DESKTOP);
  assert.equal(desktopSkip(false, 'linux', engine('Docker Desktop\n')), false);
  // Only a Linux host runs a native engine.
  assert.equal(desktopSkip(false, 'darwin', engine('Ubuntu 24.04.3 LTS\n')), false);
  assert.equal(desktopSkip(false, 'linux', () => { throw new Error('Cannot connect to the Docker daemon.'); }), false, 'Without an engine the test runs, and Docker\'s failure says why.');
});
