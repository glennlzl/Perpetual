import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** The CLI's exit code, output and error output. */
const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
  execFile(process.execPath, [CLI, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }));
});

test('an option takes its value after a space or an equals sign, and a missing value, an unknown option or command fails on one line', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'cli-fixture' }));
  for (const args of [['scan', '--repo', dir], ['scan', `--repo=${dir}`]]) {
    const result = await run(...args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).repo.name, 'cli-fixture', args.join(' '));
  }
  for (const [args, message] of [
    [['scan', '--repo'], /--repo/], [['scan', '--rpeo', dir], /--rpeo/], [['srve'], /Unknown command: srve/],
    [['serve', '--repo', dir, '--port', 'abc'], /--port needs a whole number/], [['serve', '--repo', join(dir, 'missing')], /No repository directory/],
  ] as const) {
    const result = await run(...args, `--data=${join(dir, 'data')}`);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'A failure is its message, not a stack.');
  }
  const help = await run();
  assert.deepEqual([help.code, help.stdout.startsWith('Perpetual')], [0, true], 'Without a command the CLI prints its help.');
});

test('serve prints its launch link, says it is stopping on the first signal and exits once shutdown finishes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-cli-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CLI, 'serve', '--repo', dir, `--data=${join(dir, 'data')}`, '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  for (const deadline = Date.now() + 30_000; !stdout.includes('Perpetual is ready at'); await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `serve never became ready: ${stdout}`);
  }
  assert.match(stdout, new RegExp(`Data: ${join(dir, 'data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // The link carries the secret the data directory keeps, and the output holds it nowhere else.
  const secret = await readFile(join(dir, 'data', 'launch-secret'), 'utf8');
  assert.match(stdout, new RegExp(`^Perpetual is ready at http://127\\.0\\.0\\.1:\\d+/\\?secret=${secret}$`, 'm'));
  assert.equal(stdout.split(secret).length, 2);
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  assert.deepEqual(await exited, [0, null]);
  assert.match(stdout, /Stopping…/);
});
