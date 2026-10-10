import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, MoreHorizontal, Plus, Plug, Search, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { githubSnapshot } from '@/lib/connector-snapshots';
import { githubConnectionChanges } from '@/lib/github-connection-changes';
import { buildChanges } from '@/lib/pipeline-github';
import { deploymentChanges } from '@/lib/pipeline-deployments';
import { releaseChanges } from '@/lib/production-release';
import { restoreFocus } from '@/lib/journey-focus';
import GitHubConnectDialog from './GitHubConnectDialog';
import DisconnectConnectorDialog from './DisconnectConnectorDialog';
import { AccountConnectorDialogs, AccountConnectorRow, AppMark, matchesApp, useAccountConnectors } from './AccountConnectors';
import type { GitHubConnection } from '../../contract/github.ts';

const readGitHubAgain = () => { buildChanges.notify(); deploymentChanges.notify(); releaseChanges.notify(); };
const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : 'Could not read GitHub. Try again.';
const matches = (query: string, account?: string) => `GitHub ${account || ''}`.toLowerCase().includes(query.trim().toLowerCase());

function GitHubMark() {
  return <img src="/assets/providers/github.svg" className="provider-logo size-8" data-monochrome="true" alt="" width={32} height={32} />;
}

function SearchConnectors({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <div className="relative">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    <Input type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} className="pl-9" />
  </div>;
}

// Account management is app-wide; it neither selects a repository nor creates a pipeline.
export default function Connectors({ connectionRevision }: { connectionRevision: string }) {
  const accounts = useAccountConnectors();
  const [connection, setConnection] = useState<GitHubConnection | null>(() => githubSnapshot.read(connectionRevision));
  const [loading, setLoading] = useState(() => !githubSnapshot.read(connectionRevision));
  const [refreshing, setRefreshing] = useState(false);
  const [verified, setVerified] = useState(false);
  const [action, setAction] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const active = useRef(true), request = useRef(0), changing = useRef(false);
  const readTask = useRef<{ id: number; manual: boolean; promise: Promise<void> } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null), menuButton = useRef<HTMLButtonElement>(null);

  const readConnection = useCallback(async (manual = false, changed = false) => {
    if (changing.current) return;
    // Account changes supersede a read started before the change; focus and manual reads can share it.
    if (changed) { request.current++; setVerified(false); setRefreshing(false); }
    if (manual) { setRefreshing(true); setVerified(false); }
    if (readTask.current?.id === request.current) {
      if (manual) readTask.current.manual = true;
      return readTask.current.promise;
    }
    const id = ++request.current, generation = githubSnapshot.generation();
    const promise = (async () => {
      try {
        const next = await api<GitHubConnection>('/api/github/connection');
        if (active.current && request.current === id) {
          githubSnapshot.write(next, connectionRevision, generation); setConnection(next); setError('');
          if (readTask.current?.id === id && readTask.current.manual) setVerified(next.connected && next.authenticated && !next.unreachable);
          else if (!next.connected || !next.authenticated || next.unreachable) setVerified(false);
        }
      } catch (failure) {
        if (active.current && request.current === id) { githubSnapshot.clear(); setError(messageOf(failure)); setVerified(false); }
      } finally {
        if (readTask.current?.id === id) readTask.current = null;
        if (active.current && request.current === id) { setLoading(false); setRefreshing(false); }
      }
    })();
    readTask.current = { id, manual, promise };
    return promise;
  }, [connectionRevision]);

  useEffect(() => {
    if (!verified) return;
    const timer = window.setTimeout(() => setVerified(false), 5000);
    return () => clearTimeout(timer);
  }, [verified]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  // The workspace observes changes in other tabs. Refresh the verified account when its record changes.
  useEffect(() => { void readConnection(false, true); }, [connectionRevision, readConnection]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void readConnection(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = githubConnectionChanges.subscribe(() => void readConnection(false, true));
    return () => { window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); unsubscribe(); };
  }, [readConnection]);

  async function changeConnection(nextAction: 'connect' | 'disconnect') {
    if (changing.current || loading) throw new Error('Wait for GitHub to finish checking.');
    changing.current = true;
    request.current++;
    setVerified(false);
    githubSnapshot.clear();
    setAction(nextAction);
    setError('');
    try {
      const next = await api<GitHubConnection>(`/api/github/${nextAction}`, {});
      if (active.current) {
        setConnection(next);
        setQuery('');
        if (nextAction === 'disconnect') setDisconnectOpen(false);
      }
      githubConnectionChanges.notify(nextAction);
    } catch (failure) {
      if (active.current) setError(messageOf(failure));
      throw failure;
    } finally {
      changing.current = false;
      if (active.current) { setAction(null); setRefreshing(false); }
      readGitHubAgain();
    }
  }

  const unavailable = Boolean(connection?.unreachable || error);
  const connected = Boolean(connection?.connected);
  const listed = connected || Boolean(connection?.unreachable);
  const account = connection?.account?.login;
  const initialLoading = loading || !accounts.reply && !accounts.error;
  const busy = initialLoading || refreshing || Boolean(action);
  const openPicker = () => { setPickerQuery(''); setPickerOpen(true); };
  const connectionError = error || (connection?.unreachable ? connection.message || 'GitHub is unreachable. Try again.' : '');
  const accountRows = accounts.reply?.apps.filter(app => app.account) ?? [];
  const matchingAccounts = accountRows.filter(app => matchesApp(query, app));
  const githubMatches = listed && matches(query, account);
  const anyListed = listed || accountRows.length > 0;

  return <main id="connectors" className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
        <Button ref={addButton} size="sm" disabled={busy || accounts.busy} onClick={openPicker}><Plus />Connect app</Button>
      </div>
      <h2 className="mb-4 text-sm font-medium">Connected apps</h2>
      <SearchConnectors label="Search connected apps" value={query} onChange={setQuery} />
      <div className="mt-4">
        {initialLoading ? <div className="space-y-3" role="status" aria-label="Loading connectors"><Skeleton className="h-20 w-full" /></div>
          : githubMatches || matchingAccounts.length ? <ItemGroup aria-label="Connected apps">
            {githubMatches && <><Item role="listitem" className="flex-nowrap gap-3 p-4">
              <ItemMedia><GitHubMark /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>GitHub<Badge variant="outline" aria-live="polite">{refreshing && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}{refreshing ? 'Checking' : unavailable ? 'Unverified' : 'Connected'}</Badge></ItemTitle>
                {account && <span className="truncate text-sm text-muted-foreground">{account}</span>}
              </ItemContent>
              <ItemActions>
                {verified && !refreshing && !unavailable && <span role="status" className="flex items-center gap-1.5 text-sm text-[var(--success)]"><Check className="size-4" aria-hidden="true" />Connection verified</span>}
                {unavailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void readConnection(true)}>{refreshing && <LoaderCircle className="motion-safe:animate-spin" />}Try again</Button>}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button ref={menuButton} size="icon" variant="outline" className="size-8" disabled={busy} aria-label="GitHub actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void readConnection(true)}>Check connection</DropdownMenuItem><DropdownMenuItem variant="destructive" onSelect={() => setDisconnectOpen(true)}><Unplug />Disconnect</DropdownMenuItem></DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
            <Separator /></>}
            {matchingAccounts.map(app => <AccountConnectorRow key={app.provider} app={app} state={accounts} />)}
          </ItemGroup>
            : anyListed ? <p className="py-12 text-center text-sm text-muted-foreground">No matching apps</p>
              : !connectionError && !accounts.error && accounts.reply && <div className="flex flex-col items-center gap-4 py-16">
                <Plug className="size-8 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-base font-medium">No apps connected</h3>
                <Button size="sm" disabled={busy} onClick={openPicker}><Plus />Connect app</Button>
              </div>}
      </div>
      {connectionError && <div className="mt-4 flex items-start justify-between gap-4"><p className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">{connectionError}</p>{!listed && <Button variant="outline" size="sm" disabled={busy} onClick={() => void readConnection(true)}>Try again</Button>}</div>}
      {accounts.error && <div className="mt-4 flex items-start justify-between gap-4"><p className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">{accounts.error}</p><Button variant="outline" size="sm" disabled={accounts.busy || accounts.reading} onClick={() => void accounts.refresh()}>Try again</Button></div>}
    </div>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <DialogContent className="sm:max-w-xl" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (!connectOpen && !accounts.authApp) restoreFocus([addButton.current]); }}>
        <DialogHeader><DialogTitle>Available apps</DialogTitle></DialogHeader>
        <SearchConnectors label="Search available apps" value={pickerQuery} onChange={setPickerQuery} />
        {!connected && !unavailable && matches(pickerQuery) ? <Item className="flex-nowrap gap-3 px-2 py-3">
          <ItemMedia><GitHubMark /></ItemMedia><ItemContent><ItemTitle>GitHub</ItemTitle></ItemContent>
          <ItemActions><Button variant="outline" size="sm" className="w-24 shadow-none" aria-label="Connect GitHub" disabled={busy} onClick={() => { setPickerOpen(false); setConnectOpen(true); }}>Connect</Button></ItemActions>
        </Item> : null}
        {accounts.reply?.apps.filter(app => !app.account && matchesApp(pickerQuery, app)).map(app => <Item key={app.provider} className="flex-nowrap gap-3 px-2 py-3"><ItemMedia><AppMark app={app} /></ItemMedia><ItemContent><ItemTitle>{app.name}{!app.configured && <Badge variant="outline">Setup required</Badge>}</ItemTitle></ItemContent><ItemActions><Button variant="outline" size="sm" className="w-24 shadow-none" aria-label={`Connect ${app.name}`} disabled={accounts.busy} onClick={() => { setPickerOpen(false); void accounts.choose(app); }}>Connect</Button></ItemActions></Item>)}
        {!accounts.reply && <p className="py-4 text-sm text-muted-foreground">{accounts.error ? 'Could not read available apps.' : 'Loading apps…'}</p>}
        {accounts.reply && !accounts.reply.apps.some(app => !app.account && matchesApp(pickerQuery, app)) && (connected || unavailable || !matches(pickerQuery)) && <p className="py-8 text-center text-sm text-muted-foreground">No matching apps</p>}
      </DialogContent>
    </Dialog>
    <AccountConnectorDialogs state={accounts} focusTarget={() => addButton.current} />
    {connectOpen && <GitHubConnectDialog connection={connection} checking={loading} onConnect={() => changeConnection('connect')} onSignInEnded={readGitHubAgain} onClose={() => setConnectOpen(false)} focusTargets={() => [addButton.current]} />}
    <DisconnectConnectorDialog open={disconnectOpen} provider="GitHub" account={account} mark={<GitHubMark />} busy={busy} error={error} onOpenChange={setDisconnectOpen} onConfirm={() => { void changeConnection('disconnect').catch(() => {}); }} focusTargets={() => [menuButton.current, addButton.current]} />
  </main>;
}
