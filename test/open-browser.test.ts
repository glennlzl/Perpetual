import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { openBrowser } from '../src/open-browser.ts';

// The process boundary cannot launch a real browser in CI. A real ChildProcess supplies its event/lifetime contract.
test('browser handoffs use the platform command without a shell or inherited streams and report failure once', () => {
  const url = 'http://127.0.0.1:4317/#secret=' + '0'.repeat(64);
  for (const [platform, command, args] of [
    ['darwin', 'open', [url]], ['linux', 'xdg-open', [url]], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  ] as const) {
    let failures = 0, calls = 0;
    const child = new ChildProcess();
    openBrowser(url, () => { failures += 1; }, { platform, start(file, actual, options) {
      calls += 1; assert.equal(file, command); assert.deepEqual(actual, args);
      assert.deepEqual(options, { stdio: 'ignore', detached: true, windowsHide: true }); return child;
    } });
    assert.equal(calls, 1); assert.equal(failures, 0, 'A running opener is not a failed launch.');
    child.emit('error', new Error('OS launcher unavailable')); child.emit('exit', 1, null);
    assert.equal(failures, 1);
  }
  let failures = 0;
  const successful = new ChildProcess();
  openBrowser(url, () => { failures += 1; }, { start: () => successful });
  successful.emit('exit', 0, null); assert.equal(failures, 0);
  openBrowser(url, () => { failures += 1; }, { start() { throw new Error('Cannot spawn'); } });
  assert.equal(failures, 1);
});
