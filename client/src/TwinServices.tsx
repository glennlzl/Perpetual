import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ChevronDown, ExternalLink, LoaderCircle, LockKeyhole } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { monochromeAsset, providerAsset } from '@/lib/provider-assets';
import { twinInputsChanges, twinInputsRequest, twinKeyFields, twinProvisionRequest, twinServiceRows, type TwinService } from '@/lib/twin-services';
import type { Environment } from '@/lib/test-workspace';

/** GET /api/twin/services: a Sandbox stage's twin services and the inputs each still needs; views never carry values. */
type TwinServiceRow = ReturnType<typeof twinServiceRows>[number];
type ServicesView = { key: string; services: TwinService[]; generated: boolean; error: string };

// The services in a Sandbox stage's twin config; nothing shows when it has none.
// A service blocked on inputs the user supplies connects them in place; one that can be provisioned
// also creates them, and once provisioned shows its expiry and claim link.
export default function TwinServices({ repoPath, scannedAt, stageId, environment }: { repoPath?: string; scannedAt?: string; stageId: string; environment?: Environment | null }) {
  const revision = useSyncExternalStore(twinInputsChanges.subscribe, twinInputsChanges.revision);
  const key = JSON.stringify([repoPath, scannedAt, stageId]);
  // Creating an environment may write the stage's twin config, so its services load again as the environment changes.
  const environmentState = `${environment?.id ?? ''}:${environment?.status ?? ''}`;
  const [view, setView] = useState<ServicesView | null>(null);
  const [connecting, setConnecting] = useState<TwinServiceRow | null>(null);
  useEffect(() => {
    if (!repoPath || !stageId) return undefined;
    const controller = new AbortController();
    api<{ services: TwinService[]; generated?: boolean }>(`/api/twin/services?${new URLSearchParams({ repoPath, stageId })}`, undefined, { signal: controller.signal }).then(
      result => setView({ key, services: result.services, generated: result.generated === true, error: '' }),
      (failure: Error) => { if (failure.name !== 'AbortError') setView({ key, services: [], generated: false, error: failure.message }); });
    return () => controller.abort();
  }, [key, revision, environmentState]);
  // A previous source's rows never show while the current one loads.
  const current = view?.key === key ? view : null;
  if (!current || (!current.error && !current.services.length)) return null;
  const rows = twinServiceRows(current.services, environment);
  const blocked = rows.filter(row => row.status === 'blocked').length;
  return <Collapsible defaultOpen={false} className="nodrag nopan min-w-0">
    <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 justify-start gap-2 px-1 text-xs [&[data-state=open]>svg]:rotate-180">
      Services{!current.error && <Badge variant="secondary">{rows.length}</Badge>}{current.generated && <Badge variant="outline">Generated</Badge>}{blocked > 0 && <Badge variant="outline"><LockKeyhole aria-hidden="true" />{blocked}<span className="sr-only"> blocked</span></Badge>}<ChevronDown className="size-3.5 text-muted-foreground transition-transform" />
    </Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-1">
      {current.error ? <p role="alert" className="break-words px-1 text-xs text-destructive">{current.error}</p>
        : <ItemGroup aria-label="Services">{rows.map(row => {
          const asset = providerAsset(row.provider || row.id) || 'service';
          return <Item key={row.id} role="listitem" size="sm" className="flex-nowrap gap-2 px-1 py-1.5">
          <ItemMedia><img className="provider-logo size-5 object-contain" data-monochrome={monochromeAsset(asset)} src={`/assets/providers/${asset}.svg`} alt="" width={20} height={20} /></ItemMedia>
          <ItemContent className="min-w-0"><ItemTitle className="flex-wrap gap-1.5 break-words">{row.title}<Badge variant="outline" className="text-[10px]">{row.fidelityLabel}</Badge>{row.sourceLabel && <Badge variant="outline" className="text-[10px]">{row.sourceLabel}</Badge>}{row.expiresLabel && <Badge variant="outline" className="text-[10px]">{row.expiresLabel}</Badge>}
            {row.claimUrl && <Button asChild variant="link" size="sm" className="h-5 gap-1 px-0 text-xs has-[>svg]:px-0"><a href={row.claimUrl} target="_blank" rel="noopener noreferrer">Claim<ExternalLink className="size-3" /></a></Button>}</ItemTitle></ItemContent>
          <ItemActions className="shrink-0 gap-1.5">
            {row.connectable && <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setConnecting(row)}>Connect</Button>}
            <Badge variant="secondary">{row.statusLabel}</Badge>
          </ItemActions>
        </Item>; })}</ItemGroup>}
    </CollapsibleContent>
    {connecting && <ConnectDialog service={connecting} onClose={() => setConnecting(null)} onSaved={() => { setConnecting(null); twinInputsChanges.notify(); }} />}
  </Collapsible>;
}

function Field({ id, label, type = 'text', autoComplete = 'off', value, invalid, onChange }: { id: string; label?: string; type?: string; autoComplete?: string; value: string; invalid: boolean; onChange: (value: string) => void }) {
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type={type} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false} required value={value} aria-invalid={invalid || undefined} onChange={event => onChange(event.target.value)} />
  </div>;
}

function ConnectDialog({ service, onClose, onSaved }: { service: TwinServiceRow; onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState('create');
  const [values, setValues] = useState<Record<string, string>>({});
  // Provision inputs start from the controller's defaults, such as the git email, and stay editable.
  const [provision, setProvision] = useState<Record<string, string>>(() => Object.fromEntries((service.provision?.inputs ?? []).map(input => [input.name, input.value ?? ''])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fields = twinKeyFields(service);
  const request = twinInputsRequest(service, values), provisionRequest = twinProvisionRequest(service, provision);
  async function submit(event: FormEvent, path: string, body: unknown, method?: string) {
    event.preventDefault();
    if (saving || !body) return;
    setSaving(true); setError('');
    try { await api(path, body, { method }); onSaved(); }
    catch (failure) { setError((failure as Error).message); setSaving(false); }
  }
  const failure = error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>;
  const footer = (label: string, ready: unknown) => <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || !ready}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}{label}</Button></DialogFooter>;
  const keys = <form onSubmit={event => submit(event, '/api/twin/inputs', request, 'PUT')} autoComplete="off" className="space-y-4">
    <fieldset disabled={saving} className="space-y-4">
      {fields.map(input => <Field key={input.name} id={`twin-${service.id}-${input.name}`} label={input.label} type={input.secret ? 'password' : 'text'} autoComplete={input.secret ? 'new-password' : 'off'}
        value={values[input.name] ?? ''} invalid={Boolean(error)} onChange={value => { setValues(previous => ({ ...previous, [input.name]: value })); setError(''); }} />)}
    </fieldset>
    {failure}
    {footer('Save', request)}
  </form>;
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent aria-describedby={undefined} showCloseButton={!saving} className="sm:max-w-md">
    <DialogHeader><DialogTitle>{service.title}</DialogTitle></DialogHeader>
    {service.provision ? <Tabs value={tab} onValueChange={value => { setTab(value); setError(''); }} className="min-w-0 gap-4">
      <TabsList className="w-full"><TabsTrigger value="create" disabled={saving}>Create sandbox</TabsTrigger><TabsTrigger value="keys" disabled={saving}>Use keys</TabsTrigger></TabsList>
      <TabsContent value="create">
        <form onSubmit={event => submit(event, '/api/twin/inputs/provision', provisionRequest)} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
            {service.provision.inputs.map(input => <Field key={input.name} id={`twin-${service.id}-provision-${input.name}`} label={input.label} type={input.name === 'email' ? 'email' : 'text'} autoComplete={input.name === 'email' ? 'email' : 'off'}
              value={provision[input.name] ?? ''} invalid={Boolean(error)} onChange={value => { setProvision(previous => ({ ...previous, [input.name]: value })); setError(''); }} />)}
          </fieldset>
          {failure}
          {footer('Create sandbox', provisionRequest)}
        </form>
      </TabsContent>
      <TabsContent value="keys">{keys}</TabsContent>
    </Tabs> : keys}
  </DialogContent></Dialog>;
}
