import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const child = spawn(process.execPath, [CLI, 'serve', '--repo', dir, `--data=${join(dir, 'data')}`, '--port=0', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  for (const deadline = Date.now() + 30_000; !stdout.includes('Perpetual is ready at'); await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `serve never became ready: ${stdout}`);
  }
  assert.match(stdout, new RegExp(`Data: ${join(dir, 'data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // The link carries the browser secret in its fragment; the output never holds the launch secret the data directory keeps.
  const secret = await readFile(join(dir, 'data', 'launch-secret'), 'utf8');
  assert.match(stdout, /^Perpetual is ready at http:\/\/127\.0\.0\.1:\d+\/#secret=[0-9a-f]{64}$/m);
  assert.equal(stdout.includes(secret), false);
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  assert.deepEqual(await exited, [0, null]);
  assert.match(stdout, /Stopping…/);
});

// The external OS browser launcher is replaced by an executable, while the real CLI and controller run unchanged.
// Catches omission of the browser handoff, a handoff of the unsigned URL, and a launcher failure stopping the controller.
test('serve opens its authenticated link and keeps serving when the browser launcher fails', { timeout: 60000, skip: process.platform === 'win32' ? 'POSIX executable fixture; Windows launcher is covered through its process boundary.' : false }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-cli-open-')), bin = join(dir, 'bin');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(bin);
  const launcher = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'), handed = join(dir, 'handed.json');
  await writeFile(launcher, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(handed)},JSON.stringify(process.argv.slice(2))); process.exit(1);\n`);
  await chmod(launcher, 0o700);
  const child = spawn(process.execPath, [CLI, 'serve', '--repo', dir, '--data', join(dir, 'data'), '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  for (const deadline = Date.now() + 15_000; !stderr.includes('Could not open'); await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `Browser handoff never finished: ${stderr}`);
  }
  const launch = /Perpetual is ready at (\S+)/.exec(stdout)?.[1];
  assert.ok(launch);
  assert.deepEqual(JSON.parse(await readFile(handed, 'utf8')), [launch]);
  assert.equal(stderr.includes(new URL(launch).hash), false, 'Launcher errors do not repeat credentials.');
  const browser = new URL(launch).hash.slice('#secret='.length);
  assert.equal((await fetch(`${new URL(launch).origin}/api/state`, { headers: { 'X-Perpetual-Browser-Secret': browser } })).status, 200);
  const exited = once(child, 'exit'); child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]);
});

// Catches an ignored headless opt-out: CI and remote sessions must never invoke the OS browser launcher.
test('serve supports a headless start without opening a browser', { timeout: 60000, skip: process.platform === 'win32' ? 'POSIX executable fixture; Windows launcher is covered through its process boundary.' : false }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-cli-headless-')), bin = join(dir, 'bin');
  t.after(() => rm(dir, { recursive: true, force: true })); await mkdir(bin);
  const called = join(dir, 'called'), launcher = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await writeFile(launcher, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(called)},'called');\n`); await chmod(launcher, 0o700);
  const child = spawn(process.execPath, [CLI, 'serve', '--repo', dir, '--data', join(dir, 'data'), '--port=0', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  for (const deadline = Date.now() + 15_000; !stdout.includes('Perpetual is ready at'); await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `Headless serving never became ready: ${stderr}`);
  }
  const exited = once(child, 'exit'); child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]);
  await assert.rejects(readFile(called), { code: 'ENOENT' });
});

// xdg-open can stay alive with the desktop app. A successful handoff must not be killed on a five-second deadline.
test('a long-lived desktop launcher is allowed to complete without being terminated', { timeout: 30000, skip: process.platform === 'win32' ? 'POSIX executable fixture.' : false }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-cli-desktop-')), bin = join(dir, 'bin'), completed = join(dir, 'completed'), pidFile = join(dir, 'launcher-pid');
  await mkdir(bin);
  t.after(async () => { try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* The launcher already exited. */ } await rm(dir, { recursive: true, force: true }); });
  const launcher = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await writeFile(launcher, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); await new Promise(resolve=>setTimeout(resolve,5500)); writeFileSync(${JSON.stringify(completed)},'opened');\n`); await chmod(launcher, 0o700);
  const child = spawn(process.execPath, [CLI, 'serve', '--repo', dir, '--data', join(dir, 'data'), '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  for (const deadline = Date.now() + 10_000; await readFile(completed, 'utf8').catch(() => '') !== 'opened'; await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline && !stderr.includes('Could not open') && child.exitCode === null, 'A healthy desktop launcher was treated as a failure.');
  }
  const exited = once(child, 'exit'); child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]);
});
