import { useRef, useState } from 'react';
import { ArrowRight, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { PipelineRemoval } from '../../contract/pipeline.ts';
import type { PipelineView } from '@/lib/pipeline-nodes';
import ProductionBranchSelect from './ProductionBranchSelect';

export default function Pipelines({ pipeline, repository, repositoryUrl, connected, removal, busy, readError, onOpen, onConnect, onCreate, onDelete, onProductionBranchChange }: {
  pipeline: PipelineView | null; repository: string; repositoryUrl?: string | null; connected: boolean;
  removal?: PipelineRemoval | null; busy: boolean; onOpen(): void; onConnect(): void;
  readError?: string;
  onCreate(): Promise<void>; onDelete(): Promise<void>;
  onProductionBranchChange(branch: string): Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState(false), [error, setError] = useState('');
  const actions = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const deleting = removal?.status === 'queued' || removal?.status === 'removing';
  const failed = removal?.status === 'failed';
  const status = deleting ? 'Deleting' : failed ? 'Deletion failed' : connected ? 'Connected' : 'Disconnected';
  async function remove() {
    setError('');
    try { await onDelete(); setConfirm(false); }
    catch (failure) { setError((failure as Error).message); }
  }
  async function create() {
    setError('');
    try { await onCreate(); }
    catch (failure) { setError((failure as Error).message); }
  }
  return <section className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 lg:px-10" aria-labelledby="pipelines-heading">
    <div className="mx-auto w-full max-w-5xl">
    <div className="mb-6 flex items-center justify-between gap-4"><h1 ref={heading} tabIndex={-1} id="pipelines-heading" className="text-xl font-semibold">Pipelines</h1>
      {!pipeline && <Button disabled={busy || deleting} onClick={() => void create()}><Plus />Create pipeline</Button>}
      {pipeline && !connected && !deleting && <Button disabled={busy} onClick={onConnect}><span className="brand-mark" style={{ maskImage: 'url(/assets/providers/github.svg)' }} aria-hidden="true" />Reconnect GitHub</Button>}
    </div>
    <div className="rounded-lg border">
      <Table aria-label="Pipelines">
        <TableHeader><TableRow><TableHead className="pl-4">Repository</TableHead><TableHead className="whitespace-normal">Production branch</TableHead><TableHead>Stages</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>{pipeline ? <TableRow>
          <TableCell className="max-w-80 whitespace-normal break-words pl-4">{repositoryUrl ? <Button asChild variant="link" className="h-auto max-w-full justify-start whitespace-normal border-0 px-0 text-left font-normal"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer">{repository}</a></Button> : repository}</TableCell>
          <TableCell><ProductionBranchSelect key={`${repository}:${pipeline.id || ''}:${connected}`} repository={repository} value={pipeline.productionBranch} disabled={!connected || busy || deleting || failed} onChange={onProductionBranchChange} /></TableCell><TableCell className="tabular-nums">{pipeline.stages.length}</TableCell>
          <TableCell><Badge variant="outline">{status}</Badge></TableCell>
          <TableCell className="pr-4 text-right"><div className="flex items-center justify-end gap-1">
            <Button variant="ghost" className="h-9" disabled={busy || deleting || failed} onClick={connected ? onOpen : onConnect}>Open pipeline<ArrowRight /></Button>
            {failed ? <Button variant="outline" aria-label="Retry deletion" disabled={busy} onClick={() => void remove()}><RotateCcw />Retry deletion</Button> : <DropdownMenu><DropdownMenuTrigger asChild><Button ref={actions} variant="ghost" size="icon" aria-label="Pipeline actions" disabled={busy || deleting}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => { setError(''); setConfirm(true); }}><Trash2 />Delete pipeline</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
          </div></TableCell>
        </TableRow> : <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No pipelines</TableCell></TableRow>}</TableBody>
      </Table>
    </div>
    {!confirm && (error || failed && removal?.error || readError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || (failed ? removal?.error : '') || readError}</p>}
    </div>
    <AlertDialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}><AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); (actions.current && !actions.current.disabled ? actions.current : heading.current)?.focus(); }}><AlertDialogHeader><AlertDialogTitle>Delete pipeline?</AlertDialogTitle><AlertDialogDescription>Delete this pipeline, its Sandbox environments, tests and run history. Keep the project and repository.</AlertDialogDescription></AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Delete pipeline</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>;
}
