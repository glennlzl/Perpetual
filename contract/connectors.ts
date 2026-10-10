/** App-wide direct service connections. GitHub uses its verified CLI account. */
export type ConnectorProvider = 'slack' | 'linear' | 'gmail' | 'jira';
export type ConnectorStatus = 'pending' | 'connected' | 'needs-auth' | 'unverified';
export interface ConnectorAccount {
  status: ConnectorStatus;
  /** A bound account has not been verified recently; this snapshot never authorizes an operation. */
  checking?: true;
  redirectUrl?: string;
  error?: string;
  label?: string;
}
export interface ConnectorApp {
  provider: ConnectorProvider;
  name: string;
  configured: boolean;
  setupError?: string;
  account: ConnectorAccount | null;
}
export interface ConnectorsReply { apps: ConnectorApp[] }
