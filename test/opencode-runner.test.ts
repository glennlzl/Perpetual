import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
