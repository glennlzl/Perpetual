/** Read-only provider observations. A matching commit does not establish business success. */
export interface ProviderRun { id: string | null; name: string | null; status: string | null; conclusion: string | null; sha: string | null; url?: string | null; branch?: string | null; createdAt?: string | null; matchesCommit: boolean }
export interface ProviderStatus { provider: string; status: 'connected' | 'not-connected'; detail: string; observedAt?: string; runs: ProviderRun[] }
export interface FailureDiagnosis { method: 'rule-based'; category: string; summary: string }
