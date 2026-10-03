import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { validateTwinConfig } from '../src/twin/config.ts';
import { APP_IMAGE, PACKAGE_CACHE_ENV, composeTwin, formatEnv } from '../src/twin/compose.ts';
import { services as fixtures } from './fixtures/twin/services.ts';
import type { ResolvedService } from '../src/twin/compose.ts';

const SECRET = 'pk_test_secret_value';
const ports = { 'apps.web': 43100, 'apps.api': 43101, 'database.sql': 43102, 'mail.smtp': 43103, 'mail.web': 43104 };
const database = { id: 'database', fidelity: 'actual', status: 'ready', env: { DATABASE_URL: 'postgres://postgres:db-password-1@host.docker.internal:43102/postgres' },
  containers: [{ name: 'database', image: 'postgres:17-alpine', env: { POSTGRES_PASSWORD: 'db-password-1' }, ports: { sql: 5432 }, health: { command: ['pg_isready', '-U', 'postgres'] } }] } satisfies ResolvedService;
const mail = { id: 'mail', fidelity: 'actual', status: 'ready', env: { SMTP_HOST: 'host.docker.internal', SMTP_PORT: '43103' },
  containers: [{ name: 'mail', image: 'mail/server:1.0', ports: { smtp: 1025, web: 8025 }, health: { http: { port: 'web', path: '/livez' } } }] } satisfies ResolvedService;
const payments = { id: 'payments', fidelity: 'official-sandbox', status: 'ready', env: { PAYMENTS_KEY: SECRET, PAYMENTS_WEBHOOK_SECRET: 'whsec_1234' },
  containers: [{ name: 'listener', image: 'payments/cli:1.0', command: ['listen', '--forward-to', 'http://host.docker.internal:43101/hook'], env: { PAYMENTS_KEY: SECRET } }] } satisfies ResolvedService;
const config = validateTwinConfig({
  services: { database: {}, mail: {}, payments: { webhook: '{{apps.api.url}}/hook' } },
  apps: {
    web: { directory: 'web', build: 'pnpm build', start: 'pnpm start --port $PORT', port: 3000, env: { API_URL: '{{apps.api.url}}', WEBHOOK_SIGNING: '{{payments.PAYMENTS_WEBHOOK_SECRET}}' } },
    api: { directory: 'api', start: 'node server.js', port: 8080, env: { DB: '{{database.DATABASE_URL}}' } },
  },
}, { services: fixtures });
const compose = (services: ResolvedService[]) => composeTwin({ project: 'perpetual-t1', owner: 'owner-1', environment: 't1', source: '/data/source', config, services, ports });

test('Apps, their install and the source copy run on the twin config\'s Node version, else on the current LTS', () => {
  assert.equal(APP_IMAGE, 'node:24-bookworm-slim');
  const images = (node?: number) => {
    const twin = validateTwinConfig({ ...(node === undefined ? {} : { node }), install: { command: 'npm ci' }, apps: { web: { start: 'npm start', port: 3000 } } }, { services: fixtures });
    const { compose: file } = composeTwin({ project: 'perpetual-t1', owner: 'owner-1', environment: 't1', source: '/data/source', config: twin, services: [], ports: { 'apps.web': 43100 } });
    return [file.services.install.image, file.services.web.image, file.services.source.image];
  };
  assert.deepEqual(images(26), ['node:26-bookworm-slim', 'node:26-bookworm-slim', 'node:26-bookworm-slim']);
  assert.deepEqual(images(), [APP_IMAGE, APP_IMAGE, APP_IMAGE]);
  for (const node of [17, 24.5, '24', 0]) assert.throws(() => validateTwinConfig({ node, apps: {} }, { services: fixtures }), { message: 'node must be a Node.js major version of 18 or later, such as 24.' }, String(node));
});

test('Compose output runs apps from the snapshot beside service containers on loopback ports', () => {
  const { compose: file, apps } = compose([database, mail, payments]);
  assert.equal(file.name, 'perpetual-t1');
  assert.deepEqual(Object.keys(file.services), ['database', 'mail', 'payments-listener', 'web', 'api', 'source']);
  const labels = { 'perpetual.owner': 'owner-1', 'perpetual.environment': 't1' };
  for (const service of Object.values(file.services)) {
    assert.deepEqual(service.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } });
    assert.deepEqual(service.labels, labels);
    assert.deepEqual(service.extra_hosts, ['host.docker.internal:host-gateway']);
    for (const port of service.ports ?? []) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/);
  }
  assert.deepEqual(file.services.mail.ports, ['127.0.0.1:43103:1025', '127.0.0.1:43104:8025']);
  assert.deepEqual(file.services.mail.healthcheck?.test, ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:8025/livez || curl -fsS -o /dev/null http://127.0.0.1:8025/livez']);
  assert.deepEqual(file.services.database.healthcheck?.test, ['CMD', 'pg_isready', '-U', 'postgres']);
  assert.equal(file.services['payments-listener'].healthcheck, undefined);
  assert.deepEqual(file.services['payments-listener'].command, ['listen', '--forward-to', 'http://host.docker.internal:43101/hook']);
  const web = file.services.web;
  assert.equal(web.image, APP_IMAGE);
  assert.equal(web.working_dir, '/workspace/web');
  // Apps run from the twin's workspace volume, which a one-shot service fills from the snapshot, and share one
  // machine-wide package cache, external so tearing a twin down keeps it.
  assert.deepEqual(web.volumes, [{ type: 'volume', source: 'workspace', target: '/workspace' }, { type: 'volume', source: 'perpetual-package-cache', target: '/perpetual-cache' }]);
  assert.deepEqual(file.volumes, { workspace: {}, 'perpetual-package-cache': { external: true } });
  assert.deepEqual([file.services.source.volumes?.[0], file.services.source.command, file.services.source.profiles], [{ type: 'bind', source: '/data/source', target: '/snapshot', read_only: true }, ['sh', '-c', 'cp -a /snapshot/. /workspace/'], ['source']]);
  assert.equal(web.environment?.npm_config_cache, '/perpetual-cache/npm');
  assert.equal(file.services.database.volumes, undefined);
  assert.deepEqual(web.command, ['sh', '-c', '(command -v corepack >/dev/null 2>&1 || npm install --global --force corepack@0.34.7) && corepack enable || exit $$?; pnpm build && pnpm start --port $$PORT']);
  assert.deepEqual(web.ports, ['127.0.0.1:43100:3000']);
  assert.equal(web.healthcheck?.test[0], 'CMD');
  assert.match(web.healthcheck!.test.at(-1)!, /127\.0\.0\.1:3000\//);
  assert.deepEqual(web.depends_on, { database: { condition: 'service_healthy' }, mail: { condition: 'service_healthy' }, 'payments-listener': { condition: 'service_started' } });
  assert.deepEqual(apps, [{ id: 'web', url: 'http://127.0.0.1:43100', directory: 'web' }, { id: 'api', url: 'http://127.0.0.1:43101', directory: 'api' }]);
});

test('A shared install is a one-shot service that a plain up never starts', () => {
  const shared = validateTwinConfig({ ...structuredClone(config), install: { directory: '.', command: 'pnpm install --frozen-lockfile' } }, { services: fixtures });
  const { compose: file, apps } = composeTwin({ project: 'perpetual-t1', owner: 'owner-1', environment: 't1', source: '/data/source', config: shared, services: [database, mail, payments], ports });
  assert.deepEqual(Object.keys(file.services), ['database', 'mail', 'payments-listener', 'install', 'web', 'api', 'source']);
  assert.deepEqual(file.services.install, {
    image: APP_IMAGE, working_dir: '/workspace', volumes: [{ type: 'volume', source: 'workspace', target: '/workspace' }, { type: 'volume', source: 'perpetual-package-cache', target: '/perpetual-cache' }],
    command: ['sh', '-c', '(command -v corepack >/dev/null 2>&1 || npm install --global --force corepack@0.34.7) && corepack enable || exit $$?; pnpm install --frozen-lockfile'], environment: PACKAGE_CACHE_ENV, profiles: ['install'],
    extra_hosts: ['host.docker.internal:host-gateway'], labels: { 'perpetual.owner': 'owner-1', 'perpetual.environment': 't1' },
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  });
  // Apps keep their own commands and never wait on the install; the runtime runs it before they start.
  assert.deepEqual(file.services.web.command, ['sh', '-c', '(command -v corepack >/dev/null 2>&1 || npm install --global --force corepack@0.34.7) && corepack enable || exit $$?; pnpm build && pnpm start --port $$PORT']);
  assert.equal(Object.hasOwn(file.services.web.depends_on!, 'install'), false);
  assert.equal(apps.some(app => app.id === 'install'), false);
  assert.equal(compose([database, mail, payments]).compose.services.install, undefined);
  const named = { ...mail, containers: [{ ...mail.containers[0], name: 'install' }], id: 'install' };
  assert.throws(() => composeTwin({ project: 'p', owner: 'o', environment: 'e', source: '/s', config: shared, services: [database, named, payments], ports: { ...ports, 'install.smtp': 1, 'install.web': 2 } }),
    /A service container is named install, which the install step uses\./);
});

test('Apps get same-name service variables automatically plus explicit mappings', () => {
  const { compose: file, env } = compose([database, mail, payments]);
  // The package cache locations are fixed paths, not twin values.
  const values = (name: string) => Object.fromEntries(Object.entries(file.services[name].environment!).filter(([key]) => !Object.hasOwn(PACKAGE_CACHE_ENV, key)).map(([key, value]) => [key, env[/^\$\{(.+)\}$/.exec(value)![1]]]));
  assert.deepEqual(values('web'), {
    DATABASE_URL: database.env.DATABASE_URL, SMTP_HOST: 'host.docker.internal', SMTP_PORT: '43103', PAYMENTS_KEY: SECRET, PAYMENTS_WEBHOOK_SECRET: 'whsec_1234',
    PORT: '3000', API_URL: 'http://host.docker.internal:43101', WEBHOOK_SIGNING: 'whsec_1234',
  });
  assert.equal(values('api').DB, database.env.DATABASE_URL);
  assert.equal(values('api').PORT, '8080');
  assert.deepEqual(values('database'), { POSTGRES_PASSWORD: 'db-password-1' });
});

test('Two services offering one variable need an explicit mapping', () => {
  const other = { ...mail, id: 'jobs', containers: [], env: { SMTP_HOST: 'elsewhere' } };
  assert.throws(() => compose([database, mail, payments, other]), /SMTP_HOST is provided by mail and jobs; map it in apps\.web\.env\./);
  const same = { ...mail, id: 'jobs', containers: [], env: { SMTP_HOST: 'host.docker.internal' } };
  assert.doesNotThrow(() => compose([database, mail, payments, same]));
});

test('A blocked service contributes nothing and reports its missing inputs', () => {
  const blocked = { id: 'payments', fidelity: 'official-sandbox', status: 'blocked', missing: ['PAYMENTS_KEY'] } satisfies ResolvedService;
  const { compose: file, env, services } = compose([database, mail, blocked]);
  assert.equal(file.services['payments-listener'], undefined);
  assert.equal(Object.keys(file.services.web.environment!).some(name => name.startsWith('PAYMENTS') || name === 'WEBHOOK_SIGNING'), false);
  assert.equal(Object.keys(env).some(key => key.includes('PAYMENTS') || key.includes('WEBHOOK')), false);
  assert.deepEqual(services, [
    { id: 'database', fidelity: 'actual', status: 'ready' }, { id: 'mail', fidelity: 'actual', status: 'ready' },
    { id: 'payments', fidelity: 'official-sandbox', status: 'blocked', missing: ['PAYMENTS_KEY'] },
  ]);
});

test('Secrets appear only in .env, which Compose reads without interpolation', () => {
  const { compose: file, env } = compose([database, mail, payments]);
  const yaml = YAML.stringify(file), dotenv = formatEnv(env);
  for (const secret of [SECRET, 'whsec_1234', 'db-password-1']) {
    assert.equal(yaml.includes(secret), false, secret);
    assert.equal(dotenv.includes(secret), true, secret);
  }
  assert.equal(file.services.web.environment?.PAYMENTS_KEY, '${WEB__PAYMENTS_KEY}');
  assert.equal(file.services['payments-listener'].environment?.PAYMENTS_KEY, '${PAYMENTS_LISTENER__PAYMENTS_KEY}');
  assert.equal(formatEnv({ A: 'p$x${Y}"q"\\end', B: 'one\ntwo' }), 'A="p\\$x\\${Y}\\"q\\"\\\\end"\nB="one\\ntwo"\n');
});

test('Unknown variables and names in mappings are reported', () => {
  const broken = validateTwinConfig({ services: { mail: {} }, apps: { web: { start: 'x', port: 1, env: { A: '{{mail.NOPE}}' } } } }, { services: fixtures });
  assert.throws(() => composeTwin({ project: 'p', owner: 'o', environment: 'e', source: '/s', config: broken, services: [mail], ports: { ...ports, 'apps.web': 1 } }),
    /apps\.web\.env\.A: mail does not provide NOPE\./);
  const clash = validateTwinConfig({ services: { payments: {} }, apps: { 'payments-listener': { start: 'x', port: 1 } } }, { services: fixtures });
  assert.throws(() => composeTwin({ project: 'p', owner: 'o', environment: 'e', source: '/s', config: clash, services: [payments], ports: { 'apps.payments-listener': 1 } }),
    /same name as a service container/);
  assert.throws(() => compose([{ ...mail, containers: [{ ...mail.containers[0], ports: { ...mail.containers[0].ports, other: 1 } }] }, database, payments]), /No host port was allocated for mail\.other/);
});

test('Apps map a service address to its allocated host port', () => {
  const addressed = validateTwinConfig({ services: { mail: {} }, apps: { web: { start: 'x', port: 1, env: { MAIL_API: '{{services.mail.url.web}}/api' } } } }, { services: fixtures });
  const { compose: file, env } = composeTwin({ project: 'p', owner: 'o', environment: 'e', source: '/s', config: addressed, services: [mail], ports });
  assert.equal(env[/^\$\{(.+)\}$/.exec(file.services.web.environment!.MAIL_API)![1]], 'http://host.docker.internal:43104/api');
});
