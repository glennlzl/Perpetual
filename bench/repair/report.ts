// The bake-off report as markdown: per framework and model, success with counts and a Wilson 95% interval, cost per
// success and per attempt, time, requests and tool calls, how attempts ended, rule violations and judge failures; then
// a per-case matrix and the cases only one framework and model solved.
import type { AttemptRecord } from './results.ts';

export function wilson(successes: number, total: number, z = 1.96): [number, number] {
  if (!total) return [0, 0];
  const p = successes / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator, half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function quantile(values: readonly number[], q: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
const percent = (value: number) => `${Math.round(value * 100)}%`;
const money = (value: number) => Number.isFinite(value) ? `$${value.toFixed(value < 0.1 ? 4 : 2)}` : '–';
const seconds = (ms: number) => Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : '–';
const counts = (values: readonly string[]) => {
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => `${value} ${count}`).join(', ') || '–';
};
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
const costOf = (record: AttemptRecord) => record.gateway?.cost ?? 0;

/** The report for a run's records; the latest record of a key wins. */
export function renderReport(input: readonly AttemptRecord[], { title = 'Repair-agent bake-off' }: { title?: string } = {}) {
  const latest = new Map<string, AttemptRecord>();
  for (const record of input) latest.set(record.key, record);
  const records = [...latest.values()], attempted = records.filter(record => record.status === 'judged');
  const groups = new Map<string, AttemptRecord[]>();
  for (const record of attempted) { const name = `${record.framework} · ${record.model}`; groups.set(name, [...(groups.get(name) ?? []), record]); }
  const names = [...groups.keys()].sort();
  const lines = [`# ${title}`, ''];
  const skipped = records.filter(record => record.status === 'skipped'), errors = records.filter(record => record.status === 'error');
  // Every paid request counts toward what was spent: a runner error's, and an attempt a resumed run replaced.
  const spent = input.reduce((total, record) => total + costOf(record), 0);
  lines.push(`${attempted.length} attempts over ${new Set(attempted.map(record => record.case)).size} cases, ${money(spent)} spent${skipped.length ? `; ${skipped.length} skipped (${counts(skipped.map(record => record.skipped ?? 'unknown'))})` : ''}${errors.length ? `; ${errors.length} runner errors, not counted (a resumed run retries them)` : ''}.`, '');
  lines.push('## By framework and model', '');
  lines.push(table(['Framework · model', 'Success', '95% CI', '$/success', '$/attempt', 'Median time', 'p90 time', 'Median requests', 'Median tool calls', 'Ended', 'Rule violations', 'Judge failures', 'Cost unknown', 'Passed without done'], names.map(name => {
    const group = groups.get(name)!, wins = group.filter(record => record.success).length, [low, high] = wilson(wins, group.length);
    const cost = group.reduce((total, record) => total + costOf(record), 0);
    const violations = [...group.flatMap(record => record.rules.rejected.map(reason => `rejected: ${reason.split('.')[0]}`)), ...group.filter(record => record.judge?.reason === 'test-changed').map(() => 'test-changed'),
      ...group.filter(record => record.judge?.reason === 'guard').map(() => 'guard'), ...group.filter(record => record.judge?.reason === 'scripts').map(() => 'scripts'), ...group.flatMap(record => (record.gateway?.modelViolations ?? []).map(() => 'model'))];
    const failures = group.flatMap(record => record.judge && !record.judge.ciPassed ? [record.judge.steps.find(step => step.exit !== 0)?.name ?? record.judge.reason] : []);
    return [name, `${wins}/${group.length} (${percent(wins / group.length)})`, `${percent(low)}–${percent(high)}`, wins ? money(cost / wins) : '–', money(cost / group.length),
      seconds(quantile(group.map(record => record.wallMs), 0.5)), seconds(quantile(group.map(record => record.wallMs), 0.9)),
      String(quantile(group.map(record => record.gateway?.requests ?? 0), 0.5)), String(quantile(group.map(record => record.gateway?.toolCalls ?? 0), 0.5)),
      counts(group.map(record => record.reason ?? record.status)), counts(violations), counts(failures), String(group.filter(record => (record.gateway?.costSources.unknown ?? 0) > 0).length), String(group.filter(record => record.passedWithoutDone).length)];
  })));
  const cases = [...new Set(attempted.map(record => record.case))].sort();
  lines.push('', '## By case', '', 'Each cell: successes/attempts · mean cost per attempt.', '');
  lines.push(table(['Case', ...names], cases.map(name => [name, ...names.map(group => {
    const found = groups.get(group)!.filter(record => record.case === name);
    return found.length ? `${found.filter(record => record.success).length}/${found.length} · ${money(found.reduce((total, record) => total + costOf(record), 0) / found.length)}` : '–';
  })])));
  const unique = cases.flatMap(name => {
    const solvers = names.filter(group => groups.get(group)!.some(record => record.case === name && record.success));
    return solvers.length === 1 ? [[name, solvers[0]]] : [];
  });
  lines.push('', '## Unique solves', '', unique.length ? table(['Case', 'Only solved by'], unique) : 'No case was solved by exactly one framework and model.');
  lines.push('', '## Caveat', '', `With ${cases.length} cases and ${Math.max(0, ...attempted.map(record => record.seed))} seed(s), differences under about 20 percentage points are noise. Read the intervals, not the ranks.`, '');
  return lines.join('\n');
}
