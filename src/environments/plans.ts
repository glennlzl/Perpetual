import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, dirname, posix, sep } from 'node:path';
import { detectTwinConfig, envNames } from '../twin/index.ts';
import { nodeMajor } from '../twin/detect.ts';
import { relative as repositoryPath } from '../twin/paths.ts';
import { gitReadOnly } from '../process.ts';
import { withoutRegistryCredentials } from '../redaction.ts';
import type { DetectedApp, DetectedConfig, DetectionEvidence } from '../twin/detect.ts';
import type { PackageManifest, ScanRepo, ScanService } from '../scanner.ts';

/** The scan fields detection reads. */
export type DetectionScan = { repo: Pick<ScanRepo, 'path'>; services?: (Pick<ScanService, 'id' | 'path'> & Partial<Pick<ScanService, 'framework'>>)[] };

const SKIP = new Set(['.git', 'node_modules', '.next', '.nuxt', '.output', '.perpetual', '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.vercel', '.railway', '.ssh', '.aws', '.config', '.azure', '.kube', '.gnupg', '.docker', '.codex', '.agents', '.claude']);
const BUILD_OUTPUT = new Set(['dist', 'build', 'coverage']);
const PRIVATE = /^(?:\.env(?:\..*)?|\.netrc|\.pypirc|id_(?:rsa|ed25519)(?:\..*)?|(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?)\.md)$|\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i;
const PRIVATE_NAME = /^(?:credentials|secrets?)(?:\..*)?$/i;
// A package manager's config holds settings an install needs beside registry credentials, so it is copied without those;
// one larger than this is left out.
const REGISTRY_CONFIG = /^\.(?:npmrc|yarnrc(?:\.yml)?)$/i;
export const REGISTRY_CONFIG_BYTES = 128 * 1024;
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?|pyi?)$/i;
/** Whether the snapshot keeps every folder on a repository path's way, by snapshotSource's rules. */
export const keptFolders = (path: string) => path.split('/').slice(0, -1).every((name, index, folders) => !SKIP.has(name) && !PRIVATE.test(name) && !PRIVATE_NAME.test(name)
  && !(BUILD_OUTPUT.has(name) && !folders.slice(0, index).includes('src')));
/** Whether the snapshot keeps a repository file at this path, by snapshotSource's rules. */
export function snapshotKeeps(path: string) {
  const name = posix.basename(path);
  return keptFolders(path) && !SKIP.has(name) && !PRIVATE.test(name) && !(PRIVATE_NAME.test(name) && !SOURCE_MODULE.test(name));
}

// Tests read variables of their own; docs' code is never run. A test file is one by its name, such as add.test.ts,
// server_test.ts, hello-test.ts or test.ts as Deno and Supabase name them, login.cy.ts as Cypress does, or test_add.py;
// Jest's __tests__ and __mocks__ folders and the tests folder of a functions folder, where Supabase keeps its edge
// functions' tests, hold tests, wherever they are.
export const TEST = /(?:^|\/)(?:__tests__|__mocks__|functions\/tests)\/|\.(?:test|spec)\.[^/]+$|[_-](?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test\.[cm]?[jt]sx?$|\.cy\.[cm]?[jt]sx?$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$|(?:^|\/)(?:playwright|vitest|jest|cypress|karma)\.config\.[^/]+$/i;
export const DOCS = /(?:^|\/)docs\//i;
// Test folders, Cypress's included, and tooling folders are the first folder inside a package or the repository, so an
// app's own src/, app/ or lib/ holds runtime code whatever its folders are called, a route named tests or e2e included.
export const TEST_FOLDER = /^(?:tests?|e2e|cypress)\//i;
export const TOOLING = /^(?:evals?|bench(?:marks?)?|fixtures?|examples?|samples?|playgrounds?|\.storybook|stories|tooling)\//i;
/** A repository file's path inside each of `packages` that holds it, innermost first, then inside the repository. */
export function packagePaths(file: string, packages: ReadonlySet<string>) {
  const paths: string[] = [];
  for (let directory = posix.dirname(file); directory !== '.'; directory = posix.dirname(directory)) if (packages.has(directory)) paths.push(file.slice(directory.length + 1));
  return [...paths, file];
}
/** Whether a repository file is a test's: by its name or a folder TEST names, or in a test folder of a package or the repository. */
export const isTest = (file: string, packages: ReadonlySet<string>) => TEST.test(file) || packagePaths(file, packages).some(path => TEST_FOLDER.test(path));

// Detection evidence: dependency manifests, and only the variable names of example env files.
export const ENV_EXAMPLE = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)$/i;
export const REQUIREMENTS = /^requirements(?:[.-][\w.-]+)?\.txt$/i;
/** Whether a file name is a package's manifest: package.json, pyproject.toml, a requirements file or deno.json. */
export const MANIFEST = (name: string) => name === 'package.json' || name === 'pyproject.toml' || REQUIREMENTS.test(name) || /^deno\.jsonc?$/i.test(name);
/**
 * The packages whose first folders may be test or tooling folders: `packages`, and the folder of every manifest among
 * `files` outside a test folder and docs, whatever its language. The packages around a manifest are shallower than it, so
 * manifests are taken shallowest first: one in a test folder is a test's, and makes no package.
 */
export function packageFolders(files: readonly string[], packages: Iterable<string>) {
  const folders = new Set(packages), depth = (file: string) => file.split('/').length;
  for (const file of files.filter(path => MANIFEST(posix.basename(path)) && !DOCS.test(path)).sort((one, other) => depth(one) - depth(other))) if (!isTest(file, folders)) folders.add(posix.dirname(file));
  return folders;
}
// Deno and browser modules name packages in their import specifiers instead of a manifest, e.g. npm:stripe@17 or
// https://esm.sh/stripe@17; deno.json import maps name them the same way.
export const SCRIPT_MODULE = /\.(?:[cm]?[jt]sx?)$/i, IMPORT_MAP = /^(?:deno\.jsonc?|import_map\.json)$/i;
const PACKAGE_NAME = String.raw`(@[\w.-]+\/[\w.-]+|[\w.-]+)`;
const SPECIFIER = new RegExp(String.raw`(?:\bnpm:|https:\/\/(?:esm\.sh\/(?:v\d+\/)?|cdn\.skypack\.dev\/|cdn\.jsdelivr\.net\/npm\/|unpkg\.com\/|jspm\.dev\/(?:npm:)?))${PACKAGE_NAME}`, 'g');
/** At most this many source modules are read, each up to this size. */
export const MODULES = { files: 5000, bytes: 262_144 };
/** Package names in a module's npm: and CDN specifiers. */
export const specifierNames = (text: unknown) => [...new Set([...String(text).matchAll(SPECIFIER)].map(match => match[1]))];
/** Detection's repository walk descends at most this deep and visits at most this many entries. */
export const WALK = { depth: 8, entries: 20000 };
export type WalkLimits = typeof WALK;
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// Packages of these scanned frameworks run their dev or start script as apps; any other package
// runs only a start script, npm's convention for starting a package's server. Package managers come from corepack.
const APP_FRAMEWORK = /next|vite|express|fastify|hono/i;
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'], ['yarn.lock', 'yarn', 'yarn install'], ['package-lock.json', 'npm', 'npm ci']];
const INSTALL: Record<string, string> = { pnpm: 'pnpm install', yarn: 'yarn install', npm: 'npm install' };
// A script that reaches a cloud account or publishes is never an app command. A deploy, release or publish word is one,
// in a name such as semantic-release or build-and-deploy too, but not in a flag (--release, --skip-deploy), as a folder
// (dist/release/) or in Prisma's `migrate deploy`, which applies migrations to the twin's own database. The word is found
// before looking back, and each look back is bounded, so a crafted manifest takes time in proportion to its size.
const CLOUD_LAUNCHER = /\b(?:vercel|netlify)\s+(?:dev|env|deploy|link)|\brailway\s+(?:env|deploy|link|run)|\bsupabase\s+(?:env|deploy|link|db\s+push)|\b(?=(?:deploy|release|publish)\b)(?<!(?:^|\s)--?[\w-]{0,64}|\bmigrate\s{1,16})(?:deploy|release|publish)\b(?!\/)/i;
// Servers that listen on loopback or ignore PORT unless told otherwise.
const LISTEN: [RegExp, (port: number) => string][] = [[/^\s*(?:npx\s+)?vite\b/, port => `--host 0.0.0.0 --port ${port}`], [/^\s*(?:npx\s+)?next\b/, port => `--hostname 0.0.0.0 --port ${port}`]];
/** Each app listens on this port in its own container; the twin publishes it on a host port of its own. */
export const APP_PORT = 3000;

/** The size of a repository file readLocal reads by default. */
export const FILE_BYTES = 1_048_576;
/** A repository file's text, refused when it or a folder on its way is a link out of the root, or it is too large. */
export async function readLocal(root: string, file: string, limit = FILE_BYTES) {
  const target = join(root, repositoryPath(file, 'A repository file'));
  const actual = await realpath(target);
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Repository files cannot point outside the source.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Repository configuration is too large.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

const isFile = (path: string) => lstat(path).then(info => info.isFile(), () => false);
/** A repository's package.json is untrusted: only these fields are read, and each is checked where it is used. */
type Manifest = Pick<PackageManifest, 'scripts' | 'packageManager'>;
const fields = (value: unknown) => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
// A manifest that cannot be read or parsed is not evidence.
const readManifest = (root: string, directory: string): Promise<Manifest | null> => readLocal(root, posix.join(directory, 'package.json')).then(text => fields(JSON.parse(text))).catch(() => null);

/**
 * Repository-relative files, without following links or entering skipped directories or folders that cannot be read,
 * such as a container's data owned by another user; `complete` is false when the walk's depth or entry limit left some out.
 */
export async function repositoryWalk(root: string, limits: WalkLimits = WALK) {
  const files: string[] = [];
  let entries = 0, complete = true;
  async function walk(directory: string, depth: number) {
    let found;
    try { found = await readdir(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (!directory) throw error; return; }
    for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > limits.entries) { complete = false; return; }
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(name);
      else if (!entry.isDirectory() || SKIP.has(entry.name) || BUILD_OUTPUT.has(entry.name)) continue;
      else if (depth < limits.depth) await walk(name, depth + 1);
      else complete = false;
    }
  }
  await walk('', 0);
  return { files, complete };
}

const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

// PEP 621 and dependency-group arrays, and Poetry dependency tables; no other key is a dependency.
function pyprojectNames(text: string) {
  const names: string[] = [];
  let table = '', array = false;
  for (const line of text.split(/\r?\n/).map(value => value.replace(/(?:^|\s)#.*$/, ''))) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) { table = header[1].trim(); array = false; continue; }
    const dependencies = /(?:^|\.)(?:optional-|dev-)?dependencies$|^dependency-groups$/.test(table);
    const entry: RegExpExecArray | false | null = !array && /^\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (entry) {
      if (dependencies && table.startsWith('tool.poetry.')) names.push(entry[1]);
      array = entry[2].startsWith('[') && (dependencies || (table === 'project' && entry[1] === 'dependencies'));
    }
    if (!array) continue;
    const values = entry ? entry[2] : line;
    names.push(...[...values.matchAll(/["']([A-Za-z0-9][\w.-]*)/g)].map(match => match[1]));
    if (values.replace(/"[^"]*"|'[^']*'/g, '').includes(']')) array = false;
  }
  return names.filter(name => name.toLowerCase() !== 'python');
}

/** Dependency names in a manifest: package.json, pyproject.toml or a requirements file. */
export function dependencyNames(name: string, text: string): string[] {
  if (name === 'package.json') { const manifest = fields(JSON.parse(text)); return MANIFEST_FIELDS.flatMap(field => Object.keys(fields(manifest?.[field]) ?? {})); }
  if (name === 'pyproject.toml') return pyprojectNames(text).map(pythonName);
  return text.split(/\r?\n/).map(line => /^\s*([A-Za-z0-9][\w.-]*)/.exec(line.replace(/#.*/, ''))?.[1]).filter(name => name !== undefined).map(pythonName);
}

/** The package manager of the nearest lockfile, the directory it is in (null without one) and its install command. */
async function installer(root: string, directory: string, declared: string | undefined) {
  for (let at = directory; ; at = posix.dirname(at)) {
    for (const [file, manager, command] of LOCKFILES) if (await isFile(join(root, at, file))) return { manager, lockDirectory: at, command };
    if (at === '.') break;
  }
  const manager = declared !== undefined && Object.hasOwn(INSTALL, declared) ? declared : 'npm';
  return { manager, lockDirectory: null, command: INSTALL[manager] };
}

/**
 * Apps for the scan's packages: install, build when it starts a built output, then its first dev or start
 * script that reaches no cloud CLI. A build that reaches one is left out.
 * Apps that share one lockfile would install into the same snapshot at once, so that lockfile's install
 * runs once as the twin's `install` instead; an app alone with its lockfile keeps the install in its build.
 */
type Found = { lockDirectory: string | null; command: string; install: string; app: DetectedApp & { build: string; start: string } };
type SharedLock = Found & { lockDirectory: string };
async function repositoryApps(root: string, scan: DetectionScan): Promise<{ apps: DetectedApp[]; install?: { directory: string; command: string } }> {
  const rootManifest = await readManifest(root, '.'), found: Found[] = [];
  for (const service of scan.services ?? []) {
    const manifest = service.path === '.' ? rootManifest : await readManifest(root, service.path);
    const usable = (name: string) => typeof manifest?.scripts?.[name] === 'string' && manifest.scripts[name].trim() && !CLOUD_LAUNCHER.test(manifest.scripts[name]);
    const script = (APP_FRAMEWORK.test(service.framework ?? '') ? ['dev', 'start'] : ['start']).find(usable);
    if (!script || !manifest?.scripts) continue; // a usable script is in the manifest's scripts
    const declared = /^(\w+)@/.exec(String(manifest.packageManager ?? rootManifest?.packageManager ?? ''))?.[1];
    const { manager, lockDirectory, command } = await installer(root, service.path, declared);
    const run = (name: string) => `${manager} run ${name}`, up = lockDirectory && posix.relative(service.path, lockDirectory);
    const listen = LISTEN.find(([pattern]) => pattern.test(manifest.scripts![script] as string))?.[1](APP_PORT);
    found.push({ lockDirectory, command, install: up ? `(cd ${up} && ${command})` : command,
      app: { id: service.id, directory: service.path, port: APP_PORT, build: script === 'start' && usable('build') ? run('build') : '',
        start: listen ? `${run(script)}${manager === 'npm' ? ' --' : ''} ${listen}` : run(script) } });
  }
  // A twin has one install step; if several lockfiles are shared, the one most apps share takes it.
  const sharing = Object.values(Object.groupBy(found.filter((item): item is SharedLock => item.lockDirectory !== null), item => item.lockDirectory) as Record<string, SharedLock[]>).filter(group => group.length > 1);
  const shared = sharing.sort((one, other) => other.length - one.length)[0]?.[0];
  return {
    apps: found.map(({ lockDirectory, install, app }) => ({ ...app, build: [lockDirectory !== shared?.lockDirectory && install, app.build].filter(Boolean).join(' && ') })),
    ...(shared ? { install: { directory: shared.lockDirectory, command: shared.command } } : {}),
  };
}

/**
 * The repository's detection evidence, as detectTwinConfig reads it, and the twin config it proposes: apps from the
 * scanned web packages, and services from file paths, manifest dependency names, module import specifiers and the
 * variable names (never values) of example env files. Tests, docs and tooling such as examples and fixtures, as the
 * evidence's roles class them (./evidence.ts), are not what the product runs, so their files are not evidence.
 */
export async function repositoryDetection(scan: DetectionScan): Promise<{ evidence: DetectionEvidence; config: DetectedConfig }> {
  const root = await realpath(scan.repo.path), walked = (await repositoryWalk(root)).files;
  // Test and tooling folders are those of the scanned packages and of every other folder with a manifest, as the evidence's.
  const folders = packageFolders(walked, (scan.services ?? []).map(service => service.path));
  const aside = (file: string) => isTest(file, folders) || DOCS.test(file) || packagePaths(file, folders).some(path => TOOLING.test(path));
  const files = walked.filter(file => !aside(file)), packages = new Set<string>(), env = new Set<string>();
  let modules = 0;
  for (const file of files) {
    if (IMPORT_MAP.test(posix.basename(file)) || SCRIPT_MODULE.test(file) && ++modules <= MODULES.files) {
      const text = await readLocal(root, file, MODULES.bytes).catch(() => null);
      if (text !== null) specifierNames(text).forEach(name => packages.add(name));
      continue;
    }
    const name = posix.basename(file), manifest = ['package.json', 'pyproject.toml'].includes(name) || REQUIREMENTS.test(name);
    if (!manifest && !ENV_EXAMPLE.test(name)) continue;
    const text = await readLocal(root, file).catch(() => null);
    if (text === null) continue;
    try { (manifest ? dependencyNames(name, text) : envNames(text)).forEach(item => (manifest ? packages : env).add(item)); }
    catch { /* An unreadable manifest is not evidence. */ }
  }
  const node = await repositoryNode(root);
  const evidence: DetectionEvidence = { files, packages: [...packages], env: [...env], ...await repositoryApps(root, scan), ...(node === undefined ? {} : { node }) };
  return { evidence, config: detectTwinConfig(evidence) };
}

/** The twin config proposed from the repository; see repositoryDetection. */
export const detectEnvironmentConfig = async (scan: DetectionScan): Promise<DetectedConfig> => (await repositoryDetection(scan)).config;

/**
 * The Node.js major the repository root asks for, where actions/setup-node looks: .nvmrc, .node-version, then
 * package.json's volta.node, devEngines.runtime for node, and engines.node. Undefined when none names one.
 */
async function repositoryNode(root: string) {
  const read = (file: string) => readLocal(root, file).catch(() => null);
  for (const file of ['.nvmrc', '.node-version']) { const major = nodeMajor((await read(file))?.trim()); if (major !== undefined) return major; }
  let manifest: Record<string, unknown> | null = null;
  try { manifest = fields(JSON.parse(await read('package.json') ?? 'null')); } catch { /* An unreadable manifest is not evidence. */ }
  const runtimes = [fields(manifest?.devEngines)?.runtime].flat().map(fields).filter(runtime => runtime?.name === 'node');
  for (const value of [fields(manifest?.volta)?.node, ...runtimes.map(runtime => runtime?.version), fields(manifest?.engines)?.node]) {
    const major = nodeMajor(value);
    if (major !== undefined) return major;
  }
  return undefined;
}

/**
 * The untracked paths git ignores in the checkout at `folder` of `root`, by its .gitignore files and the user's excludes,
 * relative to root and a folder's with a trailing slash. None outside a git checkout; when git fails in a folder with git
 * metadata, the snapshot is refused, since it would otherwise copy every file git ignores.
 */
async function ignoredPaths(root: string, folder = '') {
  const at = join(root, folder), shown = folder.split(sep).join('/');
  try {
    const { stdout } = await gitReadOnly(at, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).map(path => shown ? `${shown}/${path}` : path);
  } catch (error) {
    if (!await lstat(join(at, '.git')).then(() => true, () => false)) return [];
    const { code, killed } = error as { code?: unknown; killed?: boolean };
    const cause = code === 'ENOENT' ? 'git is not installed' : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'its list is over 64 MB'
      : killed ? 'it took over 20 seconds' : typeof code === 'number' ? `it exited with status ${code}` : 'it failed';
    throw new Error(`Git could not list the ignored files in the source folder ${shown || '.'}: ${cause}. Check that git status works there.`);
  }
}

/** A package manager's config without its credential lines, `name` being its file name: the same bytes, unless it held one. */
function withoutCredentials(name: string, buffer: Buffer) {
  const text = buffer.toString('utf8'), kept = withoutRegistryCredentials(text, name);
  return kept === text ? buffer : Buffer.from(kept);
}

/**
 * Copy a bounded working-tree snapshot without following links or importing local credentials. In a git checkout, files
 * git ignores stay out whatever their names, since local files such as credentials are never committed; so do those a
 * repository or submodule inside it ignores. A package manager's config is copied without its credential lines, and left
 * out unread when it is larger than REGISTRY_CONFIG_BYTES, which bounds the time its lines take to check.
 */
export async function snapshotSource(repoPath: string, destination: string) {
  const root = await realpath(repoPath), target = resolve(destination);
  if (target === root || (target.startsWith(root + sep) && relative(root, target).split(sep)[0] !== '.perpetual')) throw new Error('Keep sandbox storage outside the source or under .perpetual.');
  // Validate the nearest existing ancestor before mkdir can write through a
  // linked destination or linked parent into an unrelated directory.
  let ancestor = target;
  for (;;) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new Error('The snapshot destination cannot contain a symbolic link.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error('The snapshot destination changed during creation.');
  let count = 0, bytes = 0;
  const hash = createHash('sha256'), ignored = new Set(await ignoredPaths(root));
  async function walk(directory: string) {
    const folder = join(root, directory);
    if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder) throw new Error('Source directories changed during snapshot creation.');
    const entries = (await readdir(join(root, directory), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      throw new Error(`The source folder ${directory.split(sep).join('/') || '.'} cannot be read. Make it readable, or move it out of the checkout or have git ignore it.`);
    })).sort((a, b) => a.name.localeCompare(b.name));
    // The checkout's git lists nothing inside a repository or submodule of its own, which ignores files by its own rules.
    if (directory && entries.some(entry => entry.name === '.git')) for (const path of await ignoredPaths(root, directory)) ignored.add(path);
    for (const entry of entries) {
      const name = join(directory, entry.name), path = name.split(sep).join('/');
      if (SKIP.has(entry.name) || PRIVATE.test(entry.name) || entry.isSymbolicLink() || ignored.has(entry.isDirectory() ? `${path}/` : path)
        || (BUILD_OUTPUT.has(entry.name) && entry.isDirectory() && !directory.split(sep).includes('src'))
        || (PRIVATE_NAME.test(entry.name) && (!entry.isFile() || !SOURCE_MODULE.test(entry.name)))) continue;
      const original = join(root, name), output = join(target, name);
      if (entry.isDirectory()) { await mkdir(output, { mode: 0o700 }); await walk(name); continue; }
      if (!entry.isFile()) continue;
      if (await realpath(original) !== original) throw new Error('Source links changed during snapshot creation.');
      const handle = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(), config = REGISTRY_CONFIG.test(entry.name);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error(`Snapshot file is too large: ${name}`);
        if (config && stat.size > REGISTRY_CONFIG_BYTES) continue;
        if (++count > 20000 || (bytes += stat.size) > 256 * 1024 * 1024) throw new Error('Source snapshot exceeds 20,000 files or 256 MiB.');
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!result.bytesRead) throw new Error('Source changed during snapshot creation. Retry the operation.');
          offset += result.bytesRead;
        }
        if ((await handle.stat()).size !== stat.size || await realpath(original) !== original) throw new Error('Source changed during snapshot creation. Retry the operation.');
        const content = config ? withoutCredentials(entry.name, buffer) : buffer;
        bytes -= buffer.length - content.length;
        hash.update(relative(root, original)).update('\0').update(content).update('\0');
        const out = await open(output, 'wx', stat.mode & 0o111 ? 0o700 : 0o600);
        try { await out.writeFile(content); } finally { await out.close(); }
      } finally { await handle.close(); }
    }
  }
  await walk('');
  return { hash: hash.digest('hex'), files: count, bytes };
}
