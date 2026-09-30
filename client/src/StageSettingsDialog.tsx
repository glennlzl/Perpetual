import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useTestStage } from '@/lib/use-test-workspace';
import { environmentHasResources } from './EnvironmentSettings';
import type { StageRemoval } from '@/lib/test-workspace';
import type { StageRemovalReply } from '../../contract/environment.ts';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';
import type { PipelineDialog } from './App';
import type { PipelineAction } from './lib/test-workspace';
import type { PipelineActionReply as PipelineActionResult } from '../../contract/pipeline.ts';

type StageSettingsDialogProps = {
  // tests: a legacy stage field the controller no longer writes.
  dialog: PipelineDialog; stage: (PipelineStage & { tests?: unknown[] }) | undefined; repoPath?: string; busy?: boolean;
  onAction: (input: PipelineAction) => Promise<PipelineActionResult>; onRemoved?: () => Promise<void>; onClose: () => void;
};

const removalLabels: Record<string, string> = { queued: 'Deleting…', cleaning: 'Deleting sandbox…', removing: 'Deleting stage…', completed: 'Deleted' };
const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

export default function StageSettingsDialog({ dialog, stage, repoPath, onAction, onRemoved, onClose, busy = false }: StageSettingsDialogProps) {
  const removing = dialog.type === 'remove-stage';
  const validStage = stage?.kind === 'sandbox' && Boolean(repoPath);
  const [workspaceStage, workspace] = useTestStage(stage?.id);
  const [name, setName] = useState(stage?.name || '');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [removal, setRemoval] = useState<StageRemoval | null>(null);
  const [checking, setChecking] = useState(removing);
  const [readError, setReadError] = useState('');
  const saving = useRef(false);
  const live = useRef(true);
  const requestEpoch = useRef(0);
  const completed = useRef(false);
  const focusOrigin = useRef<Element | null>(null);
  const removalPending = ['queued', 'cleaning', 'removing'].includes(removal?.status ?? '');
  const locked = busy || Boolean(pending) || removing && (checking || removalPending || removal?.status === 'completed');
  const blocker = !validStage ? 'This Sandbox stage is no longer available.' : '';
  // An accepted removal owns a fixed sandbox list; before that, count live owned sandboxes.
  const sandboxes = removalPending || removal?.status === 'completed' ? removal!.environmentIds?.length || 0 : workspace.environment.environments.filter(environmentHasResources).length;
  const tests = (stage?.tests?.length || 0) + workspace.browser.cases.length;
  // Name only what deletion actually removes; a stage without sandboxes is deleted on its own.
  const removes = [sandboxes && count(sandboxes, 'sandbox', 'sandboxes'), tests && count(tests, 'test', 'tests')].filter(Boolean);
  const removalTitle = `Delete ${stage?.name || 'stage'}${sandboxes ? ` and its ${sandboxes === 1 ? 'sandbox' : 'sandboxes'}` : ''}?`;
  const trimmedName = name.trim();
  const renamed = Boolean(trimmedName) && trimmedName !== stage?.name;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // The controller owns removal. Closing this view never cancels its cleanup.
  useEffect(() => {
    if (!removing || !validStage) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (stopped || !workspaceStage.isCurrent()) return;
      if (!saving.current) {
        const epoch = requestEpoch.current;
        try {
          const result = await api<StageRemovalReply>(`/api/stages/removal?${new URLSearchParams({ repoPath: repoPath!, stageId: stage!.id })}`);
          if (!stopped && workspaceStage.isCurrent() && epoch === requestEpoch.current) {
            setRemoval(result.removal);
            setReadError('');
            setChecking(false);
            if (result.removal?.status === 'completed') return;
          }
        } catch (failure) {
          if (!stopped && workspaceStage.isCurrent() && epoch === requestEpoch.current) {
            setReadError((failure as Error).message);
            setChecking(false);
          }
        }
      }
      if (!stopped) timer = setTimeout(read, 1500);
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [removing, validStage, repoPath, stage?.id, workspaceStage]);

  useEffect(() => {
    if (removal?.status !== 'completed' || completed.current || !workspaceStage.isCurrent()) return;
    completed.current = true;
    void (async () => {
      try {
        await onRemoved?.();
        if (live.current) onClose();
      } catch (failure) {
        if (live.current) setError((failure as Error).message);
      }
    })();
  }, [removal?.status, onRemoved, onClose, workspaceStage]);

  async function confirm(event: SyntheticEvent) {
    event.preventDefault();
    if (locked || saving.current || blocker || !removing && !renamed) return;
    saving.current = true;
    requestEpoch.current++;
    setPending(removing ? 'Deleting…' : 'Saving…');
    setError('');
    try {
      if (!live.current || !workspaceStage.isCurrent()) throw new Error('The source changed. Reopen this stage.');
      if (removing) {
        const result = await api<StageRemovalReply>('/api/stages/remove', { repoPath, stageId: stage!.id });
        if (live.current && workspaceStage.isCurrent()) { setRemoval(result.removal); setReadError(''); }
      } else {
        await onAction({ action: 'rename-stage', stageId: stage!.id, name: trimmedName });
        if (live.current && workspaceStage.isCurrent()) onClose();
      }
    } catch (failure) {
      if (live.current && workspaceStage.isCurrent()) setError(failure instanceof Error ? failure.message : 'Could not save this stage. Try again.');
    } finally {
      saving.current = false;
      if (live.current) setPending('');
    }
  }

  const closeLocked = !removing && locked;
  const modalProps = {
    'aria-busy': locked,
    onOpenAutoFocus: () => { focusOrigin.current = document.activeElement; },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (focusOrigin.current instanceof HTMLElement && focusOrigin.current.isConnected) focusOrigin.current.focus({ preventScroll: true });
    },
    onEscapeKeyDown: (event: KeyboardEvent) => { if (closeLocked) event.preventDefault(); },
  };
  const changeOpen = (open: boolean) => { if (!open && !closeLocked) onClose(); };

  if (removing) return <AlertDialog open onOpenChange={changeOpen}>
    <AlertDialogContent {...modalProps}>
      <AlertDialogHeader>
        <AlertDialogTitle>{removalTitle}</AlertDialogTitle>
        <AlertDialogDescription className={blocker ? 'sr-only' : 'tabular-nums'}>{blocker ? 'Delete this stage.' : removes.length ? `Removes ${removes.join(' and ')}.` : 'No sandboxes or tests.'}</AlertDialogDescription>
      </AlertDialogHeader>
      {(error || readError || removal?.error || blocker) && <p role="alert" className="text-sm text-destructive">{error || readError || removal?.error || blocker}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel>{pending || removalPending || removal?.status === 'completed' ? 'Close' : 'Cancel'}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={locked || Boolean(blocker)} onClick={confirm}>{pending || (checking ? 'Checking…' : removalLabels[removal?.status ?? '']) || (removal?.status === 'failed' ? 'Retry deletion' : 'Delete stage')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;

  return <Dialog open onOpenChange={changeOpen}>
    <DialogContent {...modalProps} aria-describedby={undefined} showCloseButton={!closeLocked}>
      <DialogHeader><DialogTitle>Rename stage</DialogTitle></DialogHeader>
      <form onSubmit={confirm} className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="stage-settings-name">Stage name</Label>
          <Input id="stage-settings-name" value={name} onChange={event => setName(event.target.value)} required maxLength={40} disabled={locked || !validStage} />
        </div>
        {(error || blocker) && <p role="alert" className="text-sm text-destructive">{error || blocker}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={locked} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={locked || !validStage || !renamed}>{pending || 'Save changes'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
