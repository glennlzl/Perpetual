import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createBrowserManager } from '../src/browser/manager.ts';
import { createPlaywrightRuntime } from '../src/journeys/playwright/runtime.ts';

// Exercise the real fixture and controller. An acknowledgement is deliberately
// independent of persistence, so a broken write can still return a successful reply.
async function setup(t: TestContext, { reopen = false, postRead = false, responseWait = false, reviewedRead = false, bodylessRead = false, readRedirect = false, authenticated = false, popupRead = false, hashRoute = false, socketRead = false, readCount = 1, readBody = '{}' } = {}) {
  let value = 'Original', persist = true, writes = 0;
  const application = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      if (req.url === '/signin') {
        const data=new URLSearchParams(body);
        if(data.get('username')!=='viewer@example.test'||data.get('password')!=='fixture-password'){res.writeHead(403);res.end();return;}
        res.writeHead(303,{'Set-Cookie':'session=fixture-session; HttpOnly; SameSite=Strict','Location':'/'});res.end();return;
      }
      if (authenticated&&!req.headers.cookie?.includes('session=fixture-session')) {
        res.setHeader('Content-Type','text/html');
        res.end('<form method=post action=/signin><label>Username<input name=username></label><label>Password<input name=password type=password></label><button type=submit>Sign in</button></form>');return;
      }
      if (popupRead&&req.url==='/popup') { res.setHeader('Content-Type','text/html');res.end("<h1>Reader</h1><script>fetch('/read',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{}).finally(()=>{opener.readerFinished=(opener.readerFinished||0)+1;opener.document.getElementById('popup').textContent='Reader finished '+opener.readerFinished;});</script>");return; }
      if (req.url === '/save') { writes++; setTimeout(() => { if (persist) value = body; res.end('Saved'); }, responseWait ? 300 : 0); return; }
      if (req.url === '/read') { if(readRedirect){res.writeHead(307,{Location:'/save'});res.end();return;}res.end(value); return; }
      res.setHeader('Content-Type', 'text/html');
      const readOptions=bodylessRead ? "{method:'POST'}" : `{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(readBody)}}`;
      res.end(`<h1>Settings</h1><label>Name<input id=name></label><p id=kept>${postRead ? '' : value}</p><p id=loaded></p><p id=ack></p><p id=finished></p><button id=save>Save</button>
        ${socketRead ? '<p id=ready></p><button id=refresh>Refresh</button>' : ''}${popupRead ? `<p id=popup></p><button onclick="window.open('/popup')">Open reader</button>` : ''}<script>${socketRead ? "const socket=new WebSocket(location.origin.replace('http','ws')+'/socket');socket.onopen=()=>{ready.textContent='Socket ready';};refresh.onclick=()=>{socket.send('read');};" : ''}${postRead ? `fetch('/read',${readOptions}).then(async r=>{kept.textContent=await r.text();loaded.textContent=r.ok?'Read ready':'Unavailable';});` : ''}
        save.onclick=async()=>{const response=await fetch('/save',{method:'POST',body:document.querySelector('input').value});ack.textContent=response.ok?'Saved':'Unavailable';finished.textContent='Finished';};</script>`);
    });
  });
  if(socketRead){
    const {wsServer}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {wsServer:new(options:{server:typeof application;path:string})=>unknown};
    new wsServer({server:application,path:'/socket'});
  }
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
  await manager.saveConfig(context, { targetUrl: `http://127.0.0.1:${address.port}/`, journeyTimeoutSeconds: 60, ...(reviewedRead ? {readOnlyRequests:Array.from({length:readCount},(_,index)=>({url:`http://127.0.0.1:${address.port}/read${index?`/${index}`:''}`,body:bodylessRead?null:readBody}))} : {}) });
  await manager.saveCases(context, [item]);
  const submit = responseWait ? "await Promise.all([page.waitForResponse('**/save'),page.getByRole('button',{name:'Save',exact:true}).click()]);"
    : "await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Finished',{exact:true}).waitFor({state:'visible'});";
  const code = "import { test } from 'perpetual'; test('Rename workspace', async ({page,journey})=>{await journey.milestone('open',async()=>{" + (authenticated ? "await journey.signIn();" : "") + (hashRoute ? "await page.goto('/#/settings');" : "") + "});await journey.milestone('save',async()=>{await page.getByLabel('Name',{exact:true}).fill(`Name ${journey.run}`);" + submit + (reopen ? 'await page.reload();' : '') + (socketRead ? "await page.getByText('Socket ready',{exact:true}).waitFor({state:'visible'});await page.getByRole('button',{name:'Refresh',exact:true}).click();" : '') + '});});';
  const saved = await manager.saveSpec(context, { caseId: item.id, code }); const hash = saved.spec.draft!.hash;
  async function verify() {
    await manager.verifySpec(context, { caseId: item.id, hash, ...(authenticated?{credentials:{username:'viewer@example.test',password:'fixture-password'}}:{}) });
    for (const end = Date.now() + 60000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) {
      const state = (await manager.view(context)).specs[item.id].draft?.verification;
      if (state && state.status !== 'running') return state;
    }
    throw new Error('Verification did not settle');
  }
  return { manager, context, item, hash, verify, writes:()=>writes, breakPersistence() { persist = false; } };
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

test('a fresh read of a hash-routed page catches the blocked write', { timeout: 90000 }, async t => {
  const f = await setup(t, { reopen: true, hashRoute: true });
  assert.deepEqual(await f.verify(), { status: 'passed', passes: 3, control: 'caught' });
});

test('a delayed submission settles before fresh readback and the blocked-write response still reaches independent checks', { timeout: 90000 }, async t => {
  const f = await setup(t, { reopen: true, responseWait: true });
  assert.deepEqual(await f.verify(), { status: 'passed', passes: 3, control: 'caught' });
});

test('a reviewed POST read keeps the blocked submission observable to a paired response wait', {timeout:90000},async t=>{
  const f=await setup(t,{reopen:true,postRead:true,responseWait:true,reviewedRead:true,bodylessRead:true,authenticated:true});
  assert.deepEqual(await f.verify(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.writes(),3,'Neither interception layer lets the control save.');
});

test('a post-navigation socket block identifies the transport without qualifying its failed read', {timeout:90000},async t=>{
  const f=await setup(t,{reopen:true,socketRead:true});
  const verification=await f.verify();assert.equal(verification.passes,3);assert.equal(verification.control,'missed');
  const control=(await f.manager.view(f.context)).runs.find(run=>run.verification?.control);assert.ok(control);
  const result=(await f.manager.runProgress(f.context,control.id)).results[0];
  assert.equal(result.controlRead,false);assert.equal(result.controlReadReason,'blocked-after-read');
  assert.ok(result.controlBlocks?.some(block=>block.kind==='socket'&&block.transport==='websocket'&&block.afterRead));
  assert.equal(f.writes(),3);await assert.rejects(f.manager.approveSpec(f.context,{caseId:f.item.id,hash:f.hash}),{statusCode:409});
});

test('an unreviewed POST read after reload identifies only its safe method and path', {timeout:30000},async t=>{
  const f=await setup(t,{reopen:true,postRead:true,responseWait:true}),{config,cases}=await f.manager.view(f.context);
  const draft=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!;
  const item={...cases[0],steps:cases[0].steps!.map(step=>step.id==='open'?{...step,checks:[{type:'text-visible' as const,value:'Settings'}]}:step)};
  let result:unknown;
  await createPlaywrightRuntime({checkTimeoutMs:300}).start({mode:'run',case:item,spec:draft,targetUrl:config.targetUrl,allowedOrigins:[new URL(config.targetUrl).origin],blockWrites:true,timeoutSeconds:15},event=>{if(event.type==='result')result=event.result;}).promise;
  const facts=result as {controlRead:boolean;controlReadReason:string;controlBlocks:unknown[]};
  assert.equal(facts.controlRead,false);assert.equal(facts.controlReadReason,'blocked-after-read');
  assert.ok(facts.controlBlocks.some(block=>JSON.stringify(block)===JSON.stringify({kind:'http',method:'POST',url:new URL('/read',config.targetUrl).href,afterRead:true})));
  assert.equal(f.writes(),0);
});

test('32 maximum-body reviewed reads reach real workers and preserve a caught control', {timeout:90000},async t=>{
  const f=await setup(t,{reopen:true,postRead:true,responseWait:true,reviewedRead:true,readCount:32,readBody:JSON.stringify({value:'x'.repeat(4084)})});
  assert.deepEqual(await f.verify(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.writes(),3,'The large read policy does not permit the control write.');
});

test('blocking a read-only POST before the journey changes anything never counts as a caught control', { timeout: 90000 }, async t => {
  const f = await setup(t, { postRead: true });
  const verification = await f.verify();
  assert.equal(verification.passes, 3);
  assert.equal(verification.status, 'failed');
  assert.equal(verification.control, 'missed');
  await assert.rejects(f.manager.approveSpec(f.context, { caseId: f.item.id, hash: f.hash }), { statusCode: 409 });
});

// This catches a read exception accidentally permitting writes, or a changed policy retaining approval.
test('reviewed POST readback catches a blocked save and a changed read policy makes approval stale', { timeout: 90000 }, async t => {
  const f = await setup(t, { postRead: true, reopen: true, reviewedRead: true, authenticated: true });
  assert.deepEqual(await f.verify(), { status: 'passed', passes: 3, control: 'caught' });
  await f.manager.approveSpec(f.context, { caseId: f.item.id, hash: f.hash });
  const {config} = await f.manager.view(f.context);
  await f.manager.saveConfig(f.context, {...config, readOnlyRequests: []});
  assert.equal((await f.manager.view(f.context)).specs[f.item.id].approved?.stale, true);
  const {run} = await f.manager.run(f.context, {caseIds:[f.item.id]});
  for (const end=Date.now()+10000; Date.now()<end; await new Promise(resolve=>setTimeout(resolve,50))) {
    const report=await f.manager.runProgress(f.context,run.id);
    if (['queued','running'].includes(report.run.status)) continue;
    assert.equal(report.run.status,'needs_review');
    await f.manager.reuseSpec(f.context,{caseId:f.item.id});
    assert.ok((await f.manager.view(f.context)).specs[f.item.id].draft); return;
  }
  assert.fail('The stale approval did not settle');
});

test('a reviewed bodyless bootstrap stays readable while a signed-in save is caught and changing body mode invalidates approval', {timeout:90000},async t=>{
  const f=await setup(t,{postRead:true,reopen:true,reviewedRead:true,bodylessRead:true,authenticated:true});
  assert.deepEqual(await f.verify(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.writes(),3,'Only the three normal saves reach the application.');
  await f.manager.approveSpec(f.context,{caseId:f.item.id,hash:f.hash});
  const {config}=await f.manager.view(f.context);
  await f.manager.saveConfig(f.context,{...config,readOnlyRequests:config.readOnlyRequests!.map(rule=>({...rule,body:'{}'}))});
  assert.equal((await f.manager.view(f.context)).specs[f.item.id].approved?.stale,true);
});

test('a reviewed bodyless read cannot follow a redirect into a write', {timeout:30000},async t=>{
  const f=await setup(t,{postRead:true,readRedirect:true,reviewedRead:true,bodylessRead:true}),{config,cases}=await f.manager.view(f.context);
  const draft=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!;
  let result:unknown;
  await createPlaywrightRuntime({checkTimeoutMs:300}).start({mode:'run',case:cases[0],spec:draft,targetUrl:config.targetUrl,allowedOrigins:[new URL(config.targetUrl).origin],readOnlyRequests:config.readOnlyRequests,blockWrites:true,timeoutSeconds:15},event=>{if(event.type==='result')result=event.result;}).promise;
  assert.equal(f.writes(),0);
  assert.ok(result);
  assert.notEqual((result as {controlRead?:unknown}).controlRead,true);
});

test('a reviewed POST read redirect is guarded at every hop in a real control browser', { timeout:30000 }, async t => {
  const f=await setup(t,{postRead:true,readRedirect:true,reviewedRead:true}), {config,cases}=await f.manager.view(f.context);
  const draft=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!;
  let result:unknown;
  const job=createPlaywrightRuntime({checkTimeoutMs:300}).start({mode:'run',case:cases[0],spec:draft,targetUrl:config.targetUrl,allowedOrigins:[new URL(config.targetUrl).origin],readOnlyRequests:config.readOnlyRequests,blockWrites:true,timeoutSeconds:15},event=>{if(event.type==='result')result=event.result;});
  await job.promise;
  assert.equal(f.writes(),0,'The unreviewed redirect must never reach the write handler.');
  assert.ok(result);
  assert.notEqual((result as {controlRead?:unknown}).controlRead,true,'An unreadable redirected request is never caught control evidence.');
});


test('an immediate reviewed read in a popup never follows its write redirect', {timeout:30000}, async t => {
  const f=await setup(t,{popupRead:true,readRedirect:true,reviewedRead:true}),{config,cases}=await f.manager.view(f.context);
  const code="import { test } from 'perpetual'; test('Read workspace',async({page,journey})=>{await journey.milestone('open',async()=>{});await journey.milestone('save',async()=>{"+Array.from({length:8},()=>"await page.getByRole('button',{name:'Open reader',exact:true}).click();").join('')+"await page.getByText('Reader finished 8',{exact:true}).waitFor({state:'visible'});});});";
  await f.manager.saveSpec(f.context,{caseId:f.item.id,code});
  const draft=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!;
  let completed=false;const observed:unknown[]=[];
  const item={...cases[0],steps:cases[0].steps!.map(step=>({...step,checks:[{type:'text-visible' as const,value:'Settings'}]}))};
  await createPlaywrightRuntime({checkTimeoutMs:300}).start({mode:'run',case:item,spec:draft,targetUrl:config.targetUrl,allowedOrigins:[new URL(config.targetUrl).origin],readOnlyRequests:config.readOnlyRequests,blockWrites:true,timeoutSeconds:15},event=>{if(event.type!=='frame')observed.push(event);if(event.type==='journey-step'&&event.stepId==='save'&&event.status==='completed')completed=true;}).promise;
  assert.equal(completed,true,'The page must observe every popup read settling before checking server writes: '+JSON.stringify(observed));
  assert.equal(f.writes(),0,'The popup read must never follow a redirect into a write.');
});
