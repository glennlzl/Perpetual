import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, MoreHorizontal, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { connectorSnapshot } from '@/lib/connector-snapshots';
import { restoreFocus } from '@/lib/journey-focus';
import DisconnectConnectorDialog from './DisconnectConnectorDialog';
import './connector-dialog.css';
import type { ConnectorApp, ConnectorProvider, ConnectorsReply } from '../../contract/connectors.ts';

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not read connectors. Try again.';
export const matchesApp = (query: string, app: ConnectorApp) => `${app.name} ${app.account?.label ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
export function AppMark({ app }: { app: ConnectorApp }) {
  return <img src={`/assets/providers/${app.provider}.svg`} className="provider-logo size-8" alt="" width={32} height={32} />;
}

export function useAccountConnectors() {
  const [reply, setReply] = useState<ConnectorsReply | null>(() => connectorSnapshot.read()), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<readonly (ConnectorProvider | 'all')[]>([]);
  const [verified, setVerified] = useState<readonly ConnectorProvider[]>([]);
  const reading = refreshing.length > 0;
  const [authApp, setAuthApp] = useState<ConnectorApp | null>(null), [removeApp, setRemoveApp] = useState<ConnectorApp | null>(null);
  const [dialogError, setDialogError] = useState('');
  const active = useRef(true), changing = useRef(false), request = useRef(0);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const readTask = useRef<{ id: number; force: ConnectorProvider | 'all' | null; manual: Set<ConnectorProvider | 'all'>; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async (provider?: ConnectorProvider, quiet = false, fresh = !quiet) => {
    if (changing.current) return;
    const target = provider ?? 'all';
    if (!quiet) { setRefreshing(current => current.includes(target) ? current : [...current, target]); setVerified([]); }
    let force: ConnectorProvider | 'all' | null = fresh ? provider ?? 'all' : null;
    const current = readTask.current?.id === request.current ? readTask.current : null;
    if (current && (!force || current.force === 'all' || current.force === force)) {
      if (!quiet) current.manual.add(target);
      return current.promise;
    }
    // A manual refresh must bypass an ordinary read. Different forced providers share a new full check.
    if (current?.force && force) force = 'all';
    const manual = new Set(current?.manual);
    if (!quiet) manual.add(target);
    const id = ++request.current, generation = connectorSnapshot.generation();
    const promise = (async () => {
      try {
        const data = await api<ConnectorsReply>(force ? `/api/connectors?refresh=${force}` : '/api/connectors');
        if (active.current && id === request.current) {
          connectorSnapshot.write(data, '', generation); setReply(data); setError('');
          const connected = data.apps.filter(app => app.account?.status === 'connected' && !app.account.checking).map(app => app.provider);
          if (manual.size) setVerified(connected.filter(provider => manual.has('all') || manual.has(provider)));
          else setVerified(previous => previous.every(provider => connected.includes(provider)) ? previous : previous.filter(provider => connected.includes(provider)));
        }
      }
      catch (failure) { if (active.current && id === request.current) { connectorSnapshot.clear(); setError(messageOf(failure)); setVerified([]); } }
      finally {
        if (readTask.current?.id === id) readTask.current = null;
        if (active.current && id === request.current) setRefreshing([]);
      }
    })();
    readTask.current = { id, force, manual, promise };
    return promise;
  }, []);
  useEffect(() => {
    if (!verified.length) return;
    const timer = window.setTimeout(() => setVerified([]), 5000);
    return () => clearTimeout(timer);
  }, [verified]);
  useEffect(() => {
    active.current = true;
    const id = ++request.current;
    void api<ConnectorsReply>('/api/connectors?cached=1').then(data => {
      if (active.current && id === request.current) { setReply(data); setError(''); }
    }, failure => { if (active.current && id === request.current) setError(messageOf(failure)); }).finally(() => {
      if (active.current && id === request.current) void refresh(undefined, true, true);
    });
    return () => { active.current = false; };
  }, [refresh]);
  const pending = reply?.apps.some(app => app.account?.status === 'pending') ?? false;
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void refresh(undefined, true); };
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    const timer = pending ? window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(undefined, true, true); }, 5000) : undefined;
    return () => { window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); if (timer) clearInterval(timer); };
  }, [pending, refresh]);
  async function work<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (changing.current) return;
    changing.current = true; request.current++; connectorSnapshot.clear(); setBusy(true); setDialogError(''); setError(''); setVerified([]);
    try { return await operation(); }
    catch (failure) { if (active.current) setDialogError(messageOf(failure)); }
    finally { changing.current = false; if (active.current) { setBusy(false); setRefreshing([]); } }
  }
  async function choose(app: ConnectorApp) {
    if (changing.current) return;
    setDialogError('');
    if (!app.configured) {
      setAuthApp(app); setDialogError(app.setupError || `${app.name} sign-in is not configured on this installation.`); return;
    }
    // Open during the click so browsers can retain the new window through the request.
    const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
    const started = await work(async () => {
      const data = await api<ConnectorsReply>('/api/connectors/start', { provider: app.provider });
      const url = data.apps.find(item => item.provider === app.provider)?.account?.redirectUrl;
      if (popup && url && active.current) popup.location.href = url; else popup?.close();
      if (active.current) { connectorSnapshot.write(data); setReply(data); setAuthApp(null); }
      return true;
    });
    if (!started) { popup?.close(); if (active.current) setAuthApp(app); await refresh(undefined, true); }
  }
  async function remove(app: ConnectorApp, cancel = false) {
    const removed = await work(async () => {
      const data = await api<ConnectorsReply>('/api/connectors/remove', { provider: app.provider, cancel });
      if (active.current) { connectorSnapshot.write(data); setReply(data); setRemoveApp(null); }
      return true;
    });
    if (!removed) await refresh(undefined, true);
  }
  return { reply, error, busy, reading, refreshing, verified, refresh, choose, remove, authApp, setAuthApp, removeApp, setRemoveApp, removeTrigger, dialogError, confirmRemove(app: ConnectorApp, trigger: HTMLButtonElement | null) { removeTrigger.current = trigger; setDialogError(''); setRemoveApp(app); } };
}
export type AccountConnections = ReturnType<typeof useAccountConnectors>;

export function AccountConnectorRow({ app, state }: { app: ConnectorApp; state: AccountConnections }) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const account = app.account!;
  const refreshing = state.refreshing.includes('all') || state.refreshing.includes(app.provider);
  const status = refreshing ? 'Checking' : state.error ? 'Unverified' : account.checking ? 'Checking' : { connected: 'Connected', pending: 'Awaiting sign-in', 'needs-auth': 'Sign-in required', unverified: 'Unverified' }[account.status];
  return <><Item role="listitem" className="flex-nowrap gap-3 p-4">
    <ItemMedia><AppMark app={app} /></ItemMedia>
    <ItemContent className="min-w-0"><ItemTitle>{app.name}<Badge variant="outline" aria-live="polite">{refreshing && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}{status}</Badge></ItemTitle>{account.label && <span className="truncate text-sm text-muted-foreground">{account.label}</span>}{!account.checking && account.error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{account.error}</p>}</ItemContent>
    <ItemActions>
      {state.verified.includes(app.provider) && !refreshing && !state.error && account.status === 'connected' && !account.checking && <span role="status" className="flex items-center gap-1.5 text-sm text-[var(--success)]"><Check className="size-4" aria-hidden="true" />Connection verified</span>}
      {!account.checking && account.status === 'pending' && account.redirectUrl && <Button asChild variant="outline" size="sm"><a href={account.redirectUrl} target="_blank" rel="noopener noreferrer">Continue sign-in<ExternalLink /></a></Button>}
      {!account.checking && (state.error || account.status === 'unverified') && <Button variant="outline" size="sm" disabled={state.busy || refreshing} onClick={() => void state.refresh(app.provider)}>{refreshing ? <LoaderCircle className="motion-safe:animate-spin" /> : null}Try again</Button>}
      {!account.checking && account.status === 'needs-auth' && <Button variant="outline" size="sm" disabled={state.busy} onClick={() => void state.choose(app)}>Sign in again</Button>}
      <DropdownMenu><DropdownMenuTrigger asChild><Button ref={menuButton} size="icon" variant="outline" className="size-8" disabled={state.busy} aria-label={`${app.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem disabled={refreshing} onSelect={() => void state.refresh(app.provider)}>Check connection</DropdownMenuItem>
        {account.status === 'pending' ? <DropdownMenuItem onSelect={() => void state.remove(app, true)}>Cancel sign-in</DropdownMenuItem> : <DropdownMenuItem variant="destructive" onSelect={() => state.confirmRemove(app, menuButton.current)}><Unplug />Disconnect</DropdownMenuItem>}
      </DropdownMenuContent></DropdownMenu>
    </ItemActions>
  </Item><Separator /></>;
}

export function AccountConnectorDialogs({ state, focusTarget }: { state: AccountConnections; focusTarget: () => HTMLElement | null }) {
  const returnFocus = (event: Event) => { event.preventDefault(); restoreFocus([focusTarget()]); };
  return <>
    <Dialog open={Boolean(state.authApp)} onOpenChange={open => { if (!open && !state.busy) state.setAuthApp(null); }}>
      <DialogContent className="connector-account-dialog" showCloseButton={false} aria-busy={state.busy} onCloseAutoFocus={returnFocus}>
        <div className="flex items-center gap-4">
          <div className="shrink-0" aria-hidden="true">{state.authApp && <AppMark app={state.authApp} />}</div>
          <DialogHeader className="min-w-0 flex-1">
            <DialogTitle>Connect {state.authApp?.name}</DialogTitle>
            <DialogDescription aria-live="polite">{state.busy ? 'Connecting…' : state.authApp?.configured ? 'Connection failed' : 'Setup required'}</DialogDescription>
          </DialogHeader>
        </div>
        {state.dialogError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{state.dialogError}</p>}
        <DialogFooter><Button variant="ghost" disabled={state.busy} onClick={() => state.setAuthApp(null)}>Cancel</Button>{state.authApp?.configured && <Button disabled={state.busy} onClick={() => { if (state.authApp) void state.choose(state.authApp); }}>{state.busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}{state.busy ? 'Connecting…' : 'Try again'}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
    <DisconnectConnectorDialog open={Boolean(state.removeApp)} provider={state.removeApp?.name ?? ''} account={state.removeApp?.account?.label} mark={state.removeApp && <AppMark app={state.removeApp} />} busy={state.busy} error={state.dialogError} onOpenChange={open => { if (!open) state.setRemoveApp(null); }} onConfirm={() => { if (state.removeApp) void state.remove(state.removeApp); }} focusTargets={() => [state.removeTrigger.current, focusTarget()]} />
  </>;
}
