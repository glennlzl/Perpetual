import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { GitBranch, LoaderCircle, LockKeyhole } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { initialBranch, readsLocalCheckout, rootDirectoryError, sourceChange } from '@/lib/source-selection';
import { BranchName, BranchOptions } from './BranchSwitcher';
import GitHubConnectDialog from './GitHubConnectDialog';
import type { Scan } from './App';

/** The saved GitHub source, or the one detected from a local checkout's remote. */
export type GitHubSource = { repository: string; branch?: string | null; rootDirectory?: string | null; scanPath?: string };
/** GET /api/github/connection and the connect/disconnect replies; the session never carries a token. */
export type GitHubConnection = {
  authenticated?: boolean; connected?: boolean; message?: string;
  account?: { login: string } | null;
  source?: GitHubSource | null;
  localCheckout?: { path: string; branch: string | null } | null;
};
export type GitHubRepository = { fullName: string; name?: string; private?: boolean };
type GitHubBranch = { name: string };
type Page<Key extends string, Item> = { [key in Key]?: Item[] } & { nextPage?: number | null };
type BranchPage = Page<'branches', GitHubBranch> & { defaultBranch?: string | null };
/** A GitHub source choice as POST /api/source/github takes it. */
export type SourceSelection = { repository: string; branch: string; rootDirectory: string };
export type SourceState = { canSave: boolean; loading: boolean; connection: GitHubConnection | null; repository?: string; branch?: string; rootDirectory?: string };
export type SourceSettingsHandle = { save(): Promise<unknown> };
type SourceSettingsProps = {
  scan: Scan | null; busy?: boolean; autoConnect?: boolean;
  onSourceSave?: (selection: SourceSelection) => Promise<unknown>;
  onBusyChange?: (busy: boolean) => void;
  onStateChange?: (state: SourceState) => void;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not load GitHub settings.';
const mergeBy = <Item, Key extends keyof Item>(old: Item[], incoming: Item[], key: Key) => [...new Map([...old, ...incoming].map(item => [item[key], item])).values()];
const ownerOf = (fullName: string) => fullName.split('/')[0];

// Pinned repositories keep their order. Owners are grouped only when there are
// several; the connected account leads and the rest keep GitHub's recency order.
export function repositoryGroups(repositories: GitHubRepository[], pinnedNames: (string | undefined)[] = [], account = '') {
  const known = new Map(repositories.map(item => [item.fullName, item]));
  const pinnedSet = new Set(pinnedNames.filter((name): name is string => Boolean(name)));
  const pinned = [...pinnedSet].map(fullName => known.get(fullName) || { fullName, name: fullName.split('/')[1] || fullName });
  const owners = new Map<string, GitHubRepository[]>();
  for (const item of repositories) {
    if (pinnedSet.has(item.fullName)) continue;
    const owner = ownerOf(item.fullName);
    owners.set(owner, [...(owners.get(owner) || []), item]);
  }
  const own = (owner: string) => owner.toLowerCase() === account.toLowerCase() ? 0 : 1;
  return { pinned, owners: [...owners].map(([owner, items]) => ({ owner, repositories: items })).sort((a, b) => own(a.owner) - own(b.owner)) };
}

const missingBranch = 'Branch not on GitHub. Push it to use it as a source.';
const selectListClass = 'max-h-[min(60vh,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]';

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="space-y-4">
    {title && <h3 className="text-sm font-medium">{title}</h3>}
    {children}
  </section>;
}

const SourceSettings = forwardRef<SourceSettingsHandle, SourceSettingsProps>(function SourceSettings({ scan, busy = false, autoConnect = false, onSourceSave, onBusyChange, onStateChange }, ref) {
  const active = useRef(true);
  const connectionRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const branchRequest = useRef(0);
  const savedSource = useRef<GitHubSource | null>(null);
  const focusOrigin = useRef<Element | null>(null);
  const connectionButton = useRef<HTMLButtonElement>(null);
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionAction, setConnectionAction] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [connectOpen, setConnectOpen] = useState(autoConnect);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repository, setRepository] = useState('');
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState('');
  const [repositoryPage, setRepositoryPage] = useState<number | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');
  const [branchPage, setBranchPage] = useState<number | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [rootDirectory, setRootDirectory] = useState('/');
  const scanRepo = scan?.repo?.name ? scan.repo : null;
  const rootError = rootDirectoryError(rootDirectory);
  const connected = Boolean(connection?.connected);
  const loading = connectionLoading || Boolean(connectionAction) || repositoriesLoading || branchesLoading;
  const source = connection?.source || null;
  const local = Boolean(connection && scanRepo) && readsLocalCheckout(source, scanRepo!.path);
  // From a local checkout, its own branch on GitHub is a change: saving moves the canvas to the GitHub copy.
  const { changed, onGitHub } = sourceChange({ current: source, local, repository, branch, rootDirectory, branches: branches.map(item => item.name) });
  const branchMissing = connected && Boolean(repository && branch) && !branchesLoading && !branchesError && !onGitHub;
  const canSave = connected && Boolean(repository && branch) && !loading && !branchesError && !rootError && changed && onGitHub;

  function applyConnection(result: GitHubConnection, restoreSelection = false) {
    setConnection(result);
    savedSource.current = result.source || null;
    if (restoreSelection && result.source) {
      setRepository(result.source.repository || '');
      setBranch(result.source.branch || '');
      setRootDirectory(result.source.rootDirectory || '/');
    }
  }

  async function readConnection() {
    const request = ++connectionRequest.current;
    setConnectionLoading(true);
    setConnectionError('');
    try {
      const result = await api<GitHubConnection>('/api/github/connection');
      if (active.current && request === connectionRequest.current) applyConnection(result, true);
    } catch (failure) {
      if (active.current && request === connectionRequest.current) setConnectionError(messageOf(failure));
    } finally {
      if (active.current && request === connectionRequest.current) setConnectionLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void readConnection();
    return () => {
      active.current = false;
      connectionRequest.current++;
      repositoryRequest.current++;
      branchRequest.current++;
    };
  }, []);

  async function changeConnection(action: 'connect' | 'disconnect', throwOnError = false) {
    if (busy || connectionLoading || connectionAction) {
      if (throwOnError) throw new Error('Wait for the current connection change to finish.');
      return;
    }
    const request = ++connectionRequest.current;
    setConnectionAction(action);
    setConnectionError('');
    onBusyChange?.(true);
    try {
      const result = await api<GitHubConnection>(`/api/github/${action}`, {});
      if (active.current && request === connectionRequest.current) applyConnection(result, action === 'connect');
      return result;
    } catch (failure) {
      if (active.current && request === connectionRequest.current) setConnectionError(messageOf(failure));
      if (throwOnError) throw failure;
    } finally {
      if (active.current && request === connectionRequest.current) setConnectionAction('');
      onBusyChange?.(false);
    }
  }

  async function loadRepositories(page: number = 1, append = false) {
    const request = ++repositoryRequest.current;
    setRepositoriesLoading(true);
    setRepositoriesError('');
    try {
      const result = await api<Page<'repositories', GitHubRepository>>(`/api/github/repositories?page=${encodeURIComponent(page)}`);
      if (!active.current || request !== repositoryRequest.current) return;
      setRepositories(previous => mergeBy(append ? previous : [], result.repositories || [], 'fullName'));
      setRepositoryPage(result.nextPage || null);
    } catch (failure) {
      if (active.current && request === repositoryRequest.current) setRepositoriesError(messageOf(failure));
    } finally {
      if (active.current && request === repositoryRequest.current) setRepositoriesLoading(false);
    }
  }

  useEffect(() => {
    repositoryRequest.current++;
    if (connected) void loadRepositories();
    else {
      setRepositories([]);
      setRepositoryPage(null);
      setRepositoriesError('');
      setRepositoriesLoading(false);
    }
  }, [connected, connection?.account?.login]);

  async function loadBranches(target: string, page: number = 1, append = false) {
    const request = ++branchRequest.current;
    const preferred = savedSource.current?.repository === target ? savedSource.current.branch || '' : '';
    setBranchesLoading(true);
    setBranchesError('');
    try {
      const result = await api<BranchPage>(`/api/github/branches?repository=${encodeURIComponent(target)}&page=${encodeURIComponent(page)}${Number(page) === 1 && preferred ? `&preferredBranch=${encodeURIComponent(preferred)}` : ''}`);
      if (!active.current || request !== branchRequest.current) return;
      setBranches(previous => mergeBy(append ? previous : [], result.branches || [], 'name'));
      setBranchPage(result.nextPage || null);
      if (!append) setDefaultBranch(result.defaultBranch || null);
      if (!append) setBranch(previous => initialBranch({ previous, preferred, defaultBranch: result.defaultBranch, names: (result.branches || []).map(item => item.name) }));
    } catch (failure) {
      if (active.current && request === branchRequest.current) setBranchesError(messageOf(failure));
    } finally {
      if (active.current && request === branchRequest.current) setBranchesLoading(false);
    }
  }

  useEffect(() => {
    branchRequest.current++;
    setBranches([]);
    setBranchPage(null);
    setDefaultBranch(null);
    setBranchesError('');
    if (connected && repository) void loadBranches(repository);
    else setBranchesLoading(false);
  }, [connected, repository, connection?.account?.login]);

  useEffect(() => {
    onStateChange?.({ canSave, loading, connection, repository, branch, rootDirectory });
  }, [canSave, loading, connection, repository, branch, rootDirectory, onStateChange]);

  useImperativeHandle(ref, () => ({
    async save() {
      if (!connected) throw new Error('Connect GitHub before choosing a source.');
      if (!repository) throw new Error('Choose a GitHub repository.');
      if (!branch) throw new Error('Choose a branch.');
      if (loading || branchesError) throw new Error('Wait for the branch list to load before saving.');
      if (!onGitHub) throw new Error(missingBranch);
      if (rootError) throw new Error(rootError);
      if (!changed) throw new Error('No source changes to save.');
      if (typeof onSourceSave !== 'function') throw new Error('GitHub source saving is unavailable. Reload the page.');
      return onSourceSave({ repository, branch, rootDirectory: rootDirectory.trim() || '/' });
    },
  }), [connected, repository, branch, rootDirectory, rootError, loading, branchesError, onGitHub, changed, onSourceSave]);

  const disableFields = busy || !connected || connectionLoading || Boolean(connectionAction);
  const showLocal = local && (!repository || repository === source?.repository);
  // Without a GitHub source, show what the canvas scanned; it is not a selectable GitHub value.
  const scanned = !source && !repository && scanRepo ? { repository: scanRepo.name, branch: scanRepo.branch || '' } : null;
  // The saved or scanned branch stays listed even when GitHub lacks it, so it can be chosen again.
  const savedBranch = source?.repository === repository ? source.branch || '' : '';
  const savedLocalOnly = local && Boolean(savedBranch) && !branchesLoading && !branchesError && !branches.some(item => item.name === savedBranch);
  const { pinned: pinnedRepositories, owners } = repositoryGroups(repositories, [source?.repository, repository], connection?.account?.login || '');
  const repositoryItem = (item: GitHubRepository, label: string) => <SelectItem key={item.fullName} value={item.fullName} textValue={item.fullName} title={item.fullName}><span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{label}</span>{item.private && <LockKeyhole aria-label="Private repository" className="size-3.5" />}</SelectItem>;

  return <>
    {connectOpen && <GitHubConnectDialog connection={connection} checking={connectionLoading} onConnect={() => changeConnection('connect', true)} onClose={() => setConnectOpen(false)} focusTarget={() => connected && repositoryTrigger.current && !repositoryTrigger.current.disabled ? repositoryTrigger.current : connectionButton.current} />}
    <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
      <AlertDialogContent
        onOpenAutoFocus={() => { focusOrigin.current = document.activeElement; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (focusOrigin.current instanceof HTMLElement && focusOrigin.current.isConnected) focusOrigin.current.focus({ preventScroll: true });
        }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
          <AlertDialogDescription className={connection?.account?.login ? undefined : 'sr-only'}>{connection?.account?.login || 'Disconnect this GitHub account.'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void changeConnection('disconnect')}>Disconnect</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Section title="Source">
      <Card className="py-4">
        <CardContent className="flex flex-wrap items-center gap-3 px-4">
          <img src="/assets/providers/github.svg" className="provider-logo shrink-0" data-monochrome="true" width={24} height={24} alt="GitHub" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">GitHub</p>
            <p className="truncate text-sm text-muted-foreground">{connectionLoading ? 'Checking…' : connected ? connection!.account?.login ? `${connection!.account.login} · Connected` : 'Connected' : 'Not connected'}</p>
          </div>
          <Button ref={connectionButton} type="button" variant="outline" disabled={busy || connectionLoading || Boolean(connectionAction)} onClick={() => connected ? setConfirmDisconnect(true) : setConnectOpen(true)}>
            {connectionAction && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
            {connectionAction ? connectionAction === 'connect' ? 'Connecting…' : 'Disconnecting…' : connected ? 'Disconnect' : 'Connect'}
          </Button>
        </CardContent>
      </Card>
      {connectionError && <div className="space-y-2 text-sm text-destructive" role="alert"><p className="break-all">{connectionError}</p>{!connection && <Button type="button" variant="outline" size="sm" disabled={busy || connectionLoading} onClick={readConnection}>Try again</Button>}</div>}
    </Section>

    <Section>
      <div className="grid gap-2">
        <div className="flex items-center gap-2"><Label htmlFor="source-repository">Repository</Label>{showLocal && <Badge variant="outline" title="Local checkout">Local</Badge>}</div>
        {/* Inside a form, Radix reports '' when a value arrives before its option registers; keep the value. */}
        <Select value={repository} disabled={disableFields || repositoriesLoading && !repositories.length} onValueChange={value => {
          if (!value) return;
          branchRequest.current++;
          setRepository(value);
          setBranch('');
          setBranches([]);
          setBranchPage(null);
          setBranchesError('');
          setBranchesLoading(true);
        }}>
          <SelectTrigger ref={repositoryTrigger} id="source-repository" className={`min-w-0 w-full${scanned ? ' data-[placeholder]:text-foreground' : ''}`} title={repository || scanned?.repository || undefined}><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={scanned?.repository || (repositoriesLoading ? 'Loading repositories…' : 'Select repository')}>{repository || undefined}</SelectValue></span></SelectTrigger>
          <SelectContent position="popper" align="start" collisionPadding={16} className={selectListClass}>
            {pinnedRepositories.length > 0 && <SelectGroup>{pinnedRepositories.map(item => repositoryItem(item, item.fullName))}</SelectGroup>}
            {owners.length > 1 ? owners.map(group => <Fragment key={group.owner}>{(pinnedRepositories.length > 0 || group !== owners[0]) && <SelectSeparator />}<SelectGroup><SelectLabel>{group.owner}</SelectLabel>{group.repositories.map(item => repositoryItem(item, item.name || item.fullName.split('/')[1]))}</SelectGroup></Fragment>)
              : owners.length === 1 && <>{pinnedRepositories.length > 0 && <SelectSeparator />}<SelectGroup>{owners[0].repositories.map(item => repositoryItem(item, item.fullName))}</SelectGroup></>}
          </SelectContent>
        </Select>
      </div>
      {repositoriesError && <div className="space-y-2 text-sm text-destructive" role="alert"><p className="break-all">{repositoriesError}</p><Button type="button" variant="outline" size="sm" disabled={disableFields || repositoriesLoading} onClick={() => loadRepositories()}>Retry repositories</Button></div>}
      {connected && !repositoriesLoading && !repositoriesError && !repositories.length && <p className="text-sm text-muted-foreground">No repositories</p>}
      {repositoryPage && <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={disableFields || repositoriesLoading} onClick={() => loadRepositories(repositoryPage, true)}>{repositoriesLoading ? 'Loading…' : 'Load more repositories'}</Button>}
    </Section>

    <Section>
      <div className="grid gap-2">
        <Label htmlFor="source-branch">Branch</Label>
        <Select value={branch} disabled={disableFields || !repository || branchesLoading && !branches.length} onValueChange={value => { if (value) setBranch(value); }}>
          <SelectTrigger id="source-branch" className={`min-w-0 w-full${scanned?.branch ? ' data-[placeholder]:text-foreground' : ''}`} title={branch || scanned?.branch || undefined} aria-describedby={branchMissing ? 'source-branch-missing' : undefined}><GitBranch className="size-4" /><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={scanned?.branch ? <BranchName name={scanned.branch} /> : branchesLoading ? 'Loading branches…' : 'Select branch'}>{branch ? <BranchName name={branch} /> : undefined}</SelectValue></span></SelectTrigger>
          <SelectContent position="popper" align="start" collisionPadding={16} className={selectListClass}>
            <BranchOptions names={[savedBranch, ...branches.map(item => item.name)]} pinned={[branch, savedBranch, defaultBranch]} defaultBranch={defaultBranch} localBranch={savedLocalOnly ? savedBranch : ''} labelClassName="min-w-0 whitespace-normal [overflow-wrap:anywhere]" />
          </SelectContent>
        </Select>
        {branchMissing && <p id="source-branch-missing" className={`text-sm ${changed ? 'text-destructive' : 'text-muted-foreground'}`} aria-live="polite">{missingBranch}</p>}
      </div>
      {branchesError && <div className="space-y-2 text-sm text-destructive" role="alert"><p className="break-all">{branchesError}</p><Button type="button" variant="outline" size="sm" disabled={disableFields || branchesLoading} onClick={() => loadBranches(repository)}>Retry branches</Button></div>}
      {connected && repository && !branchesLoading && !branchesError && !branches.length && <p className="text-sm text-muted-foreground">No branches</p>}
      {branchPage && <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={disableFields || branchesLoading} onClick={() => loadBranches(repository, branchPage, true)}>{branchesLoading ? 'Loading…' : 'Load more branches'}</Button>}
    </Section>

    <Section>
      <div className="grid gap-2">
        <Label htmlFor="source-root-directory">Root directory</Label>
        <Input id="source-root-directory" className="font-mono" value={rootDirectory} onChange={event => setRootDirectory(event.target.value)} disabled={disableFields} spellCheck={false} autoComplete="off" placeholder="/" aria-invalid={rootError ? true : undefined} aria-describedby={rootError ? 'source-root-directory-error' : undefined} />
        {rootError && <p id="source-root-directory-error" className="text-sm text-destructive" aria-live="polite">{rootError}</p>}
      </div>
    </Section>

  </>;
});

export default SourceSettings;
