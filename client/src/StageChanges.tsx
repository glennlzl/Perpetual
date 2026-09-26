import { Fragment, useState } from 'react';
import { ChevronDown, Circle, CircleCheck, CircleX, ExternalLink, Eye, LoaderCircle, Sparkles, Square, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { CHANGE_LABELS, MODES, MODE_CHOICES, STEP_LABELS, autopilotBadge, changeActive, isAutopilotMode, saveAutopilotMode, stopChange, type AutopilotChange, type AutopilotTone, type DetailPart, type StageAutopilot, type StepStatus } from '@/lib/pipeline-autopilot.ts';
import { useRememberedOpen } from '@/lib/remembered-open';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';
import { StepItem, StepList } from './StepList';

const STEP_MARKS: Record<Exclude<StepStatus, 'active'>, LucideIcon> = { pending: Circle, done: CircleCheck, failed: CircleX, waiting: Eye };
const CHANGE_MARKS: Record<string, LucideIcon> = { merged: CircleCheck, passed: CircleCheck, 'needs-review': Eye, 'not-merged': CircleX };
const BADGE_MARKS: Record<AutopilotTone, LucideIcon> = { idle: Sparkles, working: LoaderCircle, passed: CircleCheck, blocked: Eye, failed: CircleX };
const BADGE_VARIANTS: Record<AutopilotTone, 'destructive' | 'outline' | 'secondary'> = { idle: 'outline', working: 'secondary', passed: 'secondary', blocked: 'secondary', failed: 'destructive' };
// A fact links only to an https address the controller supplied.
const link = (href: string | undefined) => href && /^https:\/\//.test(href) ? href : '';

// A change's mark on the stage rail reads its end; a step's mark on the nested rail reads its state.
export function ChangeMark({ change }: { change: AutopilotChange }) {
  if (changeActive(change)) return <LoaderCircle className="size-3.5 text-foreground motion-safe:animate-spin" />;
  const Mark = CHANGE_MARKS[change.status] ?? Circle;
  return <Mark className={`size-3.5${change.status === 'not-merged' ? ' text-destructive' : ' text-foreground'}`} />;
}

function StepMark({ status }: { status: StepStatus }) {
  if (status === 'active') return <LoaderCircle className="size-3.5 text-foreground motion-safe:animate-spin" />;
  const Mark = STEP_MARKS[status];
  return <Mark className={`size-3.5${status === 'failed' ? ' text-destructive' : status === 'pending' ? ' text-muted-foreground' : ' text-foreground'}`} />;
}

// A step's detail: text with its facts set in mono chips, as the controller wrote them.
function Detail({ parts }: { parts: DetailPart[] }) {
  return <p className="min-w-0 px-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
    {parts.map((part, index) => typeof part === 'string' ? <Fragment key={index}>{part}</Fragment>
      : link(part.href) ? <Badge key={index} asChild variant="outline" className="px-1.5 py-0 font-mono font-normal"><a href={link(part.href)} target="_blank" rel="noreferrer">{part.text}</a></Badge>
      : <Badge key={index} variant="outline" className="px-1.5 py-0 font-mono font-normal">{part.text}</Badge>)}
  </p>;
}

// Stop ends the change under way; a pull request it opened stays open.
function StopChange({ repoPath, change }: { repoPath: string; change: AutopilotChange }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function stop() {
    setPending(true); setError('');
    try { await stopChange(api, { repoPath, stageId: change.stageId, id: change.id }); }
    catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  }
  return <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 pt-1">
    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={() => void stop()}><Square />Stop</Button>
    {error && <p role="alert" className="basis-full break-words text-xs text-destructive">{error}</p>}
  </div>;
}

// A change on the stage rail: its title and end, and its steps beneath. A change
// under way starts expanded; a viewer's choice is kept for the page session.
export function ChangeRow({ change, repoPath }: { change: AutopilotChange; repoPath?: string }) {
  const [open, setOpen] = useRememberedOpen(`${repoPath}\n${change.stageId}\n${change.id}`, changeActive(change));
  const state = CHANGE_LABELS[change.status];
  return <Collapsible open={open} onOpenChange={setOpen} className="nodrag nopan min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-auto min-h-6 min-w-0 w-full items-start justify-between gap-2 whitespace-normal px-1 py-0.5 text-left leading-5 [&[data-state=open]>svg]:rotate-180" aria-label={`${change.title}, ${state}`} title={change.reason || undefined}>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{change.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">{state}</span>
        <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-1">
      <StepList label={`${change.title} steps`}>
        {change.steps.map(step => <StepItem key={step.id} compact icon={<StepMark status={step.status} />}>
          <p className={`min-w-0 px-1 text-xs font-medium leading-6 [overflow-wrap:anywhere] ${step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>{step.name}<span className="sr-only">, {STEP_LABELS[step.status]}</span></p>
          {step.status !== 'pending' && step.detail?.length ? <Detail parts={step.detail} /> : null}
        </StepItem>)}
      </StepList>
      {changeActive(change) && repoPath && <StopChange repoPath={repoPath} change={change} />}
    </CollapsibleContent>
  </Collapsible>;
}

// The stage's Autopilot Badge: the work under way, the end of the latest change for the scanned commit or the watched
// head, or the mode. It opens the mode menu; a mode that could not be saved says so there.
export function AutopilotBadge({ repoPath, stage, autopilot, sha }: { repoPath?: string; stage: PipelineStage; autopilot: StageAutopilot; sha?: string | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const badge = autopilotBadge(autopilot, sha)!, pullRequest = badge.change?.pullRequest;
  const Mark = BADGE_MARKS[badge.tone];
  async function choose(value: string) {
    if (!isAutopilotMode(value) || value === autopilot.mode || !repoPath) return;
    setPending(true); setError('');
    try { await saveAutopilotMode(api, { repoPath, stageId: stage.id, mode: value }); }
    catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  }
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Badge asChild variant={BADGE_VARIANTS[badge.tone]} className="stage-status nodrag" data-tone={badge.tone}>
        <button type="button" aria-label={`Autopilot for ${stage.name}: ${badge.text}`}>
          {badge.tone === 'working' ? <Spinner role="presentation" aria-label={undefined} aria-hidden="true" /> : <Mark aria-hidden="true" />}{badge.text}{error && <TriangleAlert aria-label="Mode not saved" />}
        </button>
      </Badge>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {error && <DropdownMenuLabel role="alert" className="font-normal text-destructive">{error}</DropdownMenuLabel>}
      <DropdownMenuRadioGroup value={autopilot.mode} onValueChange={value => void choose(value)}>
        {MODES.map(mode => <DropdownMenuRadioItem key={mode} value={mode} disabled={pending}>{MODE_CHOICES[mode]}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {pullRequest && link(pullRequest.url) && <><DropdownMenuSeparator /><DropdownMenuItem asChild><a href={pullRequest.url} target="_blank" rel="noreferrer"><ExternalLink />Open pull request #{pullRequest.number}</a></DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
