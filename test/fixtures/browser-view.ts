import type { BrowserCase, BrowserCapabilities, CaseProgress, JourneyResult, PublicRun, Verification } from '../../contract/browser.ts';

/** Complete wire records for presentation tests; each caller supplies only the facts it varies. */
export const browserCaseFixture = (value: Partial<BrowserCase> = {}): BrowserCase => ({
  id: 'journey', name: 'Save and reopen a workspace', goal: 'Keep the saved workspace', steps: [], isolation: 'shared',
  preconditions: [], expectedOutcomes: [], assertions: [], selected: false, needsReview: false, evidence: [], ...value,
});
export const browserCapabilitiesFixture = (value: Partial<BrowserCapabilities> = {}): BrowserCapabilities => ({
  provider: 'openrouter', model: '', escalationModel: '', baseUrl: 'https://openrouter.ai/api/v1', keyConfigured: false,
  modelConfigured: false, playwright: { browserInstalled: false }, ...value,
});
export type ProgressFixture = Pick<CaseProgress, 'id' | 'status'> & Partial<CaseProgress>;
export const caseProgressFixture = (value: ProgressFixture): CaseProgress => ({ caseId: value.id, name: value.id, actions: [], ...value });
type ResultFixture = Pick<JourneyResult, 'caseId' | 'status'> & Partial<JourneyResult>;
export const journeyResultFixture = (value: ResultFixture): JourneyResult => ({ assertions: [], ...value });
type RunFixture = Omit<Partial<PublicRun>, 'progress' | 'results' | 'verification'> & {
  progress?: { revision?: number; cases: ProgressFixture[] }; results?: ResultFixture[];
  verification?: Pick<Verification, 'id' | 'attempt' | 'control'> & Partial<Verification>;
};
export function browserRunFixture({ progress, results, verification, ...value }: RunFixture = {}): PublicRun {
  return {
    id: 'run', stageId: 'beta', mode: 'run', status: 'queued', createdAt: '2026-01-01T00:00:00Z',
    targetUrl: 'http://127.0.0.1:3000', sourceRevision: null, caseIds: [], caseSummaries: [], ...value,
    ...(progress ? { progress: { ...progress, cases: progress.cases.map(caseProgressFixture) } } : {}),
    ...(results ? { results: results.map(journeyResultFixture) } : {}),
    ...(verification ? { verification: { hash: 'a'.repeat(64), caseHash: 'b'.repeat(64), ...verification } } : {}),
  };
}
