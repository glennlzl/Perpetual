import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { GitBranch, LoaderCircle, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { canSwitchBranch, nameParts, readsLocalCheckout } from '@/lib/source-selection';
import type { Scan } from './App';
import type { SourceSelection } from './SourceSettings';
import type { GitHubConnection, GitHubBranchPage } from '../../contract/github.ts';

type BranchList = { connection: GitHubConnection | null; branches: string[]; defaultBranch: string | null; nextPage: number | null; loading: boolean; error: string };
type BranchCache = { key: string; branches: string[]; defaultBranch: string | null; nextPage: number | null };

// A colon is not valid in a Git branch name, so these cannot collide with a ref.
const CONFIGURE = ':perpetual:configure';
const RETRY = ':perpetual:retry';
const MORE = ':perpetual:more';
const STATUS = ':perpetual:status';
const LOCAL = ':perpetual:local';
const CURRENT = ':perpetual:current';
const emptyList: BranchList = { connection: null, branches: [], defaultBranch: null, nextPage: null, loading: false, error: '' };
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

// Pinned names keep their order; the rest group by first path segment. A prefix
// with a single branch stays with the top-level names instead of earning a label.
export function branchGroups(names: (string | null | undefined)[], pinnedNames: (string | null | undefined)[] = []) {
  const available = [...new Set(names.filter((name): name is string => Boolean(name)))];
  const pinned = [...new Set(pinnedNames)].filter((name): name is string => Boolean(name) && available.includes(name as string));
  const byPrefix = new Map<string, string[]>();
  for (const name of available) {
    if (pinned.includes(name)) continue;
    const slash = name.indexOf('/');
    const prefix = slash > 0 ? name.slice(0, slash + 1) : '';
    byPrefix.set(prefix, [...(byPrefix.get(prefix) || []), name]);
  }
  const other: string[] = [], groups: { prefix: string; names: string[] }[] = [];
  for (const [prefix, items] of byPrefix) {
    if (!prefix || items.length < 2) other.push(...items);
    else groups.push({ prefix, names: items.sort(compare) });
  }
  return { pinned, other: other.sort(compare), groups: groups.sort((a, b) => compare(a.prefix, b.prefix)) };
}

// Long names give way in the middle, so the distinctive end stays visible.
export function BranchName({ name }: { name: string }) {
  const [head, tail] = nameParts(name);
  if (!tail) return head;
  return <><span className="sr-only">{name}</span><span aria-hidden="true" className="flex min-w-0"><span className="min-w-0 truncate">{head}</span><span className="shrink-0">{tail}</span></span></>;
}

// `lead` and `extra` open and close the pinned group, so pinned options stay at the top of long lists.
type BranchOptionsProps = {
  names: (string | null | undefined)[]; pinned: (string | null | undefined)[]; defaultBranch: string | null;
  localBranch?: string; githubBranch?: string; lead?: ReactNode; extra?: ReactNode; disabled?: (name: string) => boolean; labelClassName?: string;
};
export function BranchOptions({ names, pinned, defaultBranch, localBranch = '', githubBranch = '', lead = null, extra = null, disabled = () => false, labelClassName = 'block min-w-0 max-w-80 truncate' }: BranchOptionsProps) {
  const { pinned: top, other, groups } = branchGroups(names, pinned);
  const item = (name: string, label = name) => <SelectItem key={name} value={name} textValue={name} disabled={disabled(name)} title={name}>
    <span className={labelClassName}>{label}</span>{name === localBranch && <Badge variant="outline">Local</Badge>}{name === githubBranch && <Badge variant="outline">GitHub</Badge>}{name === defaultBranch && <Badge variant="outline">Default</Badge>}
  </SelectItem>;
  const sections = [
    (top.length > 0 || lead || extra) && <SelectGroup key=":pinned">{lead}{top.map(name => item(name))}{extra}</SelectGroup>,
    other.length > 0 && <SelectGroup key=":other">{other.map(name => item(name))}</SelectGroup>,
    ...groups.map(group => <SelectGroup key={group.prefix}><SelectLabel>{group.prefix}</SelectLabel>{group.names.map(name => item(name, name.slice(group.prefix.length)))}</SelectGroup>),
  ].filter((section): section is ReactElement => Boolean(section));
  return sections.map((section, index) => <Fragment key={section.key}>{index > 0 && <SelectSeparator />}{section}</Fragment>);
}

type BranchSwitcherProps = {
  scan: Scan | null; busy?: boolean;
  onSourceSave?: (selection: SourceSelection) => Promise<unknown>; onLocalScan?: (path: string) => Promise<unknown>;
  onConfigureSource?: (options: { connect: boolean }) => void;
};
export default function BranchSwitcher({ scan, busy = false, onSourceSave, onLocalScan, onConfigureSource }: BranchSwitcherProps) {
  const branch = scan?.repo?.branch || '';
  const identity = `${scan?.repo?.path || ''}\n${scan?.repo?.remote || ''}\n${branch}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const active = useRef(true);
  const request = useRef(0);
  const pending = useRef(false);
  const switchingRef = useRef(false);
  const cache = useRef<BranchCache | null>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList>(emptyList);
  const [switching, setSwitching] = useState(false);
  // While the canvas reads a local checkout, the current option is that checkout and
  // its branch in the GitHub list is a separate choice: the GitHub copy.
  const readsLocal = Boolean(list.connection && branch) && readsLocalCheckout(list.connection!.source, scan?.repo?.path);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current++; };
  }, []);

  useEffect(() => {
    request.current++;
    pending.current = false;
    cache.current = null;
    setList(emptyList);
    setOpen(false);
  }, [identity]);

  async function load({ append = false, force = false, reopen = false }: { append?: boolean; force?: boolean; reopen?: boolean } = {}) {
    if (pending.current || busy || switchingRef.current) return;
    const id = ++request.current;
    const startedFor = identity;
    const valid = () => active.current && request.current === id && latestIdentity.current === startedFor;
    pending.current = true;
    setList(previous => ({ ...previous, loading: true, error: '' }));
    try {
      const connection = await api<GitHubConnection>('/api/github/connection');
      if (!valid()) return;
      // The local checkout option does not depend on GitHub, so show it before branches load.
      setList(previous => ({ ...previous, connection }));
      const source = connection.source;
      if (!connection.connected || !source?.repository) {
        cache.current = null;
        setList({ ...emptyList, connection });
        return;
      }
      const key = `${connection.account?.login || ''}\n${source.repository}\n${source.rootDirectory || '/'}\n${branch}`;
      const previous = cache.current?.key === key ? cache.current : null;
      if (previous && !append && !force) {
        setList({ ...emptyList, connection, branches: previous.branches, defaultBranch: previous.defaultBranch, nextPage: previous.nextPage });
        return;
      }
      const page = append && previous?.nextPage ? previous.nextPage : 1;
      const query = new URLSearchParams({ repository: source.repository, page: String(page) });
      if (page === 1 && branch) query.set('preferredBranch', branch);
      const result = await api<GitHubBranchPage>(`/api/github/branches?${query}`);
      if (!valid()) return;
      const branches = [...new Set([
        ...(page === 1 ? [] : previous?.branches || []),
        ...(result.branches || []).map(item => item.name).filter((name): name is string => typeof name === 'string' && Boolean(name) && !name.includes(':')),
      ])];
      const nextPage = result.nextPage || null;
      const defaultBranch = page === 1 ? result.defaultBranch || null : previous?.defaultBranch || null;
      cache.current = { key, branches, defaultBranch, nextPage };
      setList({ connection, branches, defaultBranch, nextPage, loading: false, error: '' });
    } catch (failure) {
      if (valid()) setList(previous => ({ ...previous, loading: false, error: failure instanceof Error ? failure.message : 'Could not load branches.' }));
    } finally {
      if (valid()) {
        pending.current = false;
        setList(previous => ({ ...previous, loading: false }));
        if (reopen) setOpen(true);
      }
    }
  }

  function configure() {
    setOpen(false);
    onConfigureSource?.({ connect: list.connection ? !list.connection.connected : false });
  }

  async function change(apply: () => Promise<unknown>, fallback: string) {
    const startedFor = identity;
    switchingRef.current = true;
    setSwitching(true);
    setOpen(false);
    setList(previous => ({ ...previous, error: '' }));
    try {
      await apply();
    } catch (failure) {
      if (active.current && latestIdentity.current === startedFor) {
        setList(previous => ({ ...previous, error: failure instanceof Error ? failure.message : fallback }));
      }
    } finally {
      switchingRef.current = false;
      if (active.current) setSwitching(false);
    }
  }

  async function select(value: string) {
    if (busy || switchingRef.current || value === CURRENT) return;
    // Rescanning the original checkout is read-only and never waits on GitHub.
    if (value === LOCAL) {
      const path = list.connection?.localCheckout?.path;
      if (path && typeof onLocalScan === 'function') await change(() => onLocalScan(path), 'Could not open the local checkout.');
      return;
    }
    if (pending.current) return;
    if (value === CONFIGURE) { configure(); return; }
    if (value === RETRY) { void load({ force: true, reopen: true }); return; }
    if (value === MORE) { void load({ append: true, reopen: true }); return; }
    if (!list.connection?.connected || !canSwitchBranch({ value, branch, local: readsLocal, branches: list.branches })) return;
    const source = list.connection.source;
    if (!source?.repository || typeof onSourceSave !== 'function') return;
    await change(() => onSourceSave({ repository: source.repository, branch: value, rootDirectory: source.rootDirectory || '/' }), 'Could not switch branch.');
  }

  const canChoose = Boolean(list.connection?.connected && list.connection.source?.repository);
  const branches = readsLocal ? list.branches : list.branches.filter(name => name !== branch);
  const current = branch ? <SelectItem key={CURRENT} value={CURRENT} textValue={branch} title={readsLocal ? scan!.repo.path : branch}>
    <span className="block min-w-0 max-w-80 truncate">{branch}</span>{readsLocal ? <Badge variant="outline">Local</Badge> : branch === list.defaultBranch && <Badge variant="outline">Default</Badge>}
  </SelectItem> : null;
  // The original --repo checkout stays reachable after switching to a GitHub branch,
  // and is offered again when its branch changed since the canvas scanned it.
  const local = list.connection?.localCheckout?.path ? list.connection.localCheckout : null;
  const scannedLocal = Boolean(local && local.path === scan?.repo?.path);
  const localOption = local && (!scannedLocal || local.branch && local.branch !== branch) && typeof onLocalScan === 'function' ? <SelectItem key={LOCAL} value={LOCAL} textValue={local.branch || 'Local checkout'} title={local.path}>
    <span className="block min-w-0 max-w-80 truncate">{local.branch || 'Local checkout'}</span>{local.branch && <Badge variant="outline">Local</Badge>}
  </SelectItem> : null;
  const status = list.loading ? <SelectItem value={STATUS} disabled>Loading branches…</SelectItem> : list.error ? <>
    <SelectItem value={STATUS} disabled title={list.error}>Could not load branches</SelectItem>
    <SelectItem value={RETRY}>Try again</SelectItem>
  </> : !canChoose ? <SelectItem value={CONFIGURE}>{list.connection?.connected ? 'Select repository…' : 'Connect GitHub…'}</SelectItem>
    : !list.branches.length ? <SelectItem value={STATUS} disabled>No branches found</SelectItem>
    : list.nextPage ? <SelectItem value={MORE}>Load more…</SelectItem> : null;

  return <>
    <Select value={branch ? CURRENT : ''} open={open} disabled={busy || switching} onValueChange={select} onOpenChange={next => {
      setOpen(next);
      if (next) void load();
    }}>
      <SelectTrigger
        aria-label={branch ? `Switch branch: ${branch}` : 'Switch branch'}
        aria-busy={switching || list.loading}
        title={switching ? 'Switching branch…' : branch || 'Select branch'}
        className="w-80 max-w-full gap-3 border-input bg-card text-base font-medium shadow-sm data-[size=default]:h-11 dark:bg-card dark:hover:bg-accent"
      >
        {switching || list.loading ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <GitBranch className="size-4" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder="Select branch">{branch ? <BranchName name={branch} /> : undefined}</SelectValue></span>
        {switching && <span className="sr-only">Switching branch…</span>}
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-[min(60vh,var(--radix-select-content-available-height))] max-w-[calc(100vw-2rem)]">
        <BranchOptions names={branches} pinned={[branch, list.defaultBranch]} defaultBranch={list.defaultBranch} githubBranch={readsLocal ? branch : ''} lead={current} extra={localOption} disabled={() => !canChoose || list.loading || Boolean(list.error)} />
        {status && <>{(branches.length > 0 || current || localOption) && <SelectSeparator />}{status}</>}
      </SelectContent>
    </Select>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="size-11 shrink-0 bg-card dark:bg-card" aria-label="Configure source" disabled={busy || switching} onClick={configure}><Settings2 className="size-4" /></Button>
      </TooltipTrigger>
      <TooltipContent>Configure source</TooltipContent>
    </Tooltip>
  </>;
}
