import { randomUUID } from 'node:crypto';
import { isBranchName } from './github-cli.ts';
import type { Pipeline, Stage, Transition } from '../contract/pipeline.ts';
export type { Pipeline, Stage, StageKind, Transition } from '../contract/pipeline.ts';
/** A definition that passed validatePipeline; saved transitions are checked when normalized. */
type PipelineDefinition = Omit<Pipeline, 'transitions'> & { transitions?: unknown };

const FIXED = Object.freeze([
  { id: 'source', name: 'Source', kind: 'source' },
  { id: 'build', name: 'Build', kind: 'build' },
  { id: 'production', name: 'Production', kind: 'production' },
]);
const ACTIONS = new Set<unknown>(['add-stage', 'rename-stage', 'remove-stage', 'toggle-stage', 'set-transition', 'set-github-workflow', 'set-production-branch']);
const INPUT_FIELDS = new Set(['repoPath', 'pipelineId', 'action', 'stageId', 'afterStageId', 'name', 'kind', 'sourceStageId', 'targetStageId', 'blocked', 'reason', 'workflowFile', 'branch']);

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkedName(value: unknown, maximum: number, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} name must be text.`);
  const name = value.trim();
  if (!name || name.length > maximum || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${label} name must contain 1–${maximum} characters.`);
  return name;
}
const nameKey = (value: string) => value.normalize('NFKC').toLowerCase();

// Build was the fixed Build & Deploy stage, id and kind build-deploy, until deployment targets moved to Production.
// A definition saved before then reads as Build, its transitions too; every other definition is returned unchanged.
const LEGACY_BUILD = 'build-deploy';
function migrated(pipeline: unknown): unknown {
  if (!record(pipeline) || !Array.isArray(pipeline.stages) || !pipeline.stages.some(stage => record(stage) && stage.id === LEGACY_BUILD)) return pipeline;
  const renamed = (id: unknown) => id === LEGACY_BUILD ? 'build' : id;
  return {
    ...pipeline,
    stages: pipeline.stages.map(stage => record(stage) && stage.id === LEGACY_BUILD ? { ...stage, id: 'build', name: 'Build', kind: 'build' } : stage),
    ...(Array.isArray(pipeline.transitions) ? { transitions: pipeline.transitions.map(edge => record(edge) ? { ...edge, source: renamed(edge.source), target: renamed(edge.target) } : edge) } : {}),
  };
}

function checkedWorkflow(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || !/^\.github\/workflows\/[^/\\]+\.ya?ml$/.test(value)) {
    throw new Error('Choose a GitHub Actions workflow file.');
  }
  return value;
}

export function defaultPipeline(repoPath: unknown): Pipeline {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.length > 4096 || repoPath.includes('\0')) throw new Error('A repository path is required.');
  return normalizedPipeline({ repoPath, stages: FIXED.map(stage => ({ ...stage, collapsed: false })) });
}

function validatePipeline(pipeline: unknown): asserts pipeline is PipelineDefinition {
  if (!record(pipeline) || typeof pipeline.repoPath !== 'string' || !Array.isArray(pipeline.stages) || pipeline.stages.length < 3 || pipeline.stages.length > 12) throw new Error('Invalid pipeline definition.');
  if (pipeline.id !== undefined && (typeof pipeline.id !== 'string' || !/^pipeline:[a-f0-9-]{36}$/.test(pipeline.id))) throw new Error('Invalid pipeline identity.');
  if (pipeline.productionBranch != null && !isBranchName(pipeline.productionBranch)) throw new Error('Invalid production branch.');
  if (pipeline.stages[0]?.id !== 'source' || pipeline.stages.at(-1)?.id !== 'production') throw new Error('Source and Production must remain the first and last fixed stages.');
  const ids = new Set(), names = new Set();
  for (const stage of pipeline.stages) {
    if (!record(stage) || typeof stage.id !== 'string' || !stage.id || ids.has(stage.id)) throw new Error('Stage IDs must be unique.');
    ids.add(stage.id);
    const name = checkedName(stage.name, 40, 'Stage');
    if (names.has(nameKey(name))) throw new Error('Stage names must be unique.');
    names.add(nameKey(name));
    const fixed = FIXED.find(item => item.id === stage.id);
    if (fixed ? stage.name !== fixed.name || stage.kind !== fixed.kind : stage.kind !== 'sandbox') throw new Error('Fixed stages cannot be changed; custom stages must be sandboxes.');
    if (typeof stage.collapsed !== 'boolean') throw new Error('Invalid pipeline definition.');
    if (Object.hasOwn(stage, 'githubWorkflow')) {
      if (stage.kind !== 'build') throw new Error('GitHub Actions can only be selected for Build.');
      checkedWorkflow(stage.githubWorkflow);
    }
  }
  if (!FIXED.every(fixed => ids.has(fixed.id))) throw new Error('All fixed pipeline stages are required.');
}

function checkedReason(value: unknown) {
  if (typeof value !== 'string') throw new Error('Transition reason must be text.');
  const reason = value.trim();
  if (reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) throw new Error('Transition reason must contain at most 200 characters.');
  return reason;
}

function transition(source: string, target: string, saved: { blocked?: unknown; reason?: unknown } = {}): Transition {
  if (saved.blocked !== undefined && typeof saved.blocked !== 'boolean') throw new Error('Transition blocked must be a boolean.');
  return { id: `${source}:${target}`, source, target, blocked: saved.blocked ?? false, reason: checkedReason(saved.reason ?? '') };
}

/** Fill legacy transition defaults and discard orphan edges without mutating saved definitions. */
export function normalizedPipeline(definition: unknown): Pipeline {
  const pipeline = migrated(definition);
  validatePipeline(pipeline);
  const next: PipelineDefinition = structuredClone(pipeline);
  const saved = next.transitions ?? [];
  if (!Array.isArray(saved)) throw new Error('Invalid pipeline transitions.');
  const transitions = next.stages.slice(0, -1).map((stage, index) => {
    const target = next.stages[index + 1].id;
    const matches = saved.filter(edge => record(edge) && edge.source === stage.id && edge.target === target);
    if (matches.length > 1) throw new Error('Pipeline transitions must be unique.');
    return transition(stage.id, target, matches[0]);
  });
  return { ...next, transitions };
}

/** Edit definitions only. This module never provisions, executes, or schedules them. */
export function applyPipelineAction(definition: unknown, input: unknown): Pipeline {
  const pipeline = migrated(definition);
  validatePipeline(pipeline);
  if (!record(input) || !ACTIONS.has(input.action)) throw new Error('Unsupported pipeline action.');
  for (const field of Object.keys(input)) if (!INPUT_FIELDS.has(field)) throw new Error(`Unsupported pipeline action field: ${field}`);
  if (input.repoPath !== undefined && input.repoPath !== pipeline.repoPath) throw new Error('Pipeline action targets a different repository.');
  if (input.pipelineId !== undefined && input.pipelineId !== pipeline.id) throw new Error('Pipeline action targets a different pipeline.');
  const next = normalizedPipeline(pipeline);
  if (input.action === 'set-production-branch') {
    if (!isBranchName(input.branch)) throw new Error('Choose a valid production branch from the repository.');
    next.productionBranch = input.branch;
    return next;
  }
  if (input.action === 'set-transition') {
    if (typeof input.blocked !== 'boolean') throw new Error('Transition blocked must be a boolean.');
    const edge = next.transitions.find(item => item.source === input.sourceStageId && item.target === input.targetStageId);
    if (!edge) throw new Error('Choose a transition between adjacent stages.');
    edge.blocked = input.blocked;
    if (input.reason !== undefined) edge.reason = checkedReason(input.reason);
    return next;
  }
  if (input.action === 'add-stage') {
    if (next.stages.length >= 12) throw new Error('A pipeline supports at most 12 stages.');
    const name = checkedName(input.name, 40, 'Stage');
    if (next.stages.some(stage => nameKey(stage.name) === nameKey(name))) throw new Error('Stage names must be unique.');
    const afterStageId = input.afterStageId ?? input.stageId ?? 'build';
    const position = next.stages.findIndex(stage => stage.id === afterStageId);
    if (position < 0) throw new Error('Choose an existing stage as the insertion point.');
    if (afterStageId === 'source') throw new Error('A sandbox must follow Build or another sandbox.');
    if (position === next.stages.length - 1) throw new Error('A sandbox cannot be placed after Production.');
    if (input.kind !== undefined && input.kind !== 'sandbox') throw new Error('Custom stages must use the sandbox kind.');
    const target = next.stages[position + 1].id;
    const oldTransition = next.transitions.find(edge => edge.source === afterStageId && edge.target === target);
    const stage: Stage = { id: randomUUID(), name, kind: 'sandbox', collapsed: false };
    next.stages.splice(position + 1, 0, stage);
    // Keep the existing gate before its original target when splitting the connection.
    next.transitions.push(transition(stage.id, target, oldTransition));
    return normalizedPipeline(next);
  }
  const stage = next.stages.find(item => item.id === input.stageId);
  if (!stage) throw new Error('Stage not found.');
  if (input.action === 'set-github-workflow') {
    if (stage.kind !== 'build') throw new Error('GitHub Actions can only be selected for Build.');
    stage.githubWorkflow = checkedWorkflow(input.workflowFile);
  } else if (input.action === 'rename-stage') {
    if (stage.kind !== 'sandbox') throw new Error('Fixed stages cannot be renamed.');
    const name = checkedName(input.name, 40, 'Stage');
    if (next.stages.some(item => item.id !== stage.id && nameKey(item.name) === nameKey(name))) throw new Error('Stage names must be unique.');
    stage.name = name;
  } else if (input.action === 'remove-stage') {
    if (stage.kind !== 'sandbox') throw new Error('Fixed stages cannot be removed.');
    const position = next.stages.findIndex(item => item.id === stage.id);
    const source = next.stages[position - 1].id;
    const target = next.stages[position + 1].id;
    const blocked = next.transitions.filter(edge => (edge.source === source && edge.target === stage.id || edge.source === stage.id && edge.target === target) && edge.blocked);
    next.transitions.push(transition(source, target, {
      blocked: blocked.length > 0,
      reason: [...new Set(blocked.map(edge => edge.reason).filter(Boolean))].join('; ').slice(0, 200),
    }));
    next.stages = next.stages.filter(item => item.id !== stage.id);
  } else if (input.action === 'toggle-stage') {
    stage.collapsed = !stage.collapsed;
  }
  return normalizedPipeline(next);
}
