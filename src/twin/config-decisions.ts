// A model chooses bounded edits; only the controller applies them to the draft and validates the result.
import type { JSONSchema7 } from 'ai';
import { checkWritten } from '../environments/generation.ts';
import { failureText, hasSecretLiteral, hide } from '../redaction.ts';
import { CONFIG, hiddenFromAuthor, MAX_CONFIG } from './authoring.ts';
import { ID, plain } from './config.ts';
import type { TwinServices } from './registry.ts';

const ROOTS = ['services', 'apps', 'install', 'fixtures', 'node'];
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_CHANGES = 48, MAX_DEPTH = 6, MAX_BLOCKERS = 16;
const CREDENTIAL = `${CONFIG} contains a credential literal. Use a service placeholder or a configured test input.`;

export const decisionSchema: JSONSchema7 = {
  type: 'object', additionalProperties: false, required: ['changes', 'blockers'],
  properties: {
    changes: { type: 'array', maxItems: MAX_CHANGES, items: {
      type: 'object', additionalProperties: false, required: ['path', 'value'],
      properties: {
        path: { type: 'array', minItems: 1, maxItems: MAX_DEPTH, items: { type: 'string', minLength: 1, maxLength: 256 },
          description: 'An existing-parent path to set in services, apps, install, fixtures or node. Set the containing object when a parent is absent. Array indexes must exist or append exactly one entry.' },
        value: { type: 'string', maxLength: MAX_CONFIG, description: 'The JSON encoding of the new value. Ordinary strings require JSON quotes. No credentials or reserved object keys.' },
      },
    } },
    blockers: { type: 'array', maxItems: MAX_BLOCKERS, items: { type: 'string', minLength: 1, maxLength: 2000 },
      description: 'Unresolved concrete configuration choices or unsupported dependencies. Missing declared credentials are preparation blockers: preserve the dependency and return valid placeholder wiring instead of blocking the candidate. Any blocker prevents applying changes.' },
  },
};

/** Exact data properties only: unknown replies cannot smuggle inherited fields, getters or extra operations. */
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function list(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const member = Object.getOwnPropertyDescriptor(value, String(index));
    if (!member || !Object.hasOwn(member, 'value')) return false;
  }
  return true;
}

function parse(text: string, secrets: string[]): unknown {
  if (Buffer.byteLength(text) > MAX_CONFIG) throw new Error(`Keep ${CONFIG} under 256 KB.`);
  // Inspect original JSON lexemes before parsing: a later duplicate member must not erase a secret or reserved key.
  if (hasSecretLiteral(text, secrets)) throw new Error(CREDENTIAL);
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '"') continue;
    let end = start + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (text.slice(end + 1).trimStart().startsWith(':')) {
      const key: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof key === 'string' && RESERVED.has(key)) throw new Error('Configuration uses a reserved object key.');
    }
    start = end;
  }
  return JSON.parse(text);
}

/** An array index is canonical and cannot create sparse data or change array properties such as length. */
function indexAt(value: unknown[], key: string, append: boolean) {
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('Configuration arrays require a numeric index.');
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= value.length + Number(append)) throw new Error('Configuration array index is outside the existing data.');
  return index;
}

function set(root: Record<string, unknown>, path: string[], value: unknown) {
  let parent: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[indexAt(parent, key, false)];
    else if (plain(parent) && Object.hasOwn(parent, key)) parent = parent[key];
    else throw new Error('Configuration edit has a missing parent; set its containing object first.');
  }
  const last = path.at(-1)!;
  if (Array.isArray(parent)) parent[indexAt(parent, last, true)] = value;
  else if (plain(parent)) parent[last] = value;
  else throw new Error('Configuration edit requires an object or array parent.');
}

export interface ConfigDecisionOptions {
  services?: TwinServices;
  secrets?: Iterable<unknown>;
  repair?: { stage: string; subject?: string };
}

/** Applies every edit or returns an error with no replacement text. The original draft is never normalized first. */
export function applyConfigDecisions(draft: string, decision: unknown, { services, secrets = [], repair }: ConfigDecisionOptions = {}):
  { text: string; error?: undefined } | { error: string; text?: undefined } {
  const hidden = hiddenFromAuthor(secrets), protect = hide(hidden);
  const refused = (error: unknown) => ({ error: failureText(protect(error instanceof Error ? error.message : error), 4000) });
  try {
    const config = parse(draft, hidden);
    if (!plain(config)) return refused('The twin config must be an object.');
    if (!fields(decision, ['changes', 'blockers']) || !list(decision.changes, MAX_CHANGES)
      || !list(decision.blockers, MAX_BLOCKERS)
      || decision.blockers.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) return refused('Return changes and blockers as bounded lists.');
    if (decision.blockers.length) return refused(`Configuration needs more information: ${decision.blockers.join('; ')}`);

    let app: string | undefined;
    if (repair) {
      const match = /^App `([^`]+)`(?:\s|$)/.exec(repair.subject ?? '');
      if (!['build', 'healthy', 'answers'].includes(repair.stage) || !match || !ID.test(match[1])
        || !plain(config.apps) || !Object.hasOwn(config.apps, match[1])) return refused('This failure has no supported app repair scope; explicit deeper analysis is required.');
      app = match[1];
    }

    for (const change of decision.changes) {
      if (!fields(change, ['path', 'value']) || !list(change.path, MAX_DEPTH) || change.path.length < 1
        || change.path.some(part => typeof part !== 'string' || !part.length || part.length > 256 || RESERVED.has(part))
        || typeof change.value !== 'string') return refused('Each configuration change requires a safe path and a JSON-encoded value.');
      const path = change.path as string[];
      if (!ROOTS.includes(path[0])) return refused('Configuration edits must target services, apps, install, fixtures or node.');
      if (app && (path.length < 2 || path[0] !== 'apps' || path[1] !== app)) return refused(`This repair may change only apps.${app}.`);
      if (hasSecretLiteral(JSON.stringify(path), hidden)) return refused(CREDENTIAL);
      set(config, path, parse(change.value, hidden));
    }
    const text = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_CONFIG) return refused(`Keep ${CONFIG} under 256 KB.`);
    if (hasSecretLiteral(text, hidden)) return refused(CREDENTIAL);
    const checked = checkWritten(text, services);
    return checked.error === undefined ? { text } : refused(checked.error);
  } catch (error) { return refused(error); }
}
