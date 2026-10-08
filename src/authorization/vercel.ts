// Provider credentials stay inside the controller; callers receive identity and safe fixed failures only.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface VercelClient { id: string; secret?: string }
export interface VercelTokens { access: string; refresh?: string; expiresAt?: number; installation?: { id: string; userId: string; teamId: string | null } }
export interface VercelIdentity { id: string; name: string }
export interface VercelAuthorization {
  url(input: { callback: string; state: string; verifier: string }): string;
  exchange(input: { code: string; verifier: string; callback: string }): Promise<VercelTokens>;
  refresh(tokens: VercelTokens): Promise<VercelTokens>;
  identity(tokens: VercelTokens): Promise<VercelIdentity>;
}
const tokenReply = z.object({ access_token: z.string().min(16).max(8192).regex(/^\S+$/), refresh_token: z.string().min(16).max(8192).regex(/^\S+$/), token_type: z.literal('Bearer'), expires_in: z.number().int().min(60).max(86400), scope: z.string().max(4000) });
const userReply = z.object({ sub: z.string().min(1).max(200), preferred_username: z.string().max(200).optional(), name: z.string().max(200).optional() });
export const authorizationError = (message: string, reconnect = false) => Object.assign(new Error(message), { reconnect });

export function createVercelAuthorization(client: VercelClient, { fetcher = fetch, clock = Date.now }: { fetcher?: typeof fetch; clock?: () => number } = {}): VercelAuthorization {
  if (!/^[\w-]{1,200}$/.test(client.id)) throw authorizationError('Perpetual’s Vercel application is not configured.');
  const request = vercelRequests(fetcher);
  async function tokens(parameters: Record<string, string>): Promise<VercelTokens> {
    const value = tokenReply.safeParse(await request('/login/oauth/token', { method: 'POST', body: new URLSearchParams({ ...parameters, client_id: client.id, ...(client.secret ? { client_secret: client.secret } : {}) }) }));
    if (!value.success || !value.data.scope.split(' ').includes('offline_access')) throw authorizationError('Vercel did not grant automatic renewal. Reconnect Vercel with offline access.', true);
    return { access: value.data.access_token, refresh: value.data.refresh_token, expiresAt: clock() + value.data.expires_in * 1000 };
  }
  return {
    url({ callback, state, verifier }) {
      const query = new URLSearchParams({ client_id: client.id, redirect_uri: callback, state, response_type: 'code', scope: 'openid profile offline_access', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return `https://vercel.com/oauth/authorize?${query}`;
    },
    exchange: ({ code, verifier, callback }) => tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback }),
    refresh: previous => { if (!previous.refresh) throw authorizationError('Reconnect Vercel to renew this grant.', true); return tokens({ grant_type: 'refresh_token', refresh_token: previous.refresh }); },
    async identity(tokens) {
      // Userinfo is authenticated by the issuer; never trust an unverified ID token decoded in the client.
      const reply = userReply.safeParse(await request('/login/oauth/userinfo', { headers: { Authorization: `Bearer ${tokens.access}` } }));
      if (!reply.success) throw authorizationError('Vercel did not verify the connected account.', true);
      return { id: reply.data.sub, name: reply.data.preferred_username || reply.data.name || reply.data.sub };
    },
  };
}

function vercelRequests(fetcher: typeof fetch) {
  return async function request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(`https://api.vercel.com${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw authorizationError('Vercel did not answer the authorization request.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const refused = [400, 401, 403, 404].includes(response.status);
      throw authorizationError(refused ? 'Vercel authorization is no longer valid. Reconnect Vercel.' : 'Vercel did not answer the authorization request.', refused);
    }
    try {
    const reader = response.body?.getReader();
    if (!reader) throw authorizationError('Vercel returned an incomplete authorization reply.', true);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 64 * 1024) { await reader.cancel(); throw authorizationError('Vercel returned an invalid authorization reply.', true); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw authorizationError('Vercel returned an invalid authorization reply.', true); }
    } catch { throw authorizationError('Vercel returned an incomplete authorization reply.'); }
  };
}

/** GA Integration grants are long-lived. They do not implement refresh-token rotation. */
export function createVercelIntegration(client: { id: string; secret: string; slug: string }, { fetcher = fetch }: { fetcher?: typeof fetch } = {}): VercelAuthorization {
  if (!/^oac_[\w-]{1,196}$/.test(client.id) || !client.secret || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(client.slug)) throw authorizationError('Perpetual’s Vercel integration is not configured.');
  const request = vercelRequests(fetcher);
  const installationReply = z.object({ token_type: z.literal('Bearer'), access_token: z.string().min(16).max(8192).regex(/^\S+$/), installation_id: z.string().regex(/^icfg_[\w-]{1,200}$/), user_id: z.string().regex(/^[\w-]{1,200}$/), team_id: z.string().regex(/^team_[\w-]{1,200}$/).nullable() });
  const configurationReply = z.object({ id: z.string(), integrationId: z.string(), userId: z.string(), teamId: z.string().nullable().optional(), ownerId: z.string(), disabledAt: z.number().nullish(), deletedAt: z.number().nullish(), status: z.string().optional() });
  return {
    url({ state }) { return `https://vercel.com/integrations/${client.slug}/new?${new URLSearchParams({ state })}`; },
    async exchange({ code, callback }) {
      const reply = installationReply.safeParse(await request('/v2/oauth/access_token', { method: 'POST', body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, code, redirect_uri: callback }) }));
      if (!reply.success) throw authorizationError('Vercel did not return a valid installation grant.', true);
      return { access: reply.data.access_token, installation: { id: reply.data.installation_id, userId: reply.data.user_id, teamId: reply.data.team_id } };
    },
    async refresh() { throw authorizationError('This installation requires reconnection.', true); },
    async identity(tokens) {
      const installation = tokens.installation;
      if (!installation) throw authorizationError('Vercel did not verify the installation.', true);
      const query = installation.teamId ? `?${new URLSearchParams({ teamId: installation.teamId })}` : '';
      const reply = configurationReply.safeParse(await request(`/v1/integrations/configuration/${encodeURIComponent(installation.id)}${query}`, { headers: { Authorization: `Bearer ${tokens.access}` } }));
      if (!reply.success || reply.data.id !== installation.id || reply.data.integrationId !== client.id || reply.data.userId !== installation.userId || (reply.data.teamId ?? null) !== installation.teamId || reply.data.ownerId !== (installation.teamId ?? installation.userId) || reply.data.disabledAt || reply.data.deletedAt || reply.data.status && !['ready', 'resumed'].includes(reply.data.status)) throw authorizationError('The Vercel installation is unavailable. Reconnect Vercel.', true);
      return { id: installation.id, name: installation.teamId ?? installation.userId };
    },
  };
}
