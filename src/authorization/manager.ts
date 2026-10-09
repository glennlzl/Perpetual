// Standing authority to maintain one CI credential. Values never enter repair records, model tools or replies.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { isRepository, runGitHub } from '../github-cli.ts';
import { redact } from '../redaction.ts';
import { readRecoveryCredentials, type CredentialBinding, type CredentialInput, type CredentialSnapshot } from '../repair/credentials.ts';
import type { ManagedCredentialView, RecoveryRun } from '../../contract/build-recovery.ts';
import type { VercelAuthorization } from './vercel.ts';

export interface CredentialContext { key: string; repository: string; login: string; runs: RecoveryRun[] }
export interface CredentialAuthority { key: string; repository: string; login: string }
const identity = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) });
const tokens = z.object({ access: z.string().min(16).max(8192), refresh: z.string().min(16).max(8192).optional(), expiresAt: z.number().finite().positive().optional(), installation: z.object({ id: z.string().regex(/^icfg_[\w-]{1,200}$/), userId: z.string().regex(/^[\w-]{1,200}$/), teamId: z.string().regex(/^team_[\w-]{1,200}$/).nullable() }).optional() }).refine(value => Boolean(value.refresh && value.expiresAt && !value.installation || value.installation && !value.refresh && value.expiresAt === undefined), 'Use either a renewable grant or an installation.');
const run = z.object({ id: z.string().regex(/^\d{1,20}$/), environment: z.string().min(1).max(255).nullable(), secret: z.string().regex(/^[A-Z_][A-Z\d_]{0,99}$/) });
const binding = z.object({ id: z.string().uuid(), key: z.string().min(1).max(4096), repository: z.string().refine(isRepository), login: z.string().min(1).max(100), run,
  scope: z.enum(['repository', 'environment']), expected: z.string().nullable(), clientId: z.string().min(1).max(200),
  identity: identity.optional(), tokens: tokens.optional(), status: z.enum(['pending', 'ready', 'refreshing', 'writing', 'reconnect', 'held']), reason: z.string().max(500).optional(), checkedAt: z.number().finite().optional(), syncedAccess: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(entry => !['ready','refreshing','writing'].includes(entry.status) || Boolean(entry.tokens && entry.identity), 'Active credentials require a verified grant.');
type Binding = z.infer<typeof binding>;
const pending = z.object({ state: z.string().regex(/^[\w-]{43}$/), verifier: z.string().regex(/^[\w-]{43}$/), callback: z.string().url(), expires: z.number().finite(), bindingId: z.string().uuid(), status: z.enum(['pending', 'exchanging']) });
const schema = z.object({ version: z.literal(1), bindings: z.array(binding).max(100), pending: z.array(pending).max(20) });
type State = z.infer<typeof schema>;
const same = (binding: CredentialAuthority, authority: CredentialAuthority | null) => authority && binding.key === authority.key && binding.repository === authority.repository && binding.login === authority.login;
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const candidate = (context: CredentialContext) => {
  const eligible = context.runs.filter(run => run.binding === 'references' && run.vercelSecret && run.secrets.includes(run.vercelSecret));
  const destinations = new Set(eligible.map(run => JSON.stringify([run.environment, run.vercelSecret!.toUpperCase()])));
  return eligible.length === context.runs.length && destinations.size === 1 ? eligible[0] : null;
};
const reference = (entry: Binding): RecoveryRun => ({ id: entry.run.id, attempt: 1, name: 'Workflow', url: '', workflow: null, observedAt: '', secrets: [entry.run.secret], environment: entry.run.environment, binding: 'references', settingsUrl: '' });

export async function createCredentialManager({ dataDir, clientId, provider, authority, metadata = readRecoveryCredentials, write = writeSecret, clock = Date.now }: {
  dataDir: string; clientId?: string; provider?: VercelAuthorization; authority(): Promise<CredentialAuthority | null>;
  metadata?(input: CredentialInput): Promise<CredentialSnapshot>; write?(entry: { repository: string; name: string; environment: string | null }, value: string): Promise<void>; clock?: () => number;
}) {
  const directory = await privateDirectory(join(dataDir, 'credentials'), 'Credential storage must be a private directory.');
  const file = join(directory, 'state.json'), queue = createSaveQueue();
  const raw = await readStateFile(file, { limit: 4 * 1024 * 1024, invalid: 'Credential storage is invalid.' });
  const parsed = raw === undefined ? undefined : schema.safeParse(raw);
  if (parsed && !parsed.success) throw new Error('Credential storage is invalid.');
  let state: State = parsed?.success ? parsed.data : { version: 1, bindings: [], pending: [] };
  let closed = false;
  const persist = () => writeStateFile(file, JSON.stringify(state));
  for (const entry of state.bindings) {
    if (entry.status === 'pending' && state.pending.some(request => request.bindingId === entry.id && (request.status === 'exchanging' || request.expires <= clock()))) { entry.status = 'reconnect'; entry.reason = 'Authorization was interrupted or expired. Reconnect Vercel.'; }
    if (entry.status === 'refreshing') { entry.status = 'reconnect'; entry.reason = 'Renewal was interrupted. Reconnect Vercel.'; }
    if (entry.status === 'writing') { entry.status = 'held'; entry.reason = 'GitHub did not confirm the credential update. Reconnect Vercel to resume.'; }
  }
  if (raw !== undefined) await persist();
  const selected = (context: CredentialContext) => {
    const ref = candidate(context);
    return ref ? state.bindings.find(entry => same(entry, context) && entry.run.secret === ref.vercelSecret!.toUpperCase() && entry.run.environment === ref.environment) : undefined;
  };
  function view(context: CredentialContext): ManagedCredentialView | undefined {
    if (!candidate(context)) return undefined;
    if (!provider || !clientId) return { provider: 'vercel', status: 'unavailable', canConnect: false, canDisconnect: Boolean(selected(context)), reason: 'Perpetual’s Vercel connection needs application setup.' };
    const entry = selected(context);
    if (!entry) { const ref = candidate(context)!; return { provider: 'vercel', status: 'not-connected', canConnect: true, destination: { repository: context.repository, name: ref.vercelSecret!, environment: ref.environment } }; }
    const expired = state.pending.some(request => request.bindingId === entry.id && request.expires <= clock());
    const status = entry.clientId !== clientId || entry.status === 'pending' && expired ? 'reconnect' : entry.status === 'pending' ? 'authorizing' : entry.status === 'refreshing' || entry.status === 'writing' ? 'authorizing' : entry.status;
    return { provider: 'vercel', status, canConnect: status === 'reconnect' || status === 'held', canDisconnect: true, destination: { repository: entry.repository, name: entry.run.secret, environment: entry.scope === 'environment' ? entry.run.environment : null }, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.identity ? { account: redact(entry.identity.name) } : {}) };
  }
  async function effective(entry: Binding): Promise<CredentialBinding> {
    const result = await metadata({ repository: entry.repository, runs: [reference(entry)] });
    if (!('revision' in result) || !result.bindings || result.bindings.length !== 1) throw new Error('GitHub did not verify the credential destination.');
    return result.bindings[0];
  }
  async function admitted(entry: Binding) {
    if (closed || !same(entry, await authority())) throw new Error('The GitHub account or Project changed.');
  }
  async function maintain(entry: Binding) {
    if (!provider || entry.clientId !== clientId || entry.status !== 'ready' || !entry.tokens || !entry.identity) return;
    await admitted(entry);
    const before = await effective(entry);
    if (before.scope !== entry.scope && before.scope !== 'missing' || (before.updatedAt ?? null) !== entry.expected) {
      entry.status = 'held'; entry.reason = 'The credential was changed outside Perpetual. Reconnect Vercel to resume.'; await persist(); return;
    }
    if (entry.tokens.expiresAt !== undefined && entry.tokens.expiresAt - clock() <= 15 * 60_000) {
      // The provider rotates single-use refresh tokens. Save intent before the request; uncertainty never replays it.
      entry.status = 'refreshing'; await persist();
      try {
        const next = await provider.refresh(entry.tokens);
        const account = await provider.identity(next);
        if (account.id !== entry.identity.id) throw new Error('Vercel returned a different account.');
        entry.tokens = next; entry.status = 'ready'; delete entry.reason; await persist();
      } catch {
        entry.status = 'reconnect'; entry.reason = 'Vercel could not renew access. Reconnect Vercel.'; await persist(); return;
      }
    }
    if (entry.tokens.installation && (!entry.checkedAt || clock() - entry.checkedAt >= 5 * 60_000)) {
      try {
        const account = await provider.identity(entry.tokens);
        if (account.id !== entry.identity.id) throw new Error('The installation changed.');
        entry.checkedAt = clock(); await persist();
      } catch (failure) {
        if (!failure || typeof failure !== 'object' || !('reconnect' in failure) || failure.reconnect !== true) throw new Error('Vercel access could not be checked.');
        entry.status = 'reconnect'; entry.reason = 'The Vercel installation is unavailable. Reconnect Vercel.'; await persist(); return;
      }
    }
    if (entry.syncedAccess === fingerprint(entry.tokens.access)) return;
    await admitted(entry);
    const latest = await effective(entry);
    if (latest.scope !== before.scope || latest.updatedAt !== before.updatedAt) { entry.status = 'held'; entry.reason = 'The credential destination changed. Reconnect Vercel to resume.'; await persist(); return; }
    entry.status = 'writing'; await persist();
    try {
      await admitted(entry);
      await write({ repository: entry.repository, name: entry.run.secret, environment: entry.scope === 'environment' ? entry.run.environment : null }, entry.tokens.access);
      const after = await effective(entry);
      if (after.scope !== entry.scope || !after.updatedAt) throw new Error('Credential update could not be observed.');
      entry.expected = after.updatedAt; entry.syncedAccess = fingerprint(entry.tokens.access); entry.status = 'ready'; delete entry.reason; await persist();
    } catch {
      entry.status = 'held'; entry.reason = 'GitHub did not confirm the credential update. Reconnect Vercel to resume.'; await persist();
    }
  }
  return {
    view,
    async begin(context: CredentialContext, callback: string): Promise<string> {
      return queue.run(async () => {
        if (closed || !provider || !clientId) throw new Error('Perpetual’s Vercel connection needs application setup.');
        const ref = candidate(context), address = URL.parse(callback);
        if (!ref || !address || address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.pathname !== '/authorization/vercel/callback' || address.search || address.hash || address.username || address.password) throw new Error('The Vercel credential binding is unverified.');
        if (!same(context, await authority())) throw new Error('The GitHub account or Project changed.');
        const entry: Binding = { id: randomUUID(), key:context.key,repository:context.repository,login:context.login, clientId, run: { id: ref.id, secret: ref.vercelSecret!.toUpperCase(), environment: ref.environment }, scope: 'repository', expected: null, status: 'pending' };
        const destination = await effective(entry);
        if (destination.scope === 'organization') throw new Error('This credential belongs to the GitHub organization. Its owner must authorize recovery.');
        // A missing credential in an environment remains scoped to that environment, never the whole organization.
        entry.scope = destination.scope === 'environment' || destination.scope === 'missing' && ref.environment ? 'environment' : 'repository';
        entry.expected = destination.updatedAt ?? null;
        const previous = selected(context);
        if (previous && ['ready', 'refreshing', 'writing'].includes(previous.status)) throw new Error('Vercel access is already managed.');
        // One controller must not maintain conflicting values for the same GitHub secret.
        if (state.bindings.some(item => item.id !== previous?.id && item.repository === entry.repository && item.run.secret === entry.run.secret && item.scope === entry.scope && (entry.scope !== 'environment' || item.run.environment === entry.run.environment))) throw new Error('Another Project already manages this credential.');
        if (previous) { state.bindings = state.bindings.filter(item => item.id !== previous.id); state.pending = state.pending.filter(item => item.bindingId !== previous.id); }
        if (state.bindings.length >= 100) throw new Error('Too many managed credentials.');
        const request = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), callback, expires: clock() + 10 * 60_000, bindingId: entry.id, status: 'pending' as const };
        state.bindings.push(entry); state.pending = [...state.pending.filter(item => item.expires > clock()).slice(-19), request];
        await persist();
        return provider.url({ callback, state: request.state, verifier: request.verifier });
      });
    },
    async complete(input: { state: string; code: string; callback: string }) {
      return queue.run(async () => {
        const request = state.pending.find(item => item.state === input.state), entry = state.bindings.find(item => item.id === request?.bindingId);
        if (closed || !provider || !request || !entry || request.status !== 'pending' || request.expires < clock() || request.callback !== input.callback || entry.clientId !== clientId || !input.code || input.code.length > 8192) throw new Error('This authorization link expired. Reconnect Vercel.');
        await admitted(entry);
        request.status = 'exchanging'; await persist();
        try {
          const grant = await provider.exchange({ code: input.code, verifier: request.verifier, callback: request.callback });
          const account = await provider.identity(grant);
          await admitted(entry);
          entry.tokens = grant; entry.identity = account; entry.checkedAt = clock(); entry.status = 'ready'; delete entry.reason;
          state.pending = state.pending.filter(item => item !== request); await persist();
          await maintain(entry);
        } catch {
          entry.status = 'reconnect'; entry.reason = 'Vercel authorization did not finish. Reconnect Vercel.'; await persist();
          throw new Error(entry.reason);
        }
      });
    },
    async check() {
      return queue.run(async () => {
        for (const entry of state.bindings) {
          if (closed) break;
          if (entry.status === 'pending' && state.pending.some(request => request.bindingId === entry.id && request.expires <= clock())) { entry.status = 'reconnect'; entry.reason = 'Authorization expired. Reconnect Vercel.'; await persist(); }
          try { await maintain(entry); } catch { /* Read failures retry at the next controller observation without writes. */ }
        }
      });
    },
    async disable(context: CredentialContext) {
      return queue.run(async () => {
        if (closed || !same(context, await authority())) throw new Error('The GitHub account or Project changed.');
        const entry = selected(context);
        if (!entry) return;
        state.bindings = state.bindings.filter(item => item !== entry);
        state.pending = state.pending.filter(item => item.bindingId !== entry.id);
        await persist();
      });
    },
    async close() { closed = true; await queue.idle(); },
  };
}

async function writeSecret(input: { repository: string; name: string; environment: string | null }, value: string) {
  try {
    await runGitHub(['secret', 'set', input.name, '--repo', input.repository, '--app', 'actions', ...(input.environment ? ['--env', input.environment] : [])], { input: value, timeout: 20_000, maxBuffer: 64 * 1024 });
  } catch { throw new Error('GitHub did not confirm the credential update.'); }
}
