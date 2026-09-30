import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, ListChecks, LoaderCircle, RotateCw, Terminal, Workflow, Wrench, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { repairOffer, startRepair, type StageAutopilot } from '@/lib/pipeline-autopilot.ts';
import { GITHUB_MARK_LABELS, actionLabel, actionText, buildChanges, buildWorkflowRows, combinedMark, githubMark, type BuildReply, type ConfiguredWorkflow, type GitHubMark, type GitHubRun } from '@/lib/pipeline-github.ts';
import { useRememberedOpen } from '@/lib/remembered-open';
import { StepItem, StepList } from './StepList';

const MARKS: Record<Exclude<GitHubMark, 'running'>, LucideIcon> = { queued: CircleDashed, waiting: CircleDashed, passed: CircleCheck, failed: CircleX, cancelled: CircleSlash, skipped: CircleMinus };
const withMark = (label: string, mark: GitHubMark | null) => mark ? `${label}, ${GITHUB_MARK_LABELS[mark]}` : label;

// Current-commit run status on the configured rail; unmatched rows keep their icon.
function RunMark({ mark, fallback }: { mark: GitHubMark | null; fallback: ReactElement }) {
  if (!mark) return fallback;
  if (mark === 'running') return <LoaderCircle className="size-3.5 text-foreground motion-safe:animate-spin" />;
  const Mark = MARKS[mark];
  return <Mark className={`size-3.5${mark === 'failed' ? ' text-destructive' : mark === 'passed' ? ' text-foreground' : ''}`} />;
}

// Short action refs and expression contexts; the title keeps the scanned text.
// Labels wrap at max-w-64 rather than widening the stage card.
function ActionName({ value, fallback }: { value: string; fallback?: string }) {
  const { text, ref, contexts } = actionLabel(value, fallback);
  return <>{text}{ref && <>{' '}<span className="font-mono text-muted-foreground">{ref}</span></>}{contexts.map(context => <Fragment key={context}>{' '}<Badge variant="outline" className="px-1.5 py-0 font-mono font-normal">{context}</Badge></Fragment>)}</>;
}

function ActionGroup({ openKey, name, fallback, label, aside, children, literal = false }: { openKey: string; name: string; fallback?: string; label: string; aside?: ReactNode; children: ReactNode; literal?: boolean }) {
  const [open, setOpen] = useRememberedOpen(openKey);
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-auto min-h-6 min-w-0 w-full items-start justify-between gap-2 whitespace-normal px-1 py-0.5 text-left leading-5 [&[data-state=open]>svg]:rotate-180" aria-label={label} title={name}>
        <span className="min-w-0 max-w-64 flex-1 [overflow-wrap:anywhere]">{literal ? name : <ActionName value={name} fallback={fallback} />}</span><ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform" />
      </Button>
    </CollapsibleTrigger>
    {aside}
    <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
  </Collapsible>;
}

// Repair hands a failed run at the watched head to Autopilot, named by the head's short commit when the runs shown are
// another commit's; the change then appears on the stage rail, where Stop is.
function WorkflowRepair({ repoPath, stageId, offer }: { repoPath?: string; stageId?: string; offer: ReturnType<typeof repairOffer> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!offer && !error) return null;
  async function repair() {
    if (!offer || !repoPath || !stageId) return;
    setPending(true); setError('');
    try { await startRepair(api, { repoPath, stageId, runId: offer.runId }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not start the repair.'); }
    finally { setPending(false); }
  }
  return <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 pb-1">
    {offer && <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={() => void repair()}><Wrench />Repair{offer.commit && <span className="font-mono font-normal">{offer.commit}</span>}</Button>}
    {error && <p role="alert" className="basis-full break-words text-xs text-destructive">{error}</p>}
  </div>;
}

function ActionsLoading() {
  return <div role="status" aria-label="Loading actions…"><div aria-hidden="true">
    <StepList>
      {['w-32', 'w-40', 'w-28'].map(width => <StepItem key={width} compact icon={<Skeleton className="size-3 rounded-full" />}>
        <div className="flex min-h-6 min-w-0 items-center justify-between gap-2 px-1">
          <Skeleton className={`h-3 max-w-full ${width}`} /><Skeleton className="size-3 shrink-0" />
        </div>
      </StepItem>)}
    </StepList>
  </div></div>;
}

function ObservedRun({ run, openKey }: { run: GitHubRun; openKey: string }) {
  if (run.jobs === null) return <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Job details unavailable{run.url && <> · <a className="underline" href={run.url} target="_blank" rel="noreferrer">View run</a></>}</p>;
  if (!run.jobs.length) return <p className="px-2 py-2 text-xs text-muted-foreground">No jobs reported</p>;
  return <StepList label={`${run.name || 'Workflow'} jobs`}>
    {run.jobs.map(job => <StepItem key={job.id} compact icon={<RunMark mark={githubMark(job)} fallback={<ListChecks className="size-3.5" />} />}>
      <ActionGroup openKey={`${openKey}:${run.id}:${job.id}`} name={job.name} literal label={withMark(`Job: ${job.name}`, githubMark(job))}>
        {job.steps.length ? <StepList label={`${job.name} steps`}>
          {job.steps.map((step, index) => <StepItem key={`${step.number}:${index}`} compact icon={<RunMark mark={githubMark(step)} fallback={<Terminal className="size-3.5" />} />}>
            <p className="min-w-0 max-w-[16.5rem] px-1 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{step.name}{githubMark(step) && <span className="sr-only">, {GITHUB_MARK_LABELS[githubMark(step)!]}</span>}</p>
          </StepItem>)}
        </StepList> : <p className="px-2 py-2 text-xs text-muted-foreground">No steps reported</p>}
      </ActionGroup>
    </StepItem>)}
  </StepList>;
}

export default function GitHubActionsCard({ repoPath, scannedAt, scannedSha, runs = null, readError, stageId, autopilot = null }: { repoPath?: string; scannedAt?: string; scannedSha?: string | null; runs?: BuildReply | null; readError?: string | null; stageId?: string; autopilot?: StageAutopilot | null }) {
  const configKey = JSON.stringify([repoPath, scannedAt, scannedSha]);
  const [config, setConfig] = useState<{ key: string; workflows: ConfiguredWorkflow[]; error: string } | null>(null);
  const [reload, setReload] = useState(0);
  const openKey = `github-actions:${repoPath}`;
  const [open, setOpen] = useRememberedOpen(openKey);
  const current = config?.key === configKey ? config : null;
  const workflows = buildWorkflowRows(runs, current?.workflows ?? [], scannedSha);
  const error = readError || current?.error;

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ repoPath: repoPath! });
    api<{ workflows: ConfiguredWorkflow[] }>(`/api/github-actions?${params}`).then(result => {
      if (active) setConfig({ key: configKey, workflows: result.workflows, error: '' });
    }).catch(failure => {
      if (active) setConfig({ key: configKey, workflows: [], error: failure instanceof Error ? failure.message : 'Could not load actions.' });
    });
    return () => { active = false; };
  }, [repoPath, configKey, reload]);

  return <Collapsible open={open} onOpenChange={setOpen} className="nodrag nopan min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 min-w-0 w-full items-start justify-between gap-2 whitespace-normal px-1 py-1 text-left leading-6 [&[data-state=open]>svg]:rotate-180" aria-label="GitHub Actions">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">GitHub Actions</span><ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
          {error && <div className="space-y-2 p-2"><p role="alert" className="break-words text-xs text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => { if (readError) buildChanges.notify(); else setReload(value => value + 1); }}><RotateCw />Retry</Button></div>}
          {workflows.length ? <StepList label="GitHub workflows">
              {workflows.map(workflow => {
                const mark = combinedMark(workflow.runs.map(githubMark)), file = workflow.file.split('/').at(-1), workflowName = actionText(workflow.name, file);
                const repair = <WorkflowRepair repoPath={repoPath} stageId={stageId} offer={repairOffer(autopilot, workflow.file, runs?.sha)} />;
                return <StepItem key={`${scannedAt}:${workflow.file}`} compact icon={<RunMark mark={mark} fallback={<Workflow className="size-3.5" />} />}>
                  <ActionGroup openKey={`${openKey}:${workflow.file}`} name={workflow.name} fallback={file} label={withMark(`Workflow: ${workflowName}`, mark)} aside={repair}>
                    {workflow.error && <p role="alert" className="break-words px-2 py-2 text-xs text-destructive">{workflow.error}</p>}
                    {workflow.runs.length ? workflow.runs.map(run => <ObservedRun key={`${run.id}:${run.attempt}`} run={run} openKey={`${openKey}:${runs?.sha}:${workflow.file}`} />) : workflow.jobs.length ? <StepList label={`${workflowName} jobs`}>
                      {workflow.jobs.map(job => {
                        const jobName = actionText(job.name, job.id);
                        return <StepItem key={job.id} compact icon={<ListChecks className="size-3.5" />}>
                          <ActionGroup openKey={`${openKey}:${workflow.file}:${job.id}`} name={job.name} fallback={job.id} label={`Job: ${jobName}`}>
                            {job.steps.length ? <StepList label={`${jobName} steps`}>
                              {job.steps.map((step, index) => {
                                return <StepItem key={`${index}:${step.id}`} compact icon={<Terminal className="size-3.5" />}>
                                  <p className="min-w-0 max-w-[16.5rem] px-1 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]" title={step.name}><ActionName value={step.name} fallback="Step" /></p>
                                </StepItem>;
                              })}
                            </StepList> : <p className="px-2 py-2 text-xs text-muted-foreground">No steps</p>}
                          </ActionGroup>
                        </StepItem>;
                      })}
                    </StepList> : !workflow.error && <p className="px-2 py-2 text-xs text-muted-foreground">No jobs</p>}
                  </ActionGroup>
                </StepItem>;
              })}
            </StepList> : !error && (!runs ? <ActionsLoading /> : <p className="px-2 py-2 text-xs text-muted-foreground">No workflow runs</p>)}
      </CollapsibleContent>
  </Collapsible>;
}
