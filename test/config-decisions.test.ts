import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigDecisions } from '../src/twin/config-decisions.ts';

const draft = JSON.stringify({ services: {}, apps: {
  web: { start: 'node web.mjs', port: 3000, env: {} },
  api: { start: 'node api.mjs', port: 3001, env: {} },
}, fixtures: [] });
const edit = (path: string[], value: unknown) => ({ path, value: JSON.stringify(value) });
const choices = (...changes: { path: string[]; value: string }[]) => ({ changes, blockers: [] });

test('bounded decisions wire actual app references and preserve other draft values', () => {
  const result = applyConfigDecisions(draft, choices(edit(['apps', 'web', 'env', 'API_URL'], '{{apps.api.publicUrl}}'), edit(['node'], 24)));
  assert.equal(result.error, undefined);
  const config = JSON.parse(result.text!);
  assert.equal(config.apps.web.env.API_URL, '{{apps.api.publicUrl}}');
  assert.equal(config.node, 24);
  assert.deepEqual(config.apps.api, JSON.parse(draft).apps.api);
});

test('invalid app IDs and missing references reject the entire decision without changing the draft', () => {
  for (const change of [edit(['apps', 'bad_id'], { start: 'node app.mjs', port: 4000 }), edit(['apps', 'web', 'env', 'API_URL'], '{{apps.missing.url}}')]) {
    const result = applyConfigDecisions(draft, choices(edit(['node'], 24), change));
    assert.equal(result.text, undefined);
    assert.ok(result.error);
    assert.equal(JSON.parse(draft).node, undefined);
  }
});

test('unknown existing fields survive edits until the real validator refuses them', () => {
  const result = applyConfigDecisions(JSON.stringify({ ...JSON.parse(draft), unexpected: true }), choices(edit(['node'], 24)));
  assert.equal(result.text, undefined);
  assert.match(result.error!, /unsupported field unexpected/);
});

test('all edit and decision shapes are strict and bounded', () => {
  for (const decision of [null, {}, { ...choices(), remove: [] }, { changes: [{ ...edit(['node'], 24), op: 'remove' }], blockers: [] },
    choices(edit([], {})), choices(edit(['apps', 'web', 'env', 'A', 'B', 'C', 'D'], 'x')),
    choices(edit(['node'], 24), ...Array.from({ length: 48 }, () => edit(['node'], 24))),
    choices(edit(['other'], {})), choices(edit(['apps', 'web', 'env', 'x'.repeat(257)], 'ordinary')),
    { changes: [], blockers: [null] }, { changes: [], blockers: Array(17).fill('Missing input') },
    { changes: new Array(2), blockers: [] }, choices({ path: ['apps', , 'web'] as string[], value: '{}' }),
    { changes: [], blockers: new Array(1) }]) {
    assert.ok(applyConfigDecisions(draft, decision).error);
  }
  const decision = Object.create({ changes: [], blockers: [] });
  assert.ok(applyConfigDecisions(draft, decision).error);
  let invoked = false;
  assert.ok(applyConfigDecisions(draft, { get changes() { invoked = true; return []; }, blockers: [] }).error);
  assert.equal(invoked, false);
  const path = ['apps', 'web', 'env'];
  Object.defineProperty(path, 1, { get() { invoked = true; return 'web'; } });
  assert.ok(applyConfigDecisions(draft, choices({ path, value: '{}' })).error);
  assert.equal(invoked, false);
});

test('reserved keys are refused in paths, nested values, drafts and escaped duplicate JSON members', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(applyConfigDecisions(draft, choices(edit(['apps', 'web', 'env', key], 'x'))).error);
    const value = `{"nested":{"${key}":"x"}}`;
    assert.match(applyConfigDecisions(draft, choices({ path: ['apps', 'web', 'env'], value })).error!, /reserved/);
  }
  assert.match(applyConfigDecisions(draft, choices({ path: ['apps', 'web', 'env'], value: '{"nested":{"\\u005f_proto__":1},"nested":{}}' })).error!, /reserved/);
  assert.match(applyConfigDecisions('{"apps":{},"constructor":{}}', choices()).error!, /reserved/);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('secret literals are inspected before duplicate members or JSON escapes can hide them', () => {
  const hidden = 'private-account-token-1482';
  const shadowed = '{"TOKEN":"ghp_\\u0066ixture_value","TOKEN":"ordinary"}';
  for (const value of [shadowed, '"postgres://user:fixture%40password@db/app"', JSON.stringify({ TOKEN: hidden })]) {
    const result = applyConfigDecisions(draft, choices({ path: ['apps', 'web', 'env'], value }), { secrets: [hidden] });
    assert.equal(result.text, undefined);
    assert.match(result.error!, /credential literal/);
    assert.ok(!result.error!.includes(hidden));
  }
  assert.match(applyConfigDecisions(`{"apps":${shadowed},"apps":{}}`, choices()).error!, /credential literal/);
  assert.match(applyConfigDecisions(draft, choices(edit(['apps', 'web', 'env', hidden], 'ordinary')), { secrets: [hidden] }).error!, /credential literal/);
});

test('blockers prevent changes and redact known and shaped credentials before clipping', () => {
  const secret = 'private-account-token-1482';
  const result = applyConfigDecisions(draft, { changes: [edit(['node'], 24)], blockers: [`Missing ${secret}; ghp_fixture_value`] }, { secrets: [secret] });
  assert.equal(result.text, undefined);
  assert.match(result.error!, /needs more information/);
  assert.ok(!result.error!.includes(secret) && !result.error!.includes('ghp_fixture_value'));
});

test('output size is capped across the combined changes', () => {
  const result = applyConfigDecisions(draft, choices(...['A', 'B', 'C'].map(key => edit(['apps', 'web', 'env', key], 'x'.repeat(100_000)))));
  assert.equal(result.text, undefined);
  assert.match(result.error!, /256 KB/);
});

test('quoted code stays ordinary data while unknown services and missing apps remain invalid', () => {
  const command = 'node -e \'console.log({"constructor": "ordinary"})\'';
  const result = applyConfigDecisions(draft, choices(edit(['apps', 'web', 'start'], command)));
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(result.text!).apps.web.start, command);
  assert.match(applyConfigDecisions(draft, choices(edit(['services'], { unknown: {} }))).error!, /Unknown service/);
  assert.match(applyConfigDecisions(draft, choices(edit(['apps'], {}))).error!, /Add an app/);
});

test('only existing parents are editable and arrays cannot become sparse or gain properties', () => {
  const value = JSON.parse(draft); delete value.apps.web.env;
  assert.match(applyConfigDecisions(JSON.stringify(value), choices(edit(['apps', 'web', 'env', 'NEW'], 'value'))).error!, /missing parent/);
  assert.equal(applyConfigDecisions(JSON.stringify(value), choices(edit(['apps', 'web', 'env'], { NEW: 'value' }))).error, undefined);
  for (const index of ['1', '-1', '01', 'length']) {
    assert.ok(applyConfigDecisions(draft, choices(edit(['fixtures', index], {}))).error);
  }
});

test('runtime repair can change the failed app only, including replacement of that app', () => {
  for (const stage of ['build', 'healthy', 'answers']) {
    const repair = { stage, subject: 'App `web` using `node web.mjs`' };
    assert.equal(applyConfigDecisions(draft, choices(edit(['apps', 'web', 'start'], 'node server.mjs')), { repair }).error, undefined);
    assert.equal(applyConfigDecisions(draft, choices(edit(['apps', 'web'], { start: 'node server.mjs', port: 3000 })), { repair }).error, undefined);
    for (const change of [edit(['apps'], JSON.parse(draft).apps), edit(['apps', 'api', 'start'], 'node other.mjs'), edit(['node'], 24), edit(['services'], {})]) {
      assert.match(applyConfigDecisions(draft, choices(change), { repair }).error!, /only apps.web/);
    }
  }
});

test('unscoped or unfamiliar repair failures never authorize full regeneration', () => {
  for (const repair of [{ stage: 'valid', subject: 'App `web`' }, { stage: 'account', subject: 'App `web`' },
    { stage: 'build', subject: 'Service `database`' }, { stage: 'healthy' },
    { stage: 'answers', subject: 'App `missing`' }, { stage: 'build', subject: 'App `web`suffix' }]) {
    assert.match(applyConfigDecisions(draft, choices(edit(['apps', 'web', 'start'], 'node server.mjs')), { repair }).error!, /no supported app repair scope/);
  }
});
