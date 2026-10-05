import { execFile, type ExecFileException } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { parseGitHubRemote } from './providers.ts';
import { redact } from './redaction.ts';
import type { ScanRepo } from './scanner.ts';
import type { GitCommit, GitHistory } from '../contract/git-history.ts';
export type { GitCommit, GitHistory } from '../contract/git-history.ts';

interface GitRef { hash: string; type: string; name: string; symbolic: string }

const exec = promisify(execFile);
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_REFS = 2_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

class GitHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHistoryError';
  }
}

// Do not inherit GIT_DIR, alternate object directories, trace destinations,
// helpers, config injection, or credential-bearing application environment.
function gitEnvironment() {
  return {
    PATH: process.env.PATH,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: NULL_FILE,
    GIT_CONFIG_GLOBAL: NULL_FILE,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
}

function git(root: string, args: string[]): Promise<string>;
function git(root: string, args: string[], options: { allowMissing: boolean }): Promise<string | null>;
async function git(root: string, args: string[], { allowMissing = false } = {}): Promise<string | null> {
  try {
    const { stdout } = await exec('git', [
      '--no-pager', '--no-replace-objects',
      '-c', `core.hooksPath=${NULL_FILE}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.pager=',
      '-c', 'color.ui=false',
      '-c', 'log.showSignature=false',
      '-c', 'credential.helper=',
      '-c', 'credential.interactive=never',
      '-c', 'protocol.allow=never',
      '-c', 'maintenance.auto=false',
      ...args,
    ], {
      cwd: root, env: gitEnvironment(), encoding: 'utf8',
      timeout: 10_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
    });
    return stdout;
  } catch (caught) {
    const error = caught as ExecFileException;
    if (allowMissing && error.code === 1) return null;
    if (error.code === 'ENOENT') throw new GitHistoryError('Git or the connected repository is unavailable.');
    if (error.killed || error.code === 'ETIMEDOUT') throw new GitHistoryError('Reading Git history timed out. Try again.');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitHistoryError('Git history is too large to read. Choose a smaller history window.');
    // Never return raw stderr: repository configuration and remote URLs may
    // contain credentials, and commit data is not trusted application output.
    throw new GitHistoryError('Cannot read local Git history. Check the connected repository.');
  }
}

function readRefs(output: string): GitRef[] {
  const rows = output.split('\n').filter(Boolean);
  if (rows.length > MAX_REFS) throw new GitHistoryError('The repository has too many references to display.');
  return rows.map(row => {
    const fields = row.split('\0');
    if (fields.length !== 5 || fields[4] !== '' || !HASH.test(fields[0])) {
      throw new GitHistoryError('Git returned unreadable references.');
    }
    const [hash, type, name, symbolic] = fields;
    if (!/^refs\/(?:heads|remotes|tags)\//.test(name)) throw new GitHistoryError('Git returned an unexpected reference.');
    return { hash, type, name, symbolic };
  });
}

function readTags(output: string | null) {
  // show-ref --dereference recursively peels annotated tags, including tags
  // that point to another tag. Non-commit targets cannot match displayed SHAs.
  const tags = new Map<string, string>();
  for (const row of (output || '').split('\n').filter(Boolean)) {
    const match = row.match(/^([a-f0-9]+) (refs\/tags\/.+?)(\^\{\})?$/);
    if (!match || !HASH.test(match[1])) throw new GitHistoryError('Git returned unreadable tags.');
    const [, hash, name, peeled] = match;
    if (peeled || !tags.has(name)) tags.set(name, hash);
  }
  return tags;
}

const displayText = (value: string, length: number) => redact(value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, length);

function readCommits(output: string): GitCommit[] {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 5 !== 0) throw new GitHistoryError('Git returned unreadable commit history.');
  const commits: GitCommit[] = [];
  for (let index = 0; index < fields.length; index += 5) {
    const [hash, parentsText, name, date, message] = fields.slice(index, index + 5);
    const parents = parentsText ? parentsText.split(' ') : [];
    if (!HASH.test(hash) || parents.some(parent => !HASH.test(parent)) || !Number.isFinite(Date.parse(date))) {
      throw new GitHistoryError('Git returned unreadable commit history.');
    }
    commits.push({ hash, message: displayText(message, 1_000), author: { name: displayText(name, 200) }, date, parents });
  }
  return commits;
}

/** Read the connected checkout only. Never fetch, checkout, or execute its code. */
export async function readGitHistory(scan: { repo: Pick<ScanRepo, 'path' | 'remote' | 'name'> }, { scope = 'all', limit = 100, currentRef = null }: { scope?: string; limit?: number; currentRef?: string | null } = {}): Promise<GitHistory> {
  const root = scan?.repo?.path;
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new GitHistoryError('Connect a local repository to view Git history.');
  if (!['all', 'current'].includes(scope)) throw new GitHistoryError('Choose all branches or the current branch.');
  if (!Number.isInteger(limit) || limit < 100 || limit > 500) throw new GitHistoryError('Choose a history limit between 100 and 500.');

  // First establish that the trusted scan path still points to a Git repo.
  const shallowText = (await git(root, ['rev-parse', '--is-shallow-repository'])).trim();
  if (!['true', 'false'].includes(shallowText)) throw new GitHistoryError('Cannot read the connected repository.');
  const [headOutput, branchOutput, refsOutput] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowMissing: true }),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowMissing: true }),
    // Branch heads are history tips, bounded here; tags only label displayed commits and are read below.
    git(root, ['for-each-ref', `--count=${MAX_REFS + 1}`, '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(symref)%00', 'refs/heads/', 'refs/remotes/']),
  ]);
  const head = headOutput?.trim() || null;
  if (head && !HASH.test(head)) throw new GitHistoryError('Git returned an unreadable HEAD.');
  const branch = branchOutput?.trim() || null;
  const references = readRefs(refsOutput);
  // Managed source files stay pinned to the scanned commit. Their graph follows
  // the fetched branch tip, so Refresh can show new commits without checkout.
  const currentReference = currentRef === null ? null : references.find(ref => ref.name === currentRef && !ref.symbolic && ref.type === 'commit');
  if (scope === 'current' && currentRef !== null && !currentReference) throw new GitHistoryError('The selected GitHub branch is unavailable. Choose another branch.');
  const localBranchCount = references.filter(ref => !ref.symbolic && ref.type === 'commit' && ref.name.startsWith('refs/heads/')).length;
  const remoteBranchCount = references.filter(ref => !ref.symbolic && ref.type === 'commit' && ref.name.startsWith('refs/remotes/')).length;
  const tip = scope === 'current' ? currentReference?.hash || head : head;
  const tips = new Set(tip ? [tip] : []);
  if (scope === 'all') {
    for (const ref of references) {
      if (ref.type === 'commit' && !ref.symbolic && /^refs\/(?:heads|remotes)\//.test(ref.name)) tips.add(ref.hash);
    }
  }
  const [logOutput, tagsOutput] = await Promise.all([
    tips.size ? git(root, [
      'log', '--topo-order', '--no-show-signature', '--no-decorate', '--no-notes', '--no-color',
      `--max-count=${limit + 1}`, '-z', '--format=%H%x00%P%x00%an%x00%cI%x00%s',
      ...tips, '--',
    ]) : Promise.resolve(''),
    git(root, ['show-ref', '--tags', '--dereference'], { allowMissing: true }),
  ]);
  const history = readCommits(logOutput);
  const commits = history.slice(0, limit);
  const displayed = new Map(commits.map(commit => [commit.hash, commit]));
  for (const ref of references) {
    if (ref.symbolic || !/^refs\/(?:heads|remotes)\//.test(ref.name)) continue;
    const commit = displayed.get(ref.hash);
    if (commit) (commit.refs ??= []).push(ref.name.replace(/^refs\/(?:heads|remotes)\//, ''));
  }
  if (head && !branch && displayed.has(head)) (displayed.get(head)!.refs ??= []).unshift('HEAD');
  const refRank = (name: string) => name === branch ? 0 : name === `origin/${branch}` ? 1 : 2;
  for (const commit of commits) commit.refs?.sort((a, b) => refRank(a) - refRank(b) || a.localeCompare(b));
  for (const [name, hash] of readTags(tagsOutput)) {
    const commit = displayed.get(hash);
    if (!commit) continue;
    const tag = name.slice('refs/tags/'.length);
    commit.tag = commit.tag ? `${commit.tag}, ${tag}` : tag;
  }
  return {
    commits, branch,
    repository: parseGitHubRemote(scan.repo.remote) || scan.repo.name || null,
    refCount: localBranchCount + remoteBranchCount, localBranchCount, remoteBranchCount,
    shallow: shallowText === 'true', hasMore: history.length > limit, limit, scope,
    readAt: new Date().toISOString(), source: 'local',
  };
}
