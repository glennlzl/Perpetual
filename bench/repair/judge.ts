// The judge: whether an attempt's change fixes the case, decided in a brand-new box from the clean snapshot, never on
// the (case-insensitive) macOS host. The change is applied there as the box wrote it, then checked by the product's
// change rules twice as the product checks a push (the box's diff, then what git stages: its own paths and its --text
// diff), by the universal guard (no package.json scripts or .npmrc changed) and the case's guards, and finally the case's
// holdout tests are added and its CI steps run. Success is every CI step exiting 0 with no rejection, no test or CI
// change, and every guard kept; the runner also requires that the attempt ended at done, as the product pushes only
// done attempts.
import { isDeepStrictEqual } from 'node:util';
import { lstat } from 'node:fs/promises';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { HELD, checkChanges, pathRules } from '../../src/repair/changes.ts';
import { createBenchBox, type BenchBox } from './box.ts';
import { runSteps, type CiStep } from './ci.ts';
import type { Case, Guard } from './corpus.ts';

export type JudgeReason = 'passed' | 'no-change' | 'patch' | 'rule' | 'test-changed' | 'scripts' | 'guard' | 'ci';
export interface GuardResult { file: string; json: string[]; ok: boolean; actual?: unknown }
export interface JudgeResult {
  passed: boolean; reason: JudgeReason; detail: string; rules: { rejected: string[]; holds: string[] }; testChanged: boolean; scriptsChanged: string[];
  guards: GuardResult[]; steps: { name: string; exit: number; ms: number; timedOut: boolean }[]; ciPassed: boolean; tail: string; ms: number;
}

// What git stages from the workspace against base, through a temporary index as the product's DIFF_SCRIPT reads it:
// $2 is `paths` (NUL-separated names) or `text` (the --text diff the product's host copy checks).
const STAGED = [
  'set -e', 'd=$(mktemp -d)', 'trap \'rm -rf "$d"\' EXIT', 'export GIT_INDEX_FILE="$d/index"',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.ignorecase=false -c core.precomposeunicode=false "$@"; }',
  'g read-tree "$1"', 'g add -A -- .',
  'if [ "$2" = paths ]; then g diff --cached --name-only -z --no-renames "$1"; else g diff --cached --text -U0 --no-color --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ "$1"; fi',
].join('\n');

/** The product's rules on the box's diff and on what git staged, as its agent step applies them before a push. */
export function changeRules(diff: string, staged: { paths: readonly string[]; text: string }, deployFiles: readonly string[] = []) {
  const first = checkChanges(diff, { deployFiles }), paths = pathRules(staged.paths, deployFiles), text = checkChanges(staged.text, { deployFiles });
  const rejected = [...new Set([...first.rejected, ...paths.rejected, ...text.rejected])], holds = [...new Set([...first.holds, ...paths.holds])];
  return { rejected, holds, testChanged: holds.includes(HELD.tests) };
}

/** A JSON (or JSONC, such as tsconfig.json) value at a path; undefined when the file or the path is missing. */
export function jsonValue(text: string | null, path: readonly string[]): unknown {
  if (text === null) return undefined;
  const errors: ParseError[] = [];
  let value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) return undefined;
  for (const part of path) value = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}
export const guardResults = (guards: readonly Guard[], read: (file: string) => string | null): GuardResult[] => guards.map(guard => {
  const actual = jsonValue(read(guard.file), guard.json);
  return { file: guard.file, json: guard.json, ok: isDeepStrictEqual(actual, guard.equals), ...(isDeepStrictEqual(actual, guard.equals) ? {} : { actual }) };
});
/** Whether a package.json's scripts changed; a removed package.json changed them, an added one did not. */
export function scriptsChanged(before: string | null, after: string | null) {
  if (before === null) return false;
  return after === null || !isDeepStrictEqual(jsonValue(before, ['scripts']), jsonValue(after, ['scripts']));
}

/** The first failing check, in the order a person would read them. */
export function verdict(parts: Pick<JudgeResult, 'rules' | 'testChanged' | 'scriptsChanged' | 'guards' | 'steps'>): Pick<JudgeResult, 'reason' | 'detail'> {
  if (parts.rules.rejected.length) return { reason: 'rule', detail: parts.rules.rejected.join(' ') };
  if (parts.testChanged) return { reason: 'test-changed', detail: HELD.tests };
  if (parts.scriptsChanged.length) return { reason: 'scripts', detail: `Scripts or npm configuration changed in ${parts.scriptsChanged.join(', ')}.` };
  const guard = parts.guards.find(item => !item.ok);
  if (guard) return { reason: 'guard', detail: `${guard.file} ${guard.json.join('.')} changed.` };
  const failed = parts.steps.find(step => step.exit !== 0);
  if (failed || !parts.steps.length) return { reason: 'ci', detail: failed ? `${failed.name} exited ${failed.exit}${failed.timedOut ? ' (timed out)' : ''}.` : 'No CI step ran.' };
  return { reason: 'passed', detail: '' };
}

const empty = (reason: JudgeReason, detail: string, started: number): JudgeResult =>
  ({ passed: false, reason, detail, rules: { rejected: [], holds: [] }, testChanged: false, scriptsChanged: [], guards: [], steps: [], ciPassed: false, tail: '', ms: Date.now() - started });

async function read(box: BenchBox, argv: string[]) {
  const result = await box.exec(argv, { timeoutMs: 60_000, limit: 16 * 1024 * 1024 });
  return result.exitCode === 0 ? result.stdout : null;
}
/** What the judge cannot judge without: a read that failed, timed out or was cut off is a runner error, never an empty change. */
export async function readWhole(box: Pick<BenchBox, 'exec'>, argv: string[], what: string) {
  const result = await box.exec(argv, { timeoutMs: 60_000, limit: 16 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(`The judge could not read ${what}.`);
  return result.stdout;
}
/** A file as the commit holds it, or null when the commit has none: a listing that names nothing, never a failed read. */
export async function readAtCommit(box: Pick<BenchBox, 'exec'>, sha: string, path: string) {
  const listed = await readWhole(box, ['git', 'ls-tree', '--name-only', sha, '--', path], path);
  return listed.trim() ? readWhole(box, ['git', 'show', `${sha}:${path}`], path) : null;
}

/** Judges a change to the case in a new box from snapshot at sha. */
export async function judge({ c, snapshot, sha, diff, image, steps, root, signal, onScope }: {
  c: Pick<Case, 'holdout' | 'meta'>; snapshot: string; sha: string; diff: Buffer; image: string; steps: readonly CiStep[]; root: string; signal?: AbortSignal; onScope?(scope: string): void | Promise<void>;
}): Promise<JudgeResult> {
  const started = Date.now();
  if (!diff.toString('utf8').trim()) return empty('no-change', 'The attempt changed no file.', started);
  const box = await createBenchBox({ image, source: snapshot, root, signal, onScope });
  try {
    const applied = await box.exec(['sh', '-c', 'base64 -d > /tmp/change.diff && git apply --binary --whitespace=nowarn /tmp/change.diff'], { stdin: diff.toString('base64'), timeoutMs: 120_000 });
    if (applied.exitCode !== 0) return empty('patch', `The change does not apply: ${(applied.stdout + applied.stderr).trim().split('\n')[0] ?? ''}`.slice(0, 500), started);
    const paths = (await readWhole(box, ['sh', '-c', STAGED, 'sh', sha, 'paths'], 'what git staged')).split('\0').filter(Boolean);
    const text = await readWhole(box, ['sh', '-c', STAGED, 'sh', sha, 'text'], 'what git staged');
    const rules = changeRules(diff.toString('utf8'), { paths, text });
    // npm configuration can rewrite how scripts run (node-options, script-shell), so changing it counts as changing them.
    const scripts = paths.filter(path => /(?:^|\/)\.npmrc$/.test(path));
    for (const path of paths.filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
      // A manifest absent at the commit was added; one there is read whole, so a failed read never passes for added.
      if (scriptsChanged(await readAtCommit(box, sha, path), await read(box, ['cat', '--', path]))) scripts.push(path);
    }
    const files = new Map<string, string | null>();
    for (const guard of c.meta.guards) if (!files.has(guard.file)) files.set(guard.file, await read(box, ['cat', '--', guard.file]));
    const guards = guardResults(c.meta.guards, file => files.get(file) ?? null);
    if (await lstat(c.holdout).then(info => info.isDirectory(), () => false)) await box.copyIn(c.holdout, box.root);
    const runs = await runSteps(box, steps, { signal });
    const parts = { rules: { rejected: rules.rejected, holds: rules.holds }, testChanged: rules.testChanged, scriptsChanged: scripts, guards, steps: runs.map(({ name, exit, ms, timedOut }) => ({ name, exit, ms, timedOut })) };
    const { reason, detail } = verdict(parts);
    return { passed: reason === 'passed', reason, detail, ...parts, ciPassed: runs.length === steps.length && runs.every(run => run.exit === 0), tail: (runs.at(-1)?.output ?? '').slice(-4000), ms: Date.now() - started };
  } finally { await box.remove(); }
}
