import test from 'node:test';
import assert from 'node:assert/strict';
import { leaveOutBlocked, placeholders, resolvePlaceholders, setupOrder, validateTwinConfig } from '../src/twin/config.ts';
import { idError } from '../src/twin/options.ts';
import { services } from './fixtures/twin/services.ts';
import type { Placeholder } from '../src/twin/config.ts';

const validate = (config: unknown) => validateTwinConfig(config, { services });
const config = () => ({
  services: { jobs: { database: '{{database.DATABASE_URL}}' }, payments: { webhook: '{{apps.api.url}}/webhook' }, database: null },
  apps: {
    web: { directory: './web/', build: 'pnpm build', start: 'pnpm start', port: 3000, env: { NEXT_PUBLIC_API_URL: '{{apps.api.url}}', RETRIES: 3 } },
    api: { directory: 'api', start: 'node server.js', port: 8080 },
  },
  fixtures: [{ service: 'database', sql: './seed/twin.sql' }, { service: 'database', query: ' select 1; ' }, { service: 'jobs', command: 'pnpm seed' }],
});

test('Twin config normalizes apps, options and fixtures', () => {
  const result = validate(config());
  assert.deepEqual(result.services.database, {});
  assert.deepEqual(result.apps.web, { directory: 'web', build: 'pnpm build', start: 'pnpm start', port: 3000, env: { NEXT_PUBLIC_API_URL: '{{apps.api.url}}', RETRIES: '3' } });
  assert.deepEqual(result.apps.api, { directory: 'api', start: 'node server.js', port: 8080, env: {} });
  assert.deepEqual(result.fixtures, [{ service: 'database', sql: 'seed/twin.sql' }, { service: 'database', query: 'select 1;' }, { service: 'jobs', command: 'pnpm seed' }]);
  assert.deepEqual(validate({}), { services: {}, apps: {}, fixtures: [] });
});

test('An install step is normalized like an app directory and command', () => {
  assert.deepEqual(validate({ install: { directory: './', command: ' npm ci ' } }).install, { directory: '.', command: 'npm ci' });
  assert.deepEqual(validate({ install: { command: 'pnpm install --frozen-lockfile' } }).install, { directory: '.', command: 'pnpm install --frozen-lockfile' });
  assert.equal(Object.hasOwn(validate({ install: null }), 'install'), false);
  // Without an install step, "install" stays an ordinary app id.
  assert.deepEqual(Object.keys(validate({ apps: { install: { start: 'x', port: 1 } } }).apps), ['install']);
  const cases = [
    [{ install: 'npm ci' }, /install must be an object with directory and command/],
    [{ install: { command: 'npm ci', build: 'x' } }, /install has unsupported field build; use directory, command/],
    [{ install: { directory: 'web' } }, /install\.command must be a non-empty command/],
    [{ install: { directory: '../outside', command: 'npm ci' } }, /install\.directory must stay inside/],
    [{ install: { command: 'npm ci' }, apps: { install: { start: 'x', port: 1 } } }, /App "install" has the same name as the install step/],
  ];
  for (const [input, error] of cases) assert.throws(() => validate(input), error);
});

test('Setup order follows service placeholders and keeps config order otherwise', () => {
  assert.deepEqual(setupOrder(validate(config())), ['database', 'jobs', 'payments']);
  const chained = validate({ services: { payments: { webhook: '{{jobs.JOBS_API_URL}}' }, mail: {}, jobs: { database: '{{database.DATABASE_URL}}' }, database: {} } });
  assert.deepEqual(setupOrder(chained), ['database', 'jobs', 'payments', 'mail']);
});

test('App placeholders never order setup, so apps and services may reference each other', () => {
  const result = validate({ services: { payments: { webhook: '{{apps.api.url}}' } }, apps: { api: { start: 'x', port: 1, env: { KEY: '{{payments.PAYMENTS_KEY}}' } } } });
  assert.deepEqual(setupOrder(result), ['payments']);
});

test('Circular placeholders are rejected with the cycle spelled out', () => {
  assert.throws(() => validate({ services: { jobs: { database: '{{payments.PAYMENTS_KEY}}' }, payments: { webhook: '{{jobs.JOBS_API_URL}}' } } }),
    /Circular placeholders: jobs -> payments -> jobs\./);
  assert.throws(() => validate({ services: { mail: { from: '{{mail.SMTP_HOST}}' } } }), /Circular placeholders: mail -> mail\./);
  assert.throws(() => validate({ services: { mail: { a: '{{jobs.X}}' }, jobs: { b: ['{{database.Y}}'] }, database: { c: { d: '{{mail.Z}}' } } } }),
    /mail -> jobs -> database -> mail/);
});

test('Unknown services, apps and placeholders are rejected with readable errors', () => {
  const cases = [
    [{ services: { cache: {} } }, /Unknown service "cache"; supported services are database, mail, payments, jobs\./],
    [{ services: { jobs: { database: '{{database.DATABASE_URL}}' } } }, /services\.jobs\.database references \{\{database\.DATABASE_URL\}\}, but service "database" is not configured/],
    [{ services: { payments: { webhook: '{{apps.api.url}}' } } }, /services\.payments\.webhook references \{\{apps\.api\.url\}\}, but no app "api" is configured/],
    [{ apps: { web: { start: 'x', port: 1, env: { A: '{{apps.web.port}}' } } } }, /apps\.web\.env\.A: \{\{apps\.web\.port\}\} is not a placeholder/],
    [{ apps: { web: { start: 'x', port: 1, env: { A: '{{ secret }}' } } } }, /is not a placeholder/],
    [{ services: {}, mail: {}, apps: { web: { start: 'x', port: 1 } } }, /The twin config has mail beside services; it is a service: move "mail" into "services"\./],
    [{ apps: { web: { start: 'x', port: 1, env: { A: '{{mail.SMTP_HOST}}' } } } }, /service "mail" is not configured/],
    [{ other: {} }, /unsupported field other/],
    [{ apps: { Web: { start: 'x', port: 1 } } }, /App id "Web"/],
    [{ services: { mail: {} }, apps: { mail: { start: 'x', port: 1 } } }, /same id as a service/],
    [{ apps: { web: { start: 'x', port: 70000 } } }, /apps\.web\.port/],
    [{ apps: { web: { start: ' ', port: 1 } } }, /apps\.web\.start/],
    [{ apps: { web: { start: 'x', port: 1, directory: '../outside' } } }, /apps\.web\.directory must stay inside/],
    [{ apps: { web: { start: 'x', port: 1, install: 'x' } } }, /unsupported field install/],
    [{ apps: { web: { start: 'x', port: 1, env: { 'BAD-NAME': 'x' } } } }, /not a valid variable name/],
    [{ services: { mail: {} }, fixtures: [{ service: 'mail' }] }, /exactly one of sql, query or command/],
    [{ services: { mail: {} }, fixtures: [{ service: 'payments', sql: 'a.sql' }] }, /fixtures\[0\]\.service/],
    [{ services: { mail: { value: () => {} } } }, /JSON values only/],
  ];
  for (const [input, error] of cases) assert.throws(() => validate(input), error);
});

test('An id error names the nearest valid id, but never shortens a UUID into one', () => {
  assert.equal(idError('users[0].id', 'Test_User'), 'users[0].id must use lowercase letters, digits and single hyphens, such as "test-user".');
  assert.equal(idError('users[0].id', '0f8d4c2a-1b3e-4a5c-9d6e-8f0a1b2c3d4e'), 'users[0].id must use lowercase letters, digits and single hyphens.');
  assert.equal(idError('users[0].id', 42), 'users[0].id must use lowercase letters, digits and single hyphens.');
});

test('Commands hold no placeholders: they read the variables that service options and app env fill', () => {
  const base = config();
  const cases: [object, string][] = [
    [{ apps: { ...base.apps, api: { ...base.apps.api, start: 'node server.js --db {{database.DATABASE_URL}}' } } }, 'apps.api.start'],
    [{ apps: { ...base.apps, web: { ...base.apps.web, build: 'pnpm build {{nope}}' } } }, 'apps.web.build'],
    [{ install: { command: 'npm ci && echo {{apps.web.url}}' } }, 'install.command'],
    [{ fixtures: [{ service: 'database', query: "insert into t values ('{{apps.web.url}}')" }] }, 'fixtures[0].query'],
    [{ fixtures: [{ service: 'jobs', command: 'pnpm seed {{redis.REDIS_URL}}' }] }, 'fixtures[0].command'],
  ];
  for (const [patch, where] of cases) assert.throws(() => validate({ ...base, ...patch }), { message: `${where} holds a placeholder; placeholders go in service options and app env, and a command reads the variables they fill as $VARIABLE.` }, where);
  // Shell syntax with single braces stays a command.
  assert.equal(validate({ ...base, install: { command: 'npm ci && echo ${HOME} {a,b}' } }).install?.command, 'npm ci && echo ${HOME} {a,b}');
});

test('Placeholders resolve inside nested values', () => {
  const lookup = (ref: Placeholder) => ref.app ? `http://host:${ref.app.length}` : `${ref.service}:${ref.variable}`;
  assert.deepEqual(resolvePlaceholders({ a: ['{{apps.web.url}}/hook', { b: '{{ mail.SMTP_HOST }}:{{mail.SMTP_PORT}}' }], n: 1 }, lookup),
    { a: ['http://host:3/hook', { b: 'mail:SMTP_HOST:mail:SMTP_PORT' }], n: 1 });
});

test('A service address names a port of a configured service and adds no setup order', () => {
  // payments forwards to the jobs address while jobs needs a payments variable: an address breaks the cycle a variable would make.
  const result = validate({ services: { jobs: { database: '{{payments.PAYMENTS_KEY}}' }, payments: { webhook: '{{ services.jobs.url.api }}/hook' } },
    apps: { web: { start: 'x', port: 1, env: { JOBS: '{{services.jobs.url.api}}' } } } });
  assert.deepEqual(setupOrder(result), ['payments', 'jobs']);
  assert.deepEqual(placeholders(result.services.payments, 'services.payments'), [{ addressOf: 'jobs', port: 'api', where: 'services.payments.webhook' }]);
  assert.deepEqual(resolvePlaceholders(result.services.payments, ref => `http://host:${ref.addressOf}-${ref.port}`), { webhook: 'http://host:jobs-api/hook' });
  // A service's variable may also be written under services., as its address is.
  assert.deepEqual(resolvePlaceholders('{{services.mail.SMTP_HOST}}:{{mail.SMTP_PORT}}', ref => `${ref.service}.${ref.variable}`), 'mail.SMTP_HOST:mail.SMTP_PORT');
  const cases = [
    [{ services: { payments: { webhook: '{{services.jobs.url.api}}' } } }, /services\.payments\.webhook references \{\{services\.jobs\.url\.api\}\}, but service "jobs" is not configured\./],
    [{ services: { mail: {} }, apps: { web: { start: 'x', port: 1, env: { A: '{{services.jobs.url.api}}' } } } }, /apps\.web\.env\.A references \{\{services\.jobs\.url\.api\}\}/],
    [{ services: { jobs: {}, payments: { webhook: '{{services.jobs.url.API}}' } } }, /\{\{services\.jobs\.url\.API\}\} is not a placeholder; use .*\{\{apps\.<id>\.publicUrl\}\}.*\{\{services\.<id>\.publicUrl\.<port>\}\}\./],
    [{ services: { jobs: {}, payments: { webhook: '{{services.jobs.api}}' } } }, /is not a placeholder/],
    [{ services: { jobs: {}, payments: { webhook: '{{services.jobs.url}}' } } }, /is not a placeholder/],
  ];
  for (const [input, error] of cases) assert.throws(() => validate(input), error);
});

test('Explicit public addresses preserve their configured meaning and reject missing apps, services and malformed addresses', () => {
  const input = { services: { mail: {}, payments: { webhook: '{{apps.web.publicUrl}}/return' } },
    apps: { web: { start: 'npm start', port: 3000, env: { PUBLIC_MAIL: '{{services.mail.publicUrl.web}}', SERVER_MAIL: '{{services.mail.url.web}}' } } } };
  const result = validate(input);
  assert.deepEqual(result.apps.web.env, input.apps.web.env, 'Saving never rewrites existing internal mappings.');
  assert.deepEqual(setupOrder(result), ['mail', 'payments']);
  for (const [value, error] of [
    ['{{apps.missing.publicUrl}}', /\{\{apps\.missing\.publicUrl\}\}.*no app "missing"/],
    ['{{services.missing.publicUrl.web}}', /\{\{services\.missing\.publicUrl\.web\}\}.*service "missing" is not configured/],
    ['{{apps.web.publicUrl.path}}', /is not a placeholder/],
    ['{{services.mail.publicUrl}}', /is not a placeholder/],
    ['{{services.mail.publicUrl.WEB}}', /is not a placeholder/],
  ] as const) assert.throws(() => validate({ ...input, apps: { web: { ...input.apps.web, env: { URL: value } } } }), error);
});

test('Env options leave out variables of a blocked service; other options keep them', () => {
  const options = { database: '{{payments.PAYMENTS_KEY}}', env: { KEY: '{{payments.PAYMENTS_KEY}}', DB: '{{database.DATABASE_URL}}', ADDRESS: '{{services.payments.url.api}}', PLAIN: 'x' },
    nested: [{ env: { KEY: 'k {{payments.PAYMENTS_WEBHOOK_SECRET}}', MAIL: '{{mail.SMTP_HOST}}' } }], functions: { env: { KEY: '{{payments.PAYMENTS_KEY}}' } } };
  assert.deepEqual(leaveOutBlocked(options, id => id === 'payments'), {
    database: '{{payments.PAYMENTS_KEY}}', env: { DB: '{{database.DATABASE_URL}}', ADDRESS: '{{services.payments.url.api}}', PLAIN: 'x' },
    nested: [{ env: { MAIL: '{{mail.SMTP_HOST}}' } }], functions: { env: {} },
  });
  assert.deepEqual(leaveOutBlocked(options, () => false), options);
});
