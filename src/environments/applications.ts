import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { dependencyNames, MODULES, readLocal, repositoryWalk, REQUIREMENTS } from './plans.ts';

// A supported Node package is not evidence that every web application in a repository can run on the twin's
// Node image. Keep corroborated Python entrypoints visible at the creation boundary, before paid authoring or
// provisioning. This is runtime coverage, not a ranking of folders or a guess about which app is the product.
const FRAMEWORKS = [
  { dependency: 'django', module: 'django.core.wsgi', callable: 'get_wsgi_application', name: 'Django' },
  { dependency: 'django', module: 'django.core.asgi', callable: 'get_asgi_application', name: 'Django' },
  { dependency: 'fastapi', module: 'fastapi', callable: 'FastAPI', name: 'FastAPI' },
  { dependency: 'flask', module: 'flask', callable: 'Flask', name: 'Flask' },
] as const;
const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const developmentRequirements = /^requirements[.-](?:dev|development|test|tests|testing|lint|docs)(?:[.-].*)?\.txt$/i;
// Keep line positions while excluding comments and quoted examples. Never execute repository Python to inspect it.
const pythonCode = (text: string) => text.replace(/#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));

/** Runtime declarations only: test/development dependency groups cannot turn an example into the product. */
function pythonDependencies(file: string, text: string): string[] {
  if (posix.basename(file) !== 'pyproject.toml') return dependencyNames(posix.basename(file), text);
  const manifest: unknown = parseToml(text), project = record(record(manifest)?.project), poetry = record(record(record(manifest)?.tool)?.poetry);
  return [...strings(project?.dependencies),
    ...Object.entries(record(poetry?.dependencies) ?? {}).filter(([, value]) => record(value)?.optional !== true).map(([name]) => name)]
    .flatMap(value => /^\s*([A-Za-z0-9][\w.-]*)/.exec(value)?.[1].toLowerCase().replace(/[-_.]+/g, '-') ?? []);
}

function importedCallables(code: string, framework: typeof FRAMEWORKS[number]): string[] {
  const names: string[] = [], parts = framework.module.split('.'), leaf = parts.pop(), parent = parts.join('.');
  const bindings = (text: string) => text.replace(/[()]/g, '').split(',').flatMap(value => {
    const match = /^\s*([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(value);
    return match ? [{ original: match[1], local: match[2] ?? match[1] }] : [];
  });
  for (const match of code.matchAll(/^from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\r\n]+)/gm)) {
    for (const binding of bindings(match[2])) {
      if (match[1] === framework.module && binding.original === framework.callable) names.push(binding.local);
      if (parent && match[1] === parent && binding.original === leaf) names.push(`${binding.local}.${framework.callable}`);
    }
  }
  for (const match of code.matchAll(/^import[ \t]+([^\r\n]+)/gm)) {
    for (const binding of bindings(match[1])) if (binding.original === framework.module) names.push(`${binding.local}.${framework.callable}`);
  }
  return names;
}

/** A source-declared web entrypoint, corroborated by a runtime dependency in its nearest Python project. */
export interface UnsupportedWebApplication { runtime: 'Python'; framework: string; manifest: string; entrypoint: string }

export async function unsupportedWebApplications(source: string): Promise<UnsupportedWebApplication[]> {
  const { files } = await repositoryWalk(source);
  const projects = new Map<string, { file: string; dependencies: Set<string> }[]>();
  for (const file of files.filter(file => posix.basename(file) === 'pyproject.toml' || REQUIREMENTS.test(posix.basename(file)) && !developmentRequirements.test(posix.basename(file)))) {
    try {
      const project = { file, dependencies: new Set(pythonDependencies(file, await readLocal(source, file))) }, directory = posix.dirname(file);
      projects.set(directory, [...projects.get(directory) ?? [], project]);
    } catch { /* An unreadable declaration is not evidence of an application. */ }
  }
  if (![...projects.values()].flat().some(project => FRAMEWORKS.some(framework => project.dependencies.has(framework.dependency)))) return [];
  const found: UnsupportedWebApplication[] = [];
  for (const file of files.filter(file => file.endsWith('.py')).slice(0, MODULES.files)) {
    let declarations: { file: string; dependencies: Set<string> }[] | undefined;
    for (let directory = posix.dirname(file); ; directory = posix.dirname(directory)) {
      declarations = projects.get(directory);
      if (declarations || directory === '.') break;
    }
    if (!declarations) continue;
    const text = await readLocal(source, file, MODULES.bytes).catch(() => null);
    if (text === null) continue;
    const code = pythonCode(text);
    for (const framework of FRAMEWORKS) {
      const declaration = declarations.find(project => project.dependencies.has(framework.dependency));
      if (!declaration) continue;
      // Match the imported constructor/factory and its assignment, including an explicit import alias. Merely
      // installing or importing a framework (for tooling, types or tests) does not establish a web application.
      const callables = importedCallables(code, framework);
      if (!callables.some(callable => new RegExp(`^[A-Za-z_]\\w*(?:[ \\t]*:[^=\\r\\n]+)?[ \\t]*=[ \\t]*${callable.replaceAll('.', '\\.')}[ \\t]*\\(`, 'm').test(code))) continue;
      found.push({ runtime: 'Python', framework: framework.name, manifest: declaration.file, entrypoint: file });
      break;
    }
    if (found.length === 12) break;
  }
  return found;
}

export async function requireSupportedApplications(source: string) {
  const apps = await unsupportedWebApplications(source);
  if (!apps.length) return;
  const evidence = apps.map(app => `${app.framework}: ${app.entrypoint} (${app.manifest})`).join('; ');
  throw new Error(`Python web applications are not supported by the current Node twin runner: ${evidence}. Use an existing application URL for browser tests. Other sites in this repository cannot replace these applications.`);
}
