import { useEffect, useRef, useState, type Ref } from 'react';
import { ArrowLeft, ChevronDown, Maximize2, Minimize2, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api } from '@/lib/api';
import { useNow } from '@/lib/use-now';
import { browserJourneySteps, journeyActive, journeyElapsed, journeyErrorTone, journeyProgress, journeyQueueLabel, journeyRecordings, journeyRevision, journeyStreaming, journeySummary, orderJourneys, type CaseSummary, type BrowserRun } from '@/lib/browser-test-ui';
import { createViewFocus } from '@/lib/journey-focus';
import BrowserLiveFrame from './BrowserLiveFrame';
import JourneyCard from './JourneyCard';
import JourneyEvidence, { hasJourneyEvidence } from './JourneyEvidence';
import JourneyRecording from './JourneyRecording';
import JourneySteps, { JourneyBlockers, JourneyMark, JourneySegments } from './JourneySteps';

type JourneyEntry = ReturnType<typeof orderJourneys<CaseSummary>>[number];
type JourneyFocusProps = {
  entry: JourneyEntry; entries: JourneyEntry[]; run: BrowserRun; repoPath: string; stageId: string;
  onSkip?: () => void; skipping: boolean; onSelect: (id: string) => void; onBack: () => void; headingRef: Ref<HTMLHeadingElement>;
};

// One journey fills the viewport with its milestone rail; the others stay live in a compact strip.
function JourneyFocus({ entry, entries, run, repoPath, stageId, onSkip, skipping, onSelect, onBack, headingRef }: JourneyFocusProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const { item, status, label, result } = entry;
  const progress = journeyProgress(run, item.id);
  const steps = browserJourneySteps(item, progress, status);
  const recordings = journeyRecordings({ repoPath, stageId, run, caseId: item.id, status });
  const now = useNow(journeyStreaming(status));
  useEffect(() => {
    const change = () => setFullscreen(Boolean(viewport.current) && document.fullscreenElement === viewport.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void viewport.current?.requestFullscreen?.().catch(() => {});
  }
  const others = entries.filter(other => other !== entry).map(other => ({ ...other, progress: journeyProgress(run, other.item.id) }));
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,45%)] lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-1">
      <div ref={viewport} className="journey-focus-viewport relative flex min-h-0 min-w-0 items-center justify-center bg-background">
        {recordings.length ? <JourneyRecording key={`${run.id}:${item.id}`} variant="focus" urls={recordings} name={item.name} /> : <BrowserLiveFrame variant="focus" repoPath={repoPath} stageId={stageId} runId={run.id} caseId={item.id} name={item.name} status={status} revision={journeyRevision(progress)} updatedAt={progress?.frameCapturedAt || progress?.frameUpdatedAt} />}
        {document.fullscreenEnabled && <Button variant="secondary" size="icon-sm" className="absolute top-3 right-3" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</Button>}
      </div>
      <aside className="min-h-0 space-y-4 overflow-y-auto border-t p-4 lg:border-t-0 lg:border-l" aria-label={`${item.name} milestones`}>
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon-sm" className="-ml-1 shrink-0" aria-label="All journeys" onClick={onBack}><ArrowLeft /></Button>
          <h3 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 break-words text-sm font-medium leading-8 focus:outline-none">{item.name}</h3>
          <Badge variant={status === 'failed' ? 'destructive' : 'outline'} className="mt-1.5 shrink-0"><JourneyMark status={status} />{label}</Badge>
        </div>
        {journeyStreaming(status) && <div className="flex items-start justify-between gap-3 text-xs leading-5 text-muted-foreground"><span className="min-w-0 break-words">{journeySummary(steps, status).text}</span><span className="shrink-0 tabular-nums">{journeyElapsed(progress?.startedAt, now)}</span></div>}
        <JourneySegments steps={steps} />
        <JourneySteps steps={steps} name={item.name} />
        <JourneyBlockers result={result} steps={steps} />
        {(result?.error || progress?.error) && <p className={`break-words text-xs leading-5 ${journeyErrorTone(status)}`}>{result?.error || progress?.error}</p>}
        {progress?.queueReason && status === 'queued' && <Badge variant="outline">{journeyQueueLabel(progress.queueReason)}</Badge>}
        {hasJourneyEvidence(result, progress) && <Collapsible>
          <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 w-full justify-between px-0 text-xs hover:bg-transparent [&[data-state=open]>svg]:rotate-180">Evidence<ChevronDown className="size-3.5 transition-transform" /></Button></CollapsibleTrigger>
          <CollapsibleContent className="pt-1"><JourneyEvidence item={item} result={result} progress={progress} /></CollapsibleContent>
        </Collapsible>}
        {onSkip && journeyActive(status) && <Button variant="outline" size="sm" className="h-8 text-xs" disabled={skipping || ['skipping','cancelling'].includes(status)} onClick={onSkip}><SkipForward />{skipping || status === 'skipping' ? 'Skipping…' : 'Skip'}</Button>}
      </aside>
    </div>
    {!!others.length && <ul className="journey-strip flex shrink-0 gap-3 overflow-x-auto border-t px-5 py-3" aria-label="Other journeys">{others.map(other => <li key={other.item.id} className="shrink-0">
      <Button variant="ghost" className="h-auto w-48 flex-col items-stretch gap-1.5 whitespace-normal p-1.5 text-left" aria-label={`Focus ${other.item.name}: ${other.label}`} onClick={() => onSelect(other.item.id)}>
        <BrowserLiveFrame variant="compact" className="w-full" repoPath={repoPath} stageId={stageId} runId={run.id} caseId={other.item.id} name={other.item.name} status={other.status} revision={journeyRevision(other.progress)} updatedAt={other.progress?.frameCapturedAt || other.progress?.frameUpdatedAt} />
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal"><JourneyMark status={other.status} /><span className="min-w-0 flex-1 truncate">{other.item.name}</span></span>
      </Button>
    </li>)}</ul>}
  </div>;
}

export default function RunJourneyGallery({ run, repoPath, stageId, initialFocus = '' }: { run: BrowserRun; repoPath: string; stageId: string; initialFocus?: string }) {
  const [skipping, setSkipping] = useState('');
  const [error, setError] = useState('');
  const [focusId, setFocusId] = useState(initialFocus);
  const [viewFocus] = useState(createViewFocus);
  useEffect(() => { if (initialFocus) setFocusId(initialFocus); }, [initialFocus]);
  useEffect(() => { viewFocus.settle(); }, [focusId, viewFocus]);
  function show(id: string) { if (id) viewFocus.enter(); else viewFocus.leave(focusId); setFocusId(id); }
  const active = ['queued','running'].includes(run.status);
  const entries = orderJourneys(run.caseSummaries || [], run);
  const focused = entries.find(entry => entry.item.id === focusId);
  async function skip(caseId: string) {
    setSkipping(caseId); setError('');
    try { await api('/api/browser/skip', { repoPath, stageId, id: run.id, caseId }); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSkipping(''); }
  }
  const failure = error && <p role="alert" className="mx-5 mt-4 text-sm text-destructive">{error}</p>;
  if (focused) return <>{failure}<JourneyFocus entry={focused} entries={entries} run={run} repoPath={repoPath} stageId={stageId} onSkip={active ? () => skip(focused.item.id) : undefined} skipping={skipping === focused.item.id} onSelect={show} onBack={() => show('')} headingRef={viewFocus.heading} /></>;
  return <div className="min-h-0 flex-1 overflow-y-auto p-5">
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <div className="grid items-start gap-5 xl:grid-cols-2">{entries.map(({ item, status, label }) => <JourneyCard key={item.id} item={item} run={run} status={status} label={label} repoPath={repoPath} stageId={stageId} onSkip={active ? () => skip(item.id) : undefined} skipping={skipping === item.id} onFocus={() => show(item.id)} focusRef={viewFocus.card(item.id)} />)}</div>
  </div>;
}
