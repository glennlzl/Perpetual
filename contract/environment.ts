/** Public environment progress. Readiness is availability, never a business-test verdict. */
export interface EnvironmentHealth { checkedAt?: string; ok?: boolean; consecutiveFailures?: number; skippedInUseAt?: string }
export interface EnvironmentService { id: string; name?: string; title?: string; url?: string; status?: string; fidelity?: 'actual' | 'official-sandbox' | 'emulate'; missing?: string[] }
export interface EnvironmentAccount { id: string; label: string; username: string }
export interface StepTiming { step: string; ms: number }
export interface EnvironmentAttempt { attempt: number; stage: 'valid' | 'build' | 'healthy' | 'answers' | 'account'; summary: string }
export interface Environment {
  id: string; stageId: string; status: string; step?: string; repoPath?: string; sourceBranch?: string | null; sourceRevision?: string | null; repair?: string; error?: string | null;
  services?: EnvironmentService[]; accounts?: EnvironmentAccount[]; sandboxId?: string; createdAt?: string; updatedAt?: string; cleanedAt?: string; health?: EnvironmentHealth;
  timings?: StepTiming[]; attempts?: EnvironmentAttempt[]; cleanupError?: string; cancellationRequestedAt?: string; failedStep?: string;
}
export interface EnvironmentLogs { logs: string }
