import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type Ref, type SetStateAction } from 'react';
import { Check, ExternalLink, Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useActionFocus } from '@/lib/journey-focus';

/** GET /api/settings/model: the model settings; the stored key itself is never returned. */
type ModelCapabilities = { provider: 'openrouter' | 'custom'; model: string; baseUrl: string; keyConfigured: boolean; modelConfigured: boolean; modelError?: string; escalationModel?: string };
/** An eligible model in the OpenRouter catalog (GET /api/settings/models). */
type CatalogModel = { id: string; name: string; provider: string };
type Catalog = { models: CatalogModel[]; defaultModel?: string; defaultEscalationModel?: string };
type ModelGroup = { label: string; models: CatalogModel[] };
/** Unsaved App Settings edits; they outlive the page until saved or discarded. escalationModel is what build repairs escalate to. */
export type SettingsDraft = { model: string; apiKey: string; escalationModel: string };

const openRouter = (capabilities: ModelCapabilities | null) => capabilities?.provider === 'openrouter';
const providerNames: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'meta-llama': 'Meta', 'x-ai': 'xAI', qwen: 'Qwen', mistralai: 'Mistral', nvidia: 'NVIDIA', openrouter: 'OpenRouter', rekaai: 'Reka' };
const namePrefix = (name: string) => /^([^:]{1,48}):\s+\S/.exec(name)?.[1].trim();
// Groups are named as the catalog names its models ("Meta: Llama 4"), so slugs that share
// a vendor merge; the slug is only a fallback for a provider whose names carry no prefix.
function modelGroups(models: CatalogModel[], pinnedId?: string) {
  const prefixes = new Map<string, Map<string, number>>();
  for (const item of models) {
    const prefix = namePrefix(item.name);
    if (!prefix) continue;
    const counts = prefixes.get(item.provider) || new Map();
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
    prefixes.set(item.provider, counts);
  }
  const labelFor = (provider: string) => {
    const counts = prefixes.get(provider);
    if (counts) return [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
    return providerNames[provider] || String(provider).split(/[-_.]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
  };
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const groups = new Map<string, ModelGroup>();
  for (const item of models) {
    if (item.id === pinnedId) continue;
    const label = labelFor(item.provider);
    const key = label.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { label, models: [] });
    groups.get(key)!.models.push(item);
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.label, b.label))
    .map(group => ({ ...group, models: group.models.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id)) }));
}
// Inside its group a model drops the repeated vendor prefix; typeahead still matches the full name.
const modelOption = (item: CatalogModel, group?: string) => {
  const prefix = namePrefix(item.name);
  const text = group && prefix?.toLocaleLowerCase() === group.toLocaleLowerCase() ? item.name.slice(item.name.indexOf(':') + 1).trim() : item.name;
  return <SelectItem value={item.id} key={item.id} textValue={item.name}><span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{text}</span></SelectItem>;
};

// The pinned model stays visible while the catalog scrolls; keyboard focus scrolls items clear of it.
function PinnedGroup({ label, children }: { label: string; children: ReactNode }) {
  const ref = useCallback((group: HTMLDivElement | null) => {
    const viewport = group?.parentElement;
    if (!viewport) return;
    const sync = () => { viewport.style.scrollPaddingTop = `${group.offsetHeight}px`; };
    const observer = new ResizeObserver(sync);
    observer.observe(group);
    sync();
    return () => { observer.disconnect(); viewport.style.scrollPaddingTop = ''; };
  }, []);
  return <SelectGroup ref={ref} className="sticky top-0 z-10 flow-root bg-popover"><SelectLabel>{label}</SelectLabel>{children}</SelectGroup>;
}

// A catalog Select whose saved or preselected model stays pinned above the provider groups.
function ModelSelect({ id, value, models, pinned, pinnedLabel, disabled, loading, onChange, triggerRef }: { id: string; value: string; models: CatalogModel[]; pinned?: CatalogModel; pinnedLabel: string; disabled: boolean; loading: boolean; onChange: (value: string) => void; triggerRef?: Ref<HTMLButtonElement> }) {
  const selected = models.find(item => item.id === value);
  const groups = useMemo(() => modelGroups(models, pinned?.id), [models, pinned]);
  // Radix can report an empty form value while asynchronously loaded options
  // register. Every selectable model has an id; that empty value is not an edit.
  return <Select value={selected ? value : ''} disabled={disabled} onValueChange={next => { if (next) onChange(next); }}>
    <SelectTrigger ref={triggerRef} id={id} className="min-w-0 w-full data-[size=default]:h-10" title={selected?.name}><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={loading ? 'Loading models…' : 'Select a model'}>{selected?.name}</SelectValue></span></SelectTrigger>
    <SelectContent position="popper" align="start" collisionPadding={16} className="max-h-[min(60dvh,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]">{pinned && <PinnedGroup label={pinnedLabel}>{modelOption(pinned)}{groups.length > 0 && <SelectSeparator />}</PinnedGroup>}{groups.map(group => <SelectGroup key={group.label}><SelectLabel>{group.label}</SelectLabel>{group.models.map(item => modelOption(item, group.label))}</SelectGroup>)}</SelectContent>
  </Select>;
}

export default function AppSettings({ draft, onDraftChange }: { draft: SettingsDraft | null; onDraftChange: Dispatch<SetStateAction<SettingsDraft | null>> }) {
  const [capabilities, setCapabilities] = useState<ModelCapabilities | null>(null);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [savedModel, setSavedModel] = useState('');
  const [serverModel, setServerModel] = useState('');
  const [savedEscalation, setSavedEscalation] = useState('');
  const [serverEscalation, setServerEscalation] = useState('');
  const model = draft?.model ?? savedModel;
  const escalationModel = draft?.escalationModel ?? savedEscalation;
  const apiKey = draft?.apiKey ?? '';
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = Boolean(draft);
  // An automatically chosen default is savable but is not an unsaved user edit.
  const suggested = !dirty && (Boolean(savedModel) && savedModel !== serverModel || Boolean(savedEscalation) && savedEscalation !== serverEscalation);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const loadingRef = useRef(false);
  const modelsLoadingRef = useRef(false);
  const savingRef = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const rememberSettingsFocus = useActionFocus(loading || saving, () => [keyInput.current]);
  const rememberModelsFocus = useActionFocus(modelsLoading, () => [modelTrigger.current]);
  const hasSavedKey = openRouter(capabilities) && capabilities!.keyConfigured;
  const validModel = models.some(item => item.id === model);
  const validEscalation = models.some(item => item.id === escalationModel);
  // The saved models, or the preselected defaults, stay pinned above the provider groups.
  const pinnedModel = models.find(item => item.id === savedModel);
  const pinnedEscalation = models.find(item => item.id === savedEscalation);

  function acceptCatalog(catalog: Catalog, preferred = '', preferredEscalation = '') {
    setModels(catalog.models);
    const listed = (id: string) => catalog.models.some(item => item.id === id);
    const selected = listed(preferred) ? preferred : catalog.defaultModel;
    setSavedModel(selected || '');
    setSavedEscalation(listed(preferredEscalation) ? preferredEscalation : catalog.defaultEscalationModel || selected || '');
  }
  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true); setError(''); setModelsError('');
    const [settings, catalog] = await Promise.allSettled([api<{ capabilities: ModelCapabilities }>('/api/settings/model'), api<Catalog>('/api/settings/models')]);
    loadingRef.current = false;
    if (!active.current) return;
    let preferred = '', preferredEscalation = '';
    if (settings.status === 'fulfilled') {
      const next = settings.value.capabilities;
      setCapabilities(next);
      preferred = openRouter(next) ? next.model : '';
      preferredEscalation = openRouter(next) ? next.escalationModel || '' : '';
      setServerModel(preferred);
      setServerEscalation(preferredEscalation);
    } else setError((settings.reason as Error).message);
    if (catalog.status === 'fulfilled') acceptCatalog(catalog.value, preferred, preferredEscalation);
    else { setSavedModel(preferred); setSavedEscalation(preferredEscalation); setModelsError((catalog.reason as Error).message); }
    setLoading(false);
    setLoaded(true);
  }
  async function reloadModels() {
    if (modelsLoadingRef.current) return;
    modelsLoadingRef.current = true; setModelsLoading(true); setModelsError('');
    try {
      const catalog = await api<Catalog>('/api/settings/models');
      if (active.current) acceptCatalog(catalog, model, escalationModel);
    } catch (failure) { if (active.current) setModelsError((failure as Error).message); }
    finally { modelsLoadingRef.current = false; if (active.current) setModelsLoading(false); }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
  function changed(values: Partial<SettingsDraft>) {
    onDraftChange({ model, apiKey, escalationModel, ...values });
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || !validModel || !capabilities) return;
    rememberSettingsFocus();
    const submittedDraft = draft;
    savingRef.current = true; setSaving(true); setError(''); setSaved(false);
    try {
      const { capabilities: next } = await api<{ capabilities: ModelCapabilities }>('/api/settings/model', { model, ...(validEscalation ? { escalationModel } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      // A completed save may outlive this page; retain any newer edits.
      onDraftChange(current => current === submittedDraft ? null : current);
      if (!active.current) return;
      setCapabilities(next); setSavedModel(next.model); setServerModel(next.model); setSavedEscalation(next.escalationModel || escalationModel); setServerEscalation(next.escalationModel || ''); setShowKey(false); setSaved(true);
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { savingRef.current = false; if (active.current) setSaving(false); }
  }

  return <main className="app-settings min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10 lg:py-14" id="settings">
    <section className="mx-auto w-full max-w-2xl" aria-labelledby="openrouter-heading">
      <header className="flex flex-wrap items-center justify-between gap-4 pb-8">
        <div className="flex items-center gap-3"><img src="/assets/providers/openrouter.svg" alt="" width={28} height={28} className="size-7 dark:invert" /><h1 id="openrouter-heading" className="text-xl font-semibold tracking-tight">OpenRouter</h1></div>
        <Button variant="outline" size="sm" asChild><a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">Get API Key<ExternalLink /></a></Button>
      </header>
      <Separator />
      {!loaded ? <div role="status" aria-label="Loading settings" className="divide-y">
        {[0, 1].map(row => <div key={row} className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8" aria-hidden="true"><Skeleton className="h-4 w-28 sm:mt-3" /><Skeleton className="h-10 w-full" /></div>)}
      </div> : <form onSubmit={save}>
        <fieldset disabled={saving || !capabilities} className="m-0 min-w-0 border-0 p-0">
          <div className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
            {/* The stored key is never returned, so its state is named beside the label. */}
            <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start sm:self-start sm:pt-3">
              <Label htmlFor="openrouter-api-key">OpenRouter API Key</Label>
              {capabilities && <Badge id="openrouter-api-key-state" variant={hasSavedKey ? 'secondary' : 'outline'}>{hasSavedKey ? 'Saved' : 'Not set'}</Badge>}
            </div>
            <div className="relative min-w-0"><Input ref={keyInput} id="openrouter-api-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required={!hasSavedKey} aria-describedby={capabilities ? 'openrouter-api-key-state' : undefined} placeholder={hasSavedKey ? '••••••••••••••••••••••••' : 'sk-or-v1-…'} value={apiKey} maxLength={4096} className="h-10 pr-11" onChange={event => { changed({ apiKey: event.target.value }); }} /><Button type="button" variant="ghost" size="icon-sm" className="absolute top-1 right-1" disabled={!apiKey || saving} aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff /> : <Eye />}</Button></div>
          </div>
          <Separator />
          <div className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
            <Label htmlFor="openrouter-model" className="sm:self-start sm:pt-3">Model</Label>
            <div className="min-w-0 space-y-3">
              <ModelSelect id="openrouter-model" value={model} models={models} pinned={pinnedModel} pinnedLabel={savedModel === serverModel ? 'Current' : 'Default'} triggerRef={modelTrigger} disabled={saving || modelsLoading || !models.length || !capabilities} loading={modelsLoading} onChange={value => { changed({ model: value }); }} />
              {(modelsError || modelsLoading) && <div className="space-y-2">{modelsError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{modelsError}</p>}<Button type="button" variant="outline" size="sm" disabled={saving} aria-disabled={modelsLoading} aria-busy={modelsLoading} className="aria-disabled:opacity-50" onClick={() => { if (!modelsLoading) { rememberModelsFocus(); void reloadModels(); } }}><RefreshCw className={modelsLoading ? 'motion-safe:animate-spin' : ''} />Reload models</Button></div>}
            </div>
          </div>
          <Separator />
          <div className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
            <Label htmlFor="openrouter-escalation-model" className="sm:self-start sm:pt-3">Escalation model</Label>
            <div className="min-w-0"><ModelSelect id="openrouter-escalation-model" value={escalationModel} models={models} pinned={pinnedEscalation} pinnedLabel={savedEscalation === serverEscalation ? 'Current' : 'Default'} disabled={saving || modelsLoading || !models.length || !capabilities} loading={modelsLoading} onChange={value => { changed({ escalationModel: value }); }} /></div>
          </div>
        </fieldset>
        <Separator />
        <footer className="flex items-center justify-end gap-3 py-6">{dirty && <Button type="button" variant="ghost" disabled={saving} onClick={() => { rememberSettingsFocus(); onDraftChange(null); setShowKey(false); }}>Discard changes</Button>}{saved && <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Check className="size-4" />Saved</span>}{!capabilities ? <Button type="button" variant="outline" aria-disabled={loading} aria-busy={loading} className="aria-disabled:opacity-50" onClick={() => { if (!loading) { rememberSettingsFocus(); void load(); } }}>{loading && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}Try again</Button> : <Button type="submit" disabled={saving || modelsLoading || !(dirty || suggested) || !validModel || (!apiKey.trim() && !hasSavedKey)}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}{saving ? 'Saving…' : 'Save changes'}</Button>}</footer>
      </form>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    </section>
  </main>;
}
