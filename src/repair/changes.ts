// Change rules a repair's diff meets before every push, without a model. A rejection fails the attempt and its reason
// goes back to the agent; a hold is allowed but keeps the pull request for a person (phase 3 turns auto-merge off). CI
// and deploy configuration are rejected, not held: a pushed branch runs its own workflows with the repository's secrets,
// and deploy previews build from its configuration, before any person looks. What judges a fix (its tests, and the
// configuration and scripts that decide how CI tests, lints and type-checks the code) is held: humans keep the judges.
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { hasCredential } from '../redaction.ts';

/** credentials names where credential text was added, as path:line of the new file, never the text. */
export interface ChangeCheck { paths: string[]; added: number; removed: number; rejected: string[]; holds: string[]; credentials: string[] }

/** Changed lines beyond which a change is held for a person. */
export const SIZE_LIMIT = 400;
export const REJECTED = {
  credential: 'The change adds text that looks like a credential. Remove it; a repair never adds secrets.',
  path: 'The change touches .git or a path outside the repository. Change files inside the repository only.',
  submodule: 'The change adds or moves a submodule. Change files inside the repository only.',
  delivery: 'The change touches CI or deployment configuration. A repair changes the code that fails, never how it is built or deployed.',
};
export const HELD = {
  tests: 'The change touches tests.',
  checks: 'The change touches test, lint or type configuration, or the scripts that run them.',
  size: `The change is larger than ${SIZE_LIMIT} lines.`,
};
// Tests in the usual layouts, folder names read without case: test/, Tests/, spec/, __tests__/, __snapshots__/,
// __mocks__/, e2e/, cypress/, testdata/, androidTest/ or Acme.Tests/; files such as add.test.ts, login.cy.ts,
// server_test.go, test_add.py, conftest.py or user_spec.rb; and PascalCase test projects and classes, such as
// AcmeTests/, UserServiceTest.java, FooTests.cs or LoginSpec.scala.
const TEST_FOLDER = /^(?:tests?|spec|__tests__|__snapshots__|__mocks__|__fixtures__|e2e|cypress|testdata|androidtest|testfixtures|.+[._-](?:tests?|specs?))$/i;
const TEST_FILE = /[._-](?:tests?|specs?)\.[^/]+$|\.cy\.[^/]+$|\.snap$|^(?:tests?|conftest)\.[^/]+$|^test_[^/]+$/i;
const TEST_NAME = /[a-z\d](?:Tests?|Specs?|IT)$/;
// Configuration that decides how CI checks the code: test runners, linters, formatters, type checkers, coverage, npm's
// own configuration (which can change how scripts run) and the make files CI commands call.
const CHECK_FILES = new Set([
  'pytest.ini', 'tox.ini', 'noxfile.py', 'setup.cfg', 'mypy.ini', '.mypy.ini', 'pyrightconfig.json', 'ruff.toml', '.ruff.toml', '.flake8', '.pylintrc', 'pylintrc', '.coveragerc',
  '.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json', '.rubocop.yml', '.rspec', 'phpunit.xml', 'phpunit.xml.dist', 'phpstan.neon', 'phpstan.neon.dist', 'psalm.xml',
  'clippy.toml', '.clippy.toml', 'rustfmt.toml', '.rustfmt.toml', '.swiftlint.yml', 'biome.json', 'biome.jsonc', '.eslintignore', '.prettierignore', 'codecov.yml', '.codecov.yml',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml', 'Taskfile.yaml',
]);
// The same with any extension, such as jest.config.ts, .eslintrc.cjs or tsconfig.build.json.
const CHECK_CONFIG = /^(?:(?:jest|vitest|vite|playwright|cypress|karma|ava|wdio|eslint|prettier|stylelint)\.config|vitest\.workspace|karma\.conf|[jt]sconfig|\.(?:eslintrc|prettierrc|stylelintrc|mocharc|nycrc|c8rc))(?:\.[\w-]+)*$/;
const isTest = (path: string) => {
  const parts = path.split('/'), name = parts.pop() ?? '';
  return parts.some(part => TEST_FOLDER.test(part) || TEST_NAME.test(part)) || TEST_FILE.test(name) || CODE.test(name) && TEST_NAME.test(name.replace(/\.[^.]*$/, ''));
};
const isCheckConfig = (path: string) => { const name = posix.basename(path); return CHECK_FILES.has(name) || CHECK_CONFIG.test(name); };
// What a manifest says about how its package is checked, beside its dependencies: package.json's scripts, workspaces and
// the check tools it configures, pyproject.toml's check tools and task runners, and Cargo.toml's lints.
const PYTHON_TOOLS = [['pytest'], ['mypy'], ['pyright'], ['basedpyright'], ['ruff'], ['black'], ['isort'], ['pylint'], ['flake8'], ['coverage'], ['tox'], ['nox'], ['poe'], ['hatch', 'envs'], ['pdm', 'scripts']];
const MANIFEST_CHECKS = new Map<string, { parse(text: string): unknown; checks: string[][] }>([
  ['package.json', { parse: JSON.parse, checks: [['scripts'], ['workspaces'], ['jest'], ['eslintConfig'], ['prettier'], ['stylelint'], ['ava'], ['mocha'], ['nyc'], ['c8']] }],
  ['pyproject.toml', { parse: parseToml, checks: PYTHON_TOOLS.map(keys => ['tool', ...keys]) }],
  ['Cargo.toml', { parse: parseToml, checks: [['lints'], ['workspace', 'lints']] }],
]);
/** The manifest names whose two versions manifestChecksChanged compares. */
export const MANIFESTS: ReadonlySet<string> = new Set(MANIFEST_CHECKS.keys());
const valueAt = (value: unknown, keys: readonly string[]) => keys.reduce<unknown>((item, key) => item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>)[key] : undefined, value);

/**
 * Whether a change of a manifest changed how its package is checked, from its text at the failing commit and after the
 * change (null when absent there): a removed manifest did, an added one did not, and one that does not parse did.
 */
export function manifestChecksChanged(path: string, before: string | null, after: string | null) {
  const manifest = MANIFEST_CHECKS.get(posix.basename(path));
  if (!manifest || before === null) return false;
  if (after === null) return true;
  const read = (text: string): { value: unknown } | null => { try { return { value: manifest.parse(text) }; } catch { return null; } };
  const old = read(before), now = read(after);
  return !old || !now || manifest.checks.some(keys => !isDeepStrictEqual(valueAt(old.value, keys), valueAt(now.value, keys)));
}
// Source code, where an unquoted value is an expression rather than a literal.
const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kts?|scala|groovy|gradle|rs|php|cs|fs|swift|dart|exs?|erl|clj|lua|pl|r|jl|vue|svelte|c|h|cc|cpp|hpp|m|mm)$/i;

/** A path git names in a diff header: C-quoted when it has special characters, and relative to the repository. */
function unquote(value: string) {
  if (!value.startsWith('"')) return value.replace(/\t$/, '');
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  const bytes: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') break;
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue; }
    const next = value[index + 1];
    // A quoted path cut off after its backslash, which git never writes, keeps the backslash.
    if (next === undefined) { bytes.push(0x5c); break; }
    if (/[0-7]/.test(next)) { bytes.push(parseInt(value.slice(index + 1, index + 4), 8)); index += 3; }
    else { bytes.push(...Buffer.from(escapes[next] ?? next)); index += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}
const prefixed = (value: string, prefix: string) => { const path = unquote(value); return path.startsWith(prefix) ? path.slice(prefix.length) : null; };

/** The two paths of a `diff --git a/X b/Y` header; without renames both name the same file. */
function headerPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const split = /^("(?:[^"\\]|\\.)*")\s+(.+)$/.exec(rest);
    return split ? [prefixed(split[1], 'a/'), prefixed(split[2], 'b/')].filter((path): path is string => path !== null) : [rest];
  }
  const length = (rest.length - 5) / 2, path = rest.slice(2, 2 + length);
  return Number.isInteger(length) && rest === `a/${path} b/${path}` ? [path] : [rest];
}

/** A path inside the repository, never through .git and never out of it. */
export function insideRepository(path: string) {
  if (!path || path.includes('\0') || path.includes('\\') || posix.isAbsolute(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/^\.git[. ]*$/i.test(part));
}

/** Rejections and holds for a change's paths; deployFiles are the deploy configuration files the scan found. */
export function pathRules(paths: readonly string[], deployFiles: readonly string[] = []) {
  const rejected: string[] = [], holds: string[] = [], deploy = new Set(deployFiles);
  if (paths.some(path => !insideRepository(path))) rejected.push(REJECTED.path);
  if (paths.some(path => path.startsWith('.github/') || deploy.has(path))) rejected.push(REJECTED.delivery);
  if (paths.some(isTest)) holds.push(HELD.tests);
  if (paths.some(isCheckConfig)) holds.push(HELD.checks);
  return { rejected, holds };
}

/**
 * The rules for a `git diff` with prefixes a/ and b/: its paths, changed lines, rejections and holds, and where it adds
 * credential text. A binary patch's content is not read here; the host copy checks git's --text diff of what it staged,
 * binary files included.
 */
export function checkChanges(diff: string, { deployFiles = [] }: { deployFiles?: readonly string[] } = {}): ChangeCheck {
  const paths = new Set<string>(), rejected = new Set<string>(), gone = new Set<string>(), adds: { text: string; code: boolean; at: string }[] = [];
  let added = 0, removed = 0, hunk = false, binary = false, code = false, file = '', number = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const named = headerPaths(line.slice(11));
      hunk = false; binary = false; file = named.at(-1) ?? ''; code = CODE.test(file);
      named.forEach(path => paths.add(path));
      continue;
    }
    if (binary) continue;
    if (hunk) {
      if (line.startsWith('+')) { added += 1; adds.push({ text: line.slice(1), code, at: `${file}:${number}` }); number += 1; continue; }
      if (line.startsWith('-')) { removed += 1; gone.add(line.slice(1)); continue; }
      if (line.startsWith(' ')) { number += 1; continue; }
      if (line.startsWith('\\') || line === '') continue;
      hunk = false;
    }
    if (line.startsWith('@@')) { hunk = true; number = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)?.[1] ?? 0); continue; }
    if (line === 'GIT binary patch') { binary = true; continue; }
    const header = /^(?:---|\+\+\+) (.+)$/.exec(line) ?? /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (header) {
      const path = line.startsWith('---') ? prefixed(header[1], 'a/') : line.startsWith('+++') ? prefixed(header[1], 'b/') : unquote(header[1]);
      if (header[1] !== '/dev/null') paths.add(path ?? header[1]);
      continue;
    }
    if (/^(?:new file mode|deleted file mode|old mode|new mode) 160000$|^index [\da-f]+\.\.[\da-f]+ 160000$/.test(line)) rejected.add(REJECTED.submodule);
  }
  // Credential text is text the change adds: a line it also removes, as in a file it moves, was already there.
  const credentials = adds.filter(item => !gone.has(item.text) && hasCredential(item.text, { code: item.code })).map(item => item.at);
  if (credentials.length) rejected.add(REJECTED.credential);
  const listed = [...paths], rules = pathRules(listed, deployFiles);
  rules.rejected.forEach(reason => rejected.add(reason));
  const holds = [...rules.holds, ...(added + removed > SIZE_LIMIT ? [HELD.size] : [])];
  return { paths: listed, added, removed, rejected: [...rejected], holds, credentials: credentials.slice(0, 10) };
}
