// Secrets leave the controller's text in two ways, and both live here. `redact` knows what a secret
// looks like: one catalogue of shapes, applied to every error, log, view and model input. `hide` knows
// what a secret is: the values a process was given, replaced wherever they appear. Fixed-message
// failures (a gh or docker error mapped to one sentence) need neither: they discard the raw output.

export const REDACTED = '[REDACTED]';
const NAMES = 'token|secret|password|api[-_]?key|access[-_]?(?:key|token)|authorization';
// A process can stop before END; protect the remainder in that case, through the absolute end of the input.
const PEM = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|(?![\s\S]))/g;
const QUOTED_KEY = new RegExp(`(["'])([\\w-]*(?:${NAMES})[\\w-]*)\\1(\\s*:\\s*)(["'])([^\\r\\n]*?)\\4`, 'gi');
const NAMED_VALUE = new RegExp(`(\\b[\\w-]*(?:${NAMES})[\\w-]*\\s*[=:]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;]+)`, 'gi');
const FLAG_VALUE = new RegExp(`(--?[\\w-]*(?:${NAMES})[\\w-]*(?:\\s*=\\s*|\\s+))(?:"[^"]*"|'[^']*'|\\S+)`, 'gi');
const QUERY_VALUE = new RegExp(`([?&](?:${NAMES})=)[^&\\s"'<>]+`, 'gi');
const TOKEN_SHAPE = /\b(?:gh[pousr]_\w+|github_pat_\w+|sk-[\w-]{10,}|(?:sk|rk)_(?:live|test)_[\w-]+|rkcs_test_[\w-]+|whsec_[\w-]+|sbp_[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g;
// Start once per possible scheme, rather than rescanning every suffix of a long ordinary word. Any leading
// non-letter scheme characters stay in the preserved group, so embedded forms such as 1https:// keep their text.
// Require the closing @ before splitting user/password, avoiding quadratic colon backtracking when it is absent.
const USER_INFO = /(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)(?=[^\s/@]+@)[^\s/@]+:[^\s/@]+@/gi;
function literalUrlPassword(text: string): boolean {
  return [...text.matchAll(USER_INFO)].some(([match, scheme]) => {
    const userinfo = match.slice(scheme.length, -1), password = userinfo.slice(userinfo.indexOf(':') + 1);
    return !/^(?:\{\{[\w.-]+\}\}|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*)$/.test(password);
  });
}
// A credential written as a literal, which a repair's change may never add: a credential name set to a quoted value
// anywhere, or to an unquoted one on an env-file, YAML or shell line. A reference (`${{ secrets.X }}`, `$X`, a
// template, `process.env.X`), a URL or path without a password, or a type is not one.
const CREDENTIAL_NAME = `[\\w-]*(?:${NAMES})[\\w-]*`;
const CREDENTIAL_MEMBER = new RegExp(`^${CREDENTIAL_NAME}$`, 'i');
// Decode URL escapes for inspection without changing ordinary source text. Malformed escapes remain data.
const decodedUri = (text: string) => {
  for (let depth = 0; depth < 4; depth += 1) {
    const value = text.replace(/(?:%[a-f\d]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded); }
      catch { return encoded.replace(/%([0-7][a-f\d])/gi, (_, byte: string) => String.fromCharCode(Number.parseInt(byte, 16))); }
    });
    if (value === text) break; text = value;
  }
  return text;
};
const NOT_LITERAL = '(?![$<{%/]|\\w+://)';
const QUOTED_LITERAL = new RegExp(`\\b${CREDENTIAL_NAME}["']?\\s*[=:]\\s*(["'])${NOT_LITERAL}[^"'\\s]{8,}\\1`, 'i');
const UNQUOTED_LITERAL = new RegExp(`^\\s*(?:export\\s+|-\\s+)?${CREDENTIAL_NAME}\\s*[=:]\\s*(?!["'])${NOT_LITERAL}[^\\s#]{8,}\\s*$`, 'im');
const redactedLines = (text: string, marker = REDACTED) => text.split('\n').map(() => marker).join('\n');
const namedValue = (match: string, prefix: string) => prefix + redactedLines(match.slice(prefix.length));

/**
 * Text with every secret-shaped value replaced by the marker: ANSI colour removed; private key and
 * certificate blocks blanked line by line, so line numbers hold; Authorization and Bearer values;
 * named values in JSON, YAML, env and CLI form (`API_KEY=…`, `"token": "…"`, `--password …`,
 * `?access_token=…`); known token shapes (GitHub, OpenAI and OpenRouter, Stripe, Supabase, AWS, JWT);
 * and user info in any URL. Ordinary text, however long, comes back unchanged.
 */
export function redact(input: unknown = '', { decodeUri = false }: { decodeUri?: boolean } = {}): string {
  return (decodeUri ? decodedUri(String(input)) : String(input))
    .replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '')
    .replace(PEM, block => redactedLines(block))
    .replace(/(Authorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+\S+/gi, match => `Bearer ${redactedLines(match)}`)
    .replace(QUOTED_KEY, `$1$2$1$3$4${REDACTED}$4`)
    .replace(NAMED_VALUE, namedValue)
    .replace(FLAG_VALUE, namedValue)
    .replace(QUERY_VALUE, `$1${REDACTED}`)
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(USER_INFO, `$1${REDACTED}@`);
}

/**
 * Whether text holds a credential as a literal value: a known token shape, a URL with a password, or a credential
 * name set to a literal. In source code (`code`) an unquoted value is an expression, so only a quoted one counts.
 */
export function hasCredential(input: string, { code = false, url = false }: { code?: boolean; url?: boolean } = {}): boolean {
  if (url) { const value = decodedUri(input); return redact(value) !== value; }
  return new RegExp(TOKEN_SHAPE.source).test(input) || literalUrlPassword(input)
    || QUOTED_LITERAL.test(input) || !code && UNQUOTED_LITERAL.test(input);
}

/**
 * A strong secret literal in editable data: known token shapes, key/certificate blocks, literal URL
 * passwords, or a supplied secret. Ordinary values under names such as SESSION_SECRET remain valid. Every quoted JSON
 * string is decoded before inspection, including duplicate members and otherwise valid strings missing their closing quote. A field name
 * alone is not a credential rule, but can contain a known token or supplied value. No input text is rewritten. Durable fixed requests may additionally refuse credential-shaped JSON members regardless of value length; original lexemes preserve escaped and duplicate names.
 */
export function hasSecretLiteral(input: string, secrets: Iterable<unknown> = [], { credentialMembers = false }: { credentialMembers?: boolean } = {}): boolean {
  const remove = hide(secrets, { marker: '' });
  const literal = (text: string) => new RegExp(TOKEN_SHAPE.source).test(text) || new RegExp(PEM.source).test(text)
    || literalUrlPassword(text) || remove(text) !== text;
  if (literal(input)) return true;
  // Inspect the original lexemes: parsing an object first would lose duplicate members. Visit strings once without
  // recursing over the document, and let JSON decode their escapes. Ordinary unfinished drafts remain editable.
  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== '"') continue;
    let end = start + 1;
    while (end < input.length && input[end] !== '"') end += input[end] === '\\' ? 2 : 1;
    try {
      const value: unknown = JSON.parse(input.slice(start, end + 1) + (end >= input.length ? '"' : ''));
      if (typeof value === 'string' && (literal(value) || credentialMembers && CREDENTIAL_MEMBER.test(value) && input.slice(end + 1).trimStart().startsWith(':'))) return true;
    } catch { /* An invalid escape remains raw draft text. */ }
    start = end;
  }
  return false;
}

/**
 * A function that replaces every one of the given secret values in a text with the marker, longest
 * first, so a secret that contains another leaves no fragment. Values that are not strings, are
 * empty or are shorter than `minLength` are ignored. Source observations can preserve each replaced
 * value's line count so later evidence still refers to the original line.
 */
export function hide(secrets: Iterable<unknown>, { marker = REDACTED, minLength = 1, preserveLines = false }: { marker?: string; minLength?: number; preserveLines?: boolean } = {}) {
  const values = [...new Set([...secrets].filter((value): value is string => typeof value === 'string' && value.length >= Math.max(1, minLength)))].sort((a, b) => b.length - a.length);
  const replacements = values.map(value => ({ value, marker: preserveLines ? redactedLines(value, marker) : marker }));
  return (text: unknown) => replacements.reduce((result, item) => result.split(item.value).join(item.marker), String(text));
}

/** An error's message, redacted, then clipped to `limit` characters: redaction first, so a clip never keeps part of a secret. */
export const failureText = (error: unknown, limit: number) => redact(String((error as { message?: unknown } | null | undefined)?.message || error)).slice(0, limit);
