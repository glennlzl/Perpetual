import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createGitHubAuthManager, type GitHubAuthManager } from '../src/github-auth.ts';

/**
 * A device sign-in against a GitHub CLI on PATH that prints what `gh auth login --web` prints in `mode`, then waits for
 * `authorize()`, as a person completing GitHub's page, before it exits; `gh api user` answers as octocat.
 */
async function signIn(t: TestContext, mode: 'device' | 'wrong-url' | 'old-cli') {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-github-auth-')), done = join(dir, 'authorized');
  await writeFile(join(dir, 'gh'), [
    `#!${process.execPath}`,
    `const fs = require('node:fs'), args = process.argv.slice(2);`,
    `if (args[0] === 'api') { process.stdout.write('HTTP/2.0 200 OK\\n\\n' + JSON.stringify({ login: 'octocat', name: 'Mona' })); process.exit(0); }`,
    `if (${JSON.stringify(mode)} === 'old-cli') { process.stderr.write('unknown flag: --clipboard\\n\\nUsage:  gh auth login [flags]\\n'); process.exit(1); }`,
    `process.stderr.write('! First copy your one-time code: ABCD-1234\\n');`,
    `process.stderr.write('Open this URL to continue in your web browser: ${mode === 'wrong-url' ? 'https://github.example.test/login/device' : 'https://github.com/login/device'}\\n');`,
    `setInterval(() => { if (fs.existsSync(${JSON.stringify(done)})) process.exit(0); }, 20);`, '',
  ].join('\n'), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = `${dir}${delimiter}${saved.PATH}`;
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  const manager = createGitHubAuthManager();
  t.after(async () => {
    manager.dispose();
    await until(() => !manager.isPending());
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  });
  return { manager, authorize: () => writeFile(done, '') };
}

async function until(ready: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('GitHub sign-in did not settle.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const settled = async (manager: GitHubAuthManager, id: string) => {
  await until(() => !['starting', 'pending'].includes(manager.status(id).status) && !manager.isPending());
  return manager.status(id);
};

test('device sign-in shows only GitHub\'s code and page, then the verified account', async t => {
  const { manager, authorize } = await signIn(t, 'device');
  const { id } = manager.start();
  await until(() => manager.status(id).status === 'pending');
  const pending = manager.status(id);
  assert.deepEqual([pending.userCode, pending.verificationUrl, pending.account, pending.error], ['ABCD-1234', 'https://github.com/login/device', null, null]);
  assert.equal(manager.start().id, id, 'A pending sign-in is reused.');
  await authorize();
  const done = await settled(manager, id);
  assert.deepEqual([done.status, done.account, done.userCode, done.error], ['complete', { login: 'octocat', name: 'Mona' }, null, null]);
});

test('a page other than GitHub\'s device page, or a GitHub CLI without the sign-in flags, asks for a newer GitHub CLI', async t => {
  for (const mode of ['wrong-url', 'old-cli'] as const) await t.test(mode, async t => {
    const { manager } = await signIn(t, mode);
    const { id } = manager.start();
    const done = await settled(manager, id);
    assert.deepEqual([done.status, done.error, done.userCode, done.verificationUrl], ['error', 'GitHub device sign-in is unavailable. Update GitHub CLI and try again.', null, null]);
  });
});

test('a cancelled sign-in stops GitHub CLI and ends', async t => {
  const { manager } = await signIn(t, 'device');
  const { id } = manager.start();
  await until(() => manager.status(id).status === 'pending');
  assert.equal(manager.cancel(id).status, 'cancelled');
  await until(() => !manager.isPending());
  assert.deepEqual([manager.status(id).status, manager.status(id).userCode], ['cancelled', null]);
  assert.throws(() => manager.status('another'), /This GitHub sign-in has ended/);
});

test('an environment token is kept and no browser sign-in starts', async t => {
  const { manager } = await signIn(t, 'device');
  process.env.GH_TOKEN = 'test-token';
  const started = manager.start();
  assert.deepEqual([started.status, started.error, manager.isPending()], ['error', 'GitHub uses an environment token. Continue with the existing account.', false]);
});
