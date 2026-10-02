import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { constants } from 'node:os';
import { loopbackCommand } from '../src/twin/loopback.ts';

// Control the kernel boundary to hold signal delivery and process termination apart.
// The real-process companion tests prove that owned processes and sockets stop.
async function supervisor(platform = 'darwin') {
  const child = Object.assign(new EventEmitter(), { pid: 4100 });
  const signals: (string | number)[] = [], exits: number[] = [], errors: string[] = [];
  const timers = new Set<{ at: number; interval: number; callback: () => unknown }>();
  let now = 0, groupGone = false, memberState = 'S', unrelatedState = 'S';
  const process = Object.assign(new EventEmitter(), {
    argv: ['node', '[4109]', 'node app.js'], platform,
    kill(pid: number, signal: string | number) {
      assert.equal(pid, -4100, 'Only the owned process group may be signalled or checked.');
      if (groupGone) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal !== 0) signals.push(signal);
      return true;
    },
    exit(code: number) { exits.push(code); },
  });
  const timer = (callback: () => unknown, ms: number, interval = 0) => {
    const entry = { at: now + ms, interval, callback }; timers.add(entry); return entry;
  };
  const server = Object.assign(new EventEmitter(), { listen(_options: unknown, ready: () => void) { ready(); }, close() {} });
  const modules: Record<string, unknown> = {
    'node:net': { createServer: () => server },
    'node:child_process': { spawn: () => child },
    'node:os': { constants },
    'node:fs/promises': {
      readdir: async () => ['4101', '99', 'self'],
      readFile: async (path: string) => {
        if (path === '/proc/4101/stat') return `4101 (owned child) ${memberState} 1 4100 0`;
        assert.equal(path, '/proc/99/stat');
        return `99 (unrelated) ${unrelatedState} 1 99 0`;
      },
    },
  };
  runInNewContext(loopbackCommand('node app.js', [4109], 3000)[2], {
    process, console: { error: (message: string) => errors.push(message) },
    require: (name: string) => { assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name]; },
    setTimeout: (callback: () => unknown, ms: number) => timer(callback, ms),
    setInterval: (callback: () => unknown, ms: number) => timer(callback, ms, ms),
    clearTimeout: (entry: never) => timers.delete(entry), clearInterval: (entry: never) => timers.delete(entry),
  });
  const settled = () => new Promise<void>(resolve => setImmediate(resolve));
  await settled();
  return {
    child, signals, exits, errors, stop: () => process.emit('SIGTERM'),
    removeGroup() { groupGone = true; }, memberState(value: string) { memberState = value; },
    unrelatedState(value: string) { unrelatedState = value; },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(entry => entry.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        if (next.interval) next.at += next.interval; else timers.delete(next);
        next.callback(); await settled();
        if (exits.length) break;
      }
      now = end;
    },
  };
}

test('Forced loopback shutdown waits for the owned group to terminate after signal delivery', async () => {
  const job = await supervisor();
  job.stop();
  await job.advance(2000);
  assert.deepEqual(job.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(job.exits, [], 'Sending SIGKILL alone does not confirm termination.');
  job.child.emit('exit', null, 'SIGKILL');
  await job.advance(25);
  assert.deepEqual(job.exits, [], 'The direct child exiting does not confirm its descendants stopped.');
  job.removeGroup();
  await job.advance(25);
  assert.deepEqual(job.exits, [143]);
});

test('Unconfirmed loopback group cleanup ends within its bound with an explicit failure', async () => {
  const job = await supervisor();
  job.stop();
  job.child.emit('exit', null, 'SIGTERM');
  await job.advance(4000);
  assert.deepEqual(job.exits, [1]);
  assert.match(job.errors.join('\n'), /could not confirm.*stopped/i);
});

test('Loopback shutdown reaps its direct child before completing an absent group', async () => {
  const job = await supervisor();
  job.stop(); job.removeGroup();
  await job.advance(25);
  assert.deepEqual(job.exits, []);
  job.child.emit('exit', null, 'SIGTERM');
  await job.advance(25);
  assert.deepEqual(job.exits, [143]);
});

for (const state of ['Z', 'X']) {
  test(`Linux loopback shutdown accepts ${state} members, while live members still hold cleanup`, async () => {
    const job = await supervisor('linux');
    job.stop();
    job.child.emit('exit', null, 'SIGTERM');
    await job.advance(2000);
    assert.deepEqual(job.exits, []);
    job.memberState(state);
    await job.advance(25);
    assert.deepEqual(job.exits, [143]);
  });
  test(`An unrelated Linux tracing-stop process does not prevent cleanup of an owned ${state} group`, async () => {
    const job = await supervisor('linux');
    job.memberState(state); job.unrelatedState('t'); job.stop();
    job.child.emit('exit', null, 'SIGTERM');
    await job.advance(4000);
    assert.deepEqual(job.exits, [143]);
    assert.deepEqual(job.errors, []);
  });
}

test('An owned Linux tracing-stop process is still live and cannot confirm cleanup', async () => {
  const job = await supervisor('linux');
  job.memberState('t'); job.stop();
  job.child.emit('exit', null, 'SIGTERM');
  await job.advance(4000);
  assert.deepEqual(job.exits, [1]);
  assert.match(job.errors.join('\n'), /could not confirm.*stopped/i);
});

test('Unreadable Linux process state does not confirm loopback cleanup', async () => {
  const job = await supervisor('linux');
  job.memberState('?'); job.stop();
  job.child.emit('exit', null, 'SIGTERM');
  await job.advance(4000);
  assert.deepEqual(job.exits, [1]);
  assert.match(job.errors.join('\n'), /could not confirm.*stopped/i);
});
