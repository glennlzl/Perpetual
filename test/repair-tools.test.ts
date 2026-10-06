import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairTools, workspacePath } from '../src/repair/tools.ts';
import { brokenRepository, hostBox } from './fixtures/repair-box.ts';

type Output = { ok: boolean; error?: string; [key: string]: unknown };
async function tools(t: TestContext) {
  const source = await mkdtemp(join(tmpdir(), 'perpetual-repair-tools-'));
  const outside = await mkdtemp(join(tmpdir(), 'perpetual-repair-outside-'));
  await brokenRepository(source);
  await writeFile(join(outside, 'secret.txt'), 'outside the workspace\n');
  const made = await hostBox(source);
  t.after(async () => { await made.box.remove(); await rm(source, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const events = { runs: [] as [string, number][], changes: [] as string[] };
  const set = repairTools(made.box, { events: { run: (command, code) => events.runs.push([command, code]), change: path => events.changes.push(path) } });
  const call = async (name: keyof typeof set, input: unknown) => (await (set[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, { toolCallId: 'x', messages: [] })) as Output;
  return { ...made, outside, events, call };
}

test('paths are relative to /workspace, never outside it or in .git', () => {
  assert.deepEqual(workspacePath('src/../add.js'), { path: 'add.js' });
  assert.deepEqual(workspacePath('/workspace/src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(workspacePath(undefined, '.'), { path: '.' });
  for (const value of ['../x', '/etc/passwd', 'a/../../x', '.git/config', 'pkg/.GIT/HEAD', 42, 'a\0b']) assert.ok('error' in workspacePath(value), String(value));
});

test('list, read and grep see the workspace only, capped with a truncated flag', async t => {
  const f = await tools(t);
  const listed = await f.call('list', {});
  assert.deepEqual([listed.ok, listed.entries], [true, ['.github/', 'add.js', 'check.js', 'package.json']], '.git is not listed.');
  const read = await f.call('read', { path: 'check.js', offset: 2, limit: 1 });
  assert.deepEqual([read.content, read.truncated, read.next], ['2\tconst sum = add(2, 3);', true, 3]);
  assert.equal((await f.call('read', { path: 'add.js' })).truncated, false);
  const grep = await f.call('grep', { pattern: 'add\\(', include: '*.js' });
  assert.deepEqual(grep.matches, ['check.js:2:const sum = add(2, 3);', 'check.js:3:if (sum !== 5) { console.error(`Error: add(2, 3) returned ${sum}, expected 5`); process.exit(1); }']);
  assert.match((await f.call('grep', { pattern: '(' })).error ?? '', /The search failed/);
  assert.match((await f.call('read', { path: 'missing.js' })).error ?? '', /not a file/);
});

test('a link cannot lead a tool out of the workspace or into .git', async t => {
  const f = await tools(t);
  await symlink(f.outside, join(f.root, 'out'));
  await symlink(join(f.root, '.git'), join(f.root, 'meta'));
  await symlink(join(f.outside, 'secret.txt'), join(f.root, 'secret-link'));
  for (const [name, input] of [['read', { path: 'out/secret.txt' }], ['read', { path: 'secret-link' }], ['list', { path: 'out' }], ['grep', { pattern: 'outside', path: 'out' }],
    ['write', { path: 'out/new.txt', text: 'x' }], ['edit', { path: 'secret-link', old: 'outside', new: 'inside' }]] as const) {
    assert.match((await f.call(name, input)).error ?? '', /leads outside \/workspace/, `${name} ${JSON.stringify(input)}`);
  }
  assert.match((await f.call('read', { path: 'meta/config' })).error ?? '', /leads into \.git/);
  assert.match((await f.call('write', { path: 'meta/hooks/pre-commit', text: 'x' })).error ?? '', /leads into \.git/);
  assert.match((await f.call('read', { path: '/etc/hosts' })).error ?? '', /outside \/workspace/);
  assert.equal(await readFile(join(f.outside, 'secret.txt'), 'utf8'), 'outside the workspace\n');
  assert.deepEqual(f.events.changes, []);
});

test('edit replaces text that occurs once, write creates folders, and both report the change', async t => {
  const f = await tools(t);
  assert.match((await f.call('edit', { path: 'add.js', old: 'a * b', new: 'x' })).error ?? '', /not found/);
  await writeFile(join(f.root, 'twice.js'), 'x\nx\n');
  assert.match((await f.call('edit', { path: 'twice.js', old: 'x', new: 'y' })).error ?? '', /occurs 2 times/);
  assert.equal((await f.call('edit', { path: 'add.js', old: 'a - b', new: 'a + b' })).ok, true);
  assert.equal(await readFile(join(f.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.equal((await f.call('write', { path: 'docs/notes/fix.md', text: '# Fix\n' })).ok, true);
  assert.equal(await readFile(join(f.root, 'docs/notes/fix.md'), 'utf8'), '# Fix\n');
  await mkdir(join(f.root, 'folder'));
  assert.match((await f.call('write', { path: 'folder', text: 'x' })).error ?? '', /is a folder/);
  assert.deepEqual(f.events.changes, ['add.js', 'docs/notes/fix.md']);
});

// Redaction hides a literal set to a credential-like name, so a reply can show the marker where a string was.
test('edit and write explain the redaction marker, and never put it into a file in place of code', async t => {
  const f = await tools(t);
  const source = 'const token = process.env.TOKEN ?? "fixture-literal-1";\nmodule.exports = token;\n';
  await writeFile(join(f.root, 'auth.js'), source);
  assert.match(String((await f.call('read', { path: 'auth.js' })).content), /const token = process\.env\.TOKEN \?\? \[REDACTED\];/);
  assert.match((await f.call('edit', { path: 'auth.js', old: 'process.env.TOKEN ?? [REDACTED]', new: 'process.env.TOKEN' })).error ?? '', /\[REDACTED\] stands for text the tools hide.*Anchor old on the text around it/);
  assert.match((await f.call('edit', { path: 'auth.js', old: 'module.exports = token;', new: 'module.exports = [REDACTED];' })).error ?? '', /new adds \[REDACTED\]/);
  assert.match((await f.call('write', { path: 'auth.js', text: 'const token = process.env.TOKEN ?? [REDACTED];\nmodule.exports = token;\n' })).error ?? '', /text adds \[REDACTED\]/);
  assert.equal(await readFile(join(f.root, 'auth.js'), 'utf8'), source);
  assert.equal((await f.call('edit', { path: 'auth.js', old: 'const token = process.env.TOKEN', new: 'const token = process.env.AUTH_TOKEN' })).ok, true, 'An edit anchored around the hidden text works.');
  await writeFile(join(f.root, 'mask.js'), "module.exports = () => '[REDACTED]';\n");
  assert.equal((await f.call('write', { path: 'mask.js', text: "module.exports = value => value ? '[REDACTED]' : '';\n" })).ok, true, 'A marker the file already holds may stay.');
});

test('run returns the exit code, the end of a long output from a line start, and stops at its time limit', async t => {
  const f = await tools(t);
  const failing = await f.call('run', { command: 'node check.js' });
  assert.deepEqual([failing.exitCode, failing.timedOut, failing.truncated], [1, false, false]);
  assert.match(String(failing.output), /add\(2, 3\) returned -1, expected 5/);
  // About 200 KB: within the capture, so its last 30 KB are returned whole lines first, marked truncated.
  const long = await f.call('run', { command: 'for i in $(seq 1 20000); do echo "line $i"; done; exit 4' });
  const output = String(long.output);
  assert.deepEqual([long.ok, long.exitCode, long.truncated], [true, 4, true]);
  assert.ok(output.length <= 30_000 && output.length > 29_000, String(output.length));
  assert.match(output, /^line \d+\n/);
  assert.ok(output.endsWith('line 19999\nline 20000\n'));
  const slow = await f.call('run', { command: 'sleep 5', timeoutSeconds: 1 });
  assert.equal(slow.timedOut, true);
  assert.match((await f.call('run', { command: 'true', timeoutSeconds: 901 })).error ?? '', /at most|from 1 to 900/);
  assert.deepEqual(f.events.runs.map(([, code]) => code).slice(0, 2), [1, 4]);
});

test('run redacts its whole capture before it returns the end, so a credential begun before the end stays hidden', async t => {
  // 3000 lines of a key's body: over 30 KB even as markers, so its BEGIN line lies before the end the reply returns.
  const f = await tools(t), body = Array.from({ length: 3000 }, (_, index) => `${String(index).padStart(4, '0')}${'QUJD'.repeat(15)}`).join('\n');
  await writeFile(join(f.root, 'key.txt'), `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ndone\n`);
  const result = await f.call('run', { command: 'cat key.txt' });
  const output = String(result.output);
  assert.deepEqual([result.ok, result.exitCode, result.truncated], [true, 0, true]);
  assert.ok(output.endsWith('[REDACTED]\n[REDACTED]\ndone\n'));
  assert.ok(!output.includes('QUJD'), 'The key\'s body after the returned end\'s start is hidden.');
});

test('run returns the end of an output past its 1 MiB capture, without the line the capture cut, and its exit code', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'test.log'), Array.from({ length: 60_000 }, (_, index) => `test ${String(index + 1).padStart(5, '0')} ${'.'.repeat(12)} ok`).join('\n') + '\n2 failing\n');
  const result = await f.call('run', { command: 'cat test.log; exit 5' });
  const output = String(result.output);
  assert.deepEqual([result.ok, result.exitCode, result.truncated], [true, 5, true]);
  assert.ok(output.length <= 30_000 && output.endsWith('test 60000 ............ ok\n2 failing\n'));
  assert.match(output, /^test \d{5} \.{12} ok\n/, 'The reply starts at a whole line.');
});

// Redaction runs on the controller's event loop: a megabyte that takes minutes would stall every other request.
test('run redacts a megabyte of credential names at once', async t => {
  const f = await tools(t), started = performance.now();
  const result = await f.call('run', { command: 'node -e "process.stdout.write(\'token\'.repeat(209715))"' });
  assert.ok(performance.now() - started < 10_000, `${Math.round(performance.now() - started)} ms`);
  assert.deepEqual([result.ok, result.exitCode, result.truncated, String(result.output).length], [true, 0, true, 30_000]);
});

test('read redacts complete credentials before line numbering and clipping without changing the file', async t => {
  const f = await tools(t);
  const source = `const ready = true;\n-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(600)}\n-----END PRIVATE KEY-----\n`;
  await writeFile(join(f.root, 'config.txt'), source);
  const result = await f.call('read', { path: 'config.txt' });
  assert.equal(result.content, '1\tconst ready = true;\n2\t[REDACTED]\n3\t[REDACTED]\n4\t[REDACTED]');
  assert.equal(result.truncated, false);
  assert.equal(await readFile(join(f.root, 'config.txt'), 'utf8'), source);
});

test('grep redacts a credential before clipping its matched line', async t => {
  const f = await tools(t);
  const prefix = 'x'.repeat(280), key = `AKIA${'A'.repeat(16)}`;
  await writeFile(join(f.root, 'config.txt'), `${prefix} ${key}\n`);
  const result = await f.call('grep', { pattern: 'AKIA', include: '*.txt' });
  assert.deepEqual(result.matches, [`config.txt:1:${prefix} [REDACTED]`]);
});

test('run redacts output while preserving the real exit and reproduction evidence', async t => {
  const f = await tools(t);
  const command = 'cat config.txt; exit 3';
  await writeFile(join(f.root, 'config.txt'), `API_KEY="synthetic-run-value"\nGITHUB=ghp_${'a'.repeat(36)}\nordinary diagnostic\n`);
  const result = await f.call('run', { command });
  assert.equal(result.output, 'API_KEY=[REDACTED]\nGITHUB=[REDACTED]\nordinary diagnostic\n');
  assert.deepEqual([result.exitCode, result.timedOut, result.truncated], [3, false, false]);
  assert.deepEqual(f.events.runs, [[command, 3]]);
});

test('tool replies redact filenames and refused paths but internal file operations use their exact paths', async t => {
  const f = await tools(t), name = 'ghp_syntheticfilename0123456789.txt';
  const contents = 'API_KEY="synthetic-file-value"\n';
  assert.equal((await f.call('write', { path: name, text: contents })).path, '[REDACTED].txt');
  assert.equal(await readFile(join(f.root, name), 'utf8'), contents, 'Writes keep the original bytes for later change validation.');
  const listed = await f.call('list', {});
  assert.ok(Array.isArray(listed.entries) && listed.entries.includes('[REDACTED].txt'));
  const read = await f.call('read', { path: name });
  assert.equal(read.path, '[REDACTED].txt');
  assert.equal(read.content, '1\tAPI_KEY=[REDACTED]');
  assert.deepEqual((await f.call('grep', { pattern: 'synthetic-file-value', include: '*.txt' })).matches, ['[REDACTED].txt:1:API_KEY=[REDACTED]']);
  const refused = await f.call('read', { path: `../${name}` });
  assert.ok(!refused.error?.includes('ghp_'));
  assert.match(refused.error ?? '', /\[REDACTED\]/);
});

// A file over read's bound, a search output over grep's, and a run output that is one line longer than run's capture,
// whose start the box cut.
test('tools withhold a capture already truncated by the box and preserve its execution evidence', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'large.txt'), 'unredactable-fragment'.repeat(60_000));
  for (const [name, input] of [
    ['read', { path: 'large.txt' }],
    ['grep', { pattern: 'fragment', include: 'large.txt' }],
    ['run', { command: 'cat large.txt; exit 7' }],
  ] as const) await t.test(name, async () => {
    const result = await f.call(name, input);
    assert.deepEqual([result.ok, result.exitCode, result.timedOut, result.truncated], [false, name === 'run' ? 7 : 0, false, true]);
    assert.match(result.error ?? '', /observation unavailable/i);
    assert.match(result.error ?? '', /narrow/i);
    assert.ok(!JSON.stringify(result).includes('unredactable-fragment'), 'An unknown prefix or suffix is never treated as redacted text.');
  });
});

test('read offsets and grep matches redact a PEM using the complete file context', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'config.txt'), `before\n-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(20)}\n-----END PRIVATE KEY-----\nafter\n`);
  const read = await f.call('read', { path: 'config.txt', offset: 3, limit: 1 });
  assert.deepEqual([read.content, read.truncated, read.next], ['3\t[REDACTED]', true, 4]);
  assert.deepEqual((await f.call('grep', { pattern: '^QUJD', include: 'config.txt' })).matches, ['config.txt:3:[REDACTED]']);
  assert.equal((await f.call('read', { path: 'config.txt', offset: 5, limit: 1 })).content, '5\tafter');
});

test('multiline credential redaction preserves later read offsets and grep line numbers', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'config.txt'), 'before\nPASSWORD="synthetic first\nsynthetic second"\nafter\n');
  for (const [name, input] of [
    ['read', { path: 'config.txt', offset: 4, limit: 1 }],
    ['grep', { pattern: 'after', include: 'config.txt' }],
  ] as const) await t.test(name, async () => {
    const result = await f.call(name, input);
    assert.equal(result.ok, true);
    if (name === 'read') assert.equal(result.content, '4\tafter');
    else assert.deepEqual(result.matches, ['config.txt:4:after']);
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  });
  assert.equal((await f.call('read', { path: 'config.txt', offset: 2, limit: 2 })).content, '2\tPASSWORD=[REDACTED]\n3\t[REDACTED]');
});

// An ordinary sign-in module, holding no credential: what follows token, secret or password there is an expression or
// a type, which the agent reads, finds and changes as written.
const AUTH = [
  "import { getToken, sign } from './tokens';",
  'export interface Session { token: string; secret: string }',
  'export async function login(username: string, password: string): Promise<Session> {',
  '  const token = getToken(username);',
  '  return { token, secret: sign(token, password) };',
  '}',
  '',
].join('\n');

test('ordinary auth code reads, greps and runs as written, and a line read can be edited as shown', async t => {
  const f = await tools(t);
  await mkdir(join(f.root, 'src'));
  await writeFile(join(f.root, 'src/auth.ts'), AUTH);
  const read = await f.call('read', { path: 'src/auth.ts' });
  assert.equal(read.content, AUTH.trimEnd().split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'));
  assert.deepEqual((await f.call('grep', { pattern: 'getToken\\(username', include: '*.ts' })).matches, ['src/auth.ts:4:  const token = getToken(username);']);
  assert.equal((await f.call('run', { command: 'cat src/auth.ts' })).output, AUTH);
  const diagnostic = "src/auth.ts(5,12): error TS2741: Property 'secret' is missing in type '{ token: string; }' but required in type 'Session'.";
  assert.equal((await f.call('run', { command: `printf '%s\\n' "${diagnostic}"; exit 2` })).output, `${diagnostic}\n`, 'A type checker\'s diagnostic reads as it printed it.');
  const line = String((await f.call('read', { path: 'src/auth.ts', offset: 4, limit: 1 })).content).split('\t')[1];
  assert.equal((await f.call('edit', { path: 'src/auth.ts', old: line, new: '  const token = await getToken(username);' })).ok, true);
  assert.equal(await readFile(join(f.root, 'src/auth.ts'), 'utf8'), AUTH.replace('getToken(username)', 'await getToken(username)'));
});

test('tool replies still hide token shapes, key blocks, quoted literals and URL passwords in code', async t => {
  const f = await tools(t);
  const token = `ghp_${'b'.repeat(36)}`;
  await writeFile(join(f.root, 'config.ts'), [
    `export const apiKey = "fixture-literal-1";`, `export const github = '${token}';`, 'export const url = "postgres://app:fixture-literal@db.example.test/app";',
    'export const pem = `-----BEGIN PRIVATE KEY-----', 'QUJDRA==', '-----END PRIVATE KEY-----`;', 'export const password = process.env.PASSWORD;', '',
  ].join('\n'));
  const read = await f.call('read', { path: 'config.ts' });
  assert.equal(read.content, ['1\texport const apiKey = [REDACTED];', '2\texport const github = \'[REDACTED]\';', '3\texport const url = "postgres://[REDACTED]@db.example.test/app";',
    '4\texport const pem = `[REDACTED]', '5\t[REDACTED]', '6\t[REDACTED]`;', '7\texport const password = process.env.PASSWORD;'].join('\n'));
  const run = await f.call('run', { command: 'cat config.ts' });
  for (const secret of ['fixture-literal', token, 'QUJDRA']) assert.ok(!JSON.stringify([read, run]).includes(secret), secret);
});

test('a small selected line does not bypass the complete-file observation limit', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'large.txt'), `needle\n${'x\n'.repeat(140_000)}`);
  const read = await f.call('read', { path: 'large.txt', offset: 1, limit: 1 });
  assert.deepEqual([read.ok, read.truncated], [false, true]);
  assert.match(read.error ?? '', /observation unavailable/i);
  const grep = await f.call('grep', { pattern: '^needle$', include: 'large.txt' });
  assert.deepEqual([grep.ok, grep.matches, grep.skipped], [true, [], ['large.txt is over 256 KB.']], 'grep names the file it cannot show, and shows none of it.');
});

test('grep names a matched file it cannot show completely and still answers from the others', async t => {
  const f = await tools(t);
  await writeFile(join(f.root, 'package-lock.json'), `{\n  "typescript": "5.6.3",\n${'  "padding": "x",\n'.repeat(20_000)}}\n`);
  await writeFile(join(f.root, 'package.json'), '{ "devDependencies": { "typescript": "5.6.3" } }\n');
  const result = await f.call('grep', { pattern: 'typescript' });
  assert.deepEqual([result.ok, result.matches, result.skipped], [true, ['package.json:1:{ "devDependencies": { "typescript": "5.6.3" } }'], ['package-lock.json is over 256 KB.']]);
});

test('grep refuses a file changed after its native match was observed', async t => {
  const f = await tools(t), file = join(f.root, 'race.txt');
  await writeFile(file, 'original match\n');
  const exec = f.box.exec;
  f.box.exec = async (argv, options) => {
    const result = await exec(argv, options);
    if (argv[0] === 'grep') await writeFile(file, 'different line\n');
    return result;
  };
  const result = await f.call('grep', { pattern: 'original', include: 'race.txt' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /changed/i);
  assert.equal(result.matches, undefined);
});

test('grep rechecks matched file ownership before reading its complete contents', async t => {
  const f = await tools(t), file = join(f.root, 'race.txt');
  await writeFile(file, 'original match\n');
  const exec = f.box.exec;
  f.box.exec = async (argv, options) => {
    const result = await exec(argv, options);
    if (argv[0] === 'grep') { await rm(file); await symlink(join(f.outside, 'secret.txt'), file); }
    return result;
  };
  const result = await f.call('grep', { pattern: 'original', include: 'race.txt' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /outside \/workspace/);
  assert.equal(result.matches, undefined);
});

test('grep retains native ERE order and match limits while reading each matched file only once', async t => {
  const f = await tools(t), file = join(f.root, 'numbers.txt');
  await writeFile(file, Array.from({ length: 101 }, (_, index) => `match ${index + 1}`).join('\n') + '\n');
  const result = await f.call('grep', { pattern: '^match [[:digit:]]{1,3}$', include: 'numbers.txt' });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.matches, Array.from({ length: 100 }, (_, index) => `numbers.txt:${index + 1}:match ${index + 1}`));
  const contents = f.outputs.filter(output => output.startsWith('match 1\n'));
  assert.equal(contents.length, 1, 'One bounded file observation supports every matching line.');
});
