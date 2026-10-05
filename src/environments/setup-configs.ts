// What a repository's own setup files say about running it, for EVIDENCE.md (./evidence.ts): CI workflows, Dockerfiles,
// dev containers, deploy manifests, turbo.json and Supabase's config.toml. Each reader parses one file's text as
// untrusted data and returns Markdown lines and the variable names the file declares or references, each with the line
// it first appears on. Commands, images, ports, versions and paths are quoted; a variable's value never is. However a
// file is crafted, each reader's time grows with its size, not faster, and each line it returns is one line.
import { parse as parseJsonc, visit as visitJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parseDocument, visit as visitYaml } from 'yaml';
import { redact } from '../redaction.ts';

/** A setup file's evidence: its lines, and the variable names it declares or references with their line. */
export interface SetupEvidence { lines: string[]; names: { name: string; line: number }[] }

/** Bytes of a setup file the evidence reads, characters of a quoted command line, and entries of a long list. */
export const SETUP_LIMITS = { bytes: 256 * 1024, command: 200, lines: 20, entries: 40, depth: 8 };

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fields = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const scalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);
/** A string, or the strings of a list; nothing else. */
const strings = (value: unknown) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const clip = (text: string, limit = SETUP_LIMITS.command) => text.length > limit ? `${text.slice(0, limit)}…` : text;

const LINE_BREAKS = /[\r\n\u2028\u2029]+/;
/** Text on one line: its lines, trimmed, joined by a space. */
export const oneLine = (text: string) => LINE_BREAKS.test(text) ? text.split(LINE_BREAKS).map(part => part.trim()).filter(Boolean).join(' ') : text;
/** Inline code that survives backticks in its text, on one line. */
export function code(value: string) {
  const text = oneLine(value);
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
const PLAIN = /^[\w.*!/:@-]+$/;
/** A key, port or name pattern as it is when it is one plain word, else as inline code: never Markdown of its own. */
export const word = (value: string) => PLAIN.test(value) ? value : code(value);
type Observation = (text: string) => string;
/** Quoted repository text is redacted before formatting or clipping; parsed facts stay untouched. */
function quoted(observe: Observation) {
  const quote = (value: string) => code(observe(value)), name = (value: string) => word(observe(value));
  return { code: quote, word: name, command: (value: string) => code(clip(observe(value).trim())),
    names: (values: Iterable<string>) => [...new Set(values)].map(name).join(', ') };
}
/** The first entries of a long list, and how many it left out. */
function capped(lines: string[], limit = SETUP_LIMITS.entries, indent = '') {
  return lines.length <= limit ? lines : [...lines.slice(0, limit), `${indent}- … ${lines.length - limit} more left out.`];
}
/** The first entries of a long list, each formatted, and how many it left out, which are never formatted. */
function joined<Value>(values: Value[], format: (value: Value) => string, limit = SETUP_LIMITS.entries) {
  const kept = values.slice(0, limit).map(format).join(', ');
  return values.length <= limit ? kept : `${kept} and ${values.length - limit} more`;
}

/** The 1-based line of each offset in `text`. */
export function lineNumbers(text: string) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return (offset: number) => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= offset) low = middle; else high = middle - 1; }
    return low + 1;
  };
}

/** Where each text first appears, by its offset. */
type Positions = Map<string, number>;
function earliest(positions: Positions, text: string, offset: number) {
  const known = positions.get(text);
  if (known === undefined || offset < known) positions.set(text, offset);
}
// A line that is only a comment, or a word.
const TOKEN = /^[ \t]*(?:#|\/\/)[^\n]*|[A-Za-z0-9_]+/gm;
/**
 * Each wanted name's first offset where it is a key (`NAME =`, `NAME:`, `"NAME":`), else where it is first a word; lines
 * that are only a comment are left out. For the names a parsed file has no position for.
 */
function wordPositions(text: string, wanted: Set<string>): Positions {
  const keyed: Positions = new Map(), seen: Positions = new Map();
  if (!wanted.size) return keyed;
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    if (!wanted.has(token) || keyed.has(token)) continue;
    let next = match.index + token.length;
    if (text[next] === '"' || text[next] === "'") next += 1;
    while (text[next] === ' ' || text[next] === '\t') next += 1;
    if (text[next] === '=' || text[next] === ':') keyed.set(token, match.index);
    else if (!seen.has(token)) seen.set(token, match.index);
  }
  for (const [name, offset] of seen) if (!keyed.has(name)) keyed.set(name, offset);
  return keyed;
}
/**
 * The variable names found, in order and once each, with their line in `text`: the first place the parsed file has one
 * as a key, a string or a reference (`positions`), else the first place it is a key or a word.
 */
function located(text: string, found: Iterable<string>, positions: Positions = new Map()) {
  const list = [...new Set(found)].filter(name => VARIABLE.test(name));
  const words = wordPositions(text, new Set(list.filter(name => !positions.has(name)))), line = lineNumbers(text);
  return list.map(name => ({ name, line: line(positions.get(name) ?? words.get(name) ?? 0) }));
}
/** A table of variables' keys that are variable names. */
const keys = (value: unknown) => Object.keys(fields(value) ?? {}).filter(name => VARIABLE.test(name));

/** A parsed file, and where each of its keys and string values first appears. */
type Parsed = { value: unknown; positions: Positions };
/**
 * A YAML document, refused when it does not parse; aliases expand at most 100 times, the library's own bound, which counts
 * nested expansions too, so a compose file can still share one defaults block across many services. A repeated key is not
 * refused, since checking every key against the others takes time that grows with the square of their number: the last
 * one counts. Errors are not formatted against the source, which takes as long for each of them; only the first is thrown.
 */
function yaml(text: string): Parsed {
  const document = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  if (document.errors.length) throw document.errors[0];
  const positions: Positions = new Map();
  visitYaml(document, { Scalar(_key, node) { if (typeof node.value === 'string' && node.range) earliest(positions, node.value, node.range[0]); } });
  return { value: document.toJS({ maxAliasCount: 100 }), positions };
}
/** A YAML file's value, as the readers parse it. */
export const yamlValue = (text: string) => yaml(text).value;
const JSONC = { allowTrailingComma: true };
/** JSON with comments; what does not parse is not an object. */
function jsonc(text: string): Parsed {
  const positions: Positions = new Map();
  visitJsonc(text, {
    onObjectProperty: (name, offset) => earliest(positions, name, offset),
    onLiteralValue: (value: unknown, offset) => { if (typeof value === 'string') earliest(positions, value, offset); },
  }, JSONC);
  return { value: parseJsonc(text, [], JSONC) as unknown, positions };
}
/** TOML, refused when it does not parse; its parser keeps no positions. */
const toml = (text: string): Parsed => ({ value: parseToml(text), positions: new Map() });

// GitHub Actions: a secret or variable read, `secrets.NAME` or `vars.NAME`, inside a `${{ … }}` expression that opened
// at most 200 characters before it on its line.
const REFERENCE = /(?<![\w.])(?:secrets|vars)(?<=\$\{\{[^}\n]{0,200}(?:secrets|vars))\.([A-Za-z_][A-Za-z0-9_]*)/g;
// A setup action's version inputs, such as actions/setup-node's node-version or pnpm/action-setup's version.
const SETUP_ACTION = /(?:^|\/)(?:setup-[\w-]+|action-setup)@/i, VERSION_INPUT = /(?:^|-)version(?:-file)?$/i;

function runsOn(value: unknown, code: (value: string) => string): string | null {
  if (scalar(value)) return code(String(value));
  if (Array.isArray(value)) return value.filter(scalar).map(item => code(String(item))).join(', ') || null;
  const labels = fields(value) && [...strings(fields(value)?.group), ...strings(fields(value)?.labels)];
  return labels?.length ? labels.map(code).join(', ') : null;
}
const image = (value: unknown) => typeof value === 'string' ? value : typeof fields(value)?.image === 'string' ? fields(value)!.image as string : null;

/** A GitHub Actions workflow: per job, where it runs, its services, working directory, variables and steps. */
export function workflow(text: string, observe: Observation = redact): SetupEvidence {
  const { code, word, command, names } = quoted(observe);
  const parsed = yaml(text), document = fields(parsed.value);
  if (!document) return { lines: ['- Not a workflow.'], names: [] };
  // What its expressions read, then the names its variable tables declare.
  const referenced: Positions = new Map();
  for (const match of text.matchAll(REFERENCE)) earliest(referenced, match[1], match.index);
  const lines: string[] = [], found: string[] = [...referenced.keys()];
  const variables = (value: unknown) => { const list = keys(value); found.push(...list); return list; };
  const directory = (value: unknown) => fields(fields(fields(value)?.defaults)?.run)?.['working-directory'];
  const top = variables(document.env), topDirectory = directory(document);
  if (top.length) lines.push(`- Variables: ${names(top)}`);
  if (typeof topDirectory === 'string') lines.push(`- Working directory: ${code(topDirectory)}`);
  for (const [id, value] of Object.entries(fields(document.jobs) ?? {})) {
    const job = fields(value);
    if (!job) continue;
    const where = runsOn(job['runs-on'], code), calls = typeof job.uses === 'string' ? job.uses : null;
    lines.push(`- Job ${code(id)}${where ? `: runs on ${where}` : ''}${calls ? `: calls ${code(calls)}` : ''}`);
    const container = image(job.container);
    if (container) lines.push(`  - Container: ${code(container)}`);
    for (const [service, definition] of Object.entries(fields(job.services) ?? {})) {
      const ports = Array.isArray(fields(definition)?.ports) ? (fields(definition)!.ports as unknown[]).filter(scalar).map(String) : [];
      const env = variables(fields(definition)?.env), from = image(definition);
      lines.push(`  - Service ${code(service)}${from ? `: ${code(from)}` : ''}${ports.length ? `, ports ${names(ports)}` : ''}${env.length ? `; variables ${names(env)}` : ''}`);
    }
    const jobDirectory = directory(job);
    if (typeof jobDirectory === 'string') lines.push(`  - Working directory: ${code(jobDirectory)}`);
    const env = variables(job.env);
    if (env.length) lines.push(`  - Variables: ${names(env)}`);
    const inputs = keys(job.with);
    if (inputs.length) lines.push(`  - With: ${names(inputs)}`);
    const steps = Array.isArray(job.steps) ? job.steps.map(fields).filter(step => step !== null) : [];
    if (steps.length) lines.push('  - Steps:');
    const stepLines: string[] = [];
    for (const step of steps) {
      const notes: string[] = [];
      if (typeof step['working-directory'] === 'string') notes.push(`in ${code(step['working-directory'])}`);
      const stepEnv = variables(step.env);
      if (stepEnv.length) notes.push(`variables ${names(stepEnv)}`);
      if (typeof step.uses === 'string') {
        const setup = SETUP_ACTION.test(step.uses), inputs = Object.entries(fields(step.with) ?? {});
        const version = ([key, input]: [string, unknown]) => setup && VERSION_INPUT.test(key) && scalar(input);
        const versions = inputs.filter(version).map(([key, input]) => `${word(key)} ${code(String(input))}`);
        const other = inputs.filter(input => !version(input)).map(([key]) => key);
        stepLines.push(`    - ${code(step.uses)}${[...versions, ...(other.length ? [`with ${names(other)}`] : []), ...notes].map(part => `; ${part}`).join('')}`);
      } else if (typeof step.run === 'string') {
        const run = observe(step.run).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const suffix = notes.map(part => `; ${part}`).join('');
        if (run.length === 1) stepLines.push(`    - run ${command(run[0])}${suffix}`);
        else stepLines.push(`    - run${suffix}:`, ...capped(run.map(line => `      - ${command(line)}`), SETUP_LIMITS.lines, '      '));
      }
    }
    lines.push(...capped(stepLines, SETUP_LIMITS.entries, '    '));
  }
  if (referenced.size) lines.push(`- Secrets and variables it references: ${names(referenced.keys())}`);
  for (const [name, offset] of referenced) earliest(parsed.positions, name, offset);
  return { lines, names: located(text, found, parsed.positions) };
}

// A Dockerfile's quoted strings, left out when reading its variable names. A string that is never closed runs to the end
// of its instruction, so no quote starts a second scan.
const QUOTED = /"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'[^']*(?:'|$)/g;
const unquoted = (text: string) => text.replace(QUOTED, '""');
const spaced = (text: string) => unquoted(text).trim().split(/\s+/).filter(Boolean);
// A line that ends with a backslash continues on the next one that is not a comment.
const CONTINUED = /\\\s*$/, COMMENT = /^\s*#/;
// A heredoc opens in RUN, COPY or ADD with a word of its own that starts with <<, its delimiter quoted or not; quoted text
// and arithmetic such as $((1 << n)) open none. Quoted text is left out before looking, but for a delimiter's quotes.
const HEREDOC = /(?:^|\s)<<-?(["']?)([A-Za-z_]\w*)\1(?=\s|$)/, HEREDOC_KEYWORDS = new Set(['RUN', 'COPY', 'ADD']);
const QUOTED_TEXT = /(<<-?(["'])[A-Za-z_]\w*\2)|"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'[^']*(?:'|$)/g;

/** A Dockerfile: its base images, working directories, build arguments, variables, ports and start commands. */
export function dockerfile(text: string, observe: Observation = redact): SetupEvidence {
  const { code, word, command } = quoted(observe);
  const rows = text.split(/\r?\n/), found = new Map<string, number>();
  // The last row that is each text, so a heredoc that never closes opens none and the rows after it are still read.
  const closing = new Map(rows.map((row, index) => [row.trim(), index]));
  const parts: Record<'From' | 'Workdir' | 'Args' | 'Env' | 'Expose' | 'Cmd' | 'Entrypoint', string[]> = { From: [], Workdir: [], Args: [], Env: [], Expose: [], Cmd: [], Entrypoint: [] };
  for (let index = 0, heredoc: string | null = null; index < rows.length; index += 1) {
    if (heredoc !== null) { if (rows[index].trim() === heredoc) heredoc = null; continue; }
    if (!rows[index].trim() || COMMENT.test(rows[index])) continue;
    const line = index + 1, pieces: string[] = [];
    // Tested once for each line it holds, not again for each comment row inside the instruction.
    let current = rows[index], continued = CONTINUED.test(current);
    while (continued && index + 1 < rows.length) {
      index += 1;
      if (COMMENT.test(rows[index])) continue;
      pieces.push(current.replace(CONTINUED, ' '));
      current = rows[index];
      continued = CONTINUED.test(current);
    }
    pieces.push(current);
    const match = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(pieces.join(''));
    if (!match) continue;
    const keyword = match[1].toUpperCase(), args = match[2].trim();
    const opened = HEREDOC_KEYWORDS.has(keyword) ? HEREDOC.exec(args.replace(QUOTED_TEXT, (_text, delimiter?: string) => delimiter ?? '""'))?.[2] : undefined;
    heredoc = opened !== undefined && (closing.get(opened) ?? -1) > index ? opened : null;
    if (keyword === 'FROM') {
      const [from, as, stage] = spaced(args).filter(item => !item.startsWith('--'));
      if (from) parts.From.push(`${code(from)}${as?.toUpperCase() === 'AS' && stage ? ` as ${code(stage)}` : ''}`);
    } else if (keyword === 'WORKDIR') parts.Workdir.push(code(args));
    else if (keyword === 'EXPOSE') parts.Expose.push(...spaced(args).map(word));
    else if (keyword === 'CMD' || keyword === 'ENTRYPOINT') parts[keyword === 'CMD' ? 'Cmd' : 'Entrypoint'].push(command(args));
    else if (keyword === 'ARG' || keyword === 'ENV') {
      const bare = unquoted(args);
      // ENV NAME=value NAME2=value, or the older ENV NAME value; ARG NAME[=default].
      const declared = keyword === 'ARG' ? spaced(args).map(item => item.split('=')[0])
        : /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare) ? [...bare.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(item => item[1]) : [spaced(args)[0] ?? ''];
      for (const name of declared.filter(name => VARIABLE.test(name))) {
        parts[keyword === 'ARG' ? 'Args' : 'Env'].push(word(name));
        if (!found.has(name)) found.set(name, line);
      }
    }
  }
  const lines = Object.entries(parts).filter(([, values]) => values.length).map(([label, values]) => `- ${label}: ${[...new Set(values)].join(', ')}`);
  return { lines: lines.length ? lines : ['- No instructions it reads.'], names: [...found].map(([name, line]) => ({ name, line })) };
}

/** A dev container command: a string, a list of arguments, or named commands that run in parallel, each one of those. */
function devCommand(value: unknown, quotes: ReturnType<typeof quoted>, named = true): string[] {
  const { code, command } = quotes;
  if (typeof value === 'string') return [command(value)];
  if (Array.isArray(value)) return [command(strings(value).join(' '))];
  return named ? Object.entries(fields(value) ?? {}).flatMap(([name, item]) => devCommand(item, quotes, false).map(text => `${code(name)} ${text}`)) : [];
}
const LIFECYCLE = ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand'];

/** A devcontainer.json, comments allowed: its image or build, features, forwarded ports, setup commands and variables. */
export function devcontainer(text: string, observe: Observation = redact): SetupEvidence {
  const quotes = quoted(observe), { code, names } = quotes;
  const parsed = jsonc(text), config = fields(parsed.value);
  if (!config) return { lines: ['- Could not be read.'], names: [] };
  const lines: string[] = [], build = fields(config.build);
  if (typeof config.image === 'string') lines.push(`- Image: ${code(config.image)}`);
  if (build) lines.push(`- Build: ${[...strings(build.dockerfile).map(file => `dockerfile ${code(file)}`), ...strings(build.context).map(context => `context ${code(context)}`)].join(', ') || 'yes'}`);
  const compose = strings(config.dockerComposeFile);
  if (compose.length) lines.push(`- Compose files: ${compose.map(code).join(', ')}${typeof config.service === 'string' ? `, service ${code(config.service)}` : ''}`);
  const features = Object.keys(fields(config.features) ?? {});
  if (features.length) lines.push(`- Features: ${features.map(code).join(', ')}`);
  const ports = Array.isArray(config.forwardPorts) ? config.forwardPorts.filter(scalar).map(String) : [];
  if (ports.length) lines.push(`- Forwarded ports: ${names(ports)}`);
  for (const key of LIFECYCLE) lines.push(...capped(devCommand(config[key], quotes).map(item => `- ${key}: ${item}`)));
  const containerEnv = keys(config.containerEnv), remoteEnv = keys(config.remoteEnv);
  if (containerEnv.length) lines.push(`- containerEnv: ${names(containerEnv)}`);
  if (remoteEnv.length) lines.push(`- remoteEnv: ${names(remoteEnv)}`);
  return { lines: lines.length ? lines : ['- No settings it reads.'], names: located(text, [...containerEnv, ...remoteEnv], parsed.positions) };
}

// Keys of a deploy manifest whose values are quoted: commands, directories and settings such as a builder or port. A
// table named like an environment only has its names read.
const COMMAND_KEY = /(?:cmds?|commands?)$/i;
const DIRECTORY_KEY = /^(?:root|base|publish|functions|directory|rootDir(?:ectory)?|outputDirectory|dockerfile(?:Path)?|dockerContext|context|buildContext|workingDirectory|watchPatterns|sql_paths)$/i;
const SETTING_KEY = /^(?:builder|runtime|framework|type|provider|image|internal_port|port|targetPort|healthcheckPath)$/i;
const ENVIRONMENT_KEY = /^(?:env|environment|variables|envVars|build_args|buildArgs|args)$/i;
const PROCESSES_KEY = /^processes$/i;
/** The names of a table of variables, a list of `{ key }` entries or `NAME=value` strings. */
function tableNames(value: unknown) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item.split('=')[0] : fields(item)?.key).filter((name): name is string => typeof name === 'string' && VARIABLE.test(name));
  return keys(value);
}

/**
 * Commands, directories, settings and variable names anywhere in a parsed deploy manifest. A line past the entries the
 * evidence keeps is only counted, as an empty line, since formatting each entry's whole path would take time that grows
 * with their number times the path's length.
 */
function manifestEntries(value: unknown, path: string, lines: string[], found: string[], quotes: ReturnType<typeof quoted>, depth = 0) {
  if (depth > SETUP_LIMITS.depth) return;
  const { code, command, names } = quotes;
  const add = (line: () => string) => { lines.push(lines.length < SETUP_LIMITS.entries ? line() : ''); };
  if (Array.isArray(value)) {
    value.forEach((item, index) => { const name = fields(item)?.name; manifestEntries(item, `${path}[${typeof name === 'string' ? name : index}]`, lines, found, quotes, depth + 1); });
    return;
  }
  for (const [key, child] of Object.entries(fields(value) ?? {})) {
    const at = path ? `${path}.${key}` : key;
    if (ENVIRONMENT_KEY.test(key) && (Array.isArray(child) || fields(child))) {
      const list = tableNames(child);
      found.push(...list);
      if (list.length) add(() => `- ${code(at)}: ${names(list)}`);
    } else if (PROCESSES_KEY.test(key) && fields(child)) {
      for (const [process, item] of Object.entries(fields(child)!)) if (typeof item === 'string') add(() => `- ${code(`${at}.${process}`)}: ${command(item)}`);
    } else if ((COMMAND_KEY.test(key) || DIRECTORY_KEY.test(key)) && strings(child).length) add(() => `- ${code(at)}: ${strings(child).map(command).join(', ')}`);
    else if (SETTING_KEY.test(key) && scalar(child)) add(() => `- ${code(at)}: ${code(String(child))}`);
    else if (child !== null && typeof child === 'object') manifestEntries(child, at, lines, found, quotes, depth + 1);
  }
}

/** A deploy manifest by its file name: Procfile, TOML, YAML or JSON with comments. */
export function deployManifest(name: string, text: string, observe: Observation = redact): SetupEvidence {
  const quotes = quoted(observe), { code, command } = quotes;
  const lines: string[] = [], found: string[] = [];
  let positions: Positions = new Map();
  if (/^procfile$/i.test(name)) {
    for (const row of observe(text).split(/\r?\n/)) { const entry = /^([\w-]+):\s*(.+)$/.exec(row.trim()); if (entry) lines.push(`- ${code(entry[1])}: ${command(entry[2])}`); }
  } else {
    const parsed = /\.toml$/i.test(name) ? toml(text) : /\.ya?ml$/i.test(name) ? yaml(text) : jsonc(text);
    if (!fields(parsed.value)) return { lines: ['- Could not be read.'], names: [] };
    positions = parsed.positions;
    manifestEntries(parsed.value, '', lines, found, quotes);
  }
  return { lines: lines.length ? capped(lines) : ['- No commands, directories or variables it reads.'], names: located(text, found, positions) };
}

/** turbo.json: its tasks and the variables each passes to them. */
export function turbo(text: string, observe: Observation = redact): SetupEvidence {
  const { code, names } = quoted(observe);
  const parsed = jsonc(text), config = fields(parsed.value);
  if (!config) return { lines: ['- Could not be read.'], names: [] };
  const tasks = Object.entries(fields(config.tasks) ?? fields(config.pipeline) ?? {}), found: string[] = [], lines: string[] = [];
  const listed = (label: string, value: unknown) => { const list = strings(value); found.push(...list); return list.length ? [`${label} ${names(list)}`] : []; };
  if (tasks.length) lines.push(`- Tasks: ${tasks.map(([task]) => code(task)).join(', ')}`);
  const global = [...listed('env', config.globalEnv), ...listed('pass-through', config.globalPassThroughEnv)];
  if (global.length) lines.push(`- Global: ${global.join('; ')}`);
  for (const [task, value] of tasks) {
    const own = [...listed('env', fields(value)?.env), ...listed('pass-through', fields(value)?.passThroughEnv)];
    if (own.length) lines.push(`- ${code(task)}: ${own.join('; ')}`);
  }
  return { lines: lines.length ? capped(lines) : ['- No tasks or variables.'], names: located(text, found, parsed.positions) };
}

// Supabase config.toml: a value `env(NAME)` is read from the environment.
const ENV_REFERENCE = /env\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
function references(value: unknown, path: string, found: [string, string][], depth = 0) {
  if (typeof value === 'string') for (const match of value.matchAll(ENV_REFERENCE)) found.push([path, match[1]]);
  else if (depth <= SETUP_LIMITS.depth && value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) references(child, path ? `${path}.${key}` : key, found, depth + 1);
  }
}
const enabled = (value: unknown, key = 'enabled') => fields(value)?.[key] === true;

/** A Supabase config.toml: its env() references, functions, seed and enabled sign-in methods. */
export function supabaseConfig(text: string, observe: Observation = redact): SetupEvidence {
  const { code, word } = quoted(observe);
  const config = fields(toml(text).value);
  if (!config) return { lines: ['- Could not be read.'], names: [] };
  const lines: string[] = [], found: [string, string][] = [];
  references(config, '', found);
  if (found.length) lines.push(`- Variables from env(): ${joined(found, ([path, name]) => `${code(path)} ${word(name)}`)}`);
  const functions = Object.entries(fields(config.functions) ?? {});
  if (functions.length) lines.push(`- Functions in config: ${joined(functions, ([name, value]) => {
    const settings = Object.entries(fields(value) ?? {}).filter(([, setting]) => scalar(setting)).map(([key, setting]) => `${word(key)} ${code(String(setting))}`);
    return `${code(name)}${settings.length ? ` (${settings.join(', ')})` : ''}`;
  })}`);
  const seed = fields(fields(config.db)?.seed);
  if (seed) lines.push(`- Seed: ${seed.enabled === false ? 'disabled' : 'enabled'}${strings(seed.sql_paths).length ? `, ${strings(seed.sql_paths).map(code).join(', ')}` : ''}`);
  const auth = fields(config.auth);
  if (auth) {
    const methods = [...(enabled(auth.email, 'enable_signup') ? ['email'] : []), ...(enabled(auth.sms, 'enable_signup') ? ['phone'] : []), ...(auth.enable_anonymous_sign_ins === true ? ['anonymous'] : []),
      ...Object.entries(fields(auth.external) ?? {}).filter(([, value]) => enabled(value)).map(([provider]) => `external ${word(provider)}`),
      ...Object.entries(fields(auth.third_party) ?? {}).filter(([, value]) => enabled(value)).map(([provider]) => `third-party ${word(provider)}`)];
    lines.push(`- Sign-in enabled: ${methods.join(', ') || 'none'}`);
  }
  // Each name's line is that of its first env() reference.
  const positions: Positions = new Map();
  for (const match of text.matchAll(ENV_REFERENCE)) earliest(positions, match[1], match.index);
  return { lines, names: located(text, found.map(([, name]) => name), positions) };
}
