// Secrets leave the controller's text in two ways, and both live here. `redact` knows what a secret
// looks like: one catalogue of shapes, applied to every error, log, view and model input. `hide` knows
// what a secret is: the values a process was given, replaced wherever they appear. Fixed-message
// failures (a gh or docker error mapped to one sentence) need neither: they discard the raw output. A package
// manager's config that a twin's source copies loses its credential lines instead (`withoutRegistryCredentials`), so
// the package manager reads no marker as a token.

export const REDACTED = '[REDACTED]';
// Credential names, found inside a longer name such as STRIPE_SECRET_KEY. A short one, PASS or PWD, counts only where a
// name ends, so BYPASS and PASS_COUNT are not one, and PASSWD never as the file in a path such as /etc/passwd.
// Redaction also hides the keys that read as secrets, such as ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY, which the
// change and request rules leave to ordinary values; a key that is no secret, such as a primary, foreign, cache or
// publishable key, is ordinary text.
const NAMES = 'token|secret|password|(?<!/)passwd|passphrase|(?<![a-z])(?:pass|pwd)(?![\\w-])|api[-_]?key|access[-_]?(?:key|token)|private[-_]?key|authorization';
const SECRET_NAMES = `${NAMES}|(?:encryption|signing|master|license|service[-_]?role|hmac|jwt)[-_]?key`;
const PRIVATE_KEY = '[A-Z ]*PRIVATE KEY(?: BLOCK)?';
// A process can stop before END; protect the remainder in that case, through the absolute end of the input.
const PEM = new RegExp(`-----BEGIN (?:${PRIVATE_KEY}|CERTIFICATE)-----[\\s\\S]*?(?:-----END (?:${PRIVATE_KEY}|CERTIFICATE)-----|(?![\\s\\S]))`, 'g');
// JSON members, also inside a string whose quotes are escaped, and whose value may hold escaped quotes.
const QUOTED_KEY = new RegExp(`(\\\\?["'])([\\w-]*(?:${SECRET_NAMES})[\\w-]*)\\1(\\s*:\\s*)(\\\\?["'])((?:\\\\.|[^\\\\\\r\\n])*?)\\4`, 'gi');
// A name starts where a run of name characters starts, so a long run is read once, not once per hyphen in it. A value
// ends at whitespace, keeping trailing punctuation and quotes, and in code it runs on through the quoted literal a type
// annotation is set to (`password: string = "…"`).
const QUOTED_VALUE = `"(?:\\\\.|[^"\\\\])*"|'[^']*'`, WORD = `["']*[^\\s,;"']+(?:[,;"']+[^\\s,;"']+)*`;
const NAMED_VALUE = new RegExp(`((?<![\\w-])[\\w-]*(?:${SECRET_NAMES})[\\w-]*\\s*[=:]\\s*)(?:${QUOTED_VALUE}|${WORD}(?:[ \\t]*=[ \\t]*(?:${QUOTED_VALUE}))?)`, 'gi');
// A YAML line: an unquoted value runs on over spaces, up to the next name set with = or :. A shell line's value ends at
// its first space, where its command starts (`NPM_TOKEN=… npm publish`).
const LINE_VALUE = new RegExp(`^([ \\t]*(?:-[ \\t]+)?[\\w-]*(?:${SECRET_NAMES})[\\w-]*[ \\t]*:[ \\t]*)(?!["'])${WORD}(?:[ \\t]+(?![\\w-]+[ \\t]*[=:])${WORD})*`, 'gim');
const FLAG_VALUE = new RegExp(`((?<![\\w-])--?[\\w-]*(?:${SECRET_NAMES})[\\w-]*(?:\\s*=\\s*|\\s+))(?:"[^"]*"|'[^']*'|\\S+)`, 'gi');
const QUERY_VALUE = new RegExp(`([?&](?:${SECRET_NAMES})=)[^&\\s"'<>]+`, 'gi');
// An Authorization value of any scheme. On a header line, at the start of a line or a quoted string, it runs through the
// end of the line or the closing quote. Elsewhere, as in code or passed with its quoted name (`headers.set("Authorization",
// …)`, `headers["Authorization"] = …`), it is a quoted value, or a scheme and its credential up to the space, ; , ) or }
// that ends the expression.
const AUTHORIZATION_HEADER = /((?:^[ \t>]*|["'])Authorization[ \t]*:[ \t]*)[^\s"'][^\r\n"']*/gim;
const AUTHORIZATION = /((?:Authorization\s*[:=]|\(\s*["']Authorization["']\s*,|\[\s*["']Authorization["']\s*\]\s*=)\s*)(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|`[^`\r\n]*`|(?:[\w-]+[ \t]+)?[^\s"',;)}]+(?:[,;)}]+[^\s"',;)}]+)*)/gi;
const TOKEN_SHAPE = /\b(?:gh[pousr]_\w+|github_pat_\w+|glpat-[\w-]{20,}|sk-[\w-]{10,}|(?:sk|rk)_(?:live|test)_[\w-]+|rkcs_test_[\w-]+|whsec_[\w-]+|sbp_[\w-]+|sb_secret_[\w-]+|xox[abeoprs]-[\w-]{10,}|npm_[A-Za-z0-9]{36}|AIza[\w-]{30,}|A(?:KI|SI)A[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g;
// Start once per possible scheme, rather than rescanning every suffix of a long ordinary word. Any leading
// non-letter scheme characters stay in the preserved group, so embedded forms such as 1https:// keep their text.
// User info, a user or a password alone too, ends at the last @ before the path. The user ends at ? or #, so an @ in a
// query (`https://host?email=…@…`) is no user info, while a password may hold ?, # and @. Each part is read once.
const USER_INFO = /(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)(?!@)[^\s/?#@:]*(?::[^\s/]*)?@/gi;
function literalUrlPassword(text: string): boolean {
  return [...text.matchAll(USER_INFO)].some(([match, scheme]) => {
    const userinfo = match.slice(scheme.length, -1), colon = userinfo.indexOf(':'), password = userinfo.slice(colon + 1);
    return colon >= 0 && password !== '' && !/^(?:\{\{[\w.-]+\}\}|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*)$/.test(password);
  });
}
// A credential written as a literal, which a repair's change may never add: a private key block, a credential name set
// to a quoted value anywhere (after a type annotation, and as a || or ?? fallback, too), or to an unquoted one on an
// env-file, YAML or shell line. A reference (`${{ secrets.X }}`, `$X`, a template, `process.env.X`), a URL or path
// without a password, or a type is not one.
const CREDENTIAL_NAME = `[\\w-]*(?:${NAMES})[\\w-]*`;
const CREDENTIAL_MEMBER = new RegExp(`^${CREDENTIAL_NAME}$`, 'i');
const PRIVATE_KEY_BLOCK = new RegExp(`-----BEGIN ${PRIVATE_KEY}-----`);
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
// A type annotation starts with no space, so a run of spaces is read once.
const QUOTED_LITERAL = new RegExp(`(?<![\\w-])${CREDENTIAL_NAME}["']?\\s*(?::[ \\t]*[\\w$.<>[\\]|?][\\w$.<>[\\]|? ]*?)?(?:[=:]|\\|\\|=?|\\?\\?=?)\\s*(["'\`])${NOT_LITERAL}(?:(?!\\$\\{)[^"'\`\\s]){8,}\\1`, 'i');
const UNQUOTED_LITERAL = new RegExp(`^\\s*(?:export\\s+|-\\s+)?${CREDENTIAL_NAME}\\s*[=:]\\s*(?!["'])${NOT_LITERAL}[^\\s#]{8,}\\s*$`, 'im');
const redactedLines = (text: string, marker = REDACTED) => text.split('\n').map(() => marker).join('\n');
const namedValue = (match: string, prefix: string) => prefix + redactedLines(match.slice(prefix.length));
// A package manager's setting that holds or points to a registry credential: a token, password, user name or email, a
// client certificate or its key, or a token helper. npm's and pnpm's .npmrc and Yarn 1's .yarnrc set one on a line of its
// own, scoped to a registry or not (`//registry.example/:_authToken=…`), in .yarnrc quoted and set with a space. Yarn's
// .yarnrc.yml has settings of its own, nested under a scope or registry, or in a flow mapping (`{ npmAuthToken: … }`). A
// commented-out one counts too.
const NPM_CREDENTIAL = /^\s*(?:[#;]\s*)?["']?(?:[^\s"'=]*:)?(?:_authToken|_auth|_password|username|email|certfile|keyfile|cert|key|tokenHelper)["']?(?:\s*[=:]|\s|$)/i;
const YARN_KEY = `["']?(?:npmAuthToken|npmAuthIdent|httpsCertFilePath|httpsKeyFilePath)["']?\\s*:`;
const YARN_CREDENTIAL = new RegExp(`^\\s*(?:#\\s*)?${YARN_KEY}`), YARN_FLOW_CREDENTIAL = new RegExp(`[{,]\\s*${YARN_KEY}`);
// A URL with user info, a user alone or with a password, literal or a reference: a registry or proxy that signs in.
const URL_USER = new RegExp(USER_INFO.source, 'i');
// The catalogue's time grows faster than a line's length, so a longer line of a config is removed without being read.
const CONFIG_LINE = 4096;
const indentation = (line: string) => /^[ \t]*/.exec(line)![0].length;
/**
 * How many flow collections ({…} or […]) are open after a line of YAML, `depth` being those open before it, and whether
 * one opened on it. One opens where a node starts, at the start of the line or after `: `, `- ` or `? `, and anywhere
 * inside another; quoted text and comments are skipped.
 */
function flowCollections(line: string, depth: number) {
  let start = true, opened = false, quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\' || quote === "'" && char === "'" && line[index + 1] === "'") index += 1;
      else if (char === quote) { quote = ''; start = false; }
    } else if (char === ' ' || char === '\t' || char === '\r') continue;
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    else if (start && (char === '"' || char === "'")) quote = char;
    else if ((start || depth > 0) && (char === '{' || char === '[')) { depth += 1; opened = true; start = true; }
    else if (depth > 0 && (char === '}' || char === ']')) { depth -= 1; start = false; }
    else start = depth > 0 ? char === ',' || char === ':' : ':-?'.includes(char) && /^\s?$/.test(line.slice(index + 1, index + 2));
  }
  return { depth, opened };
}

/**
 * Text with every secret-shaped value replaced by the marker: ANSI colour removed; private key and
 * certificate blocks blanked line by line, so line numbers hold; Authorization values of any scheme and
 * Bearer values; named values in JSON (escaped JSON too), YAML, env, code and CLI form (`API_KEY=…`,
 * `"token": "…"`, `password: string = "…"`, `--password …`, `?access_token=…`); known token shapes
 * (GitHub, GitLab, OpenAI and OpenRouter, Stripe, Supabase, Slack, npm, Google, AWS, JWT); and user info
 * in any URL, with or without a password. Ordinary text, however long, comes back unchanged. `names: false` leaves the
 * values after credential names and Authorization alone, for text formatted from values already redacted one
 * by one, whose `NAME: file:line` labels are not assignments; every other shape is still replaced.
 */
export function redact(input: unknown = '', { decodeUri = false, names = true, secrets = [] }: { decodeUri?: boolean; names?: boolean; secrets?: Iterable<unknown> } = {}): string {
  // A shaped substring may be only part of a supplied credential. Hide that whole value first,
  // after optional URI decoding, so shape replacements cannot leave its prefix or suffix behind.
  const values = [...secrets], known = hide(decodeUri ? [...values, ...values.filter((value): value is string => typeof value === 'string').map(decodedUri)] : values);
  const supplied = known(input);
  let text = (decodeUri ? known(decodedUri(supplied)) : supplied)
    .replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '')
    .replace(PEM, block => redactedLines(block));
  if (names) text = text.replace(AUTHORIZATION_HEADER, `$1${REDACTED}`).replace(AUTHORIZATION, `$1${REDACTED}`);
  text = text.replace(/\bBearer\s+\S+/gi, match => `Bearer ${redactedLines(match)}`);
  if (names) text = text
    .replace(QUOTED_KEY, `$1$2$1$3$4${REDACTED}$4`)
    .replace(LINE_VALUE, `$1${REDACTED}`)
    .replace(NAMED_VALUE, namedValue)
    .replace(FLAG_VALUE, namedValue)
    .replace(QUERY_VALUE, `$1${REDACTED}`);
  return text
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(USER_INFO, `$1${REDACTED}@`);
}

/** Whether text ends inside a private key or certificate block, which the next chunk of the same stream continues. */
export const openBlock = (text: string) => [...String(text).matchAll(PEM)].some(([block]) => !block.includes('-----END '));

/** Diagnostic URI text is opaque if bounded decoding leaves escapes another boundary could reveal. */
export function redactUri(input: unknown, secrets: Iterable<unknown> = []): string {
  const text = redact(input, { decodeUri: true, secrets });
  return /%[a-f\d]{2}/i.test(text) ? REDACTED : text;
}

/**
 * Whether text holds a credential as a literal value: a known token shape, a private key block, a URL with a password,
 * or a credential name set to a literal. In source code (`code`) an unquoted value is an expression, so only a quoted
 * one counts.
 */
export function hasCredential(input: string, { code = false, url = false }: { code?: boolean; url?: boolean } = {}): boolean {
  if (url) { const value = decodedUri(input); return redact(value) !== value; }
  return new RegExp(TOKEN_SHAPE.source).test(input) || PRIVATE_KEY_BLOCK.test(input) || literalUrlPassword(input)
    || QUOTED_LITERAL.test(input) || !code && UNQUOTED_LITERAL.test(input);
}

/**
 * A package manager's config without its credentials, `file` being its name (.npmrc, .yarnrc or .yarnrc.yml): each line
 * that sets a registry credential, holds a credential as a literal (a known token shape, a private key block) or a URL
 * with user info, or is over 4 KB, is removed, with the rest of a key block it opens and the lines indented beneath it,
 * which continue its value; a comment continues nothing. In YAML, a flow collection that holds one, such as
 * `{ npmAlwaysAuth: true, npmAuthToken: … }`, is removed whole, over every line it spans and with the key on its first
 * line, so the file stays YAML. Every other line, such as a registry, Yarn's nodeLinker or pnpm's hoisting, is kept as
 * written, so an install resolves as the repository's does.
 */
export function withoutRegistryCredentials(text: string, file: string): string {
  const yaml = /\.ya?ml$/i.test(file), lines = text.split('\n'), kept: string[] = [];
  const comment = yaml ? /^\s*#/ : /^\s*[#;]/, setting = yaml ? YARN_CREDENTIAL : NPM_CREDENTIAL;
  for (let index = 0; index < lines.length; index += 1) {
    // What a line sets: the line, or in YAML every line a flow collection opened on it spans.
    const first = index;
    let flow = false;
    if (yaml) for (let depth = 0; ; index += 1) {
      const open = flowCollections(lines[index], depth);
      flow ||= open.opened;
      depth = open.depth;
      if (!depth || index + 1 === lines.length) break;
    }
    const unit = lines.slice(first, index + 1);
    if (!unit.some(line => line.length > CONFIG_LINE || setting.test(line) || flow && YARN_FLOW_CREDENTIAL.test(line) || URL_USER.test(line) || hasCredential(line))) { kept.push(...unit); continue; }
    if (lines[index].includes('-----BEGIN ')) while (!lines[index].includes('-----END ') && index + 1 < lines.length) index += 1;
    if (comment.test(lines[first])) continue;
    // Blank lines inside a continued value go with it; those after it stay.
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim()) continue;
      if (indentation(lines[next]) <= indentation(lines[first])) break;
      index = next;
    }
  }
  return kept.join('\n');
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
