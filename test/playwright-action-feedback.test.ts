import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPlaywrightRuntime } from '../src/journeys/playwright/runtime.ts';
import { specHash } from '../src/journeys/playwright/specs.ts';
import type { WorkerEvent } from '../src/browser/runtime.ts';
import { chromium } from '@playwright/test';
import { installActionObservation, actionFeedback } from '../src/journeys/playwright/action-observation.ts';

test('form failure collection bounds renderer traversal before returning its small summary', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  await installActionObservation(context);
  await context.addInitScript(() => {
    const original = Element.prototype.checkVisibility;
    let calls = 0;
    Object.defineProperty(window, 'observationVisibilityCalls', { get: () => calls });
    Element.prototype.checkVisibility = function(options) { calls++; return original.call(this, options); };
  });
  const page = await context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent('<button>Submit</button>' + '<input aria-label="Field">'.repeat(3000)));
  assert.match(String(await actionFeedback(page, [])), /Field: empty/);
  const calls = await page.evaluate(() => (window as unknown as { observationVisibilityCalls: number }).observationVisibilityCalls);
  assert.ok(calls <= 1000, `Visibility inspected ${calls} fields despite the collection bound.`);
});

// A history URL can change while the old form remains. The reused field accepts the fill,
// then the destination replaces it before its submit button appears: no write reaches the app.
test('failed replay explains an edited field replaced by an empty destination field without exposing values', { timeout: 20000 }, async t => {
  let writes = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.method === 'POST') { writes++; response.end('Saved'); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<a href="/request" id="open">Open request</a>
        <form><label>Email<input id="email"></label><label>Password<input type="password" value="private-password"></label></form>
        <script>
          document.getElementById('open').onclick = event => { event.preventDefault(); history.pushState({}, '', '/request');
            email.oninput = () => setTimeout(() => { document.body.innerHTML = '<form method="post" action="/save"><label>Email<input required name="email"></label><button>Submit request</button><textarea id="notes">private-entered-note</textarea><input aria-labelledby="notes"><div id="heading" contenteditable>private-editable-heading<span id="nested">private-nested-edit</span></div><input aria-labelledby="heading"><input aria-labelledby="nested"></form>'; }, 0);
          };
        </script>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const item = { id: 'request', name: 'Request delivery', goal: 'Submit and receive a request', steps: [{ id: 'submit', title: 'Submit request', checks: [] }] };
  const code = `import { test } from 'perpetual'; test('Request delivery', async ({ page, journey }) => {
    await journey.milestone('submit', async () => {
      await page.getByRole('link', { name: 'Open request', exact: true }).click();
      await page.waitForURL('${origin}/request');
      await page.getByLabel('Email', { exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill('private-owner@example.test');
      await Promise.all([page.waitForResponse('${origin}/save', { timeout: 600 }), page.getByRole('button', { name: 'Submit request', exact: true }).click()]);
    });
  });`;
  const events: WorkerEvent[] = [];
  await createPlaywrightRuntime().start({ mode: 'run', targetUrl: origin, allowedOrigins: [origin], timeoutSeconds: 10, case: item, spec: { code, hash: specHash(code) }, credentials: { username: 'private-owner@example.test', password: 'private-password' } }, event => { if (event.type !== 'frame') events.push(event); }).promise;
  const facts = events.find(event => event.type === 'result')?.result as Record<string, unknown>;
  assert.equal(writes, 0, 'The empty destination form must not reach the application.');
  assert.equal(facts.stopCause, 'action');
  assert.match(String(facts.error), /waiting for event "response"/);
  assert.ok(events.filter(event => event.type === 'case').some(event => Array.isArray(event.actions) && event.actions.some(action => action.type === 'input' && action.status === 'passed')));
  assert.match(String(facts.actionFeedback), /Edited control removed: Email/);
  assert.match(String(facts.actionFeedback), /Email: empty, invalid/);
  assert.match(String(facts.actionFeedback), /Submit request/);
  assert.ok(!JSON.stringify(facts).includes('private-owner'));
  assert.ok(!JSON.stringify(facts).includes('private-password'));
  assert.ok(!JSON.stringify(facts).includes('private-entered-note'));
  assert.ok(!JSON.stringify(facts).includes('private-editable-heading'));
  assert.ok(!JSON.stringify(facts).includes('private-nested-edit'));
});
