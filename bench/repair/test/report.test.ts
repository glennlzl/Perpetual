// The report from fixture records: success with its interval, cost per success, time, requests, how attempts ended,
// rule violations, judge failures, the per-case matrix and unique solves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, renderReport, wilson } from '../report.ts';
import type { AttemptRecord } from '../results.ts';

function record(framework: string, name: string, seed: number, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    run: 'r', key: `${framework}|m/x|${name}|${seed}`, framework, frameworkVersion: '1', model: 'm/x', case: name, seed, startedAt: '', status: 'judged', reason: 'done', adapterReason: 'done', summary: '', error: '',
    adapterSteps: 5, reproduced: true, frameworkCost: 0.1, wallMs: 60_000, setupMs: 1, harnessPaths: [], diff: null, rules: { rejected: [], holds: [] }, guards: [], scriptsChanged: [],
    gateway: { requests: 6, toolCalls: 5, tokens: { prompt: 1, completion: 1, reasoning: 0, cached: 0, cacheWrite: 0 }, cost: 0.1, costSources: { usage: 6, generation: 0, unknown: 0 }, refusals: {}, firstRefusal: null, modelViolations: [], providers: {}, byok: 0 },
    judge: { reason: 'passed', detail: '', passed: true, ciPassed: true, steps: [], ms: 1 }, success: true, passedWithoutDone: false, ...extra,
  };
}

test('the Wilson interval and quantiles', () => {
  assert.deepEqual(wilson(0, 0), [0, 0]);
  const [low, high] = wilson(8, 8);
  assert.ok(Math.abs(low - 0.6756) < 0.001 && high === 1);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 3.7);
});

test('the report summarizes each framework and model, each case, and unique solves', () => {
  const failed = { success: false, reason: 'steps' as const, judge: { reason: 'ci' as const, detail: '', passed: false, ciPassed: false, steps: [{ name: 'Run npm test', exit: 1, ms: 1, timedOut: false }], ms: 1 } };
  const records = [
    record('aisdk', 'a', 1), record('aisdk', 'b', 1), record('aisdk', 'b', 1, { ...failed, wallMs: 120_000 }),
    record('pi', 'a', 1, failed), record('pi', 'b', 1, { success: false, reason: 'done', rules: { rejected: ['The change touches CI or deployment configuration. More.'], holds: [] }, judge: { reason: 'rule', detail: '', passed: false, ciPassed: true, steps: [], ms: 1 } }),
    record('pi', 'c', 1, { success: false, passedWithoutDone: true, reason: 'cost', gateway: { ...record('pi', 'c', 1).gateway!, cost: 0.5, costSources: { usage: 1, generation: 0, unknown: 1 } } }),
    record('pi', 'd', 1, { status: 'skipped', skipped: 'budget', gateway: null, judge: null, success: false }),
    record('pi', 'e', 1, { status: 'error', reason: 'error', error: 'Could not create the repair box', gateway: null, judge: null, success: false }),
    // A runner error after the model ran keeps what it spent.
    record('pi', 'f', 1, { status: 'error', reason: 'error', error: 'Could not read the change from the repair box: git failed.', judge: null, success: false, gateway: { ...record('pi', 'f', 1).gateway!, cost: 0.3 } }),
  ];
  const report = renderReport(records);
  // The later aisdk|b record replaces the earlier one: five attempts.
  assert.match(report, /\| aisdk · m\/x \| 1\/2 \(50%\) \| 9%–91% \| \$0\.20 \| \$0\.10 \| 90s \| 114s \| 6 \| 5 \| done 1, steps 1 \| – \| Run npm test 1 \| 0 \| 0 \|/);
  assert.match(report, /\| pi · m\/x \| 0\/3 \(0%\) \| 0%–56% \| – \| \$0\.23 \|.*\| cost 1, done 1, steps 1 \| rejected: The change touches CI or deployment configuration 1 \| Run npm test 1 \| 1 \| 1 \|/);
  assert.match(report, /5 attempts over 3 cases, \$1\.30 spent; 1 skipped \(budget 1\); 2 runner errors, not counted \(a resumed run retries them\)\./, 'What every attempt spent counts, the replaced aisdk|b and pi|f\'s runner error included.');
  assert.match(report, /\| a \| 1\/1 · \$0\.10 \| 0\/1 · \$0\.10 \|/);
  assert.match(report, /\| c \| – \| 0\/1 · \$0\.50 \|/);
  assert.match(report, /## Unique solves\n\n\| Case \| Only solved by \|\n\| --- \| --- \|\n\| a \| aisdk · m\/x \|/);
  assert.match(report, /differences under about 20 percentage points are noise/);
});
