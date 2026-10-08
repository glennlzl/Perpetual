import type { Ref } from 'react';
import { Box, CircleDot, CircleMinus, CircleX, GitGraph, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { environmentWorking } from '@/lib/stage-activity.ts';
import { environmentStatusLabel, latestEnvironment } from '@/lib/environment-view';
import { useTestStage } from '@/lib/use-test-workspace';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';

// Headers stay mounted while a deferred inspector loads, including its focused Close control.
export function GitGraphHeader({ onClose, actionsRef }: { onClose: () => void; actionsRef: Ref<HTMLDivElement> }) {
  return <SheetHeader className="flex-row items-center gap-3 border-b">
    <GitGraph className="size-6 shrink-0" />
    <SheetTitle className="shrink-0 text-xl">Git graph</SheetTitle>
    <div ref={actionsRef} className="flex min-w-0 flex-1 items-center gap-2" />
    <Button variant="ghost" size="icon" aria-label="Close Git graph" onClick={onClose}><X /></Button>
  </SheetHeader>;
}

// The header status reads like the stage card's: ready, working, failed, or an absent/idle sandbox.
export function environmentTone(status: string | undefined) {
  if (!status) return 'unconfigured';
  if (status === 'ready') return 'ready';
  if (['failed', 'cleanup_failed'].includes(status)) return 'failed';
  return environmentWorking(status) ? 'working' : 'idle';
}
const TONE_ICONS: Record<string, LucideIcon> = { ready: CircleDot, failed: CircleX, working: LoaderCircle };
function EnvironmentStatus({ status, step }: { status: string | undefined; step?: string }) {
  const stopped = status === 'failed' && step === 'Stopped';
  const tone = stopped ? 'idle' : environmentTone(status), Icon = TONE_ICONS[tone] || CircleMinus;
  const quiet = ['idle', 'unconfigured'].includes(tone);
  return <Badge variant={tone === 'failed' ? 'destructive' : quiet ? 'outline' : 'secondary'} data-tone={tone} className={`shrink-0 ${quiet ? 'text-muted-foreground' : ''}`}>
    <Icon aria-hidden="true" className={tone === 'working' ? 'motion-safe:animate-spin' : undefined} />{stopped ? 'Stopped' : environmentStatusLabel(status)}
  </Badge>;
}
export function EnvironmentHeader({ repoPath, stage, busy = false, onClose }: { repoPath?: string; stage?: PipelineStage; busy?: boolean; onClose: () => void }) {
  const validStage = stage?.kind === 'sandbox' && Boolean(repoPath);
  const [, snapshot] = useTestStage(stage?.id, validStage ? ['environment'] : []);
  const current = latestEnvironment(snapshot.environment.environments);
  const disabled = busy || Boolean(snapshot.pending);
  const requestFailed = snapshot.environmentCreationError && (!current || ['failed', 'destroyed', 'cleanup_failed'].includes(current.status));
  return <SheetHeader className="flex-row items-center gap-3">
    <Box className="size-6 shrink-0" />
    <SheetTitle className="min-w-0 flex-1 truncate text-xl">{stage?.name || 'Sandbox'}</SheetTitle>
    {(current || snapshot.pending === 'create' || !snapshot.loading.environment) && <EnvironmentStatus status={snapshot.pending === 'create' ? 'preparing' : requestFailed ? 'failed' : current?.status} step={current?.step} />}
    <Button variant="ghost" size="icon" disabled={disabled} aria-label="Close" onClick={onClose}><X /></Button>
  </SheetHeader>;
}
