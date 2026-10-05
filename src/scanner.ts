import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withDeliveryGraph } from './delivery.ts';
import { redact } from './redaction.ts';
import { gitReadOnly } from './process.ts';
import { parseGitHubRemote } from './providers.ts';
import { hasRepositoryFile, readRepositoryFile } from './repository-files.ts';
import type { Confidence, Evidence, ScanNode, ScanEdge, ScanService, ScanWorkflow, ScanRepo, Scan, PreviewPlan } from '../contract/scanner.ts';
export type { Confidence, Evidence, ScanNode, ScanEdge, ScanService, ScanWorkflowJob, ScanWorkflow, ScanRepo, ScanPlan, Scan, PreviewPlan } from '../contract/scanner.ts';

export const DISCOVERY_VERSION = 6;

// Parsed repository files are untrusted: these describe only the fields read below, and each is still checked where used.
/** A repository's package.json as parsed JSON: only these fields are read, and each is checked where it is used. */
export interface PackageManifest {
  name?: unknown; packageManager?: unknown; workspaces?: { packages?: unknown } | null;
  dependencies?: Record<string, unknown> | null; devDependencies?: Record<string, unknown> | null; scripts?: Record<string, unknown> | null;
  engines?: unknown; volta?: unknown; devEngines?: unknown;
}
interface WorkflowYaml { name?: unknown; on?: string | string[] | { push?: { branches?: unknown } | null } | null; jobs?: Record<string, { name?: unknown; needs?: unknown }> | null }
interface RailwayConfig { build?: { dockerfilePath?: unknown } | null; deploy?: { healthcheckPath?: unknown } | null }
interface PackageManager { name: string; version: string | undefined; lock: string | null }
interface WorkflowStep { name?: string; uses?: string; run?: string; with?: Record<string, string | boolean>; env?: Record<string, string>; 'working-directory'?: string }

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'graphify-out']);
const DEPLOYMENT_FILES = new Set(['vercel.json', 'railway.toml', 'railway.json']);
const SCRIPT_NAMES = ['build', 'test', 'lint', 'typecheck', 'check', 'test:changed', 'test:related'];
const MAX_BYTES = 512 * 1024;
const clean = (value: unknown) => redact(String(value ?? '').replace(/[\r\n\t]/g, ' ')).slice(0, 160);
const slash = (value: string) => value.split(path.sep).join('/');
// A lone surrogate, from a YAML escape or a clip through a pair, would make encodeURIComponent throw.
const id = (value: string) => encodeURIComponent(value.toWellFormed());
const evidence = (file: string, summary: string, line?: number): Evidence => ({ file, ...(line ? { line } : {}), summary });
const lineOf = (text: string, search: string) => text.slice(0, Math.max(0, text.indexOf(search))).split('\n').length;
const appendEvidence = (sources: Evidence[], item: Evidence) => {
  if (!sources.some(source => source.file === item.file && source.line === item.line && source.summary === item.summary)) sources.push(item);
};

// Only known configuration files are read. Never execute repository code or follow links.
function safeFile(root: string, relative: string, options?: { content: true }): Promise<string | null>;
function safeFile(root: string, relative: string, options: { content: false }): Promise<true | null>;
async function safeFile(root: string, relative: string, { content = true }: { content?: boolean } = {}): Promise<string | true | null> {
  // Only known configuration files are read: never env files, VCS state or installed packages.
  if (relative.replaceAll('\\', '/').split('/').some(part => part.startsWith('.env') || part === '.git' || part === 'node_modules')) return null;
  if (content) return readRepositoryFile(root, relative, { limit: MAX_BYTES });
  return (await hasRepositoryFile(root, relative, { limit: MAX_BYTES })) ? true : null;
}

// Package manifests, and the directories that configure a deployment whether or not they hold one: a service in
// another language deploys from its own directory.
async function manifests(root: string) {
  const found: string[] = [], deployments = new Set<string>();
  let visited = 0;
  async function walk(relative = '.', depth = 0) {
    if (depth > 4 || visited++ > 1200) return;
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const next = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isFile() && entry.name === 'package.json') found.push(next);
      else if (entry.isFile() && DEPLOYMENT_FILES.has(entry.name)) deployments.add(relative);
      else if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) await walk(next, depth + 1);
    }
  }
  await walk();
  return { packages: found.slice(0, 100), deployments: [...deployments].slice(0, 100) };
}

async function gitValue(root: string, args: string[]) {
  try {
    const { stdout } = await gitReadOnly(root, args, { timeout: 10_000, maxBuffer: 16 * 1024 });
    return stdout.trim() || null;
  } catch (error) {
    // Git's own exit, as for a detached HEAD, no commit, no origin or no repository, means the value is absent. A git
    // that timed out or never ran gave no answer, and a scan without it would lose the commit it describes.
    if (typeof (error as { code?: unknown }).code === 'number') return null;
    throw new Error('Could not read the repository\'s branch and commit. Try again.');
  }
}

/**
 * The top level of the Git work tree holding `root`, or `root` outside one. GitHub reads `.github/workflows` only
 * there, so workflow paths are relative to it, as GitHub names them, even when a subdirectory is scanned.
 */
export async function repositoryTop(root: string) {
  const top = await gitValue(root, ['rev-parse', '--show-toplevel']);
  return top && path.isAbsolute(top) ? path.resolve(top) : root;
}

/**
 * A scan's evidence file named from the repository's top level, given the scanned directory within it, such as /apps/web
 * or apps/web/: workflow files already are, as GitHub names them, and every other file is named from the directory.
 */
export function repositoryPath(file: string, directory: string) {
  const prefix = directory.split('/').filter(Boolean).join('/');
  return prefix && !file.startsWith('.github/workflows/') ? `${prefix}/${file}` : file;
}

// GitHub's SSH, git and plain HTTP addresses name the repository its HTTPS address does.
const GITHUB_HOSTS = new Set(['github.com', 'ssh.github.com']);
function safeRemote(remote: string | null) {
  if (!remote) return null;
  // As git reads an address: one with :// is a URL, and one with a colon before any slash is scp-like,
  // [user@]host:path, where a one-letter host would be a Windows drive.
  if (!remote.includes('://')) {
    const ssh = remote.match(/^(?:[^@\s]+@)?([\w.-]{2,}):([\w./-]+)$/);
    return ssh ? `https://${GITHUB_HOSTS.has(ssh[1].toLowerCase()) ? 'github.com' : ssh[1]}/${ssh[2]}` : null;
  }
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    if (GITHUB_HOSTS.has(url.hostname.toLowerCase())) return `https://github.com${url.pathname}`;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

function framework(deps: Record<string, unknown>) {
  if (deps.next) return 'Next.js';
  if (deps.hono) return 'Hono';
  if (deps.express) return 'Express';
  if (deps.fastify) return 'Fastify';
  if (deps.nuxt) return 'Nuxt';
  if (deps.vite) return 'Vite';
  if (deps.react) return 'React';
  return 'Node.js';
}

function workspaceIncludes(relative: string, patterns: string[]) {
  if (relative === '.') return true;
  const matches = (pattern: string) => {
    const glob = pattern.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '');
    const expression = glob.split('**').map(segment => segment.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${expression}$`).test(relative);
  };
  return patterns.some(p => !p.startsWith('!') && matches(p)) && !patterns.some(p => p.startsWith('!') && matches(p));
}

async function packageManager(root: string, manifest: PackageManifest | undefined): Promise<PackageManager> {
  const declared = String(manifest?.packageManager || '').match(/^(npm|pnpm|yarn|bun)@([\d.]+)/);
  for (const [name, lock] of [['pnpm', 'pnpm-lock.yaml'], ['npm', 'package-lock.json'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock']]) {
    if ((declared && declared[1] !== name) || !(await safeFile(root, lock, { content: false }))) continue;
    return { name, version: declared?.[2], lock };
  }
  return { name: declared?.[1] || 'npm', version: declared?.[2], lock: null };
}

// The file actions/setup-node reads the repository's Node.js version from, as it looks: .nvmrc, .node-version, then
// package.json's volta.node, devEngines.runtime or engines.node; without one, the current LTS.
async function nodeVersion(root: string, manifest: PackageManifest | undefined): Promise<Record<string, string>> {
  for (const file of ['.nvmrc', '.node-version']) if (await safeFile(root, file, { content: false })) return { 'node-version-file': file };
  const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const runtimes = [record(manifest?.devEngines)?.runtime].flat().map(record).filter(runtime => runtime?.name === 'node');
  const named = [record(manifest?.volta)?.node, ...runtimes.map(runtime => runtime?.version), record(manifest?.engines)?.node].some(value => typeof value === 'string' && value.trim());
  return named ? { 'node-version-file': 'package.json' } : { 'node-version': '24' };
}

function starterWorkflow(manager: PackageManager, services: ScanService[], workspace: boolean, node: Record<string, string>) {
  const steps: WorkflowStep[] = [{ uses: 'actions/checkout@v7', with: { 'persist-credentials': false } }, { uses: 'actions/setup-node@v7', with: node }];
  if (manager.name === 'pnpm') steps.push({ uses: 'pnpm/action-setup@v6', with: { version: manager.version || '10' } });
  if (manager.name === 'yarn') steps.push({ name: 'Enable package manager', run: 'corepack enable' });
  if (manager.name === 'bun') steps.push({ uses: 'oven-sh/setup-bun@v2', with: { 'bun-version': manager.version || 'latest' } });
  const install = manager.name === 'npm'
    ? (manager.lock ? 'npm ci --ignore-scripts' : 'npm install --ignore-scripts')
    : manager.name === 'yarn'
      ? `yarn install${manager.lock ? (Number(manager.version?.split('.')[0] || 1) >= 2 ? ' --immutable' : ' --frozen-lockfile') : ''}`
      : `${manager.name} install${manager.lock ? ' --frozen-lockfile' : ''} --ignore-scripts`;
  steps.push({ name: 'Install dependencies (review lifecycle needs)', run: install, ...(manager.name === 'yarn' ? { env: { YARN_ENABLE_SCRIPTS: 'false' }, ...(!manager.version || Number(manager.version.split('.')[0]) < 2 ? { run: `${install} --ignore-scripts` } : {}) } : {}) });
  if (manager.name === 'pnpm' && workspace && services.some(s => s.commands.build)) {
    steps.push({ name: 'Build workspace packages', run: 'pnpm -r --if-present run build' });
  }
  for (const service of services) {
    for (const script of ['typecheck', 'lint', 'build', 'test']) {
      if (!service.commands[script] || (script === 'build' && manager.name === 'pnpm' && workspace && service.path !== '.')) continue;
      steps.push({ name: `${script}: ${service.name}`, ...(service.path !== '.' ? { 'working-directory': service.path } : {}), run: `${manager.name} run ${script}` });
    }
  }
  return '# Proposal only. Review scripts, lifecycle requirements and environment needs before enabling.\n' + stringify({
    name: 'Perpetual validation', on: { pull_request: {}, workflow_dispatch: {} },
    permissions: { contents: 'read' },
    concurrency: { group: 'perpetual-${{ github.ref }}', 'cancel-in-progress': true },
    jobs: { validate: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 15, steps } },
  });
}

export async function scanRepository(repositoryPath: unknown): Promise<Scan> {
  if (typeof repositoryPath !== 'string' || !repositoryPath.trim()) throw new Error('A repository directory is required.');
  const root = path.resolve(repositoryPath);
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) throw new Error('Repository path must not be a symlink.');
  if (!stat.isDirectory()) throw new Error('Repository path must be a directory.');
  const warnings = ['Repository evidence only: cloud accounts, current deployment state and business behavior have not been verified.'];
  const nodes: ScanNode[] = [], edges: ScanEdge[] = [], services: ScanService[] = [], workflows: ScanWorkflow[] = [], packages: { file: string; raw: string; data: PackageManifest }[] = [];
  const node = (n: ScanNode) => { if (!nodes.some(x => x.id === n.id)) nodes.push(n); };
  const edge = (source: string, target: string, label: string, confidence: Confidence = 'configured') => edges.push({ source, target, label, confidence });
  const found = await manifests(root);
  for (const file of found.packages) {
    const raw = await safeFile(root, file);
    if (!raw) continue;
    try {
      const data: unknown = JSON.parse(raw);
      if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
      packages.push({ file, raw, data: data as PackageManifest });
    } catch { warnings.push(`Could not parse ${file}; other evidence is still shown.`); }
  }
  const rootPackage = packages.find(p => p.file === 'package.json');
  const manager = await packageManager(root, rootPackage?.data);
  const workspaceRaw = await safeFile(root, 'pnpm-workspace.yaml');
  const workspace = Boolean(rootPackage?.data.workspaces || workspaceRaw);
  let workspacePatterns: unknown = rootPackage?.data.workspaces?.packages || rootPackage?.data.workspaces;
  if (workspaceRaw) {
    try { workspacePatterns = parse(workspaceRaw, { maxAliasCount: 20 })?.packages; }
    catch { warnings.push('Could not parse pnpm-workspace.yaml; confirm workspace membership before generating CI.'); }
  }
  const knownWorkspace = Array.isArray(workspacePatterns) && workspacePatterns.every(p => typeof p === 'string' && /^!?[\w@./*-]+$/.test(p));
  const [branch, sha, remote] = await Promise.all([
    gitValue(root, ['symbolic-ref', '--short', 'HEAD']), gitValue(root, ['rev-parse', '--verify', 'HEAD']), gitValue(root, ['remote', 'get-url', 'origin']),
  ]);
  const repo: ScanRepo = { name: clean(rootPackage?.data.name || path.basename(root)), path: root, branch: clean(branch) || null, sha, remote: safeRemote(remote) };
  node({ id: 'repository', label: repo.name, kind: 'repository', provider: parseGitHubRemote(repo.remote) ? 'GitHub' : 'Git', status: 'configured', detail: 'Local repository configuration; no cloud connection implied.', evidence: [evidence(rootPackage ? 'package.json' : '.', rootPackage ? 'Repository package manifest.' : 'Selected local directory.')] });

  for (const pkg of packages) {
    const deps = { ...pkg.data.dependencies, ...pkg.data.devDependencies };
    if (pkg === rootPackage && workspace && !Object.keys(deps).some(d => ['next', 'hono', 'express', 'react', 'fastify', 'vite'].includes(d))) continue;
    const servicePath = slash(path.dirname(pkg.file));
    const service: ScanService = {
      id: `service:${id(servicePath)}`, name: clean(pkg.data.name || servicePath), path: servicePath,
      framework: framework(deps), provider: null,
      commands: Object.fromEntries(SCRIPT_NAMES.filter(name => typeof pkg.data.scripts?.[name] === 'string').map(name => [name, `${String(pkg.data.packageManager || '').match(/^(npm|pnpm|yarn|bun)@/)?.[1] || manager.name} run ${name}`])),
    };
    services.push(service);
    node({ id: service.id, label: service.name, kind: service.framework === 'Node.js' ? 'package' : 'service', provider: null, status: 'configured', detail: `${service.framework} · ${servicePath}`, evidence: [evidence(pkg.file, 'Framework and script names detected from package manifest.', 1)] });
    edge('repository', service.id, 'contains');
    const integrations: [string, boolean][] = [
      ['LangGraph', Object.keys(deps).some(k => k.startsWith('@langchain/langgraph'))],
      ['Composio', Object.keys(deps).some(k => /composio/i.test(k))],
      ['Supabase', Object.keys(deps).some(k => k.startsWith('@supabase/'))],
      ['Trigger.dev', Boolean(deps['@trigger.dev/sdk'])],
    ];
    for (const [label, present] of integrations) {
      if (!present) continue;
      const depId = `integration:${id(label)}`;
      node({ id: depId, label, kind: label === 'LangGraph' ? 'runtime' : 'integration', provider: label, status: 'inferred', detail: 'Dependency declared; runtime configuration and account access are unverified.', evidence: [evidence(pkg.file, `${label} dependency declared.`)] });
      edge(service.id, depId, 'declares dependency', 'configured');
    }
  }
  for (const pkg of packages) {
    const source = services.find(s => s.path === slash(path.dirname(pkg.file)));
    if (!source) continue;
    for (const [name, version] of Object.entries(pkg.data.dependencies || {})) {
      const target = services.find(s => s.name === name);
      if (target && String(version).startsWith('workspace:')) edge(source.id, target.id, 'workspace dependency');
    }
  }

  let workflowFiles: string[] = [];
  const top = await repositoryTop(root), workflowDir = path.join(top, '.github/workflows');
  try {
    if (!(await lstat(path.join(top, '.github'))).isSymbolicLink() && !(await lstat(workflowDir)).isSymbolicLink()) {
      workflowFiles = (await readdir(workflowDir, { withFileTypes: true })).filter(f => f.isFile() && /\.ya?ml$/.test(f.name)).map(f => `.github/workflows/${f.name}`).sort().slice(0, 40);
    }
  } catch { /* Workflows are optional. */ }
  const vercelEvidence: Evidence[] = [];
  const vercelConfigurations: { file: string; location: string }[] = [];
  for (const file of workflowFiles) {
    const raw = await safeFile(top, file);
    if (!raw) continue;
    let data: WorkflowYaml;
    try { const parsed: unknown = parse(raw, { maxAliasCount: 20 }); if (!parsed || typeof parsed !== 'object') throw new Error(); data = parsed; }
    catch { warnings.push(`Could not parse ${file}; review the existing workflow instead of replacing it.`); continue; }
    const triggers = typeof data.on === 'string' ? [data.on] : Array.isArray(data.on) ? data.on : Object.keys(data.on || {});
    const jobs = Object.entries(data.jobs || {}).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => ({ id: clean(key), name: clean(value.name || key), needs: (Array.isArray(value.needs) ? value.needs : value.needs ? [value.needs] : []).map(clean) }));
    const workflow: ScanWorkflow = { file, name: clean(data.name || path.basename(file)), triggers: triggers.map(clean), jobs };
    workflows.push(workflow);
    const workflowId = `workflow:${id(file)}`;
    node({ id: workflowId, label: workflow.name, kind: 'workflow', provider: 'GitHub', status: 'configured', detail: `Triggers: ${workflow.triggers.join(', ') || 'not detected'} · execution status unknown.`, evidence: [evidence(file, 'Existing GitHub Actions workflow.', 1)] });
    edge('repository', workflowId, 'existing automation');
    for (const job of jobs) {
      const jobId = `${workflowId}:${id(job.id)}`;
      node({ id: jobId, label: job.name, kind: 'job', provider: 'GitHub', status: 'configured', detail: 'Declared job; no run result has been fetched.', evidence: [evidence(file, `Job ${job.id}.`, lineOf(raw, `${job.id}:`))] });
      edge(workflowId, jobId, 'runs');
      for (const dependency of job.needs) if (jobs.some(j => j.id === dependency)) edge(`${workflowId}:${id(dependency)}`, jobId, 'needs');
    }
    // A comment, an @vercel/ package such as @vercel/ncc or a vercel-labs/ tool mentions Vercel without deploying to it.
    const vercelLine = raw.split('\n').findIndex(line => /vercel/i.test(line.replace(/(?:^|\s)#.*/, '').replace(/@vercel\/[\w.-]*|vercel-labs\/[\w.-]*/gi, '')));
    if (vercelLine >= 0) appendEvidence(vercelEvidence, evidence(file, 'Vercel-related automation found; provider connection is not verified.', vercelLine + 1));
  }

  for (const location of new Set(['.', ...services.map(s => s.path), ...found.deployments])) {
    const prefix = location === '.' ? '' : `${location}/`;
    const vercelFile = `${prefix}vercel.json`;
    if (await safeFile(root, vercelFile, { content: false })) vercelConfigurations.push({ file: vercelFile, location });
    for (const filename of ['railway.toml', 'railway.json']) {
      const file = `${prefix}${filename}`;
      const raw = await safeFile(root, file);
      if (!raw) continue;
      let config: RailwayConfig = {};
      if (filename.endsWith('.json')) {
        // A JSON null or a non-text Dockerfile path is not configuration evidence, and must not abort the whole scan.
        try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object') config = parsed; } catch { warnings.push(`Could not parse ${file}.`); }
      }
      const configuredDockerfile = config.build?.dockerfilePath;
      const dockerfile = (typeof configuredDockerfile === 'string' ? configuredDockerfile : '') || raw.match(/^\s*dockerfilePath\s*=\s*["']([^"']+)["']/m)?.[1];
      const healthPath = config.deploy?.healthcheckPath || raw.match(/^\s*healthcheckPath\s*=\s*["']([^"']+)["']/m)?.[1];
      const targetPath = dockerfile ? slash(path.dirname(path.posix.join(prefix, dockerfile))) : location;
      const service = services.find(s => s.path === targetPath) || services.find(s => s.path === location);
      const railwayId = `railway:${id(file)}`;
      const sources = [evidence(file, 'Railway deployment configuration; cloud settings are not verified.', 1)];
      if (dockerfile && await safeFile(root, path.posix.join(prefix, dockerfile), { content: false })) sources.push(evidence(path.posix.join(prefix, dockerfile), 'Configured Dockerfile exists.'));
      node({ id: railwayId, label: service ? `${service.name} deployment` : location === '.' ? 'Railway deployment' : `${clean(location)} deployment`, kind: 'deployment', provider: 'Railway', status: 'configured', detail: `Deployment configuration detected${dockerfile ? '; Docker build context must be verified' : ''}.`, evidence: sources });
      edge(service?.id || 'repository', railwayId, 'deployment configuration');
      if (service) { service.provider = 'Railway'; nodes.find(n => n.id === service.id)!.provider = 'Railway'; }
      if (healthPath) warnings.push(`${file}: a configured health endpoint is not proof of verified business behavior; inspect the response and test the intended integration separately.`);
    }
  }

  const frontend = services.filter(s => ['Next.js', 'Nuxt', 'Vite', 'React'].includes(s.framework));
  // Standard configuration keeps its own identity; workflow clues never name a project.
  for (const config of vercelConfigurations) {
    const targetId = `vercel:config:${id(config.file)}`;
    const service = services.find(item => item.path === config.location);
    node({ id: targetId, label: service ? `${service.name} deployment` : config.location === '.' ? 'Vercel deployment' : `${clean(config.location)} deployment`, kind: 'deployment', provider: 'Vercel', status: 'configured', projectName: null, configFile: config.file, detail: 'Vercel project configuration; account authorization and deployed commit are unverified.', evidence: [evidence(config.file, 'Vercel project configuration exists.')] });
    edge(service?.id || 'repository', targetId, 'deployment configuration');
    // Preserve another provider's explicit association; per-target edges carry
    // multiple deployment relationships without overwriting the service identity.
    if (service && !service.provider) {
      service.provider = 'Vercel';
      const serviceNode = nodes.find(item => item.id === service.id);
      if (serviceNode && !serviceNode.provider) serviceNode.provider = 'Vercel';
    }
  }
  if (vercelEvidence.length) {
    const targetId = 'vercel:Vercel';
    node({ id: targetId, label: 'Vercel deployment', kind: 'deployment', provider: 'Vercel', status: 'configured', projectName: null, configFile: null, detail: 'Vercel-related workflow configuration; the deployment target and cloud connection are unverified.', evidence: vercelEvidence });
    edge('repository', targetId, 'provider configuration');
    for (const source of vercelEvidence) edge(`workflow:${id(source.file)}`, targetId, 'provider configuration');
  }
  const backend = services.filter(s => ['Hono', 'Express', 'Fastify'].includes(s.framework));
  for (const web of frontend) for (const api of backend) edge(web.id, api.id, 'Likely API dependency; verify URL wiring', 'inferred');
  if (frontend.length && backend.length) warnings.push('Cross-service API links are inferred from framework roles, not confirmed environment variables. Verify each preview frontend points to its intended backend.');
  if (!services.length) warnings.push('No supported package manifests found within four directory levels. No build commands were guessed.');
  const existing = workflowFiles.length > 0;
  const knownInstallTopology = Boolean(rootPackage && (workspace ? knownWorkspace : services.every(s => s.path === '.')));
  if (!existing && !knownInstallTopology && services.length) warnings.push('Confirm the install topology and workspace membership before generating CI for nested packages.');
  const validationServices = workspace && knownWorkspace ? services.filter(s => workspaceIncludes(s.path, workspacePatterns as string[])) : services;
  const canGenerate = !existing && knownInstallTopology && validationServices.some(s => Object.keys(s.commands).some(k => ['build', 'test', 'lint', 'typecheck'].includes(k)));
  const plan = {
    summary: existing ? 'Reuse and inspect the existing GitHub Actions workflows; connect provider accounts to verify live releases.' : canGenerate ? 'Review a validation-only starter generated from detected package scripts.' : 'Confirm the project build and test commands before proposing a workflow.',
    steps: [existing ? 'Keep existing workflow files and inspect their latest run at the selected commit.' : 'Review detected services and proposed checks before adding a workflow.', 'Connect GitHub and each deployment provider separately.', 'Match provider deployments to the selected commit before checking preview routes.', 'Run a bounded business check against a dedicated test environment.'],
    ...(canGenerate ? { workflow: starterWorkflow(manager, validationServices, workspace, await nodeVersion(root, rootPackage?.data)) } : {}),
  };
  return withDeliveryGraph({ discoveryVersion: DISCOVERY_VERSION, repo, nodes, edges, services, workflows, warnings: [...new Set(warnings)], plan, scannedAt: new Date().toISOString() });
}

export function createPreviewPlan(scan: Pick<Scan, 'nodes' | 'workflows' | 'plan'>, environment: unknown = 'alpha'): PreviewPlan {
  if (typeof environment !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(environment)) throw new Error('Use a lowercase environment name with letters, numbers or hyphens.');
  const steps = [
    `Propose ${environment} from one selected commit; no environment has been created.`,
    scan.workflows?.length ? 'Reuse existing CI and require its applicable checks for that commit.' : 'Review the proposed validation workflow before enabling it.',
    'Connect and authorize GitHub, Vercel and Railway independently where applicable.',
  ];
  if (scan.nodes?.some(n => n.provider === 'Railway')) steps.push(`Provision a dedicated Railway ${environment} environment, with explicit test credentials and a database seed plan; confirm resource cost and expiry.`);
  if (scan.nodes?.some(n => n.provider === 'Vercel')) steps.push(`Create or select a Vercel preview for ${environment}, wire its API URL to the intended backend, and verify the commit rather than trusting a stable alias.`);
  steps.push('Verify reachability and one agreed business interaction; a successful build or HTTP 200 alone is insufficient.', 'Show the result and cleanup deadline for review. Production promotion is a separate action.');
  return { title: `Proposed ${environment} environment`, steps, ...(scan.plan?.workflow ? { workflow: scan.plan.workflow } : {}) };
}
