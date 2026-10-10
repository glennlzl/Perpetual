import type { Adapter, BrokerProvider } from './broker.ts';
import type { TrialGmailProfileReply, TrialIdentityProfileReply, TrialProfileReply } from '../../contract/broker-trial.ts';

const API_ORIGIN = 'https://backend.composio.dev';
const API_PREFIX = '/api/v3.1';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const LINEAR_PROFILE_TOOL_VERSION = '20260924_00';
const SLACK_PROFILE_TOOL_VERSION = '20261008_00';
const JIRA_PROFILE_TOOL_VERSION = '20261001_00';
/** Exact Google scopes on the observed Composio-managed Gmail default auth config. */
export const COMPOSIO_GMAIL_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/profile.language.read',
  'https://www.googleapis.com/auth/user.addresses.read',
  'https://www.googleapis.com/auth/user.birthday.read',
  'https://www.googleapis.com/auth/user.emails.read',
  'https://www.googleapis.com/auth/user.phonenumbers.read',
  'https://www.googleapis.com/auth/profile.emails.read',
  'https://mail.google.com/',
] as const;
const SAFE_ERROR = 'Composio request failed.';
const REMOTE_ACCOUNT_NOT_FOUND = Symbol('remote-account-not-found');

type JsonObject = Record<string, unknown>;
export type ComposioFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ComposioAdapterOptions {
  apiKey: string;
  authConfigId: string;
  provider?: BrokerProvider;
  /** Injected in tests; production uses the built-in fetch implementation. */
  transport?: ComposioFetch;
  /** Exact provider scopes expected on the auth config. */
  expectedScopes?: readonly string[];
  /** Slack separates user-token scopes from bot scopes; this exact list is checked independently. */
  expectedUserScopes?: readonly string[];
  /** Explicitly pins the one metadata-verified profile tool this adapter may execute. */
  profileTool?: { slug: string; version: string; inputProperties: readonly string[]; requiredProperties?: readonly string[]; arguments?: JsonObject; parse(value: unknown): TrialProfileReply | TrialIdentityProfileReply | TrialGmailProfileReply | undefined };
}

export interface ComposioAdapter extends Adapter {
  /** Fail closed unless the provider's configured scope and profile-tool policy matches exactly. */
  inspectSetup(): Promise<void>;
}

function object(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeId(value: unknown): value is string {
  return boundedString(value, 256) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function identityId(value: unknown): value is string {
  return boundedString(value, 256) && value.trim() === value;
}

function scopes(value: unknown, allowEmpty = false): string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64) return undefined;
  if (!value.every(item => boundedString(item, 256))) return undefined;
  const result = [...value] as string[];
  if (new Set(result).size !== result.length) return undefined;
  return result.sort();
}

function configuredScopes(value: unknown, allowEmpty = false): string[] | undefined {
  const entries: unknown = typeof value === 'string'
    ? value.split(',').map(scope => scope.trim())
    : value;
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0) || entries.length > 64 || !entries.every(scope => boundedString(scope, 256))) return undefined;
  const result = entries as string[];
  if (new Set(result).size !== result.length) return undefined;
  return [...result].sort();
}

function exactToolAccess(value: unknown, toolSlug: string): boolean {
  if (!object(value)) return false;
  const expectedKeys = ['tools_available_for_execution', 'tools_for_connected_account_creation'];
  if (Object.keys(value).sort().join('\n') !== expectedKeys.sort().join('\n')) return false;
  const creation = value.tools_for_connected_account_creation;
  const execution = value.tools_available_for_execution;
  return Array.isArray(creation) && creation.length === 0 && Array.isArray(execution) &&
    execution.length === 1 && execution[0] === toolSlug;
}

function compatibleLegacyRestriction(value: unknown, toolSlug: string): boolean {
  return Array.isArray(value) && (value.length === 0 || value.length === 1 && value[0] === toolSlug);
}

function hasNoUserScopes(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function hasExactScopes(value: unknown, expected: readonly string[]): boolean {
  const actual = scopes(value, true);
  return actual !== undefined && actual.join('\n') === [...expected].sort().join('\n');
}

function hasExactInput(value: JsonObject | undefined, propertyNames: readonly string[], requiredNames: readonly string[]): boolean {
  if (!value || value.type !== 'object' || !object(value.properties) || Object.keys(value.properties).sort().join('\n') !== [...propertyNames].sort().join('\n')) return false;
  const required = value.required;
  if (required !== undefined && (!Array.isArray(required) || required.some(item => typeof item !== 'string') || [...required as string[]].sort().join('\n') !== [...requiredNames].sort().join('\n'))) return false;
  if (required === undefined && requiredNames.length > 0) return false;
  return value.additionalProperties === undefined || value.additionalProperties === false;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== API_ORIGIN) throw new Error(SAFE_ERROR);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) throw new Error(SAFE_ERROR);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error(SAFE_ERROR);
  if (!response.body) throw new Error(SAFE_ERROR);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(SAFE_ERROR);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(SAFE_ERROR); }
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error(SAFE_ERROR); }
}

export function createComposioAdapter(options: ComposioAdapterOptions): ComposioAdapter {
  const { apiKey, authConfigId } = options;
  const provider = options.provider ?? 'linear';
  const profileTool = options.profileTool ?? defaultProfileTool(provider);
  const toolkitSlug = provider;
  const transport = options.transport ?? fetch;
  const expectedScopes = options.expectedScopes === undefined ? undefined : scopes(options.expectedScopes, provider === 'slack');
  const expectedUserScopes = options.expectedUserScopes === undefined ? undefined : scopes(options.expectedUserScopes, true);
  if (!boundedString(apiKey, 4096) || !safeId(authConfigId) ||
      expectedScopes === undefined || provider === 'slack' && expectedUserScopes === undefined ||
      provider !== 'slack' && (expectedScopes.length === 0 || expectedUserScopes !== undefined)) throw new Error('Invalid Composio adapter configuration.');

  async function request(path: string, method: 'GET' | 'POST' | 'DELETE', body?: JsonObject, missingIsTerminal = false): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await transport(`${API_ORIGIN}${API_PREFIX}${path}`, {
        method,
        headers: {
          'x-api-key': apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
      });
      if ((method === 'DELETE' || missingIsTerminal) && response.status === 404) {
        try { await response.body?.cancel(); } catch { /* the documented not-found status is enough */ }
        return REMOTE_ACCOUNT_NOT_FOUND;
      }
      return await responseJson(response);
    } catch {
      throw new Error(SAFE_ERROR);
    } finally {
      clearTimeout(timer);
    }
  }

  async function authConfig(): Promise<JsonObject> {
    const value = await request(`/auth_configs/${encodeURIComponent(authConfigId)}`, 'GET');
    if (!object(value)) throw new Error(SAFE_ERROR);
    return value;
  }

  async function toolMetadata(): Promise<JsonObject> {
    const value = await request(`/tools/${encodeURIComponent(profileTool.slug)}?version=${encodeURIComponent(profileTool.version)}`, 'GET');
    if (!object(value)) throw new Error(SAFE_ERROR);
    return value;
  }

  async function inspectSetup(): Promise<void> {
    const [config, tool] = await Promise.all([authConfig(), toolMetadata()]);
    const toolkit = object(config.toolkit) ? config.toolkit : undefined;
    const input = object(tool.input_parameters) ? tool.input_parameters : undefined;
    const configuredScopeList = object(config.credentials) ? configuredScopes(config.credentials.scopes, provider === 'slack') : undefined;
    const toolKit = object(tool.toolkit) ? tool.toolkit : undefined;
    const access = config.tool_access_config;
    if (config.id !== authConfigId || toolkit?.slug !== toolkitSlug || config.auth_scheme !== 'OAUTH2' || config.status !== 'ENABLED' ||
        config.is_disabled === true || tool.slug !== profileTool.slug || toolKit?.slug !== toolkitSlug || !hasExactInput(input, profileTool.inputProperties, profileTool.requiredProperties ?? []) ||
        !configuredScopeList || configuredScopeList.join('\n') !== expectedScopes!.join('\n') ||
        !object(config.credentials) || (provider === 'slack'
          ? !hasExactScopes(config.credentials.user_scopes, expectedUserScopes!)
          : !hasNoUserScopes(config.credentials.user_scopes)) || !exactToolAccess(access, profileTool.slug) ||
        !compatibleLegacyRestriction(config.restrict_to_following_tools, profileTool.slug)) {
      throw new Error(`Composio ${provider} profile setup is not verified.`);
    }
  }

  async function inspectAccount(id: string, allowMissing = false): Promise<{ userId: string; toolkit: string; authConfigId: string; status: string } | undefined> {
    if (!safeId(id)) throw new Error(SAFE_ERROR);
    const value = await request(`/connected_accounts/${encodeURIComponent(id)}`, 'GET', undefined, allowMissing);
    if (value === REMOTE_ACCOUNT_NOT_FOUND) return undefined;
    if (!object(value)) throw new Error(SAFE_ERROR);
    const toolkit = object(value.toolkit) ? value.toolkit : undefined;
    const config = object(value.auth_config) ? value.auth_config : undefined;
    const experimental = object(value.experimental) ? value.experimental : undefined;
    // A missing or future sharing value cannot prove that this is a private connection.
    if (value.id !== id || !boundedString(value.user_id, 256) || !boundedString(toolkit?.slug, 128) || !safeId(config?.id) || !boundedString(value.status, 64) ||
        value.is_disabled === true || config?.is_disabled === true || experimental?.account_type !== 'PRIVATE') throw new Error(SAFE_ERROR);
    return { userId: value.user_id, toolkit: toolkit.slug, authConfigId: config.id, status: value.status };
  }

  return {
    async start(userId) {
      if (!boundedString(userId, 256)) throw new Error(SAFE_ERROR);
      await inspectSetup();
      const value = await request('/connected_accounts/link', 'POST', { auth_config_id: authConfigId, user_id: userId });
      if (!object(value) || !safeId(value.connected_account_id) || !boundedString(value.redirect_url, 4096)) throw new Error(SAFE_ERROR);
      let redirect: URL;
      try { redirect = new URL(value.redirect_url); } catch { throw new Error(SAFE_ERROR); }
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password || !['backend.composio.dev', 'connect.composio.dev'].includes(redirect.hostname.toLowerCase())) throw new Error(SAFE_ERROR);
      return { id: value.connected_account_id, redirectUrl: redirect.toString() };
    },

    async inspect(id) {
      const details = await inspectAccount(id);
      if (!details) throw new Error(SAFE_ERROR);
      return details;
    },

    async remove(id, userId, terminalStatuses) {
      if (!safeId(id) || !boundedString(userId, 256)) throw new Error(SAFE_ERROR);
      const details = await inspectAccount(id, true);
      if (!details) return 'not-found';
      if (details.userId !== userId || details.toolkit.toLowerCase() !== toolkitSlug || details.authConfigId !== authConfigId) throw new Error(SAFE_ERROR);
      if (terminalStatuses && !terminalStatuses.includes(details.status)) throw new Error(SAFE_ERROR);
      const result = await request(`/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, 'DELETE');
      if (result === REMOTE_ACCOUNT_NOT_FOUND) return 'not-found';
      if (!object(result) || result.success !== true) throw new Error(SAFE_ERROR);
      return 'removed';
    },

    async profile(id, userId) {
      if (!safeId(id) || !boundedString(userId, 256)) throw new Error(SAFE_ERROR);
      const value = await request(`/tools/execute/${encodeURIComponent(profileTool.slug)}`, 'POST', {
        connected_account_id: id,
        user_id: userId,
        version: profileTool.version,
        arguments: profileTool.arguments ?? {},
      });
      if (!object(value) || value.successful !== true || (value.error !== undefined && value.error !== null)) throw new Error(SAFE_ERROR);
      let payload: unknown = value.data;
      if (typeof payload === 'string') {
        if (!boundedString(payload, MAX_RESPONSE_BYTES)) throw new Error(SAFE_ERROR);
        try { payload = JSON.parse(payload) as unknown; } catch { throw new Error(SAFE_ERROR); }
      }
      const parsed = profileTool.parse(payload);
      if (!parsed) throw new Error(SAFE_ERROR);
      return parsed;
    },
    inspectSetup,
  };
}

function defaultProfileTool(provider: BrokerProvider): NonNullable<ComposioAdapterOptions['profileTool']> {
  if (provider === 'slack') return {
    slug: 'SLACK_WHO_AM_I', version: SLACK_PROFILE_TOOL_VERSION, inputProperties: [],
    parse: parseSlackProfile,
  };
  if (provider === 'jira') return {
    slug: 'JIRA_GET_CURRENT_USER', version: JIRA_PROFILE_TOOL_VERSION, inputProperties: ['expand'],
    parse: parseJiraProfile,
  };
  if (provider === 'gmail') throw new Error('Gmail requires its explicit profile tool policy.');
  return {
    slug: 'LINEAR_GET_CURRENT_USER', version: LINEAR_PROFILE_TOOL_VERSION, inputProperties: [],
    parse: parseLinearProfile,
  };
}

function parseLinearProfile(value: unknown): TrialProfileReply | undefined {
  if (!object(value)) return undefined;
  const hasUser = Object.hasOwn(value, 'user');
  const hasDirectViewer = Object.hasOwn(value, 'viewer');
  const nestedData = object(value.data) ? value.data : undefined;
  const hasNestedViewer = nestedData !== undefined && Object.hasOwn(nestedData, 'viewer');
  if ([hasUser, hasDirectViewer, hasNestedViewer].filter(Boolean).length !== 1) return undefined;
  const viewer = hasUser ? value.user : hasDirectViewer ? value.viewer : nestedData?.viewer;
  if (!object(viewer) || !safeId(viewer.id) || !boundedString(viewer.name, 256) || !boundedString(viewer.email, 320)) return undefined;
  return { id: viewer.id, name: viewer.name, email: viewer.email };
}

function parseSlackProfile(value: unknown): TrialIdentityProfileReply | undefined {
  if (!object(value) || !object(value.data)) return undefined;
  const userId = value.data.user_id, teamId = value.data.team_id;
  if (!safeId(userId) || !safeId(teamId)) return undefined;
  const id = `${teamId}:${userId}`;
  if (id.length > 256) return undefined;
  const displayName = boundedString(value.display_name, 320) ? value.display_name.trim() : undefined;
  const user = boundedString(value.data.user, 256) ? value.data.user.trim() : undefined;
  const team = boundedString(value.data.team, 256) ? value.data.team.trim() : undefined;
  const combinedLabel = [user, team].filter(Boolean).join(' · ');
  const label = displayName || (boundedString(combinedLabel, 320) ? combinedLabel : id);
  if (!boundedString(label, 320)) return undefined;
  return { id, label };
}

function parseJiraProfile(value: unknown): TrialIdentityProfileReply | undefined {
  if (!object(value) || value.active !== true || !identityId(value.accountId)) return undefined;
  const email = typeof value.emailAddress === 'string' && value.emailAddress.length <= 320 && !/[\u0000-\u001f\u007f]/u.test(value.emailAddress) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.emailAddress)
    ? value.emailAddress
    : undefined;
  const displayName = boundedString(value.displayName, 320) ? value.displayName.trim() : undefined;
  const label = email || displayName;
  return label ? { id: value.accountId, label } : undefined;
}
