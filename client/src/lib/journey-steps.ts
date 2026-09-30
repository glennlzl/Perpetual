import type { JourneyStep, StepCheck } from './browser-test-ui.ts';

// Business milestones are edited as rows. IDs stay stable so results keep matching their milestone.
export const STEP_CHECKS = ['text-visible', 'text-absent', 'url-contains', 'read-number', 'compare-number'] as const;
export const COMPARE_OPS = ['<', '>', '=', '!='] as const;
const NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
let rows = 0;
const key = () => `row-${++rows}`;

/** A check as its row edits it: every field is text, so each input stays controlled. */
export interface CheckRow { key: string; type: string; value: string; label: string; name: string; op: string; than: string }
/** A milestone as its row edits it; id is empty until the milestone is saved. */
export interface StepRow { key: string; id: string; title: string; checks: CheckRow[] }
export const checkRow = (check: Partial<Omit<CheckRow, 'key'>> = {}): CheckRow => ({ key: key(), type: STEP_CHECKS.find(type => type === check.type) ?? 'text-visible', value: check.value ?? '', label: check.label ?? '', name: check.name ?? '', op: check.op ?? '<', than: check.than ?? '' });
export const stepRow = (step: Partial<JourneyStep> = {}): StepRow => ({ key: key(), id: step.id || '', title: step.title || '', checks: (step.checks || []).map(checkRow) });

// Title matches win, then a row's own ID; new lines mint IDs never used by this case.
export function assignStepIds(values: Pick<StepRow, 'id' | 'title'>[], original: Pick<JourneyStep, 'id' | 'title'>[] = []) {
  const ids = Array.from(values, () => ''), used = new Set<string>();
  values.forEach((row, index) => {
    const match = original.find(step => step.title.trim() === row.title.trim() && !used.has(step.id));
    if (match) { ids[index] = match.id; used.add(match.id); }
  });
  values.forEach((row, index) => { if (!ids[index] && row.id && ID.test(row.id) && !used.has(row.id)) { ids[index] = row.id; used.add(row.id); } });
  const taken = new Set([...used, ...original.map(step => step.id), ...values.map(row => row.id).filter(Boolean)]);
  let next = 1;
  return ids.map(id => { if (id) return id; while (taken.has(`step-${next}`)) next++; taken.add(`step-${next}`); return `step-${next}`; });
}

export function nextCaptureName(values: Pick<StepRow, 'checks'>[]) {
  const names = new Set(values.flatMap(row => row.checks.map(check => check.name.trim())));
  let next = 1;
  while (names.has(`reading${next}`)) next++;
  return `reading${next}`;
}

export function earlierCaptures(values: Pick<StepRow, 'checks'>[], stepIndex: number, checkIndex: number) {
  const names = values.slice(0, stepIndex + 1).flatMap((row, index) => row.checks.slice(0, index === stepIndex ? checkIndex : undefined)).filter(check => check.type === 'read-number' && NAME.test(check.name.trim())).map(check => check.name.trim());
  return [...new Set(names)];
}

function stepCheck(check: CheckRow): StepCheck | null {
  if (check.type === 'text-visible' || check.type === 'text-absent' || check.type === 'url-contains') return check.value.trim() && check.value.trim().length <= 4000 ? { type: check.type, value: check.value.trim() } : null;
  const label = check.label.trim(), name = check.name.trim();
  if (!label || label.length > 120 || !name) return null;
  if (check.type === 'read-number') return { type: check.type, label, name };
  const op = COMPARE_OPS.find(value => value === check.op);
  return check.type === 'compare-number' && op && check.than.trim() ? { type: check.type, label, name, op, than: check.than.trim() } : null;
}

export function buildJourneySteps(values: StepRow[], original: Pick<JourneyStep, 'id' | 'title'>[] = []): { steps: JourneyStep[]; error: string } {
  const filled = values.filter(row => row.title.trim() || row.checks.length);
  if (filled.some(row => !row.title.trim())) return { steps: [], error: 'Name each business step.' };
  if (filled.length > 12) return { steps: [], error: 'Use at most 12 business steps.' };
  if (filled.some(row => row.title.trim().length > 240)) return { steps: [], error: 'Use at most 240 characters per step.' };
  if (filled.some(row => row.checks.length > 6)) return { steps: [], error: 'Use at most 6 checks per step.' };
  const ids = assignStepIds(filled, original), captures = new Set<string>();
  const steps: JourneyStep[] = [];
  for (const [index, row] of filled.entries()) {
    const checks: StepCheck[] = [];
    for (const value of row.checks) {
      const check = stepCheck(value);
      if (!check) return { steps: [], error: 'Complete each step check.' };
      if ('name' in check && !NAME.test(check.name)) return { steps: [], error: 'Use a check name such as creditsBefore.' };
      if (check.type === 'compare-number' && !captures.has(check.than ?? '')) return { steps: [], error: 'Compare with a number read earlier.' };
      if (check.type === 'read-number') captures.add(check.name ?? '');
      checks.push(check);
    }
    steps.push({ id: ids[index], title: row.title.trim(), ...(checks.length ? { checks } : {}) });
  }
  return { steps, error: '' };
}

export const reviewedStepError = (steps: readonly unknown[], { legacyUnchanged = false }: { legacyUnchanged?: boolean } = {}) => (steps.length >= 2 && steps.length <= 12) || (legacyUnchanged && !steps.length) ? '' : 'Add 2–12 business steps.';
