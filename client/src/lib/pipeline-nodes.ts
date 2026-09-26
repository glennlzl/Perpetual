import { stageActivity, type ActivitySnapshot } from './stage-activity.ts';
import { environmentBehind, repairHead, shallowEqual } from './pipeline-flow.ts';
import type { BuildStatus, BuildSummary, GitHubRuns } from './pipeline-github.ts';
import type { AutopilotView } from './pipeline-autopilot.ts';
import type { GateView } from './stage-gate.ts';
import type { SavedSource } from './source-selection.ts';
import type { BrowserView, Environment } from './test-workspace.ts';

export interface PipelineStage { id: string; name: string; kind: string; collapsed?: boolean }
export interface PipelineTransition { id: string; source: string; target: string; blocked?: boolean }
/** A source's pipeline: its stages in order and the transitions between them. */
export interface PipelineView { repoPath?: string; stages: PipelineStage[]; transitions: PipelineTransition[] }
/** A scan as stage cards read it. R is a delivery row the scan projects for Source, Build or Production. */
export interface NodeScan<R = unknown> { repo?: { path?: string; sha?: string | null } | null; scannedAt?: string; delivery?: { source?: readonly R[]; build?: readonly R[]; production?: readonly R[] } | null }

// One shared empty list: a fresh [] per recompute would give every sandbox card, and a
// Production card without deployment targets, new data on each unrelated poll.
const NO_SERVICES: readonly never[] = Object.freeze([]);

export function stageServices<R>(scan: NodeScan<R> | null | undefined, stage: Pick<PipelineStage, 'kind'>): readonly R[] {
  const delivery = scan?.delivery;
  const rows = stage.kind === 'source' ? delivery?.source : stage.kind === 'build' ? delivery?.build : stage.kind === 'production' ? delivery?.production : undefined;
  return rows?.length ? rows : NO_SERVICES;
}

// Where the scanned commit came from. It is a GitHub source only when the saved
// managed copy owns the scanned path; a GitHub remote alone is a local checkout.
export function sourceProvenance(scan: NodeScan | null | undefined, source: SavedSource | null = null) {
  const sha = typeof scan?.repo?.sha === 'string' ? scan.repo.sha : '';
  if (!sha) return { origin: '', revision: '' };
  return { origin: source?.scanPath && source.scanPath === scan?.repo?.path ? 'github' : 'local', revision: sha.slice(0, 7) };
}

export const STAGE_LIMIT = 12;

// The transition leaving a stage, as primitives. Its controls render inside the
// source card, so keyboard focus reaches them right after that stage's own
// controls. A stage is inserted only after Build or a sandbox.
export function outgoingTransition(stage: Pick<PipelineStage, 'id' | 'kind'>, pipeline: PipelineView | null | undefined) {
  const edge = pipeline?.transitions?.find(item => item.source === stage.id);
  const target = edge && pipeline?.stages?.find(item => item.id === edge.target);
  if (!target) return { next: '', nextName: '', nextBlocked: false, canInsert: false, atStageLimit: false };
  return {
    next: target.id, nextName: target.name, nextBlocked: Boolean(edge?.blocked),
    canInsert: ['build', 'sandbox'].includes(stage.kind), atStageLimit: pipeline!.stages.length >= STAGE_LIMIT,
  };
}

// Card data for one stage. Fields are primitives or records the workspace
// reuses across polls; only Build carries GitHub status. A Sandbox
// stage carries its journey gate and Production its readiness.
/** What a stage card's data is computed from. D is the canvas's dialog, R a scanned delivery row. */
export interface StageNodeContext<D = unknown, R = unknown> {
  scan?: NodeScan<R> | null; source?: SavedSource | null; pipeline?: PipelineView | null; sha?: string | null;
  latest?: Record<string, Environment | undefined>; snapshot?: ActivitySnapshot & { browserTests?: Record<string, Partial<BrowserView> | undefined> }; arrivals?: Record<string, string>;
  healthBeat?: (environment: Environment | undefined) => string; build?: BuildSummary | null; buildStatus?: BuildStatus | null; github?: GitHubRuns | null; gates?: GateView | null;
  /** Production's rows with the deployments GitHub records for the commit; absent, the scan's rows stand. */
  production?: readonly R[] | null;
  /** Autopilot as the controller reports it; every stage but Source carries its own entry. */
  autopilot?: AutopilotView | null;
  selection?: D | null; selectedStageId?: string | null; busyStages?: string[]; busy?: boolean;
  openDialog?: (dialog: D) => void; toggleStage?: (stageId: string) => void; addTest?: (stageId: string) => void; createSandbox?: (stageId: string) => void;
}
export function stageNodeData<D = unknown, R = unknown>(stage: PipelineStage, { scan, source = null, pipeline, sha = null, latest = {}, snapshot = {}, arrivals = {}, healthBeat = () => '', build = null, buildStatus = null, github = null, gates = null, production = null, autopilot = null, selection = null, selectedStageId = null, busyStages = [], busy = false, openDialog, toggleStage, addTest, createSandbox }: StageNodeContext<D, R>) {
  const environment = latest[stage.id], services = stage.kind === 'production' && production ? production : stageServices(scan, stage);
  return {
    stage, services, repoPath: scan?.repo?.path, scannedAt: scan?.scannedAt, sha,
    blocked: Boolean(pipeline?.transitions?.some(edge => edge.target === stage.id && edge.blocked)),
    ...outgoingTransition(stage, pipeline),
    busy, openDialog, toggleStage, addTest, selected: stage.id === selectedStageId, selection, environment, createSandbox,
    environmentBusy: busyStages.includes(stage.id), browserTests: snapshot.browserTests?.[stage.id],
    activity: stageActivity(stage, snapshot), behind: environmentBehind(environment, sha) ? `${environment?.sourceRevision?.slice(0, 7)} → ${sha?.slice(0, 7)}` : '', repairHead: repairHead(environment),
    arrival: arrivals[stage.id] || '', beat: stage.kind === 'sandbox' ? healthBeat(environment) : '',
    gate: stage.kind === 'sandbox' ? gates?.stages?.[stage.id] || null : stage.kind === 'production' ? gates?.production || null : null,
    ...(stage.kind === 'source' ? sourceProvenance(scan, source) : {}),
    // Whether a Sandbox stage gates commits before Production; its badge says so when none does.
    ...(stage.kind === 'production' ? { gated: Boolean(pipeline?.stages?.some(item => item.kind === 'sandbox')) } : {}),
    // Source is the repository connection; the other stages carry their Autopilot.
    ...(stage.kind !== 'source' ? { autopilot: autopilot?.stages?.[stage.id] || null } : {}),
    ...(stage.kind === 'build' ? { build, buildStatus, github } : {}),
  };
}

// Keeps a stage's previous data while every field is identical, so memoized
// cards skip polls that changed only other stages.
export function createStageDataCache() {
  const cache = new Map<string, unknown>();
  // A cached value is returned only while it is shallowly equal to next.
  return <T>(id: string, next: T): T => {
    const previous = cache.get(id), data = previous && shallowEqual(previous, next) ? previous as T : next;
    cache.set(id, data);
    return data;
  };
}

// What the canvas's live region says: only stages whose status text changed
// since the last observation. The first observation, and stages added or removed
// since, stay silent, so a poll that changed nothing announces nothing. A status
// not known yet (empty text) keeps the stage's last observation and says nothing.
export function statusChanges(seen: Map<string, string> | null | undefined, statuses: { id: string; name: string; text: string }[] = []) {
  const next = new Map(statuses.flatMap(item => { const text = item.text || seen?.get(item.id); return text ? [[item.id, text] as const] : []; }));
  const changed = seen ? statuses.filter(item => item.text && seen.has(item.id) && seen.get(item.id) !== item.text) : [];
  return { seen: next, message: changed.map(item => `${item.name}: ${item.text}`).join('. ') };
}
