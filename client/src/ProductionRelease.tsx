import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, RefreshCw, Rocket, Settings2 } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useReturnFocus } from '@/lib/journey-focus';
import { createReleasePoller, gatesReleasable, releaseChanges, releaseForSource, releaseRequest, type ReleaseConfirmation } from '@/lib/production-release';
import type { GateView } from '../../contract/gate.ts';
import type { ReleaseReply, ReleaseTarget } from '../../contract/releases.ts';

type FocusFallback = Parameters<typeof useReturnFocus>[0];

/**
 * One visible-page poller for the source, shared by the Production card and its Badge. The journey gates decide whether
 * Deploy is allowed, so a changed verdict or report error reads the release at once, and while they allow the scanned
 * commit the release is read again soon until it allows it too.
 */
export function useReleases(repoPath: string | null | undefined, scannedSha: string | null | undefined, gates: GateView | null = null) {
  const sha = scannedSha ?? null;
  const [read, setRead] = useState<{ repoPath: string; sha: string | null; view: ReleaseReply | null; error: string | null } | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const ready = useRef(false);
  ready.current = gatesReleasable(gates, sha);
  const gateKey = JSON.stringify([gates?.production, Object.values(gates?.stages ?? {}).map(gate => [gate.sha, gate.status, gate.statusError])]);
  useEffect(() => {
    if (!repoPath) return undefined;
    const poller = createReleasePoller({ repoPath, controller: api, gatesReady: () => ready.current,
      onChange: view => setRead(previous => previous?.repoPath === repoPath && previous.sha === sha && JSON.stringify(previous.view) === JSON.stringify(view) ? previous : { repoPath, sha, view, error: null }),
      onError: error => setRead(previous => previous?.repoPath === repoPath && previous.sha === sha && previous.error === error ? previous : { repoPath, sha, view: previous?.repoPath === repoPath && previous.sha === sha ? previous.view : null, error }),
    });
    refresh.current = poller.refresh;
    const unsubscribe = releaseChanges.subscribe(() => poller.refresh());
    return () => { refresh.current = null; unsubscribe(); poller.stop(); };
  }, [repoPath, sha]);
  const verdicts = useRef(gateKey);
  useEffect(() => { if (verdicts.current !== gateKey) { verdicts.current = gateKey; refresh.current?.(); } }, [gateKey]);
  return read && read.repoPath === repoPath && read.sha === sha ? { view: releaseForSource(read.view, repoPath, sha), error: read.error } : { view: null, error: null };
}

function TargetDialog({ repoPath, target, onClose, focusFallback }: { repoPath: string; target: ReleaseTarget | null; onClose: () => void; focusFallback?: FocusFallback }) {
  const id = useId();
  const returnFocus = useReturnFocus(focusFallback);
  const [environment, setEnvironment] = useState(target?.environment || 'production');
  const [workflowPath, setWorkflowPath] = useState(target?.workflowPath || '');
  const [productionEnvironment, setProductionEnvironment] = useState(target?.productionEnvironment ?? true);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      await api('/api/releases/configure', { repoPath, target: { environment: environment.trim(), workflowPath: workflowPath.trim(), productionEnvironment } });
      releaseChanges.notify(); onClose();
    } catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}><DialogContent aria-describedby={undefined} onCloseAutoFocus={returnFocus} showCloseButton={!pending}>
    <DialogHeader><DialogTitle>Deployment target</DialogTitle></DialogHeader>
    <form onSubmit={save} className="space-y-4">
      <fieldset disabled={pending} className="grid gap-4">
        <div className="grid gap-2"><Label htmlFor={`${id}-environment`}>Environment</Label><Input id={`${id}-environment`} value={environment} onChange={event => setEnvironment(event.target.value)} required autoComplete="off" /></div>
        <div className="grid gap-2"><Label htmlFor={`${id}-workflow`}>Deployment workflow</Label><Input id={`${id}-workflow`} value={workflowPath} onChange={event => setWorkflowPath(event.target.value)} placeholder=".github/workflows/deploy.yml" required autoComplete="off" autoCapitalize="none" spellCheck={false} /></div>
        <div className="flex items-center justify-between gap-3"><Label htmlFor={`${id}-production`}>Production environment</Label><Switch id={`${id}-production`} checked={productionEnvironment} onCheckedChange={setProductionEnvironment} /></div>
      </fieldset>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending || !environment.trim() || !workflowPath.trim()}>{pending ? 'Saving…' : 'Save target'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function DeployDialog({ confirmation, view, pending, disabled, error, onClose, onDeploy, focusFallback }: {
  confirmation: ReleaseConfirmation; view: ReleaseReply | null; pending: boolean; disabled: boolean; error: string;
  onClose: () => void; onDeploy: (request: NonNullable<ReturnType<typeof releaseRequest>>) => void; focusFallback?: FocusFallback;
}) {
  const returnFocus = useReturnFocus(focusFallback);
  const request = releaseRequest(view, confirmation);
  return <AlertDialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent onCloseAutoFocus={returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>Deploy {confirmation.sha.slice(0, 7)}?</AlertDialogTitle><AlertDialogDescription className="break-words">Deploy commit <span className="font-mono">{confirmation.sha}</span> to <strong>{confirmation.target.environment}</strong> using <span className="font-mono">{confirmation.target.workflowPath}</span>.</AlertDialogDescription></AlertDialogHeader>
      {!request && <p role="alert" className="text-sm text-destructive">{view?.blockedReason || 'The release changed. Close and review it again.'}</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction disabled={disabled || pending || !request} onClick={event => { event.preventDefault(); if (request) onDeploy(request); }}>{pending ? 'Deploying…' : 'Deploy'}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

/** Explicit deployment controls; the server rechecks the confirmed SHA's Build and journey gates. */
export function ProductionRelease({ repoPath, view, readError, disabled = false }: { repoPath?: string; view: ReleaseReply | null | undefined; readError?: string | null; disabled?: boolean }) {
  const controls = useRef<HTMLDivElement>(null);
  const focusFallback = () => controls.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? null;
  const [configure, setConfigure] = useState(false);
  const [confirmation, setConfirmation] = useState<ReleaseConfirmation | null>(null);
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  const current = view && view.repoPath === repoPath ? view : null;
  const target = current?.target;
  if (!repoPath) return null;
  async function act(operation: 'deploy' | 'refresh', input: Record<string, unknown> = {}) {
    if (pending) return false;
    setPending(operation); setError('');
    try { await api(`/api/releases/${operation}`, { repoPath, ...input }); releaseChanges.notify(); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { setPending(''); }
  }
  const locked = disabled || Boolean(pending);
  return <div ref={controls} className="nodrag nopan flex w-80 max-w-full min-w-0 flex-wrap gap-2 [overflow-wrap:anywhere]">
    <Button className="text-xs" variant="ghost" size="sm" disabled={locked || !current} onClick={() => { setError(''); setConfigure(true); }}><Settings2 />{target ? 'Deployment target' : 'Configure deployment'}</Button>
    <Button className="text-xs" variant="ghost" size="sm" disabled={locked} onClick={() => act('refresh')}><RefreshCw />{pending === 'refresh' ? 'Checking…' : 'Check status'}</Button>
    {target && <Button className="text-xs" variant="outline" size="sm" disabled={locked || !current?.canDeploy || !current.sha} onClick={() => { if (current?.sha && current.target) { setError(''); setConfirmation({ sha: current.sha, target: { ...current.target } }); } }}><Rocket />Deploy</Button>}
    {current?.current?.url && <Button asChild className="text-xs" variant="link" size="sm"><a href={current.current.url} target="_blank" rel="noopener noreferrer">Open deployment<ExternalLink /></a></Button>}
    {current?.current?.logUrl && <Button asChild className="text-xs" variant="link" size="sm"><a href={current.current.logUrl} target="_blank" rel="noopener noreferrer">Logs<ExternalLink /></a></Button>}
    {!confirmation && error && <p role="alert" className="basis-full break-words text-xs text-destructive">{error}</p>}
    {readError && <p role="alert" className="basis-full break-words text-xs text-destructive">{readError}</p>}
    {!readError && !current && <p role="status" className="basis-full text-xs text-muted-foreground">Loading release status…</p>}
    {/* Why a configured target cannot be deployed yet; without one, Configure deployment is the next step. */}
    {target && current?.blockedReason && <p className="basis-full break-words text-xs text-muted-foreground">{current.blockedReason}</p>}
    {configure && <TargetDialog repoPath={repoPath} target={target || null} onClose={() => setConfigure(false)} focusFallback={focusFallback} />}
    {confirmation && <DeployDialog confirmation={confirmation} view={current} pending={pending === 'deploy'} disabled={locked} error={error}
      onClose={() => { setConfirmation(null); setError(''); }} onDeploy={async request => { if (await act('deploy', request)) setConfirmation(null); }} focusFallback={focusFallback} />}
  </div>;
}
