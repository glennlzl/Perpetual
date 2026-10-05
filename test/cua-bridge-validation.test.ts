import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/validate-cua-bridge.ts', import.meta.url));

test('the bridge validation runs from the command line and reports a desktop it cannot reach', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-bridge-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, [script], { cwd: directory, timeout: 30000 }),
    { code: 1, stderr: 'Usage: node scripts/validate-cua-bridge.ts --id ID --output DIR [--data DIR]\n' });
  // No desktop has this ID, so the first check fails without contacting Docker, and its report is still written.
  const id = randomUUID(), output = join(directory, 'evidence');
  const failure: { code?: number; stderr?: string } = await exec(process.execPath, [script, '--id', id, '--output', output, '--data', join(directory, 'data')], { cwd: directory, timeout: 30000 })
    .then(() => ({}), (error: { code?: number; stderr?: string }) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /^Cua bridge validation failed during SDK shell\. .*\nReport: .*report\.json\n$/);
  const [run] = await readdir(output);
  const report = JSON.parse(await readFile(join(output, run, 'report.json'), 'utf8'));
  assert.deepEqual([report.status, report.sandboxId, report.checks.map((check: { name: string }) => check.name)], ['failed', id, ['SDK shell']]);
});
