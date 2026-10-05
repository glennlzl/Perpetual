import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { redact } from './redaction.ts';
import { SECRET_PATH, readRepositoryFile } from './repository-files.ts';
import { repositoryTop, type Scan } from './scanner.ts';
import type { ConfigField, ConfigSection, ServiceConfiguration } from '../contract/service-config.ts';
import type { ActionJob, ActionWorkflow, GitHubActionsReply } from '../contract/github.ts';
export type { ConfigField, ConfigSection, ConfigFile, ServiceConfiguration } from '../contract/service-config.ts';
export type { ActionStep, ActionJob, ActionWorkflow } from '../contract/github.ts';

type Scalar = string | number | boolean;

// Parsed YAML and JSON are untrusted: a record's fields stay unknown until each is checked.
type Fields = { readonly [key: string]: unknown };
const isRecord = (value: unknown): value is Fields => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** One field of a parsed value, as optional chaining reads it; a value without fields has none. */
const at = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? (value as Fields)[key] : undefined;

const MAX_BYTES = 512 * 1024;
const scalar = (value: unknown): value is Scalar => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown) => redact(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2048);

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !/[\\\0]/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..') && !SECRET_PATH.test(value);
}

async function readConfig(root: string, relative: string) {
  if (!safePath(relative)) return null;
  return readRepositoryFile(root, relative, { limit: MAX_BYTES });
}

function field(key: string, label: string, value: unknown): ConfigField | null {
  if (Array.isArray(value)) {
    const values = value.filter(scalar).slice(0, 100).map(text);
    return values.length ? { key, label, type: 'list', value: values, readOnly: true } : null;
  }
  if (!scalar(value) || value === '') return null;
  return { key, label, type: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text', value: typeof value === 'string' ? text(value) : value, readOnly: true };
}

function addSection(sections: ConfigSection[], id: string, title: unknown, fields: (ConfigField | null)[]) {
  const actual = fields.filter((item): item is ConfigField => Boolean(item));
  if (actual.length) sections.push({ id, title: text(title), fields: actual });
}

export async function readServiceConfig(scan: Pick<Scan, 'repo' | 'nodes' | 'services'>, nodeId: string | null): Promise<ServiceConfiguration> {
  const node = scan?.nodes?.find(item => item.id === nodeId);
  if (!node) throw new Error('This service is no longer in the pipeline.');
  const root = scan?.repo?.path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Repository configuration is unavailable.');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Repository configuration is unavailable.');
  const paths = [...new Set((node.evidence || []).map(item => item.file).filter(safePath))].slice(0, 40);
  const result: ServiceConfiguration = { nodeId, provider: node.provider || null, files: paths.map(file => ({ path: file })), sections: [] };

  // These drawers show file links only; unreadable contents must not hide the path a person needs to fix.
  if (node.kind === 'workflow' || node.kind === 'job' || node.provider === 'Railway') return result;
  if (node.provider === 'Vercel') {
    let name = typeof node.projectName === 'string' ? node.projectName : '';
    if (!Object.hasOwn(node, 'projectName')) {
      try { if (node.id.startsWith('vercel:')) name = decodeURIComponent(node.id.slice(7)); } catch { /* Legacy node has no project association. */ }
    }
    for (const file of paths) {
      if (!/(?:^|\/)vercel\.json$/.test(file)) continue;
      const raw = await readConfig(root, file);
      if (raw === null) continue;
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new Error('Could not read this Vercel configuration.'); }
      // A scanned config path is authoritative; legacy names need an explicit match.
      if (node.configFile !== file && name && name !== 'Vercel' && at(data, 'name') !== name) continue;
      addSection(result.sections, `vercel:${file}`, 'Build', [
        field('framework', 'Framework', at(data, 'framework')), field('buildCommand', 'Build command', at(data, 'buildCommand')),
        field('installCommand', 'Install command', at(data, 'installCommand')), field('outputDirectory', 'Output directory', at(data, 'outputDirectory')),
        field('devCommand', 'Development command', at(data, 'devCommand')),
      ]);
    }
  }

  if (!result.sections.length) {
    const service = scan.services?.find(item => item.id === nodeId);
    if (service) {
      addSection(result.sections, 'service', 'Service', [field('path', 'Root directory', service.path), field('framework', 'Framework', service.framework)]);
      addSection(result.sections, 'commands', 'Commands', Object.entries(service.commands || {}).map(([key, value]) => field(key, key, value)));
    }
  }
  return result;
}

function actionName(value: unknown, fallback = 'Action') {
  if (typeof value !== 'string') return fallback;
  // Action references are identifiers, never shell commands or arbitrary URLs.
  const isAction = /^[\w.-]+\/[\w./-]+@[\w./-]+$/.test(value);
  const isLocal = /^\.\/[\w./-]+$/.test(value) && !value.split('/').includes('..');
  const isImage = /^docker:\/\/[\w./:-]+(?:@sha256:[a-fA-F0-9]+)?$/.test(value);
  return isAction || isLocal || isImage ? text(value) : fallback;
}

export async function readGitHubActions(scan: Pick<Scan, 'repo' | 'workflows'>): Promise<GitHubActionsReply> {
  const root = scan?.repo?.path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Repository configuration is unavailable.');
  let rootStat;
  try { rootStat = await lstat(root); } catch { throw new Error('Repository configuration is unavailable.'); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Repository configuration is unavailable.');
  const workflows: ActionWorkflow[] = [];
  const seen = new Set<string>();
  // Workflow paths are relative to the repository's top level, where GitHub reads them, even for a scanned subdirectory.
  let top: string | undefined;
  for (const known of Array.isArray(scan.workflows) ? scan.workflows : []) {
    if (!known || typeof known.file !== 'string' || seen.has(known.file)) continue;
    seen.add(known.file);
    const workflow: ActionWorkflow = {
      file: known.file,
      name: text(typeof known.name === 'string' && known.name.trim() ? known.name : path.posix.basename(known.file)),
      jobs: [],
    };
    workflows.push(workflow);
    if (!safePath(known.file) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(known.file)) {
      workflow.error = 'Workflow file is unavailable.';
      continue;
    }
    const raw = await readConfig(top ??= await repositoryTop(root), known.file);
    if (raw === null) {
      workflow.error = 'Could not read this workflow file.';
      continue;
    }
    let data: unknown;
    try { data = parse(raw, { maxAliasCount: 20 }); }
    catch {
      workflow.error = 'Could not parse this workflow file.';
      continue;
    }
    if (!isRecord(data) || !isRecord(data.jobs)) {
      workflow.error = 'Workflow jobs are unavailable.';
      continue;
    }
    if (typeof data.name === 'string' && data.name.trim()) workflow.name = text(data.name);
    for (const [id, config] of Object.entries(data.jobs)) {
      if (!isRecord(config)) {
        workflow.error = 'Some jobs could not be read.';
        continue;
      }
      const job: ActionJob = { id: text(id), name: text(typeof config.name === 'string' && config.name.trim() ? config.name : id), steps: [] };
      workflow.jobs.push(job);
      if (Array.isArray(config.steps)) {
        for (const [index, step] of (config.steps as unknown[]).entries()) {
          if (!isRecord(step)) {
            workflow.error = 'Some steps could not be read.';
            continue;
          }
          const name = typeof step.name === 'string' && step.name.trim()
            ? text(step.name)
            : typeof step.uses === 'string' ? actionName(step.uses)
              : typeof step.run === 'string' ? 'Run command' : 'Step';
          job.steps.push({ id: typeof step.id === 'string' && step.id.trim() ? text(step.id) : `step-${index + 1}`, name });
        }
      } else if (typeof config.uses === 'string') {
        job.steps.push({ id: 'reusable-workflow', name: actionName(config.uses, 'Reusable workflow') });
      } else if (config.steps !== undefined) {
        workflow.error = 'Some steps could not be read.';
      }
    }
  }
  return { workflows };
}
