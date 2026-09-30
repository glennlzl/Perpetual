import type { TwinInput, TwinService } from '../../../contract/twin.ts';
export type { TwinInput, TwinService } from '../../../contract/twin.ts';

// Twin service rows for a Sandbox stage. The controller reports the stage's twin
// services and whether each is blocked; Ready needs the stage's latest ready
// environment to report the service ready in its twin. Blocked always wins.
export type TwinStatus = 'ready' | 'blocked' | 'not-started';
export const TWIN_STATUS: Record<TwinStatus, string> = { ready: 'Ready', blocked: 'Blocked', 'not-started': 'Not started' };
export const TWIN_FIDELITY: Record<string, string> = { actual: 'Actual', 'official-sandbox': 'Official sandbox', emulate: 'Emulate' };
export const TWIN_SOURCE: Record<string, string> = { settings: 'App Settings' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `Expires Oct 1` for a provision's UTC expiry date; '' for anything else. */
export function twinExpiryLabel(expiresAt: unknown) {
  if (typeof expiresAt !== 'string' || !DATE.test(expiresAt)) return '';
  const date = new Date(`${expiresAt}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : `Expires ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

// A provisioned service connects too, so claimed keys can replace its sandbox.
export function twinServiceRows(services: TwinService[] = [], environment: { status?: string; services?: { id: string; status?: string }[] } | null = null) {
  const running = new Set(environment?.status === 'ready' ? (environment.services || []).filter(item => item.status === 'ready').map(item => item.id) : []);
  return services.map(service => {
    const status: TwinStatus = service.blocked ? 'blocked' : running.has(service.id) ? 'ready' : 'not-started';
    const missing = service.missing || [], claimUrl = service.provisioned?.claimUrl;
    return { ...service, missing, status, statusLabel: TWIN_STATUS[status], fidelityLabel: TWIN_FIDELITY[service.fidelity] || service.fidelity, sourceLabel: TWIN_SOURCE[String(service.source)] || '',
      expiresLabel: twinExpiryLabel(service.provisioned?.expiresAt), claimUrl: typeof claimUrl === 'string' && claimUrl.startsWith('https://') ? claimUrl : '',
      connectable: (status === 'blocked' && missing.length > 0) || Boolean(service.provisioned && service.keys?.length) };
  });
}

/** The key fields the user enters: the missing inputs, or the keys that replace a provisioned service's. */
export const twinKeyFields = (service: Pick<TwinService, 'missing' | 'keys'>) => service.missing?.length ? service.missing : service.keys || [];

const entered = (fields: TwinInput[], values: Record<string, unknown>) => {
  const inputs = Object.fromEntries(fields.map(input => [input.name, String(values[input.name] ?? '').trim()]));
  return fields.length && Object.values(inputs).every(Boolean) ? inputs : null;
};

/** The PUT /api/twin/inputs body for a service's key fields; null until each has a value. */
export function twinInputsRequest(service: Pick<TwinService, 'id' | 'missing' | 'keys'>, values: Record<string, unknown> = {}) {
  const inputs = entered(twinKeyFields(service), values);
  return inputs ? { service: service.id, inputs } : null;
}

/** The POST /api/twin/inputs/provision body for a service's provision inputs; null until each has a value. */
export function twinProvisionRequest(service: Pick<TwinService, 'id' | 'provision'>, values: Record<string, unknown> = {}) {
  const inputs = entered(service.provision?.inputs || [], values);
  return inputs ? { service: service.id, inputs } : null;
}

// Inputs are shared by every stage, so one save refreshes every Services list.
let revision = 0;
const listeners = new Set<() => void>();
export const twinInputsChanges = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  revision: () => revision,
  notify() { revision++; listeners.forEach(listener => listener()); },
};
