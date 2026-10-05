import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item';
import { api, sourceBusy } from '@/lib/api';
import { inspectorTab } from '@/lib/browser-test-ui';
import { targetSuggestions } from '@/lib/journey-config';
import { latestEnvironment } from '@/lib/environment-view';
import { useSourceBranch, useSourcePreviews, useTestStage } from '@/lib/use-test-workspace';
import BrowserTestingPanel from './BrowserTestingPanel';
import { EnvironmentHeader } from './InspectorHeaders';
import type { Environment } from '@/lib/test-workspace';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';
import type { EnvironmentLogs } from '../../contract/environment.ts';

export function safeLink(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value, window.location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function EnvironmentProgress({ environment, repoPath, stageId, busy, onStop }: {
  environment: Environment; repoPath: string; stageId: string; busy: boolean; onStop: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false), [logs, setLogs] = useState(''), [error, setError] = useState('');
  const creating = ['queued', 'creating', 'preparing'].includes(environment.status), stopping = creating && Boolean(environment.cancellationRequestedAt);
  const stopped = environment.status === 'failed' && environment.step === 'Stopped';
  const step = creating ? environment.step : stopped ? undefined : environment.failedStep;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const reply = await api<EnvironmentLogs>('/api/environments/logs', { repoPath, stageId, id: environment.id }, { signal: controller.signal });
        if (!controller.signal.aborted) { setLogs(reply.logs); setError(''); }
      } catch (failure) { if (!controller.signal.aborted && !sourceBusy(failure)) setError((failure as Error).message); }
      if (creating && !controller.signal.aborted) timer = setTimeout(read, 2000);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, creating, environment.id, repoPath, stageId]);
  return <div className="mb-4 min-w-0 space-y-2">
    {(step || creating) && <Item size="sm" className="px-0 py-1">
      <ItemContent><ItemTitle className="break-words" aria-live="polite">{step || 'Queued'}</ItemTitle></ItemContent>
      {creating && <ItemActions><Button size="sm" variant="outline" disabled={busy || stopping} onClick={() => { setError(''); void onStop().catch(failure => setError((failure as Error).message)); }}>Stop</Button></ItemActions>}
    </Item>}
    {(environment.error || environment.cleanupError || error) && <p role={stopped && !environment.cleanupError && !error ? 'status' : 'alert'} className={`break-words text-sm ${stopped && !environment.cleanupError && !error ? 'text-muted-foreground' : 'text-destructive'}`}>{[environment.error, environment.cleanupError, error].filter(Boolean).join('\n')}</p>}
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild><Button size="sm" variant="ghost" className="px-0">Logs<ChevronDown className={open ? 'rotate-180' : undefined} /></Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {environment.attempts?.map(attempt => <Item key={attempt.attempt} size="sm" className="px-0 py-1"><ItemContent>
          <ItemTitle>Attempt {attempt.attempt}</ItemTitle><p className="break-words text-sm text-muted-foreground">{attempt.summary}</p>
        </ItemContent></Item>)}
        {environment.timings?.map((timing, index) => <div key={index} className="flex items-start justify-between gap-3 text-sm text-muted-foreground"><span className="break-words">{timing.step}</span><span className="shrink-0 tabular-nums">{(timing.ms / 1000).toFixed(1)}s</span></div>)}
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm">{logs || 'No logs yet.'}</pre>
      </CollapsibleContent>
    </Collapsible>
  </div>;
}

type EnvironmentSettingsProps = {
  repoPath?: string; stage?: PipelineStage; initialTab?: string; initialError?: string; initialWatch?: boolean; initialRunId?: string; initialCaseId?: string; caseRequestKey?: number | string;
  onClose: () => void; onBusyChange?: (busy: boolean) => void; onAppSettings?: () => void; busy?: boolean; showHeader?: boolean;
};
export default function EnvironmentSettings({ repoPath, stage, initialTab = 'browser', initialError = '', initialWatch = false, initialRunId = '', initialCaseId = '', caseRequestKey = '', onClose, onBusyChange, onAppSettings, busy = false, showHeader = true }: EnvironmentSettingsProps) {
  // Each graph request selects its tab during render, so the panel never handles it against the other view.
  const [tabState, setTabState] = useState(() => inspectorTab(null, initialTab, caseRequestKey));
  const requested = inspectorTab(tabState, initialTab, caseRequestKey);
  if (requested !== tabState) setTabState(requested);
  const tab = requested.tab;
  const validStage = stage?.kind === 'sandbox' && Boolean(repoPath);
  const [workspace, snapshot] = useTestStage(stage?.id, validStage ? ['environment'] : []);
  const previews = useSourcePreviews();
  const branch = useSourceBranch();
  const current = latestEnvironment(snapshot.environment.environments);
  const suggestions = useMemo(() => targetSuggestions({ environment: current, previews, branch }), [current, previews, branch]);
  const disabled = busy || Boolean(snapshot.pending);

  return <>
    {showHeader && <EnvironmentHeader repoPath={repoPath} stage={stage} busy={disabled} onClose={onClose} />}
    <Tabs value={tab} onValueChange={value => setTabState({ ...requested, tab: value })} className="min-h-0 min-w-0 flex-1 gap-0">
      <TabsList variant="line" className="mx-4 w-auto shrink-0 justify-start group-data-[orientation=horizontal]/tabs:h-auto" aria-label="Test views">
        <TabsTrigger value="browser" className="h-9 flex-none">Integration tests</TabsTrigger>
        <TabsTrigger value="browser-runs" className="h-9 flex-none">Runs</TabsTrigger>
      </TabsList>
      <div className="inspector-body min-h-0 flex-1 overflow-y-auto p-4">
        {!validStage ? <p role="alert" className="break-words text-sm text-destructive">Choose a Sandbox stage.</p> : <TabsContent value={tab} forceMount className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {current && <EnvironmentProgress key={current.id} environment={current} repoPath={repoPath!} stageId={stage.id} busy={disabled}
            onStop={() => workspace.perform('environment', 'cancel', tx => tx.post('cancel', { id: current.id }))} />}
          <BrowserTestingPanel
            repoPath={repoPath!}
            stageId={stage.id}
            busy={disabled}
            view={tab === 'browser-runs' ? 'runs' : 'tests'}
            environmentStatus={current?.status}
            targetSuggestions={suggestions}
            environmentError={initialError}
            initialRunId={initialWatch ? initialRunId : ''}
            initialWatch={initialWatch}
            initialCaseId={initialCaseId}
            caseRequestKey={caseRequestKey}
            onAppSettings={onAppSettings}
            onBusyChange={onBusyChange}
          />
        </TabsContent>}
      </div>
    </Tabs>
  </>;
}
