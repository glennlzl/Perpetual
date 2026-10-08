import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, MoreHorizontal, RefreshCw, Unplug } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { restoreFocus } from '@/lib/journey-focus';
import type { ConnectorApp, ConnectorAuthConfig, ConnectorOptionsReply, ConnectorProvider, ConnectorsReply } from '../../contract/connectors.ts';

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not read connectors. Try again.';
export const matchesApp = (query: string, app: ConnectorApp) => app.name.toLowerCase().includes(query.trim().toLowerCase());
export function AppMark({ app }: { app: ConnectorApp }) {
  return <img src={`/assets/providers/${app.provider}.svg`} className="provider-logo size-8" alt="" width={32} height={32} />;
}

export function useAccountConnectors() {
  const [reply, setReply] = useState<ConnectorsReply | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<readonly (ConnectorProvider | 'all')[]>([]);
  const reading = refreshing.length > 0;
  const [setupOpen, setSetupOpen] = useState(false), [authApp, setAuthApp] = useState<ConnectorApp | null>(null), [removeApp, setRemoveApp] = useState<ConnectorApp | null>(null);
  const [configs, setConfigs] = useState<ConnectorAuthConfig[]>([]), [configId, setConfigId] = useState('');
  const [apiKey, setApiKey] = useState(''), [dialogError, setDialogError] = useState('');
  const active = useRef(true), changing = useRef(false), request = useRef(0), resume = useRef<ConnectorApp | null>(null);
  const readTask = useRef<{ id: number; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async (provider?: ConnectorProvider, quiet = false) => {
    if (changing.current) return;
    if (!quiet) { const target = provider ?? 'all'; setRefreshing(current => current.includes(target) ? current : [...current, target]); }
    if (readTask.current?.id === request.current) return readTask.current.promise;
    const id = ++request.current;
    const promise = (async () => {
      try { const data = await api<ConnectorsReply>('/api/connectors'); if (active.current && id === request.current) { setReply(data); setError(''); } }
      catch (failure) { if (active.current && id === request.current) setError(messageOf(failure)); }
      finally {
        if (readTask.current?.id === id) readTask.current = null;
        if (active.current && id === request.current) setRefreshing([]);
      }
    })();
    readTask.current = { id, promise };
    return promise;
  }, []);
  useEffect(() => {
    active.current = true;
    const id = ++request.current;
    void api<ConnectorsReply>('/api/connectors?cached=1').then(data => {
      if (active.current && id === request.current) { setReply(data); setError(''); }
    }, failure => { if (active.current && id === request.current) setError(messageOf(failure)); }).finally(() => {
      if (active.current && id === request.current) void refresh(undefined, true);
    });
    return () => { active.current = false; };
  }, [refresh]);
  const pending = reply?.apps.some(app => app.account?.status === 'pending') ?? false;
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void refresh(undefined, true); };
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    const timer = pending ? window.setInterval(visible, 5000) : undefined;
    return () => { window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); if (timer) clearInterval(timer); };
  }, [pending, refresh]);
  async function work<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (changing.current) return;
    changing.current = true; request.current++; setBusy(true); setDialogError(''); setError('');
    try { return await operation(); }
    catch (failure) { if (active.current) { setError(messageOf(failure)); setDialogError(messageOf(failure)); } }
    finally { changing.current = false; if (active.current) { setBusy(false); setRefreshing([]); } }
  }
  async function choose(app: ConnectorApp, configured = reply?.configured) {
    resume.current = app; setDialogError('');
    const browser = app.account?.method === 'browser' || !app.account && reply?.method === 'browser';
    if (!browser && !configured) { setSetupOpen(true); return; }
    const popup = browser ? window.open('about:blank', '_blank') : undefined; if (popup) popup.opener = null;
    setAuthApp(app); setConfigs([]); setConfigId('');
    const choices = await work(async () => { const data = await api<ConnectorOptionsReply>('/api/connectors/options', { provider: app.provider }); const choices = browser ? data.accounts ?? [] : data.configs; if (active.current) { setConfigs(choices); setConfigId(choices.length === 1 ? choices[0].id : ''); } return choices; });
    if (browser && choices && choices.length <= 1) await start(app, popup, choices[0]?.id ?? ''); else popup?.close();
  }
  async function setup() {
    const saved = await work(async () => {
      const data = await api<ConnectorsReply>('/api/connectors/setup', { apiKey });
      if (active.current) { setReply(data); setApiKey(''); setSetupOpen(false); }
      return true;
    });
    if (saved && active.current && resume.current) await choose(resume.current, true);
  }
  async function start(app = authApp, existingPopup?: Window | null, selectedId = configId) {
    if (!app || changing.current) return;
    const popup = existingPopup === undefined ? window.open('about:blank', '_blank') : existingPopup; if (popup) popup.opener = null;
    const started = await work(async () => {
      const data = await api<ConnectorsReply>('/api/connectors/start', { provider: app.provider, ...(selectedId ? app.account?.method === 'browser' || !app.account && reply?.method === 'browser' ? { accountId: selectedId } : { configId: selectedId } : {}) });
      const url = data.apps.find(item => item.provider === app.provider)?.account?.redirectUrl;
      if (popup && url) popup.location.href = url; else popup?.close();
      if (active.current) { setReply(data); setAuthApp(null); }
      return true;
    });
    if (!started) { popup?.close(); await refresh(undefined, true); }
  }
  async function remove(app: ConnectorApp, cancel = false) {
    const removed = await work(async () => {
      const data = await api<ConnectorsReply>('/api/connectors/remove', { provider: app.provider, cancel });
      if (active.current) { setReply(data); setRemoveApp(null); }
      return true;
    });
    if (!removed) await refresh(undefined, true);
  }
  async function useBrowser() { await work(async () => { const data = await api<ConnectorsReply>('/api/connectors/browser', {}); if (active.current) setReply(data); }); }
  return { reply, error, busy, reading, refreshing, refresh, choose, setup, start, remove, useBrowser, setupOpen, setSetupOpen, authApp, setAuthApp, removeApp, setRemoveApp, configs, configId, setConfigId, apiKey, setApiKey, dialogError, confirmRemove(app: ConnectorApp) { setDialogError(''); setRemoveApp(app); }, resetSetup() { resume.current = null; setDialogError(''); setSetupOpen(true); } };
}
export type AccountConnections = ReturnType<typeof useAccountConnectors>;

export function AccountConnectorRow({ app, state }: { app: ConnectorApp; state: AccountConnections }) {
  const account = app.account!;
  const refreshing = state.refreshing.includes('all') || state.refreshing.includes(app.provider);
  const status = state.error ? 'Unverified' : account.checking ? 'Checking' : { connected: 'Connected', pending: 'Awaiting sign-in', 'needs-auth': 'Sign-in required', unverified: 'Unverified' }[account.status];
  return <><Item role="listitem" className="flex-nowrap gap-3 p-4">
    <ItemMedia><AppMark app={app} /></ItemMedia>
    <ItemContent className="min-w-0"><ItemTitle>{app.name}<Badge variant="outline">{status}</Badge></ItemTitle>{!account.checking && account.error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{account.error}</p>}</ItemContent>
    <ItemActions>
      {!account.checking && account.status === 'pending' && account.redirectUrl && <Button asChild variant="outline" size="sm"><a href={account.redirectUrl} target="_blank" rel="noopener noreferrer">Continue sign-in<ExternalLink /></a></Button>}
      {!account.checking && account.method === 'browser' && (account.status === 'needs-auth' || account.status === 'unverified') && <Button variant="outline" size="sm" disabled={state.busy} onClick={() => void state.choose(app)}>Sign in again</Button>}
      <Button variant="outline" size="sm" disabled={state.busy || refreshing} aria-label={`Refresh ${app.name}`} onClick={() => void state.refresh(app.provider)}>{refreshing ? <LoaderCircle className="motion-safe:animate-spin" /> : <RefreshCw />}Refresh</Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="size-8" disabled={state.busy} aria-label={`${app.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
        {account.status === 'pending' ? <DropdownMenuItem onSelect={() => void state.remove(app, true)}>Cancel sign-in</DropdownMenuItem> : <DropdownMenuItem variant="destructive" onSelect={() => state.confirmRemove(app)}><Unplug />Disconnect</DropdownMenuItem>}
      </DropdownMenuContent></DropdownMenu>
    </ItemActions>
  </Item><Separator /></>;
}

export function AccountConnectorDialogs({ state, focusTarget }: { state: AccountConnections; focusTarget: () => HTMLElement | null }) {
  const browserAuth = state.authApp?.account?.method === 'browser' || !state.authApp?.account && state.reply?.method === 'browser';
  const returnFocus = (event: Event) => { event.preventDefault(); restoreFocus([focusTarget()]); };
  return <>
    <Dialog open={state.setupOpen} onOpenChange={open => { if (!state.busy) { state.setSetupOpen(open); if (!open) state.setApiKey(''); } }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md" onCloseAutoFocus={returnFocus}><DialogHeader><DialogTitle>Project API Key</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void state.setup(); }}>
          <div className="space-y-2"><Label htmlFor="composio-key">Composio Project API Key</Label><Input id="composio-key" type="password" autoComplete="off" spellCheck={false} aria-describedby="composio-key-location" value={state.apiKey} onChange={event => state.setApiKey(event.target.value)} disabled={state.busy} /></div>
          <div className="space-y-2"><Button asChild variant="link" className="h-auto p-0"><a href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer">Open Composio<ExternalLink /></a></Button><p id="composio-key-location" className="text-sm text-muted-foreground">Platform → your project → API Keys</p></div>
          {state.dialogError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{state.dialogError}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={state.busy} onClick={() => { state.setSetupOpen(false); state.setApiKey(''); }}>Cancel</Button><Button type="submit" disabled={state.busy || !state.apiKey.trim()}>{state.busy && <LoaderCircle className="motion-safe:animate-spin" />}Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(state.authApp)} onOpenChange={open => { if (!open && !state.busy) state.setAuthApp(null); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md" onCloseAutoFocus={returnFocus}><DialogHeader><DialogTitle>Connect {state.authApp?.name}</DialogTitle></DialogHeader>
        {state.configs.length > 1 && <div className="space-y-2"><Label htmlFor="connector-auth">{browserAuth ? 'Account' : 'Authorization'}</Label><Select value={state.configId} onValueChange={state.setConfigId} disabled={state.busy}><SelectTrigger id="connector-auth" className="w-full"><SelectValue placeholder="Select account" /></SelectTrigger><SelectContent>{state.configs.map(config => <SelectItem key={config.id} value={config.id}>{config.name}</SelectItem>)}</SelectContent></Select></div>}
        {state.dialogError && <Button asChild variant="link" className="h-auto justify-start p-0"><a href={browserAuth ? 'https://connect.composio.dev' : 'https://dashboard.composio.dev'} target="_blank" rel="noopener noreferrer">Open Composio<ExternalLink /></a></Button>}
        {state.dialogError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{state.dialogError}</p>}
        <DialogFooter><Button variant="outline" disabled={state.busy} onClick={() => { if (state.authApp) void state.choose(state.authApp); }}>Refresh</Button><Button disabled={state.busy || Boolean(state.dialogError) || (state.configs.length > 1 && !state.configId)} onClick={() => void state.start()}>{state.busy && <LoaderCircle className="motion-safe:animate-spin" />}Sign in with {state.authApp?.name}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(state.removeApp)} onOpenChange={open => { if (!open && !state.busy) state.setRemoveApp(null); }}><AlertDialogContent onCloseAutoFocus={returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>Disconnect {state.removeApp?.name}?</AlertDialogTitle><AlertDialogDescription>{state.removeApp?.account?.method === 'browser' ? 'This disconnects the account from Perpetual. Your Composio connection stays available.' : 'This removes the account from Perpetual and Composio. Sign in again to reconnect.'}</AlertDialogDescription></AlertDialogHeader>
      {state.dialogError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{state.dialogError}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={state.busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={state.busy} onClick={event => { event.preventDefault(); if (state.removeApp) void state.remove(state.removeApp); }}>{state.busy && <LoaderCircle className="motion-safe:animate-spin" />}Disconnect</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
