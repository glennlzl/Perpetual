import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { REDACTED, failureText, hasCredential, hasSecretLiteral, hide, redact } from '../src/redaction.ts';

test('redact knows every secret shape once: named values, tokens, key blocks, user info', () => {
  const cases: [string, string[]][] = [
    ['Authorization: Bearer abc123 and Authorization=Basic Zm9v', ['abc123', 'Zm9v']],
    ['curl -H "Bearer tok-en-value"', ['tok-en-value']],
    ['API_KEY=abcdef\napi-key: "quoted value"\nSTRIPE_SECRET_KEY: sk_test_51H\nACCESS_TOKEN=zzz', ['abcdef', 'quoted value', 'sk_test_51H', 'zzz']],
    ['{"API_KEY":"sensitive-value","password": \'p a s s\'}', ['sensitive-value', 'p a s s']],
    ['deploy --token ghp_abcdefghijklmnop --api-key=flagvalue', ['ghp_abcdefghijklmnop', 'flagvalue']],
    ['GET /callback?access_token=q1&other=keep&api_key=q2', ['q1', 'q2']],
    ['github_pat_11AAA sk-abcdefghijklmnop sbp_0123456789 AKIAABCDEFGHIJKLMNOP eyJhbGci.eyJzdWIi.SflKxw', ['github_pat_11AAA', 'sk-abcdefghijklmnop', 'sbp_0123456789', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGci.eyJzdWIi.SflKxw']],
    ['https://u:pass@example.com postgres://postgres:secret@db/app', ['u:pass', 'postgres:secret']],
    // The controller's secrets: the browser secret in the launch link and its header, and the launch secret in its header.
    ['http://127.0.0.1:4317/#secret=link1 X-Perpetual-Browser-Secret: browser2 X-Perpetual-Secret: header3', ['link1', 'browser2', 'header3']],
  ];
  for (const [input, secrets] of cases) {
    const output = redact(input);
    for (const secret of secrets) assert.equal(output.includes(secret), false, `${JSON.stringify(input)} keeps ${secret}`);
    assert.match(output, /\[REDACTED\]/);
  }
  assert.equal(redact('other=keep'), 'other=keep');
  assert.equal(redact('\u001b[31mred\u001b[0m'), 'red', 'ANSI colour is removed.');
  const long = 'a'.repeat(220000);
  assert.equal(redact(long), long, 'Ordinary text comes back unchanged.');
  const colons = 'https://' + ':'.repeat(220000);
  assert.equal(redact(colons), colons, 'A long URL-shaped value without user info comes back unchanged.');
  assert.equal(redact(undefined), '');
});

test('a long run of name characters is read once, so a log of hyphenated or base64url text never stalls the controller', () => {
  for (const run of ['a-'.repeat(30000), '-'.repeat(60000), 'Zm9v_-YmFy'.repeat(8000), Array.from({ length: 3000 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`).join('_')]) {
    const started = performance.now();
    assert.equal(redact(run), run);
    assert.equal(redact(run, { code: true }), run);
    assert.equal(hasCredential(run), false);
    assert.equal(hasCredential(run, { code: true }), false);
    assert.ok(performance.now() - started < 2000, `${run.slice(0, 20)}… took ${Math.round(performance.now() - started)} ms`);
  }
  assert.equal(redact(`${'a-'.repeat(30000)} token=abc`), `${'a-'.repeat(30000)} token=${REDACTED}`, 'A name after the run is still found.');
  // A run of spaces after a credential name is read once too, where a type annotation could start.
  const spaced = `password:${' '.repeat(60000)}${'x'.repeat(60000)}`, started = performance.now();
  hasCredential(spaced); hasCredential(spaced, { code: true }); redact(spaced, { code: true });
  assert.ok(performance.now() - started < 2000, `A run of spaces took ${Math.round(performance.now() - started)} ms`);
  // Code reads every credential name once, even one after another or before a quote that never closes.
  for (const text of ['token: '.repeat(20000), `token = "${'x'.repeat(200000)}`, '"token": "'.repeat(10000), `https://${'$a'.repeat(50000)}@host`]) {
    const begun = performance.now();
    redact(text, { code: true });
    assert.ok(performance.now() - begun < 2000, `${text.slice(0, 20)}… took ${Math.round(performance.now() - begun)} ms`);
  }
});

// A megabyte is what the repair agent's run tool redacts at once, on the controller's event loop.
test('a megabyte run of credential names, after any prefix, is read once in every mode', () => {
  const names = 'token'.repeat(210_000), parts = 'eyJa-'.repeat(210_000);
  for (const text of [...['', '--', '-', '"', "'", '\\"', '?', '&', '=', ' '].map(prefix => prefix + names), parts, `"${parts}`]) {
    for (const [mode, read] of [['full', () => redact(text)], ['code', () => redact(text, { code: true })], ['change rules', () => hasCredential(text)], ['change rules in code', () => hasCredential(text, { code: true })]] as const) {
      const started = performance.now();
      read();
      assert.ok(performance.now() - started < 2000, `${text.slice(0, 12)}… in ${mode} took ${Math.round(performance.now() - started)} ms`);
    }
  }
  assert.equal(redact(`--${names}=fixture-literal`), `--${names}=${REDACTED}`, 'A value after the run is still found.');
  assert.equal(redact(`${names} = "fixture-literal"`, { code: true }), `${names} = ${REDACTED}`);
});

test('code keeps what follows a credential name when it is an expression, a type or a reference, and hides literals', () => {
  for (const line of [
    '  const token = getToken(username);', 'export interface Session { token: string; secret: string }', 'async function login(username: string, password: string): Promise<Session> {',
    'def verify(password: str, hashed: str) -> bool:', 'secret := os.Getenv("SECRET")', 'const apiKey = process.env.OPENAI_API_KEY;', '  max_tokens: 4096,', 'token = get_token(username)',
    "src/auth.ts(5,12): error TS2741: Property 'secret' is missing in type '{ token: string; }' but required in type 'Session'.", '    "jsonwebtoken": "^9.0.2",',
    '  headers: { Authorization: `Bearer ${token}` },', "  headers: { Authorization: 'Bearer ' + token },", '  Authorization: token,', '// Uses Bearer authentication.',
    'const url = `postgres://postgres:${password}@db:5432/app`;', 'git clone https://${GITHUB_TOKEN}@github.com/acme/app.git', 'const callback = `/callback?access_token=${token}`;',
    'curl --token "$TOKEN" https://api.example.test', "const tokenType = 'Bearer';", "secretPath = '/run/secrets/db'", 'PASSWORD="${DB_PASSWORD}"',
  ]) assert.equal(redact(line, { code: true }), line, line);
  const cases: [string, string][] = [
    ['const apiKey = "fixture-literal-1";', `const apiKey = ${REDACTED};`],
    ['const password: string = \'fixture-literal-1\';', `const password: string = ${REDACTED};`],
    ['const key = process.env.API_KEY || "fixture-literal-1";', `const key = process.env.API_KEY || ${REDACTED};`],
    ['secret := "fixture-literal-1"', `secret := ${REDACTED}`],
    ["'password' => 'fixture-literal-1',", `'password' => ${REDACTED},`],
    ['request failed: {\\"password\\":\\"fixture-literal\\"}', `request failed: {\\"password\\":\\"${REDACTED}\\"}`],
    ['export DB_PASSWORD="fixture literal value"', `export DB_PASSWORD=${REDACTED}`],
    ['deploy --password "fixture-literal-1"', `deploy --password ${REDACTED}`],
    ['GET /callback?access_token=fixture123&other=keep', `GET /callback?access_token=${REDACTED}&other=keep`],
    ['curl -H "Authorization: token 0123456789abcdef" https://api.example.test', `curl -H "Authorization: ${REDACTED}" https://api.example.test`],
    ['headers.set("Authorization", "Basic Zml4dHVyZTpsaXRlcmFs");', `headers.set("Authorization", ${REDACTED});`],
    ['request: Bearer abc123def456ghi', `request: Bearer ${REDACTED}`],
    ['postgres://user:fixture-literal@db.example.test/app', `postgres://${REDACTED}@db.example.test/app`],
    ['git clone https://0123456789abcdef@github.com/acme/app.git', `git clone https://${REDACTED}@github.com/acme/app.git`],
    [`value ghp_${'a'.repeat(36)} end`, `value ${REDACTED} end`],
    ['before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter', `before\n${REDACTED}\n${REDACTED}\n${REDACTED}\nafter`],
    // A literal goes with its quotes, and one that spans lines whatever its length, so numbered lines redacted again
    // come back the same.
    ['before\nPASSWORD="first line\nsecond line"\nafter', `before\nPASSWORD=${REDACTED}\n${REDACTED}\nafter`],
    ['password = "ab\ncd"', `password = ${REDACTED}\n${REDACTED}`],
  ];
  for (const [input, output] of cases) {
    assert.equal(redact(input, { code: true }), output, input);
    const numbered = output.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    assert.equal(redact(numbered, { code: true }), numbered, `${input} numbered`);
  }
});

test('an Authorization value of any scheme and every part of a named value or URL user info are hidden', () => {
  const cases: [string, string][] = [
    ['curl -H "Authorization: token 0123456789abcdef" https://api.example.test', `curl -H "Authorization: ${REDACTED}" https://api.example.test`],
    ['Authorization: ApiKey opaque-value-12345', `Authorization: ${REDACTED}`],
    ["headers: { Authorization: 'Bot opaque-value' }", `headers: { Authorization: ${REDACTED} }`],
    ['const password: string = "fixture-literal-1";', `const password: ${REDACTED};`],
    ['{"password":"fixture\\"literal"}', `{"password":"${REDACTED}"}`],
    ['env DB_PASSWORD=fixture,literal;tail next', `env DB_PASSWORD=${REDACTED} next`],
    ['  token: process.env.TOKEN,', `  token: ${REDACTED},`],
    ['password: correct horse battery\nother: kept', `password: ${REDACTED}\nother: kept`],
    ['token=abc user=bob', `token=${REDACTED} user=bob`],
    ['postgres://user:fixture@literal@db.example.test/app', `postgres://${REDACTED}@db.example.test/app`],
    ['REDIS_URL=redis://:fixture-literal@cache:6379/0', `REDIS_URL=redis://${REDACTED}@cache:6379/0`],
    ['git clone https://0123456789abcdef@github.com/acme/app.git', `git clone https://${REDACTED}@github.com/acme/app.git`],
    ['DATABASE_URL=postgres://app:fixture#literal@db.example.test:5432/app', `DATABASE_URL=postgres://${REDACTED}@db.example.test:5432/app`],
    ['mysql://root:fixture?literal-1@db:3306/app', `mysql://${REDACTED}@db:3306/app`],
    ['request headers: Authorization: token 0123456789abcdef, Accept: application/json', `request headers: Authorization: ${REDACTED}, Accept: application/json`],
    ['headers.set("Authorization", "Basic Zml4dHVyZTpsaXRlcmFs");', `headers.set("Authorization", ${REDACTED});`],
    ["headers['Authorization'] = 'token fixture-literal'", `headers['Authorization'] = ${REDACTED}`],
    ['fetch(url, { headers: { Authorization: `token fixture-literal` } });', `fetch(url, { headers: { Authorization: ${REDACTED} } });`],
  ];
  for (const [input, output] of cases) assert.equal(redact(input), output, input);
  const paths = 'http://localhost:3000/@vite/client https://registry.npmjs.org/@types/node webpack://@acme/app/./src/index.ts https://app.example.test?email=owner@example.test';
  assert.equal(redact(paths), paths, 'An @ after the host, or in a query, is not user info.');
  assert.equal(hasCredential(paths), false);
  assert.equal(hasCredential('REDIS_URL=redis://:fixture-literal@cache:6379/0'), true, 'A password alone is a literal URL password.');
  assert.equal(hasSecretLiteral(JSON.stringify({ url: 'redis://:fixture-literal@cache:6379/0' })), true);
  for (const url of ['postgres://app:fixture#literal@db.example.test:5432/app', 'mysql://root:fixture?literal-1@db:3306/app']) {
    assert.equal(hasCredential(url), true, `A password may hold ? or #: ${url}`);
    assert.equal(hasCredential(`const url = "${url}";`, { code: true }), true, url);
    assert.equal(hasSecretLiteral(JSON.stringify({ url })), true, url);
  }
  assert.equal(hasCredential('git clone https://user@github.com/acme/app.git'), false, 'A user alone is not a password.');
});

test('ordinary code and commands around a credential name stay readable', () => {
  const cases: [string, string][] = [
    ['  DATABASE_PASSWORD=postgres npm run test:integration', `  DATABASE_PASSWORD=${REDACTED} npm run test:integration`],
    ['  NPM_TOKEN=fixture-literal npm publish', `  NPM_TOKEN=${REDACTED} npm publish`],
    ['const authorization = req.headers.authorization; if (!authorization) return 401;', `const authorization = ${REDACTED}; if (!authorization) return 401;`],
  ];
  for (const [input, output] of cases) assert.equal(redact(input), output, input);
  // A key that is no secret: an ORM column, a markup attribute, a cache or storage key, a public client key.
  for (const line of ['id = Column(Integer, primary_key=True)', 'foreign_key: true', '<li data-key="row-1">', 'const cache_key = `user:${id}`;', 'CACHE_KEY=user-profile-v2',
    'STRIPE_PUBLISHABLE_KEY=pk_test_fixture', 'NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-anon', "cors({ allowedHeaders: ['Authorization', 'Content-Type'] })", 'cat: /etc/passwd: Permission denied']) {
    assert.equal(redact(line), line, line);
  }
});

test('common credential names, token shapes, escaped JSON and PGP key blocks are secrets too', () => {
  assert.equal(redact('request failed: {\\"password\\":\\"fixture-literal\\"}'), `request failed: {\\"password\\":\\"${REDACTED}\\"}`);
  assert.equal(redact('PRIVATE_KEY=fixture-a ENCRYPTION_KEY=fixture-b SIGNING_KEY: fixture-c'), `PRIVATE_KEY=${REDACTED} ENCRYPTION_KEY=${REDACTED} SIGNING_KEY: ${REDACTED}`);
  assert.equal(redact('SUPABASE_SERVICE_ROLE_KEY=fixture-a RAILS_MASTER_KEY=fixture-b jwt_key: fixture-c'), `SUPABASE_SERVICE_ROLE_KEY=${REDACTED} RAILS_MASTER_KEY=${REDACTED} jwt_key: ${REDACTED}`);
  assert.equal(redact('DB_PASS=fixture-a MYSQL_PWD=fixture-b passphrase: fixture-c'), `DB_PASS=${REDACTED} MYSQL_PWD=${REDACTED} passphrase: ${REDACTED}`);
  assert.equal(redact('DB_PASSWD=fixture-a passwd: fixture-b'), `DB_PASSWD=${REDACTED} passwd: ${REDACTED}`);
  assert.equal(hasCredential('DB_PASSWD=fixture-literal'), true);
  assert.equal(hasCredential('passwd: "fixture-literal-1"', { code: true }), true);
  const ordinary = 'tests_passed=12 bypass=true passenger=3 pass_count=4 npm_lifecycle_event=test';
  assert.equal(redact(ordinary), ordinary, 'A name holding PASS, or npm\'s own variables, is not a credential.');
  // Built at run time, so the file itself holds no token-shaped text.
  for (const token of [`sb_secret_${'x'.repeat(24)}`, `xoxb-${'0'.repeat(12)}-fixture-value`, `npm_${'a1'.repeat(18)}`, `AIza${'x'.repeat(35)}`, `ASIA${'X'.repeat(16)}`, `glpat-${'x'.repeat(20)}`]) {
    assert.equal(redact(`value ${token} end`), `value ${REDACTED} end`, token);
    assert.equal(hasCredential(`const value = "${token}";`, { code: true }), true, token);
  }
  const block = 'before\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\nafter';
  assert.equal(redact(block), `before\n${REDACTED}\n${REDACTED}\n${REDACTED}\nafter`);
  assert.equal(hasSecretLiteral(JSON.stringify({ value: block })), true);
  assert.equal(hasCredential('const CACHE_KEY = "user-profile-v2";', { code: true }), false, 'The change rule leaves a cache key alone.');
});

test('a change that adds a private key or a credential literal in an ordinary code form holds a credential', () => {
  for (const line of ['-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----', 'const pem = "-----BEGIN PRIVATE KEY-----\\nMIIE";',
    'const password: string = "fixture-literal-1";', 'password: Optional[str] = "fixture-literal-1"', 'const password = `fixture-literal-1`;',
    'const key = process.env.API_KEY || "fixture-literal-1";', 'process.env.API_KEY ??= "fixture-literal-1";', 'const privateKey = "fixture-literal-1";', 'DB_PASS: "fixture-literal-1"']) {
    assert.equal(hasCredential(line, { code: true }), true, line);
  }
  for (const line of ['-----BEGIN CERTIFICATE-----', 'token: string;', 'password?: string;', 'const token = `Bearer ${value}`;', 'const token = `fixture-${id}-value`;',
    'const required = ["API_KEY", "DATABASE_URL"];', 'const pwd = process.cwd();', 'const passenger = "fixture-literal-1";']) {
    assert.equal(hasCredential(line, { code: true }), false, line);
  }
});

test('a private key block is blanked line by line, so line numbers hold', () => {
  const block = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nAAAA\n-----END RSA PRIVATE KEY-----\nafter';
  assert.equal(redact(block), `before\n${REDACTED}\n${REDACTED}\n${REDACTED}\n${REDACTED}\nafter`);
});

test('an unfinished private key or certificate block stays hidden through the end of the observation', () => {
  for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'CERTIFICATE']) {
    const input = `before\n-----BEGIN ${kind}-----\npartial-body\n`;
    assert.equal(redact(input), `before\n${REDACTED}\n${REDACTED}\n${REDACTED}`);
    assert.equal(hasSecretLiteral(JSON.stringify({ value: input })), true);
  }
});

test('named and flag credentials keep every source line when their quoted value spans lines', () => {
  for (const prefix of ['API_KEY=', 'password: ', '--token ', '--password=']) {
    for (const quote of ['"', "'"]) {
      const source = `before\n${prefix}${quote}first line\nsecond line${quote}\nafter`;
      assert.equal(redact(source), `before\n${prefix}${REDACTED}\n${REDACTED}\nafter`);
    }
  }
  assert.equal(redact('before\nBearer\nsecret-value\nafter'), `before\nBearer ${REDACTED}\n${REDACTED}\nafter`);
});

test('URL passwords are hidden inside prefixed text without losing any prefix', () => {
  for (const prefix of ['prefix_', 'prefix-', '1', '.', '+', '123.-+', 'prefix_1', 'word,']) {
    assert.equal(redact(`${prefix}https://user:pass@host/path`), `${prefix}https://${REDACTED}@host/path`);
    assert.equal(hasSecretLiteral(`${prefix}https://user:pass@host/path`), true);
  }
});

test('hide replaces known values longest first, honours a marker and a minimum length, and ignores what is not a string', () => {
  assert.equal(hide(['abc', 'abcdef', undefined, '', 42])('x abcdef y abc z'), `x ${REDACTED} y ${REDACTED} z`);
  assert.equal(hide(['abc', 'abcdef'])('x abcdef y'), `x ${REDACTED} y`, 'The longer value wins, leaving no fragment.');
  assert.equal(hide(['pw'], { marker: '[redacted]', minLength: 4 })('pw pass'), 'pw pass', 'A value below the minimum is never a secret.');
  assert.equal(hide(['pass'], { marker: '[redacted]', minLength: 4 })('pw pass'), 'pw [redacted]');
  assert.equal(hide(['1234'])('count 1234'), `count ${REDACTED}`, 'Without a minimum, a four-character value is replaced.');
  assert.equal(hide([])(12), '12');
});

test('URI diagnostics hide complete supplied credentials before redacting an embedded token shape',()=>{
  const secret='private-prefix/ghp_fixtureToken/private-suffix';
  for(const value of [secret,encodeURIComponent(secret),encodeURIComponent(encodeURIComponent(secret))])assert.equal(redact(`https://app.test/${value}`,{decodeUri:true,secrets:[secret]}),'https://app.test/[REDACTED]');
});

test('URI diagnostics also hide a supplied credential whose literal escapes decode differently',()=>{
  for(const secret of ['private%21','private%2521','prefix%20ghp_fixtureToken'])for(const value of [secret,encodeURIComponent(secret),encodeURIComponent(encodeURIComponent(secret))])assert.equal(redact(`https://app.test/${value}`,{decodeUri:true,secrets:[secret]}),'https://app.test/[REDACTED]');
});

test('source observations can hide supplied multiline values without moving the following lines', () => {
  const key = 'fixture first line\nfixture second line\n';
  const source = `before\n${key}after\n`;
  assert.equal(hide([key], { preserveLines: true })(source), `before\n${REDACTED}\n${REDACTED}\n${REDACTED}after\n`);
  assert.equal(hide([key])(source), `before\n${REDACTED}after\n`, 'Other call sites retain their existing replacement behavior.');
});

test('failureText redacts before it clips, so a clipped message never keeps part of a secret', () => {
  const error = new Error(`${'x'.repeat(20)} token=${'s'.repeat(40)}`);
  assert.equal(failureText(error, 30), `${'x'.repeat(20)} token=[RE`);
  assert.equal(failureText('plain', 10), 'plain');
  assert.equal(failureText({ message: 'API_KEY=abc' }, 100), 'API_KEY=[REDACTED]');
});

test('no module keeps a redaction of its own', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('redaction.ts'));
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.split\([^)]*\)\.join\(['"]\[(?:REDACTED|redacted)\]['"]\)/, `${file} substitutes secrets by hand`);
    assert.doesNotMatch(text, /'\[REDACTED\]'/, `${file} spells the marker itself`);
  }
});

test('vendor-generated webhook and restricted keys are redacted before their values are registered',()=>{
  for(const token of ['whsec_fixture_signing_value','rkcs_test_fixture_sandbox_value','rk_test_fixture_restricted_value','rk_live_fixture_restricted_value']){
    assert.equal(redact(`generated\n${token}\n`),`generated\n${REDACTED}\n`);
    assert.ok(!failureText(new Error(`failed ${token}`),100).includes(token));
  }
});

test('editable data recognizes strong credential literals without rewriting ordinary values, keys or references', () => {
  for (const value of ['ghp_fixture_value', 'sk-or-v1-fixture-value', 'rk_test_fixture_value', 'whsec_fixture_value', 'sbp_fixture_value',
    'AKIAABCDEFGHIJKLMNOP', 'eyJhbGci.eyJzdWIi.SflKxw', 'postgres://user:literal-password@db/app',
    '-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----\nbody\n-----END CERTIFICATE-----']) {
    assert.equal(hasSecretLiteral(value), true, value);
    assert.equal(hasSecretLiteral(JSON.stringify({ value })), true, 'Encoded JSON values are inspected after decoding.');
  }
  const references = JSON.stringify({ env: { API_KEY: '{{llm.OPENAI_API_KEY}}', SESSION_SECRET: 'fixture-secret-value',
    DATABASE_URL: 'postgres://user:{{secrets.DATABASE_PASSWORD}}@db/app', SHELL: 'postgres://$USER:$PASSWORD@db/app',
    TOKEN_URL: 'https://example.test/token', FILE: '/run/secrets/app', PASSWORD: 'process.env.PASSWORD', FLAG: false, RETRIES: 3 },
  FIELD_NAME: 'ordinary value' });
  assert.equal(hasSecretLiteral(references), false, 'Ordinary credential field names and references are not literals.');
  assert.equal(hasCredential('SESSION_SECRET="fixture-secret-value"'), true, 'Repair change admission keeps its stricter named-literal policy.');
  assert.equal(hasSecretLiteral('SESSION_SECRET="fixture-secret-value"'), false);
  const supplied = 'a supplied "value"\nwith a newline';
  assert.equal(hasSecretLiteral(JSON.stringify({ value: supplied }), [null, '', 42, supplied]), true);
  assert.equal(hasSecretLiteral('{"value":"ghp_\\u0066ixture_value"}'), true, 'JSON escapes do not conceal a known shape.');
  assert.equal(hasSecretLiteral('{"ghp_\\u0066ixture_value":"ordinary"}'), true, 'A field name can itself disclose a known credential.');
  assert.equal(hasSecretLiteral('{"value":"ghp_\\u0066ixture_value",'), true, 'An incomplete draft still exposes its completed string values.');
  assert.equal(hasSecretLiteral('"ordinary text"', ['', undefined]), false);
  const depth = 20000;
  assert.equal(hasSecretLiteral('['.repeat(depth) + JSON.stringify(supplied) + ']'.repeat(depth), [supplied]), true, 'Untrusted nesting does not recurse on the call stack.');
});

test('URL credential admission examines the password reference, not punctuation elsewhere in user info', () => {
  for (const userinfo of ['user:fixture%40password', 'user:fixture$literal', 'user%40name:literal-password', '$USER:literal-password']) {
    const url = `postgres://${userinfo}@db/app`;
    assert.equal(hasSecretLiteral(JSON.stringify({ value: url })), true);
    assert.equal(hasCredential(url), true);
  }
  for (const password of ['{{database.PASSWORD}}', '${PASSWORD}', '$PASSWORD']) {
    const url = `postgres://user:${password}@db/app`;
    assert.equal(hasSecretLiteral(JSON.stringify({ value: url })), false);
    assert.equal(hasCredential(url), false);
  }
});

test('literal admission inspects every quoted value before duplicate JSON keys can discard one', () => {
  assert.equal(hasSecretLiteral('{"value":"ghp_\\u0066ixture_value","value":"ordinary"}'), true);
  assert.equal(hasSecretLiteral('{"value":"ghp_\\u0066ixture_value'), true, 'A missing closing quote does not hide otherwise decodable text.');
  assert.equal(hasSecretLiteral('{"value":"ordinary incomplete'), false);
});
