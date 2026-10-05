import type { EnvironmentAccount } from './environment.ts';
import type { ModelSettingsReply } from './settings.ts';

/** Reviewed checks are fixed input to the runner, never assertions supplied by generated code. */
export type TextCheck = { type: 'url-contains' | 'text-visible' | 'text-absent'; value: string };
export type ReadNumberCheck = { type: 'read-number'; label: string; name: string };
export type CompareNumberCheck = { type: 'compare-number'; label: string; name: string; op: '<' | '>' | '=' | '!='; than: string };
export type MilestoneCheck = TextCheck | ReadNumberCheck | CompareNumberCheck;
export interface JourneyStep { id: string; title: string; checks?: MilestoneCheck[] }
export type FinalAssertion = TextCheck;
export interface SourceEvidence { path: string; line: number }
export type Isolation = 'shared' | 'isolated';
/** Normalized editable case. Drafts carry the same fields as reviewed cases. */
export interface BrowserCase {
  id: string; name: string; goal: string; steps: JourneyStep[]; isolation: Isolation;
  preconditions: string[]; expectedOutcomes: string[]; assertions: FinalAssertion[];
  selected: boolean; needsReview: boolean; evidence: SourceEvidence[];
}
/** Immutable run snapshot projection. Older approvals are never normalized as current editable cases. */
export type CaseSummary = Pick<BrowserCase, 'id' | 'name' | 'steps' | 'isolation'>
  & Partial<Pick<BrowserCase, 'goal' | 'preconditions' | 'expectedOutcomes' | 'assertions'>>;
/** null explicitly reviews a bodyless POST with no Content-Type; a string reviews exact JSON bytes. */
export interface ReadOnlyRequest { url: string; body: string | null }
export interface BlockedRequest { method: string; url: string }
export interface BrowserConfig {
  targetUrl: string; signInUrl: string; scope: string; requirements: string; maxSteps: number;
  journeyTimeoutSeconds: number; externalOrigins: string[]; authEndpoints: string[]; readOnlyRequests?: ReadOnlyRequest[];
}
export interface BrowserPreparation { environmentId: string; status: string; createdAt: string; targetUrl?: string; runId?: string; error?: string; completedAt?: string }
export interface BrowserDiscovery { cases: BrowserCase[]; summary: string; authenticated: boolean }
export interface BrowserAnalysis extends BrowserDiscovery { createdAt: string; sourceRevision: string | null; error?: string }
export type BrowserCapabilities = ModelSettingsReply['capabilities'] & { playwright: { browserInstalled: boolean } };

export type BlockerKind = 'account' | 'fixture' | 'integration' | 'permission' | 'environment';
export interface Blocker { stepId?: string; kind: BlockerKind; evidence: string }
export type AssertionResult = FinalAssertion & { passed: boolean; resolved?: string; reached?: false };
export type JourneyVerdict = 'passed' | 'failed' | 'blocked' | 'needs_review';
export type ControlBlocker = 'shared-worker' | 'unguarded-transport';
export interface JourneyResult { caseId: string; status: JourneyVerdict | 'skipped' | 'cancelled'; engine?: 'playwright'; controlRead?: boolean; controlBlocker?: ControlBlocker; assertions: AssertionResult[]; blockers?: Blocker[]; error?: string }
export type RunStatus = JourneyVerdict | 'cancelled' | 'completed';
export type ConcurrencyLimit = 'account' | 'shared-data' | null;
export type MilestoneCheckResult = MilestoneCheck & { passed: boolean; observed?: number; resolved?: string; error?: string; provenance?: 'independent' };
/** Old recorded steps may lack a title or retain agent provenance; neither changes a verdict. */
export interface StepProgress { id: string; title?: string; status: string; evidence?: string; checks?: MilestoneCheckResult[]; provenance?: string }
export interface BrowserAction { type: string; status: string; errorCode?: string; index?: number }
/** Full action history is returned only by the full run view. Counts and revisions may predate tracking. */
export interface CaseProgress {
  id: string; caseId: string; name: string; status: string; error?: string; actions: BrowserAction[]; actionCount?: number;
  steps?: StepProgress[]; lastAction?: Pick<BrowserAction, 'type' | 'status' | 'index'>; queueReason?: string; startedAt?: string; completedAt?: string;
  frameUpdatedAt?: string; frameCapturedAt?: string; videos?: string[];
}
export interface RunProgress { revision?: number; cases: CaseProgress[] }
export type SummaryCaseProgress = Omit<CaseProgress, 'actions'>;
export interface SummaryProgress { revision?: number; cases: SummaryCaseProgress[] }
/** Older verification attempts predate independently versioned checks. */
export interface Verification { id: string; hash: string; caseHash: string; checkVersion?: number; readPolicy?: string; attempt: number; control: boolean }
/** Public run projection; historical status strings are kept. Ownership scopes, credentials and approvedCases are private. */
export interface PublicRun {
  id: string; stageId: string; mode: 'run' | 'discover'; status: string; createdAt: string; startedAt?: string; completedAt?: string;
  targetUrl: string; sourceRevision: string | null; caseIds: string[]; caseSummaries: CaseSummary[]; progress?: RunProgress; results?: JourneyResult[]; error?: string; blockedRequests?: BlockedRequest[];
  engine?: 'playwright' | 'browser-use'; concurrency?: number; effectiveConcurrency?: number; concurrencyLimit?: ConcurrencyLimit; specHashes?: Record<string, string>;
  environmentId?: string; verification?: Verification; discovery?: BrowserDiscovery; frameUpdatedAt?: string; frameCapturedAt?: string;
}
/** Source polling omits code hashes and discovery, and includes progress only for active and latest runs. */
export type RunSummary = Omit<PublicRun, 'progress' | 'specHashes' | 'discovery'> & { progress?: SummaryProgress };
export interface RunProgressReply { run: PublicRun; results: JourneyResult[]; progress: RunProgress; discovery?: BrowserDiscovery }

export interface SpecVerification { status: 'passed' | 'failed' | 'cancelled' | 'running'; passes: number; control: 'missed' | 'caught' | null; error?: string }
export interface SpecSummary {
  approved?: { hash: string; stale: boolean; approvedAt: string; provenance?: unknown };
  draft?: { hash: string; stale: boolean; provenance?: unknown; verification?: SpecVerification };
  generation?: { status: 'running' | 'failed'; step?: string; error?: string; rejected?: string };
}
export type JourneySpecs = Record<string, SpecSummary>;
/** Code text is read separately for review, never in polling summaries. */
export interface SpecCodeReply { authoring?: import('./authoring.ts').AuthoringRecord[]; approved?: { hash: string; code: string }; draft?: { hash: string; code: string } }
export interface BrowserSummaryReply { cases: BrowserCase[]; specs: JourneySpecs; runs: RunSummary[]; preparation: BrowserPreparation | null }
export interface BrowserViewReply extends Omit<BrowserSummaryReply, 'runs'> {
  config: BrowserConfig; runs: PublicRun[]; analysis: BrowserAnalysis | null; accounts: EnvironmentAccount[]; capabilities: BrowserCapabilities;
}
