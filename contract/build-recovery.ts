/** Recovery of an existing CI authorization failure. Credential values never enter this contract. */
export interface RecoveryRun {
  id: string;
  attempt: number;
  name: string;
  url: string;
  workflow: string | null;
  observedAt: string;
  /** References in the failed job's configuration, not proof of which credential failed or its validity. */
  secrets: string[];
  environment: string | null;
  binding: 'references' | 'unknown';
  /** A direct VERCEL_TOKEN environment reference in the failed step, not a guess from a workflow name. */
  vercelSecret?: string;
  settingsUrl: string;
}
export interface RecoveryRequest {
  runId: string;
  attempt: number;
  requestedAt: string;
  /** Metadata revision that authorized an automatic retry; never a secret value. */
  credentialRevision?: string;
  status: 'requested' | 'accepted' | 'uncertain' | 'observed' | 'refused';
}
export interface BuildRecovery {
  status: 'required' | 'verifying' | 'unconfirmed' | 'passed';
  runs: RecoveryRun[];
  requests: RecoveryRequest[];
  checkedAt?: string;
  /** First complete metadata observation, retained across restarts. */
  credentialRevision?: string;
  automation?: { status: 'watching' | 'unavailable'; reason?: string };
  credential?: ManagedCredentialView;
}

export interface ManagedCredentialView {
  provider: 'vercel';
  status: 'not-connected' | 'authorizing' | 'ready' | 'reconnect' | 'held' | 'unavailable';
  reason?: string;
  account?: string;
  canConnect: boolean;
  canDisconnect?: boolean;
  destination?: { repository: string; name: string; environment: string | null };
}
export interface CredentialAuthorizationReply { url: string }
