// The failing job of a GitHub Actions workflow as a repair reads it from the repository at the failing commit: the
// failed step's run command, and the toolchain its actions/setup-* step installs, which picks the repair box's image.
// Workflow YAML is repository data: only the fields read here are used, each checked, and versions match strict patterns.
import { parse } from 'yaml';

export type Toolchain = { tool: 'node' | 'python' | 'go'; version: string | null; file: string | null };
export interface FailingStep { job: string | null; step: string | null; run: string | null; workingDirectory: string | null; toolchain: Toolchain | null }

const MAX_WORKFLOW = 256 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 4000) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, limit) : null;
const SETUP = /^actions\/setup-(node|python|go)@/;
const TOOLS = { node: 'node', python: 'python', go: 'go' } as const;
// A version as setup actions accept it, normalized to an image tag: 20, 20.11, 3.12.1; `.x` suffixes drop.
const VERSIONS: Record<Toolchain['tool'], RegExp> = { node: /^\d{1,2}(?:\.\d{1,3}){0,2}$/, python: /^3(?:\.\d{1,2}){0,2}$/, go: /^1(?:\.\d{1,2}){0,2}$/ };
const FALLBACK: Record<Toolchain['tool'], string> = { node: 'lts', python: '3', go: '1' };
const IMAGES: Record<Toolchain['tool'], string> = { node: 'node', python: 'python', go: 'golang' };
/** The image for a repository without a setup action: git and a build toolchain, like GitHub's Ubuntu runner. */
export const DEFAULT_IMAGE = 'buildpack-deps:bookworm';

/** A setup action's version as an image tag, or null when it is not one this box can name. */
export function toolVersion(tool: Toolchain['tool'], value: unknown): string | null {
  const raw = text(value, 100)?.trim().replace(/^v/i, '').replace(/(?:\.x)+$/i, '');
  if (!raw) return null;
  if (tool === 'node' && /^lts(?:\/.*)?$/i.test(raw)) return 'lts';
  if (tool === 'node' && /^(?:latest|current|node)$/i.test(raw)) return 'current';
  if (tool === 'go' && /^(?:stable|oldstable)$/i.test(raw)) return '1';
  return VERSIONS[tool].test(raw) ? raw : null;
}

/** The box image for a toolchain: node → node:<v>-bookworm, python → python:<v>-bookworm, go → golang:<v>-bookworm. */
export function boxImage(toolchain: Pick<Toolchain, 'tool' | 'version'> | null | undefined) {
  if (!toolchain || !Object.hasOwn(IMAGES, toolchain.tool)) return DEFAULT_IMAGE;
  const version = toolchain.version && toolVersion(toolchain.tool, toolchain.version);
  return `${IMAGES[toolchain.tool]}:${version || FALLBACK[toolchain.tool]}-bookworm`;
}

/**
 * The images a box falls back to when the registry has no tag for its toolchain image, such as an old or unreleased
 * version without a bookworm build: the same version on the image's own default base, then DEFAULT_IMAGE.
 */
export const fallbackImages = (image: string) => image === DEFAULT_IMAGE ? [] : [...(image.endsWith('-bookworm') ? [image.slice(0, -'-bookworm'.length)] : []), DEFAULT_IMAGE];

// How .tool-versions (asdf, mise) names each tool at the start of its line.
const TOOL_LINE: Record<Toolchain['tool'], RegExp> = { node: /^(?:nodejs|node)\s+/i, python: /^python\s+/i, go: /^(?:golang|go)\s+/i };

/**
 * A version file's version: .nvmrc, .node-version or .python-version's first line, the tool's own line of
 * .tool-versions (its first version, as it may list fallbacks), or go.mod's go line.
 */
export function versionFromFile(tool: Toolchain['tool'], file: string, content: string) {
  if (tool === 'go' && /(?:^|\/)go\.mod$/.test(file)) return toolVersion(tool, /^go\s+(\S+)/m.exec(content)?.[1]);
  const lines = content.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
  if (/(?:^|\/)\.tool-versions$/.test(file)) {
    const line = lines.find(value => TOOL_LINE[tool].test(value));
    return line ? toolVersion(tool, line.replace(TOOL_LINE[tool], '').split(/\s+/)[0]) : null;
  }
  return toolVersion(tool, (lines[0] ?? '').replace(/^(?:nodejs|node|python|golang|go)\s+/i, ''));
}

// A job's name as GitHub reports it: its name or id, with matrix values in parentheses; a reusable workflow's jobs
// are `caller / callee`.
function jobMatches(id: string, job: Record<string, unknown>, name: string) {
  const base = name.split(' / ')[0];
  return [text(job.name), id].filter((value): value is string => Boolean(value) && !value!.includes('${{')).some(value => base === value || base.startsWith(`${value} (`));
}
// A step's name, or GitHub's default for an unnamed one: `Run <first line>` or `Run <action>`.
function stepMatches(step: Record<string, unknown>, name: string) {
  if (text(step.name) === name) return true;
  if (!name.startsWith('Run ')) return false;
  const rest = name.slice(4).trim(), uses = text(step.uses), run = text(step.run)?.trim().split('\n')[0].trim();
  return Boolean(rest) && (uses === rest || Boolean(run) && (run === rest || run!.startsWith(rest) || rest.startsWith(run!)));
}
// ${{ matrix.key }}: the value in the reported job name's parentheses when the matrix lists it, else its first value.
function matrixValue(value: unknown, job: Record<string, unknown>, name: string) {
  const expression = typeof value === 'string' && /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value.trim());
  if (!expression) return value;
  const matrix = isRecord(job.strategy) && isRecord(job.strategy.matrix) ? job.strategy.matrix : {};
  const values = Array.isArray(matrix[expression[1]]) ? (matrix[expression[1]] as unknown[]).map(item => text(item, 100)).filter(Boolean) as string[] : [];
  const shown = /\((.*)\)\s*$/.exec(name.split(' / ')[0])?.[1].split(',').map(item => item.trim()) ?? [];
  return values.find(item => shown.includes(item)) ?? values[0] ?? null;
}

// Words that only prepare the shell for the commands after them, and the keywords around a command, never a check.
const SETUP_WORD = /^(?:cd|pushd|popd|echo|printf|export|set|shopt|source|\.|true|false|:|unset|alias|trap|umask|fi|done|esac|then|else|do|\{|\}|\(|\))$/;
const LEADING = /^(?:(?:if|then|do|else|elif|while|until|!|\{|\()\s+|[A-Za-z_]\w*=\S*\s+)+/;
/**
 * The commands of a step's run script: its lines, continuations joined, split at &&, ||, ; and |, without comments,
 * leading keywords and variable assignments, or the shell's own setup such as cd. A GitHub expression ends a command
 * where it starts, since no shell runs it; what precedes it, at least a program and an argument, is matched as a prefix.
 */
function stepCommands(run: string) {
  return run.replace(/\\\r?\n/g, ' ').split(/\r?\n/).flatMap(line => line.replace(/(?:^|\s)#.*$/, '').split(/&&|\|\||[;|]/)).map(part => {
    const expression = part.indexOf('${{');
    const text = (expression < 0 ? part : part.slice(0, expression)).replace(/\s+/g, ' ').trim().replace(LEADING, '').trim();
    return { text, whole: expression < 0 };
  }).filter(({ text, whole }) => text && !SETUP_WORD.test(text.split(' ')[0]) && !/^[A-Za-z_]\w*=/.test(text) && (whole || text.includes(' '))).slice(0, 100);
}
const BEFORE = /[\s;&|(]/, AFTER = /[\s;&|)]/;
/**
 * Whether a shell command runs one of the failing steps' commands (`runs`, their run scripts) as a command of its own,
 * such as `npm test` in `cd app && CI=1 npm test`, never inside another word such as `pnpm test`.
 */
export function reproduces(command: string, runs: readonly string[]) {
  const ran = ` ${command.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim()} `;
  return runs.flatMap(stepCommands).some(({ text, whole }) => {
    for (let index = ran.indexOf(text); index > 0; index = ran.indexOf(text, index + 1)) {
      if (BEFORE.test(ran[index - 1]) && (!whole || AFTER.test(ran[index + text.length] ?? ' '))) return true;
    }
    return false;
  });
}

/**
 * The failed job and step of a workflow's YAML: the step's run command and working directory, and the job's first
 * actions/setup-node|python|go step with its version or version file. Anything it cannot read is null.
 */
export function failingStep(yaml: string, job: string | null, steps: readonly string[]): FailingStep {
  const empty: FailingStep = { job, step: steps[0] ?? null, run: null, workingDirectory: null, toolchain: null };
  let workflow: unknown;
  try { workflow = yaml.length > MAX_WORKFLOW ? null : parse(yaml, { maxAliasCount: 50 }); } catch { return empty; }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return empty;
  const entries = Object.entries(workflow.jobs).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
  const found = (job ? entries.find(([id, item]) => jobMatches(id, item, job)) : undefined) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!found) return empty;
  const [, definition] = found, list = Array.isArray(definition.steps) ? definition.steps.filter(isRecord) : [];
  const failed = steps.map(name => list.find(step => stepMatches(step, name))).find(Boolean);
  const defaults = (value: unknown) => isRecord(value) && isRecord(value.run) ? text(value.run['working-directory'], 500) : null;
  const setup = list.find(step => SETUP.test(text(step.uses) ?? ''));
  let toolchain: Toolchain | null = null;
  if (setup) {
    const tool = TOOLS[SETUP.exec(text(setup.uses)!)![1] as keyof typeof TOOLS], options = isRecord(setup.with) ? setup.with : {};
    const version = matrixValue(options[`${tool}-version`], definition, job ?? '');
    toolchain = { tool, version: toolVersion(tool, version), file: text(options[`${tool}-version-file`], 500) };
  }
  return {
    job, step: failed ? text(failed.name, 300) ?? steps[0] ?? null : steps[0] ?? null, run: failed ? text(failed.run) : null,
    workingDirectory: (failed && text(failed['working-directory'], 500)) || defaults(definition.defaults) || defaults(workflow.defaults), toolchain,
  };
}
