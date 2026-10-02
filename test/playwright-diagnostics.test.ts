import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { createLifecycleRecorder, fixtureLifecycle, lifecycleError, type LifecycleEvent } from '../src/journeys/playwright/diagnostics.ts';

test('lifecycle diagnostics retain only failed ordinary runs, in private bounded files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'evidence');
  const passed = createLifecycleRecorder({ directory });
  passed.record({ source: 'fixture', name: 'page-open', page: 1 });
  await passed.finish(false);
  const control = createLifecycleRecorder({ directory, blockWrites: true });
  control.record({ source: 'reporter', name: 'test-end', status: 'failed' });
  await control.finish(true);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const failed = createLifecycleRecorder({ directory });
  for (let n = 0; n < 700; n++) failed.record({ source: 'fixture', name: 'frame-navigated', frame: n });
  failed.record({ source: 'reporter', name: 'reload-end', error: 'closed' });
  await failed.finish(true);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.events.length, 512);
  assert.equal(stored.events.at(-1).name, 'reload-end');
  assert.ok(stored.dropped > 0, 'A truncated lifecycle must say that earlier events were dropped.');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok((await stat(path)).size < 256 * 1024);
});

test('diagnostics reject unknown fields and redact supplied secrets without copying messages or URLs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = createLifecycleRecorder({ directory: root, secrets: ['reload-end'] });
  for (const value of [null, [], 'secret', { source: 'fixture', name: 'https://private.example' }, { source: 'secret', name: 'page-open' }]) recorder.record(value);
  recorder.record({ source: 'reporter', name: 'reload-end', error: 'closed', url: 'https://private.example/?token=secret', title: 'Private page', password: 'pw-secret', frame: 'credential-text', stack: 'Never keep me' });
  recorder.record({ source: 'fixture', name: 'page-open', page: NaN, frame: Infinity, target: -1 });
  await recorder.finish(true);
  const text = await readFile(join(root, (await readdir(root))[0]), 'utf8');
  const stored = JSON.parse(text);
  assert.equal(stored.events.length, 2);
  for (const secret of ['reload-end', 'private.example', 'Private page', 'pw-secret', 'credential-text', 'Never keep me']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('[REDACTED]'));
  assert.equal(stored.events[0].error, 'closed');
  assert.equal(stored.events[1].page, undefined);
  assert.equal(stored.events[1].frame, undefined);
  assert.equal(stored.events[1].target, undefined);
  assert.equal(lifecycleError(new Error('Protocol error (Page.reload): Not attached to an active page; token=secret')), 'inactive-page');
  assert.equal(lifecycleError({ message: 'Target page, context or browser has been closed' }), 'closed');
  assert.equal(lifecycleError({ message: 42 }), 'other');
});

test('diagnostic storage failures and symbolic links cannot fail a run or write outside its directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'file'); await writeFile(file, 'keep');
  const linked = join(root, 'link'); await symlink(root, linked);
  for (const directory of [file, linked, undefined]) {
    const recorder = createLifecycleRecorder({ directory });
    recorder.record({ source: 'supervisor', name: 'worker-close', code: 1 });
    await recorder.finish(true);
  }
  assert.equal(await readFile(file, 'utf8'), 'keep');
  assert.deepEqual((await readdir(root)).sort(), ['file', 'link']);
});

test('optional lifecycle transport cannot spoof supervisor facts or disturb the worker result', async () => {
  const { superviseWorker } = await import('../src/browser/runtime.ts');
  const lifecycle: unknown[] = [], diagnostics: unknown[] = [], events: unknown[] = [];
  const job = superviseWorker({
    command: process.execPath, args: ['-e', `
      const fs = require('node:fs');
      const diagnostic = value => { try { fs.writeSync(3, JSON.stringify(value)+'\\n'); } catch {} };
      diagnostic({source:'supervisor', name:'worker-stop', reason:'cancel'});
      diagnostic({source:'fixture', name:'page-close', page:1});
      try { fs.writeSync(3, 'x'.repeat(100000)+'\\n'); } catch {}
      console.log(JSON.stringify({type:'status', status:'ready'}));
    `], env: {}, timeoutMs: 10000,
    onEvent: event => events.push(event), onLifecycle: event => lifecycle.push(event), onDiagnostic: event => diagnostics.push(event),
  });
  await job.promise;
  assert.deepEqual(events, [{ type: 'status', status: 'ready' }]);
  assert.ok(lifecycle.some(value => (value as { name: string }).name === 'worker-exit'));
  assert.ok(lifecycle.some(value => (value as { name: string }).name === 'worker-close'));
  assert.ok(lifecycle.some(value => (value as { name: string }).name === 'worker-diagnostic-truncated'));
  assert.ok(!lifecycle.some(value => (value as { name: string }).name === 'worker-stop'));
  assert.deepEqual(diagnostics, [{ source: 'fixture', name: 'page-close', page: 1 }]);
});

test('supervisor cancellation facts survive throwing diagnostic consumers without changing cleanup', async () => {
  const { superviseWorker } = await import('../src/browser/runtime.ts');
  const lifecycle: { name: string; reason?: string; signal?: string; failed?: boolean }[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const job = superviseWorker({ command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'status'}));setInterval(()=>{},1000);`], env: {}, timeoutMs: 10000,
    onEvent: () => ready(), onLifecycle(event) { lifecycle.push(event); throw new Error('Diagnostic sink unavailable'); },
  });
  await started; job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  assert.ok(lifecycle.some(event => event.name === 'worker-stop' && event.reason === 'cancel'));
  assert.ok(lifecycle.some(event => event.name === 'worker-signal' && event.signal === 'SIGTERM'));
  assert.ok(lifecycle.some(event => event.name === 'worker-done' && event.failed === true));
});

test('fixture diagnostics bound opaque identity storage and never copy protocol payloads', async () => {
  // CDP is the external boundary: event bodies are untrusted even though the browser normally supplies them.
  const browser = new EventEmitter(), context = Object.assign(new EventEmitter(), { browser: () => browser });
  const cdp = Object.assign(new EventEmitter(), { async send() {} });
  const page = Object.assign(new EventEmitter(), { isClosed: () => false });
  const events: LifecycleEvent[] = [];
  const diagnostic = fixtureLifecycle(context as unknown as BrowserContext, event => events.push(event));
  diagnostic.page(page as unknown as Page);
  diagnostic.cdp(page as unknown as Page, cdp as unknown as CDPSession, { targetId: 'secret-target-identity', url: 'https://private.example' });
  for (let n = 0; n < 1600; n++) cdp.emit('Page.frameNavigated', { frame: { id: `secret-frame-${n}`, loaderId: `secret-loader-${n}`, url: 'https://private.example', name: 'Private frame' } });
  for (const value of [null, [], 'private-text', { frame: { id: { token: 'secret' } } }]) cdp.emit('Page.frameNavigated', value);
  diagnostic.cleanup(); context.emit('close'); browser.emit('disconnected');
  assert.ok(events.length < 1100, 'A busy page cannot grow the channel without bound.');
  assert.ok(events.some(event => event.name === 'fixture-cleanup' && Number(event.dropped) > 0));
  assert.ok(events.some(event => event.name === 'browser-disconnected'));
  const frames = events.filter(event => event.name === 'frame-navigated');
  assert.ok(frames.some(event => event.frame === undefined), 'New opaque IDs are omitted once the bounded ID table is full.');
  assert.ok(frames.every(event => event.frame === undefined || typeof event.frame === 'number' && event.frame <= 1024));
  const text = JSON.stringify(events);
  for (const value of ['secret-target', 'secret-frame', 'secret-loader', 'private.example', 'Private frame', 'private-text']) assert.ok(!text.includes(value), value);
});
