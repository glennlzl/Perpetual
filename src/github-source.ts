import { GITHUB_MESSAGES, SHA, githubEnvironment, githubFailureKind, githubGetArgs, isRepository, parseGitHubResponse, runGitHub } from './github-cli.ts';
import { execFile, type ExecFileException } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { failureText, redact } from './redaction.ts';
import type { GitHubSession, GitHubRepositoryPage, GitHubBranchPage } from '../contract/github.ts';
import type { GitHistory } from '../contract/git-history.ts';
export type { GitHubAccount, GitHubSession, GitHubRepositoryChoice } from '../contract/github.ts';

const exec = promisify(execFile);
const PAGE_SIZE = 100;
const API_TIMEOUT = 25_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// GitHub JSON is untrusted: a parsed object reads as a record of unknown fields, each checked where it is used.
type GitHubJson = { readonly [key: string]: unknown } | null;
const record = (value: unknown): GitHubJson => value !== null && typeof value === 'object' ? value as { readonly [key: string]: unknown } : null;
/** A managed clone of one branch, and the directory of it that is scanned. */
export interface PreparedGitHubSource { scanPath: string; checkoutPath: string; repository: string; branch: string; rootDirectory: string; sha: string }
/** A saved source as read back: every field is checked again before Git runs in it. */
export interface ManagedSourceInput { repository?: unknown; branch?: unknown; rootDirectory?: unknown; checkoutPath?: unknown; scanPath?: unknown }
export type HistorySync = Required<Pick<GitHistory, 'syncedAt'>> & { source: 'github' };

class GitHubSourceError extends Error {
  declare code: string;
  constructor(message: string, code = 'GITHUB_SOURCE_ERROR') {
    super(redact(message));
    this.name = 'GitHubSourceError';
    this.code = code;
  }
}

// gh keeps its account and keychain configuration; git runs with no user or system config, no helper prompts and no LFS smudge.
/** The environment of gh and git commands on managed clones, which a repair's host copy shares. */
export const commandEnvironment = () => githubEnvironment({ strip: ['SSH_ASKPASS'], set: {
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: NULL_FILE,
  GIT_CONFIG_GLOBAL: NULL_FILE, GIT_ATTR_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1',
} });

// The failure's kind comes from github-cli; the words and codes for it are this module's, and never the raw output.
function commandFailure(error: ExecFileException | GitHubSourceError, executable: string, operation: string) {
  if (error instanceof GitHubSourceError) return error;
  const kind = githubFailureKind(error);
  if (kind === 'missing') return new GitHubSourceError(
    executable === 'gh' ? GITHUB_MESSAGES.missing : 'Git is unavailable. Install Git before connecting a repository.',
    executable === 'gh' ? 'GH_NOT_FOUND' : 'GIT_NOT_FOUND',
  );
  if (kind === 'timeout') return new GitHubSourceError(`${operation} timed out. Check your connection and try again.`, 'GITHUB_TIMEOUT');
  if (kind === 'rate-limit') return new GitHubSourceError(GITHUB_MESSAGES['rate-limit'], 'GITHUB_RATE_LIMIT');
  if (kind === 'unauthenticated') return new GitHubSourceError(GITHUB_MESSAGES.unauthenticated, 'GITHUB_AUTH_REQUIRED');
  if (kind === 'not-found') return new GitHubSourceError('The repository or branch is unavailable to your GitHub account. Check the selection and repository access.', 'GITHUB_NOT_FOUND');
  if (kind === 'denied') return new GitHubSourceError('GitHub denied access. Check repository permissions and any organization SSO authorization for GitHub CLI.', 'GITHUB_FORBIDDEN');
  return new GitHubSourceError(`${operation} failed. Check your network connection and GitHub CLI account, then try again.`);
}

async function command(executable: string, args: string[], operation: string, timeout = API_TIMEOUT, cwd?: string) {
  try {
    if (executable === 'gh') return await runGitHub(args, { timeout, maxBuffer: MAX_OUTPUT, env: commandEnvironment() });
    return await exec(executable, args, {
      timeout, maxBuffer: MAX_OUTPUT, encoding: 'utf8', windowsHide: true,
      env: commandEnvironment(), ...(cwd ? { cwd } : {}),
    });
  } catch (error) { throw commandFailure(error as ExecFileException, executable, operation); }
}

function pageNumber(value: unknown) {
  const page = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new GitHubSourceError('Choose a page between 1 and 10,000.');
  }
  return page;
}

function repositoryName(value: unknown) {
  if (typeof value !== 'string') throw new GitHubSourceError('Choose a GitHub repository in owner/repository format.');
  const repository = value.trim();
  if (!isRepository(repository)) {
    throw new GitHubSourceError('Choose a GitHub repository in owner/repository format.');
  }
  return repository;
}

function branchName(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('-') || value === '@'
    || /[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(value) || value.includes('..') || value.includes('@{')
    || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new GitHubSourceError('Choose a valid Git branch name from the repository.');
  }
  return value;
}

// client/src/lib/source-selection.ts mirrors these rules for the Source sheet.
export function sourceRoot(value: unknown = '/') {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new GitHubSourceError('Use a repository root such as / or /apps/web.');
  }
  const parts = value.trim().split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.' || part.toLowerCase() === '.git')) {
    throw new GitHubSourceError('The root directory must stay inside the repository and cannot include .git, . or .. segments.');
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

async function githubApi(endpoint: string): Promise<{ data: unknown; hasNext: boolean }> {
  const { stdout } = await command('gh', githubGetArgs(endpoint), 'Reading GitHub');
  const { data, headers = {} } = parseGitHubResponse(stdout, message => new GitHubSourceError(message));
  return { data, hasNext: /;\s*rel="?next"?(?:\s*,|\s*$)/i.test(headers.link || '') };
}

export async function getGitHubSession(): Promise<GitHubSession> {
  try {
    const data = record((await githubApi('user')).data);
    if (!data || typeof data.login !== 'string') throw new GitHubSourceError('GitHub did not return an account. Sign in again with gh auth login --hostname github.com.');
    return { available: true, authenticated: true, account: { login: data.login, name: typeof data.name === 'string' ? data.name : null } };
  } catch (caught) {
    const error = caught as GitHubSourceError;
    return { available: error.code !== 'GH_NOT_FOUND', authenticated: false, account: null, message: failureText(error, 500) };
  }
}

export async function listGitHubRepositories({ page = 1 }: { page?: unknown } = {}): Promise<GitHubRepositoryPage> {
  const currentPage = pageNumber(page);
  const { data, hasNext } = await githubApi(`user/repos?per_page=${PAGE_SIZE}&page=${currentPage}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`);
  if (!Array.isArray(data)) throw new GitHubSourceError('GitHub did not return a repository list. Try again.');
  const repositories = data.map((entry: unknown) => {
    const item = record(entry);
    return { fullName: repositoryName(item?.full_name), name: typeof item?.name === 'string' ? item.name : null,
      private: Boolean(item?.private), defaultBranch: typeof item?.default_branch === 'string' && item.default_branch ? item.default_branch : null };
  });
  return { repositories, nextPage: hasNext && currentPage < 10_000 ? currentPage + 1 : null };
}

export async function listGitHubBranches({ repository, page = 1, preferredBranch }: { repository?: unknown; page?: unknown; preferredBranch?: unknown } = {}): Promise<GitHubBranchPage> {
  const selected = repositoryName(repository), currentPage = pageNumber(page);
  const preferred = preferredBranch == null ? null : branchName(preferredBranch);
  const [metadata, response] = await Promise.all([
    githubApi(`repos/${selected}`),
    githubApi(`repos/${selected}/branches?per_page=${PAGE_SIZE}&page=${currentPage}`),
  ]);
  if (!Array.isArray(response.data)) throw new GitHubSourceError('GitHub did not return a branch list. Try again.');
  const listed = record(metadata.data), defaultBranch = listed?.default_branch ? branchName(listed.default_branch) : null;
  const names = new Set(response.data.map((item: unknown) => branchName(record(item)?.name)));
  if (currentPage === 1) {
    const missing = [...new Set([defaultBranch, preferred].filter((name): name is string => Boolean(name)))].filter(name => !names.has(name));
    const additional = await Promise.all(missing.map(async name => {
      try {
        const { data } = await githubApi(`repos/${selected}/branches/${encodeURIComponent(name)}`);
        return branchName(record(data)?.name);
      } catch (error) {
        if ((error as GitHubSourceError).code === 'GITHUB_NOT_FOUND') return null;
        throw error;
      }
    }));
    for (const name of additional) if (name) names.add(name);
  }
  return {
    branches: [...names].map(name => ({ name })),
    nextPage: response.hasNext && currentPage < 10_000 ? currentPage + 1 : null,
    defaultBranch,
  };
}

async function managedSourcesDirectory(dataDir: unknown) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw new GitHubSourceError('A local data directory is required to connect a repository.');
  const directory = resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new GitHubSourceError('The local data directory must not be a symbolic link.');
  const sources = join(await realpath(directory), 'sources');
  await mkdir(sources, { recursive: true, mode: 0o700 });
  const stat = await lstat(sources);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitHubSourceError('The managed sources directory must be a regular directory.');
  await chmod(sources, 0o700);
  return sources;
}

async function scanDirectory(checkoutPath: string, rootDirectory: string) {
  let target = checkoutPath;
  for (const part of rootDirectory.split('/').filter(Boolean)) {
    target = join(target, part);
    let stat;
    try { stat = await lstat(target); }
    catch { throw new GitHubSourceError('The selected root directory does not exist in this branch. Choose / or an existing subdirectory.'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitHubSourceError('The root directory must contain only regular directories, without symbolic links.');
  }
  const canonical = await realpath(target);
  const within = relative(checkoutPath, canonical);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || resolve(checkoutPath, within) !== canonical) {
    throw new GitHubSourceError('The root directory must remain inside the managed checkout.');
  }
  return canonical;
}

/** Git arguments for a managed clone: no hooks or monitor, credentials only from gh's helper, no file or ext transport. */
export function gitArgs(args: string[]) {
  return [
    '-c', `core.hooksPath=${NULL_FILE}`, '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'credential.interactive=never', '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...args,
  ];
}

const historySyncs = new Map<string, HistorySync>();
const pendingHistorySyncs = new Map<string, Promise<HistorySync>>();
// Git work on one managed clone runs one operation at a time, so a history sync and an in-place
// move never race for its locks or its shallow boundary.
const checkoutTurns = new Map<string, Promise<unknown>>();
function inCheckoutTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
  const turn = (checkoutTurns.get(path) ?? Promise.resolve()).then(work);
  const settled = turn.catch(() => {});
  checkoutTurns.set(path, settled);
  void settled.then(() => { if (checkoutTurns.get(path) === settled) checkoutTurns.delete(path); });
  return turn;
}

async function managedHistoryCheckout(source: ManagedSourceInput | null | undefined, dataDir: unknown) {
  if (!source || typeof source !== 'object') throw new GitHubSourceError('Connect a GitHub repository before loading its history.');
  const repository = repositoryName(source.repository), branch = branchName(source.branch), root = sourceRoot(source.rootDirectory);
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')
    || typeof source.checkoutPath !== 'string' || !isAbsolute(source.checkoutPath) || source.checkoutPath.includes('\0')) {
    throw new GitHubSourceError('The managed GitHub checkout is unavailable. Reconnect the repository.');
  }
  const invalidCheckout = () => new GitHubSourceError('History can only be synced in a managed GitHub checkout. Reconnect the repository.');
  const requireDirectory = async (path: string) => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidCheckout();
  };
  try {
    // Validate without creating directories or touching the original repository.
    const directory = resolve(dataDir);
    await requireDirectory(directory);
    const sources = join(await realpath(directory), 'sources');
    await requireDirectory(sources);
    const checkoutPath = resolve(source.checkoutPath), parts = relative(sources, checkoutPath).split(sep);
    if (parts.length !== 2 || !/^github-[a-z\d]+$/i.test(parts[0]) || parts[1] !== repository.split('/')[1]) throw invalidCheckout();
    await requireDirectory(join(sources, parts[0]));
    await requireDirectory(checkoutPath);
    if (await realpath(checkoutPath) !== checkoutPath) throw invalidCheckout();
    const gitDirectory = join(checkoutPath, '.git');
    await requireDirectory(gitDirectory);
    // Managed clones are standalone repositories, never linked worktrees.
    const config = await lstat(join(gitDirectory, 'config'));
    if (config.isSymbolicLink() || !config.isFile()) throw invalidCheckout();
    for (const name of ['objects', 'refs']) await requireDirectory(join(gitDirectory, name));
    const scanPath = await scanDirectory(checkoutPath, root);
    if (source.scanPath !== scanPath) throw invalidCheckout();
    const [layout, origin, head, shallow] = await Promise.all([
      command('git', gitArgs(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']), 'Reading the managed checkout', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['remote', 'get-url', '--all', 'origin']), 'Reading the GitHub remote', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['symbolic-ref', '--short', 'HEAD']), 'Reading the checkout branch', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['rev-parse', '--is-shallow-repository']), 'Reading GitHub history', API_TIMEOUT, checkoutPath),
    ]);
    const paths = layout.stdout.trim().split(/\r?\n/);
    if (paths.length !== 3 || resolve(checkoutPath, paths[0]) !== checkoutPath
      || resolve(checkoutPath, paths[1]) !== gitDirectory || resolve(checkoutPath, paths[2]) !== gitDirectory
      || origin.stdout.trim().toLowerCase() !== `https://github.com/${repository}.git`.toLowerCase()
      || head.stdout.trim() !== branch || !['true', 'false'].includes(shallow.stdout.trim())) throw invalidCheckout();
    return { checkoutPath, repository, shallow: shallow.stdout.trim() === 'true' };
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw invalidCheckout();
  }
}

/** Fetch history only into an owned clone; never checks out files or moves HEAD. */
export async function ensureGitHubHistory({ source, dataDir, refresh = false }: { source?: ManagedSourceInput | null; dataDir?: unknown; refresh?: boolean } = {}): Promise<HistorySync> {
  const checkout = await managedHistoryCheckout(source, dataDir);
  const key = checkout.checkoutPath;
  if (pendingHistorySyncs.has(key)) return pendingHistorySyncs.get(key)!;
  if (!refresh && historySyncs.has(key)) return historySyncs.get(key)!;
  const sync = inCheckoutTurn(key, async () => {
    // Read the boundary in turn: a move that ran first may have changed it.
    const shallow = (await command('git', gitArgs(['rev-parse', '--is-shallow-repository']), 'Reading GitHub history', API_TIMEOUT, key)).stdout.trim() === 'true';
    await command('git', gitArgs([
      '-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'fetch', '--atomic', '--no-tags', '--prune', '--no-recurse-submodules',
      '--no-auto-maintenance', '--no-write-fetch-head', '--filter=blob:none',
      ...(shallow ? ['--unshallow'] : []), '--',
      `https://github.com/${checkout.repository}.git`, '+refs/heads/*:refs/remotes/origin/*',
    ]), 'Syncing GitHub history', 120_000, key);
    const result: HistorySync = { syncedAt: new Date().toISOString(), source: 'github' };
    historySyncs.set(key, result);
    return result;
  });
  pendingHistorySyncs.set(key, sync);
  try { return await sync; }
  finally { if (pendingHistorySyncs.get(key) === sync) pendingHistorySyncs.delete(key); }
}

/**
 * Moves an owned clone to one commit of its branch, in place, so environments built from its path
 * stay attached to the source. Only a managed checkout is accepted; a user's own checkout never is.
 */
export async function updateGitHubSource({ source, dataDir, sha }: { source?: ManagedSourceInput | null; dataDir?: unknown; sha?: unknown } = {}): Promise<{ sha: string }> {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new GitHubSourceError('Choose a commit of the selected branch.');
  const { checkoutPath } = await managedHistoryCheckout(source, dataDir);
  return inCheckoutTurn(checkoutPath, async () => {
    // Validated again in turn, so the shallow boundary is read after any history sync before it.
    const checkout = await managedHistoryCheckout(source, dataDir);
    await command('git', gitArgs([
      '-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head',
      // A full history stays full; a depth-one copy fetches only this commit.
      ...(checkout.shallow ? ['--depth', '1'] : []), '--', `https://github.com/${checkout.repository}.git`, sha,
    ]), 'Fetching the commit', 120_000, checkoutPath);
    // No checkout hook; global filters and templates are disabled for this operation.
    await command('git', gitArgs(['reset', '--hard', sha]), 'Updating the source files', 60_000, checkoutPath);
    // The graph follows the fetched branch tip, which this fetch by commit does not advance: the next read syncs again.
    historySyncs.delete(checkoutPath);
    const { stdout } = await command('git', gitArgs(['rev-parse', '--verify', 'HEAD']), 'Reading the checkout commit', API_TIMEOUT, checkoutPath);
    if (stdout.trim().toLowerCase() !== sha.toLowerCase()) throw new GitHubSourceError('The managed source did not move to this commit. Try again.');
    return { sha: stdout.trim() };
  });
}

/**
 * A fresh clone of one commit of a managed source copy into `directory`, which must not exist yet: made in the copy's
 * turn from the copy's own objects, even a commit behind its HEAD, fetching the commit from GitHub only when the copy
 * lacks it, with `branch` checked out at it. The clone has no remote, so its config names neither the copy nor a
 * credential. A user's checkout never is one.
 */
export async function cloneGitHubSourceCommit({ source, dataDir, sha, directory, branch }: { source?: ManagedSourceInput | null; dataDir?: unknown; sha?: unknown; directory?: unknown; branch?: unknown } = {}): Promise<{ path: string; sha: string }> {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new GitHubSourceError('Choose a commit of the selected branch.');
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new GitHubSourceError('A private directory is required for the copy.');
  const local = branchName(branch);
  const { checkoutPath } = await managedHistoryCheckout(source, dataDir);
  return inCheckoutTurn(checkoutPath, async () => {
    const checkout = await managedHistoryCheckout(source, dataDir);
    await command('git', gitArgs(['init', '--quiet', '--template=', '--', directory]), 'Copying the managed source', API_TIMEOUT);
    await chmod(directory, 0o700);
    const fetch = ['-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--depth', '1'];
    // The commit comes from the copy's own objects, whichever of its commits it is: the copy is Perpetual's own clone,
    // so the local transport is allowed for this command alone, and its upload-pack serves a commit behind its tips.
    const copied = await command('git', gitArgs(['-c', 'protocol.file.allow=always', ...fetch, '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', '--', checkoutPath, sha]),
      'Copying the managed source', 120_000, directory).then(() => true, () => false);
    if (!copied) await command('git', gitArgs([...fetch, '--', `https://github.com/${checkout.repository}.git`, sha]), 'Fetching the commit', 120_000, directory);
    await command('git', gitArgs(['checkout', '--force', '--quiet', '-B', local, sha]), 'Checking out the commit', 60_000, directory);
    const { stdout } = await command('git', gitArgs(['rev-parse', '--verify', 'HEAD']), 'Reading the copy commit', API_TIMEOUT, directory);
    if (stdout.trim().toLowerCase() !== sha.toLowerCase()) throw new GitHubSourceError('The copy did not check out this commit. Try again.');
    return { path: directory, sha: stdout.trim() };
  });
}

/** Clone/read only: never changes an existing checkout, runs hooks, or starts a project. */
export async function prepareGitHubSource({ repository, branch, rootDirectory = '/', dataDir }: { repository?: unknown; branch?: unknown; rootDirectory?: unknown; dataDir?: unknown } = {}): Promise<PreparedGitHubSource> {
  const selected = repositoryName(repository), selectedBranch = branchName(branch), root = sourceRoot(rootDirectory);
  // Check the branch, so git clone --branch cannot silently select a same-named tag.
  const remoteBranch = record((await githubApi(`repos/${selected}/branches/${encodeURIComponent(selectedBranch)}`)).data);
  if (remoteBranch?.name !== selectedBranch) throw new GitHubSourceError('The selected branch is no longer available. Refresh the branch list.');
  let ownedDirectory: string | undefined;
  try {
    const sources = await managedSourcesDirectory(dataDir);
    ownedDirectory = await mkdtemp(join(sources, 'github-'));
    await chmod(ownedDirectory, 0o700);
    const checkoutPath = join(ownedDirectory, selected.split('/')[1]);
    await command('git', gitArgs([
      'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-checkout',
      '--template=', '--branch', selectedBranch, '--', `https://github.com/${selected}.git`, checkoutPath,
    ]), 'Cloning the selected GitHub branch', 120_000);
    await chmod(checkoutPath, 0o700);
    const { stdout: checkedOutBranch } = await command('git', gitArgs(['symbolic-ref', '--short', 'HEAD']), 'Reading the checkout branch', API_TIMEOUT, checkoutPath);
    if (checkedOutBranch.trim() !== selectedBranch) throw new GitHubSourceError('The selected branch changed while connecting. Refresh the branch list and reconnect.');
    // No checkout hook; global filters and templates are disabled for this operation.
    await command('git', gitArgs(['reset', '--hard', 'HEAD']), 'Reading the selected source files', 30_000, checkoutPath);
    const { stdout } = await command('git', gitArgs(['rev-parse', '--verify', 'HEAD']), 'Reading the checkout commit', API_TIMEOUT, checkoutPath);
    const sha = stdout.trim();
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) throw new GitHubSourceError('Git did not return a valid checkout commit. Reconnect the repository.');
    const scanPath = await scanDirectory(checkoutPath, root);
    return { scanPath, checkoutPath, repository: selected, branch: selectedBranch, rootDirectory: root, sha };
  } catch (error) {
    let cleanupFailed = false;
    if (ownedDirectory) try { await rm(ownedDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    const safe = error instanceof GitHubSourceError ? error : new GitHubSourceError('Could not create the private source checkout. Check the local data directory permissions and available disk space.');
    if (cleanupFailed) safe.message += ' An incomplete private checkout could not be removed from the managed sources directory.';
    throw safe;
  }
}
