import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStateFile } from '../../src/store.ts';
import { COMPOSIO_GMAIL_DEFAULT_SCOPES, createComposioAdapter } from './adapter.ts';
import { createBroker, type BrokerPrincipal, type BrokerHandler } from './broker.ts';
import { listenTrial } from './http.ts';
import { createBrokerStateStore } from './state.ts';

export async function startTrial(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.COMPOSIO_API_KEY, authConfigId = env.BROKER_TRIAL_LINEAR_AUTH_CONFIG_ID, principalsPath = env.BROKER_TRIAL_PRINCIPALS;
  if (!apiKey || !authConfigId || !principalsPath) throw new Error('Configure the trial broker credentials and pairing.');
  const raw = await readStateFile(principalsPath, { limit: 16384, invalid: 'Invalid broker pairing.' });
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) throw new Error('Invalid broker pairing.');
  const principals: BrokerPrincipal[] = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid broker pairing.');
    const value = item as Record<string, unknown>;
    if (typeof value.id !== 'string' || !/^broker-trial-[a-f0-9-]{36}$/.test(value.id) || typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash)) throw new Error('Invalid broker pairing.');
    return { id: value.id, tokenHash: value.tokenHash };
  });
  const directory = dirname(resolve(principalsPath));
  const linearAdapter = createComposioAdapter({ apiKey, authConfigId, provider: 'linear', expectedScopes: ['read'] });
  await linearAdapter.inspectSetup();
  const linearStore = await createBrokerStateStore(join(directory, 'connections.json'));
  const linear = createBroker({ adapter: linearAdapter, expectedAuthConfigId: authConfigId, provider: 'linear', principals, stateStore: linearStore });
  const handlers = new Map<string, BrokerHandler>([['linear', linear]]);
  await addProvider({ provider: 'gmail', authConfigId: env.BROKER_TRIAL_GMAIL_AUTH_CONFIG_ID,
    adapterOptions: { expectedScopes: COMPOSIO_GMAIL_DEFAULT_SCOPES,
      profileTool: { slug: 'GMAIL_GET_PROFILE', version: '20260915_00', inputProperties: ['user_id'], requiredProperties: [], arguments: { user_id: 'me' }, parse: gmailProfile } },
    filename: 'gmail-connections.json' });
  await addProvider({ provider: 'slack', authConfigId: env.BROKER_TRIAL_SLACK_AUTH_CONFIG_ID,
    adapterOptions: {
      expectedScopes: configuredScopeList(env.BROKER_TRIAL_SLACK_EXPECTED_SCOPES, true),
      expectedUserScopes: configuredScopeList(env.BROKER_TRIAL_SLACK_EXPECTED_USER_SCOPES, true),
    },
    filename: 'slack-connections.json' });
  await addProvider({ provider: 'jira', authConfigId: env.BROKER_TRIAL_JIRA_AUTH_CONFIG_ID,
    adapterOptions: { expectedScopes: configuredScopeList(env.BROKER_TRIAL_JIRA_EXPECTED_SCOPES) },
    filename: 'jira-connections.json' });
  await Promise.all([...handlers.values()].map(handler => handler.ready));
  const broker: BrokerHandler = Object.assign(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const match = /^\/trial\/(linear|gmail|slack|jira)\//u.exec(path);
    const provider = match?.[1] ?? (path.startsWith('/trial/') ? 'linear' : undefined);
    return (provider && handlers.get(provider) ? handlers.get(provider)! : linear)(request);
  }, { ready: Promise.all([...handlers.values()].map(handler => handler.ready)).then(() => {}) });
  return listenTrial(broker);

  async function addProvider({ provider, authConfigId, adapterOptions, filename }: {
    provider: 'gmail' | 'slack' | 'jira'; authConfigId?: string;
    adapterOptions: Pick<Parameters<typeof createComposioAdapter>[0], 'expectedScopes' | 'expectedUserScopes' | 'profileTool'>;
    filename: string;
  }) {
    const configId = authConfigId;
    if (!configId) return;
    if (provider === 'slack' && (adapterOptions.expectedScopes === undefined || adapterOptions.expectedUserScopes === undefined) ||
        provider === 'jira' && (!adapterOptions.expectedScopes || adapterOptions.expectedScopes.length === 0)) {
      throw new Error(`Configure the exact ${provider} OAuth scopes for the broker.`);
    }
    const adapter = createComposioAdapter({ apiKey: apiKey!, authConfigId: configId, provider, ...adapterOptions });
    await adapter.inspectSetup();
    const stateStore = await createBrokerStateStore(join(directory, filename));
    handlers.set(provider, createBroker({ adapter, expectedAuthConfigId: configId, provider, principals, stateStore }));
  }
}

function configuredScopeList(value: string | undefined, allowEmpty = false): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const list = value === '' && allowEmpty ? [] : value.split(',').map(scope => scope.trim());
  if ((!allowEmpty && list.length === 0) || list.length > 64 || list.some(scope => !scope || scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(scope)) || new Set(list).size !== list.length) {
    throw new Error('Invalid expected provider scopes.');
  }
  return list;
}

function gmailProfile(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const profile = value as Record<string, unknown>;
  const emailAddress = profile.emailAddress, historyId = profile.historyId;
  const messagesTotal = profile.messagesTotal, threadsTotal = profile.threadsTotal;
  if (typeof emailAddress !== 'string' || emailAddress.length > 320 || /[\u0000-\u001f\u007f]/u.test(emailAddress) ||
      typeof historyId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(historyId) ||
      !Number.isSafeInteger(messagesTotal) || (messagesTotal as number) < 0 || !Number.isSafeInteger(threadsTotal) || (threadsTotal as number) < 0) return undefined;
  return { emailAddress, historyId, messagesTotal: messagesTotal as number, threadsTotal: threadsTotal as number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await startTrial();
    console.log('Local connection-broker trial ready on 127.0.0.1:43179. No public listener.');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
  } catch { console.error('Trial broker could not start. Check its private configuration, Linear read-only auth config, and Composio access.'); process.exitCode = 1; }
}
