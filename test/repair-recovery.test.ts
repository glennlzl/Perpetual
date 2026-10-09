import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialReferences, recoveryFor, validRecovery } from '../src/repair/recovery.ts';
import { readRecoveryWorkflow } from '../src/repair/github.ts';

const YAML = `env:
  CLOUD_TOKEN: \${{ secrets.SHADOWED }}
jobs:
  aliases:
    name: Update aliases
    steps:
      - name: Prepare
        env:
          OTHER: \${{ secrets.UNRELATED }}
        run: prepare
      - name: Point aliases
        env:
          CLOUD_TOKEN: \${{ secrets.CLOUD_ACCESS }}
        run: node scripts/aliases.mjs
  separate:
    steps:
      - env:
          OTHER: \${{ secrets.ANOTHER_JOB }}
        run: build
`;
const jobs = [{ id: '1', name: 'Update aliases', conclusion: 'failure', failedSteps: ['Point aliases'] }];

test('credential binding reads the failed step effective env and records references, never credential validity', () => {
  assert.deepEqual(credentialReferences(YAML, jobs), { secrets: ['CLOUD_ACCESS'], environment: null, binding: 'references' });
  assert.deepEqual(credentialReferences(YAML.replace('    name: Update aliases', '    name: Update aliases\n    environment: preview'), jobs), { secrets: ['CLOUD_ACCESS'], environment: 'preview', binding: 'references' });
  const unknown = { secrets: [], environment: null, binding: 'unknown' };
  for (const yaml of [YAML.replace('    name: Update aliases', '    name: ${{ matrix.job }}'), YAML.replace('    name: Update aliases', '    name: Update aliases\n    environment: ${{ inputs.target }}'), YAML.replace('    name: Update aliases', '    name: Update aliases\n    uses: other/reusable.yml@main'), YAML.replace('    name: Update aliases', '    name: Update aliases\n    strategy: {matrix: {os: [linux]}}'), 'invalid: [', YAML.repeat(1000)]) {
    assert.deepEqual(credentialReferences(yaml, jobs), unknown);
  }
  assert.deepEqual(credentialReferences(YAML, [{ ...jobs[0], name: 'Another job' }]), unknown);
});

test('recovery evidence is pinned to the failed SHA and cannot expose arbitrary workflow text or credentials', async () => {
  const calls: unknown[] = [];
  const recovery = await recoveryFor({ repository: 'acme/app', sha: 'a'.repeat(40), runs: [{ id: '12', name: 'Aliases', path: '.github/workflows/aliases.yml@refs/heads/preview', attempt: 1, url: 'https://malicious.example/' }], failures: [{ runId: '12', jobs, log: 'Error: cloud GET /deployments: Not authorized', tail: '', observedAt: '2026-10-07T00:00:00Z', diagnosis: { method: 'rule-based', category: 'configuration', summary: 'Authorization failed' } }] }, async input => { calls.push(input); return YAML; });
  assert.deepEqual(calls, [{ repository: 'acme/app', sha: 'a'.repeat(40), path: '.github/workflows/aliases.yml' }]);
  assert.equal(recovery.runs[0].url, 'https://github.com/acme/app/actions/runs/12');
  assert.equal(recovery.runs[0].settingsUrl, 'https://github.com/acme/app/settings/secrets/actions');
  assert.deepEqual(recovery.runs[0].secrets, ['CLOUD_ACCESS']);
  assert.equal(validRecovery(recovery), true);
  assert.equal(validRecovery({ ...recovery, requests: [{ runId: '../secrets', attempt: 1, requestedAt: '', status: 'requested' }] }), false);
  assert.equal(validRecovery({ ...recovery, runs: [{ ...recovery.runs[0], secrets: ['secret=value'] }] }), false);
});

test('workflow reader validates path, commit and repository before querying GitHub', async () => {
  const calls: string[][] = [];
  const run = async (_file: string, args: string[]) => { calls.push(args); return { stdout: JSON.stringify({ type: 'file', encoding: 'base64', size: YAML.length, content: Buffer.from(YAML).toString('base64') }) }; };
  const input = { repository: 'acme/app', sha: 'a'.repeat(40), path: '.github/workflows/ci.yml' };
  assert.equal(await readRecoveryWorkflow(input, { run }), YAML);
  assert.equal(calls[0].at(-1), `repos/acme/app/contents/.github/workflows/ci.yml?ref=${input.sha}`);
  for (const invalid of [{ ...input, sha: 'main' }, { ...input, path: '.github/workflows/../../secret.yml' }, { ...input, repository: 'acme/app?x=1' }]) await assert.rejects(readRecoveryWorkflow(invalid, { run }));
  assert.equal(calls.length, 1);
});
