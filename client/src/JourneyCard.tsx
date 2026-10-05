import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, LoaderCircle, Maximize2, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { browserJourneySteps, browserRunLabel, journeyActive, journeyCode, journeyErrorTone, journeyOpenByDefault, journeyProgress, journeyQueueLabel, journeyRecordings, journeyRevision, type JourneyDefinition, type BrowserRun, type JourneySpec } from '@/lib/browser-test-ui';
import BrowserLiveFrame from './BrowserLiveFrame';
import JourneyRecording from './JourneyRecording';
import JourneyEvidence, { hasJourneyEvidence } from './JourneyEvidence';
import JourneySteps, { JourneyBlockers, JourneyMark } from './JourneySteps';

// The journey's code: its approved code, the draft beside it and its verification, a running generation, and why a
// verification or generation failed.
function JourneyCode({ spec }: { spec: JourneySpec | null | undefined }) {
  const code = journeyCode(spec);
  if (!code.approved && !code.draft && !code.generating && !code.error) return null;
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-1.5">
      {code.approved && <Badge variant={code.approved === 'Approved' ? 'secondary' : 'outline'}>{code.approved}</Badge>}
      {code.draft && <Badge variant={code.verificationError ? 'destructive' : 'outline'}>{code.verifying && <LoaderCircle className="motion-safe:animate-spin" />}{code.draft}</Badge>}
      {code.generating && <Badge variant="secondary"><LoaderCircle className="motion-safe:animate-spin" />Generating</Badge>}
      {code.error && <Badge variant="destructive">Generation failed</Badge>}
    </div>
    {code.verificationError && <p className="break-words text-xs text-destructive">{code.verificationError}</p>}
    {code.error && <p className="break-words text-xs text-destructive">{code.error}</p>}
  </div>;
}

type JourneyCardProps = {
  item: JourneyDefinition; run: BrowserRun | null | undefined; status: string; label?: string; repoPath: string; stageId: string;
  selection?: ReactNode; actions?: ReactNode; spec?: JourneySpec; onSkip?: () => void; skipping?: boolean;
  onInspect?: () => void; onViewRun?: () => void; onFocus?: () => void; focusRef?: Ref<HTMLButtonElement>; focused?: boolean;
};
export default function JourneyCard({ item, run, status, label, repoPath, stageId, selection, actions, spec, onSkip, skipping, onInspect, onViewRun, onFocus, focusRef, focused = false }: JourneyCardProps) {
  const progress = journeyProgress(run, item.id);
  const statusLabel = label || browserRunLabel(status);
  const badge = <Badge variant={status === 'failed' ? 'destructive' : 'outline'} className="shrink-0"><JourneyMark status={status} />{statusLabel}</Badge>;
  const result = run?.results?.find(value => value.caseId === item.id);
  const steps = browserJourneySteps(item, progress, status);
  const recordings = journeyRecordings({ repoPath, stageId, run, caseId: item.id, status });
  // Only live or failed journeys open by default, as do code being generated and code that failed to generate or
  // verify, since the card's body is where they show; a later start or failure reopens the card.
  const code = journeyCode(spec);
  const attention = journeyOpenByDefault(status) || code.generating || Boolean(code.error || code.verificationError);
  const [open, setOpen] = useState(attention);
  useEffect(() => { if (attention) setOpen(true); }, [attention]);
  // A journey clicked on its stage opens its live card.
  useEffect(() => { if (focused) setOpen(true); }, [focused]);
  return <Card className="journey-card gap-0 overflow-hidden py-0 shadow-none" data-status={status} data-case-id={item.id} data-focused={focused || undefined} tabIndex={-1}>
    <Collapsible open={open} onOpenChange={setOpen}>
      <CardHeader className="flex flex-row flex-wrap items-start gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
          {selection}
          {/* The title opens review/edit; its readable measure takes priority over keeping every control on one row. */}
          <CardTitle className="min-w-0 flex-1 text-sm leading-5 [overflow-wrap:anywhere]">{onInspect
            ? <Button variant="link" className="h-auto min-w-0 max-w-full justify-start whitespace-normal p-0 text-left text-sm leading-5 font-semibold text-foreground" aria-label={`${item.name}: ${item.needsReview ? 'Review' : 'Edit'}`} onClick={onInspect}>{item.name}</Button>
            : item.name}</CardTitle>
        </div>
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
          {onViewRun ? <Button variant="ghost" size="sm" className="h-7 shrink-0 rounded-full px-0.5" aria-label={`View run for ${item.name}: ${statusLabel}`} onClick={onViewRun}>{badge}</Button> : badge}
          {onFocus && <Button ref={focusRef} variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Focus ${item.name}`} onClick={onFocus}><Maximize2 /></Button>}
          {actions}
          <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground [&[data-state=open]>svg]:rotate-180" aria-label={`${item.name} details`}><ChevronDown className="transition-transform" /></Button></CollapsibleTrigger>
        </div>
      </CardHeader>
      <CollapsibleContent>
        {run && (recordings.length ? <JourneyRecording key={`${run.id}:${item.id}`} urls={recordings} name={item.name} /> : <BrowserLiveFrame collapseEmpty repoPath={repoPath} stageId={stageId} runId={run.id} caseId={item.id} name={item.name} status={status} revision={journeyRevision(progress)} updatedAt={progress?.frameCapturedAt || progress?.frameUpdatedAt} />)}
        <CardContent className="space-y-3 px-4 py-4">
          <JourneyCode spec={spec} />
          <JourneySteps steps={steps} name={item.name} />
          <JourneyBlockers result={result} steps={steps} />
          {(result?.error || progress?.error) && <p className={`break-words text-xs leading-5 ${journeyErrorTone(status)}`}>{result?.error || progress?.error}</p>}
          {progress?.queueReason && status === 'queued' && <Badge variant="outline">{journeyQueueLabel(progress.queueReason)}</Badge>}
          {hasJourneyEvidence(result, progress) && <Collapsible>
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 w-full justify-between px-0 text-xs hover:bg-transparent [&[data-state=open]>svg]:rotate-180">Evidence<ChevronDown className="size-3.5 transition-transform" /></Button></CollapsibleTrigger>
            <CollapsibleContent className="pt-1"><JourneyEvidence item={item} result={result} progress={progress} /></CollapsibleContent>
          </Collapsible>}
          {onSkip && journeyActive(status) && <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={skipping || ['skipping','cancelling'].includes(status)} onClick={onSkip}><SkipForward />{skipping || status === 'skipping' ? 'Skipping…' : 'Skip'}</Button>
          </div>}
        </CardContent>
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}
