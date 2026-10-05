import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceCatalog } from '../src/twin/catalog.ts';
import { serviceOptionErrors, validateTwinConfig } from '../src/twin/config.ts';
import { services } from '../src/twin/index.ts';
import { services as fixtures } from './fixtures/twin/services.ts';

test('The service catalog lists every registered service with its options, variables, addresses and inputs', () => {
  const catalog = serviceCatalog();
  const entries = catalog.split(/^### /m).slice(1);
  assert.deepEqual(entries.map(entry => /^`([^`]+)`/.exec(entry)?.[1]), Object.keys(services));
  for (const [index, service] of Object.values(services).entries()) {
    const entry = entries[index];
    assert.ok(service.describe, `${service.id} describes itself for the catalog`);
    assert.ok(entry.startsWith(`\`${service.id}\`: ${service.title} (`), service.id);
    assert.ok(entry.includes(service.describe.summary), service.id);
    for (const name of Object.keys(service.describe.options)) assert.ok(entry.includes(`  - \`${name}\`: `), `${service.id}.${name}`);
    for (const name of service.describe.provides) assert.ok(entry.includes(`\`${name}\``), `${service.id} provides ${name}`);
    for (const port of service.describe.ports ?? []) assert.ok(entry.includes(`{{services.${service.id}.url.${port}}}`), `${service.id} port ${port}`);
    for (const input of service.inputs ?? []) assert.ok(entry.includes(`\`${input.name}\` (`), `${service.id} input ${input.name}`);
    assert.equal(entry.includes('Creates test accounts'), Boolean(service.accounts), service.id);
  }
  assert.match(catalog, /Runs `postgres` itself: never add it beside this service\./);
  const stripe = entries.find(entry => entry.startsWith('`stripe`:'))!;
  assert.match(stripe, /Inputs created on request or supplied once by the user/);
  assert.match(stripe, /Perpetual can create its inputs when the user asks\./);
  // An author never relies on a part of Trigger.dev the shared instance does not run.
  assert.match(entries.find(entry => entry.startsWith('`trigger-dev`:'))!, /runs no Electric or object store: Realtime run subscriptions/);
});

test('A catalog comes from whichever registry it is given, described or not', () => {
  const catalog = serviceCatalog(fixtures);
  assert.deepEqual([...catalog.matchAll(/^### `([^`]+)`/gm)].map(match => match[1]), Object.keys(fixtures));
  assert.match(catalog, /### `payments`: Payments \(official sandbox\)\n\n- Inputs the user supplies once; a required one that is missing blocks the service: `PAYMENTS_KEY` \(Payments test key\)\.\n- A repository that needs it has packages `\^payments-sdk\$`; variables matching `\^PAYMENTS_`\./);
});

test('Service options are checked as each service reads them, with placeholders counting as text', () => {
  const config = (servicesConfig: object) => validateTwinConfig({ services: servicesConfig, apps: { web: { start: 'npm start', port: 3000 } } });
  assert.deepEqual(serviceOptionErrors(config({
    supabase: { directory: 'backend/supabase', users: [{ id: 'owner', email: 'owner@example.test' }], functions: { env: { HOOK_SECRET: '{{secrets.HOOK_SECRET}}' }, noVerifyJwt: ['hook'] } },
    secrets: { names: ['HOOK_SECRET'] }, stripe: { webhook: '{{apps.web.url}}/hooks/stripe' }, postgres: {}, emulate: { services: ['github'] }, llm: { source: 'app' },
  })), []);
  assert.deepEqual(serviceOptionErrors(config({
    supabase: { users: [{ id: 'Owner', email: 'owner@example.test' }] },
    postgres: { port: 5432 },
    secrets: { names: ['SESSION'] },
    emulate: { services: ['stripe'] },
    llm: { source: 'mock' },
    'trigger-dev': { version: 'latest' },
  })), [
    'services.supabase: supabase.users[0].id must use lowercase letters, digits and single hyphens, such as "owner". It names the test account; Auth gives the user its own id, and a fixture finds the user by its email.',
    'services.postgres has unsupported option port; use user, database, password.',
    'services.secrets: secrets.names must list variable names ending in SECRET, KEY, TOKEN or PASSWORD.',
    'services.emulate: emulate does not replace stripe: use the Stripe sandbox (test keys and stripe listen)',
    'services.llm: llm source must be one of: app, settings',
    'services.trigger-dev: version must be an exact trigger.dev CLI version, such as 4.4.4.',
  ]);
  // A service without a description is checked by its own validate only.
  assert.deepEqual(serviceOptionErrors({ services: { database: { anything: true } } }, { services: fixtures }), []);
});

test('An SQL fixture is refused when the config is saved unless its service provides DATABASE_URL', () => {
  const config = validateTwinConfig({ services: { redis: {}, postgres: {}, supabase: {} }, fixtures: [
    { service: 'redis', query: 'select 1' }, { service: 'postgres', query: 'select 1' }, { service: 'supabase', sql: 'seed.sql' }, { service: 'redis', command: 'npm run seed' },
  ] });
  assert.deepEqual(serviceOptionErrors(config), ['fixtures[0]: redis does not provide DATABASE_URL, which SQL fixtures use.']);
});

test('A placeholder names a variable and a port its service declares, so a typo is refused when the config is saved', () => {
  const config = (servicesConfig: object, env: Record<string, string>) => validateTwinConfig({ services: servicesConfig, apps: { web: { start: 'npm start', port: 3000, env } } });
  const services = { postgres: {}, supabase: { functions: { env: { HOOK_SECRET: '{{secrets.HOOK_SECRET}}' } } }, secrets: { names: ['HOOK_SECRET', 'SESSION_SECRET'] }, emulate: { services: ['github'] }, stripe: { fixtures: 'billing/stripe.json' } };
  // Declared variables and ports, variables an option adds, and a repository file's variables, known only at setup, pass.
  assert.deepEqual(serviceOptionErrors(config(services, { DB: '{{postgres.DATABASE_URL}}', PG: '{{services.postgres.url.postgres}}', ANON: '{{supabase.SUPABASE_ANON_KEY}}', API: '{{services.supabase.url.api}}',
    SESSION: '{{secrets.SESSION_SECRET}}', GITHUB: '{{emulate.GITHUB_EMULATOR_URL}}', PRICE: '{{stripe.STRIPE_PRICE_PRO}}', STRIPE: '{{services.stripe.STRIPE_SECRET_KEY}}' })), []);
  assert.deepEqual(serviceOptionErrors(config({ ...services, supabase: { functions: { env: { HOOK_SECRET: '{{secrets.HOOK}}' } } }, stripe: { fixtures: { fixtures: [{ name: 'price', path: '/v1/prices', method: 'post', params: { currency: 'usd' } }], env: { STRIPE_PRICE_PRO: '${price:id}' } } } },
    { KEY: '{{supabase.SUPABASE_ANON}}', DB: '{{postgres.DATABASE_UR}}', PG: '{{services.postgres.url.nope}}', GOOGLE: '{{emulate.GOOGLE_EMULATOR_URL}}', PRICE: '{{stripe.STRIPE_PRICE_TEAM}}' })), [
    'services.supabase.functions.env.HOOK_SECRET: secrets does not provide HOOK.',
    'apps.web.env.KEY: supabase does not provide SUPABASE_ANON.',
    'apps.web.env.DB: postgres does not provide DATABASE_UR.',
    'apps.web.env.PG references {{services.postgres.url.nope}}, but PostgreSQL has no port nope.',
    'apps.web.env.GOOGLE: emulate does not provide GOOGLE_EMULATOR_URL.',
    'apps.web.env.PRICE: stripe does not provide STRIPE_PRICE_TEAM.',
  ]);
});

test('A variable a service provides only with an option is refused without that option when the config is saved', () => {
  const config = (servicesConfig: object) => validateTwinConfig({ services: servicesConfig, apps: { web: { start: 'npm start', port: 3000,
    env: { MAIL_USER: '{{mailpit.SMTP_USER}}', MAIL_PASSWORD: '{{mailpit.SMTP_PASSWORD}}', HOOK: '{{stripe.STRIPE_WEBHOOK_SECRET}}' } } } });
  assert.deepEqual(serviceOptionErrors(config({ mailpit: {}, stripe: {} })), [
    'apps.web.env.MAIL_USER: mailpit does not provide SMTP_USER.',
    'apps.web.env.MAIL_PASSWORD: mailpit does not provide SMTP_PASSWORD.',
    'apps.web.env.HOOK: stripe does not provide STRIPE_WEBHOOK_SECRET.',
  ]);
  assert.deepEqual(serviceOptionErrors(config({ mailpit: { user: 'mailer', password: 'any' }, stripe: { webhook: '{{apps.web.url}}/hooks/stripe' } })), []);
  // Stripe gives its own variables after a fixtures document's, so neither a repository file, whose names are known only
  // at setup, nor an inline document provides the webhook's secret; only the webhook does.
  const hook = (stripe: object) => serviceOptionErrors(validateTwinConfig({ services: { stripe }, apps: { web: { start: 'npm start', port: 3000,
    env: { HOOK: '{{stripe.STRIPE_WEBHOOK_SECRET}}', PRICE: '{{stripe.STRIPE_PRICE}}' } } } }));
  const inline = { fixtures: [{ name: 'price', path: '/v1/prices' }], env: { STRIPE_PRICE: '${price:id}', STRIPE_WEBHOOK_SECRET: '${price:id}' } };
  assert.deepEqual(hook({ fixtures: 'stripe/fixtures.json' }), ['apps.web.env.HOOK: stripe does not provide STRIPE_WEBHOOK_SECRET.']);
  assert.deepEqual(hook({ fixtures: inline }), ['apps.web.env.HOOK: stripe does not provide STRIPE_WEBHOOK_SECRET.']);
  assert.deepEqual(hook({ fixtures: 'stripe/fixtures.json', webhook: '{{apps.web.url}}/hooks/stripe' }), []);
  assert.deepEqual(hook({ fixtures: inline, webhook: '{{apps.web.url}}/hooks/stripe' }), []);
});

test('generated internal secrets cannot stand in for catalogued vendor credentials',()=>{
  const config=validateTwinConfig({services:{secrets:{names:['STRIPE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET']}},apps:{web:{start:'npm start',port:3000}}});
  const errors=serviceOptionErrors(config);
  assert.ok(errors.some(error=>error.includes('STRIPE_SECRET_KEY')&&error.includes('stripe')),errors.join('\n'));
  assert.ok(errors.some(error=>error.includes('SUPABASE_SERVICE_ROLE_KEY')&&error.includes('supabase')),errors.join('\n'));
  assert.ok(errors.every(error=>!error.includes('SESSION_SECRET')),'An application-owned session key is still generated');
  assert.deepEqual(serviceOptionErrors(validateTwinConfig({services:{stripe:{},supabase:{},secrets:{names:['SESSION_SECRET']}},apps:{web:{start:'npm start',port:3000,env:{PAYMENTS_KEY:'{{stripe.STRIPE_SECRET_KEY}}',ADMIN_KEY:'{{supabase.SUPABASE_SERVICE_ROLE_KEY}}'}}}})),[]);
});

test('generated secrets cannot replace credentials an enabled service option supplies',()=>{
  const config=validateTwinConfig({services:{stripe:{webhook:'{{apps.web.url}}/hook'},secrets:{names:['STRIPE_WEBHOOK_SECRET']}},apps:{web:{start:'npm start',port:3000,env:{STRIPE_WEBHOOK_SECRET:'{{secrets.STRIPE_WEBHOOK_SECRET}}'}}}});
  assert.ok(serviceOptionErrors(config).some(error=>error.includes('STRIPE_WEBHOOK_SECRET')&&error.includes('stripe')));
});

test('omitting a service cannot make its conditional signing key an internal secret',()=>{
  const config=validateTwinConfig({services:{secrets:{names:['STRIPE_WEBHOOK_SECRET']}},apps:{web:{start:'npm start',port:3000,env:{STRIPE_WEBHOOK_SECRET:'{{secrets.STRIPE_WEBHOOK_SECRET}}'}}}});
  assert.ok(serviceOptionErrors(config).some(error=>error.includes('STRIPE_WEBHOOK_SECRET')&&error.includes('stripe')));
});
