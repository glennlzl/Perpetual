import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserManager } from '../src/browser/manager.ts';
import { createPlaywrightRuntime } from '../src/journeys/playwright/runtime.ts';

// Exercise the real fixture and controller. An acknowledgement is deliberately
// independent of persistence, so a broken write can still return a successful reply.
async function setup(t: TestContext, { reopen = false, postRead = false } = {}) {
  let value = 'Original', persist = true;
  const application = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      if (req.url === '/save') { if (persist) value = body; res.end('Saved'); return; }
      if (req.url === '/read') { res.end(value); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<h1>Settings</h1><label>Name<input id=name></label><p id=kept>${postRead ? '' : value}</p><p id=loaded></p><p id=ack></p><p id=finished></p><button id=save>Save</button>
        <script>${postRead ? "fetch('/read',{method:'POST'}).then(async r=>{kept.textContent=await r.text();loaded.textContent=r.ok?'Read ready':'Unavailable';});" : ''}
        save.onclick=async()=>{const response=await fetch('/save',{method:'POST',body:document.querySelector('input').value});ack.textContent=response.ok?'Saved':'Unavailable';finished.textContent='Finished';};</script>`);
    });
  });
  await new Promise<void>(resolve => application.listen(0, '127.0.0.1', resolve));
  const address = application.address(); assert.ok(address && typeof address !== 'string');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-control-read-')), repo = join(dataDir, 'repo'); await mkdir(repo);
  const manager = await createBrowserManager({ dataDir, playwright: createPlaywrightRuntime({ checkTimeoutMs: 600 }) });
  t.after(async () => { await manager.close(); application.closeAllConnections(); await new Promise<void>(resolve => application.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); });
  const context = { key: 'repo', stageId: 'beta', controllerOrigin: 'http://127.0.0.1:4317', scan: { repo: { path: repo, sha: 'a'.repeat(40) } } };
  const item = { id: 'rename', name: 'Rename workspace', goal: 'Keep the new workspace name', needsReview: false, selected: true,
    steps: [{ id: 'open', title: 'Open settings', checks: [{ type: 'text-visible', value: postRead ? 'Read ready' : 'Settings' }] },
      { id: 'save', title: 'Save workspace name', checks: [{ type: 'text-visible', value: reopen ? 'Name {run}' : 'Saved' }] }],
    expectedOutcomes: ['The new name is stored'] };
  await manager.saveConfig(context, { targetUrl: `http://127.0.0.1:${address.port}/`, journeyTimeoutSeconds: 60 });
  await manager.saveCases(context, [item]);
  const code = "import { test } from 'perpetual'; test('Rename workspace', async ({page,journey})=>{await journey.milestone('open',async()=>{});await journey.milestone('save',async()=>{await page.getByLabel('Name',{exact:true}).fill(`Name ${journey.run}`);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Finished',{exact:true}).waitFor({state:'visible'});" + (reopen ? 'await page.reload();' : '') + '});});';
  const saved = await manager.saveSpec(context, { caseId: item.id, code }); const hash = saved.spec.draft!.hash;
  async function verify() {
    await manager.verifySpec(context, { caseId: item.id, hash });
    for (const end = Date.now() + 60000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) {
      const state = (await manager.view(context)).specs[item.id].draft?.verification;
      if (state && state.status !== 'running') return state;
    }
    throw new Error('Verification did not settle');
  }
  return { manager, context, item, hash, verify, breakPersistence() { persist = false; } };
}

test('an acknowledgement-only journey cannot be approved because the control removed its success response', { timeout: 90000 }, async t => {
  const f = await setup(t);
  const verification = await f.verify();
  assert.equal(verification.passes, 3);
  assert.equal(verification.status, 'failed', 'A missing acknowledgement does not demonstrate a persistence check');
  assert.equal(verification.control, 'missed');
  await assert.rejects(f.manager.approveSpec(f.context, { caseId: f.item.id, hash: f.hash }), { statusCode: 409 });
});

test('a fresh page read catches the blocked write and the approved journey detects a later persistence regression', { timeout: 90000 }, async t => {
  const f = await setup(t, { reopen: true });
  assert.deepEqual(await f.verify(), { status: 'passed', passes: 3, control: 'caught' });
  await f.manager.approveSpec(f.context, { caseId: f.item.id, hash: f.hash });
  f.breakPersistence();
  const { run } = await f.manager.run(f.context, { caseIds: [f.item.id] });
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) {
    const report = await f.manager.runProgress(f.context, run.id);
    if (['queued', 'running'].includes(report.run.status)) continue;
    assert.equal(report.run.status, 'failed'); return;
  }
  assert.fail('The gate run did not settle');
});

test('blocking a read-only POST before the journey changes anything never counts as a caught control', { timeout: 90000 }, async t => {
  const f = await setup(t, { postRead: true });
  const verification = await f.verify();
  assert.equal(verification.passes, 3);
  assert.equal(verification.status, 'failed');
  assert.equal(verification.control, 'missed');
  await assert.rejects(f.manager.approveSpec(f.context, { caseId: f.item.id, hash: f.hash }), { statusCode: 409 });
});
