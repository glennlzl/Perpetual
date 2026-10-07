import { useEffect, useId, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BranchName, BranchOptions } from './BranchSwitcher';
import { api } from '@/lib/api';
import type { GitHubBranchPage } from '../../contract/github.ts';

const MORE = ':more', RETRY = ':retry', STATUS = ':status';
type Branches = { names: string[]; defaultBranch: string | null; nextPage: number | null };
const empty: Branches = { names: [], defaultBranch: null, nextPage: null };

export default function ProductionBranchSelect({ repository, value, disabled, onChange }: {
  repository: string; value?: string | null; disabled: boolean; onChange(branch: string): Promise<unknown>;
}) {
  const [branches, setBranches] = useState(empty), [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const request = useRef(0), pending = useRef(false), active = useRef(true), errorId = useId();
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; }; }, []);

  async function load(append = false, reopen = false) {
    if (pending.current || disabled) return;
    const id = ++request.current;
    const current = () => active.current && request.current === id;
    pending.current = true; setLoading(true); setError('');
    try {
      const page = append ? branches.nextPage : 1;
      if (!page) return;
      const query = new URLSearchParams({ repository, page: String(page) });
      if (page === 1 && value) query.set('preferredBranch', value);
      const result = await api<GitHubBranchPage>(`/api/github/branches?${query}`);
      if (current()) setBranches(previous => ({
        names: [...new Set([...(append ? previous.names : []), ...result.branches.map(branch => branch.name)])],
        defaultBranch: append ? previous.defaultBranch : result.defaultBranch,
        nextPage: result.nextPage,
      }));
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : 'Could not load branches.');
    } finally {
      if (current()) { pending.current = false; setLoading(false); if (reopen) setOpen(true); }
    }
  }

  async function select(branch: string) {
    if (disabled || pending.current || saving) return;
    if (branch === MORE || branch === RETRY) { void load(branch === MORE, true); return; }
    if (branch === value || !branches.names.includes(branch)) return;
    setSaving(true); setError('');
    try { await onChange(branch); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : 'Could not save the Production branch.'); }
    finally { if (active.current) setSaving(false); }
  }

  return <div className="w-28 max-w-full sm:w-56">
    <Select value={value || ''} open={open} disabled={disabled || saving} onOpenChange={next => { setOpen(next); if (next) void load(); }} onValueChange={branch => void select(branch)}>
      <SelectTrigger aria-label="Production branch" aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} className="w-full min-w-0">
        <SelectValue placeholder="Not set">{value ? <BranchName name={value} /> : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">
        <BranchOptions names={branches.names} pinned={[value, branches.defaultBranch]} defaultBranch={branches.defaultBranch} disabled={() => loading} />
        {loading ? <SelectItem value={STATUS} disabled>Loading branches…</SelectItem>
          : error ? <SelectItem value={RETRY}>Try again</SelectItem>
          : branches.nextPage ? <SelectItem value={MORE}>Load more</SelectItem>
          : !branches.names.length && <SelectItem value={STATUS} disabled>No branches</SelectItem>}
      </SelectContent>
    </Select>
    {error && <p id={errorId} role="alert" className="mt-1 whitespace-normal text-sm text-destructive">{error}</p>}
  </div>;
}
