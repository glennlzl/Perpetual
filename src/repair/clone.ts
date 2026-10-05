// The repair's host copy: a fresh clone of the failing commit from the managed source copy (never the user's checkout)
// under <dataDir>/repairs/<id>/clone. The box's diff is applied to its index alone, since a case-insensitive worktree
// such as macOS's cannot hold a case-only rename, then committed as the connected account and pushed to the repair
// branch; this copy alone pushes, and its config holds no remote or credential. It reads names with their case, as the
// Linux box it is copied into does. A pull request head's journey gates scan their own checkout of it beside this copy,
// since this copy's worktree stays at the failing commit.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { SHA, isRepository } from '../github-cli.ts';
import { cloneGitHubSourceCommit, commandEnvironment, gitArgs } from '../github-source.ts';
import { TOO_LARGE } from './box.ts';
import { MANIFESTS, manifestChecksChanged } from './changes.ts';
import { REPAIR_BRANCH, pushRepairBranch, remoteRepairBranch, repairBranch, type CommandRunner } from './github.ts';
import type { Repair } from './manager.ts';

export interface RepairHost {
  clone(input: { repair: Repair; directory: string }): Promise<void>;
  /**
   * Applies a diff against base, exactly as the box wrote it, to the copy's index; returns the changed paths as git names
   * them, git's text diff of the staged change, binary files included, and the manifests whose checks it changed (such
   * as package.json's scripts), for the change rules. A staged change too large to read rejects with `rejected`.
   */
  stage(input: { directory: string; diff: Buffer; base: string }): Promise<{ paths: string[]; text: string; checks: string[] }>;
  /** Commits what stage left on top of parent; null when it equals parent. */
  commit(input: { directory: string; parent: string; message: string; author: { name: string; email: string } }): Promise<string | null>;
  remote(input: { directory: string; repository: string; branch: string; signal?: AbortSignal }): Promise<string | null>;
  push(input: { directory: string; repository: string; branch: string; sha: string; lease: string }): Promise<void>;
  /**
   * A checkout of the pull request head for its journey gates in directory, which it replaces: fetched from the host
   * copy clone's objects, or from GitHub when the copy lacks the commit, such as GitHub's merge of the target branch into
   * the repair branch, and checked out on the repair branch. It has no remote or credential. Returns the path gates scan:
   * its root directory, which must be a directory rather than a link.
   */
  checkout(input: { directory: string; clone: string; repository: string; branch: string; sha: string; rootDirectory: string }): Promise<string>;
}

const exec = promisify(execFile) as CommandRunner;
const FETCH = ['-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--depth', '1'];
/** Bytes of the staged change's text diff read at most. */
const TEXT_LIMIT = 64 * 1024 * 1024;

/** The host copy's git through a runner; tests supply one that records a push instead of reaching GitHub. */
export function createRepairHost({ dataDir, run = exec }: { dataDir: string; run?: CommandRunner }): RepairHost {
  const git = async (directory: string, args: string[], failure: string, env: Record<string, string> = {}, maxBuffer = 16 * 1024 * 1024) => {
    // The private clone can be copied or removed as soon as this command ends; no detached maintenance may outlive it.
    try { return (await run('git', gitArgs(['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', directory, ...args]), { timeout: 120_000, maxBuffer, encoding: 'utf8', windowsHide: true, env: { ...commandEnvironment(), ...env } })).stdout; }
    catch (error) { throw Object.assign(new Error(failure), { code: (error as { code?: unknown }).code }); }
  };
  return {
    async clone({ repair, directory }) {
      const root = repair.rootDirectory.split('/').filter(Boolean);
      const source = { repository: repair.repository, branch: repair.branch, rootDirectory: repair.rootDirectory, checkoutPath: repair.checkoutPath, scanPath: join(repair.checkoutPath, ...root) };
      await cloneGitHubSourceCommit({ source, dataDir, sha: repair.sha, directory, branch: repairBranch(repair.sha) });
      await git(directory, ['config', 'core.ignorecase', 'false'], 'Could not prepare the repair copy.');
      // The checkout's reflog names the host's user, login and hostname, which the box it is copied into never learns.
      await git(directory, ['config', 'core.logAllRefUpdates', 'false'], 'Could not prepare the repair copy.');
      await rm(join(directory, '.git', 'logs'), { recursive: true, force: true });
    },
    async stage({ directory, diff, base }) {
      if (!SHA.test(base)) throw new Error('Invalid base commit.');
      const file = join(dirname(directory), 'change.diff');
      await writeFile(file, diff, { mode: 0o600 });
      await chmod(file, 0o600);
      await git(directory, ['read-tree', base], 'Could not reset the repair copy.');
      await git(directory, ['apply', '--cached', '--binary', '--whitespace=nowarn', '--', file], 'The change does not apply to the failing commit.');
      // Each changed path with its status: added (A), deleted (D) or changed.
      const listed = (await git(directory, ['diff', '--cached', '--name-status', '-z', '--no-renames', base], 'Could not read the change.')).split('\0').filter(Boolean);
      const statuses = new Map<string, string>();
      for (let index = 0; index + 1 < listed.length; index += 2) statuses.set(listed[index + 1], listed[index]);
      const paths = [...statuses.keys()];
      const text = await git(directory, ['diff', '--cached', '--text', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base], 'Could not read the change.', {}, TEXT_LIMIT)
        .catch((error: { code?: unknown }) => { throw error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? Object.assign(new Error(TOO_LARGE), { rejected: true }) : error; });
      // A changed manifest as the failing commit and the staged change hold it, null where it does not exist.
      const blob = (object: string) => git(directory, ['cat-file', 'blob', object], 'Could not read the change.');
      const checks: string[] = [];
      for (const path of paths.filter(path => MANIFESTS.has(posix.basename(path)))) {
        const status = statuses.get(path);
        if (manifestChecksChanged(path, status === 'A' ? null : await blob(`${base}:${path}`), status === 'D' ? null : await blob(`:0:${path}`))) checks.push(path);
      }
      return { paths, text, checks };
    },
    async commit({ directory, parent, message, author }) {
      if (!SHA.test(parent)) throw new Error('Invalid parent commit.');
      await git(directory, ['reset', '--soft', parent], 'Could not prepare the commit.');
      const same = await git(directory, ['diff', '--cached', '--quiet'], '').then(() => true, (error: { code?: unknown }) => { if (error.code === 1) return false; throw new Error('Could not read the change.'); });
      if (same) return null;
      const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
      await git(directory, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', message], 'Could not commit the change.', identity);
      const sha = (await git(directory, ['rev-parse', '--verify', 'HEAD'], 'Could not read the commit.')).trim();
      if (!SHA.test(sha)) throw new Error('Could not read the commit.');
      return sha.toLowerCase();
    },
    remote: input => remoteRepairBranch(input, { run }),
    push: input => pushRepairBranch(input, { run }),
    async checkout({ directory, clone, repository, branch, sha, rootDirectory }) {
      if (!SHA.test(sha)) throw new Error('Invalid pull request head.');
      if (!REPAIR_BRANCH.test(branch)) throw new Error('A repair checks out only its perpetual/repair branch.');
      if (!isRepository(repository)) throw new Error('Choose a GitHub repository from the connected account.');
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
      await git(directory, ['init', '--quiet', '--template='], 'Could not prepare the pull request checkout.');
      // The host copy is Perpetual's own, so the local transport is allowed for this fetch alone, and its upload-pack
      // serves the commit it made.
      const copied = await git(directory, ['-c', 'protocol.file.allow=always', ...FETCH, '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', '--', clone, sha], '').then(() => true, () => false);
      if (!copied) await git(directory, [...FETCH, '--', `https://github.com/${repository}.git`, sha], 'Could not fetch the pull request head from GitHub.');
      await git(directory, ['checkout', '--force', '--quiet', '-B', branch, sha], 'Could not check out the pull request head.');
      if ((await git(directory, ['rev-parse', '--verify', 'HEAD'], 'Could not read the pull request checkout.')).trim().toLowerCase() !== sha.toLowerCase()) throw new Error('The checkout is not at the pull request head.');
      let path = directory;
      for (const part of rootDirectory.split('/').filter(Boolean)) {
        path = join(path, part);
        if (part === '.' || part === '..' || !(await lstat(path).catch(() => null))?.isDirectory()) throw new Error('The root directory is not in the pull request head.');
      }
      return path;
    },
  };
}
