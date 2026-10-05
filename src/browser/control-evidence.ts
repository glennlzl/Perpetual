import { blockedHttpMethod, blockedRequestUrl } from './read-requests.ts';
import { redactUri, REDACTED } from '../redaction.ts';
import type { ControlBlockedTransport, ControlFailedRead } from '../../contract/browser.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate the whole bounded diagnostic list; decoded credentials are hidden before URL clipping. */
export function controlBlocks(value: unknown, secrets: Iterable<unknown> = []): ControlBlockedTransport[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) return null;
  const known = [...secrets];
  const found: ControlBlockedTransport[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.afterRead !== 'boolean') return null;
    let block: ControlBlockedTransport;
    if (item.kind === 'http') {
      if (Object.keys(item).some(key => !['kind', 'method', 'url', 'afterRead'].includes(key))) return null;
      if (item.method !== REDACTED && !blockedHttpMethod(item.method)) return null;
      if (item.url !== REDACTED && blockedRequestUrl(item.url) === null) return null;
      // Conceal full supplied values before URL parsing discards userinfo or matrix parameters.
      // If that conceals part of the origin, retain a fixed marker rather than a malformed identity.
      const url = item.url === REDACTED ? REDACTED : blockedRequestUrl(redactUri(item.url, known), text => redactUri(text, known)) ?? REDACTED;
      const method = redactUri(item.method, known);
      block = { kind: 'http', method: blockedHttpMethod(method) ? method : REDACTED, url, afterRead: item.afterRead };
    } else if (item.kind === 'socket' && item.transport === 'websocket') {
      if (Object.keys(item).some(key => !['kind', 'transport', 'afterRead'].includes(key))) return null;
      block = { kind: 'socket', transport: 'websocket', afterRead: item.afterRead };
    } else return null;
    if (!found.some(previous => JSON.stringify(previous) === JSON.stringify(block))) found.push(block);
  }
  return found;
}

const READ_TYPES: ReadonlySet<unknown> = new Set<ControlFailedRead['resourceType']>(['document', 'script', 'xhr', 'fetch', 'eventsource']);
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
/**
 * Validate the one failed read of a rejected control whole, undefined when there is none: its kind, method, origin and
 * path, and the status it answered with. Decoded credentials are hidden before URL clipping, as for blocked transports.
 */
export function controlFailedRead(value: unknown, secrets: Iterable<unknown> = []): ControlFailedRead | null | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(key => !['resourceType', 'method', 'url', 'status'].includes(key)) || !READ_TYPES.has(value.resourceType)) return null;
  if (value.method !== REDACTED && (typeof value.method !== 'string' || !METHOD.test(value.method))) return null;
  if (value.status !== undefined && (typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 100 || value.status > 599)) return null;
  if (value.url !== REDACTED && blockedRequestUrl(value.url) === null) return null;
  const known = [...secrets];
  const url = value.url === REDACTED ? REDACTED : blockedRequestUrl(redactUri(value.url, known), text => redactUri(text, known)) ?? REDACTED;
  const method = redactUri(value.method, known);
  return { resourceType: value.resourceType as ControlFailedRead['resourceType'], method: METHOD.test(method) ? method : REDACTED, url, ...(value.status === undefined ? {} : { status: value.status }) };
}
