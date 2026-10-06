// The repair agent's tools, its only permissions. Each runs inside the repair box: list, read and grep within the
// workspace with capped output and a `truncated` flag; edit and write within the workspace, never .git; run a shell
// command with a time limit, returning its exit code and the end of its output; and done. A path is checked twice: as
// text on the host (relative, no `..`, no .git) and by its real path in the box, so a link cannot lead out.
import { posix } from 'node:path';
import { jsonSchema, tool, type JSONSchema7 } from 'ai';
import type { BoxResult, RepairBox } from './box.ts';
import { REDACTED, redact } from '../redaction.ts';

export const LIMITS = {
  path: 1024, entries: 500, lines: 2000, readBytes: 64 * 1024, lineChars: 2000, matches: 100, matchChars: 300, pattern: 500, include: 200,
  editBytes: 1024 * 1024, command: 20_000, output: 30_000, capture: 1024 * 1024, searchSeconds: 30, runSeconds: 900, defaultRunSeconds: 300,
};
type Refusal = { ok: false; error: string };
type Result = { ok: true; [key: string]: unknown } | Refusal;
type FileObservation = { ok: true; raw: string[]; redacted: string[] } | Refusal;
/** What the loop learns from the tools: each command's exit code, and each file a tool changed. */
export interface ToolEvents { run?(command: string, exitCode: number): void; change?(path: string): void }

const refused = (error: string): Refusal => ({ ok: false, error });
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
// Replies read the workspace as source code: key blocks, token shapes and literals set to a name like token or password
// are hidden, while the expressions and types around such names stay as written, so a line read can be edited.
const scrub = (value: unknown) => redact(value, { code: true });
// The redaction marker stands in replies for text the tools hide, such as a literal set to a name like token or
// password; copied into a file it would replace real code.
const markers = (text: string) => text.split(REDACTED).length - 1;
const MARKED = `${REDACTED} stands for text the tools hide, such as a literal set to a name like token or password, and is never code`;
const oneLine = (value: unknown, limit = 200) => clip(scrub(value).replace(/\s+/g, ' ').trim(), limit);
const unavailable = (result: BoxResult) => ({ ...refused('The tool output exceeded its capture limit. Observation unavailable; narrow the command or use a smaller file.'), exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated });
/** The last limit characters of text from a line start, or the end of its last line when that alone is longer. */
function lastLines(text: string, limit: number) {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit), start = text[text.length - limit - 1] === '\n' ? 0 : tail.indexOf('\n') + 1;
  return start > 0 && start < tail.length ? tail.slice(start) : tail;
}
/** Model-facing text only; internal paths, file edits and change validation keep their original bytes. */
function modelResult(result: Result): Result {
  const strings = (value: unknown): unknown => typeof value === 'string' ? scrub(value)
    : Array.isArray(value) ? value.map(strings)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strings(item)])) : value;
  return strings(result) as Result;
}
const field = (input: unknown, name: string) => input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const GIT = /^\.git[. ]*$/i;
// The nearest existing ancestor of a path, as named and as its real path.
const RESOLVE = 't="$1"; while [ ! -e "$t" ] && [ ! -L "$t" ]; do t=$(dirname "$t"); done; printf \'%s\\n\' "$t"; realpath "$t"';

/** A workspace path as the model named it: relative, or under /workspace; never absolute elsewhere, `..` or .git. */
export function workspacePath(value: unknown, fallback?: string): { path: string; error?: undefined } | { error: string } {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== 'string' || raw.length > LIMITS.path || raw.includes('\0')) return { error: 'Name a path relative to /workspace, such as src/index.ts.' };
  let path = raw.trim();
  if (path === '/workspace' || path.startsWith('/workspace/')) path = path.slice('/workspace'.length).replace(/^\/+/, '');
  if (!path) path = '.';
  if (posix.isAbsolute(path)) return { error: `${oneLine(raw)} is outside /workspace; name a path relative to it.` };
  const normalized = posix.normalize(path).replace(/\/$/, '') || '.';
  if (normalized === '..' || normalized.startsWith('../')) return { error: `${oneLine(raw)} is outside /workspace.` };
  if (normalized.split('/').some(part => GIT.test(part))) return { error: `${oneLine(raw)} is in .git, which a repair never reads or changes.` };
  return { path: normalized };
}

/** The tools over one box; `signal` stops a command in flight. */
export function repairTools(box: RepairBox, { events = {}, signal }: { events?: ToolEvents; signal?: AbortSignal } = {}) {
  const root = box.root, shown = (full: string) => full === root ? '.' : full.slice(root.length + 1);
  const exec = (argv: string[], options: Parameters<RepairBox['exec']>[1] = {}) => box.exec(argv, { signal, timeoutMs: 30_000, ...options });
  /** The real path of a workspace path in the box, refused when a link leads it out of the workspace or into .git. */
  async function locate(value: unknown, fallback?: string): Promise<{ full: string; name: string; error?: undefined } | { error: string }> {
    const named = workspacePath(value, fallback);
    if (named.error !== undefined) return named;
    const target = named.path === '.' ? root : `${root}/${named.path}`;
    const result = await exec(['sh', '-c', RESOLVE, 'sh', target]);
    if (result.truncated) return { error: 'The workspace path could not be read completely.' };
    const [ancestor, real] = result.stdout.split('\n');
    if (result.exitCode !== 0 || !ancestor || !real || !target.startsWith(ancestor)) return { error: `${named.path} leads outside /workspace.` };
    const full = posix.normalize(real + target.slice(ancestor.length)).replace(/\/$/, '');
    if (full !== root && !full.startsWith(`${root}/`)) return { error: `${named.path} leads outside /workspace.` };
    if (shown(full).split('/').some(part => GIT.test(part))) return { error: `${named.path} leads into .git, which a repair never reads or changes.` };
    return { full, name: named.path };
  }
  async function list(input: unknown): Promise<Result> {
    const found = await locate(field(input, 'path'), '.');
    if (found.error !== undefined) return refused(found.error);
    const result = await exec(['sh', '-c', '[ -d "$1" ] || exit 3; ls -1AF "$1"', 'sh', found.full]);
    if (result.truncated) return unavailable(result);
    if (result.exitCode === 3) return refused(`${found.name} is not a folder; read it instead.`);
    if (result.exitCode !== 0) return refused(`${found.name} could not be listed.`);
    const entries = scrub(result.stdout).split('\n').filter(Boolean).map(entry => entry.replace(/[*=|>%]$/, '')).filter(entry => !GIT.test(entry.replace(/[/@]$/, '')));
    return { ok: true, path: found.name, entries: entries.slice(0, LIMITS.entries), truncated: entries.length > LIMITS.entries };
  }
  /** Redact the complete bounded file before selecting lines; a fragment may have lost its credential's context. */
  async function observeFile(found: { full: string; name: string }): Promise<FileObservation> {
    const result = await exec(['sh', '-c', '[ -f "$1" ] || exit 3; cat "$1"', 'sh', found.full], { limit: 4 * LIMITS.readBytes });
    if (result.truncated) return unavailable(result);
    if (result.exitCode === 3) return refused(`${found.name} is not a file; list it instead.`);
    if (result.exitCode !== 0 || result.timedOut) return refused(`${found.name} could not be read completely.`);
    if (result.stdout.includes('\0')) return refused(`${found.name} is a binary file.`);
    const lines = (text: string) => { const values = text.split('\n'); if (values.at(-1) === '') values.pop(); return values; };
    const raw = lines(result.stdout), redacted = lines(scrub(result.stdout));
    if (raw.length !== redacted.length) return refused(`${found.name} cannot be shown with accurate line numbers after redaction.`);
    return { ok: true, raw, redacted };
  }
  async function read(input: unknown): Promise<Result> {
    const found = await locate(field(input, 'path'));
    if (found.error !== undefined) return refused(found.error);
    const offset = field(input, 'offset') ?? 1, limit = field(input, 'limit') ?? LIMITS.lines;
    if (!whole(offset) || !whole(limit)) return refused('offset and limit are whole numbers from 1.');
    const wanted = Math.min(limit, LIMITS.lines);
    const file = await observeFile(found);
    if (!file.ok) return file;
    const lines = file.redacted.slice(offset - 1);
    if (offset > 1 && !lines.length) return refused(`${found.name} has fewer than ${offset} lines.`);
    const content: string[] = [];
    let size = 0;
    for (const [index, line] of lines.slice(0, wanted).entries()) {
      const numbered = `${offset + index}\t${clip(line, LIMITS.lineChars)}`;
      if (content.length && size + numbered.length + 1 > LIMITS.readBytes) break;
      size += numbered.length + 1;
      content.push(numbered);
    }
    const truncated = content.length < lines.length;
    return { ok: true, path: found.name, content: content.join('\n'), truncated, ...(truncated ? { next: offset + content.length } : {}) };
  }
  async function grep(input: unknown): Promise<Result> {
    const pattern = field(input, 'pattern'), include = field(input, 'include');
    if (typeof pattern !== 'string' || !pattern || pattern.length > LIMITS.pattern) return refused(`Pass a pattern of 1 to ${LIMITS.pattern} characters.`);
    if (include !== undefined && (typeof include !== 'string' || !include || include.length > LIMITS.include || include.includes('/'))) return refused(`include is a file name glob of 1 to ${LIMITS.include} characters, such as *.ts.`);
    const found = await locate(field(input, 'path'), '.');
    if (found.error !== undefined) return refused(found.error);
    const result = await exec(['grep', '-rnHIsE', '--null', '--exclude-dir=.git', ...(include ? [`--include=${include}`] : []), '-e', pattern, '--', found.full], { timeoutMs: LIMITS.searchSeconds * 1000, limit: 1024 * 1024 });
    if (result.truncated) return unavailable(result);
    if (result.timedOut) return refused(`The search took over ${LIMITS.searchSeconds} seconds; use a narrower path or an include glob.`);
    if (result.exitCode > 1) return refused(`The search failed: ${oneLine(result.stderr || 'grep error', 300)}`);
    // Keep grep's native ERE and match order. Its text is evidence for a complete-file read, never model output.
    const lines: { file: string; line: number; text: string }[] = [];
    let cursor = 0;
    while (cursor < result.stdout.length) {
      const separator = result.stdout.indexOf('\0', cursor), end = result.stdout.indexOf('\n', separator + 1);
      const colon = result.stdout.indexOf(':', separator + 1), number = result.stdout.slice(separator + 1, colon);
      if (separator < cursor || end < 0 || colon < separator || colon > end || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) return refused('The search returned an unreadable match.');
      lines.push({ file: result.stdout.slice(cursor, separator), line: Number(number), text: result.stdout.slice(colon + 1, end) });
      cursor = end + 1;
    }
    // Only a match shown counts toward the limit. A matched file the tools cannot show completely, such as a large or
    // binary one, is named in skipped and its lines are left out, so the rest of the search still answers. At most as
    // many files are read as matches may be shown, skipped ones included.
    const files = new Map<string, FileObservation>(), matches: string[] = [], skipped: string[] = [];
    let truncated = false;
    for (const match of lines) {
      let file = files.get(match.file);
      if (file && !file.ok) continue;
      if (matches.length === LIMITS.matches || !file && files.size === LIMITS.matches) { truncated = true; break; }
      if (!match.file.startsWith(`${root}/`)) return refused('A search result leads outside /workspace.');
      if (!file) {
        const located = await locate(shown(match.file));
        if (located.error !== undefined) return refused(located.error);
        file = await observeFile(located);
        files.set(match.file, file);
        if (!file.ok) { skipped.push('truncated' in file && file.truncated ? `${located.name} is over ${4 * LIMITS.readBytes / 1024} KB.` : file.error); continue; }
      }
      if (file.raw[match.line - 1] !== match.text) return refused(`${shown(match.file)} changed after the search; search again.`);
      matches.push(`${shown(match.file)}:${clip(`${match.line}:${file.redacted[match.line - 1]}`.trim(), LIMITS.matchChars)}`);
    }
    return { ok: true, path: found.name, matches, truncated, ...(skipped.length ? { skipped } : {}) };
  }
  async function write(found: { full: string; name: string }, text: string) {
    const result = await exec(['sh', '-c', '[ -d "$1" ] && exit 3; mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', found.full], { stdin: text });
    if (result.exitCode === 3) return refused(`${found.name} is a folder.`);
    if (result.exitCode !== 0) return refused(`${found.name} could not be written.`);
    events.change?.(found.name);
    return null;
  }
  async function edit(input: unknown): Promise<Result> {
    const before = field(input, 'old'), after = field(input, 'new');
    if (typeof before !== 'string' || !before || typeof after !== 'string') return refused('Pass old, the exact text to replace, and new, its replacement.');
    if (before === after) return refused('old and new are the same.');
    const found = await locate(field(input, 'path'));
    if (found.error !== undefined) return refused(found.error);
    const result = await exec(['sh', '-c', '[ -f "$1" ] || exit 3; cat "$1"', 'sh', found.full], { limit: LIMITS.editBytes });
    if (result.exitCode === 3) return refused(`${found.name} is not a file; write it instead.`);
    if (result.exitCode !== 0) return refused(`${found.name} could not be read.`);
    if (result.truncated) return refused(`${found.name} is over 1 MB; change it with run.`);
    if (result.stdout.includes('\0') || result.stdout.includes('�')) return refused(`${found.name} is not UTF-8 text; change it with run.`);
    const parts = result.stdout.split(before);
    if (parts.length === 1 && before.includes(REDACTED)) return refused(`old was not found in ${found.name}: ${MARKED}. Anchor old on the text around it.`);
    if (parts.length === 1) return refused(`old was not found in ${found.name}; read the file and copy the text exactly, with its indentation.`);
    if (parts.length > 2) return refused(`old occurs ${parts.length - 1} times in ${found.name}; include more of the surrounding lines so it is unique.`);
    if (markers(after) > markers(before)) return refused(`new adds ${REDACTED}: ${MARKED}. Keep the original text.`);
    return await write(found, parts.join(after)) ?? { ok: true, path: found.name };
  }
  async function create(input: unknown): Promise<Result> {
    const text = field(input, 'text');
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.editBytes) return refused('Pass the whole file as text, at most 1 MB.');
    const found = await locate(field(input, 'path'));
    if (found.error !== undefined) return refused(found.error);
    if (found.full === root) return refused('Name a file to write.');
    if (text.includes(REDACTED)) {
      const current = await exec(['sh', '-c', '[ -f "$1" ] || exit 0; cat "$1"', 'sh', found.full], { limit: LIMITS.editBytes });
      if (markers(text) > markers(current.stdout)) return refused(`text adds ${REDACTED}: ${MARKED}. Keep the original text: change the file with edit, anchored around it.`);
    }
    return await write(found, text) ?? { ok: true, path: found.name };
  }
  async function run(input: unknown): Promise<Result> {
    const command = field(input, 'command'), seconds = field(input, 'timeoutSeconds') ?? LIMITS.defaultRunSeconds;
    if (typeof command !== 'string' || !command.trim() || command.length > LIMITS.command) return refused(`Pass a shell command of at most ${LIMITS.command} characters.`);
    if (!whole(seconds) || seconds > LIMITS.runSeconds) return refused(`timeoutSeconds is a whole number from 1 to ${LIMITS.runSeconds}.`);
    const result = await box.exec(['bash', '-c', 'exec 2>&1; eval "$1"', 'bash', command], { signal, timeoutMs: seconds * 1000, limit: LIMITS.capture, keep: 'tail' });
    events.run?.(command, result.exitCode);
    // The capture is the output's last MiB, redacted whole before its end is returned, so a credential begun before that
    // end is still hidden. Of a capture the box cut, the first line has lost its start, which may hold a credential's
    // context: it is dropped, and a capture that is one cut line is withheld.
    let text = result.stdout + result.stderr;
    if (result.truncated) {
      const start = text.indexOf('\n') + 1;
      if (!start || start === text.length) return unavailable(result);
      text = text.slice(start);
    }
    const output = scrub(text), tail = lastLines(output, LIMITS.output);
    return { ok: true, exitCode: result.exitCode, output: tail, timedOut: result.timedOut, truncated: result.truncated || tail.length < output.length };
  }
  // A tool that fails answers with its error so the model can adapt; a stopped repair stops the loop.
  const guarded = (name: string, work: (input: unknown) => Promise<Result>) => async (input: unknown) => {
    try { return modelResult(await work(input)); }
    catch (error) { if (signal?.aborted) throw error; return refused(`The ${name} failed: ${oneLine((error as Error).message ?? error, 300)}`); }
  };
  const schema = (properties: Record<string, JSONSchema7>, required: string[]) => jsonSchema<unknown>({ type: 'object', properties, required, additionalProperties: false });
  const PATH = { type: 'string', description: 'A path relative to /workspace, such as src/index.ts.' } satisfies JSONSchema7;
  return {
    list: tool({ description: `Lists a folder of /workspace, at most ${LIMITS.entries} entries; folders end in / and links in @.`, inputSchema: schema({ path: PATH }, []), execute: guarded('list', list) }),
    read: tool({
      description: `Reads a text file of /workspace after redacting its complete contents (at most ${4 * LIMITS.readBytes / 1024} KB), with accurate line numbers: at most ${LIMITS.lines} lines or ${LIMITS.readBytes / 1024} KB from offset. When truncated, next is the line to read on from.`,
      inputSchema: schema({ path: PATH, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: LIMITS.lines } }, ['path']),
      execute: guarded('read', read),
    }),
    grep: tool({
      description: `Searches files under a path for an extended regular expression: at most ${LIMITS.matches} matching lines as path:line:text, after redacting each complete matched file (at most ${4 * LIMITS.readBytes / 1024} KB). A matched file it cannot show, such as a larger or binary one, is named in skipped and its lines left out. Pass a narrow path and an include glob.`,
      inputSchema: schema({ pattern: { type: 'string', maxLength: LIMITS.pattern }, path: PATH, include: { type: 'string', description: 'A file name glob, such as *.ts.' } }, ['pattern']),
      execute: guarded('grep', grep),
    }),
    edit: tool({
      description: 'Replaces old with new in a file of /workspace; old must occur exactly once, with its exact indentation.',
      inputSchema: schema({ path: PATH, old: { type: 'string' }, new: { type: 'string' } }, ['path', 'old', 'new']),
      execute: guarded('edit', edit),
    }),
    write: tool({ description: 'Writes a whole file of /workspace, creating its folders.', inputSchema: schema({ path: PATH, text: { type: 'string' } }, ['path', 'text']), execute: guarded('write', create) }),
    run: tool({
      description: `Runs a bash command in /workspace and returns its exit code and the last ${LIMITS.output / 1000} KB of its redacted output, from a line start, with truncated set when it printed more. timeoutSeconds is at most ${LIMITS.runSeconds}, ${LIMITS.defaultRunSeconds} by default.`,
      inputSchema: schema({ command: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: LIMITS.runSeconds } }, ['command']),
      execute: guarded('run', run),
    }),
    done: tool({ description: 'Ends the attempt: the cause, the change, and the command that now passes, or why the failure cannot be fixed here.', inputSchema: schema({ summary: { type: 'string' } }, ['summary']) }),
  };
}
