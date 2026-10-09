/** Public environment progress. Readiness is availability, never a business-test verdict. */
export interface EnvironmentHealth { checkedAt?: string; ok?: boolean; consecutiveFailures?: number; skippedInUseAt?: string }
export interface EnvironmentService { id: string; name?: string; title?: string; url?: string; status?: string; fidelity?: 'actual' | 'official-sandbox' | 'emulate'; missing?: string[] }
export interface EnvironmentAccount { id: string; label: string; username: string }
export interface StepTiming { step: string; ms: number }
/** Configuration preparation spans contain numeric observations only, never prompts or credentials. */
export interface ConfigAuthoringTiming {
  phase: 'evidence' | 'context' | 'model' | 'validation' | 'cleanup'; ms: number; call?: number;
  outcome?: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number; firstOutputMs?: number;
}
export interface EnvironmentAttempt { attempt: number; stage: 'valid' | 'build' | 'healthy' | 'answers' | 'account'; summary: string }
export interface Environment {
  id: string; stageId: string; status: string; step?: string; repoPath?: string; sourceBranch?: string | null; sourceRevision?: string | null; repair?: string; error?: string | null;
  services?: EnvironmentService[]; accounts?: EnvironmentAccount[]; sandboxId?: string; createdAt?: string; updatedAt?: string; cleanedAt?: string; health?: EnvironmentHealth;
  timings?: StepTiming[]; configTimings?: (ConfigAuthoringTiming & { attempt: number })[]; attempts?: EnvironmentAttempt[]; cleanupError?: string; cancellationRequestedAt?: string; failedStep?: string;
}
export interface EnvironmentLogs { logs: string }
export type RemovalStatus = 'queued' | 'removing' | 'completed' | 'failed';
/** Public progress of an accepted stage deletion; private source ownership is not included. */
export interface StageRemoval {
  id: string; stageId: string; status: RemovalStatus; environmentIds: string[]; completedEnvironmentIds: string[];
  createdAt: string; updatedAt: string; currentEnvironmentId?: string; error?: string; completedAt?: string;
}
export interface StageRemovalReply { removal: StageRemoval | null }
