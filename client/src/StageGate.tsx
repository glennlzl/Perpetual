import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, CircleX, LoaderCircle, Play, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { canRelease, createGatePoller, gateBadge, gateChanges, gatePending, gateReleaseRequest, shareGates, sourceMoved, type GateReleaseConfirmation, type GateView, type StageGate } from '@/lib/stage-gate.ts';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';
import type { ScanRepo } from './App';

const ICONS: Record<string, LucideIcon> = { idle: CircleDashed, passed: CircleCheck, failed: CircleX, blocked: CircleAlert };

/**
 * The gate view for the scanned source; onSourceMoved runs when the controller moved it to another commit, and again a
 * second later while it reports that it could not reload yet, such as while a pipeline change saves. A new `retryKey`
 * starts it over, as Try again after a failed reload does.
 */
export function useStageGates(repo: ScanRepo | null | undefined, onSourceMoved: () => Promise<boolean>, retryKey = 0) {
  const [view, setView] = useState<GateView | null>(null);
  const path = repo?.path;
  useEffect(() => {
    if (!path) return undefined;
    const poller = createGatePoller({ controller: api, onChange: next => setView(previous => shareGates(previous, next)) });
    const stop = gateChanges.subscribe(() => poller.refresh());
    return () => { stop(); poller.stop(); };
  }, [path]);
  // Reload once per commit the gate view reports, not on every new callback identity.
  const moved = sourceMoved(view, repo);
  const reload = useRef(onSourceMoved);
  reload.current = onSourceMoved;
  useEffect(() => {
    if (!moved) return undefined;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => { if (!await reload.current() && !stopped) timer = setTimeout(attempt, 1000); };
    void attempt();
    return () => { stopped = true; clearTimeout(timer); };
  }, [moved, retryKey]);
  return view?.repoPath === path ? view : null;
}

export function GateBadge({ gate }: { gate: StageGate | null | undefined }) {
  const badge = gateBadge(gate);
  if (!badge) return null;
  const Icon = ICONS[badge.tone];
  const content = <Badge variant={badge.tone === 'failed' ? 'destructive' : 'secondary'} className="stage-status" data-tone={badge.tone} role="status" tabIndex={badge.hint ? 0 : undefined}>
    {badge.tone === 'working' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}{badge.label}<span className="stage-status-sha">{badge.sha}</span>{gate!.statusError && <TriangleAlert aria-label="Commit status not reported" />}
  </Badge>;
  return badge.hint ? <Tooltip><TooltipTrigger asChild>{content}</TooltipTrigger><TooltipContent>{badge.hint}</TooltipContent></Tooltip> : content;
}

export function GateActions({ repoPath, stage, gate, disabled = false }: { repoPath?: string; stage: PipelineStage; gate: StageGate | null | undefined; disabled?: boolean }) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<GateReleaseConfirmation | null>(null);
  const request = gateReleaseRequest({ repoPath, stageId: stage.id, gate }, confirmation);
  async function act(operation: 'run' | 'release', input = {}) {
    setPending(operation); setError('');
    try { await api(`/api/gate/${operation}`, { repoPath, stageId: stage.id, ...input }); gateChanges.notify(); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { setPending(''); }
  }
  return <>
    <Button className="nodrag" variant="ghost" size="sm" disabled={disabled || Boolean(pending) || gatePending(gate)} onClick={() => act('run')}><Play />Run now</Button>
    {(canRelease(gate) || confirmation) && <AlertDialog open={Boolean(confirmation)} onOpenChange={open => {
      if (pending) return;
      setError('');
      if (!open) setConfirmation(null);
      else if (repoPath && canRelease(gate)) setConfirmation({ repoPath, stageId: stage.id, gateId: gate.id, sha: gate.sha, detectedAt: gate.detectedAt, reason: gate.reason || stage.name });
    }}>
      {canRelease(gate) && <AlertDialogTrigger asChild><Button className="nodrag" variant="ghost" size="sm" disabled={disabled || Boolean(pending) || !repoPath}><ShieldCheck />Release</Button></AlertDialogTrigger>}
      {confirmation && <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Release {confirmation.sha.slice(0, 7)}?</AlertDialogTitle><AlertDialogDescription>{confirmation.reason}</AlertDialogDescription></AlertDialogHeader>
        {!request && <p role="alert" className="text-sm text-destructive">The gate changed. Close and review it again.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(pending)}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={disabled || Boolean(pending) || !request} onClick={async event => { event.preventDefault(); if (request && await act('release', request)) setConfirmation(null); }}>{pending ? 'Releasing…' : 'Release'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>}
    {error && !confirmation && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
  </>;
}
