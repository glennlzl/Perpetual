// Secrets leave the controller's text in two ways, and both live here. `redact` knows what a secret
// looks like: one catalogue of shapes, applied to every error, log, view and model input. `hide` knows
// what a secret is: the values a process was given, replaced wherever they appear. Fixed-message
// failures (a gh or docker error mapped to one sentence) need neither: they discard the raw output.

export const REDACTED = '[REDACTED]';
const NAMES = 'token|secret|password|api[-_]?key|access[-_]?(?:key|token)|authorization';
const PEM = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/g;
const QUOTED_KEY = new RegExp(`(["'])([\\w-]*(?:${NAMES})[\\w-]*)\\1(\\s*:\\s*)(["'])([^\\r\\n]*?)\\4`, 'gi');
const NAMED_VALUE = new RegExp(`(\\b[\\w-]*(?:${NAMES})[\\w-]*\\s*[=:]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;]+)`, 'gi');
const FLAG_VALUE = new RegExp(`(--?[\\w-]*(?:${NAMES})[\\w-]*(?:\\s*=\\s*|\\s+))(?:"[^"]*"|'[^']*'|\\S+)`, 'gi');
const QUERY_VALUE = new RegExp(`([?&](?:${NAMES})=)[^&\\s"'<>]+`, 'gi');
const TOKEN_SHAPE = /\b(?:gh[pousr]_\w+|github_pat_\w+|sk-[\w-]{10,}|(?:sk|rk)_(?:live|test)_[\w-]+|rkcs_test_[\w-]+|whsec_[\w-]+|sbp_[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g;
const USER_INFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi;
// A credential written as a literal, which a repair's change may never add: a credential name set to a quoted value
// anywhere, or to an unquoted one on an env-file, YAML or shell line. A reference (`${{ secrets.X }}`, `$X`, a
// template, `process.env.X`), a URL or path without a password, or a type is not one.
const CREDENTIAL_NAME = `[\\w-]*(?:${NAMES})[\\w-]*`;
const NOT_LITERAL = '(?![$<{%/]|\\w+://)';
const QUOTED_LITERAL = new RegExp(`\\b${CREDENTIAL_NAME}["']?\\s*[=:]\\s*(["'])${NOT_LITERAL}[^"'\\s]{8,}\\1`, 'i');
const UNQUOTED_LITERAL = new RegExp(`^\\s*(?:export\\s+|-\\s+)?${CREDENTIAL_NAME}\\s*[=:]\\s*(?!["'])${NOT_LITERAL}[^\\s#]{8,}\\s*$`, 'im');

/**
 * Text with every secret-shaped value replaced by the marker: ANSI colour removed; private key and
 * certificate blocks blanked line by line, so line numbers hold; Authorization and Bearer values;
 * named values in JSON, YAML, env and CLI form (`API_KEY=…`, `"token": "…"`, `--password …`,
 * `?access_token=…`); known token shapes (GitHub, OpenAI and OpenRouter, Stripe, Supabase, AWS, JWT);
 * and user info in any URL. Ordinary text, however long, comes back unchanged.
 */
export function redact(input: unknown = ''): string {
  return String(input)
    .replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '')
    .replace(PEM, block => block.split('\n').map(() => REDACTED).join('\n'))
    .replace(/(Authorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(QUOTED_KEY, `$1$2$1$3$4${REDACTED}$4`)
    .replace(NAMED_VALUE, `$1${REDACTED}`)
    .replace(FLAG_VALUE, `$1${REDACTED}`)
    .replace(QUERY_VALUE, `$1${REDACTED}`)
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(USER_INFO, `$1${REDACTED}@`);
}

/**
 * Whether text holds a credential as a literal value: a known token shape, a URL with a password, or a credential
 * name set to a literal. In source code (`code`) an unquoted value is an expression, so only a quoted one counts.
 */
export function hasCredential(input: string, { code = false }: { code?: boolean } = {}): boolean {
  return new RegExp(TOKEN_SHAPE.source).test(input) || [...input.matchAll(USER_INFO)].some(([match]) => !/[$%{}<>]/.test(match))
    || QUOTED_LITERAL.test(input) || !code && UNQUOTED_LITERAL.test(input);
}

/**
 * A function that replaces every one of the given secret values in a text with the marker, longest
 * first, so a secret that contains another leaves no fragment. Values that are not strings, are
 * empty or are shorter than `minLength` are ignored.
 */
export function hide(secrets: Iterable<unknown>, { marker = REDACTED, minLength = 1 }: { marker?: string; minLength?: number } = {}) {
  const values = [...new Set([...secrets].filter((value): value is string => typeof value === 'string' && value.length >= Math.max(1, minLength)))].sort((a, b) => b.length - a.length);
  return (text: unknown) => values.reduce((result, value) => result.split(value).join(marker), String(text));
}

/** An error's message, redacted, then clipped to `limit` characters: redaction first, so a clip never keeps part of a secret. */
export const failureText = (error: unknown, limit: number) => redact(String((error as { message?: unknown } | null | undefined)?.message || error)).slice(0, limit);
