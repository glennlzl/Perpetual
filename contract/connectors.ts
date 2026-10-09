/** Account connections are app-wide and independent of projects. GitHub keeps its CLI connection. */
export type ConnectorProvider = 'slack' | 'linear' | 'gmail' | 'jira';
export type ConnectorStatus = 'pending' | 'connected' | 'needs-auth' | 'unverified';
export interface ConnectorAccount {
  status: ConnectorStatus;
  /** A bound account has not been verified recently; this snapshot never authorizes an operation. */
  checking?: true;
  redirectUrl?: string;
  error?: string;
  /** Browser connections are bindings to the person's own shared Composio account. */
  method?: 'browser' | 'project';
}
export interface ConnectorApp {
  provider: ConnectorProvider;
  name: string;
  account: ConnectorAccount | null;
}
export interface ConnectorsReply { configured: boolean; method?: 'browser' | 'project'; apps: ConnectorApp[] }
export interface ConnectorAuthConfig { id: string; name: string }
export interface ConnectorOptionsReply { configs: ConnectorAuthConfig[]; accounts?: ConnectorAuthConfig[] }
