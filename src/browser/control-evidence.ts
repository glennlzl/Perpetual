import { blockedHttpMethod, blockedRequestUrl } from './read-requests.ts';
import { redactUri, REDACTED } from '../redaction.ts';
import type { ControlBlockedTransport } from '../../contract/browser.ts';

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
