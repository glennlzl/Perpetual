// The judge's rules without Docker: the product's change rules on the box's diff and on what git staged, JSONC guards,
// the universal scripts guard, and the order in which a failing check is reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HELD, REJECTED } from '../../../src/repair/changes.ts';
import { changeRules, guardResults, jsonValue, readWhole, scriptsChanged, verdict } from '../judge.ts';

const diff = (path: string, added: string, removed = 'old') => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${removed}\n+${added}\n`;

test('the product\'s rules run on the box\'s diff and again on what git staged', () => {
  assert.deepEqual(changeRules(diff('src/a.js', 'ok'), { paths: ['src/a.js'], text: diff('src/a.js', 'ok') }), { rejected: [], holds: [], testChanged: false });
  const tests = changeRules(diff('test/a.test.js', 'x'), { paths: ['test/a.test.js'], text: '' });
  assert.deepEqual([tests.testChanged, tests.holds], [true, [HELD.tests]]);
  assert.deepEqual(changeRules(diff('.github/workflows/ci.yml', 'run: true'), { paths: ['.github/workflows/ci.yml'], text: '' }).rejected, [REJECTED.delivery]);
  // A path only git's staged list names, such as one a binary patch hid, is still checked.
  assert.deepEqual(changeRules('', { paths: ['.github/workflows/ci.yml'], text: '' }).rejected, [REJECTED.delivery]);
  assert.deepEqual(changeRules(diff('src/a.js', 'const apiKey = "sk-live-0123456789abcdef";'), { paths: ['src/a.js'], text: '' }).rejected, [REJECTED.credential]);
  const large = changeRules(Array.from({ length: 401 }, (_, index) => diff(`src/f${index}.js`, 'x')).join(''), { paths: [], text: '' });
  assert.deepEqual([large.holds, large.testChanged], [[HELD.size], false], 'A large change is only recorded.');
});

test('guards read JSON and JSONC values, and scripts must stay as they were', () => {
  const tsconfig = '{\n  // strict for safety\n  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, },\n}\n';
  assert.equal(jsonValue(tsconfig, ['compilerOptions', 'strict']), true);
  assert.equal(jsonValue(null, ['a']), undefined);
  assert.equal(jsonValue('{ broken', ['a']), undefined);
  const guards = [{ file: 'tsconfig.json', json: ['compilerOptions', 'strict'], equals: true }, { file: 'package.json', json: ['type'], equals: 'module' }];
  assert.deepEqual(guardResults(guards, file => file === 'tsconfig.json' ? tsconfig : '{"type":"commonjs"}'), [
    { file: 'tsconfig.json', json: ['compilerOptions', 'strict'], ok: true }, { file: 'package.json', json: ['type'], ok: false, actual: 'commonjs' }]);
  const before = '{"scripts":{"test":"node --test","build":"tsc"}}';
  assert.equal(scriptsChanged(before, '{"version":"2.0.0","scripts":{"build":"tsc","test":"node --test"}}'), false);
  assert.equal(scriptsChanged(before, '{"scripts":{"test":"exit 0","build":"tsc"}}'), true);
  assert.equal(scriptsChanged(before, null), true, 'Removing package.json removes its scripts.');
  assert.equal(scriptsChanged(null, before), false, 'A new package.json changes no existing scripts.');
});

test('the first failing check decides the reason, in the order rules, tests, scripts, guards, CI', () => {
  const clean = { rules: { rejected: [], holds: [] }, testChanged: false, scriptsChanged: [], guards: [], steps: [{ name: 'Run npm test', exit: 0, ms: 1, timedOut: false }] };
  assert.deepEqual(verdict(clean), { reason: 'passed', detail: '' });
  assert.equal(verdict({ ...clean, steps: [{ name: 'Run npm test', exit: 1, ms: 1, timedOut: false }] }).detail, 'Run npm test exited 1.');
  assert.equal(verdict({ ...clean, steps: [] }).reason, 'ci', 'No step run is no pass.');
  assert.equal(verdict({ ...clean, guards: [{ file: 'package.json', json: ['type'], ok: false }], steps: [{ name: 'x', exit: 1, ms: 1, timedOut: false }] }).reason, 'guard');
  assert.equal(verdict({ ...clean, scriptsChanged: ['package.json'], guards: [{ file: 'package.json', json: ['type'], ok: false }] }).reason, 'scripts');
  assert.equal(verdict({ ...clean, testChanged: true, scriptsChanged: ['package.json'] }).reason, 'test-changed');
  assert.equal(verdict({ ...clean, rules: { rejected: [REJECTED.delivery], holds: [] }, testChanged: true }).reason, 'rule');
});

// A staged listing the judge box could not read would otherwise skip the staged-path rules and the scripts guard.
test('what the judge needs is read whole, or the attempt is a runner error', async () => {
  const box = (result: { exitCode: number; timedOut?: boolean; truncated?: boolean }) => ({ async exec() { return { stdout: 'package.json\0', stderr: '', timedOut: false, truncated: false, ...result }; } });
  assert.equal(await readWhole(box({ exitCode: 0 }), ['git'], 'what git staged'), 'package.json\0');
  for (const result of [{ exitCode: 128 }, { exitCode: 124, timedOut: true }, { exitCode: 0, truncated: true }]) {
    await assert.rejects(readWhole(box(result), ['git'], 'what git staged'), /The judge could not read what git staged\./, JSON.stringify(result));
  }
});
