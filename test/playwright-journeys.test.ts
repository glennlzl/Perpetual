import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import type {AddressInfo} from 'node:net';
import {createBrowserManager} from '../src/browser/manager.ts';
import {createPlaywrightRuntime} from '../src/journeys/playwright/runtime.ts';
import {specHash,validateJourneySpec} from '../src/journeys/playwright/specs.ts';
import {journeyResult} from '../src/browser/results.ts';
import type {BrowserManager,BrowserStageContext} from '../src/browser/manager.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import {RUN_TOKEN,type ApprovedCase} from '../src/journeys/playwright/checks.ts';
import type {JourneyFacts} from '../src/journeys/playwright/reporter.ts';

/** An event a journey's worker reported, as the tests read it. */
type RunEvent={type:string;stepId?:string;status?:string;evidence?:string;result?:JourneyFacts};
type Progress={manager:BrowserManager;context:BrowserStageContext};
type Socket={on(event:'message',listener:(data:Buffer)=>void):void;send(data:string):void};
// The WebSocket server bundled with Playwright, so the application needs no dependency of its own.
const {wsServer}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {wsServer:new(options:{server:http.Server;path:string})=>{on(event:'connection',listener:(socket:Socket)=>void):void}};

// A real local Chromium runs specs through the manager, as a person's Beta run does.
const account={username:'tester@example.com',password:'pw-secret-4821'};
const page=(title:string,body:string)=>`<!doctype html><title>${title}</title><body>${body}</body>`;
// A page's or worker's socket to the application, which says hello as it opens, as a real protocol's opening message
// does, and a message sent over it after that.
const SOCKET="const SOCKET_URL=location.origin.replace('http','ws')+'/socket',socket=new WebSocket(SOCKET_URL),open=new Promise(resolve=>socket.addEventListener('open',()=>{socket.send(JSON.stringify({type:'hello'}));resolve();})),say=message=>open.then(()=>socket.send(JSON.stringify(message)));";
function application({persist=true}:{persist?:boolean}={}){
  const state={name:'Original Name',credits:10,notes:0,failRename:false},leaks:Record<string,string>[]=[],hosts=new Set<string|undefined>(),posts:string[]=[],seen:(string|null)[]=[],received:string[]=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url!,'http://app'),signedIn=/session=1/.test(req.headers.cookie||'');hosts.add(req.headers.host);
    if(req.method!=='GET')posts.push(`${req.method} ${url.pathname}`);
    const send=(html:string,headers={})=>{res.writeHead(200,{'content-type':'text/html',...headers});res.end(html);};
    const redirect=(location:string,headers={})=>{res.writeHead(303,{location,...headers});res.end();};
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const form=new URLSearchParams(body);
      // A redirect or a link to wherever ?to= says, and a record of what a spec's own requests could send.
      if(url.pathname==='/away')return redirect(url.searchParams.get('to')!);
      if(url.pathname==='/link')return send(page('Link',`<a href="${url.searchParams.get('to')}">Leave</a>`));
      if(url.pathname==='/leak'){leaks.push(Object.fromEntries(url.searchParams));return send(page('Leak',''));}
      // Form fields a person sees, and those no check reads: a password, a hidden field, a field out of view, a checkbox and an unselected option.
      if(url.pathname==='/fields')return send(page('Fields',`<form><label>Name <input value="Field Name"></label><label>Bio <textarea>Field\n   Bio</textarea></label>
        <label>Plan <select><option>Basic plan</option><option selected>Pro plan</option></select></label><label>Password <input type=password value="Field Secret"></label>
        <input type=hidden value="Field Hidden"><div hidden><input value="Field Invisible"></div><label>Box <input type=checkbox value="Field Box"></label>
        <label>Late <input id=late></label></form><script>setTimeout(()=>{document.getElementById('late').value='Field Late';},800);</script>`));
      // A fresh GET echoes the query in declared search controls, without a matching record.
      if(url.pathname==='/search-readback')return send(page('Search results',`<h1>Search results</h1>
        <input type=search value="Native query"><input role=searchbox value="ARIA query">
        <search><input value="Landmark query"></search><form role=search><textarea>Form query</textarea><select><option selected>Filter query</option></select></form>
        <search><x-query></x-query></search><div role=searchbox><x-searchbox></x-searchbox></div>
        <x-slotted-field><input slot=q value="Slotted field query"></x-slotted-field><x-slotted-text><span slot=q>Slotted text query</span></x-slotted-text>
        <label>Stored name<input value="Kept name"></label><input type=search value="Kept result"><search><article>Kept result</article></search>
        <script>document.querySelector('x-query').attachShadow({mode:'open'}).innerHTML='<input value="Shadow field query">';document.querySelector('x-searchbox').attachShadow({mode:'open'}).innerHTML='<span>Shadow text query</span>';document.querySelector('x-slotted-field').attachShadow({mode:'open'}).innerHTML='<search><slot name=q></slot></search>';document.querySelector('x-slotted-text').attachShadow({mode:'open'}).innerHTML='<div role=searchbox><slot name=q></slot></div>';</script>`));
      // A rename saved by a script's request, whose field keeps what was typed; the page shows the name only in that field.
      if(url.pathname==='/rename'&&req.method==='POST'){if(state.failRename){res.writeHead(500);return res.end();}state.name=body;res.writeHead(200);return res.end();}
      if(url.pathname==='/rename')return send(page('Rename',`<h1>Rename</h1><label>Display name <input id=rename value="${state.name}"></label><button id=save>Rename</button>
        <script>save.onclick=()=>fetch(${url.searchParams.has('query')?"'/rename?name='+encodeURIComponent(rename.value)":"'/rename'"},{method:'POST',body:rename.value}).then(r=>document.body.insertAdjacentHTML('beforeend',r.ok?'<p>Done</p>':'<p>Failed</p>'));</script>`));
      if(url.pathname==='/other')return send(page('Other','<p>Another page</p>'));
      // A search that filters the list as it is typed; the deleted workflow is no longer listed.
      if(url.pathname==='/workflows')return send(page('Workflows',`<h1>Workflows</h1><input type=search aria-label=Search id=q><ul id=list><li>Weekly report</li></ul><p id=empty hidden>No workflows found</p>
        <script>q.oninput=()=>{const hits=[...list.children].filter(item=>!(item.hidden=!item.textContent.toLowerCase().includes(q.value.toLowerCase())));empty.hidden=hits.length>0;};</script>`));
      if(url.pathname==='/')return redirect(signedIn?'/settings':'/login');
      if(url.pathname==='/login'&&req.method==='POST')return form.get('email')===account.username&&form.get('password')===account.password?redirect('/settings',{'set-cookie':'session=1; Path=/'}):redirect('/login');
      if(url.pathname==='/login')return send(page('Sign in','<form method=post action=/login><label>Email <input type=email name=email autocomplete=username></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>'));
      // The same form, shown by a button once the socket said hello, signing in over that socket, then Notes, counted only
      // over a socket and written over the socket of the page, a worker or a shared worker, the page's WebSocketStream or
      // a socket the page opens only to add the note; with spa, the page itself opens a socket for Notes a moment later.
      if(url.pathname==='/socket-login')return send(page('Sign in',`<button id=show hidden>Sign in</button><form hidden><label>Email <input type=email name=email autocomplete=username></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form><script>${SOCKET}const form=document.forms[0],show=document.getElementById('show');open.then(()=>{show.hidden=false;});show.onclick=()=>{show.hidden=true;form.hidden=false;};form.onsubmit=event=>{event.preventDefault();say({type:'sign-in',email:form.email.value,password:form.password.value});};socket.addEventListener('message',event=>{if(event.data!=='signed-in')return;document.cookie='session=1; path=/';if(!location.search.includes('spa'))return location.assign('/live'+location.search);form.hidden=true;setTimeout(()=>{const notes=new WebSocket(SOCKET_URL);notes.onopen=()=>notes.send(JSON.stringify({type:'hello'}));notes.onmessage=event=>{document.body.insertAdjacentHTML('beforeend','<p>'+event.data+'</p><button id=add>Add note</button>');document.getElementById('add').onclick=()=>{notes.send(JSON.stringify({type:'add'}));document.body.insertAdjacentHTML('beforeend','<p>Note added</p>');};};},1500);});</script>`));
      if(url.pathname==='/note-worker.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(`${SOCKET}const add=port=>()=>say({type:'add'}).then(()=>port.postMessage('sent'));onmessage=add(self);onconnect=event=>{event.ports[0].onmessage=add(event.ports[0]);};`);}
      // A landing page with no sign-in form, and a sign-in page whose form, shown at once, signs in over its socket.
      if(url.pathname==='/welcome')return send(page('Welcome','<h1>Welcome</h1>'));
      if(url.pathname==='/socket-sign-in')return send(page('Sign in',`<form><label>Email <input type=email name=email autocomplete=username></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form><script>${SOCKET}const form=document.forms[0];form.onsubmit=event=>{event.preventDefault();say({type:'sign-in',email:form.email.value,password:form.password.value});};socket.addEventListener('message',event=>{if(event.data!=='signed-in')return;document.cookie='session=1; path=/';location.assign('/live');});</script>`));
      if(url.pathname==='/socket-identifier')return send(page('Sign in','<form method=post action=/socket-identify><label>Email <input type=email name=email autocomplete=username></label><button>Continue</button></form>'));
      if(url.pathname==='/socket-identify'&&req.method==='POST')return form.get('email')===account.username?redirect('/socket-password',{'set-cookie':'identified=1; Path=/; HttpOnly'}):redirect('/socket-identifier');
      // A full navigation creates a new document and socket before the password is entered.
      if(url.pathname==='/socket-password')return /identified=1/.test(req.headers.cookie||'')?send(page('Sign in',`<form><label>Email <input type=email name=email autocomplete=username value="${account.username}" readonly></label><label>Password <input type=password name=password autocomplete=current-password></label><button type=submit>Sign in</button></form><script>${SOCKET}const form=document.forms[0];form.onsubmit=event=>{event.preventDefault();say({type:'sign-in',email:form.email.value,password:form.password.value});};socket.addEventListener('message',event=>{if(event.data!=='signed-in')return;document.cookie='session=1; path=/';location.assign('/live');});</script>`)):redirect('/socket-identifier');
      if(!signedIn)return redirect('/login');
      if(url.pathname==='/live')return send(page('Notes',`<p></p><button>Add note</button><script>${SOCKET}socket.addEventListener('message',event=>{if(event.data.startsWith('Notes '))document.querySelector('p').textContent=event.data;});const via=new URLSearchParams(location.search).get('via'),port=via==='worker'?new Worker('/note-worker.js'):via==='shared'?new SharedWorker('/note-worker.js').port:null,added=()=>document.body.insertAdjacentHTML('beforeend','<p>Note added</p>');if(port)port.onmessage=added;const writers={stream:async()=>{const writer=(await new WebSocketStream(SOCKET_URL).opened).writable.getWriter();for(const type of ['hello','add'])await writer.write(JSON.stringify({type}));},lazy:()=>new Promise(resolve=>{const lazy=new WebSocket(SOCKET_URL);lazy.onopen=()=>{for(const type of ['hello','add'])lazy.send(JSON.stringify({type}));resolve();};})};document.querySelector('button').onclick=()=>port?port.postMessage('add'):(writers[via]||(()=>say({type:'add'})))().then(added);</script>`));
      if(url.pathname==='/settings'&&req.method==='POST'){state.credits--;if(persist)state.name=form.get('name')!;return redirect('/settings?saved=1');}
      // A note is added by a script's request; the page reports the status it received.
      if(url.pathname==='/notes'&&req.method==='POST'){state.notes++;res.writeHead(200);return res.end();}
      if(url.pathname==='/seen'){seen.push(url.searchParams.get('status'));res.writeHead(204);return res.end();}
      if(url.pathname==='/notes')return send(page('Notes',`<p>Notes ${state.notes}</p><button onclick="fetch('/notes',{method:'POST'}).then(r=>{fetch('/seen?status='+r.status);document.body.insertAdjacentHTML('beforeend',r.ok?'<p>Note added</p>':'<p>Note not added</p>');})">Add note</button>`));
      // The profile shows the saved name only in its field.
      if(url.pathname==='/profile')return send(page('Profile',`<h1>Profile</h1><label>Display name <input name=name value="${state.name}"></label>`));
      if(url.pathname==='/settings')return send(page('Settings',`<h1>Settings</h1><p>Signed in as ${state.name}</p><p><span>Credits</span> <strong>${state.credits}</strong></p>${url.searchParams.has('saved')?'<p role=status>Saved</p>':''}<form method=post action=/settings><label>Display name <input id=display-name name=name value="${state.name}"></label><button>Save</button></form>`));
      res.writeHead(404);res.end();
    });
  });
  // Over its socket the application answers hello with the note count, and only then signs in and adds a note.
  new wsServer({server,path:'/socket'}).on('connection',socket=>{
    let greeted=false;
    socket.on('message',data=>{
      const message:{type?:string;email?:string;password?:string}=JSON.parse(String(data));received.push(String(message.type));
      if(message.type==='hello'){greeted=true;return socket.send(`Notes ${state.notes}`);}
      if(!greeted)return socket.send('denied');
      if(message.type==='add')state.notes++;
      else socket.send(message.email===account.username&&message.password===account.password?'signed-in':'denied');
    });
  });
  return new Promise<{server:typeof server;leaks:typeof leaks;hosts:typeof hosts;posts:typeof posts;seen:typeof seen;received:typeof received;state:typeof state;url:string}>(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,leaks,hosts,posts,seen,received,state,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/`})));
}

const journey={id:'rename',name:'Rename the display name',goal:'Change my display name and see it kept after a reload.',isolation:'shared',selected:true,needsReview:false,
  steps:[
    {id:'open-settings',title:'Sign in and open Settings',checks:[{type:'url-contains',value:'/settings'},{type:'read-number',label:'Credits',name:'before'}]},
    {id:'save-name',title:'Save the display name Twin Tester',checks:[{type:'text-visible',value:'Saved'},{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'}]},
    {id:'reload',title:'Reload Settings and see the new name',checks:[{type:'text-visible',value:'Signed in as Twin Tester'}]},
  ],
  preconditions:['A test account'],expectedOutcomes:['After a reload, Settings shows Twin Tester.'],assertions:[{type:'text-absent',value:'Original Name'}]} satisfies Omit<BrowserCase,'evidence'>;
const spec=({missing=false,linger=false,reload='await page.reload();'}={})=>`import { test } from 'perpetual';

test('Rename the display name', async ({ page, journey }) => {
  await journey.milestone('open-settings', async () => {
    await journey.signIn();
  });
  await journey.milestone('save-name', async () => {
    ${missing?"await page.locator('#nickname').fill('Twin Tester', { timeout: 1000 });":"await page.getByLabel('Display name').fill('Twin Tester');"}
    await page.getByRole('button', { name: 'Save' }).click();
  });
  await journey.milestone('reload', async () => {
    ${linger?'await page.waitForTimeout(60000);':''}${reload}
  });
});
`;
// A note written over a socket, kept only if a reload still counts it; the page shows Note added once it has sent it.
const live={...journey,name:'Add a note',goal:'Add a note and see it kept after a reload.',
  steps:[
    {id:'open-notes',title:'Sign in and open Notes',checks:[{type:'read-number',label:'Notes',name:'before'}]},
    {id:'add-note',title:'Add a note',checks:[{type:'text-visible',value:'Note added'}]},
    {id:'reload',title:'Reload Notes and see the note kept',checks:[{type:'compare-number',label:'Notes',name:'after',op:'>',than:'before'}]},
  ],
  expectedOutcomes:['After a reload, Notes counts the new note.'],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
// It signs in over the page's socket after showing the form, or with the HTTP form before opening Notes.
const liveSpec=(via='page',form=false)=>`import { test } from 'perpetual';

test('Add a note', async ({ page, journey }) => {
  await journey.milestone('open-notes', async () => {
    ${form?`await journey.signIn();
    await page.goto('/live?via=${via}');`:`await page.goto('/socket-login?via=${via}');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await journey.signIn();`}
  });
  await journey.milestone('add-note', async () => {
    await page.getByRole('button', { name: 'Add note' }).click();
  });
  await journey.milestone('reload', async () => {
    await page.reload();
  });
});
`;

async function setup(t:TestContext,{item=journey,...options}:{persist?:boolean;item?:Omit<BrowserCase,'evidence'>}={}){
  const app=await application(options);
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-journeys-'));await mkdir(join(dataDir,'repo'));
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('The browser-use runtime is not used.');}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:createPlaywrightRuntime({checkTimeoutMs:3000})});
  t.after(async()=>{await manager.close();app.server.closeAllConnections();app.server.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:app.url,journeyTimeoutSeconds:60});
  await manager.saveCases(context,[item]);
  // A person's manual run tries a saved draft; approval follows its passing run.
  const draft=async(code:string)=>(await manager.saveSpec(context,{caseId:item.id,code})).spec;
  const run=(input?:Parameters<BrowserManager['run']>[1])=>manager.run(context,{credentials:account,...input},{manual:true});
  return {manager,context,dataDir,draft,run,app};
}
// Runs a spec in the worker directly, as the manager would after approval, with any allowed origins.
async function runSpec(target:string,code:string,{allowedOrigins=[new URL(target).origin],timeoutSeconds=30,item=journey,blockWrites,checkVersion,signInUrl}:{allowedOrigins?:string[];timeoutSeconds?:number;item?:ApprovedCase;blockWrites?:boolean;checkVersion?:number;signInUrl?:string}={}){
  const events:RunEvent[]=[];
  await createPlaywrightRuntime({checkTimeoutMs:3000}).start({mode:'run',targetUrl:target,allowedOrigins,timeoutSeconds,credentials:account,case:item,spec:{code,hash:specHash(code)},blockWrites,checkVersion,...(signInUrl?{signInUrl}:{})},event=>{if(!['frame','case'].includes(event.type as string))events.push(event as RunEvent);}).promise;
  return events;
}
async function finished({manager,context}:Progress,id:string,seconds=90){
  for(const end=Date.now()+seconds*1000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status))return report;}
  throw new Error('The run did not finish.');
}
async function verified({manager,context}:Progress,{id=journey.id,seconds=90}={}){
  for(const end=Date.now()+seconds*1000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){const verification=(await manager.view(context)).specs[id]?.draft?.verification;if(verification&&verification.status!=='running')return verification;}
  throw new Error('The verification did not finish.');
}

test('a later response wait follows run-owned request data through three saves and a caught control',{timeout:90000},async t=>{
  const item={...journey,id:'create-update',name:'Create and update a profile',steps:[
    {id:'create',title:'Save and read the new name',checks:[{type:'text-visible' as const,value:'Saved {run}'}]},
    {id:'update',title:'Update and read the saved name',checks:[{type:'text-visible' as const,value:'Updated {run}'}]},
  ],assertions:[]};
  const f=await setup(t,{item});
  const code="import { test } from 'perpetual';\ntest('Create and update a profile', async ({page,journey}) => {\n"+
    "await journey.milestone('create',async()=>{ await journey.signIn(); await page.getByLabel('Display name').fill(`Saved ${journey.run}`); await Promise.all([page.waitForResponse('**/settings'),page.getByRole('button',{name:'Save'}).click()]); await page.goto('/profile'); });\n"+
    "await journey.milestone('update',async()=>{ await page.goto('/rename?query=yes'); await page.getByLabel('Display name').fill(`Updated ${journey.run}`); await Promise.all([page.waitForResponse(`**/rename?name=Updated%20${journey.run}`),page.getByRole('button',{name:'Rename'}).click()]); await page.goto('/profile'); });\n});";
  const draft=await f.draft(code);assert.ok(draft.draft);
  await f.manager.verifySpec(f.context,{caseId:item.id,hash:draft.draft.hash,credentials:account});
  assert.deepEqual(await verified(f,{id:item.id}),{status:'passed',passes:3,control:'caught'});
  const attempts=(await f.manager.view(f.context)).runs.filter(run=>run.verification);
  assert.equal(attempts.length,4);assert.equal(attempts.filter(run=>run.status==='passed').length,3);
  assert.equal(attempts.find(run=>run.verification?.control)?.results?.[0].controlRead,true);
  assert.equal(f.app.state.credits,7,'The control cannot save another profile.');
});

test('a draft spec passes its reviewed journey with live frames, actions and a recording, and is approved after its verification',{timeout:180000},async t=>{
  const persisted={...journey,steps:journey.steps.map(step=>step.id==='save-name'?{...step,checks:step.checks.filter(check=>check.type!=='text-visible')}:step)};
  const f=await setup(t,{item:persisted});
  const uncoded=await finished(f,(await f.run()).run.id);
  assert.equal(uncoded.results[0].error,'Generate and approve code for this journey.');
  const {draft}=await f.draft(spec().replace("await page.getByRole('button', { name: 'Save' }).click();","await page.getByRole('button', { name: 'Save' }).click(); await page.waitForLoadState('load'); await page.reload();"));
  const gated=await finished(f,(await f.manager.run(f.context,{credentials:account})).run.id);
  assert.equal(gated.results[0].error,'Generate and approve code for this journey.','Only a person runs a draft.');
  const {run}=await f.run();
  assert.equal(run.engine,'playwright');
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'passed',JSON.stringify(report.results));
  assert.deepEqual(report.results,[{caseId:journey.id,status:'passed',engine:'playwright',assertions:[{type:'text-absent',value:'Original Name',passed:true}]}]);
  const [progress]=report.progress.cases;
  assert.deepEqual(progress.steps!.map(step=>[step.id,step.status]),journey.steps.map(step=>[step.id,'completed']));
  // The number read before saving is compared after it.
  assert.deepEqual(progress.steps!.flatMap(step=>step.checks!.map(check=>['name' in check?check.name:check.value,check.passed,check.observed])),[['/settings',true,undefined],['before',true,10],['after',true,9],['Signed in as Twin Tester',true,undefined]]);
  assert.match(progress.steps![1].evidence??'',/^Reviewed checks passed: Credits 9 < before 10\.$/);
  // The explicit load wait and each reload's document-activation wait are real reported actions.
  assert.deepEqual(progress.actions.map(action=>action.type),['sign_in_with_test_account','input','click','wait','wait','reload_page','wait','reload_page']);
  assert.ok(progress.actions.every(action=>action.status==='passed'));
  const frame=await f.manager.frame(f.context,run.id,journey.id);
  assert.ok(frame!.length>100&&frame![0]===0xff&&frame![1]===0xd8,'A JPEG frame reached the live view.');
  assert.equal(progress.videos!.length,1);
  const video=await f.manager.video(f.context,run.id,journey.id,progress.videos![0]);
  assert.ok((await stat(video.path)).size>1000);
  assert.ok(!JSON.stringify(report).includes(account.password));
  // Three more passing runs, then a control run in which the rename cannot be saved: its reviewed check notices.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:draft!.hash,credentials:account});
  assert.deepEqual(await verified(f),{status:'passed',passes:3,control:'caught'});
  const control=(await f.manager.view(f.context)).runs.find(item=>item.verification?.control)!,result=control.results![0];
  assert.deepEqual([result.status,result.error],['failed','Milestone check failed: Save the display name Twin Tester.']);
  const saved=(await f.manager.runProgress(f.context,control.id)).progress!.cases[0].steps![1];
  assert.deepEqual([saved.status,(saved.checks![0] as {label?:string}).label,saved.checks![0].passed],['failed','Credits',false]);
  assert.equal(f.app.posts.filter(post=>post==='POST /settings').length,4,'Only the four unblocked runs saved the name.');
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:draft!.hash});
  assert.equal((await f.manager.view(f.context)).specs[journey.id].approved?.hash,draft!.hash);
});

test('a control run blocks every write from the page but lets the fixture sign in',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const events=await runSpec(target,spec(),{blockWrites:true});
  assert.deepEqual(f.app.posts,['POST /login'],'The sign-in form posted; the settings form never reached the application.');
  assert.deepEqual([f.app.state.name,f.app.state.credits],['Original Name',10]);
  // A failed check on the blocked submission itself cannot certify that the application kept nothing.
  const steps=events.filter(event=>event.type==='journey-step');
  assert.deepEqual(steps.map(event=>`${event.stepId}:${event.status}`),['open-settings:running','open-settings:completed','save-name:running','save-name:failed']);
  assert.equal(steps.at(-1)?.evidence,'Reviewed check failed: Text visible “Saved”.');
  const facts=events.at(-1)?.result;
  assert.deepEqual(facts,{caseId:journey.id,assertions:[],controlRead:false,stopCause:'none'});
  assert.equal(journeyResult(journey,facts,journey.steps.map(({id,title},index)=>({id,title,status:['completed','failed','pending'][index]}))).status,'failed');
  // The same code without the block saves the name.
  await runSpec(target,spec());
  assert.deepEqual(f.app.posts,['POST /login','POST /login','POST /settings']);
  // A script's write is answered 503 without reaching the application, and the page goes on to be judged.
  const notes={...journey,id:'rename',steps:[{id:'open-notes',title:'Open Notes',checks:[{type:'text-visible',value:'Notes 0'}]},{id:'add-note',title:'Add a note',checks:[{type:'text-visible',value:'Note added'}]}],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
  const note=`import { test } from 'perpetual';\ntest('Add a note', async ({ page, journey }) => {\n  await journey.milestone('open-notes', async () => {\n    await journey.signIn();\n    await page.goto('/notes');\n  });\n  await journey.milestone('add-note', async () => {\n    await page.getByRole('button', { name: 'Add note' }).click();\n  });\n});\n`;
  validateJourneySpec(note,notes);
  const noted=(await runSpec(target,note,{item:notes,blockWrites:true})).filter(event=>event.type==='journey-step').map(event=>`${event.stepId}:${event.status}`);
  assert.deepEqual(noted,['open-notes:running','open-notes:completed','add-note:running','add-note:failed']);
  assert.deepEqual([f.app.state.notes,f.app.seen,f.app.posts.includes('POST /notes')],[0,['503'],false]);
});

test('a control run passes a journey whose checks cannot tell that nothing was kept, which its verification misses',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  // Only the first milestone is checked, and only by its address: with the rename blocked, every milestone still completes.
  const weak={...journey,steps:journey.steps.map((step,index)=>({...step,checks:index?[]:[step.checks[0]]})),assertions:[]};
  const events=await runSpec(target,spec(),{item:weak,blockWrites:true}),facts=events.at(-1)?.result;
  assert.deepEqual(events.filter(event=>event.type==='journey-step'&&event.status!=='running').map(event=>`${event.stepId}:${event.status}`),['open-settings:completed','save-name:completed','reload:completed']);
  assert.equal(journeyResult(weak,facts,weak.steps.map(({id,title})=>({id,title,status:'completed'}))).status,'passed');
  assert.deepEqual([f.app.state.name,f.app.posts],['Original Name',['POST /login']]);
});

test('a control run drops what a page sends over a WebSocket once the journey acts, except while the fixture signs in, and a check on the kept notes catches it',{timeout:180000},async t=>{
  const f=await setup(t);
  await f.manager.saveCases(f.context,[live]);
  const {draft}=await f.draft(liveSpec());
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:draft!.hash,credentials:account});
  assert.deepEqual(await verified(f),{status:'passed',passes:3,control:'caught'});
  // Every socket said hello as it opened, the sign-in page's before the journey showed the form, and every run signed in
  // over its socket; only the three unblocked runs' notes reached the application.
  const run=['hello','sign-in','hello','add','hello'];
  assert.deepEqual([f.app.state.notes,f.app.received],[3,[...run,...run,...run,'hello','sign-in','hello','hello']]);
  // The control run showed Note added as the page sent it, but the reload counted no new note.
  const control=(await f.manager.view(f.context)).runs.find(item=>item.verification?.control)!;
  const steps=(await f.manager.runProgress(f.context,control.id)).progress!.cases[0].steps!;
  assert.deepEqual(steps.map(step=>step.status),['completed','completed','failed']);
  assert.deepEqual(steps[2].checks!.map(check=>[check.passed,check.observed]),[[false,3]]);
});

test('a control run lets a socket opened after sign-in say hello, so checks that cannot tell that the note was not kept pass',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const ends=async(code:string,item:ApprovedCase)=>{const events=await runSpec(target,code,{item,blockWrites:true});return [events.filter(event=>event.type==='journey-step'&&event.status!=='running').map(event=>`${event.stepId}:${event.status}`),events.at(-1)?.result];};
  const passed=(item:ApprovedCase)=>[item.steps!.map(step=>`${step.id}:completed`),{caseId:journey.id,assertions:[],stopCause:'none'}];
  // Notes arrive only after a socket says hello; after the reload Notes is only read again, never compared.
  const weak={...live,steps:live.steps.map((step,index)=>index===2?{...step,checks:[{type:'read-number' as const,label:'Notes',name:'after'}]}:step)};
  assert.deepEqual(await ends(liveSpec('page',true),weak),passed(weak));
  assert.deepEqual([f.app.state.notes,f.app.received],[0,['hello','hello']]);
  // A page that signed in over its socket, after the journey showed the form, then opens one for Notes: what that socket
  // sends is no write around the block.
  const spa={...live,steps:live.steps.map((step,index)=>index===2?{...step,checks:[]}:step)};
  assert.deepEqual(await ends(liveSpec('spa'),spa),passed(spa));
  assert.deepEqual([f.app.state.notes,f.app.received],[0,['hello','hello','hello','sign-in','hello','hello']]);
});

test('a control run lets the account sign in over a socket on the stage\'s sign-in page, then drops what the journey sends',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=new URL('/welcome',(await f.manager.view(f.context)).config.targetUrl).href;
  // The application URL shows no sign-in form, so signIn() opens the sign-in page: a new document, whose form signs in
  // over its socket while the fixture signs in.
  const code=`import { test } from 'perpetual';

test('Add a note', async ({ page, journey }) => {
  await journey.milestone('open-notes', async () => {
    await journey.signIn();
  });
  await journey.milestone('add-note', async () => {
    await page.getByRole('button', { name: 'Add note' }).click();
  });
  await journey.milestone('reload', async () => {
    await page.reload();
  });
});
`;
  const events=await runSpec(target,code,{item:live,blockWrites:true,signInUrl:new URL('/socket-sign-in',target).href});
  assert.deepEqual(events.filter(event=>event.type==='journey-step'&&event.status!=='running').map(event=>`${event.stepId}:${event.status}`),['open-notes:completed','add-note:completed','reload:failed']);
  assert.deepEqual([f.app.state.notes,f.app.received],[0,['hello','sign-in','hello','hello']]);
});

test('identifier-first navigation permits password-step socket authentication, then the control catches the blocked note',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=new URL('/welcome',f.app.url).href;
  const code=`import { test } from 'perpetual';
test('Add a note', async ({ page, journey }) => {
  await journey.milestone('open-notes', async () => { await journey.signIn(); });
  await journey.milestone('add-note', async () => { await page.getByRole('button', { name: 'Add note' }).click(); });
  await journey.milestone('reload', async () => { await page.reload(); });
});`;
  const options={item:live,signInUrl:new URL('/socket-identifier',target).href};
  const saved=await runSpec(target,code,options);
  const blocked=await runSpec(target,code,{...options,blockWrites:true});
  const statuses=(events:RunEvent[])=>events.filter(event=>event.type==='journey-step'&&event.status!=='running').map(event=>`${event.stepId}:${event.status}`);
  assert.deepEqual(statuses(saved),['open-notes:completed','add-note:completed','reload:completed'],JSON.stringify(saved.at(-1)));
  assert.deepEqual(statuses(blocked),['open-notes:completed','add-note:completed','reload:failed'],JSON.stringify(blocked.at(-1)));
  assert.deepEqual([f.app.state.notes,f.app.posts],[1,['POST /socket-identify','POST /socket-identify']]);
  assert.deepEqual(f.app.received,['hello','sign-in','hello','add','hello','hello','sign-in','hello','hello']);
});

test('a control run that a write could get around cannot pass, so its verification is never missed',{timeout:180000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const ends=async(via:string,item:ApprovedCase=live)=>(await runSpec(target,liveSpec(via),{item,blockWrites:true})).at(-1)?.result;
  // A worker's socket, a shared worker and a page's WebSocketStream bypass every route, and a socket that opens after the
  // click sends before the journey acts again: the note is kept and every check passes, which proves nothing.
  for(const via of ['worker','shared','stream','lazy'])assert.deepEqual(await ends(via),{caseId:journey.id,assertions:[],stopCause:'action',error:via==='shared'?'The control run cannot block shared-worker communication.':'The control run could not block everything the pages sent.'},via);
  assert.equal(f.app.state.notes,4);
  // The page's own socket signs in, and checks that cannot tell pass: the sign-in it forwarded is no write around the block.
  assert.deepEqual(await ends('page',{...live,steps:live.steps.map((step,index)=>index?{...step,checks:[]}:step)}),{caseId:journey.id,assertions:[],stopCause:'none'});
  assert.deepEqual([f.app.state.notes,f.app.received.filter(type=>type!=='hello')],[4,['sign-in','add','sign-in','add','sign-in','add','sign-in','add','sign-in']]);
});

test('a failed reviewed check retains the shared-worker control refusal',{timeout:60000},async t=>{
  const f=await setup(t),target=(await f.manager.view(f.context)).config.targetUrl;
  const item={...live,steps:live.steps.map((step,index)=>index===2?{...step,checks:[{type:'text-visible' as const,value:'Name {run}'}]}:step)};
  const events=await runSpec(target,liveSpec('shared'),{item,blockWrites:true});
  assert.equal(events.some(event=>event.type==='journey-step'&&event.stepId===item.steps[2].id&&event.status==='failed'),true);
  assert.deepEqual(events.at(-1)?.result,{caseId:journey.id,assertions:[],controlRead:false,controlBlocker:'shared-worker',stopCause:'action',error:'The control run cannot block shared-worker communication.'});
});

test('a reviewed check the application does not satisfy fails the journey',{timeout:120000},async t=>{
  const f=await setup(t,{persist:false});
  await f.draft(spec());
  const {run}=await f.run();
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'failed');
  assert.equal(report.results[0].error,'Milestone check failed: Reload Settings and see the new name.');
  const steps=report.progress.cases[0].steps;
  assert.deepEqual(steps!.map(step=>step.status),['completed','completed','failed']);
  assert.equal(steps![2].checks![0].passed,false);
  assert.deepEqual(report.results[0].assertions,[],'The end state was never reached, so no final assertion ran.');
});

test('a spec action that cannot complete needs review, never a product failure',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.draft(spec({missing:true}));
  const {run}=await f.run();
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'needs_review');
  assert.match(report.results[0].error??'',/^Action failed at “Save the display name Twin Tester”: .*locator\.fill: Timeout 1000ms exceeded/);
  assert.deepEqual(report.progress.cases[0].steps!.map(step=>step.status),['completed','unconfirmed','pending']);
  assert.equal(report.progress.cases[0].actions.at(-1)?.status,'failed');
});

test('skipping a Playwright journey stops its process and keeps its recording',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.draft(spec({linger:true}));
  const {run}=await f.run();
  for(;!(await f.manager.runProgress(f.context,run.id)).progress.cases[0].steps!.some(step=>step.id==='reload'&&step.status==='running');)await new Promise(resolve=>setTimeout(resolve,100));
  const skipped=Date.now();
  await f.manager.skip(f.context,run.id,journey.id);
  const report=await finished(f,run.id,30);
  assert.ok(Date.now()-skipped<20000,'Skip stopped the lingering journey.');
  assert.equal(report.run.status,'completed');
  assert.equal(report.progress.cases[0].status,'skipped');
  assert.deepEqual(report.progress.cases[0].steps!.map(step=>step.status),['completed','completed','skipped']);
  assert.equal(report.progress.cases[0].videos?.length,1);
});

test('leaving the approved origins needs review, whether by address, server redirect or clicked link',{timeout:120000},async t=>{
  const f=await setup(t);
  // The same server under another host name is another origin.
  const target=(await f.manager.view(f.context)).config.targetUrl,outside=`${target.replace('127.0.0.1','localhost')}settings`;
  for(const reload of [`await page.goto('${outside}');`,`await page.goto('/away?to=${encodeURIComponent(outside)}');`,`await page.goto('/link?to=${encodeURIComponent(outside)}');\n    await page.getByText('Leave').click();`]){
    await f.draft(spec({reload}));
    const report=await finished(f,(await f.run()).run.id);
    assert.equal(report.run.status,'needs_review',reload);
    assert.equal(report.results[0].error,'Action failed at “Reload Settings and see the new name”: Navigation is outside approved origins.',reload);
    assert.deepEqual(report.progress.cases[0].steps!.map(step=>step.status),['completed','completed','unconfirmed'],reload);
  }
  assert.deepEqual([...f.app.hosts],[new URL(target).host],'No request, not even a redirect hop, reached the other origin.');
  // A Stripe page loads only in test mode: a live Checkout behind a redirect, or a page that does not show test mode, stops the journey.
  const pay={...journey,steps:[{id:'pay',title:'Pay',checks:[{type:'text-visible',value:'Paid'}]}],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
  for(const address of [`/away?to=${encodeURIComponent('https://checkout.stripe.com/c/pay/cs_live_a1')}`,'https://buy.stripe.com/aEU5kD']){
    const code=`import { test } from 'perpetual';\ntest('Pay', async ({ page, journey }) => {\n  await journey.milestone('pay', async () => {\n    await page.goto('${address}');\n  });\n});\n`;
    const events=await runSpec(target,code,{item:pay,allowedOrigins:[new URL(target).origin,'https://checkout.stripe.com','https://buy.stripe.com']});
    assert.deepEqual(events.at(-1)?.result,{caseId:journey.id,assertions:[],stopCause:'action',error:'Action failed at “Pay”: Payment pages accept input only in Stripe test mode.'},address);
  }
});

test('a spec that skips a milestone, differs from its approval or runs out of time needs review',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  // Validation rejects a conditional milestone; the fixture enforces coverage for any spec that reaches it.
  const conditional=spec().replace("  await journey.milestone('reload'","  if (await page.getByText('Never shown').count()) await journey.milestone('reload'");
  assert.throws(()=>validateJourneySpec(conditional,journey),/Line 11: the test body only awaits journey\.milestone/);
  assert.deepEqual((await runSpec(target,conditional)).at(-1)?.result,{caseId:journey.id,assertions:[],stopCause:'action',error:'The spec did not run every reviewed milestone in order.'});
  // A worker handed code that is not the approved spec refuses to run it.
  const facts:unknown[]=[],code=spec();
  await createPlaywrightRuntime().start({mode:'run',targetUrl:target,allowedOrigins:[new URL(target).origin],timeoutSeconds:30,case:journey,spec:{code,hash:specHash(`${code}\n`)}},event=>{if(event.type==='result')facts.push(event.result);}).promise;
  assert.deepEqual(facts,[{caseId:journey.id,assertions:[],stopCause:'action',error:'The spec differs from its approved version.'}]);
  // Playwright's test timeout is the journey's deadline.
  const events=await runSpec(target,spec({linger:true}),{timeoutSeconds:4});
  assert.deepEqual(events.filter(event=>event.type==='journey-step').map(event=>`${event.stepId}:${event.status}`),['open-settings:running','open-settings:completed','save-name:running','save-name:completed','reload:running']);
  assert.equal(events.at(-1)?.result?.stopCause,'deadline');
});

test('a spec that escaped validation can neither forge milestones, read the account and the run token, nor change journey.run',{timeout:120000},async t=>{
  const f=await setup(t,{persist:false});
  const target=(await f.manager.view(f.context)).config.targetUrl;
  // Rewriting the page after a reload would pass the application that does not keep the name; the grammar has no page scripts.
  await assert.rejects(f.draft(spec({reload:"await page.reload();\n    await page.addScriptTag({ content: \"document.body.innerHTML = document.body.innerHTML.replaceAll('Original Name', 'Twin Tester')\" });"})),/Line 13: page\.addScriptTag is not an allowed journey action\./);
  // Milestones named only in a comment, forged events on the channel, a changed run token, and the account and the
  // token sent through Node's fetch.
  const forged=`import { test } from 'perpetual';
// journey.milestone('open-settings', …); journey.milestone('save-name', …); journey.milestone('reload', …);
test('Rename the display name', async ({ page, journey }) => {
  const p = process, say = event => p.stdout.write(p.env.PERPETUAL_EVENT_CHANNEL + JSON.stringify({ ...event, caseId: 'rename' }) + '\\n');
  for (const stepId of ['open-settings', 'save-name', 'reload']) { say({ type: 'journey-step', stepId, status: 'running' }); say({ type: 'journey-step', stepId, status: 'completed', evidence: 'Forged.', checks: [] }); }
  say({ type: 'assertions', assertions: [{ type: 'text-absent', value: 'Original Name', passed: true }] });
  let assigned = 'kept';
  try { journey.run = 'forged00'; } catch (error) { assigned = error.name; }
  await fetch(p.env.PERPETUAL_TARGET_URL + 'leak?' + new URLSearchParams({ pw: String(p.env.PERPETUAL_ACCOUNT_PASSWORD), token: String(p.env.PERPETUAL_RUN_TOKEN), assigned, run: journey.run }));
});
`;
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:journey.id,code:forged}),/Line 4: the test body only awaits journey\.milestone/);
  const events=await runSpec(target,forged),facts=events.at(-1)?.result;
  assert.deepEqual(events.map(event=>event.type),['result'],'No forged milestone or assertion reached the controller.');
  const [leak]=f.app.leaks;
  assert.deepEqual([f.app.leaks.length,leak.pw,leak.token,leak.assigned],[1,'undefined','undefined','TypeError'],'The spec ran; the account and the token had left its environment, and journey.run cannot be changed.');
  assert.match(leak.run,RUN_TOKEN);
  assert.equal(journeyResult(journey,facts,journey.steps.map(({id,title})=>({id,title,status:'pending'}))).status,'needs_review');
});

// A journey that saves a display name and reopens the profile, where the name is shown only in its field. Its code types
// what its reviewed check reads: a run-unique value holding journey.run for {run}, or a fixed one.
const keep=(name:string)=>({id:'keep',name:'Keep a display name',goal:'Save a display name and see it on the profile.',isolation:'shared',selected:true,needsReview:false,
  steps:[
    {id:'open-settings',title:'Sign in and open Settings',checks:[{type:'url-contains',value:'/settings'}]},
    {id:'save-name',title:'Save a new display name',checks:[]},
    {id:'reopen',title:'Reopen the profile and see the name',checks:[{type:'text-visible',value:name}]},
  ],
  preconditions:['A test account'],expectedOutcomes:['The profile shows the saved name.'],assertions:[]}) satisfies Omit<BrowserCase,'evidence'>;
const keepSpec=(typed:string)=>`import { test } from 'perpetual';

test('Keep a display name', async ({ page, journey }) => {
  await journey.milestone('open-settings', async () => {
    await journey.signIn();
  });
  await journey.milestone('save-name', async () => {
    await page.getByLabel('Display name').fill(${typed});
    await page.getByRole('button', { name: 'Save' }).click();
  });
  await journey.milestone('reopen', async () => {
    await page.goto('/profile');
  });
});
`;

test('a journey that saves a run-unique value is verified, while one whose fixed value earlier runs stored is missed',{timeout:180000},async t=>{
  const unique=keep('QA {run}'),f=await setup(t,{item:unique});
  const {draft}=await f.draft(keepSpec('`QA ${journey.run}`'));
  await f.manager.verifySpec(f.context,{caseId:unique.id,hash:draft!.hash,credentials:account});
  assert.deepEqual(await verified(f,{id:unique.id}),{status:'passed',passes:3,control:'caught'});
  const attempts=(await f.manager.view(f.context)).runs.filter(run=>run.verification).sort((a,b)=>a.verification!.attempt!-b.verification!.attempt!);
  const reopened=await Promise.all(attempts.map(async run=>(await f.manager.runProgress(f.context,run.id)).progress!.cases[0].steps![2]));
  // Each attempt typed its own value; the control run looked for its own and found only the name stored before it.
  const resolved=reopened.map(step=>step.checks![0].resolved!);
  assert.equal(new Set(resolved).size,4);assert.ok(resolved.every(value=>/^QA [a-z0-9]{8}$/.test(value)),resolved.join());
  assert.deepEqual(reopened.map(step=>[step.status,(step.checks![0] as {value?:string}).value]),[['completed','QA {run}'],['completed','QA {run}'],['completed','QA {run}'],['failed','QA {run}']]);
  assert.equal(reopened[2].evidence,`Reviewed checks passed: Text visible “QA {run}” (“${resolved[2]}”).`);
  assert.equal(reopened[3].evidence,`Reviewed check failed: Text visible “QA {run}” (“${resolved[3]}”).`);
  assert.equal(f.app.state.name,resolved[2],'The last ordinary run saved its value; the control run saved nothing.');
  // A fixed value passes the control run once an earlier run stored it: its check cannot tell that nothing was kept.
  const fixed=keep('QA Tester'),target=(await f.manager.view(f.context)).config.targetUrl,code=keepSpec("'QA Tester'");
  validateJourneySpec(code,fixed);
  await runSpec(target,code,{item:fixed});
  const steps=(await runSpec(target,code,{item:fixed,blockWrites:true})).filter(event=>event.type==='journey-step'&&event.status!=='running');
  assert.deepEqual(steps.map(event=>`${event.stepId}:${event.status}`),['open-settings:completed','save-name:completed','reopen:completed']);
  assert.equal(f.app.posts.filter(post=>post==='POST /settings').length,4,'Three ordinary attempts and the fixed run saved; neither control run did.');
});

test('a text check reads what visible form fields hold, never a password, and waits for a value to appear',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const visible=['field name','Field Bio','Pro plan','Field Late'],absent=['Field Secret','Field Hidden','Field Invisible','Field Box','Basic plan'];
  const fields={...journey,id:'fields',steps:[{id:'open-fields',title:'Open the form',checks:visible.map(value=>({type:'text-visible' as const,value}))}],
    // Every final assertion is evaluated: those that pass, then a field's value, which is not absent, and a password, which is never visible.
    assertions:[...absent.map(value=>({type:'text-absent' as const,value})),{type:'text-absent' as const,value:'Field Name'},{type:'text-visible' as const,value:'Field Secret'}]};
  const code=`import { test } from 'perpetual';\ntest('Fields', async ({ page, journey }) => {\n  await journey.milestone('open-fields', async () => {\n    await page.goto('/fields');\n  });\n});\n`;
  validateJourneySpec(code,fields);
  const events=await runSpec(target,code,{item:fields}),step=events.find(event=>event.type==='journey-step'&&event.status!=='running');
  assert.deepEqual([step?.status,step?.evidence],['completed',`Reviewed checks passed: ${visible.map(value=>`Text visible “${value}”`).join('; ')}.`]);
  assert.deepEqual(events.at(-1)?.result?.assertions.map(item=>item.passed),[...absent.map(()=>true),false,false]);
  // Code approved under check version 1 keeps its checks: they read visible text only.
  const older=(await runSpec(target,code,{item:fields,checkVersion:1})).find(event=>event.type==='journey-step'&&event.status!=='running');
  assert.deepEqual([older?.status,older?.evidence],['failed','Reviewed check failed: Text visible “field name”.']);
});

// A journey renames the display name with a run-unique value, then looks for it. The rename page shows the name only
// in the field the journey typed into.
const renamed={id:'renamed',name:'Rename and see the name',goal:'Rename the display name and see it kept.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'rename',title:'Rename the display name',checks:[]},{id:'see',title:'See the new name',checks:[{type:'text-visible',value:'Renamed {run}'}]}],
  preconditions:[],expectedOutcomes:['The new name is kept.'],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
const renameSpec=(see:string)=>`import { test } from 'perpetual';
test('Rename and see the name', async ({ page, journey }) => {
  await journey.milestone('rename', async () => {
    await page.goto('/rename');
    await page.getByLabel('Display name').fill(\`Renamed \${journey.run}\`);
    await page.getByRole('button', { name: 'Rename' }).click();
  });
  await journey.milestone('see', async () => {
    ${see}
  });
});
`;
const ended=(events:RunEvent[])=>events.filter(event=>event.type==='journey-step'&&event.status!=='running').map(event=>`${event.stepId}:${event.status}`);

test('a text check never reads what the journey typed into a field, nor a field the browser restored on returning to a page',{timeout:180000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const later='await page.getByRole(\'heading\', { name: \'Rename\' }).click();',back='await page.goto(\'/other\');\n    await page.goBack();',reload='await page.reload();';
  f.app.state.failRename=true;
  // The rename is not saved: the field still holds the typed name on the same page, in a later milestone, after the
  // browser restored it on going back, and in a control run; a reload shows the stored name.
  for(const see of [later,back,reload]){
    const code=renameSpec(see);validateJourneySpec(code,renamed);
    assert.deepEqual(ended(await runSpec(target,code,{item:renamed})),['rename:completed','see:failed'],see);
  }
  assert.deepEqual(ended(await runSpec(target,renameSpec(later),{item:renamed,blockWrites:true})),['rename:completed','see:failed']);
  const same={...renamed,steps:[{...renamed.steps[0],checks:renamed.steps[1].checks},{...renamed.steps[1],checks:[]}]};
  assert.deepEqual(ended(await runSpec(target,renameSpec(later),{item:same})),['rename:failed']);
  assert.equal(f.app.state.name,'Original Name');
  // Saved, the name is what the application puts in the field once the page is opened again.
  f.app.state.failRename=false;
  const events=await runSpec(target,renameSpec(reload),{item:renamed}),seen=events.find(event=>event.type==='journey-step'&&event.stepId==='see'&&event.status!=='running');
  assert.deepEqual([seen?.status,f.app.state.name],['completed',seen?.evidence?.match(/“(Renamed [a-z0-9]{8})”/)?.[1]]);
});

test('a text-absent check passes when only the search field the journey typed into holds the text',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  const search={...journey,id:'search',steps:[{id:'search',title:'Search for the deleted workflow',checks:[{type:'text-visible' as const,value:'No workflows found'},{type:'text-absent' as const,value:'Nightly sync'}]}],assertions:[{type:'text-absent' as const,value:'Nightly sync'}]};
  const code=`import { test } from 'perpetual';\ntest('Search', async ({ page, journey }) => {\n  await journey.milestone('search', async () => {\n    await page.goto('/workflows');\n    await page.getByRole('searchbox', { name: 'Search' }).fill('Nightly sync');\n  });\n});\n`;
  validateJourneySpec(code,search);
  const events=await runSpec(target,code,{item:search});
  assert.deepEqual(ended(events),['search:completed']);
  assert.deepEqual(events.at(-1)?.result?.assertions,[{type:'text-absent',value:'Nightly sync',passed:true}]);
});

test('fresh search query controls prove neither result presence nor result absence, while stored fields and results remain readable',{timeout:60000},async t=>{
  const f=await setup(t),target=(await f.manager.view(f.context)).config.targetUrl;
  const queries=['Native query','ARIA query','Landmark query','Form query','Filter query','Shadow field query','Shadow text query','Slotted field query','Slotted text query'];
  const search={...journey,id:'search-readback',steps:[{id:'search',title:'Read search results',checks:[{type:'text-visible' as const,value:'Search results'},{type:'text-visible' as const,value:'Kept name'}]}],
    assertions:[...queries.flatMap(value=>[{type:'text-visible' as const,value},{type:'text-absent' as const,value}]),
      {type:'text-visible' as const,value:'Kept result'},{type:'text-absent' as const,value:'Kept result'}]};
  const code="import { test } from 'perpetual'; test('Read search results',async({page,journey})=>{await journey.milestone('search',async()=>{await page.goto('/search-readback');});});";
  validateJourneySpec(code,search);
  const events=await runSpec(target,code,{item:search});
  assert.deepEqual(ended(events),['search:completed']);
  assert.deepEqual(events.at(-1)?.result?.assertions.map(check=>check.passed),[false,true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,true,false]);
});
