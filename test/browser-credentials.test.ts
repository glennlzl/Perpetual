import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserManager } from '../src/browser/manager.ts';
import { createBrowserRuntime } from '../src/browser/runtime.ts';
import { draftCode, manual } from './fixtures/journey-code.ts';
import type { WorkerEvent } from '../src/browser/runtime.ts';
import type { RunCredentials } from '../src/browser/run-credentials.ts';
import type { JourneyRunInput } from '../src/journeys/playwright/runtime.ts';

// What the fake worker receives: the run-only account, if any.
type Request = JourneyRunInput & { credentials?: RunCredentials };

const credentials = { username: 'private-fixture@example.test', password: 'secret-"fixture\\value' };
const scenario = { id: 'journey', name: 'Reopen saved workspace', goal: 'Sign in, save and reopen a workspace',
  steps: [{ id: 'sign-in', title: 'Sign in with the test account' }, { id: 'reopen', title: 'Save and reopen the workspace' }],
  preconditions: ['A dedicated test account is supplied for this run'], expectedOutcomes: ['Saved workspace is visible'],
  assertions: [{ type: 'text-visible', value: 'Workspace' }], selected: true, needsReview: false };

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-private-login-'));
  const repo = join(dataDir, 'repo'); await mkdir(repo);
  const calls: Request[] = [];
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const runtime = { capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: true }), start(input: Request, emit: (event: WorkerEvent) => void) {
    calls.push(input);
    const promise = delay(10).then(() => {
      if (input.credentials) emit({ type: 'result', result: { caseId: 'journey', stopCause: 'none', assertions: [] } });
      else throw new Error('Test account is unavailable');
    });
    return { promise, cancel() {} };
  } };
  const manager = await createBrowserManager({ dataDir, runtime, playwright: runtime });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const context = { key: 'repo', stageId: 'beta', scan: { repo: { path: repo, sha: 'fixture' } } };
  await manager.saveConfig(context, { targetUrl: 'http://127.0.0.1:54300' });
  await manager.saveCases(context, [scenario]); await draftCode(manager, context, [scenario]);
  async function terminal(id: string) {
    for (let i = 0; i < 200; i++) { const report = await manager.runProgress(context, id); if (!['queued', 'running'].includes(report.run.status)) return report; await delay(5); }
    throw new Error('Run did not finish');
  }
  return { dataDir, context, manager, calls, terminal, runtime };
}

function containsNoCredentials(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(credentials)) {
    assert.ok(!text.includes(secret), 'The controller never stores or returns the test account');
    assert.ok(!text.includes(JSON.stringify(secret).slice(1, -1)), 'The controller never stores or returns the JSON-escaped test account');
  }
}

test('test accounts reach only the current worker, never public history, persisted cases or later runs', async t => {
  const f = await fixture(t);
  const response = await f.manager.run(f.context, { credentials }, manual);
  containsNoCredentials(response);
  const report = await f.terminal(response.run.id);
  assert.deepEqual(f.calls[0].credentials, credentials);
  assert.equal(report.run.status, 'needs_review');
  containsNoCredentials(report);
  containsNoCredentials(await f.manager.view(f.context));
  containsNoCredentials(await readFile(join(f.dataDir, 'browser/state.json'), 'utf8'));
  const next = await f.manager.run(f.context, {}, manual); await f.terminal(next.run.id);
  assert.equal(f.calls[1].credentials, undefined);
  await f.manager.close();
  const reopened = await createBrowserManager({ dataDir: f.dataDir, runtime: f.runtime });
  try { containsNoCredentials(await reopened.view(f.context)); } finally { await reopened.close(); }
});

test('malformed or oversized test accounts fail before scheduling any browser work', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 'login', {}, { username: 'a' }, { username: '', password: 'p' },
    { username: 'u', password: 'p', origin: 'https://elsewhere.test' },
    { username: 'u'.repeat(321), password: 'p' }, { username: 'u', password: 'p'.repeat(1025) }]) {
    await assert.rejects(f.manager.run(f.context, { credentials: value }, manual), /test account/i);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.manager.view(f.context)).runs.length, 0);
});

// Twin test accounts are generated local test data: what a worker observed about one is kept as reported.
test('evidence naming the test account is kept as the worker reported it', async t => {
  const f = await fixture(t);
  const evidence = `Login rejected ${credentials.username} ${credentials.password}`;
  f.runtime.start = (input, emit) => ({ promise: delay(5).then(() => {
    emit({ type: 'journey-step', caseId: 'journey', stepId: 'sign-in', status: 'running' }); emit({ type: 'journey-step', caseId: 'journey', stepId: 'sign-in', status: 'completed', evidence });
    emit({ type: 'result', result: { caseId: 'journey', stopCause: 'none', assertions: [] } });
  }), cancel() {} });
  const { run } = await f.manager.run(f.context, { credentials }, manual);
  const report = await f.terminal(run.id);
  assert.equal(report.run.status, 'needs_review');
  assert.deepEqual([report.results[0].caseId, report.progress.cases[0].steps![0].evidence], [scenario.id, evidence]);
});

test('a failed account-backed worker keeps its reason with account values and bearer tokens scrubbed', async t => {
  const f = await fixture(t);
  f.runtime.start = input => ({ promise: Promise.reject(new Error(`Rejected ${input.credentials!.username} with Bearer fixture-token-value`)), cancel() {} });
  const { run } = await f.manager.run(f.context, { credentials }, manual);
  const report = await f.terminal(run.id);
  assert.equal(report.run.status, 'failed');
  assert.equal(report.results[0].error, 'Rejected [REDACTED] with Bearer [REDACTED]');
});

test('worker protocol keeps test account values but scrubs the model key from events and terminal errors', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'perpetual-login-protocol-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const worker = join(folder, 'runner.mjs');
  await writeFile(worker, `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const {credentials:c}=JSON.parse(text);console.log(JSON.stringify({type:'result',note:c.username+' '+process.env.PERPETUAL_MODEL_API_KEY}));console.log(JSON.stringify({type:'error',error:c.username+' '+process.env.PERPETUAL_MODEL_API_KEY}));});`);
  const runtime = createBrowserRuntime({ python: process.execPath, runner: worker, env: { PERPETUAL_MODEL_API_KEY: 'model-fixture-only', PERPETUAL_MODEL: 'fixture' } });
  const events: WorkerEvent[] = [];
  const job = runtime.start({ mode: 'discover', credentials }, event => events.push(event));
  await assert.rejects(job.promise, (error: Error) => error.message === `${credentials.username} [REDACTED]`);
  assert.deepEqual(events, [{ type: 'result', note: `${credentials.username} [REDACTED]` }]);
});
