import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { configEvidence, CONFIG_EVIDENCE_LIMITS } from '../src/twin/config-evidence.ts';
import { repositoryFacts, evidenceText, workFacts } from '../src/environments/evidence.ts';

async function fixture(t: TestContext, files: Record<string, string | Buffer>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-config-evidence-'))), source = join(root, 'source');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), content);
  }
  return { root, source };
}
const draft = JSON.stringify({ services: {}, apps: { web: { directory: 'web', start: 'npm run start', port: 3000, env: {} } }, fixtures: [] });

test('collects real manifests, runtime variable and callback snippets and SQL without changing the source', async t => {
  const callback = `${'// earlier code\n'.repeat(100)}export function finish(request) {\n  return Response.redirect(new URL('/complete', request.url));\n}\n`;
  const files = {
    'package.json': JSON.stringify({ name: 'workspace', scripts: { setup: 'node scripts/setup.mjs' }, workspaces: ['web'] }),
    'web/package.json': JSON.stringify({ name: 'web', scripts: { start: 'node server.js' } }),
    'web/server.js': 'const endpoint = process.env.WEB_API_URL;\nfetch(endpoint);\n',
    'web/return.js': callback,
    'db/seed.sql': 'insert into products (name) values (\'example\');',
    'runtime/config.toml': 'port = 3000\n',
  };
  const { source } = await fixture(t, files);
  const facts = await repositoryFacts({ source, draft });
  const evidence = evidenceText(facts, draft) + '\n## Runtime config\n`runtime/config.toml`\n';
  const packet = await configEvidence({ source, draft, facts: workFacts(facts)!, evidence });
  assert.match(packet.text, /node server\.js/);
  assert.match(packet.text, /scripts\/setup\.mjs/);
  assert.match(packet.text, /process\.env\.WEB_API_URL/);
  assert.match(packet.text, /102:.*Response\.redirect\(new URL\('\/complete', request\.url\)\)/);
  assert.match(packet.text, /insert into products/);
  assert.match(packet.text, /port = 3000/);
  assert.match(packet.text, /not an exhaustive callback or dependency inventory/);
  assert.ok(Buffer.byteLength(packet.text) <= CONFIG_EVIDENCE_LIMITS.bytes);
  for (const [file, content] of Object.entries(files)) assert.equal(await readFile(join(source, file), 'utf8'), content);
});

test('redacts complete known and multiline secrets before selecting or clipping source lines', async t => {
  const opaque = `unshaped-secret-value-${'q'.repeat(4500)}`;
  const multiline = 'opaque-multiline-one\nopaque-multiline-two';
  const pem = '-----BEGIN PRIVATE KEY-----\nnever-include-private-key-body\n-----END PRIVATE KEY-----';
  const sourceCode = `const value = '${opaque}';\n${pem}\nconst password = \`private-line-one\nprivate-line-two\`;\nconsole.log('after');\n`;
  const { source } = await fixture(t, {
    'app.js': sourceCode,
    'package.json': JSON.stringify({ name: 'web', scripts: { start: `node app.js ${opaque}`, setup: pem, check: multiline } }),
    'config.yml': 'API_KEY: short\n',
  });
  const packet = await configEvidence({ source, draft: '{}', evidence: '`app.js:3`\n`config.yml`\n' + opaque, secrets: [opaque, multiline] });
  for (const secret of ['unshaped-secret-value-', 'never-include-private-key-body', 'private-line-one', 'private-line-two', 'opaque-multiline-one', 'opaque-multiline-two', 'short']) assert.ok(!packet.text.includes(secret), secret);
  assert.match(packet.text, /\[REDACTED\]/);
  assert.match(packet.text, /7: console\.log\('after'\)/);
});

test('refuses traversal, private files, symlinked files and symlinked ancestor directories', async t => {
  const { root, source } = await fixture(t, {
    '.env': 'PRIVATE_ENV_DO_NOT_READ=yes',
    '.ssh/settings.txt': 'PRIVATE_FOLDER_DO_NOT_READ',
    'visible.js': 'ONLY_VISIBLE_SOURCE',
  });
  await writeFile(join(root, 'outside.js'), 'OUTSIDE_CONTENT_DO_NOT_READ');
  await symlink(join(root, 'outside.js'), join(source, 'out.js'));
  await symlink(join(source, 'visible.js'), join(source, 'inside.js'));
  await symlink(root, join(source, 'linked'));
  const evidence = ['../outside.js', 'sub/../../outside.js', '/tmp/outside.js', '.env', '.ssh/settings.txt', 'out.js', 'inside.js', 'linked/outside.js', 'visible.js'].map(path => `\`${path}:1\``).join('\n');
  const result = await configEvidence({ source, draft: '{}', evidence });
  assert.match(result.text, /ONLY_VISIBLE_SOURCE/);
  assert.doesNotMatch(result.text, /OUTSIDE_CONTENT_DO_NOT_READ|PRIVATE_ENV_DO_NOT_READ|PRIVATE_FOLDER_DO_NOT_READ/);
  assert.ok(result.truncated);
  assert.match(result.text, /File omitted/);
});

test('rejects binary and oversized files without reading clipped secret prefixes', async t => {
  const { source } = await fixture(t, {
    'binary.txt': Buffer.from([0xff, 0x00, 0x10]),
    'oversized.js': `const secret = '${'x'.repeat(CONFIG_EVIDENCE_LIMITS.fileBytes)}';`,
    'okay.js': 'VISIBLE_CONTENT',
  });
  const result = await configEvidence({ source, draft: '{}', evidence: '`binary.txt`\n`oversized.js`\n`okay.js`' });
  assert.match(result.text, /VISIBLE_CONTENT/);
  assert.doesNotMatch(result.text, /x{10}|\ufffd/);
  assert.ok(result.truncated);
});

test('keeps launch scripts when a minified package manifest has a large dependency list before them', async t => {
  const dependencies = Object.fromEntries(Array.from({ length: 600 }, (_, n) => [`module-${n}`, '1.0.0']));
  const { source } = await fixture(t, { 'package.json': JSON.stringify({ dependencies, scripts: { start: 'node launch.mjs', build: 'node compile.mjs' } }) });
  const result = await configEvidence({ source, draft: '{}', evidence: '' });
  assert.match(result.text, /node launch\.mjs/);
  assert.match(result.text, /node compile\.mjs/);
  assert.ok(result.truncated);
});

test('caps a large packet, retains later summary categories and reports incomplete evidence', async t => {
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, n) => [`src/file-${n}.js`, 'const publicValue = "漢字";\n'.repeat(500)]));
  const { source } = await fixture(t, files);
  const evidence = ['## Variables', 'unwired '.repeat(3000), ...Object.keys(files).map(file => `\`${file}:400\``), '## Setup commands', 'npm run initialize', '## SQL files', '`db/seed.sql`'].join('\n');
  const result = await configEvidence({ source, draft: '{}', evidence });
  assert.ok(Buffer.byteLength(result.text) <= CONFIG_EVIDENCE_LIMITS.bytes);
  assert.match(result.text, /npm run initialize/);
  assert.match(result.text, /## SQL files/);
  assert.match(result.text, /Evidence omitted/);
  assert.doesNotMatch(result.text, /\ufffd/);
  assert.ok(result.truncated);
});

test('propagates cancellation before and during read-only collection', async t => {
  const { source } = await fixture(t, { 'package.json': '{}', 'src/app.js': 'const port = 3000;' });
  await assert.rejects(configEvidence({ source, draft: '{}', evidence: '', signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController();
  const collecting = configEvidence({ source, draft: '{}', evidence: '`src/app.js:1`', signal: controller.signal });
  controller.abort();
  await assert.rejects(collecting, { name: 'AbortError' });
});


test('returns explicit incomplete evidence when its local collection deadline expires', async t => {
  const { source } = await fixture(t, { 'app.js': 'SHOULD_NOT_READ_AFTER_DEADLINE' });
  let calls = 0;
  t.mock.method(performance, 'now', () => calls++ === 0 ? 0 : CONFIG_EVIDENCE_LIMITS.timeoutMs + 1);
  const result = await configEvidence({ source, draft: '{}', evidence: '`app.js:1`' });
  assert.ok(result.truncated);
  assert.match(result.text, /Evidence omitted/);
  assert.doesNotMatch(result.text, /SHOULD_NOT_READ_AFTER_DEADLINE/);
});
