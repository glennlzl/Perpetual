import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorTwinConfig, inputAvailabilityContext } from '../src/twin/authoring.ts';
import type { AuthoringOptions } from '../src/twin/authoring.ts';
import { evidenceText, repositoryFacts } from '../src/environments/evidence.ts';
import { REDACTED } from '../src/redaction.ts';
import { scriptedLoopHarness } from './fixtures/scripted-model.ts';

const KEY = 'sk-or-v1-fixture-author-observation-7310';
const DRAFT = '{ "services": { "payments": {} }, "apps": { "web": { "start": "node app.mjs", "port": 3000, "env": { "SESSION_SECRET": "fixture-secret-value", "PAYMENTS_KEY": "{{payments.PAYMENTS_KEY}}" } } } }\n';
const PEM = '-----BEGIN PRIVATE KEY-----\nfixture-key-body-7310\n-----END PRIVATE KEY-----';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-author-')));
  const source = join(root, 'source'), workspace = join(root, 'workspace');
  await mkdir(source); await mkdir(workspace, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workspace, source, draft: DRAFT, evidence: '# Repository evidence\n', apiKey: KEY, model: 'fixture/model',
    env: { PATH: process.env.PATH, HOME: join(root, 'home') }, cleanupGraceMs: 1000 } satisfies AuthoringOptions;
  return { source, workspace, options };
}

// This adapter reads the same real project files OpenCode reads directly; no model or network is used.
const rewriteDraft = { command: process.execPath, args: ['-e', 'const fs = require("node:fs"); fs.writeFileSync("twin.json", fs.readFileSync("twin.json"));'] };

test('the author reads a redacted source copy and feedback while the application source and editable draft keep their bytes', async t => {
  const f = await fixture(t);
  const source = `const api = "${KEY}";\nconst certificate = \`${PEM}\`;\nexport const port = process.env.PORT;\n`;
  await writeFile(join(f.source, 'app.mjs'), source);
  const observed: string[] = [];
  let draft = '';
  const result = await authorTwinConfig({ ...f.options, evidence: `# Evidence\n${PEM}\n`, feedback: `Provider refused ${KEY}`, harness: ({ cwd }) => {
    for (const file of ['repo/app.mjs', 'EVIDENCE.md', 'feedback.md']) observed.push(readFileSync(join(cwd, file), 'utf8'));
    draft = readFileSync(join(cwd, 'twin.json'), 'utf8');
    return rewriteDraft;
  } }).promise;
  assert.equal(result.text, DRAFT, 'Writing the same draft still counts, without normalizing or redacting its literals.');
  assert.equal(draft, DRAFT);
  assert.equal(await readFile(join(f.source, 'app.mjs'), 'utf8'), source, 'Actual application code is untouched.');
  for (const text of observed) {
    assert.ok(!text.includes(KEY) && !text.includes('fixture-key-body-7310'), 'No credential reaches the author-readable project.');
    assert.ok(text.includes(REDACTED));
  }
  assert.equal(observed[0].split('\n').length, source.split('\n').length, 'Evidence line numbers still locate source.');
  assert.match(observed[0], /export const port = process\.env\.PORT/);
});

test('the author reads EVIDENCE.md as the controller formatted it, credential-named variables with the lines that read them', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { start: 'node app.mjs' } }));
  await writeFile(join(f.source, 'app.mjs'), 'const secret = process.env.SESSION_SECRET;\nconst key = process.env.INTERNAL_API_KEY;\nconst header = process.env.HTTP_AUTHORIZATION;\n');
  const draft = JSON.stringify({ apps: { web: { start: 'node app.mjs', port: 3000 } } });
  const evidence = evidenceText(await repositoryFacts({ source: f.source, draft }), draft);
  assert.match(evidence, /^- SESSION_SECRET: `app\.mjs:1`$/m);
  assert.match(evidence, /^- INTERNAL_API_KEY: runtime, `app\.mjs:2`$/m);
  // A name ending in AUTHORIZATION labels its line too, rather than starting an Authorization header.
  assert.match(evidence, /^- HTTP_AUTHORIZATION: runtime, `app\.mjs:3`$/m);
  let observed = '';
  const result = await authorTwinConfig({ ...f.options, draft, evidence, harness: ({ cwd }) => {
    observed = readFileSync(join(cwd, 'EVIDENCE.md'), 'utf8');
    return rewriteDraft;
  } }).promise;
  assert.equal(result.text, draft);
  assert.equal(observed, `${evidence}\n\n${inputAvailabilityContext()}`);
});

test('a short supplied value, such as a local model server placeholder key, is not a secret to the author', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'style.css'), '.hidden { display: none; }\n');
  await writeFile(join(f.source, 'nonempty.js'), 'export const value = 1;\n');
  const draft = JSON.stringify({ apps: { web: { start: 'node app.mjs', port: 3000, env: { ADMIN_EMAIL: 'owner@example.test' } } } });
  let files: string[] = [], style = '';
  const result = await authorTwinConfig({ ...f.options, draft, secrets: ['none', 'test'], harness: ({ cwd }) => {
    files = readdirSync(join(cwd, 'repo')).sort();
    style = readFileSync(join(cwd, 'repo/style.css'), 'utf8');
    return rewriteDraft;
  } }).promise;
  assert.equal(result.text, draft, 'A draft with the documented account address is no credential literal.');
  assert.deepEqual(files, ['nonempty.js', 'style.css']);
  assert.equal(style, '.hidden { display: none; }\n');
});

test('a credential-bearing draft is refused before the author starts, preserving its text', async t => {
  const f = await fixture(t);
  const draft = JSON.stringify({ services: {}, apps: { web: { start: 'node app.mjs', port: 3000, env: { VALUE: KEY } } } });
  let started = false;
  const result = await authorTwinConfig({ ...f.options, draft, harness: () => { started = true; return rewriteDraft; } }).promise;
  assert.equal(started, false, 'Credentials in a draft must not enter a model workspace.');
  assert.equal(result.text, undefined);
  assert.match(result.error!, /credential/i);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(draft, JSON.stringify({ services: {}, apps: { web: { start: 'node app.mjs', port: 3000, env: { VALUE: KEY } } } }));
});

test('encoded URL passwords and shadowed JSON credentials never reach either author harness', async t => {
  for (const [name, draft] of [
    ['encoded URL', '{"value":"postgres://user:fixture%40password@db/app"}'],
    ['duplicate member', '{"value":"ghp_\\u0066ixture_value","value":"ordinary"}'],
    ['unfinished string', '{"value":"ghp_\\u0066ixture_value'],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    let started = false;
    const result = await authorTwinConfig({ ...f.options, draft, harness: () => { started = true; return rewriteDraft; } }).promise;
    assert.equal(started, false);
    assert.equal(result.text, undefined);
    assert.match(result.error!, /credential literal/);
  });
});

test('a credential literal written by an author is refused instead of becoming an executable config', async t => {
  const f = await fixture(t);
  const credential = 'user-supplied-value-7310';
  const output = JSON.stringify({ services: {}, apps: { web: { start: 'node app.mjs', port: 3000, env: { VALUE: credential } } } });
  const result = await authorTwinConfig({ ...f.options, secrets: [credential], harness: () => ({ command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync("twin.json", process.argv[1]);', output] }) }).promise;
  assert.equal(result.text, undefined, 'The caller must keep its previous draft, not run or save this output.');
  assert.match(result.error!, /credential/i);
  assert.ok(!JSON.stringify(result).includes(credential));
});

test('supplied values in native-author facts are hidden before unwired metadata reaches the model', async t => {
  const f = await fixture(t);
  const supplied = 'user-supplied-value-7310';
  const facts = { packages: [{ directory: '.', name: supplied, dependencies: [] }],
    reads: [{ name: supplied, file: `src/${supplied}.ts`, line: 1, role: 'runtime' as const }], functions: [], examples: { [supplied]: `examples/${supplied}` } };
  const original = structuredClone(facts);
  const script = join(f.workspace, 'script.json'), calls = join(f.workspace, 'calls.jsonl');
  await writeFile(script, JSON.stringify([{ calls: [{ tool: 'write_config', input: { text: DRAFT } }] }, { text: 'Done.' }]));
  const result = await authorTwinConfig({ ...f.options, facts, secrets: [supplied], harness: scriptedLoopHarness(script, calls) }).promise;
  assert.equal(result.text, DRAFT);
  const received = await readFile(calls, 'utf8');
  assert.ok(!received.includes(supplied), 'Private facts must not leak through unwired tool results.');
  assert.ok(received.includes(REDACTED));
  assert.deepEqual(facts, original, 'Controller facts stay structurally and byte-for-byte unchanged.');
});

test('the author copy omits links, credential-bearing paths and binary contents without altering the execution source', async t => {
  const f = await fixture(t), supplied = 'user-supplied-value-7310';
  const binary = Buffer.from(`\u0000opaque ${supplied}`);
  await writeFile(join(f.source, 'asset.bin'), binary);
  await writeFile(join(f.source, `${supplied}.ts`), 'export const value = 1;');
  await writeFile(join(f.workspace, 'private.txt'), supplied);
  await symlink(join(f.workspace, 'private.txt'), join(f.source, 'linked.txt'));
  let files: string[] = [], contents = '';
  const result = await authorTwinConfig({ ...f.options, secrets: [supplied], harness: ({ cwd }) => {
    files = readdirSync(join(cwd, 'repo'));
    contents = readFileSync(join(cwd, 'repo', 'asset.bin'), 'utf8');
    return rewriteDraft;
  } }).promise;
  assert.equal(result.text, DRAFT);
  assert.deepEqual(files, ['asset.bin']);
  assert.match(contents, /binary.*omitted/i);
  assert.ok(!contents.includes(supplied));
  assert.deepEqual(await readFile(join(f.source, 'asset.bin')), binary);
  assert.equal(await readFile(join(f.source, `${supplied}.ts`), 'utf8'), 'export const value = 1;');
  assert.equal(await readFile(join(f.source, 'linked.txt'), 'utf8'), supplied);
});

test('refusing an author change outside twin.json hides credential text in the changed path', async t => {
  const f = await fixture(t);
  const result = await authorTwinConfig({ ...f.options, harness: () => ({ command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "changed");', `${KEY}.txt`] }) }).promise;
  assert.match(result.error!, /Only twin\.json may change/);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(result.error?.includes(REDACTED));
  assert.equal(await readFile(join(f.workspace, 'project', 'twin.json'), 'utf8'), DRAFT);
});

test('a supplied multiline value in the author source copy preserves later evidence line numbers', async t => {
  const f = await fixture(t), supplied = 'fixture first line\nfixture second line';
  const source = `const configured = \`${supplied}\`;\nexport const port = process.env.PORT;\n`;
  await writeFile(join(f.source, 'app.mjs'), source);
  let observed = '';
  const result = await authorTwinConfig({ ...f.options, secrets: [supplied], harness: ({ cwd }) => {
    observed = readFileSync(join(cwd, 'repo/app.mjs'), 'utf8');
    return rewriteDraft;
  } }).promise;
  assert.equal(result.text, DRAFT);
  assert.equal(observed.split('\n')[2], 'export const port = process.env.PORT;');
  assert.ok(!observed.includes('fixture first line') && !observed.includes('fixture second line'));
  assert.equal(await readFile(join(f.source, 'app.mjs'), 'utf8'), source);
});

test('a malformed draft with an escaped credential stays private while ordinary incomplete drafts remain editable', async t => {
  const f = await fixture(t);
  const draft = '{"value":"ghp_\\u0066ixture_value",';
  let started = false;
  const result = await authorTwinConfig({ ...f.options, draft, harness: () => { started = true; return rewriteDraft; } }).promise;
  assert.equal(started, false);
  assert.match(result.error!, /credential literal/);
  assert.equal(result.text, undefined);
  const safe = await authorTwinConfig({ ...f.options, draft: '{ "services": ', harness: () => rewriteDraft }).promise;
  assert.equal(safe.text, '{ "services": ', 'The author can still repair an incomplete config.');
});
