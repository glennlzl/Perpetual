import type { BrowserCase, CaseAssertion } from './browser-test-ui.ts';
import type { StepRow } from './journey-steps.ts';

/** The case editor's fields: preconditions and outcomes as text, one per line, and milestones as rows. */
export type CaseForm = Omit<BrowserCase, 'goal' | 'preconditions' | 'expectedOutcomes' | 'assertions' | 'isolation'> & { goal: string; preconditions: string; expectedOutcomes: string; assertions: CaseAssertion[]; isolation: BrowserCase['isolation']; stepRows: StepRow[] };
/** An edit of a case: the definition it started from (caseDraftOriginal) and the edited fields. */
export interface CaseDraft { original: string; draft: CaseForm }
// Ephemeral edits survive closing a dialog; never persist test inputs in browser storage.
export const caseDrafts = new Map<string, CaseDraft>();
// A new test's unsent description, kept on every close until it is generated or discarded.
export const newTestDrafts = new Map<string, string>();
export const hasCaseDrafts = () => caseDrafts.size > 0 || newTestDrafts.size > 0;
export const caseDraftKey = (repoPath: string, stageId: string, caseId: string) => JSON.stringify([repoPath, stageId, caseId]);
export const newTestDraftKey = (repoPath: string, stageId: string) => JSON.stringify([repoPath, stageId]);
export const caseDraftOriginal = <T extends object>({ selected: _selected, ...definition }: T & { selected?: boolean }) => JSON.stringify(definition);

// A draft of a deleted or changed case can never be saved, so it must not keep the unload prompt alive.
export function pruneCaseDrafts<T extends Pick<BrowserCase, 'id' | 'selected'>>(repoPath: string, stageId: string, cases: T[], drafts: Map<string, Pick<CaseDraft, 'original'>> = caseDrafts) {
  const scope = JSON.stringify([repoPath, stageId]).slice(0, -1) + ',';
  const originals = new Map(cases.map(item => [caseDraftKey(repoPath, stageId, item.id), caseDraftOriginal(item)]));
  for (const [key, value] of drafts) if (key.startsWith(scope) && originals.get(key) !== value.original) drafts.delete(key);
}

// Neither a case draft nor an unsent description of a stage that left the pipeline can be saved or
// sent, so both are dropped once the source's pipeline no longer lists that stage.
export function pruneStageDrafts(repoPath: string, stageIds: string[], maps: Map<string, unknown>[] = [caseDrafts, newTestDrafts]) {
  const kept = new Set(stageIds);
  for (const drafts of maps) for (const key of drafts.keys()) {
    let scope: unknown;
    try { scope = JSON.parse(key); } catch { continue; }
    if (Array.isArray(scope) && scope[0] === repoPath && !kept.has(scope[1])) drafts.delete(key);
  }
}
