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

test('component and template pages are sampled, and a large file contributes its first whole lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  const pages = ['src/views/Orders.vue', 'src/components/OrderForm.vue', 'src/routes/orders/+page.svelte', 'src/pages/index.astro', 'app/views/orders/index.html.erb', 'views/orders.ejs', 'views/orders.hbs', 'templates/orders.html.twig', 'Pages/Orders.cshtml'];
  for (const name of pages) await write(name, `<h1>${name}</h1>\n`);
  // A single-file application over 64 KiB, each line holding characters wider than one byte.
  const lines = Array.from({ length: 1500 }, (_, index) => `const order${index} = "Save Bestellung ${index} – €";`);
  await write('src/App.jsx', `${lines.join('\n')}\n`);
  const context = await businessSourceContext(root, { scope: '' }), names = context.files.map(file => file.path);
  for (const name of [...pages, 'src/App.jsx']) assert.ok(names.includes(name), name);
  const sampled = context.files.find(file => file.path === 'src/App.jsx')!.source.split('\n');
  assert.equal(sampled[0], `1: ${lines[0]}`);
  // Every sampled line, the last one read included, is a whole original line under its own number.
  for (const line of sampled) { const [, number, text] = line.match(/^(\d+): (.*)$/)!; assert.equal(text, lines[Number(number) - 1], line); }
  assert.ok(Number(sampled.at(-1)!.match(/^\d+/)![0]) > 1000, 'Lines near the end of the first 64 KiB are sampled.');
  assert.ok(context.warnings.some(warning => /shortened/.test(warning)));
});

test('product code named like a tooling or test folder is sampled, while tooling, test helpers and retired code stay out', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-aside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  const routes = ['agents', 'scripts', 'evals', 'tests', 'fixtures', 'archive'].map(area => `frontend/pages/${area}/index.tsx`);
  // Pages, API handlers and feature folders named like tooling, and route pages named like tests.
  const product = [...routes, 'app/agents/page.tsx', 'app/agents/[id]/page.tsx', 'app/api/agents/route.ts', 'app/api/agents/[id]/route.ts', 'backend/routes/agents/create.ts',
    'src/features/agents/api.ts', 'src/features/agents/components/AgentList.tsx', 'src/features/evals/components/EvalList.tsx', 'src/features/evals/hooks/useEvals.ts',
    'app/tests/page.tsx', 'app/api/tests/route.ts', 'src/routes/fixtures/+page.svelte', 'frontend/pages/login.tsx'];
  for (const name of product) await write(name, `export function Page() { return "${name}"; }\n`);
  // Tooling at the root, test folders holding helpers, mock data or no page, retired code and documentation stay out.
  await write('scripts/seed.ts', 'export const seed = "SEED_SCRIPT";\n');
  await write('agents/notes.md', 'AGENT_NOTES\n');
  await write('src/test/java/acme/OrderTest.java', 'class OrderTest { String note = "JAVA_TEST"; }\n');
  await write('backend/app/tests/test_orders.py', 'NOTE = "PYTHON_TEST"\n');
  await write('src/test/test-utils.tsx', 'export const render = "TEST_UTILS";\n');
  await write('src/test/setup.ts', 'export const setup = "TEST_SETUP";\n');
  for (const name of ['handlers', 'data']) await write(`src/test/mocks/${name}.ts`, 'export const order = "MOCK_DATA";\n');
  await write('packages/web/tests/render.jsx', 'export const render = "TEST_RENDER";\n');
  await write('packages/web/tests/helpers/db.ts', 'export const db = "TEST_DB";\n');
  await write('app/fixtures/page.mock.tsx', 'export const page = "MOCK_PAGE";\n');
  await write('src/components/deprecated/OldCheckout.tsx', 'export const checkout = "RETIRED_UI";\n');
  await write('frontend/pages/agents/README.md', 'ROUTE_NOTES\n');
  await write('src/features/agents/docs/notes.md', 'FEATURE_NOTES\n');
  await write('docs/superpowers/plans/old-plan.md', 'OLD_PLAN\n');
  const context = await businessSourceContext(root, { scope: '' }), names = context.files.map(file => file.path);
  for (const name of product) assert.ok(names.includes(name), name);
  assert.doesNotMatch(JSON.stringify(context), /SEED_SCRIPT|AGENT_NOTES|JAVA_TEST|PYTHON_TEST|TEST_UTILS|TEST_SETUP|MOCK_DATA|TEST_RENDER|TEST_DB|MOCK_PAGE|RETIRED_UI|ROUTE_NOTES|FEATURE_NOTES|OLD_PLAN/);
});
