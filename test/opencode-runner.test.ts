import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeRunner, openrouterRefusal, type RunFailure } from '../src/agents/opencode.ts';

const refusal = 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.';
const advice = 'Wait for active OpenRouter requests to finish or add credits, then try again.';
const secret = 'fixture-provider-key-8291';
const messages = { cancelled: 'Writing code cancelled.', timedOut: 'Writing code timed out.', stopped: 'The code generator stopped.', unavailable: 'The code generator is unavailable.' };
// Readiness uses a real clock even when a deadline test advances the supervisor's clock.
const realSetTimeout = setTimeout;

async function setup(t: TestContext, message: string, { keepAlive = false, ignoreTermination = false }: { keepAlive?: boolean; ignoreTermination?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'perpetual-opencode-refusal-'));
  const ready = join(cwd, 'ready');
  let calls = 0;
  const runner = createOpencodeRunner({ model: 'example/model', cwd, env: { OPENROUTER_API_KEY: secret }, secrets: [secret],
    timeoutMs: 30_000, cleanupGraceMs: 100, messages,
    harness: () => {
      calls++;
      return { command: process.execPath, args: ['--input-type=module', '-e', `
        import { writeFileSync } from 'node:fs';
        ${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}
        console.error('tool: read requirements; key=' + process.env.OPENROUTER_API_KEY);
        console.error('Error: ' + ${JSON.stringify(message)});
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        ${keepAlive ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 1;'}
      `] };
    },
  });
  t.after(async () => { runner.cancel(); await rm(cwd, { recursive: true, force: true }); });
  return { runner, calls: () => calls, async ready() {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      if (await readFile(ready, 'utf8').catch(() => '') === 'ready') return;
      await new Promise(resolve => realSetTimeout(resolve, 10));
    }
    throw new Error('The local refusal fixture did not start.');
  } };
}

test('in-flight credit reservations give wait-or-add guidance without claiming an empty account', () => {
  assert.equal(openrouterRefusal(`Error: ${refusal}`), advice);
  assert.equal(openrouterRefusal(`tool: searched for "${refusal}"`), undefined, 'A tool match is not a provider refusal.');
});

for (const [message, expected] of [
  [refusal, advice],
  ['This request requires more credits, or fewer max_tokens.', 'Add credits to your OpenRouter account and try again.'],
  ['Invalid API key', 'Check your OpenRouter API key in Settings.'],
  ['{"code":400,"message":"The provider rejected a request parameter."}', 'The selected model does not work with this agent. Choose another model in Settings.'],
] as const) test(`a stopped provider refusal presents only its action while retaining redacted diagnostics: ${message}`, async t => {
  const f = await setup(t, message);
  await assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.message, expected);
    assert.equal(error.reason, expected);
    assert.match(error.output, /tool: read requirements/);
    assert.ok(error.output.includes(message));
    assert.ok(!JSON.stringify({ message: error.message, reason: error.reason, output: error.output }).includes(secret));
    assert.equal(error.timedOut, undefined);
    assert.equal(error.cleanupIncomplete, undefined);
    return true;
  });
  assert.equal(f.calls(), 1, 'A refusal never retries the agent.');
});

test('an unrecognized agent failure keeps its diagnostic in the displayed error', async t => {
  const f = await setup(t, 'The test file could not be written.');
  await assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.match(error.message, /The test file could not be written/);
    assert.match(error.output, /tool: read requirements/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(f.calls(), 1);
});

async function capture(t: TestContext, chunks: string[], { exit = 0, secrets = [], env = {}, harnessEnv = {} }: { exit?: number; secrets?: string[]; env?: Record<string, string>; harnessEnv?: Record<string, string> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'perpetual-opencode-output-'));
  await writeFile(join(cwd, 'chunks.json'), JSON.stringify(chunks));
  const runner = createOpencodeRunner({ model: 'example/model', cwd, env, secrets, timeoutMs: 30_000, cleanupGraceMs: 1000, messages,
    harness: () => ({ command: process.execPath, env: harnessEnv, args: ['--input-type=module', '-e', `
      import {readFile} from 'node:fs/promises';
      for (const chunk of JSON.parse(await readFile('chunks.json','utf8'))) {
        await new Promise(resolve => process.${exit ? 'stderr' : 'stdout'}.write(chunk, resolve));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      process.exitCode = ${exit};
    `] }) });
  t.after(async () => { runner.cancel(); await rm(cwd, { recursive: true, force: true }); });
  return runner.run('Write the reviewed data.');
}

test('agent output redacts complete credential blocks before retaining a success or failure tail', async t => {
  for (const exit of [0, 1]) await t.test(`exit ${exit}`, async t => {
    const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(300), '-----END PRIVATE KEY-----\nFinished.\n'], { exit });
    const result = exit ? await promise.catch((error: RunFailure) => error) : await promise;
    assert.ok(!result.output.includes('private-fixture-body'));
    assert.ok(result.output.includes('Finished.'), 'Ordinary diagnostic text remains useful.');
    if ('reason' in result) assert.equal(result.reason, messages.stopped);
  });
});

test('an agent that stops inside a credential block never returns its unfinished body', async t => {
  const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(300)], { exit: 1 });
  await assert.rejects(promise, (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.ok(!error.output.includes('private-fixture-body'));
    assert.ok(error.output.includes('[REDACTED]'));
    return true;
  });
});

test('agent output hides a supplied value across stream chunks without retaining a suffix', async t => {
  const secret = `supplied-fixture-${'q'.repeat(5000)}-end`;
  const result = await capture(t, [secret.slice(0, 4500), secret.slice(4500), '\nFinished.\n'], { secrets: [secret] });
  assert.ok(!result.output.includes('q'.repeat(30)));
  assert.ok(result.output.includes('[REDACTED]'));
  assert.ok(result.output.includes('Finished.'));
});

test('agent output protects the effective process model key before clipping without requiring duplicate secrets', async t => {
  const key = `private-model-credential-${'q'.repeat(40)}`;
  for (const input of [{ env: { OPENROUTER_API_KEY: key } }, { harnessEnv: { OPENROUTER_API_KEY: key } }]) {
    const result = await capture(t, [`${key}${'.'.repeat(3970)}`], input);
    assert.ok(!result.output.includes('q'.repeat(10)));
  }
});

test('incomplete captured output is withheld while the actual agent outcome remains known', async t => {
  const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(30_000), '-----END PRIVATE KEY-----\n'], { exit: 1 });
  await assert.rejects(promise, (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.equal(error.timedOut, undefined);
    assert.ok(!error.output.includes('private-fixture-body'));
    assert.match(error.output, /output.*withheld/i);
    return true;
  });
});

test('cancellation takes precedence over provider refusal output', async t => {
  const f = await setup(t, refusal, { keepAlive: true });
  const failed = assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.reason, messages.cancelled);
    assert.equal(error.message, messages.cancelled);
    assert.equal(error.output, '');
    assert.equal(error.timedOut, undefined);
    return true;
  });
  await f.ready();
  f.runner.cancel();
  await failed;
  assert.equal(f.calls(), 1);
});

for (const ignoreTermination of [false, true]) test(`deadline and cleanup ownership take precedence over provider refusal (forced cleanup: ${ignoreTermination})`, async t => {
  const f = await setup(t, refusal, { keepAlive: true, ignoreTermination });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.ok(error.reason.startsWith(messages.timedOut));
    assert.equal(error.timedOut, true);
    assert.equal(error.cleanupIncomplete, ignoreTermination ? true : undefined);
    if (ignoreTermination) assert.match(error.reason, /Cleanup incomplete/);
    assert.ok(error.output.includes(refusal), 'The process actually emitted the provider refusal before the deadline.');
    assert.ok(!error.message.includes(advice), 'The refusal must not override the deadline.');
    assert.ok(!error.output.includes(secret));
    return true;
  });
  await f.ready();
  t.mock.timers.tick(30_000);
  if (ignoreTermination) t.mock.timers.tick(100);
  await failed;
  assert.equal(f.calls(), 1);
});
