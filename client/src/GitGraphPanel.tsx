import { useEffect, useRef, useState } from 'react';
import { GitGraph, RefreshCw } from 'lucide-react';
import { CommitGraph, type Commit } from '@/components/commit-graph';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SheetFooter } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { GitGraphHeader } from './InspectorHeaders';
import type { Scan } from './App';
import './branch-map.css';

/** GET /api/git-history: real commits with their parent hashes, and where they were read. */
type GitHistory = { commits: Commit[]; branch?: string | null; repository?: string | null; shallow?: boolean; hasMore?: boolean; source?: string };
type HistoryResult = { key: string; history?: GitHistory; error?: string };

const wrapAtSlash = (value: string | null | undefined) => String(value || '').split('/').flatMap((part, index, parts) => index < parts.length - 1 ? [`${part}/`, <wbr key={index} />] : [part]);

function HistoryLoading() {
  return <div role="status">
    <span className="sr-only">Loading history…</span>
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="flex h-10 items-center gap-3 border-b border-border/30 px-3 last:border-b-0">
        <Skeleton className="size-2 shrink-0 rounded-full" />
        <Skeleton className={index % 3 === 0 ? 'h-3 w-3/5' : 'h-3 w-2/5'} />
        <Skeleton className="ml-auto h-3 w-12 shrink-0" />
      </div>)}
    </div>
  </div>;
}

export default function GitGraphPanel({ scan, onClose, showHeader = true }: { scan: Scan | null; onClose: () => void; showHeader?: boolean }) {
  const [scope, setScope] = useState('current');
  const [limit, setLimit] = useState(100);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<HistoryResult | null>(null);
  const syncedRevision = useRef(0);
  const historyBody = useRef<HTMLDivElement>(null);
  const focusAfterLoad = useRef<number | null>(null);
  const repoPath = scan?.repo?.path;
  const requestKey = JSON.stringify([repoPath, scan?.scannedAt, scope, limit, revision]);
  const loading = result?.key !== requestKey;
  const history = !loading ? result?.history : null;
  const error = !loading ? result?.error : null;

  useEffect(() => {
    let active = true;
    if (!repoPath) {
      setResult({ key: requestKey, error: 'Connect a repository to view its history.' });
      return;
    }
    const params = new URLSearchParams({ repoPath, scope, limit: String(limit) });
    if (syncedRevision.current !== revision) params.set('refresh', '1');
    syncedRevision.current = revision;
    api<GitHistory>(`/api/git-history?${params}`).then(
      history => { if (active) setResult({ key: requestKey, history }); },
      (failure: Error) => { if (active) setResult({ key: requestKey, error: failure.message }); },
    );
    return () => { active = false; };
  }, [repoPath, scope, limit, revision, requestKey]);

  // The footer unmounts while more history loads; focus resumes on the first new commit.
  useEffect(() => {
    if (loading || focusAfterLoad.current === null) return;
    const entries = historyBody.current?.querySelectorAll<HTMLElement>('[data-slot="commit-entry"]');
    entries?.[Math.min(focusAfterLoad.current, entries.length - 1)]?.focus();
    focusAfterLoad.current = null;
  }, [loading]);

  return <>
    {showHeader && <GitGraphHeader onClose={onClose} />}
    {/* One row down to 375px; a long repository name wraps inside its badge, after the slash first. */}
    <div className="git-graph-toolbar flex items-center gap-2 px-4">
      <Badge variant="outline" className="min-w-0 shrink whitespace-normal text-left"><span className="min-w-0 [overflow-wrap:anywhere]">{wrapAtSlash(history?.repository || scan?.repo?.name)}</span></Badge>
      <Select value={scope} onValueChange={value => { focusAfterLoad.current = null; setScope(value); setLimit(100); }}>
        <SelectTrigger className="ml-auto w-auto shrink-0 sm:w-40" aria-label="History branches"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All branches</SelectItem>
          <SelectItem value="current">Current branch</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" className="size-10 shrink-0" aria-label="Refresh history" title="Refresh history" disabled={loading} onClick={() => setRevision(value => value + 1)}>
        <RefreshCw className="size-4" />
      </Button>
    </div>
    <div ref={historyBody} className="inspector-body min-h-0 flex-1 overflow-auto px-4 pb-4" aria-busy={loading}>
      {loading ? <HistoryLoading />
        : error ? <div className="grid min-w-0 justify-items-start gap-3 py-6"><p className="max-w-full break-words text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]" role="alert">{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>
        : history && (history.commits.length
          ? <CommitGraph commits={history.commits} railWidth={20} className="git-history-graph" />
          : <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-sm text-muted-foreground" role="status"><GitGraph className="size-6" aria-hidden="true" /><p>No commits found</p></div>)}
    </div>
    {/* The footer carries provenance only, so it appears with the history. */}
    {history && <SheetFooter className="flex-row flex-wrap items-center justify-between border-t">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
        <span className="tabular-nums">{history.source === 'github' ? 'GitHub history' : 'Local history'} · {history.commits.length} {history.commits.length === 1 ? 'commit' : 'commits'}</span>
        {history.shallow && <Badge variant="outline">Shallow clone</Badge>}
        <Badge variant="secondary" className="max-w-full whitespace-normal break-all text-left">{history.branch || 'Detached HEAD'}</Badge>
        {history.hasMore && limit >= 500 && <span>500-commit limit</span>}
      </div>
      {history.hasMore && limit < 500 && <Button variant="outline" size="sm" onClick={() => { focusAfterLoad.current = history.commits.length; setLimit(value => Math.min(value + 100, 500)); }}>Load more</Button>}
    </SheetFooter>}
  </>;
}
