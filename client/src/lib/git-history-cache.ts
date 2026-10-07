import { api } from './api.ts';
import type { GitHistory } from '../../../contract/git-history.ts';

type Scope = 'current' | 'all';
type Entry = { history?: GitHistory; pending?: Promise<GitHistory> };

/** One source snapshot's history, shared by its background preload and inspector. */
export function createGitHistoryCache(repoPath: string | undefined, read: (path: string) => Promise<GitHistory> = api) {
  const entries = new Map<string, Entry>();
  const key = (scope: Scope, limit: number, cursor = '') => `${scope}:${limit}:${cursor}`;
  return {
    peek(scope: Scope = 'current', limit = 100) { return entries.get(key(scope, limit))?.history; },
    load(scope: Scope = 'current', limit = 100, refresh = false, cursor = ''): Promise<GitHistory> {
      if (!repoPath) return Promise.reject(new Error('Connect a repository to view its history.'));
      // A refresh changes the remote tips for every scope and page. An older request
      // may finish, but its detached entry can never overwrite the refreshed cache.
      if (refresh) entries.clear();
      const id = key(scope, limit, cursor), previous = entries.get(id);
      if (previous?.pending) return previous.pending;
      if (previous?.history) return Promise.resolve(previous.history);
      const params = new URLSearchParams({ repoPath, scope, limit: String(limit) });
      if (refresh) params.set('refresh', '1');
      if (cursor) params.set('cursor', cursor);
      const entry: Entry = {};
      entries.set(id, entry);
      entry.pending = read(`/api/git-history?${params}`).then(history => {
        entry.history = history;
        entry.pending = undefined;
        return history;
      }, failure => {
        if (entries.get(id) === entry) entries.delete(id);
        throw failure;
      });
      return entry.pending;
    },
  };
}

export type GitHistoryCache = ReturnType<typeof createGitHistoryCache>;
