import type { GitHubSource } from '../../../contract/github.ts';

// Mirrors sourceRoot in src/github-source.ts: / is the repository root, not the host filesystem.
export function rootDirectoryError(value: string) {
  const path = value.trim();
  if (path.includes('\\')) return 'Use forward slashes, such as /apps/web.';
  if (path.length > 2048) return 'Use a path under 2,048 characters.';
  if (/[\u0000-\u001f\u007f]/u.test(path)) return 'Remove control characters.';
  const parts = path.split('/');
  if (parts.some(part => part === '.' || part === '..')) return 'Remove . and .. segments.';
  if (parts.some(part => part.toLowerCase() === '.git')) return 'Choose a folder outside .git.';
  return '';
}

export function normalizedRoot(value: string | null = '/') {
  const parts = String(value ?? '/').trim().split('/').filter(Boolean);
  return parts.length ? `/${parts.join('/')}` : '/';
}

// Keep the current choice, then the saved or scanned branch even when GitHub lacks it.
export function initialBranch({ previous = '', preferred = '', defaultBranch = '', names = [] }: { previous?: string; preferred?: string; defaultBranch?: string | null; names?: string[] }) {
  const available = new Set(names);
  if (previous && available.has(previous)) return previous;
  if (preferred) return preferred;
  if (defaultBranch && available.has(defaultBranch)) return defaultBranch;
  return names[0] || '';
}

/** A saved GitHub source: its repository, branch and root directory, and the managed copy's path once scanned. */
export type SavedSource = Partial<Pick<GitHubSource, 'repository' | 'branch' | 'rootDirectory' | 'scanPath'>>;
// The canvas reads a managed GitHub copy only when the saved source scanned this exact path.
export function readsLocalCheckout(source: SavedSource | null | undefined, scanPath: string | null | undefined) {
  return Boolean(scanPath) && source?.scanPath !== scanPath;
}

// `current` is the saved source, or the scanned checkout when none is saved. While
// the canvas reads a local checkout, its GitHub copy is a change even at the same branch.
export function sourceChange({ current = null, local = false, repository = '', branch = '', rootDirectory = '/', branches = [] }: { current?: SavedSource | null; local?: boolean; repository?: string; branch?: string; rootDirectory?: string; branches?: string[] }) {
  const onGitHub = Boolean(branch) && branches.includes(branch);
  const changed = !current?.repository
    || local && onGitHub
    || repository.toLowerCase() !== current.repository.toLowerCase()
    || branch !== (current.branch || '')
    || normalizedRoot(rootDirectory) !== normalizedRoot(current.rootDirectory);
  return { changed, onGitHub };
}

// The branch switcher moves to a branch GitHub has; the scanned branch counts only
// when the canvas reads the local checkout, which switches it to the GitHub copy.
export function canSwitchBranch({ value = '', branch = '', local = false, branches = [] }: { value?: string; branch?: string; local?: boolean; branches?: string[] }) {
  return Boolean(value) && branches.includes(value) && (local || value !== branch);
}

// Middle truncation keeps a branch's distinctive end: only the head gives way. The
// tail starts after a nearby separator when there is one, so it reads as whole words.
export function nameParts(name: string | null = '', tail = 12): [string, string] {
  const chars = [...String(name ?? '')];
  if (chars.length <= tail) return [chars.join(''), ''];
  const at = chars.length - tail;
  const split = [0, -1, 1, -2, 2, -3, 3, -4, 4].map(offset => at + offset)
    .find(index => index > 1 && index < chars.length && /[-/_.]/u.test(chars[index - 1])) ?? at;
  return [chars.slice(0, split).join(''), chars.slice(split).join('')];
}
