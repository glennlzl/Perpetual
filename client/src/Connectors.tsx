import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, MoreHorizontal, Plus, Plug, RefreshCw, Search, Unplug } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { githubConnectionChanges } from '@/lib/github-connection-changes';
import { buildChanges } from '@/lib/pipeline-github';
import { deploymentChanges } from '@/lib/pipeline-deployments';
import { releaseChanges } from '@/lib/production-release';
import { restoreFocus } from '@/lib/journey-focus';
import GitHubConnectDialog from './GitHubConnectDialog';
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
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const active = useRef(true), request = useRef(0), changing = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null), menuButton = useRef<HTMLButtonElement>(null);

  const readConnection = useCallback(async () => {
    if (changing.current) return;
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await api<GitHubConnection>('/api/github/connection');
      if (active.current && request.current === id) setConnection(next);
    } catch (failure) {
      if (active.current && request.current === id) setError(messageOf(failure));
    } finally {
      if (active.current && request.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current++; };
  }, []);
  // The workspace observes changes in other tabs. Refresh the verified account when its record changes.
  useEffect(() => { void readConnection(); }, [connectionRevision, readConnection]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void readConnection(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = githubConnectionChanges.subscribe(() => void readConnection());
    return () => { window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); unsubscribe(); };
  }, [readConnection]);

  async function changeConnection(nextAction: 'connect' | 'disconnect') {
    if (changing.current || loading) throw new Error('Wait for GitHub to finish checking.');
    changing.current = true;
    request.current++;
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
      if (active.current) setAction(null);
      readGitHubAgain();
    }
  }

  const unavailable = Boolean(connection?.unreachable || error);
  const connected = Boolean(connection?.connected);
  const listed = connected || Boolean(connection?.unreachable);
  const account = connection?.account?.login;
  const busy = loading || Boolean(action);
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
        <div className="flex items-center gap-2"><Button variant="ghost" size="sm" disabled={accounts.busy} onClick={accounts.resetSetup}>{accounts.reply?.configured ? 'Manage Composio' : 'Set up Composio'}</Button><Button ref={addButton} size="sm" disabled={busy || accounts.busy} onClick={openPicker}><Plus />Connect app</Button></div>
      </div>
      <h2 className="mb-4 text-sm font-medium">Connected apps</h2>
      <SearchConnectors label="Search connected apps" value={query} onChange={setQuery} />
      <div className="mt-4">
        {loading && !connection ? <div className="space-y-3" role="status" aria-label="Loading connectors"><Skeleton className="h-20 w-full" /></div>
          : githubMatches || matchingAccounts.length ? <ItemGroup aria-label="Connected apps">
            {githubMatches && <><Item role="listitem" className="flex-nowrap gap-3 p-4">
              <ItemMedia><GitHubMark /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>GitHub<Badge variant="outline">{unavailable ? 'Unverified' : 'Connected'}</Badge></ItemTitle>
                {account && <span className="truncate text-sm text-muted-foreground">{account}</span>}
              </ItemContent>
              <ItemActions>
                <Button size="sm" variant="outline" aria-label="Refresh GitHub" disabled={busy} onClick={() => void readConnection()}>{loading ? <LoaderCircle className="motion-safe:animate-spin" /> : <RefreshCw />}Refresh</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button ref={menuButton} size="icon" variant="outline" className="size-8" disabled={busy} aria-label="GitHub actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => setDisconnectOpen(true)}><Unplug />Disconnect</DropdownMenuItem></DropdownMenuContent>
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
      {connectionError && <div className="mt-4 flex items-start justify-between gap-4"><p className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">{connectionError}</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void readConnection()}>Try again</Button></div>}
      {accounts.error && <div className="mt-4 flex items-start justify-between gap-4"><p className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">{accounts.error}</p><Button variant="outline" size="sm" disabled={accounts.busy || accounts.reading} onClick={() => void accounts.refresh()}>Try again</Button></div>}
    </div>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <DialogContent className="sm:max-w-xl" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (!connectOpen && !accounts.setupOpen && !accounts.authApp) restoreFocus([addButton.current]); }}>
        <DialogHeader><DialogTitle>Available apps</DialogTitle></DialogHeader>
        <SearchConnectors label="Search available apps" value={pickerQuery} onChange={setPickerQuery} />
        {!connected && !unavailable && matches(pickerQuery) ? <Item className="flex-nowrap gap-3 px-2 py-3">
          <ItemMedia><GitHubMark /></ItemMedia><ItemContent><ItemTitle>GitHub</ItemTitle></ItemContent>
          <ItemActions><Button variant="outline" size="sm" disabled={busy} onClick={() => { setPickerOpen(false); setConnectOpen(true); }}>Connect GitHub</Button></ItemActions>
        </Item> : null}
        {accounts.reply?.apps.filter(app => !app.account && matchesApp(pickerQuery, app)).map(app => <Item key={app.provider} className="flex-nowrap gap-3 px-2 py-3"><ItemMedia><AppMark app={app} /></ItemMedia><ItemContent><ItemTitle>{app.name}</ItemTitle></ItemContent><ItemActions><Button variant="outline" size="sm" disabled={accounts.busy} onClick={() => { setPickerOpen(false); void accounts.choose(app); }}>Connect {app.name}</Button></ItemActions></Item>)}
        {!accounts.reply && <p className="py-4 text-sm text-muted-foreground">{accounts.error ? 'Could not read available apps.' : 'Loading apps…'}</p>}
        {accounts.reply && !accounts.reply.apps.some(app => !app.account && matchesApp(pickerQuery, app)) && (connected || unavailable || !matches(pickerQuery)) && <p className="py-8 text-center text-sm text-muted-foreground">No matching apps</p>}
      </DialogContent>
    </Dialog>
    <AccountConnectorDialogs state={accounts} focusTarget={() => addButton.current} />
    {connectOpen && <GitHubConnectDialog connection={connection} checking={loading} onConnect={() => changeConnection('connect')} onSignInEnded={readGitHubAgain} onClose={() => setConnectOpen(false)} focusTargets={() => [addButton.current]} />}
    <AlertDialog open={disconnectOpen} onOpenChange={open => { if (!action) setDisconnectOpen(open); }}>
      <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); restoreFocus([menuButton.current, addButton.current]); }}>
        <AlertDialogHeader><AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle><AlertDialogDescription>Your projects and tests stay saved. GitHub access pauses until you reconnect.</AlertDialogDescription></AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={Boolean(action)}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void changeConnection('disconnect').catch(() => {}); }}>{action === 'disconnect' && <LoaderCircle className="motion-safe:animate-spin" />}Disconnect</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>;
}
