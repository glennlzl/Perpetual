import { useRef, useState } from 'react';
import { MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { PipelineRemoval } from '../../contract/pipeline.ts';
import type { PipelineView } from '@/lib/pipeline-nodes';

export default function Pipelines({ pipeline, repository, branch, connected, removal, busy, readError, onOpen, onConnect, onCreate, onDelete }: {
  pipeline: PipelineView | null; repository: string; branch?: string | null; connected: boolean;
  removal?: PipelineRemoval | null; busy: boolean; onOpen(): void; onConnect(): void;
  readError?: string;
  onCreate(): Promise<void>; onDelete(): Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false), [error, setError] = useState('');
  const actions = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const deleting = removal?.status === 'queued' || removal?.status === 'removing';
  const failed = removal?.status === 'failed';
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
    <div className="mb-6 flex items-center justify-between gap-4"><h1 ref={heading} tabIndex={-1} id="pipelines-heading" className="text-xl font-semibold">Pipelines</h1>
      {!pipeline && <Button disabled={busy || deleting} onClick={() => void create()}><Plus />Create pipeline</Button>}
      {pipeline && !connected && !deleting && <Button disabled={busy} onClick={onConnect}><span className="brand-mark" style={{ maskImage: 'url(/assets/providers/github.svg)' }} aria-hidden="true" />Reconnect GitHub</Button>}
    </div>
    <div className="rounded-lg border">
      <Table aria-label="Pipelines">
        <TableHeader><TableRow><TableHead className="pl-4">Pipeline</TableHead><TableHead className="hidden md:table-cell">Repository</TableHead><TableHead>Branch</TableHead><TableHead className="hidden md:table-cell">Stages</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>{pipeline ? <TableRow>
          <TableCell className="pl-4"><Button variant="ghost" className="h-9 border-0 px-0 font-normal hover:bg-transparent hover:underline" disabled={busy || deleting || failed} onClick={connected ? onOpen : onConnect}>Delivery</Button></TableCell>
          <TableCell className="hidden max-w-80 whitespace-normal break-words md:table-cell">{repository}</TableCell>
          <TableCell>{branch || '—'}</TableCell><TableCell className="hidden tabular-nums md:table-cell">{pipeline.stages.length}</TableCell>
          <TableCell><Badge variant="outline">{deleting ? 'Deleting' : failed ? 'Deletion failed' : connected ? 'Connected' : 'Disconnected'}</Badge></TableCell>
          <TableCell className="pr-4 text-right">{failed ? <Button variant="outline" aria-label="Retry deletion" disabled={busy} onClick={() => void remove()}><RotateCcw /><span className="hidden sm:inline">Retry deletion</span></Button> : <DropdownMenu><DropdownMenuTrigger asChild><Button ref={actions} variant="ghost" size="icon" aria-label="Pipeline actions" disabled={busy || deleting}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => { setError(''); setConfirm(true); }}><Trash2 />Delete pipeline</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</TableCell>
        </TableRow> : <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No pipelines</TableCell></TableRow>}</TableBody>
      </Table>
    </div>
    {!confirm && (error || failed && removal?.error || readError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || (failed ? removal?.error : '') || readError}</p>}
    <AlertDialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}><AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); (actions.current && !actions.current.disabled ? actions.current : heading.current)?.focus(); }}><AlertDialogHeader><AlertDialogTitle>Delete pipeline?</AlertDialogTitle><AlertDialogDescription>Delete this pipeline, its Sandbox environments, tests and run history. Keep the project and repository.</AlertDialogDescription></AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Delete pipeline</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>;
}
