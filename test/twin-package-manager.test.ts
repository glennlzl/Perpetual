import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appCommand } from '../src/twin/compose.ts';

const exec = promisify(execFile);
for (const setup of ['', 'corepack() { return 23; }; ']) for (const command of ['printf FIRST; printf SECOND', 'printf FIRST || printf SECOND', 'printf FIRST\nprintf SECOND']) {
  test(`failed package-manager setup stops every part of a compound app command: ${JSON.stringify({ setup, command })}`, { skip: process.platform === 'win32' }, async () => {
    const result = await exec('/bin/sh', ['-c', setup + appCommand(command)], { env: { PATH: '/nonexistent' } }).then(
      value => ({ ok: true, ...value }), error => ({ ok: false, stdout: String(error.stdout), stderr: String(error.stderr) }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.stdout, '', 'No application command may execute after setup fails.');
  });
}
