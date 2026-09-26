import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Box, GitBranch, X } from 'lucide-react';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import SourceSettings, { type SourceSelection, type SourceSettingsHandle, type SourceState } from './SourceSettings';
import ServiceSettings from './ServiceSettings';
import TransitionConfirmation from './TransitionConfirmation';
import GitGraphPanel from './GitGraphPanel';
import EnvironmentSettings from './EnvironmentSettings';
import StageSettingsDialog from './StageSettingsDialog';
import { monochromeAsset, providerAsset } from '@/lib/provider-assets';
import type { PipelineView } from '@/lib/pipeline-nodes.ts';
import type { PipelineAction, PipelineActionResult, PipelineDialog, Scan } from './App';

type OnAction = (input: PipelineAction) => Promise<PipelineActionResult>;

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
const stageKey = (value: unknown) => String(value ?? '').trim().normalize('NFKC').toLowerCase();
// A new sandbox proposes the unused Greek letter that keeps its neighbours in order (Alpha before Beta, Delta after
// Gamma); the first sandbox is Beta, as the docs name it; with no letter between them, a unique neutral name.
function nextStageName(pipeline: PipelineView | null | undefined, afterStageId: string) {
  const stages = pipeline?.stages || [];
  const used = new Set(stages.map(stage => stageKey(stage.name)));
  const position = stages.findIndex(stage => stage.id === afterStageId);
  const letters = (list: PipelineView['stages']) => list.map(stage => stage.kind === 'sandbox' ? GREEK.findIndex(name => stageKey(name) === stageKey(stage.name)) : -1).filter(index => index >= 0);
  const before = letters(stages.slice(0, position + 1)).at(-1) ?? -1;
  const after = letters(stages.slice(position + 1))[0] ?? GREEK.length;
  const first = letters(stages).length === 0 ? 1 : 0;
  const letter = GREEK.slice(Math.max(before + 1, first), after).find(name => !used.has(stageKey(name)));
  if (letter) return letter;
  for (let count = 1; ; count++) {
    const name = count === 1 ? 'Sandbox' : `Sandbox ${count}`;
    if (!used.has(stageKey(name))) return name;
  }
}

function InspectorMark({ provider, type }: { provider?: string; type: PipelineDialog['type'] }) {
  const asset = providerAsset(provider);
  if (asset) return <img className="provider-logo" data-monochrome={monochromeAsset(asset)} src={`/assets/providers/${asset}.svg`} alt={provider} width={24} height={24} />;
  const Icon = type === 'source' ? GitBranch : Box;
  return <Icon className="size-6" aria-hidden="true" />;
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="grid gap-2">
    <Label htmlFor={id}>{label}</Label>
    {children}
  </div>;
}

// Radix loops Tab inside every Dialog, including a non-modal Sheet that does not trap focus,
// and leaves invisible focus guards at both ends of the body. At the sheet's edges Tab skips
// that loop and continues from the sheet's opener in document order, never on a guard.
const visible = (node: HTMLElement) => typeof node.checkVisibility === 'function' ? node.checkVisibility({ checkVisibilityCSS: true }) : node.getClientRects().length > 0;
function tabbables(root: Node, excluded: (node: HTMLElement) => boolean = () => false) {
  const nodes: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node: HTMLElement) => excluded(node) || node.hidden || node.inert ? NodeFilter.FILTER_REJECT
      : node.tabIndex < 0 || node.matches(':disabled, input[type="hidden"], a:not([href]):not([tabindex])') ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as HTMLElement);
  return nodes.filter(visible);
}
function releaseTabAtEdges(event: KeyboardEvent<HTMLElement>, origin: Element | null) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const container = event.currentTarget, focused = document.activeElement, back = event.shiftKey;
  const inside = tabbables(container);
  const atEdge = inside.length ? focused === (back ? inside[0] : inside.at(-1)) || back && focused === container : focused === container;
  if (!atEdge) return;
  event.stopPropagation();
  // Without a connected opener the sheet stands in for it at the end of the page.
  const anchor = origin instanceof Element && origin.isConnected && !container.contains(origin) ? origin : container;
  const page = tabbables(document.body, node => node === container || node.hasAttribute('data-radix-focus-guard'));
  const follows = (node: Node) => Boolean(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  const target = back ? page.findLast(node => node !== anchor && !follows(node)) ?? page.at(-1) : page.find(follows) ?? page[0];
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function NewStageDialog({ dialog, pipeline, onAction, onClose, busy }: { dialog: PipelineDialog; pipeline: PipelineView | null | undefined; onAction: OnAction; onClose: () => void; busy: boolean }) {
  const placements = pipeline?.stages?.filter(item => !['source', 'production'].includes(item.kind)) || [];
  // The + the user clicked already fixes the insertion point; only an unknown one offers a choice.
  const placement = placements.find(item => item.id === dialog.afterStageId);
  const [afterStageId, setAfterStageId] = useState(dialog.afterStageId || 'build');
  const [name, setName] = useState(() => nextStageName(pipeline, afterStageId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  const saving = useRef(false);
  const focusOrigin = useRef<Element | null>(null);
  const locked = busy || pending;
  const trimmedName = name.trim();
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || saving.current || !trimmedName) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onAction({ action: 'add-stage', afterStageId, name: trimmedName });
      if (live.current) onClose();
    } catch (failure) {
      if (live.current) setError(failure instanceof Error ? failure.message : 'Could not add this stage. Try again.');
    } finally {
      saving.current = false;
      if (live.current) setPending(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <DialogContent aria-describedby={undefined} aria-busy={locked} showCloseButton={!locked}
      onOpenAutoFocus={() => { focusOrigin.current = document.activeElement; }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (focusOrigin.current instanceof HTMLElement && focusOrigin.current.isConnected) focusOrigin.current.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={event => { if (locked) event.preventDefault(); }}>
      <DialogHeader className="flex-row flex-wrap items-center gap-2"><DialogTitle>New stage</DialogTitle><Badge variant="outline">Sandbox</Badge></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <Field id="stage-name" label="Stage name">
          <Input id="stage-name" value={name} onChange={event => setName(event.target.value)} required maxLength={40} placeholder="Beta" disabled={locked} />
        </Field>
        {placement ? <dl className="grid gap-2">
          <dt className="text-[13px] font-medium leading-5">Place after</dt>
          <dd className="m-0 text-sm [overflow-wrap:anywhere]">{placement.name}</dd>
        </dl> : <Field id="stage-after" label="Place after">
          <Select value={afterStageId} disabled={locked} onValueChange={value => {
            // An untouched proposed name follows the placement; a typed name is kept.
            if (name === nextStageName(pipeline, afterStageId)) setName(nextStageName(pipeline, value));
            setAfterStageId(value);
          }}>
            <SelectTrigger id="stage-after" className="w-full"><SelectValue placeholder="Choose a stage" /></SelectTrigger>
            <SelectContent>{placements.map(item =>
              <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>}
        {error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={locked} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={locked || !trimmedName}>{pending ? 'Adding…' : 'Add stage'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function DialogForm({ dialog, scan, onClose, onSourceSave, busy, setPending }: { dialog: PipelineDialog; scan: Scan | null; onClose: () => void; onSourceSave?: (selection: SourceSelection) => Promise<unknown>; busy: boolean; setPending: (pending: boolean) => void }) {
  const node = scan?.nodes?.find(item => item.id === dialog.nodeId);
  const { type } = dialog;
  const provider = type === 'source' ? 'GitHub' : node?.provider;
  const active = useRef(true);
  const sourceSettings = useRef<SourceSettingsHandle>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [error, setError] = useState('');
  const [sourceState, setSourceState] = useState<SourceState>({ canSave: false, loading: true, connection: null });
  // Only this form's own save says Saving; a connection change also locks the form but saves nothing.
  const [saving, setSaving] = useState(false);

  async function save(work: () => Promise<unknown>) {
    if (busy) return;
    setError('');
    setPending(true); setSaving(true);
    try {
      await work();
      if (active.current) onClose();
    } catch (failure) {
      if (active.current) {
        setError(failure instanceof Error ? failure.message : 'Could not save your changes. Try again.');
      }
    } finally {
      setPending(false);
      if (active.current) setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    return save(async () => {
      if (type === 'source') {
        if (!sourceSettings.current) throw new Error('Source settings are still loading.');
        return sourceSettings.current.save();
      }
    });
  }

  const titles: Partial<Record<PipelineDialog['type'], string>> = {
    source: scan?.repo?.name || 'Source',
    service: node?.label || 'Service',
  };

  return <>
    <SheetHeader className="shrink-0 flex-row items-start gap-3 border-b">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center"><InspectorMark provider={provider} type={type} /></span>
      <SheetTitle className="min-w-0 flex-1 py-0.5 text-xl leading-7 tracking-tight [overflow-wrap:anywhere]">{titles[type] || 'Configuration'}</SheetTitle>
      <Button type="button" variant="ghost" size="icon" aria-label="Close" disabled={busy} onClick={onClose}><X /></Button>
    </SheetHeader>
    <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submit} aria-busy={busy}>
      <div className="inspector-body min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <fieldset disabled={busy} className="m-0 min-w-0 space-y-6 border-0 p-0">
          {type === 'source' && <SourceSettings ref={sourceSettings} scan={scan} autoConnect={Boolean(dialog.connect)} busy={busy} onSourceSave={onSourceSave} onBusyChange={setPending} onStateChange={setSourceState} />}

          {type === 'service' && <ServiceSettings nodeId={dialog.nodeId} repoPath={scan?.repo?.path} deployBranches={node?.deployBranches} branch={scan?.repo?.branch} />}
        </fieldset>
        {error && <p role="alert" className="mt-4 break-all text-sm text-destructive">{error}</p>}
      </div>

      {/* A read-only drawer closes from its header; only editable forms carry Cancel and Save. */}
      {type !== 'service' && <SheetFooter className="shrink-0 flex-row flex-wrap justify-end border-t">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || type === 'source' && !sourceState.canSave}>
          {saving ? 'Saving…' : type === 'source' ? 'Save source' : 'Save changes'}
        </Button>
      </SheetFooter>}
    </form>
  </>;
}

type PipelineDialogsProps = {
  dialog: PipelineDialog | null; onClose: () => void; scan: Scan | null; pipeline: PipelineView | null | undefined;
  onSourceSave: (selection: SourceSelection) => Promise<unknown>; onAction: OnAction; onStageRemoved: () => Promise<void>;
  busy?: boolean; onAppSettings: () => void;
};
export default function PipelineDialogs({ dialog, onClose, scan, pipeline, onSourceSave, onAction, onStageRemoved, busy = false, onAppSettings }: PipelineDialogsProps) {
  const [pending, setPending] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const locked = busy || pending;
  const dialogKey = dialog ? [dialog.type, dialog.stageId, dialog.nodeId, dialog.afterStageId, dialog.sourceStageId, dialog.targetStageId, dialog.connect, dialog.connectRequest].join(':') : '';
  useEffect(() => {
    if (!dialog) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && !panel.current?.contains(focused)) focusOrigin.current = focused;
  }, [dialogKey]);
  if (dialog?.type === 'transition') return <TransitionConfirmation key={dialogKey} dialog={dialog} pipeline={pipeline} onAction={onAction} onClose={onClose} busy={busy} />;
  if (dialog?.type === 'stage') return <NewStageDialog key={`${scan?.repo?.path}:${scan?.repo?.branch}:${dialogKey}`} dialog={dialog} pipeline={pipeline} onAction={onAction} onClose={onClose} busy={busy} />;
  if (dialog?.type === 'rename-stage' || dialog?.type === 'remove-stage') return <StageSettingsDialog key={`${scan?.repo?.path}:${scan?.repo?.branch}:${dialogKey}`} dialog={dialog} stage={pipeline?.stages?.find(stage => stage.id === dialog.stageId)} repoPath={scan?.repo?.path} onAction={onAction} onRemoved={onStageRemoved} onClose={onClose} busy={busy} />;
  return <Sheet modal={false} open={Boolean(dialog)} onOpenChange={open => { if (!open && !locked) onClose(); }}>
    {dialog && <SheetContent side="right" showCloseButton={false} className={dialog.type === 'git-graph' ? 'git-graph-inspector' : 'pipeline-inspector'} tabIndex={-1} aria-describedby={undefined}
      onOpenAutoFocus={event => {
        event.preventDefault();
        panel.current = event.target as HTMLElement;
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused !== document.body && !panel.current?.contains(focused)) focusOrigin.current = focused;
        panel.current?.focus?.({ preventScroll: true });
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (focusOrigin.current?.isConnected) focusOrigin.current.focus({ preventScroll: true });
        focusOrigin.current = null;
        panel.current = null;
      }}
      onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()} onKeyDownCapture={event => releaseTabAtEdges(event, focusOrigin.current)}>
      {dialog.type === 'git-graph'
        ? <GitGraphPanel key={`${scan?.repo?.path}:${scan?.repo?.branch}`} scan={scan} onClose={onClose} />
        : dialog.type === 'environment'
        ? <EnvironmentSettings key={`${scan?.repo?.path}:${scan?.repo?.branch}:${dialog.stageId}`} repoPath={scan?.repo?.path} stage={pipeline?.stages?.find(stage => stage.id === dialog.stageId)} initialTab={dialog.tab} initialError={dialog.error} initialWatch={dialog.watch} initialRunId={dialog.runId} initialCaseId={dialog.caseId} caseRequestKey={dialog.caseRequestKey} onClose={onClose} onBusyChange={setPending} onAppSettings={onAppSettings} busy={busy} />
        : <DialogForm key={dialogKey} dialog={dialog} scan={scan} onClose={onClose} onSourceSave={onSourceSave} busy={locked} setPending={setPending} />}
    </SheetContent>}
  </Sheet>;
}
