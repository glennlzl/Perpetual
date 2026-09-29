import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const failure = (where: string, reason: string) => new Error(`Supabase ${where} ${reason}.`);
const FUNCTION_NAME = /^[a-z\d_-]+$/i;
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

// Never read or write through a repository link. The snapshot normally omits links; check again at this boundary.
async function file(root: string, value: unknown, where: string, optional = false, kind: 'file' | 'directory' = 'file') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\') || value.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(value)
    || isAbsolute(value)) throw failure(where, 'must be a relative path inside the copied project');
  const target = resolve(root, value), path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw failure(where, 'must stay inside the copied project');
  let cursor = root;
  const parts = path.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (optional && missing(error)) return null; throw failure(where, 'must name an existing file inside the copied project'); });
    if (!info) return null;
    if (info.isSymbolicLink()) throw failure(where, 'cannot follow a symbolic link');
    if (index < parts.length - 1 || kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw failure(where, `must name a ${kind} inside the copied project`);
  }
  return target;
}

/** CLI 2.118 passes importMapPath outside Edge Runtime's context; Deno config discovery supplies the same map. */
export async function bridgeSupabaseImportMaps(project: string, toml: string) {
  let config: unknown;
  try { config = parse(toml); } catch { throw failure('config.toml', 'must be valid TOML'); }
  if (!object(config)) throw failure('config.toml', 'must contain tables');
  if (config.edge_runtime != null && !object(config.edge_runtime)) throw failure('edge_runtime', 'must be a table');
  if (object(config.edge_runtime) && config.edge_runtime.enabled != null && typeof config.edge_runtime.enabled !== 'boolean') throw failure('edge_runtime.enabled', 'must be a boolean');
  if (object(config.edge_runtime) && config.edge_runtime.enabled === false) return;
  const functions = config.functions ?? {};
  if (!object(functions)) throw failure('functions', 'must be a table');
  const root = await realpath(project);
  const functionsDirectory = await file(root, 'functions', 'functions directory', true, 'directory');
  const discovered = functionsDirectory ? (await readdir(functionsDirectory, { withFileTypes: true }))
    .filter(item => item.isDirectory() && /^[a-z][a-z\d_-]*$/i.test(item.name)).map(item => item.name) : [];
  const entries: { directory: string; map: string | null }[] = [];
  functionsLoop: for (const name of new Set([...Object.keys(functions), ...discovered])) {
    const options = functions[name] ?? {};
    const where = `functions.${name}`;
    if (!FUNCTION_NAME.test(name) || !object(options)) throw failure('functions', 'must map function names to tables');
    if (options.enabled != null && typeof options.enabled !== 'boolean') throw failure(`${where}.enabled`, 'must be a boolean');
    if (options.enabled === false) continue;
    if (options.import_map != null && typeof options.import_map !== 'string') throw failure(`${where}.import_map`, 'must be text');
    const defaultEntrypoint = options.entrypoint == null || options.entrypoint === '';
    const entrypoint = await file(root, defaultEntrypoint ? `functions/${name}/index.ts` : options.entrypoint, `${where}.entrypoint`, defaultEntrypoint);
    if (!entrypoint) continue;
    const directory = dirname(entrypoint);
    // The CLI mounts functions as a directory. Ancestors outside it are not necessarily visible in the container.
    const visibleRoot = functionsDirectory && inside(functionsDirectory, directory) ? functionsDirectory : directory;
    for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
      for (const extension of ['json', 'jsonc']) {
        if (await file(root, relative(root, join(ancestor, `deno.${extension}`)), `${where} Deno config`, true)) continue functionsLoop;
      }
      if (ancestor === visibleRoot) break;
    }
    // CLI resolveFunctionConfigs: explicit map, function-local legacy map, then functions/import_map.json.
    const map = options.import_map
      ? await file(root, options.import_map, `${where}.import_map`)
      : await file(root, relative(root, join(directory, 'import_map.json')), `${where} import map`, true)
        ?? await file(root, 'functions/import_map.json', 'global import map', true);
    if (map && (!functionsDirectory || !inside(functionsDirectory, directory))) {
      throw failure(`${where} legacy import map`, 'cannot be bridged for an entrypoint outside functions; provide a runtime-visible Deno config or move the entrypoint under functions');
    }
    entries.push({ directory, map });
  }
  // Inspect all original configs before any write: one generated wrapper is never repository precedence.
  const bridges = new Map<string, string>();
  for (const { directory, map } of entries) if (map) {
    if (bridges.has(directory) && bridges.get(directory) !== map) throw failure('functions', 'share an entrypoint directory but use different import maps; add function-local Deno configs');
    bridges.set(directory, map);
  }
  for (const directory of bridges.keys()) if (entries.some(entry => !entry.map && inside(directory, entry.directory))) {
    throw failure('functions', 'need function-local Deno configs: a compatibility wrapper would change another function without a legacy import map');
  }
  for (const [directory, map] of bridges) {
    const importMap = relative(directory, map).split(sep).join('/');
    await writeFile(join(directory, 'deno.json'), `${JSON.stringify({ importMap: importMap.startsWith('.') ? importMap : `./${importMap}` }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
}
