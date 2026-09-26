import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, Handle, Position, BaseEdge, MarkerType, getStraightPath, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps, type Viewport } from '@xyflow/react';
import { Box, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleMinus, CirclePause, CircleX, ExternalLink, Eye, GitBranch, GitGraph, HeartPulse, LoaderCircle, Maximize, Moon, Pause, Pencil, Play, Plus, Settings2, Sun, Trash2, Workflow, X, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle } from '@/components/base-node';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import PipelineDialogs from './PipelineDialogs';
import PipelineLoading from './PipelineLoading';
import AppSettings, { type SettingsDraft } from './AppSettings';
import GitHubActionsCard from './GitHubActionsCard';
import BranchSwitcher from './BranchSwitcher';
import NewTestDialog from './NewTestDialog';
import type { TranscribeAudio } from '@/lib/use-description-voice';
import type { BrowserCase, BrowserRun } from '@/lib/browser-test-ui';
import { StepItem, StepList } from './StepList';
import { StageBeam } from './StageBeam.tsx';
import { AutopilotBadge, ChangeMark, ChangeRow } from './StageChanges';
import { api } from '@/lib/api';
import { INITIAL_PIPELINE_VIEWPORT, STAGE_MIN_WIDTH, alignTop, createSheetViewport, entryViewport, revealViewport, stageBoxes, stageGap, uncoverViewport } from '@/lib/pipeline-viewport.ts';
import { useRememberedOpen } from '@/lib/remembered-open';
import { createTestWorkspace } from '@/lib/test-workspace';
import { TestWorkspaceContext, useTestStage, useTestWorkspace } from '@/lib/use-test-workspace';
import { hasCaseDrafts, newTestDraftKey } from '@/lib/case-drafts';
import { MAX_CASES } from '@/lib/journey-config';
import { environmentWorking } from '@/lib/stage-activity.ts';
import { readyArrivals, sourceEnvironments, transitionFlow } from '@/lib/pipeline-flow.ts';
import { createGitHubRunsPoller, githubBuildStatus, githubBuildSummary, type GitHubRuns } from '@/lib/pipeline-github.ts';
import { DEPLOYMENT_MARK_LABELS, createGitHubDeploymentsPoller, deploymentMark, isRecordedDeployment, productionRows, type DeploymentGroupRow, type DeploymentMark, type GitHubDeployments, type RecordedDeployment } from '@/lib/pipeline-deployments.ts';
import { createHealthBeats, healthLabel, healthWarning } from '@/lib/pipeline-health.ts';
import { autopilotChanges, createAutopilotPoller, shareAutopilot, stageActive, type AutopilotView } from '@/lib/pipeline-autopilot.ts';
import { createStageDataCache, stageNodeData, statusChanges, type PipelineStage, type PipelineView } from '@/lib/pipeline-nodes.ts';
import { monochromeAsset, providerAsset } from '@/lib/provider-assets';
import StageJourneyList from './StageJourneyList';
import TwinServices from './TwinServices';
import { environmentStatusLabel, latestEnvironment } from './EnvironmentSettings';
import { GateActions, GateBadge, useStageGates } from './StageGate';
import { isStageGate, productionStatus } from '@/lib/stage-gate.ts';
import type { BrowserView, Environment, StageRemoval, WorkspaceSnapshot } from '@/lib/test-workspace';
import type { GitHubSource, SourceSelection } from './SourceSettings';

// The pipeline as GET /api/state reports it. Scans may predate the current discovery shape, so their fields are optional.
export type ScanRepo = { path: string; name?: string; sha?: string; branch?: string; remote?: string };
/** A discovered node: a repository, workflow, job or deployment target. */
export type ScanNode = { id: string; kind?: string; provider?: string; label?: string; projectName?: string; previewAlias?: string; deployBranches?: unknown };
/** A Production provider's group: its discovered targets and the deployments GitHub records for the commit. */
export type DeploymentGroupService = DeploymentGroupRow<ScanNode>;
/** A delivery row: Build's GitHub Actions runner, or a Production provider's deployment group or single target. */
export type DeliveryService = ScanNode | DeploymentGroupService;
export type Scan = { repo: ScanRepo; scannedAt?: string; nodes?: ScanNode[]; workflows?: { file?: unknown }[]; delivery?: { source?: DeliveryService[]; build?: DeliveryService[]; production?: DeliveryService[] } };
export type PipelineState = { scan: Scan | null; defaultRepo: string; pipeline?: PipelineView | null; source?: GitHubSource | null; environments?: Environment[]; stageRemovals?: StageRemoval[]; browserTests?: Record<string, Partial<BrowserView>>; providers?: unknown[]; autopilot?: AutopilotView | null };
/** The open sheet or dialog, and what it was opened for. */
export type PipelineDialog = {
  type: 'source' | 'service' | 'stage' | 'rename-stage' | 'remove-stage' | 'transition' | 'environment' | 'git-graph';
  stageId?: string; nodeId?: string; afterStageId?: string; sourceStageId?: string; targetStageId?: string;
  connect?: boolean; connectRequest?: number; tab?: string; runId?: string; watch?: boolean; caseId?: string; caseRequestKey?: number; error?: string;
};
export type OpenDialog = (next: PipelineDialog | null) => void;
export type PipelineAction =
  | { action: 'add-stage'; afterStageId: string; name: string }
  | { action: 'rename-stage'; stageId: string; name: string }
  | { action: 'set-transition'; sourceStageId?: string; targetStageId?: string; blocked: boolean };
export type PipelineActionResult = { pipeline: PipelineView };
export type SourceResult = { scan: Scan; source: GitHubSource; pipeline: PipelineView; environments?: Environment[] };
type Page = 'pipeline' | 'settings';
/** The dialog Settings was opened from, handed back on return to the Pipeline. */
type SettingsReturn = { dialog: PipelineDialog | null; newTest: string };
type Theme = 'light' | 'dark';
type CanvasFailure = { message: string; retry: (() => void) | null };
type Arrival = { stageId: string; key: string };
type PipelineCanvasProps = {
  scan: Scan | null; source?: GitHubSource | null; pipeline: PipelineView; busy: boolean; theme: Theme;
  toggleStage: (stageId: string) => void; addTest: (stageId: string) => void; openDialog: OpenDialog; createSandbox: (stageId: string) => void;
  error: CanvasFailure | null; onRetryError: () => void; onDismissError: () => void; selection: PipelineDialog | null; branchSwitcher: ReactNode;
  environments: WorkspaceSnapshot['environments']; environmentBusy: WorkspaceSnapshot['busyStages']; browserTests: WorkspaceSnapshot['browserTests']; stageRemovals: WorkspaceSnapshot['stageRemovals'];
  gates: ReturnType<typeof useStageGates>; autopilot: AutopilotView | null;
};
/** A stage card's data. The canvas renders a scanned source and supplies every card callback. */
type StageData = ReturnType<typeof stageNodeData<PipelineDialog, DeliveryService>> & { repoPath: string; openDialog: OpenDialog; toggleStage: (stageId: string) => void; addTest: (stageId: string) => void; createSandbox: (stageId: string) => void };
type StageFlowNode = Node<StageData, 'stage'>;
/** blocked, ready, unconfigured, idle, failed, working or passed; `hint` is the badge's tooltip. */
type StageStatusView = { kind: string; text: string; sha?: string; hint?: string };
const isDeploymentGroup = (service: DeliveryService): service is DeploymentGroupService => service.kind === 'deployment-group';

const NODE_TYPES = { stage: React.memo(StageNode) };
const EDGE_TYPES = { transition: TransitionEdge };
const FIT_VIEW_OPTIONS = { padding: 0.15, minZoom: 0.02, maxZoom: 1 };
const FLOW_OPTIONS = { hideAttribution: true };
const STAGE_GAP = stageGap(typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches));
// Edges run along this rail between the handles. A transition's controls sit on
// it, centered in the gap past the source card's 1px border.
const RAIL_TOP = 30;
const HANDLE_STYLE = { top: RAIL_TOP };
const TRANSITION_STYLE = { top: RAIL_TOP, left: `calc(100% + ${STAGE_GAP / 2 + 1}px)` };
const STAGE_STYLE: CSSProperties = { pointerEvents: 'all' };
const STAGE_ROLE = { 'aria-roledescription': 'stage' };
// Stages and transitions are not selectable, focusable or deletable, so React
// Flow's hidden keyboard instructions would describe controls that do not exist.
const ARIA_LABELS = { 'node.a11yDescription.default': '', 'node.a11yDescription.keyboardDisabled': '', 'edge.a11yDescription.default': '' };
// Confirmations are modal and leave the canvas where the viewer put it.
const MODAL_DIALOGS = new Set(['stage', 'rename-stage', 'remove-stage', 'transition']);
// Absent and idle states read quieter than present ones; blocked keeps its tint.
const STATUS_VARIANTS: Record<string, 'destructive' | 'outline'> = { failed: 'destructive', idle: 'outline', unconfigured: 'outline' };
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function ProviderMark({ provider, active = false }: { provider?: string; active?: boolean }) {
  const slug = providerAsset(provider) || 'service';
  return <img className="provider-logo" data-monochrome={monochromeAsset(slug)} data-active={active || undefined} src={`/assets/providers/${slug}.svg`} alt={provider || 'Service'} width={20} height={20} />;
}

function Hint({ text, children }: { text: ReactNode; children: ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

function AppSidebar({ theme, page, onNavigate }: { theme: Theme; page: Page; onNavigate: (page: Page) => void }) {
  const { state, isMobile, setOpen, setOpenMobile } = useSidebar();
  const compact = !isMobile && state === 'collapsed';
  const brandVariant = theme === 'dark' ? 'light' : 'dark';
  const closeNavigation = () => { setOpen(false); setOpenMobile(false); };
  const navigate = (page: Page) => { onNavigate(page); closeNavigation(); };

  return <Sidebar collapsible="icon">
    <SidebarHeader>
      <a href="#pipeline" aria-label="Perpetual" onClick={() => navigate('pipeline')} className={`flex h-12 items-center overflow-hidden ${compact ? 'justify-center' : 'px-2'}`}>
        <img src={`/assets/brand/perpetual-${compact ? 'mark-small' : 'lockup'}-${brandVariant}.svg`} alt="Perpetual" width={compact ? 24 : 180} className={compact ? 'h-6 w-6 shrink-0' : 'h-auto w-[180px] max-w-none shrink-0'} />
      </a>
    </SidebarHeader>
    <SidebarContent role="navigation" aria-label="Main navigation">
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={page === 'pipeline'} tooltip="Pipeline" aria-current={page === 'pipeline' ? 'page' : undefined} onClick={() => navigate('pipeline')}>
              <Workflow /><span>Pipeline</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive={page === 'settings'} tooltip="Settings" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 /><span>Settings</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
  </Sidebar>;
}

const DEPLOYMENT_MARKS: Record<Exclude<DeploymentMark, 'deploying'>, LucideIcon> = { deployed: CircleCheck, failed: CircleX, queued: CircleDashed, inactive: CircleMinus };
// The latest state GitHub records for a deployment; a record without one keeps the target icon.
function DeploymentStateMark({ mark }: { mark: DeploymentMark | null }) {
  if (!mark) return <Box className="size-3.5" />;
  if (mark === 'deploying') return <LoaderCircle className="size-3.5 text-foreground motion-safe:animate-spin" />;
  const Mark = DEPLOYMENT_MARKS[mark];
  return <Mark className={`size-3.5${mark === 'failed' ? ' text-destructive' : mark === 'deployed' ? ' text-foreground' : ''}`} />;
}

// A deployment GitHub records for the scanned commit: its environment, the app
// that reported it and its state in the title, and a link to its address.
function RecordedDeploymentRow({ row }: { row: RecordedDeployment }) {
  const { deployment } = row, mark = deploymentMark(deployment), at = deployment.stateAt || deployment.createdAt;
  const detail = [deployment.creator, mark && DEPLOYMENT_MARK_LABELS[mark], at && new Date(at).toLocaleString()].filter(Boolean).join(' · ');
  return <div className="flex min-h-6 min-w-0 items-center justify-between gap-2 px-1 py-0.5 text-sm font-medium leading-5" title={detail}>
    <span className="min-w-0 break-words">{row.label}{mark && <span className="sr-only">, {DEPLOYMENT_MARK_LABELS[mark]}</span>}</span>
    {deployment.url && <Hint text={new URL(deployment.url).host}><Button asChild variant="ghost" size="icon" className="size-6 shrink-0"><a href={deployment.url} target="_blank" rel="noreferrer" aria-label={`Open ${row.label}`}><ExternalLink className="size-3.5 text-muted-foreground" /></a></Button></Hint>}
  </div>;
}

// Collapsed by default; a group the viewer expands stays open across page visits.
function DeploymentGroup({ service, repoPath, stageId, selection, openDialog }: { service: DeploymentGroupService; repoPath?: string; stageId: string; selection: PipelineDialog | null; openDialog: OpenDialog }) {
  const [open, setOpen] = useRememberedOpen(`${repoPath}\n${stageId}\n${service.id}`);
  return <Collapsible open={open} onOpenChange={setOpen} className="nodrag nopan min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-1 [&[data-state=open]>svg]:rotate-180" aria-label={`${service.provider} projects`}>
        <span className="flex-1 text-left">{service.label}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <StepList label={`${service.provider} projects`}>
        {service.deployments.map(deployment => isRecordedDeployment(deployment)
          ? <StepItem key={deployment.id} compact icon={<DeploymentStateMark mark={deploymentMark(deployment.deployment)} />}><RecordedDeploymentRow row={deployment} /></StepItem>
          : <StepItem key={deployment.id} compact icon={<Box className="size-3.5" />}>
            <Button type="button" variant="ghost" size="sm" className="h-auto min-h-6 w-full justify-between gap-2 whitespace-normal px-1 py-0.5 text-left leading-5 aria-pressed:bg-accent" aria-pressed={selection?.nodeId === deployment.id} aria-label={`Configure ${deployment.label}`} onClick={() => openDialog({ type: 'service', nodeId: deployment.id, stageId })}>
              <span className="min-w-0 break-words">{deployment.label}</span><Settings2 className="size-3.5 text-muted-foreground" />
            </Button>
          </StepItem>)}
      </StepList>
    </CollapsibleContent>
  </Collapsible>;
}

// Source reports where its scanned commit came from; Production reports only
// deployments bound to it, or the gate's readiness for a commit. Neither is a deployment or test result.
// null is a status not known yet, which shows no Badge.
function stageStatus(stage: PipelineStage, { blocked, environment, buildStatus, origin, revision, services, gate, gated }: Pick<StageData, 'blocked' | 'environment' | 'services'> & Partial<Pick<StageData, 'buildStatus' | 'origin' | 'revision' | 'gate' | 'gated'>>): StageStatusView | null {
  if (blocked) return { kind: 'blocked', text: 'Transition paused' };
  if (stage.kind === 'source') return revision ? { kind: 'ready', text: origin === 'github' ? 'GitHub' : 'Local', sha: revision } : { kind: 'unconfigured', text: 'No commit' };
  // Ready is a gate verdict for a commit; Perpetual never deploys production. The badge's tooltip says what the verdict rests on.
  if (stage.kind === 'production') {
    const ready = productionStatus(gate && !isStageGate(gate) ? gate : null);
    if (ready) return { ...ready, hint: 'Every Sandbox gate passed or released this commit.' };
    if (!services.length) return { kind: 'unconfigured', text: 'Not connected', hint: 'No deployment target found in the repository or in its GitHub deployments.' };
    return { kind: 'idle', text: 'Unverified', hint: gated ? 'No commit has passed every Sandbox gate yet.' : 'No Sandbox stage gates commits before Production. Add Beta with the + after Build.' };
  }
  if (stage.kind === 'sandbox') return environment ? {
    kind: environment.status === 'ready' ? 'ready' : ['failed', 'cleanup_failed'].includes(environment.status) ? 'failed' : environmentWorking(environment.status) ? 'working' : 'idle',
    text: environmentStatusLabel(environment.status),
  } : { kind: 'unconfigured', text: 'Not provisioned' };
  // Current-commit GitHub Actions only, once read; a passing workflow is not a deployment.
  return buildStatus ?? null;
}

function HealthAge({ health }: { health: Parameters<typeof healthLabel>[0] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <span className="tabular-nums">{healthLabel(health, now)}</span>;
}

// `beat` is the checkedAt of a new monitor check (createHealthBeats), so each
// check remounts the mark and plays its beat once.
function HealthMark({ health, beat }: { health: Parameters<typeof healthWarning>[0]; beat?: string }) {
  return <HeartPulse key={beat || 'still'} className="stage-heartbeat" data-beat={beat ? true : undefined} data-tone={healthWarning(health) ? 'warning' : undefined} aria-hidden="true" />;
}

function StageStatus({ stage, status, environment, beat }: { stage: PipelineStage; status: StageStatusView | null; environment?: Environment | null; beat?: string }) {
  const [open, setOpen] = useState(false);
  // A status not known yet shows no Badge rather than a guess.
  if (!status) return null;
  const heartbeat = stage.kind === 'sandbox' && status.kind === 'ready';
  // A failed sandbox's badge says why; the card has no other place for its error.
  const hint = status.kind === 'working' && environment?.step ? environment.step : status.kind === 'failed' && environment?.error ? environment.error
    : heartbeat && healthLabel(environment?.health) ? <HealthAge health={environment!.health} /> : status.hint || null;
  const Icon = status.kind === 'failed' ? CircleX : status.kind === 'blocked' ? CirclePause : status.kind === 'passed' ? CircleCheck : status.kind === 'ready' ? CircleDot : CircleMinus;
  if (open && !hint) setOpen(false);
  const content = <>{heartbeat ? <HealthMark health={environment?.health} beat={beat} /> : status.kind === 'working' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}{status.text}{status.sha && <span className="stage-status-sha">{status.sha}</span>}</>;
  // The Tooltip wrapper stays mounted with or without a hint and opens only while
  // one exists. A badge with a hint is a button, so keyboard and screen reader
  // users reach it as a named control. A ready sandbox's first hint arrives with
  // its first check, the same render that keys a new beat, so the swap from span
  // to button never beats twice.
  return <Tooltip open={open} onOpenChange={value => setOpen(value && Boolean(hint))}>
    <TooltipTrigger asChild><Badge variant={STATUS_VARIANTS[status.kind] || 'secondary'} className="stage-status" data-tone={status.kind} asChild={Boolean(hint)}>
      {hint ? <button type="button">{content}</button> : content}
    </Badge></TooltipTrigger>
    {hint && <TooltipContent className="max-w-sm break-words">{hint}</TooltipContent>}
  </Tooltip>;
}

// Rendered inside the source card, so Tab reaches a transition right after the
// stage it leaves instead of before every stage.
function StageTransition({ stageId, stageName, next, nextName, blocked, canInsert, atStageLimit, busy, openDialog }: { stageId: string; stageName: string; next: string; nextName: string; blocked: boolean; canInsert: boolean; atStageLimit: boolean; busy: boolean; openDialog: OpenDialog }) {
  return <div className="stage-transition nodrag nopan" style={TRANSITION_STYLE}>
    {canInsert && <span className="stage-transition-insert"><Hint text={atStageLimit ? 'Stage limit reached' : 'Add stage'}><Button variant="outline" size="icon" className="stage-insert-button" disabled={busy} aria-disabled={atStageLimit || undefined} aria-label={`Add stage between ${stageName} and ${nextName}${atStageLimit ? ', stage limit reached' : ''}`} onClick={atStageLimit ? undefined : () => openDialog({ type: 'stage', afterStageId: stageId })}><Plus /></Button></Hint></span>}
    <span className="stage-transition-state">
      <Hint text={blocked ? 'Resume deployment' : 'Pause deployment'}><Button variant="ghost" size="icon" className="transition-control" aria-label={`${blocked ? 'Resume' : 'Pause'} deployment from ${stageName} to ${nextName}`} aria-haspopup="dialog" data-paused={blocked || undefined} disabled={busy} onClick={() => openDialog({ type: 'transition', sourceStageId: stageId, targetStageId: next })}>{blocked ? <Play /> : <Pause />}</Button></Hint>
      {blocked && <span className="transition-label">Paused</span>}
    </span>
  </div>;
}

function StageNode({ data }: NodeProps<StageFlowNode>) {
  const { stage, services, repoPath, scannedAt, sha, blocked, busy, openDialog, toggleStage, addTest, selected, selection, environment, createSandbox, environmentBusy, browserTests, activity, behind, repairHead, arrival, beat, build, buildStatus, github, origin, revision, next, nextName, nextBlocked, canInsert, atStageLimit, gate, gated, autopilot } = data;
  const status = stageStatus(stage, { blocked, environment, buildStatus, origin, revision, services, gate, gated });
  const sandbox = stage.kind === 'sandbox';
  // The changes Autopilot records for the stage; one under way lights the card's beam.
  const changes = autopilot?.changes || [];
  const businessCases: BrowserCase[] = browserTests?.cases || [];
  const browserRuns: BrowserRun[] = browserTests?.runs || [];
  const activeBrowserRun = browserRuns.find(run => ['queued', 'running'].includes(run.status));
  const preparation = browserTests?.preparation?.status;
  const preparingTests = ['preparing', 'discovering'].includes(preparation ?? '');
  // Production is header-only until a deployment is bound to it; its badge says so.
  const hasBody = stage.kind !== 'production' || services.length > 0 || changes.length > 0;
  const expanded = hasBody && !stage.collapsed;
  const openTests = () => openDialog({ type: 'environment', stageId: stage.id, tab: 'browser' });
  return <BaseNode className="pipeline-stage" data-status={status?.kind} data-activity={activity || undefined} data-expanded={expanded} data-selected={selected} tabIndex={-1}>
    {arrival && <span key={arrival} className="stage-arrival" aria-hidden="true" />}
    {stageActive(autopilot) && <StageBeam />}
    {stage.kind !== 'source' && <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />}
    {stage.kind !== 'production' && <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />}
    <Collapsible open={expanded} onOpenChange={() => toggleStage(stage.id)}>
      <BaseNodeHeader className="stage-header">
        <div><BaseNodeHeaderTitle as="h2">{stage.kind === 'source' || sandbox ? <Button variant="ghost" className="stage-title-button nodrag" onClick={() => stage.kind === 'source' ? openDialog({ type: 'source' }) : openTests()}>{stage.name}</Button> : stage.name}</BaseNodeHeaderTitle></div>
        <div className="stage-header-actions">
          <div className="stage-badges">
            <StageStatus stage={stage} status={status} environment={environment} beat={beat} />
            {sandbox && <GateBadge gate={isStageGate(gate) ? gate : null} />}
            {autopilot && <AutopilotBadge repoPath={repoPath} stage={stage} autopilot={autopilot} sha={sha} />}
            {behind && <Hint text={behind}><Badge asChild variant="outline" className="stage-behind"><button type="button">Behind</button></Badge></Hint>}
            {repairHead && <Hint text={repairHead}><Badge asChild variant="outline" className="stage-behind"><button type="button">PR head</button></Badge></Hint>}
            {sandbox && <Badge variant="outline" className="stage-kind">Sandbox</Badge>}
          </div>
          {hasBody && <CollapsibleTrigger asChild><Button className="stage-collapse nodrag" variant="ghost" size="icon" disabled={busy} aria-label={`${stage.collapsed ? 'Expand' : 'Collapse'} ${stage.name}`}>{stage.collapsed ? <ChevronRight /> : <ChevronDown />}</Button></CollapsibleTrigger>}
        </div>
      </BaseNodeHeader>
      {hasBody && <CollapsibleContent>
        {(services.length > 0 || changes.length > 0) && <StepList className="stage-actions" label={`${stage.name} steps`}>
          {services.map(service => <StepItem key={service.id} icon={<ProviderMark provider={service.provider} active={service.kind === 'github-actions' && ['running', 'queued'].includes(build?.status ?? '')} />}>
            {service.kind === 'github-actions'
              ? <GitHubActionsCard repoPath={repoPath} scannedAt={scannedAt} runs={github} stageId={stage.id} autopilot={autopilot} />
              : isDeploymentGroup(service)
              ? <DeploymentGroup service={service} repoPath={repoPath} stageId={stage.id} selection={selection} openDialog={openDialog} />
              : <Button variant="ghost" size="sm" className="stage-step-action nodrag nopan h-auto min-h-8 w-full justify-between whitespace-normal aria-pressed:bg-accent" onClick={() => openDialog({ type: stage.kind === 'source' ? 'source' : 'service', nodeId: service.id, stageId: stage.id })} aria-pressed={selection?.nodeId === service.id || (stage.kind === 'source' && selection?.type === 'source')} aria-label={`Configure ${service.label}`}>
                <span className="min-w-0 break-words text-left" title={service.label}>{service.label}</span><Settings2 className="size-3.5 text-muted-foreground" />
              </Button>}
          </StepItem>)}
          {changes.map(change => <StepItem key={change.id} icon={<ChangeMark change={change} />}><ChangeRow change={change} repoPath={repoPath} /></StepItem>)}
        </StepList>}
        {!services.length && stage.kind === 'build' && <div className="stage-placeholder"><p>No actions configured</p></div>}
        {sandbox && <div className="flex min-w-0 flex-col gap-3 px-3 pb-3">
          <TwinServices repoPath={repoPath} scannedAt={scannedAt} stageId={stage.id} environment={environment} />
          {(!environment || ['destroyed', 'failed', 'cleanup_failed'].includes(environment.status)) && <Button className="nodrag nopan" size="sm" disabled={busy || environmentBusy} onClick={() => createSandbox(stage.id)}><Box />{environmentBusy ? 'Creating…' : `Create ${stage.name} environment`}</Button>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" className="nodrag nopan h-8 justify-start gap-2 px-1 text-xs" aria-label={`Integration tests, ${businessCases.length}`} onClick={openTests}>Integration tests<Badge variant="outline" className="tabular-nums">{businessCases.length}</Badge></Button>
            {preparingTests || activeBrowserRun ? <Badge variant="outline"><LoaderCircle className="motion-safe:animate-spin" />{activeBrowserRun?.mode === 'run' ? 'Running' : 'Generating'}</Badge>
              : preparation === 'failed' ? <Badge variant="destructive">Preparation failed</Badge>
              : preparation === 'needs_setup' && <Badge variant="outline">Setup required</Badge>}
          </div>
          <StageJourneyList repoPath={repoPath} stageId={stage.id} stageName={stage.name} cases={businessCases} runs={browserRuns} selection={selection} busy={busy || Boolean(activeBrowserRun) || preparingTests} openDialog={openDialog} />
          {activeBrowserRun && <Button variant="outline" className="nodrag nopan" size="sm" onClick={() => openDialog({ type: 'environment', stageId: stage.id, tab: 'browser', runId: activeBrowserRun.id, watch: true })}><Eye />Watch live</Button>}
        </div>}
        {sandbox && <div className="stage-edit-footer">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <Button variant="ghost" className="nodrag" size="sm" data-add-test={stage.id} disabled={busy || environmentBusy || Boolean(activeBrowserRun) || businessCases.length >= MAX_CASES} onClick={() => addTest(stage.id)}><Plus />Add test</Button>
            <GateActions repoPath={repoPath} stage={stage} gate={isStageGate(gate) ? gate : null} disabled={busy} />
          </div>
          <div className="flex items-center gap-1">
            <Hint text="Rename"><Button className="nodrag" variant="ghost" size="icon" disabled={busy} aria-label={`Rename ${stage.name}`} onClick={() => openDialog({ type: 'rename-stage', stageId: stage.id })}><Pencil /></Button></Hint>
            <Hint text="Delete stage"><Button className="nodrag" variant="ghost" size="icon" disabled={busy || environmentBusy || Boolean(activeBrowserRun) || preparingTests} aria-label={`Delete ${stage.name}`} onClick={() => openDialog({ type: 'remove-stage', stageId: stage.id })}><Trash2 /></Button></Hint>
          </div>
        </div>}
      </CollapsibleContent>}
    </Collapsible>
    {next && <StageTransition stageId={stage.id} stageName={stage.name} next={next} nextName={nextName} blocked={nextBlocked} canInsert={canInsert} atStageLimit={atStageLimit} busy={busy} openDialog={openDialog} />}
  </BaseNode>;
}

function TransitionEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd }: EdgeProps) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={16} />;
}

// Current-commit Actions runs, polled faster only while a run of a listed
// workflow is queued or running.
function useGitHubRuns(repoPath: string | undefined, sha: string | null, workflows: string[], enabled: boolean) {
  const [result, setResult] = useState<GitHubRuns | null>(null);
  const workflowKey = JSON.stringify(workflows);
  useEffect(() => {
    if (!repoPath || !sha || !enabled) return undefined;
    // The key is the list serialized above, so the effect runs only when its contents change.
    const poller = createGitHubRunsPoller({ controller: api, repoPath, workflows: JSON.parse(workflowKey) as string[], onChange: setResult });
    return () => poller.stop();
  }, [repoPath, sha, workflowKey, enabled]);
  return enabled && result?.sha === sha ? result : null;
}

// The deployments GitHub records for the current commit, polled faster only
// while one is queued or in progress.
function useGitHubDeployments(repoPath: string | undefined, sha: string | null, enabled: boolean) {
  const [result, setResult] = useState<GitHubDeployments | null>(null);
  useEffect(() => {
    if (!repoPath || !sha || !enabled) return undefined;
    const poller = createGitHubDeploymentsPoller({ controller: api, repoPath, onChange: setResult });
    return () => poller.stop();
  }, [repoPath, sha, enabled]);
  return enabled && result?.sha === sha ? result : null;
}

// Autopilot's modes and changes, read once the controller reports them in the
// pipeline state; before that the cards show nothing about Autopilot.
function useAutopilot(repoPath: string | undefined, initial: AutopilotView | null | undefined) {
  const [view, setView] = useState<AutopilotView | null>(null);
  const enabled = initial !== undefined;
  useEffect(() => {
    if (!repoPath || !enabled) return undefined;
    const poller = createAutopilotPoller({ controller: api, repoPath, onChange: next => setView(previous => shareAutopilot(previous, next)) });
    const stop = autopilotChanges.subscribe(() => poller.refresh());
    return () => { stop(); poller.stop(); };
  }, [repoPath, enabled]);
  const current = view ?? initial ?? null;
  return enabled && current?.repoPath === repoPath ? current : null;
}

// The canvas's one live region. It speaks when a stage's status text changes,
// never on first render or for a poll that changed nothing.
function StatusAnnouncer({ statuses }: { statuses: { id: string; name: string; text: string }[] }) {
  const seen = useRef<ReturnType<typeof statusChanges>['seen'] | null>(null);
  const [message, setMessage] = useState('');
  const key = JSON.stringify(statuses);
  useEffect(() => {
    const next = statusChanges(seen.current, JSON.parse(key) as typeof statuses); // the statuses serialized above
    seen.current = next.seen;
    if (next.message) setMessage(next.message);
  }, [key]);
  return <p className="sr-only" role="status" aria-atomic="true">{message}</p>;
}

// Canvas pans are linear, so an animated pan never dips the zoom mid-flight.
const panOptions = () => ({ duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220, interpolate: 'linear' as const });

// Sits above the stages rather than over them. Try again appears only for an
// operation the canvas can repeat.
function CanvasError({ error, onRetry, onDismiss }: { error: CanvasFailure; onRetry: () => void; onDismiss: () => void }) {
  return <Alert variant="destructive" className="canvas-alert">
    <CircleAlert aria-hidden="true" />
    <AlertDescription><p>{error.message}</p></AlertDescription>
    <div className="canvas-alert-actions">
      {error.retry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
      <Button variant="ghost" size="icon" className="size-8" aria-label="Dismiss" onClick={onDismiss}><X /></Button>
    </div>
  </Alert>;
}

function PipelineCanvas({ scan, source, pipeline, busy, toggleStage, addTest, openDialog, error, onRetryError, onDismissError, selection, branchSwitcher, environments, createSandbox, environmentBusy, browserTests, stageRemovals, gates, autopilot, theme }: PipelineCanvasProps) {
  const section = useRef<HTMLElement>(null), canvas = useRef<HTMLDivElement>(null), flowElement = useRef<HTMLDivElement>(null);
  const [stageSizes, setStageSizes] = useState<Record<string, { width: number; height: number }>>({});
  const nodesInitialized = useNodesInitialized();
  const flow = useReactFlow<StageFlowNode>();
  const measureStages = useCallback((changes: NodeChange<StageFlowNode>[]) => {
    const resized = changes.filter((change): change is Extract<NodeChange, { type: 'dimensions' }> & { dimensions: { width: number; height: number } } => change.type === 'dimensions' && (change.dimensions?.width ?? 0) > 0 && (change.dimensions?.height ?? 0) > 0);
    if (!resized.length) return;
    setStageSizes(current => {
      let next = current;
      for (const { id, dimensions } of resized) {
        if (next[id]?.width === dimensions.width && next[id]?.height === dimensions.height) continue;
        if (next === current) next = { ...current };
        next[id] = { width: dimensions.width, height: dimensions.height };
      }
      return next;
    });
  }, []);
  const selectedStageId = selection?.stageId || selection?.sourceStageId || selection?.afterStageId || (selection?.type === 'source' ? 'source' : null);
  const sha = scan?.repo?.sha || null;
  // The workflow files the Actions rail lists; other runs never set its status.
  const workflows = useMemo(() => (scan?.workflows || []).map(workflow => workflow.file).filter((file): file is string => typeof file === 'string'), [scan]);
  const githubSource = Boolean(scan?.delivery?.build?.some(service => service.kind === 'github-actions'));
  const github = useGitHubRuns(scan?.repo?.path, sha, workflows, githubSource);
  const build = useMemo(() => githubBuildSummary(github, sha, workflows), [github, sha, workflows]);
  const buildStatus = useMemo(() => githubBuildStatus(github, sha, workflows), [github, sha, workflows]);
  const deployments = useGitHubDeployments(scan?.repo?.path, sha, githubSource);
  // Production's rows with the deployments GitHub records for the scanned commit; without records, the scan's rows stand.
  const production = useMemo(() => deployments ? productionRows<ScanNode>(scan?.delivery?.production || [], deployments, sha) : null, [scan, deployments, sha]);
  const stageEnvironments = useMemo(() => sourceEnvironments(environments, scan?.repo?.path), [environments, scan]);
  const latest = useMemo(() => Object.fromEntries((pipeline?.stages || []).map(stage => [stage.id, latestEnvironment(stageEnvironments, stage.id)])), [pipeline, stageEnvironments]);
  const activitySnapshot = useMemo(() => ({ environments: stageEnvironments, browserTests, stageRemovals }), [stageEnvironments, browserTests, stageRemovals]);
  // One-shot arrival ring when an observed provisioning environment becomes
  // ready. A new key replays the ring.
  const readiness = useRef<ReturnType<typeof readyArrivals>['seen'] | null>(null), arrivalTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [arrivals, setArrivals] = useState<Record<string, string>>({});
  useEffect(() => () => arrivalTimers.current.forEach(clearTimeout), []);
  const arrive = useCallback((arrived: Arrival[]) => {
    if (!arrived.length) return;
    setArrivals(current => ({ ...current, ...Object.fromEntries(arrived.map(item => [item.stageId, item.key])) }));
    const timer = setTimeout(() => {
      arrivalTimers.current.delete(timer);
      setArrivals(current => Object.fromEntries(Object.entries(current).filter(([stageId, key]) => !arrived.some(item => item.stageId === stageId && item.key === key))));
    }, 1500);
    arrivalTimers.current.add(timer);
  }, []);
  useEffect(() => {
    const { seen, arrived } = readyArrivals(readiness.current, stageEnvironments);
    readiness.current = seen;
    arrive(arrived);
  }, [stageEnvironments, arrive]);
  // Reuse unchanged stage data so memoized cards skip unrelated polls. Heartbeat
  // baselines live here, above each card, so a remounted badge keeps its beat.
  const [reuseStageData] = useState(createStageDataCache);
  const [healthBeat] = useState(createHealthBeats);
  const nodes = useMemo(() => {
    let x = 0;
    const context = { scan, source, pipeline, sha, latest, snapshot: activitySnapshot, arrivals, healthBeat, build, buildStatus, github, gates, production, autopilot, selection, selectedStageId, busyStages: environmentBusy, busy, openDialog, toggleStage, addTest, createSandbox };
    return (pipeline?.stages || []).map((stage): StageFlowNode => {
      const position = { x, y: 0 };
      const measured = stageSizes[stage.id];
      x += (measured?.width ?? STAGE_MIN_WIDTH) + STAGE_GAP;
      return {
        id: stage.id, type: 'stage', position, measured, draggable: false, ariaRole: 'group', ariaLabel: stage.name, domAttributes: STAGE_ROLE,
        // Preserve React Flow's measured dimensions without fixing the CSS size.
        // Card expansion only moves following stages; it does not change the zoom.
        className: 'nopan', style: STAGE_STYLE, data: reuseStageData(stage.id, stageNodeData(stage, context)) as StageData,
      };
    });
  }, [scan, source, sha, pipeline, stageSizes, busy, openDialog, toggleStage, addTest, selectedStageId, selection, latest, createSandbox, environmentBusy, activitySnapshot, arrivals, healthBeat, reuseStageData, build, buildStatus, github, gates, production, autopilot]);
  const edges = useMemo(() => (pipeline?.transitions || []).map((edge): Edge => {
    const flow = transitionFlow(edge, { stages: pipeline.stages, snapshot: activitySnapshot, build, latest, sha, gates });
    const sourceName = pipeline.stages.find(stage => stage.id === edge.source)?.name, targetName = pipeline.stages.find(stage => stage.id === edge.target)?.name;
    return {
      id: edge.id, source: edge.source, target: edge.target, type: 'transition', className: edge.blocked ? 'is-blocked' : '', domAttributes: flow ? { 'data-flow': flow } as Edge['domAttributes'] : undefined,
      ariaLabel: `${sourceName} to ${targetName}${edge.blocked ? ', paused' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: edge.blocked ? 'var(--pipeline-edge-muted)' : flow === 'active' ? 'var(--foreground)' : 'var(--pipeline-accent)' },
    };
  }), [pipeline, activitySnapshot, build, latest, sha, gates]);
  // React Flow fixes role="application" on its wrapper, which takes screen readers
  // out of browse mode; the stages are ordinary grouped controls. React leaves an
  // unchanged prop alone, so the attribute set here persists.
  useEffect(() => {
    flowElement.current?.setAttribute('role', 'region');
    flowElement.current?.setAttribute('aria-labelledby', 'pipeline-heading');
  }, []);

  const statuses = useMemo(() => nodes.map(node => ({ id: node.id, name: node.data.stage.name, text: stageStatus(node.data.stage, node.data)?.text ?? '' })), [nodes]);

  // Automatic framing runs on the first load, on a layout change the viewer has
  // not overridden by panning or zooming, and on a window or sidebar resize. A
  // sheet pans its stage into view without zooming and hands the viewer's frame
  // back when it closes; modal dialogs never move the canvas.
  const layoutKey = pipeline.stages.map(stage => `${stage.id}:${stage.collapsed}`).join('|');
  const sheet = selection && !MODAL_DIALOGS.has(selection.type) ? selection : null;
  const sheetStageId = sheet ? selectedStageId : null;
  const [ready, setReady] = useState(false);
  if (nodesInitialized && !ready) setReady(true);
  const [sheetViewport] = useState(createSheetViewport);
  const view = useRef<{ moved: boolean; stageId: string | null; timer: ReturnType<typeof setTimeout> | 0; raf: number }>({ moved: false, stageId: null, timer: 0, raf: 0 });
  const takeView = useCallback(() => { view.current.moved = true; sheetViewport.moved(); }, [sheetViewport]);
  // Programmatic moves report no event; a drag, wheel or pinch does.
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => { if (event) takeView(); }, [takeView]);
  // An animated move is recorded until it lands, so a sheet opened meanwhile
  // borrows where the canvas is going.
  const pan = useCallback((next: Viewport) => { void sheetViewport.animate(next, flow.setViewport(next, panOptions())); }, [flow, sheetViewport]);
  const uncover = useCallback((stageId: string | null, animated = false) => {
    const width = canvas.current?.clientWidth || 0, node = stageId ? flow.getNode(stageId) : null;
    // Below 901px the sheet covers the canvas instead of narrowing it.
    if (!node || !width || !matchMedia('(min-width: 901px)').matches) return;
    const current = sheetViewport.view(flow.getViewport()), next = uncoverViewport(current, stageBoxes([node])[0], { width });
    if (next === current) return;
    if (animated) pan(next);
    else void flow.setViewport(next);
  }, [flow, sheetViewport, pan]);
  const frame = useCallback(() => {
    const width = canvas.current?.clientWidth || 0, nodes = flow.getNodes();
    if (!width || !nodes.length) return;
    void flow.setViewport(entryViewport(stageBoxes(nodes), { width }));
    view.current.moved = false;
    sheetViewport.reframed();
    uncover(view.current.stageId);
  }, [flow, sheetViewport, uncover]);
  const latestFrame = useRef(frame);
  useEffect(() => { latestFrame.current = frame; }, [frame]);
  // Measured sizes settle before framing.
  const scheduleFrame = useCallback(() => {
    const pending = view.current;
    clearTimeout(pending.timer); cancelAnimationFrame(pending.raf);
    pending.timer = setTimeout(() => { pending.raf = requestAnimationFrame(() => latestFrame.current()); }, 80);
  }, []);
  // The section keeps its size when a sheet narrows the flow viewport inside it,
  // so only window and sidebar resizes reach the observer. Its first report is
  // the first-load framing.
  useEffect(() => {
    if (!ready || !section.current) return undefined;
    const pending = view.current, observer = new ResizeObserver(scheduleFrame);
    observer.observe(section.current);
    return () => { observer.disconnect(); clearTimeout(pending.timer); cancelAnimationFrame(pending.raf); };
  }, [ready, scheduleFrame]);
  const framedLayout = useRef(layoutKey);
  useEffect(() => {
    if (framedLayout.current === layoutKey) return;
    framedLayout.current = layoutKey;
    if (!view.current.moved) scheduleFrame();
  }, [layoutKey, scheduleFrame]);
  const sheetOpen = Boolean(sheet);
  useEffect(() => {
    view.current.stageId = sheetStageId;
    if (!ready) return;
    if (sheetOpen) {
      sheetViewport.open(flow.getViewport());
      uncover(sheetStageId, true);
      return;
    }
    const closed: { restore?: Viewport; frame?: boolean } | null = sheetViewport.close();
    if (closed?.restore) pan(closed.restore);
    else if (closed?.frame) scheduleFrame();
  }, [ready, sheetOpen, sheetStageId, flow, sheetViewport, uncover, pan, scheduleFrame]);

  // The renderer clips rather than scrolls, so the browser cannot shift it under
  // the viewport when a control takes focus. Keyboard focus pans instead, just
  // far enough to show the control, and never zooms.
  useEffect(() => {
    const element = flowElement.current;
    if (!element) return undefined;
    const reveal = (event: FocusEvent) => {
      const control = event.target instanceof Element ? event.target : null, node = control?.closest('.react-flow__node');
      if (!control || !node || !control.matches(':focus-visible')) return;
      const live = flow.getViewport(), bounds = element.getBoundingClientRect();
      const box = (target: Element) => { const rect = target.getBoundingClientRect(); return { x: (rect.left - bounds.left - live.x) / live.zoom, y: (rect.top - bounds.top - live.y) / live.zoom, width: rect.width / live.zoom, height: rect.height / live.zoom }; };
      const current = sheetViewport.view(live), next = revealViewport(current, box(control), box(node), { width: bounds.width, height: bounds.height });
      if (next === current) return;
      takeView();
      pan(next);
    };
    element.addEventListener('focusin', reveal);
    return () => element.removeEventListener('focusin', reveal);
  }, [flow, sheetViewport, takeView, pan]);

  const zoomOut = () => { takeView(); void flow.zoomOut(); };
  const zoomIn = () => { takeView(); void flow.zoomIn(); };
  // Fit view shows the whole pipeline, starting at the entry row height.
  const fit = () => {
    takeView();
    void flow.fitView(FIT_VIEW_OPTIONS).then(() => {
      const fitted = flow.getViewport(), next = alignTop(fitted);
      if (next !== fitted) void flow.setViewport(next!);
    });
  };

  return <section ref={section} className={`pipeline-canvas${sheet ? ' has-inspector' : ''}${sheet?.type === 'git-graph' ? ' has-git-graph' : ''}`}>
    <h1 id="pipeline-heading" className="sr-only">Release pipeline</h1>
    <StatusAnnouncer statuses={statuses} />
    <div className="pipeline-branch-toolbar">{branchSwitcher}<Button variant="outline" className="h-11 shrink-0 gap-2 bg-card dark:bg-card" aria-label="Git graph" disabled={busy} onClick={() => openDialog({ type: 'git-graph' })}><GitGraph className="size-4" /><span className="branch-map-trigger-label">Git graph</span></Button></div>
    <div className="flow-viewport" ref={canvas}>
    {error && <CanvasError error={error} onRetry={onRetryError} onDismiss={onDismissError} />}
    <ReactFlow ref={flowElement} className="release-flow" colorMode={theme} nodes={nodes} edges={edges} onNodesChange={measureStages} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false} disableKeyboardA11y ariaLabelConfig={ARIA_LABELS} deleteKeyCode={null} minZoom={0.02} maxZoom={1.6} zoomOnDoubleClick={false} panOnScroll selectionOnDrag={false} onMoveStart={onMoveStart} defaultViewport={INITIAL_PIPELINE_VIEWPORT} proOptions={FLOW_OPTIONS}>
    </ReactFlow>
    <div className="canvas-toolbar"><div className="canvas-view-actions">
      <Hint text="Zoom out"><Button variant="ghost" size="icon" aria-label="Zoom out" onClick={zoomOut}><ZoomOut size={16} /></Button></Hint>
      <Hint text="Zoom in"><Button variant="ghost" size="icon" aria-label="Zoom in" onClick={zoomIn}><ZoomIn size={16} /></Button></Hint>
      <Hint text="Fit view"><Button variant="ghost" size="icon" onClick={fit} aria-label="Fit view"><Maximize size={16} /></Button></Hint>
    </div></div>
    </div>
  </section>;
}

// The card's Add test opens only the New test dialog. The draft joins the card
// for review; it is never approved or run from here.
function StageNewTest({ repoPath, stageId, onClose, onAppSettings }: { repoPath: string; stageId: string; onClose: () => void; onAppSettings: () => void }) {
  const [stage, snapshot] = useTestStage(stageId, ['browser']);
  const capabilities = snapshot.browser.capabilities;
  const configured = Boolean(capabilities?.modelConfigured && capabilities.baseUrl?.replace(/\/$/, '') === OPENROUTER_BASE);
  const create = useCallback(async (description: string) => {
    await stage.perform('browser', 'draft', tx => tx.post('draft', { description }));
    if (stage.isCurrent()) onClose();
  }, [stage, onClose]);
  // The transcribe reply is { text }, which the voice hook checks before use.
  const transcribe = useCallback<TranscribeAudio>((audio, options) => stage.perform('browser', 'transcribe', tx => tx.post('transcribe', audio, options) as Promise<{ text?: unknown }>), [stage]);
  // The dialog opens at once; its key gate waits until capabilities are known.
  return <NewTestDialog draftKey={newTestDraftKey(repoPath, stageId)} onCreate={create} onTranscribe={transcribe} onClose={onClose} onAppSettings={onAppSettings} modelChecked={Boolean(capabilities)} modelConfigured={configured} voiceConfigured={configured} />;
}

class PageBoundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <div className="p-8"><h1 className="text-xl font-semibold">Could not display the pipeline</h1><Button onClick={() => location.reload()}>Reload</Button></div> : this.props.children; }
}

function PipelineApp() {
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (settingsDraft || hasCaseDrafts()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [settingsDraft]);
  const [workspace, tests] = useTestWorkspace();
  const [page, setPage] = useState<Page>(() => window.location.hash === '#settings' ? 'settings' : 'pipeline');
  const pageRef = useRef(page), settingsReturn = useRef<SettingsReturn | null>(null);
  useEffect(() => { document.title = `Perpetual — ${page === 'settings' ? 'Settings' : 'Pipeline'}`; }, [page]);
  const [state, setState] = useState<PipelineState>({ scan: null, defaultRepo: '' });
  const [pipeline, setPipeline] = useState<PipelineView | null | undefined>(null);
  const [loading, setLoading] = useState(true);
  // A failure the canvas reports, with the operation that can repeat it, if any.
  const [error, setFailure] = useState<CanvasFailure | null>(null);
  const setError = useCallback((message: string, retry: (() => void) | null = null) => setFailure(message ? { message, retry } : null), []);
  // A workspace poll failure the viewer dismissed stays hidden until it clears.
  const [quietError, setQuietError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<PipelineDialog | null>(() => {
    const query = new URLSearchParams(window.location.search);
    if (['browser', 'live'].includes(query.get('watch') ?? '') && query.get('stage')) {
      const legacyRun = query.get('watch') === 'live' && query.get('run');
      return { type: 'environment', stageId: query.get('stage')!, tab: legacyRun ? 'runs' : 'browser', watch: true, runId: query.get('run') || '' };
    }
    return query.get('preview') === 'branch-map' ? { type: 'git-graph' } : null;
  });
  // The sandbox whose card opened New test; closing returns focus to that card.
  const [newTest, setNewTest] = useState('');
  const newTestReturn = useRef('');
  const mutation = useRef(false);
  const pipelineRevision = useRef(0);
  const toggles = useRef(0);
  const toggleRevision = useRef(0);
  const connectRequest = useRef(0);
  const caseRequest = useRef(0);
  const [theme, setTheme] = useState<Theme>(() => { try { return localStorage.getItem('perpetual-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const openDialog = useCallback<OpenDialog>(next => {
    if (mutation.current) return;
    setError('');
    setDialog(next?.connect ? { ...next, connectRequest: ++connectRequest.current } : next?.caseId || next?.watch ? { ...next, caseRequestKey: ++caseRequest.current } : next);
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    const url = new URL(window.location.href);
    for (const key of ['watch', 'run', 'stage']) url.searchParams.delete(key);
    if (url.searchParams.get('preview') === 'branch-map') {
      url.searchParams.delete('preview');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const addTest = useCallback((stageId: string) => {
    if (mutation.current) return;
    setError(''); setNewTest(stageId);
  }, []);
  const closeNewTest = useCallback(() => setNewTest(''), []);
  useEffect(() => {
    if (newTest) { newTestReturn.current = newTest; return undefined; }
    const stageId = newTestReturn.current;
    if (!stageId) return undefined;
    newTestReturn.current = '';
    // Radix restores focus when the dialog unmounts; the card's trigger is focused after it.
    const timer = setTimeout(() => document.querySelector<HTMLElement>(`[data-add-test="${CSS.escape(stageId)}"]`)?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(timer);
  }, [newTest]);
  // Settings opened from a dialog hands that dialog back when the viewer returns
  // to the Pipeline; any other page change closes it.
  const showPage = useCallback((next: Page, from: SettingsReturn | null = null) => {
    const restore = next === 'pipeline' && pageRef.current === 'settings' ? settingsReturn.current : null;
    if (next !== pageRef.current) settingsReturn.current = from;
    pageRef.current = next;
    setPage(next);
    if (restore) { setDialog(restore.dialog); setNewTest(restore.newTest); }
    else { closeDialog(); setNewTest(''); }
  }, [closeDialog]);
  const navigate = useCallback((next: Page, from?: SettingsReturn) => {
    showPage(next, from);
    window.location.hash = next;
  }, [showPage]);
  const openAppSettings = useCallback(() => navigate('settings', { dialog, newTest }), [navigate, dialog, newTest]);
  // Back and Forward change the hash; navigate's own hash change finds the page already shown.
  useEffect(() => {
    const changed = () => { const next = window.location.hash === '#settings' ? 'settings' : 'pipeline'; if (next !== pageRef.current) showPage(next); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [showPage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('view') !== 'environments') return;
    url.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // The theme switches in one frame: transitions stay off until the new colours
  // have been styled, so nothing fades between themes.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.classList.toggle('dark', theme === 'dark');
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content = theme === 'dark' ? '#111113' : '#ffffff';
    void root.offsetHeight;
    const frame = requestAnimationFrame(() => root.classList.remove('theme-switching'));
    try { localStorage.setItem('perpetual-theme', theme); } catch { /* Theme still applies for this visit. */ }
    return () => { cancelAnimationFrame(frame); root.classList.remove('theme-switching'); };
  }, [theme]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const fresh = await api<PipelineState>('/api/state');
      workspace.activate(fresh.scan?.repo, fresh);
      setState(fresh);
      setPipeline(fresh.pipeline);
    } catch (failure) { setError((failure as Error).message); }
    finally { setLoading(false); }
  }, [workspace]);
  useEffect(() => { void load(); }, [load]);

  const refreshPipeline = useCallback(async () => {
    if (mutation.current) return;
    const source = workspace.stage('source');
    const revision = pipelineRevision.current, toggled = toggleRevision.current;
    const fresh = await workspace.refreshSource<PipelineState>();
    if (fresh && source.isCurrent() && revision === pipelineRevision.current && toggled === toggleRevision.current && !toggles.current && !mutation.current) setPipeline(fresh.pipeline);
  }, [workspace]);
  // A gate moved the managed source to another commit in place; the workspace and its drafts stay.
  const refreshScan = useCallback(async () => {
    if (mutation.current) return;
    const revision = pipelineRevision.current;
    try {
      const fresh = await api<PipelineState>('/api/state');
      if (mutation.current || revision !== pipelineRevision.current || fresh.scan?.repo?.path !== state.scan?.repo?.path) return;
      setState(fresh); setPipeline(fresh.pipeline);
    } catch (failure) { setError((failure as Error).message); }
  }, [state.scan]);
  const gates = useStageGates(state.scan?.repo, refreshScan);
  const autopilot = useAutopilot(state.scan?.repo?.path, state.autopilot);
  useEffect(() => {
    if (!tests.stageRemovals?.some(item => item.status === 'completed' && pipeline?.stages.some(stage => stage.id === item.stageId))) return;
    const refresh = () => void refreshPipeline().catch(failure => setError(failure.message, refresh));
    refresh();
  }, [tests.stageRemovals, pipeline, refreshPipeline, setError]);
  useEffect(() => {
    if (dialog?.type === 'remove-stage' && pipeline && !pipeline.stages.some(stage => stage.id === dialog.stageId)) closeDialog();
  }, [dialog, pipeline, closeDialog]);

  const createSandbox = useCallback(async (stageId: string) => {
    if (mutation.current) return;
    const stage = workspace.stage(stageId);
    if (stage.getSnapshot().pending) return;
    setError('');
    setDialog({ type: 'environment', stageId, tab: 'browser' });
    try { await stage.createEnvironment(); }
    catch (failure) {
      if (!stage.isCurrent()) return;
      setError((failure as Error).message);
      setDialog(previous => previous?.type === 'environment' && previous.stageId === stageId ? { ...previous, error: (failure as Error).message } : previous);
    }
  }, [workspace]);

  const onAction = useCallback(async (input: PipelineAction) => {
    if (mutation.current) throw new Error('Wait for the previous change to finish saving.');
    mutation.current = true; pipelineRevision.current++; setBusy(true); setError('');
    try { const result = await api<PipelineActionResult>('/api/pipeline/action', { repoPath: state.scan!.repo.path, ...input }); setPipeline(result.pipeline); return result; }
    finally { mutation.current = false; setBusy(false); }
  }, [state.scan]);
  // Collapsing is a saved view preference, not a release change: it applies at
  // once without the global busy lock and rolls back only if saving fails.
  const toggleStage = useCallback(async (stageId: string) => {
    const repoPath = state.scan?.repo?.path;
    if (mutation.current || !repoPath) return;
    const base = pipelineRevision.current, request = ++toggleRevision.current;
    const flip = (current: PipelineView | null | undefined) => current?.repoPath === repoPath ? { ...current, stages: current.stages.map(stage => stage.id === stageId ? { ...stage, collapsed: !stage.collapsed } : stage) } : current;
    toggles.current++;
    setError('');
    setPipeline(flip);
    try {
      const result = await api<PipelineActionResult>('/api/pipeline/action', { repoPath, action: 'toggle-stage', stageId });
      // The server applies toggles in order, so the latest response includes earlier ones.
      if (request === toggleRevision.current && base === pipelineRevision.current) setPipeline(result.pipeline);
    } catch (failure) {
      // Only a rolled-back toggle can be repeated as it was.
      const rolledBack = base === pipelineRevision.current;
      if (rolledBack) setPipeline(flip);
      setError((failure as Error).message, rolledBack ? () => toggleStage(stageId) : null);
    } finally { toggles.current--; }
  }, [state.scan]);
  const onSourceSave = useCallback(async (selection: SourceSelection) => {
    if (mutation.current) throw new Error('Wait for the previous change to finish saving.');
    mutation.current = true; pipelineRevision.current++; setBusy(true);
    try {
      const result = await api<SourceResult>('/api/source/github', selection);
      workspace.activate(result.scan.repo, result);
      setState(previous => ({ ...previous, scan: result.scan, source: result.source, providers: [], environments: result.environments || [], browserTests: {} }));
      setPipeline(result.pipeline);
      setError('');
      return result;
    } catch (failure) { setError((failure as Error).message); throw failure; }
    finally { mutation.current = false; setBusy(false); }
  }, [workspace]);

  const switchBranch = useCallback(async (source: SourceSelection) => {
    const result = await onSourceSave(source);
    setDialog(null);
    setNewTest('');
    return result;
  }, [onSourceSave]);

  // Returns to the original local checkout; the scan only reads it and clears the managed source.
  const scanLocal = useCallback(async (path: string) => {
    if (mutation.current) throw new Error('Wait for the previous change to finish saving.');
    mutation.current = true; pipelineRevision.current++; setBusy(true);
    try {
      await api('/api/scan', { path });
      const fresh = await api<PipelineState>('/api/state');
      workspace.activate(fresh.scan?.repo, fresh);
      setState(fresh);
      setPipeline(fresh.pipeline);
      setError('');
      setDialog(null);
      setNewTest('');
      return fresh;
    } catch (failure) { setError((failure as Error).message); throw failure; }
    finally { mutation.current = false; setBusy(false); }
  }, [workspace]);

  // The canvas shows its own failure first, then a workspace poll failure the
  // viewer has not dismissed. Polls retry on their own, so only the canvas's
  // own operations offer Try again.
  useEffect(() => { if (!tests.error) setQuietError(''); }, [tests.error]);
  const canvasError = useMemo(() => error || (tests.error && tests.error !== quietError ? { message: tests.error, retry: null } : null), [error, tests.error, quietError]);
  const retryError = useCallback(() => { const retry = error?.retry; setError(''); retry?.(); }, [error, setError]);
  const dismissError = useCallback(() => { if (error) setError(''); else setQuietError(tests.error); }, [error, setError, tests.error]);

  return <>
    <AppSidebar theme={theme} page={page} onNavigate={navigate} />
    <div className="app-workspace">
      <header className="workspace-header"><div className="workspace-context"><SidebarTrigger aria-label="Toggle sidebar" /><Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />{page === 'settings' ? <Settings2 size={16} /> : <Workflow size={16} />}<span className="workspace-title">{page === 'settings' ? 'Settings' : 'Pipeline'}</span>{page === 'pipeline' && state.scan?.repo?.name && <><ChevronRight size={14} /><span className="workspace-repo">{state.scan.repo.name}</span></>}</div><Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</Button></header>
      {page === 'settings' ? <AppSettings draft={settingsDraft} onDraftChange={setSettingsDraft} /> : <main className="pipeline-page" id="pipeline">
        {loading ? <PipelineLoading /> : pipeline ? <ReactFlowProvider key={pipeline.repoPath}><PipelineCanvas scan={state.scan} source={state.source} pipeline={pipeline} busy={busy} toggleStage={toggleStage} addTest={addTest} openDialog={openDialog} theme={theme} error={canvasError} onRetryError={retryError} onDismissError={dismissError} selection={dialog?.type === 'transition' ? null : dialog} environments={tests.environments} browserTests={tests.browserTests} stageRemovals={tests.stageRemovals} gates={gates} autopilot={autopilot} createSandbox={createSandbox} environmentBusy={tests.busyStages} branchSwitcher={<BranchSwitcher scan={state.scan} busy={busy} onSourceSave={switchBranch} onLocalScan={scanLocal} onConfigureSource={options => openDialog({ type: 'source', connect: Boolean(options?.connect) })} />} /></ReactFlowProvider> : <div className="pipeline-canvas canvas-empty"><GitBranch size={28} /><h1>{error ? 'Could not load pipeline' : 'Connect your GitHub'}</h1>{error && <p role="alert">{error.message}</p>}<Button onClick={error ? load : () => openDialog({ type: 'source', connect: true })}>{error ? 'Try again' : <><span className="brand-mark" style={{ maskImage: 'url(/assets/providers/github.svg)' }} aria-hidden="true" />Connect GitHub</>}</Button></div>}
      </main>}
    </div>
    <PipelineDialogs dialog={page !== 'pipeline' || loading && dialog?.type === 'git-graph' ? null : dialog} onClose={closeDialog} onAppSettings={openAppSettings} scan={state.scan || { repo: { path: state.defaultRepo } }} pipeline={pipeline} onSourceSave={onSourceSave} onAction={onAction} onStageRemoved={refreshPipeline} busy={busy} />
    {page === 'pipeline' && newTest && pipeline?.stages.some(stage => stage.id === newTest) && <StageNewTest key={`${pipeline.repoPath}\n${newTest}`} repoPath={state.scan?.repo?.path!} stageId={newTest} onClose={closeNewTest} onAppSettings={openAppSettings} />}
  </>;
}

export default function App() {
  const [workspace] = useState(() => createTestWorkspace({ controller: api }));
  useEffect(() => () => workspace.dispose(), [workspace]);
  return <TestWorkspaceContext.Provider value={workspace}><PageBoundary><TooltipProvider delayDuration={200}><SidebarProvider defaultOpen={false} className="delivery-app"><PipelineApp /></SidebarProvider></TooltipProvider></PageBoundary></TestWorkspaceContext.Provider>;
}
