import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecoveryCredentials } from '../src/repair/credentials.ts';
import type { RecoveryRun } from '../contract/build-recovery.ts';
const ref: RecoveryRun = { id: '12', attempt: 1, name: 'Aliases', url: 'https://github.com/acme/app/actions/runs/12', workflow: '.github/workflows/ci.yml', observedAt: '2026-10-07T00:00:00Z', secrets: ['CLOUD_TOKEN'], environment: null, binding: 'references', settingsUrl: 'https://github.com/acme/app/settings/secrets/actions' };
const secret = (name = 'CLOUD_TOKEN', updated_at = '2026-10-07T00:00:00Z') => ({ name, updated_at });

test('only effective secret metadata changes the recovery revision, never values or unrelated secrets', async () => {
  let effective = secret(), unrelated = secret('UNRELATED');
  const calls: string[][] = [];
  const run = async (_: string, args: string[]) => { calls.push(args); return { stdout: JSON.stringify({ total_count: 2, secrets: [effective, unrelated] }) }; };
  const input = { repository: 'acme/app', runs: [ref] };
  const first = await readRecoveryCredentials(input, { run });
  assert.ok('revision' in first && /^[a-f0-9]{64}$/.test(first.revision));
  unrelated = secret('UNRELATED', '2026-10-08T00:00:00Z');
  assert.deepEqual(await readRecoveryCredentials(input, { run }), first);
  effective = secret('CLOUD_TOKEN', '2026-10-08T00:00:00Z');
  assert.notDeepEqual(await readRecoveryCredentials(input, { run }), first);
  assert.equal(calls.every(args => args.includes('GET') && args.at(-1) === 'repos/acme/app/actions/secrets?per_page=100&page=1'), true);
});

test('environment secrets take precedence and organization metadata is read only when the repository lacks the reference', async () => {
  const calls: string[] = [];
  const run = async (_: string, args: string[]) => {
    const path = args.at(-1)!; calls.push(path);
    const secrets = path.includes('/environments/') || path.includes('/organization-secrets') ? [secret()] : [];
    return { stdout: JSON.stringify({ total_count: secrets.length, secrets }) };
  };
  assert.ok('revision' in await readRecoveryCredentials({ repository: 'acme/app', runs: [{ ...ref, environment: 'preview / one' }] }, { run }));
  assert.deepEqual(calls, ['repos/acme/app/environments/preview%20%2F%20one/secrets?per_page=100&page=1']);
  calls.length = 0;
  assert.ok('revision' in await readRecoveryCredentials({ repository: 'acme/app', runs: [ref] }, { run }));
  assert.deepEqual(calls, ['repos/acme/app/actions/secrets?per_page=100&page=1', 'repos/acme/app/actions/organization-secrets?per_page=100&page=1']);
});

test('unknown binding, denied higher scope, malformed dates and incomplete metadata never authorize retries', async () => {
  let called = 0;
  const denied = async () => { called++; throw Object.assign(new Error('denied'), { stderr: 'HTTP 403' }); };
  assert.ok('reason' in await readRecoveryCredentials({ repository: 'acme/app', runs: [{ ...ref, binding: 'unknown' }] }, { run: denied }));
  assert.equal(called, 0);
  assert.ok('reason' in await readRecoveryCredentials({ repository: 'acme/app', runs: [{ ...ref, environment: 'preview' }] }, { run: denied }));
  assert.equal(called, 1, 'Denied environment scope must not fall back to a shadowed repository credential.');
  for (const value of [{ total_count: 1, secrets: [secret('CLOUD_TOKEN', 'invalid')] }, { total_count: 2, secrets: [] }, { total_count: 1001, secrets: [] }]) {
    assert.ok('reason' in await readRecoveryCredentials({ repository: 'acme/app', runs: [ref] }, { run: async () => ({ stdout: JSON.stringify(value) }) }));
  }
});

test('metadata pagination completes before a reference can be treated as absent', async () => {
  const calls: string[] = [];
  const run = async (_: string, args: string[]) => {
    const path = args.at(-1)!; calls.push(path);
    return { stdout: JSON.stringify({ total_count: 101, secrets: path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => secret(`OTHER_${i}`)) : [secret()] }) };
  };
  assert.ok('revision' in await readRecoveryCredentials({ repository: 'acme/app', runs: [ref, ref] }, { run }));
  assert.equal(calls.length, 2, 'The snapshot reuses a complete metadata list.');
});
