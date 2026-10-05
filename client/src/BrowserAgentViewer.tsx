import { useEffect, useRef, useState } from 'react';
import { Ban, Check, ChevronDown, Circle, CircleX, LoaderCircle, Monitor, Square, X } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { api, replyError, type ApiError } from '@/lib/api';
import { useReturnFocus } from '@/lib/journey-focus';
import RunJourneyGallery from './RunJourneyGallery';
import { CHECKS, browserActionFailure, browserActionLabel, browserConcurrencyLabel, browserRunLabel, browserRunTitle, checkedOutcome, journeyCheckFailed, journeyCheckState, type BrowserAction, type BrowserCase } from '@/lib/browser-test-ui';

// A finished run's frame is its last one, never a paused stream, so it says when the run ended.
const endedLabel = (at: string | undefined) => { const time = at ? new Date(at) : null; return time && !Number.isNaN(time.getTime()) ? `Ended ${time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Ended'; };

/** GET /api/browser/runs/:id: the run with its full progress and results. */
import type { RunProgressReply as RunSnapshot } from '../../contract/browser.ts';
export type { RunProgressReply as RunSnapshot } from '../../contract/browser.ts';
// A journey as the activity list shows it: live progress, or a result once progress is gone. Older runs reported
// their actions as steps.
type ViewerAction = Pick<BrowserAction, 'status'> & Partial<Omit<BrowserAction, 'status'>>;
type ViewerCase = { id?: string; caseId?: string; name?: string; status: string; error?: string; actions?: ViewerAction[]; steps?: ViewerAction[] };
type BrowserAgentViewerProps = {
  repoPath: string; stageId: string; runId?: string | null; mode?: 'run' | 'discover'; cases?: BrowserCase[]; focusCaseId?: string; startingError?: string;
  focusFallback?: Parameters<typeof useReturnFocus>[0]; onClose: () => void; onFinished?: (snapshot: RunSnapshot) => void; onTestSettings?: () => void;
};

const ACTIVE = new Set(['queued', 'running']);
function Mark({ status }: { status: string | undefined }) {
  const Icon = status === 'running' ? LoaderCircle : status === 'passed' || status === 'completed' ? Check : status === 'failed' ? CircleX : status === 'blocked' ? Ban : Circle;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${status === 'running' ? 'motion-safe:animate-spin' : ''} ${status === 'failed' ? 'text-destructive' : ''}`} />;
}

export default function BrowserAgentViewer({ repoPath, stageId, runId, mode = 'run', cases = [], focusCaseId = '', startingError = '', focusFallback, onClose, onFinished, onTestSettings }: BrowserAgentViewerProps) {
  const returnFocus = useReturnFocus(focusFallback);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState('');
  // A run the stage does not have, or a read the controller refuses, never appears by reading again.
  const [unavailable, setUnavailable] = useState(false);
  // Kept apart from read errors, so the next successful read does not clear why Cancel run failed.
  const [stopError, setStopError] = useState('');
  const [frame, setFrame] = useState('');
  const [frameError, setFrameError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const active = useRef(true);
  const imageUrl = useRef('');
  const finishedCallback = useRef(onFinished);
  finishedCallback.current = onFinished;
  const currentAction = useRef<HTMLLIElement>(null);

  useEffect(() => {
    setSnapshot(null); setError(''); setUnavailable(false); setFrame(''); setFrameError('');
    active.current = true;
    if (!runId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`/api/browser/runs/${encodeURIComponent(runId!)}?${new URLSearchParams({ repoPath, stageId })}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), cache: 'no-store',
        });
        const reply: unknown = await response.json();
        if (!response.ok) throw Object.assign(new Error(replyError(reply) || 'Could not load this run.'), { statusCode: response.status });
        const next = reply as RunSnapshot; // the run route's reply, as the controller defines it
        if (cancelled) return;
        setSnapshot(next); setError('');
        if (!ACTIVE.has(next.run.status)) {
          active.current = false;
          finishedCallback.current?.(next);
          return;
        }
      } catch (failure) {
        if (cancelled) return;
        setError((failure as Error).message);
        const status = (failure as ApiError).statusCode;
        if (status >= 400 && status < 500) { active.current = false; setUnavailable(true); return; }
      }
      if (!cancelled) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [repoPath, stageId, runId]);

  useEffect(() => {
    if (!runId || (mode === 'run' && snapshot?.run?.concurrency)) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function capture() {
      try {
        const response = await fetch(`/api/browser/runs/${encodeURIComponent(runId!)}/frame?${new URLSearchParams({ repoPath, stageId })}`, {
          headers: { Accept: 'image/jpeg' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (response.status !== 204) {
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Browser stream unavailable.');
          const blob = await response.blob();
          if (cancelled) return;
          const previous = imageUrl.current;
          imageUrl.current = URL.createObjectURL(blob);
          setFrame(imageUrl.current); setFrameError('');
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch (failure) { if (cancelled) return; setFrameError((failure as Error).message); }
      if (!cancelled && active.current) timer = setTimeout(capture, 250);
    }
    void capture();
    return () => {
      cancelled = true; clearTimeout(timer); controller.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = '';
    };
  }, [repoPath, stageId, runId, mode, snapshot?.run?.concurrency]);

  const run = snapshot?.run;
  const finished = Boolean(run && !ACTIVE.has(run.status));
  const approvedCases = run?.caseSummaries || (run ? [] : cases);
  const freshFrame = Boolean(run?.frameUpdatedAt && Date.now() - new Date(run.frameUpdatedAt).getTime() < 3000);
  const progressCases = snapshot?.progress?.cases || [];
  const displayedCases: ViewerCase[] = progressCases.length ? progressCases : (snapshot?.results || []).map(item => ({ ...item, name: approvedCases.find(value => value.id === item.caseId)?.name || item.caseId }));
  const evidenceOnly = finished && !frame;
  const casePriority = (item: ViewerCase) => {
    const result = snapshot?.results?.find(value => value.caseId === (item.caseId || item.id));
    if (item.status === 'failed' || result?.status === 'failed' || result?.assertions?.some(journeyCheckFailed)) return 0;
    if (item.status === 'blocked' || result?.status === 'blocked') return 1;
    if (item.status === 'needs_review' || result?.status === 'needs_review') return 2;
    return 3;
  };
  const orderedCases = finished ? [...displayedCases].sort((a, b) => casePriority(a) - casePriority(b)) : displayedCases;
  const current = displayedCases.find(item => item.status === 'running');
  const actions: ViewerAction[] = current?.actions || current?.steps || [];
  useEffect(() => { currentAction.current?.scrollIntoView({ block: 'nearest' }); }, [current?.caseId, actions.length, actions.at(-1)?.status]);

  async function stop() {
    setStopping(true); setStopError('');
    try { await api('/api/browser/stop', { repoPath, stageId, id: runId }); }
    catch (failure) { setStopError((failure as Error).message); }
    finally { setStopping(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={false} onCloseAutoFocus={returnFocus} className="browser-agent-viewer flex h-[min(90dvh,960px)] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1440px]">
      <DialogHeader className="shrink-0 flex-row flex-wrap items-start gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <Monitor className="mt-0.5 size-5 shrink-0" /><DialogTitle className="min-w-0 flex-1 text-left [overflow-wrap:anywhere]">{run ? browserRunTitle(run) : mode === 'discover' ? 'Explore product' : 'Browser test'}</DialogTitle>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {run?.verification?.control && <Badge variant="outline">Control</Badge>}
          {browserConcurrencyLabel(run) && <Badge variant="outline">{browserConcurrencyLabel(run)}</Badge>}
          {!unavailable && <Badge variant={run?.status === 'failed' || startingError ? 'destructive' : 'secondary'}>{startingError ? 'Failed' : error ? 'Reconnecting' : run ? browserRunLabel(run) : 'Starting'}</Badge>}
          {startingError && mode === 'discover' && onTestSettings && <Button size="sm" variant="outline" onClick={onTestSettings}>Test settings</Button>}
          {/* Cancelling stops every journey in the run, so it is confirmed with Keep running focused first. */}
          {!finished && !startingError && !unavailable && <AlertDialog open={confirmingStop} onOpenChange={setConfirmingStop}>
            <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={!runId || stopping}><Square />{stopping ? 'Cancelling…' : 'Cancel run'}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Cancel run?</AlertDialogTitle><AlertDialogDescription className="break-words">{run ? browserRunTitle(run) : mode === 'discover' ? 'Explore product' : 'Browser test'}</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { void stop(); }}>Cancel run</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>}
          {/* Closing only hides the viewer; the run keeps going until Cancel run. */}
          <DialogClose asChild><Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Close viewer"><X /></Button></DialogClose>
        </div>
      </DialogHeader>
      {(startingError || stopError || error || run?.error) && <p role="alert" className="border-b px-5 py-3 text-sm text-destructive">{startingError || stopError || error || run?.error}</p>}
      {run?.concurrency ? <RunJourneyGallery run={run} repoPath={repoPath} stageId={stageId} initialFocus={focusCaseId} /> : <div className={evidenceOnly ? "flex min-h-0 flex-1" : "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_200px] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1"}>
        {!evidenceOnly && <div className="relative flex min-h-0 min-w-0 items-center justify-center bg-background">
          {frame ? <img src={frame} alt={finished ? 'Final browser state' : 'Live browser viewport'} className="h-full w-full object-contain" />
            : <span role="status" className="text-sm text-muted-foreground">{startingError ? 'Browser not started' : finished || unavailable ? 'No browser frame' : 'Opening browser…'}</span>}
          {frame && <Badge variant="secondary" className="absolute bottom-3 left-3">{finished ? endedLabel(run?.completedAt) : frameError || error ? 'Reconnecting' : freshFrame ? 'Live' : 'Waiting for frame'}</Badge>}
          {frameError && <p role="status" className="absolute bottom-3 right-3 rounded bg-background px-3 py-2 text-sm text-destructive">{frameError}</p>}
        </div>}
        <aside className={`min-h-0 w-full overflow-y-auto ${evidenceOnly ? "" : "border-t lg:border-t-0 lg:border-l"}`} aria-label="Agent activity">
          <div className="sticky top-0 z-10 flex items-center justify-between bg-background px-4 py-3"><span className="text-sm font-medium">{mode === 'discover' ? 'Exploration' : 'Cases'}</span></div><Separator />
          {!displayedCases.length && !unavailable && <p role="status" className="p-4 text-sm text-muted-foreground">{finished ? (run!.status === 'completed' ? 'Cases ready for review' : browserRunLabel(run!.status)) : 'Waiting for agent'}</p>}
          {orderedCases.map((item, index) => {
            const caseId = item.caseId || item.id;
            const approved = approvedCases.find(value => value.id === caseId);
            const result = snapshot?.results?.find(value => value.caseId === caseId);
            const actionList = <ol className="space-y-1">{(item.actions || item.steps || []).map((action, actionIndex, all) => <li key={action.index ?? actionIndex} ref={item.status === 'running' && actionIndex === all.length - 1 ? currentAction : null} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${action.status === 'running' ? 'bg-accent' : ''}`}><Mark status={action.status} /><span>{browserActionLabel(action.type)}</span>{browserActionFailure(action) ? <span className="text-xs text-destructive">{browserActionFailure(action)}</span> : <span className="sr-only">{browserRunLabel(action.status)}</span>}</li>)}</ol>;
            return <section key={caseId || index} className={`space-y-4 border-b p-4 last:border-0 ${evidenceOnly ? "sm:px-8 sm:py-6" : ""}`}>
              <div className="flex items-start gap-2"><Mark status={item.status} /><h3 className="min-w-0 flex-1 break-words text-sm font-medium">{item.name || approved?.name || 'Explore product'}</h3><Badge variant={item.status === 'failed' ? 'destructive' : 'outline'}>{browserRunLabel(item.status)}</Badge></div>
              {snapshot?.discovery?.summary && <p className="max-w-[75ch] whitespace-pre-wrap break-words text-sm text-muted-foreground">{snapshot.discovery.summary}</p>}
              {/* The reviewed checks alone back the expected outcomes. */}
              {!!approved?.expectedOutcomes?.length && <div className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">Expected outcomes</h4><ul className="space-y-3 text-sm">{approved.expectedOutcomes.map((outcome, outcomeIndex) => <li key={outcomeIndex} className="space-y-1.5 break-words"><p className="max-w-[75ch]">{outcome}</p>{result?.engine === 'playwright' && <Badge variant={checkedOutcome(result).variant}>{checkedOutcome(result).label}</Badge>}</li>)}</ul></div>}

              {!!result?.assertions?.length && <div className="space-y-2 border-t pt-3"><h4 className="text-xs font-medium text-muted-foreground">Final checks</h4><ul className="space-y-2 text-sm">{result.assertions.map((assertion, assertionIndex) => { const state = journeyCheckState(assertion); return <li key={assertionIndex} className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words">{CHECKS[assertion.type ?? ''] || assertion.type}: {assertion.value}</span><Badge variant={state.variant} className="shrink-0">{state.label}</Badge></li>; })}</ul></div>}
              {(item.error || result?.error) && <p className="break-words text-sm text-destructive">{item.error || result!.error}</p>}
              {!!(item.actions || item.steps || []).length && (finished
                ? <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between px-0 [&[data-state=open]>svg]:rotate-180">Actions ({(item.actions || item.steps || []).length})<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent>{actionList}</CollapsibleContent></Collapsible>
                : actionList)}
            </section>;
          })}
        </aside>
      </div>}
    </DialogContent>
  </Dialog>;
}
