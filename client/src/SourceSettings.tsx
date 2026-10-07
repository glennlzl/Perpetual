import { Fragment, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GitBranch, LoaderCircle, LockKeyhole } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { deploymentChanges } from '@/lib/pipeline-deployments';
import { buildChanges } from '@/lib/pipeline-github';
import { releaseChanges } from '@/lib/production-release';
import { restoreFocus, type FocusTarget } from '@/lib/journey-focus';
import { initialBranch, readsLocalCheckout, rootDirectoryError, sourceChange } from '@/lib/source-selection';
import { BranchName, BranchOptions } from './BranchSwitcher';
import GitHubConnectDialog from './GitHubConnectDialog';
import type { Scan } from './App';
import type { GitHubSource, GitHubSourceSelection, GitHubConnection, GitHubRepositoryChoice, GitHubRepositoryPage, GitHubBranch, GitHubBranchPage } from '../../contract/github.ts';
import { githubConnectionChanges } from '@/lib/github-connection-changes';

/** A GitHub source choice as POST /api/source/github takes it. */
export type SourceSelection = GitHubSourceSelection;
export type SourceState = { canSave: boolean; loading: boolean; connection: GitHubConnection | null; repository?: string; branch?: string; rootDirectory?: string };
export type SourceSettingsHandle = { save(): Promise<unknown> };
type SourceSettingsProps = {
  scan: Scan | null; busy?: boolean; autoConnect?: boolean; creating?: boolean;
  onSourceSave?: (selection: SourceSelection) => Promise<unknown>;
  onBusyChange?: (busy: boolean) => void;
  onStateChange?: (state: SourceState) => void;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not load GitHub settings.';
// Build, the recorded deployments and the release read GitHub through the connection, and the controller refuses those
// reads while a sign-in is pending, so they read again at once after a connection change or a sign-in that ended.
const readGitHubAgain = () => { buildChanges.notify(); deploymentChanges.notify(); releaseChanges.notify(); };
const mergeBy = <Item, Key extends keyof Item>(old: Item[], incoming: Item[], key: Key) => [...new Map([...old, ...incoming].map(item => [item[key], item])).values()];
const ownerOf = (fullName: string) => fullName.split('/')[0];

// Pinned repositories keep their order. Owners are grouped only when there are
// several; the connected account leads and the rest keep GitHub's recency order.
export function repositoryGroups(repositories: GitHubRepositoryChoice[], pinnedNames: (string | undefined)[] = [], account = '') {
  const known = new Map(repositories.map(item => [item.fullName, item]));
  const pinnedSet = new Set(pinnedNames.filter((name): name is string => Boolean(name)));
  const pinned = [...pinnedSet].map(fullName => known.get(fullName) || { fullName, name: fullName.split('/')[1] || fullName });
  const owners = new Map<string, GitHubRepositoryChoice[]>();
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

function SourceReadError({ error, label, disabled, onRetry, focusTarget }: {
  error: string; label: string; disabled: boolean;
  onRetry?: () => Promise<void>; focusTarget: () => FocusTarget | null;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const completed = useRef<HTMLButtonElement | null>(null);
  const [retrying, setRetrying] = useState(false);
  useLayoutEffect(() => {
    const origin = completed.current;
    completed.current = null;
    if (origin && (document.activeElement === origin || document.activeElement === document.body)) {
      restoreFocus([button.current, focusTarget()]);
    }
  });
  async function retry() {
    if (disabled || retrying || !onRetry) return;
    setRetrying(true);
    await onRetry(); // The source reader owns the error and catches failed requests.
    if (!button.current) return; // The inspector may have closed while reading.
    completed.current = document.activeElement === button.current ? button.current : null;
    setRetrying(false);
  }
  if (!error && !retrying) return null;
  return <div className="space-y-2 text-sm text-destructive">
    {error && <p className="break-all" role="alert">{error}</p>}
    {(onRetry || retrying) && <Button ref={button} type="button" variant="outline" size="sm" aria-disabled={disabled || retrying} aria-busy={retrying} className="aria-disabled:opacity-50" onClick={() => void retry()}>
      {retrying && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}{label}
    </Button>}
  </div>;
}

const SourceSettings = forwardRef<SourceSettingsHandle, SourceSettingsProps>(function SourceSettings({ scan, busy = false, autoConnect = false, creating = false, onSourceSave, onBusyChange, onStateChange }, ref) {
  const active = useRef(true);
  const connectionRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const branchRequest = useRef(0);
  const savedSource = useRef<GitHubSource | null>(null);
  const focusOrigin = useRef<Element | null>(null);
  const connectionButton = useRef<HTMLButtonElement>(null);
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionAction, setConnectionAction] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [connectOpen, setConnectOpen] = useState(autoConnect);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [repositories, setRepositories] = useState<GitHubRepositoryChoice[]>([]);
  const [repository, setRepository] = useState('');
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState('');
  const [repositoryPage, setRepositoryPage] = useState<number | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');
  // A failed further page leaves the listed branches, and the choice among them, valid; Load more branches tries it again.
  const [moreBranchesError, setMoreBranchesError] = useState('');
  const [branchPage, setBranchPage] = useState<number | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [rootDirectory, setRootDirectory] = useState('/');
  const scanRepo = scan?.repo?.name ? scan.repo : null;
  const rootError = rootDirectoryError(rootDirectory);
  const connected = Boolean(connection?.connected);
  // A connection GitHub could not verify for now is neither connected nor disconnected; reading it again may verify it.
  const unreachable = Boolean(connection?.unreachable);
  const loading = connectionLoading || Boolean(connectionAction) || repositoriesLoading || branchesLoading;
  const source = connection?.source || null;
  const local = !creating && Boolean(connection && scanRepo) && readsLocalCheckout(source, scanRepo!.path);
  // From a local checkout, its own branch on GitHub is a change: saving moves the canvas to the GitHub copy.
  const { changed, onGitHub } = sourceChange({ current: source, local, repository, branch, rootDirectory, branches: branches.map(item => item.name) });
  const branchMissing = connected && Boolean(repository && branch) && !branchesLoading && !branchesError && !onGitHub;
  const canSave = connected && Boolean(repository && branch) && !loading && !branchesError && !rootError && (creating || changed) && onGitHub;

  function applyConnection(result: GitHubConnection, restoreSelection = false) {
    setConnection(result);
    if (result.connected) setConnectOpen(false);
    else if (creating && restoreSelection && !result.unreachable) setConnectOpen(true);
    savedSource.current = result.source || null;
    if (!creating && restoreSelection && result.source) {
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
      if (active.current && request === connectionRequest.current) {
        applyConnection(result, action === 'connect');
        githubConnectionChanges.notify(action);
      }
      return result;
    } catch (failure) {
      if (active.current && request === connectionRequest.current) setConnectionError(messageOf(failure));
      if (throwOnError) throw failure;
    } finally {
      if (active.current && request === connectionRequest.current) setConnectionAction('');
      onBusyChange?.(false);
      readGitHubAgain();
    }
  }

  async function loadRepositories(page: number = 1, append = false) {
    const request = ++repositoryRequest.current;
    setRepositoriesLoading(true);
    setRepositoriesError('');
    try {
      const result = await api<GitHubRepositoryPage>(`/api/github/repositories?page=${encodeURIComponent(page)}`);
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
    const preferred = !creating && savedSource.current?.repository === target ? savedSource.current.branch || '' : '';
    const setError = append ? setMoreBranchesError : setBranchesError;
    setBranchesLoading(true);
    setError('');
    try {
      const result = await api<GitHubBranchPage>(`/api/github/branches?repository=${encodeURIComponent(target)}&page=${encodeURIComponent(page)}${Number(page) === 1 && preferred ? `&preferredBranch=${encodeURIComponent(preferred)}` : ''}`);
      if (!active.current || request !== branchRequest.current) return;
      setBranches(previous => mergeBy(append ? previous : [], result.branches || [], 'name'));
      setBranchPage(result.nextPage || null);
      if (!append) setDefaultBranch(result.defaultBranch || null);
      if (!append) setBranch(previous => initialBranch({ previous, preferred, defaultBranch: result.defaultBranch, names: (result.branches || []).map(item => item.name) }));
    } catch (failure) {
      if (active.current && request === branchRequest.current) setError(messageOf(failure));
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
    setMoreBranchesError('');
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
      if (!creating && !changed) throw new Error('No source changes to save.');
      if (typeof onSourceSave !== 'function') throw new Error('GitHub source saving is unavailable. Reload the page.');
      return onSourceSave({ repository, branch, rootDirectory: rootDirectory.trim() || '/', ...(creating ? { createPipeline: true } : {}) });
    },
  }), [connected, repository, branch, rootDirectory, rootError, loading, branchesError, onGitHub, changed, onSourceSave, creating]);

  const disableFields = busy || !connected || connectionLoading || Boolean(connectionAction);
  const showLocal = local && (!repository || repository === source?.repository);
  // Without a GitHub source, show what the canvas scanned; it is not a selectable GitHub value.
  const scanned = !creating && !source && !repository && scanRepo ? { repository: scanRepo.name, branch: scanRepo.branch || '' } : null;
  // The saved or scanned branch stays listed even when GitHub lacks it, so it can be chosen again.
  const savedBranch = !creating && source?.repository === repository ? source.branch || '' : '';
  const savedLocalOnly = local && Boolean(savedBranch) && !branchesLoading && !branchesError && !branches.some(item => item.name === savedBranch);
  const { pinned: pinnedRepositories, owners } = repositoryGroups(repositories, [source?.repository, repository], connection?.account?.login || '');
  const repositoryItem = (item: Pick<GitHubRepositoryChoice, 'fullName'> & Partial<Pick<GitHubRepositoryChoice, 'private'>>, label: string) => <SelectItem key={item.fullName} value={item.fullName} textValue={item.fullName} title={item.fullName}><span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{label}</span>{item.private && <LockKeyhole aria-label="Private repository" className="size-3.5" />}</SelectItem>;

  return <>
    {connectOpen && <GitHubConnectDialog connection={connection} checking={connectionLoading} onConnect={() => changeConnection('connect', true)} onSignInEnded={readGitHubAgain} onClose={() => setConnectOpen(false)} focusTargets={() => [
      connected ? repositoryTrigger.current : null,
      connectionButton.current,
      connectionButton.current?.closest<HTMLElement>('[data-slot="sheet-content"]'),
    ]} />}
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
            <p className="truncate text-sm text-muted-foreground">{connectionLoading ? 'Checking…' : connected ? connection!.account?.login ? `${connection!.account.login} · Connected` : 'Connected' : unreachable ? 'Unreachable' : 'Not connected'}</p>
          </div>
          <Button ref={connectionButton} type="button" variant="outline" disabled={busy || connectionLoading || Boolean(connectionAction)} onClick={() => connected || unreachable ? setConfirmDisconnect(true) : setConnectOpen(true)}>
            {connectionAction && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}
            {connectionAction ? connectionAction === 'connect' ? 'Connecting…' : 'Disconnecting…' : connected || unreachable ? 'Disconnect' : 'Connect'}
          </Button>
        </CardContent>
      </Card>
      <SourceReadError error={connectionError || (unreachable ? connection!.message || 'GitHub is unreachable.' : '')} label="Try again" disabled={busy || connectionLoading} onRetry={!connection || unreachable ? readConnection : undefined} focusTarget={() => connectionButton.current} />
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
          setMoreBranchesError('');
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
      <SourceReadError error={repositoriesError} label="Retry repositories" disabled={disableFields || repositoriesLoading} onRetry={() => loadRepositories()} focusTarget={() => repositoryTrigger.current} />
      {connected && !repositoriesLoading && !repositoriesError && !repositories.length && <p className="text-sm text-muted-foreground">No repositories</p>}
      {repositoryPage && <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={disableFields || repositoriesLoading} onClick={() => loadRepositories(repositoryPage, true)}>{repositoriesLoading ? 'Loading…' : 'Load more repositories'}</Button>}
    </Section>

    <Section>
      <div className="grid gap-2">
        <Label htmlFor="source-branch">Branch</Label>
        <Select value={branch} disabled={disableFields || !repository || branchesLoading && !branches.length} onValueChange={value => { if (value) setBranch(value); }}>
          <SelectTrigger ref={branchTrigger} id="source-branch" className={`min-w-0 w-full${scanned?.branch ? ' data-[placeholder]:text-foreground' : ''}`} title={branch || scanned?.branch || undefined} aria-describedby={branchMissing ? 'source-branch-missing' : undefined}><GitBranch className="size-4" /><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={scanned?.branch ? <BranchName name={scanned.branch} /> : branchesLoading ? 'Loading branches…' : 'Select branch'}>{branch ? <BranchName name={branch} /> : undefined}</SelectValue></span></SelectTrigger>
          <SelectContent position="popper" align="start" collisionPadding={16} className={selectListClass}>
            <BranchOptions names={[savedBranch, ...branches.map(item => item.name)]} pinned={[branch, savedBranch, defaultBranch]} defaultBranch={defaultBranch} localBranch={savedLocalOnly ? savedBranch : ''} labelClassName="min-w-0 whitespace-normal [overflow-wrap:anywhere]" />
          </SelectContent>
        </Select>
        {branchMissing && <p id="source-branch-missing" className={`text-sm ${changed ? 'text-destructive' : 'text-muted-foreground'}`} aria-live="polite">{missingBranch}</p>}
      </div>
      <SourceReadError error={branchesError} label="Retry branches" disabled={disableFields || branchesLoading} onRetry={() => loadBranches(repository)} focusTarget={() => branchTrigger.current} />
      {connected && repository && !branchesLoading && !branchesError && !branches.length && <p className="text-sm text-muted-foreground">No branches</p>}
      {branchPage && <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={disableFields || branchesLoading} onClick={() => loadBranches(repository, branchPage, true)}>{branchesLoading ? 'Loading…' : 'Load more branches'}</Button>}
      <SourceReadError error={moreBranchesError} label="Load more branches" disabled focusTarget={() => branchTrigger.current} />
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
