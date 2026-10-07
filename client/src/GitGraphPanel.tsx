import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitGraph, LoaderCircle, RefreshCw } from 'lucide-react';
import { CommitGraph } from '@/components/commit-graph';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { GitHistoryCache } from '@/lib/git-history-cache';
import { useActionFocus } from '@/lib/journey-focus';
import type { Scan } from './App';
import type { GitHistory } from '../../contract/git-history.ts';
import './branch-map.css';

const HistoryGraph = memo(CommitGraph);

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

export default function GitGraphPanel({ scan, historyCache, headerActions }: { scan: Scan | null; historyCache: GitHistoryCache; headerActions: HTMLDivElement | null }) {
  const [history, setHistory] = useState<GitHistory | undefined>(() => historyCache.peek());
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(!history);
  const [error, setError] = useState('');
  const [pagePending, setPagePending] = useState(false);
  const [pageError, setPageError] = useState('');
  const historyBody = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const pageRetryButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const focusAfterLoad = useRef(0);
  const paging = useRef(false);
  const live = useRef(true);
  const rememberFocus = useActionFocus(loading || pagePending, () => {
    const entries = historyBody.current?.querySelectorAll<HTMLElement>('[data-slot="commit-entry"]');
    return [retryButton.current, pageRetryButton.current, entries?.[Math.min(focusAfterLoad.current, (entries?.length ?? 1) - 1)], refreshButton.current];
  });

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(revision > 0 || !historyCache.peek());
    historyCache.load('current', 100, revision > 0).then(
      value => {
        if (!active) return;
        setHistory(value); setError(''); setPageError(''); setLoading(false);
        if (revision && historyBody.current) historyBody.current.scrollTop = 0;
      },
      (failure: Error) => { if (active) { setError(failure.message); setLoading(false); } },
    );
    return () => { active = false; };
  }, [historyCache, revision]);

  const loadNextPage = useCallback(async (retry = false) => {
    const cursor = history?.nextCursor;
    if (!cursor || loading || paging.current || pageError && !retry) return;
    paging.current = true;
    setPagePending(true);
    try {
      const page = await historyCache.load('current', 100, false, cursor);
      if (live.current) {
        setHistory(previous => previous?.nextCursor === cursor ? { ...page, commits: [...previous.commits, ...page.commits] } : previous);
        setPageError('');
      }
    } catch (failure) { if (live.current) setPageError((failure as Error).message); }
    finally { paging.current = false; if (live.current) setPagePending(false); }
  }, [history?.nextCursor, historyCache, loading, pageError]);

  useEffect(() => {
    if (!history?.nextCursor || loading || pagePending || error || pageError || !historyBody.current || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadNextPage();
    }, { root: historyBody.current, rootMargin: '0px 0px 120px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [history?.nextCursor, loading, pagePending, error, pageError, loadNextPage]);

  const branch = scan?.repo?.branch || history?.branch || 'Detached HEAD';
  const provenance = history ? `${history.source === 'github' ? 'GitHub' : 'Local'} history${history.shallow ? ' · Shallow clone' : ''}` : undefined;
  return <>
    {headerActions && createPortal(<>
      <Badge variant="outline" className="min-w-0 shrink gap-2" aria-label={`History branch: ${branch}`} title={`${branch}${provenance ? ` · ${provenance}` : ''}`}><GitBranch className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{branch}</span></Badge>
      {history?.shallow && <Badge variant="outline">Shallow clone</Badge>}
      <Button ref={refreshButton} variant="ghost" size="icon" className="ml-auto shrink-0" aria-label="Refresh history" title="Refresh history" disabled={loading || pagePending} onClick={() => { rememberFocus(); focusAfterLoad.current = 0; setLoading(true); setRevision(value => value + 1); }}>
        <RefreshCw className={loading ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
      </Button>
    </>, headerActions)}
    <div ref={historyBody} className="inspector-body min-h-0 flex-1 overflow-auto px-4 pb-4" aria-label="Commit history" aria-busy={loading || pagePending}>
      {error && <div className="grid min-w-0 justify-items-start gap-3 py-6"><p className="max-w-full break-words text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]" role="alert">{error}</p><Button ref={retryButton} variant="outline" aria-disabled={loading} aria-busy={loading} className="aria-disabled:opacity-50" onClick={() => { if (!loading) { rememberFocus(); focusAfterLoad.current = 0; setLoading(true); setRevision(value => value + 1); } }}>{loading && <RefreshCw className="motion-safe:animate-spin" aria-hidden="true" />}Retry</Button></div>}
      {!history && loading && !error ? <HistoryLoading /> : history && (history.commits.length
        ? <HistoryGraph commits={history.commits} railWidth={20} className="git-history-graph" />
        : <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-sm text-muted-foreground" role="status"><GitGraph className="size-6" aria-hidden="true" /><p>No commits found</p></div>)}
      {pageError && <div className="grid min-w-0 justify-items-start gap-3 py-4"><p role="alert" className="max-w-full break-words text-sm text-destructive">{pageError}</p><Button ref={pageRetryButton} variant="outline" aria-disabled={pagePending} aria-busy={pagePending} onClick={() => { if (!pagePending) { rememberFocus(); focusAfterLoad.current = history?.commits.length ?? 0; void loadNextPage(true); } }}>{pagePending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}Retry</Button></div>}
      {pagePending && !pageError && <div role="status" className="flex h-10 items-center justify-center text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only">Loading older commits…</span></div>}
      <div ref={sentinel} className="h-px" aria-hidden="true" />
    </div>
  </>;
}
