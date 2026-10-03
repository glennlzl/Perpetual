import { createHash } from 'node:crypto';
import { hasCredential, hasSecretLiteral, redact } from '../redaction.ts';
import type { ReadOnlyRequest, BlockedRequest } from '../../contract/browser.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A person reviews a whole fixed JSON request, never an endpoint prefix or an agent's assertion of safety. */
export function validateReadRequests(value: unknown, targetUrl: string): ReadOnlyRequest[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Add at most 10 read-only POST requests.');
  const found: ReadOnlyRequest[] = [];
  for (const item of value) {
    if (!record(item) || Object.keys(item).some(key => !['url', 'body'].includes(key))) throw new Error('Provide the URL and exact JSON body of each read-only POST request.');
    let url: URL;
    try { url = new URL(String(item.url)); } catch { throw new Error('Read-only requests need an absolute application URL.'); }
    if (typeof item.url !== 'string' || item.url.length > 2048 || !targetUrl || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || /[?#]/.test(item.url) || url.origin !== new URL(targetUrl).origin) throw new Error('Read-only request URLs must be on the application origin, without credentials or queries.');
    if (typeof item.body !== 'string' || Buffer.byteLength(item.body) > 4096) throw new Error('Use an exact JSON request body of at most 4096 bytes.');
    let body: unknown;
    try { body = JSON.parse(item.body); } catch { throw new Error('The read-only request body must be a JSON object.'); }
    if (!record(body)) throw new Error('The read-only request body must be a JSON object.');
    if (hasCredential(item.body) || hasCredential(JSON.stringify(body)) || hasSecretLiteral(item.body, [], { credentialMembers: true }) || hasCredential(url.href, { url: true })) throw new Error('Remove secrets and credentials from read-only requests.');
    if (found.some(rule => rule.url === url.href && rule.body === item.body)) throw new Error('Remove duplicate read-only requests.');
    found.push({ url: url.href, body: item.body });
  }
  return found;
}

/** Exact bytes and JSON media type; no URL-name, wildcard, batch or operation-name inference. */
export function reviewedRead(rules: readonly ReadOnlyRequest[], method: string, url: string, body: string | null | undefined, headers: Record<string, string>): boolean {
  if (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > 4096) return false;
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-?8"?)?\s*$/i.test(normalized['content-type'] ?? '')) return false;
  if (['x-http-method-override', 'x-method-override', 'x-http-method'].some(key => key in normalized)) return false;
  let candidate: URL;
  try { candidate = new URL(url); } catch { return false; }
  if (candidate.username || candidate.password || /[?#]/.test(url)) return false;
  return rules.some(rule => rule.url === candidate.href && rule.body === body);
}

/** Empty means the original method-only guard, so previous evidence with no policy remains valid. */
export function readPolicyHash(rules: readonly ReadOnlyRequest[] = [], applicationId?: string): string {
  const requests = rules.map(rule => ({ ...rule, url: applicationId ? `managed:${applicationId}:${new URL(rule.url).pathname}` : rule.url }));
  return rules.length ? createHash('sha256').update(JSON.stringify(requests.sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : a.body < b.body ? -1 : a.body > b.body ? 1 : 0))).digest('hex') : '';
}

/** Evidence excludes queries, fragments, userinfo and bodies, then passes through the shared redactor. */
export function blockedRequest(method: unknown, value: unknown, sanitize = (value: string) => redact(value, { decodeUri: true })): BlockedRequest | null {
  if (typeof method !== 'string' || !/^(POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/.test(method) || typeof value !== 'string' || value.length > 8192) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const path = url.pathname.split('/').map(segment => segment.split(';')[0]).join('/');
  return { method, url: sanitize(`${url.origin}${path}`).slice(0, 512) };
}
