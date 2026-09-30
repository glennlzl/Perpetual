// The controller runs only selected cases, so a one-off journey run selects its case
// for that run alone. The saved selection returns once the run leaves the queue.
export const MAX_RUN_CASES = 30;
type Selectable = { id: string; selected?: boolean };
const scopeKey = (repoPath: string, stageId: string) => JSON.stringify([repoPath, stageId]);

export function oneOffSelection<T extends Selectable>(cases: T[], caseIds: string[]): { added: string[]; cases: T[]; error?: string } {
  const added = caseIds.filter(id => cases.some(item => item.id === id && !item.selected));
  if (!added.length) return { added, cases };
  if (cases.filter(item => item.selected).length + added.length > MAX_RUN_CASES) return { added, cases, error: 'Deselect a test to run this one.' };
  return { added, cases: cases.map(item => added.includes(item.id) ? { ...item, selected: true } : item) };
}

// Null when nothing is left to undo, so an unchanged list is never saved.
export function restoreSelection<T extends Selectable>(cases: T[], added: string[]): T[] | null {
  if (!cases.some(item => added.includes(item.id) && item.selected)) return null;
  return cases.map(item => added.includes(item.id) ? { ...item, selected: false } : item);
}

type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type SelectionSnapshot = { caseIds: string[]; restoring: boolean; error: string };
type Save<T> = (cases: T[], baseCases: T[]) => Promise<unknown>;
const STORAGE_ERROR = 'Could not remember the temporary selection. Select the test manually before running it.';
export const RESTORE_FIRST = 'Restore the previous test selection first.';

/** Owns one stage's temporary selection until its save succeeds or the controller shows it deselected. */
export function createRunSelection(repoPath: string, stageId: string, storage: () => SelectionStorage | null = () => null) {
  const key = `perpetual:one-off:${scopeKey(repoPath, stageId)}`, listeners = new Set<() => void>();
  let snapshot: SelectionSnapshot = { caseIds: [], restoring: false, error: '' }, starting = false, unconfirmed = false;
  try {
    const saved: unknown = JSON.parse(storage()?.getItem(key) || 'null');
    if (Array.isArray(saved) && saved.length <= MAX_RUN_CASES && saved.every(id => typeof id === 'string' && id.length > 0)) { snapshot.caseIds = [...new Set(saved)]; unconfirmed = snapshot.caseIds.length > 0; }
  } catch { /* A start must successfully record its ownership before it changes a selection. */ }
  function publish(patch: Partial<SelectionSnapshot>) { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); }
  function remember(caseIds: string[]) {
    try { const target = storage(); if (caseIds.length) target?.setItem(key, JSON.stringify(caseIds)); else target?.removeItem(key); }
    catch { throw new Error(STORAGE_ERROR); }
    publish({ caseIds, ...(caseIds.length ? {} : { error: '' }) });
  }
  const failed = (failure: unknown) => publish({ restoring: false, error: `Could not restore test selection: ${(failure as Error).message}` });
  function keep(caseIds: string[]) {
    const left = snapshot.caseIds.filter(id => !caseIds.includes(id));
    if (left.length !== snapshot.caseIds.length) { remember(left); if (!left.length) unconfirmed = false; }
  }
  async function restore<T extends Selectable>(cases: T[], save: Save<T>, { active = false, retry = false }: { active?: boolean; retry?: boolean } = {}) {
    if (starting || snapshot.restoring || !snapshot.caseIds.length) return;
    try {
      // Explicit deselection or removal relinquishes ownership even while a run is active.
      // A lost write reply or reload cannot establish that the old cached snapshot is still the controller's selection.
      if (!unconfirmed) keep(snapshot.caseIds.filter(id => !cases.some(item => item.id === id && item.selected)));
      if (!snapshot.caseIds.length || active || snapshot.error && !retry) return;
      const owned = [...snapshot.caseIds], next = restoreSelection(cases, owned) || (unconfirmed ? cases : null);
      if (!next) return;
      publish({ restoring: true, error: '' });
      await save(next, cases);
      keep(owned);
      publish({ restoring: false });
    } catch (failure) { failed(failure); throw failure; }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    keep,
    restore,
    async start<T extends Selectable, Result>(cases: T[], ids: string[], save: Save<T>, run: () => Promise<Result>): Promise<Result> {
      if (snapshot.caseIds.length || snapshot.restoring || starting) throw new Error(RESTORE_FIRST);
      const selection = oneOffSelection(cases, ids);
      if (selection.error) throw new Error(selection.error);
      if (!selection.added.length) return run();
      // Only IDs enter browser storage, before the first request can persist their temporary selection.
      remember(selection.added);
      starting = true; unconfirmed = true;
      let selected = false;
      try { await save(selection.cases, cases); selected = true; unconfirmed = false; return await run(); }
      catch (failure) {
        starting = false;
        if (selected) await restore(selection.cases, save, { retry: true }).catch(() => { /* The owner retains and exposes the failed restoration. */ });
        // A conflict before selection confirms this write changed nothing; another writer's choice is not ours.
        else if ((failure as { statusCode?: number } | null)?.statusCode === 409) keep(selection.added);
        else failed(failure);
        throw failure;
      } finally { starting = false; }
    },
  };
}

const selections = new Map<string, ReturnType<typeof createRunSelection>>();
/** Closing a panel keeps its owner; reloading the same tab reloads only its scoped case IDs. */
export function runSelection(repoPath: string, stageId: string) {
  const key = scopeKey(repoPath, stageId);
  if (!selections.has(key)) selections.set(key, createRunSelection(repoPath, stageId, () => globalThis.sessionStorage));
  return selections.get(key)!;
}
