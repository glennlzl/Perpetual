import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { composeTwin } from '../src/twin/compose.ts';
import { validateTwinConfig } from '../src/twin/config.ts';
import { services } from '../src/twin/index.ts';

test('A built frontend uses explicit public app and Supabase addresses while server URLs keep their container meaning', async t => {
  const config = validateTwinConfig({ services: { supabase: {} }, apps: {
    web: { directory: 'web', build: 'npm run build', start: 'npm start', port: 3000, env: {
      VITE_API_URL: '{{apps.api.publicUrl}}', VITE_SUPABASE_URL: '{{services.supabase.publicUrl.api}}',
      NEXT_PUBLIC_API_URL: '{{apps.api.publicUrl}}', SERVER_API_URL: '{{apps.api.url}}',
      VITE_LEGACY_API_URL: '{{apps.api.url}}', BILLING_URL: 'https://checkout.stripe.com',
    } }, api: { directory: 'api', start: 'node server.js', port: 8080 },
  } }, { services });
  const result = composeTwin({ project: 'acme-addresses', owner: 'acme', environment: 'addresses', source: '/acme/app', config,
    services: [{ id: 'supabase', fidelity: 'official-sandbox', status: 'ready', env: { SUPABASE_URL: 'http://host.docker.internal:47102' }, containers: [] }],
    ports: { 'apps.web': 47100, 'apps.api': 47101, 'supabase.api': 47102 } });
  assert.equal(result.apps[0].url, 'http://127.0.0.1:47100');
  assert.equal(result.env.WEB__NEXT_PUBLIC_API_URL, 'http://127.0.0.1:47101');
  assert.equal(result.env.WEB__SERVER_API_URL, 'http://host.docker.internal:47101');
  assert.equal(result.env.WEB__VITE_LEGACY_API_URL, 'http://host.docker.internal:47101', 'Variable prefixes never silently change saved mappings.');
  assert.equal(result.env.WEB__SUPABASE_URL, 'http://host.docker.internal:47102', 'Service outputs keep their existing meaning.');
  assert.equal(result.env.WEB__BILLING_URL, 'https://checkout.stripe.com');

  // Use Vite's real env replacement and bundler, with a neutral in-memory source and no output files or network.
  for (const name of ['VITE_API_URL', 'VITE_SUPABASE_URL']) {
    const previous = process.env[name];
    process.env[name] = result.env[`WEB__${name}`];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const bundle = await build({ configFile: false, envDir: false, logLevel: 'silent', plugins: [{ name: 'acme-browser-addresses',
    resolveId(id) { if (id.endsWith('acme-client')) return '\0acme-client'; },
    load(id) { if (id === '\0acme-client') return 'export const apiUrl = import.meta.env.VITE_API_URL + "/account"; export const authUrl = import.meta.env.VITE_SUPABASE_URL + "/auth/v1/token";'; },
  }], build: { write: false, minify: false, lib: { entry: 'virtual:acme-client', formats: ['es'], fileName: 'acme-client' } } });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  assert.ok(outputs.every(output => 'output' in output));
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  const browser = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  assert.equal(browser.apiUrl, 'http://127.0.0.1:47101/account');
  assert.equal(browser.authUrl, 'http://127.0.0.1:47102/auth/v1/token');
  assert.ok(!code.includes('host.docker.internal'), 'The compiled browser code needs no Perpetual-only DNS override.');
});
