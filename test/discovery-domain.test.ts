import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { domainTerms, businessSourceContext } from '../src/business/discovery.ts';

test('domain terms come from the repository route vocabulary, not a built-in product list', () => {
  const shop = ['web/app/orders/page.tsx', 'web/app/orders/[id]/page.tsx', 'web/app/orders/new/page.tsx', 'web/app/products/page.tsx', 'web/app/products/[slug]/page.tsx', 'api/routes/orders.ts', 'api/routes/products.ts', 'web/components/product-card.tsx', 'web/app/settings/page.tsx', 'web/app/login/page.tsx'];
  assert.deepEqual(domainTerms(shop), ['order', 'product']);
  assert.deepEqual(domainTerms(['src/app/page.tsx', 'src/lib/utils.ts', 'src/components/ui/button.tsx']), []);
  assert.ok(!domainTerms(['a/billing/x.ts', 'b/billing/y.ts', 'c/billing/z.ts', 'a/settings/x.ts', 'b/settings/y.ts', 'c/settings/z.ts']).length, 'billing and settings keep their own areas');
});

test('browser discovery prioritizes an unfamiliar product\'s primary pages without product-specific rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  await Promise.all(Array.from({ length: 230 }, (_, index) => write(`api/lib/helper-${String(index).padStart(3, '0')}.ts`, `export const unrelated = ${index};\n${'// filler\n'.repeat(800)}`)));
  for (const name of ['web/app/orders/page.tsx', 'web/app/orders/[id]/page.tsx', 'web/app/orders/new/page.tsx', 'api/routes/orders.ts']) await write(name, 'export async function createOrder() { return "Place order"; }\n');
  await write('web/app/checkout/page.tsx', 'export function Checkout() { return "Pay"; }\n');
  const context = await businessSourceContext(root, { scope: '' });
  const names = context.files.map(file => file.path);
  for (const name of ['web/app/orders/new/page.tsx', 'api/routes/orders.ts', 'web/app/checkout/page.tsx']) assert.ok(names.includes(name), name);
  assert.ok(names.indexOf('web/app/orders/new/page.tsx') < names.indexOf('api/lib/helper-000.ts'));
});

test('every page of a layout without conventional folder names reaches the model, within its budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  // A root App Router layout, and a framework whose views live in each application's own folder.
  const app = ['app/page.tsx', 'app/dashboard/page.tsx', 'app/workflows/page.tsx', 'app/workflows/[id]/page.tsx', 'app/workflows/new/page.tsx', 'app/settings/page.tsx', 'app/reports/page.tsx', 'app/reports/[id]/page.tsx', 'app/team/page.tsx', 'app/billing/page.tsx', 'app/login/page.tsx', 'app/api/workflows/route.ts', 'lib/workflows.ts', 'lib/reports.ts', 'lib/credits.ts', 'lib/auth.ts'];
  const views = ['shop/views.py', 'shop/models.py', 'orders/views.py', 'orders/models.py', 'orders/forms.py', 'accounts/views.py', 'accounts/forms.py', 'billing/views.py'];
  for (const name of [...app, ...views]) await write(name, `export const page = "${name}";\n`);
  const context = await businessSourceContext(root, { scope: '' }), names = context.files.map(file => file.path);
  for (const name of [...app, ...views]) assert.ok(names.includes(name), name);
  assert.ok(context.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.source), 0) <= 180 * 1024);
});

test('a product route named like a tooling folder is sampled, while tooling, tests and retired plans stay out', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-aside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  const routes = ['agents', 'scripts', 'evals', 'tests', 'fixtures', 'archive'].map(area => `frontend/pages/${area}/index.tsx`);
  for (const name of [...routes, 'app/agents/page.tsx', 'app/agents/[id]/page.tsx']) await write(name, `export function Page() { return "${name}"; }\n`);
  await write('frontend/pages/login.tsx', 'export function Login() { return "Sign in"; }\n');
  // Tooling at the root, a test folder without a page, and documentation beside a route stay out.
  await write('scripts/seed.ts', 'export const seed = "SEED_SCRIPT";\n');
  await write('agents/notes.md', 'AGENT_NOTES\n');
  await write('src/test/java/acme/OrderTest.java', 'class OrderTest { String note = "JAVA_TEST"; }\n');
  await write('backend/app/tests/test_orders.py', 'NOTE = "PYTHON_TEST"\n');
  await write('frontend/pages/agents/README.md', 'ROUTE_NOTES\n');
  await write('docs/superpowers/plans/old-plan.md', 'OLD_PLAN\n');
  const context = await businessSourceContext(root, { scope: '' }), names = context.files.map(file => file.path);
  for (const name of [...routes, 'app/agents/page.tsx', 'app/agents/[id]/page.tsx', 'frontend/pages/login.tsx']) assert.ok(names.includes(name), name);
  assert.doesNotMatch(JSON.stringify(context), /SEED_SCRIPT|AGENT_NOTES|JAVA_TEST|PYTHON_TEST|ROUTE_NOTES|OLD_PLAN/);
});
