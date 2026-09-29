import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { REDACTED, failureText, hide, redact } from '../src/redaction.ts';

test('redact knows every secret shape once: named values, tokens, key blocks, user info', () => {
  const cases: [string, string[]][] = [
    ['Authorization: Bearer abc123 and Authorization=Basic Zm9v', ['abc123', 'Zm9v']],
    ['curl -H "Bearer tok-en-value"', ['tok-en-value']],
    ['API_KEY=abcdef\napi-key: "quoted value"\nSTRIPE_SECRET_KEY: sk_test_51H\nACCESS_TOKEN=zzz', ['abcdef', 'quoted value', 'sk_test_51H', 'zzz']],
    ['{"API_KEY":"sensitive-value","password": \'p a s s\'}', ['sensitive-value', 'p a s s']],
    ['deploy --token ghp_abcdefghijklmnop --api-key=flagvalue', ['ghp_abcdefghijklmnop', 'flagvalue']],
    ['GET /callback?access_token=q1&other=keep&api_key=q2', ['q1', 'q2']],
    ['github_pat_11AAA sk-abcdefghijklmnop sbp_0123456789 AKIAABCDEFGHIJKLMNOP eyJhbGci.eyJzdWIi.SflKxw', ['github_pat_11AAA', 'sk-abcdefghijklmnop', 'sbp_0123456789', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGci.eyJzdWIi.SflKxw']],
    ['https://u:pass@example.com postgres://postgres:secret@db/app', ['u:pass', 'postgres:secret']],
  ];
  for (const [input, secrets] of cases) {
    const output = redact(input);
    for (const secret of secrets) assert.equal(output.includes(secret), false, `${JSON.stringify(input)} keeps ${secret}`);
    assert.match(output, /\[REDACTED\]/);
  }
  assert.equal(redact('other=keep'), 'other=keep');
  assert.equal(redact('\u001b[31mred\u001b[0m'), 'red', 'ANSI colour is removed.');
  const long = 'a'.repeat(220000);
  assert.equal(redact(long), long, 'Ordinary text comes back unchanged.');
  assert.equal(redact(undefined), '');
});

test('a private key block is blanked line by line, so line numbers hold', () => {
  const block = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nAAAA\n-----END RSA PRIVATE KEY-----\nafter';
  assert.equal(redact(block), `before\n${REDACTED}\n${REDACTED}\n${REDACTED}\n${REDACTED}\nafter`);
});

test('hide replaces known values longest first, honours a marker and a minimum length, and ignores what is not a string', () => {
  assert.equal(hide(['abc', 'abcdef', undefined, '', 42])('x abcdef y abc z'), `x ${REDACTED} y ${REDACTED} z`);
  assert.equal(hide(['abc', 'abcdef'])('x abcdef y'), `x ${REDACTED} y`, 'The longer value wins, leaving no fragment.');
  assert.equal(hide(['pw'], { marker: '[redacted]', minLength: 4 })('pw pass'), 'pw pass', 'A value below the minimum is never a secret.');
  assert.equal(hide(['pass'], { marker: '[redacted]', minLength: 4 })('pw pass'), 'pw [redacted]');
  assert.equal(hide(['1234'])('count 1234'), `count ${REDACTED}`, 'Without a minimum, a four-character value is replaced.');
  assert.equal(hide([])(12), '12');
});

test('failureText redacts before it clips, so a clipped message never keeps part of a secret', () => {
  const error = new Error(`${'x'.repeat(20)} token=${'s'.repeat(40)}`);
  assert.equal(failureText(error, 30), `${'x'.repeat(20)} token=[RE`);
  assert.equal(failureText('plain', 10), 'plain');
  assert.equal(failureText({ message: 'API_KEY=abc' }, 100), 'API_KEY=[REDACTED]');
});

test('no module keeps a redaction of its own', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('redaction.ts'));
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.split\([^)]*\)\.join\(['"]\[(?:REDACTED|redacted)\]['"]\)/, `${file} substitutes secrets by hand`);
    assert.doesNotMatch(text, /'\[REDACTED\]'/, `${file} spells the marker itself`);
  }
});

test('vendor-generated webhook and restricted keys are redacted before their values are registered',()=>{
  for(const token of ['whsec_fixture_signing_value','rkcs_test_fixture_sandbox_value','rk_test_fixture_restricted_value','rk_live_fixture_restricted_value']){
    assert.equal(redact(`generated\n${token}\n`),`generated\n${REDACTED}\n`);
    assert.ok(!failureText(new Error(`failed ${token}`),100).includes(token));
  }
});
