/** Real repository commits and their observed ancestry, independent of the graph renderer. */
export interface GitCommit { hash: string; message: string; author: { name: string }; date: string; parents: string[]; refs?: string[]; tag?: string }
export interface GitHistory {
  commits: GitCommit[]; branch: string | null; repository: string | null;
  refCount: number; localBranchCount: number; remoteBranchCount: number;
  shallow: boolean; hasMore: boolean; limit: number; scope: string; readAt: string;
  source: 'local' | 'github'; syncedAt?: string;
  /** Current-branch continuation anchored to its first page's tip; null at the end. */
  nextCursor?: string | null;
}
