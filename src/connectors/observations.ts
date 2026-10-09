import type { ConnectorAccount, ConnectorProvider } from '../../contract/connectors.ts';

/** Controller-local observations are tied to one binding and never replace fresh authorization. */
export function createConnectorObservations() {
  const values = new Map<ConnectorProvider, { binding: string; at: number; account: ConnectorAccount }>();
  return {
    remember(provider: ConnectorProvider, binding: string, account: ConnectorAccount) {
      values.set(provider, { binding, at: Date.now(), account: structuredClone(account) });
    },
    snapshot(provider: ConnectorProvider, binding: string): ConnectorAccount {
      const value = values.get(provider);
      if (!value || value.binding !== binding) return { status: 'unverified', checking: true };
      return { ...structuredClone(value.account), ...(Date.now() - value.at >= 30_000 ? { checking: true as const } : {}) };
    },
    remove(provider: ConnectorProvider) { values.delete(provider); },
  };
}
