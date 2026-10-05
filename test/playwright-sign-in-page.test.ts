import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {createBrowserManager} from '../src/browser/manager.ts';
import {PLAYWRIGHT_CLI,createPlaywrightRuntime,journeyEnvironment,writeJourneyWorkspace,type JourneyRunInput} from '../src/journeys/playwright/runtime.ts';
import {specHash} from '../src/journeys/playwright/specs.ts';
import type {BrowserManager,BrowserStageContext} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';

// An application whose URL is a landing page without a sign-in form; the form is at /login. A real local Chromium runs
// the journey's code, as a person's Beta run does. landing replaces the landing page, and /elsewhere redirects to
// elsewhere.
const account={username:'landing-tester@example.com',password:'pw-landing-5190'};
const SIGN_IN_FORM='<form method=post action=/login><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>';
function application({landing='<h1>Plan your week</h1><a href="/login">Sign in</a>',elsewhere=''}:{landing?:string;elsewhere?:string}={}){
  const posts:string[]=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url!,'http://app'),signedIn=/session=1/.test(req.headers.cookie||'');
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const send=(html:string)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>App</title><body>${html}</body>`);};
      const redirect=(location:string,headers={})=>{res.writeHead(303,{location,...headers});res.end();};
      if(req.method!=='GET')posts.push(`${req.method} ${url.pathname}`);
      if(url.pathname==='/')return send(landing);
      if(url.pathname==='/elsewhere'&&elsewhere)return redirect(elsewhere);
      if(url.pathname==='/login'&&req.method==='POST'){const form=new URLSearchParams(body);return form.get('email')===account.username&&form.get('password')===account.password?redirect('/dashboard',{'set-cookie':'session=1; Path=/'}):redirect('/login');}
      if(url.pathname==='/login')return send(SIGN_IN_FORM);
      if(url.pathname==='/dashboard/save'&&req.method==='POST')return redirect(signedIn?'/dashboard?saved=1':'/login');
      if(url.pathname==='/dashboard')return signedIn?send(`<h1>Dashboard</h1><p>Your week is planned</p>${url.searchParams.has('saved')?'<p>Week saved</p>':''}<form method=post action=/dashboard/save><button>Save the week</button></form>`):redirect('/login');
      send('<h1>Nothing here</h1>');
    });
  });
  return new Promise<{server:typeof server;posts:typeof posts;url:string}>(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,posts,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/`})));
}
async function served(t:TestContext,options?:Parameters<typeof application>[0]){const app=await application(options);t.after(()=>{app.server.closeAllConnections();app.server.close();});return app;}
const journey={id:'plan',name:'Open the planned week',goal:'Sign in and see the planned week.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'sign-in',title:'Sign in',checks:[{type:'url-contains',value:'/dashboard'}]},{id:'week',title:'See the planned week',checks:[{type:'text-visible',value:'Your week is planned'}]}],
  preconditions:['A test account'],expectedOutcomes:['The dashboard shows the planned week.'],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
const spec=`import { test } from 'perpetual';

test('Open the planned week', async ({ page, journey }) => {
  await journey.milestone('sign-in', async () => {
    await journey.signIn();
  });
  await journey.milestone('week', async () => {
    await page.reload();
  });
});
`;
const secretFree=(value:unknown)=>!JSON.stringify(value).includes(account.username)&&!JSON.stringify(value).includes(account.password);

async function setup(t:TestContext,options?:Parameters<typeof application>[0]){
  const app=await application(options);
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-sign-in-page-'));await mkdir(join(dataDir,'repo'));
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('The browser-use runtime is not used.');}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:createPlaywrightRuntime({checkTimeoutMs:3000})});
  t.after(async()=>{await manager.close();app.server.closeAllConnections();app.server.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveCases(context,[journey]);
  await manager.saveSpec(context,{caseId:journey.id,code:spec});
  return {app,dataDir,manager,context};
}
async function finished(manager:BrowserManager,context:BrowserStageContext,id:string){
  for(const end=Date.now()+90000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status))return report;}
  throw new Error('The run did not finish.');
}
// Runs a journey's code in the worker directly, keeping every event it reports but its frames: by default this journey
// on its application URL's origin alone.
type RunOptions={signInUrl?:string;origins?:string[];blockWrites?:boolean;item?:Omit<BrowserCase,'evidence'>;code?:string};
async function runSpec(target:string,options:string|RunOptions={}){
  const {signInUrl,origins=[new URL(target).origin],blockWrites,item=journey,code=spec}=typeof options==='string'?{signInUrl:options}:options;
  const events:WorkerEvent[]=[];
  await createPlaywrightRuntime({checkTimeoutMs:3000}).start({mode:'run',targetUrl:target,allowedOrigins:origins,timeoutSeconds:40,credentials:account,case:item,spec:{code,hash:specHash(code)},...(signInUrl?{signInUrl}:{}),...(blockWrites?{blockWrites}:{})},event=>{if(event.type!=='frame')events.push(event);}).promise;
  return events;
}
const resultOf=(events:WorkerEvent[])=>events.find(event=>event.type==='result')?.result as {stopCause:string;error?:string};
// Each milestone's last reported status.
const milestones=(events:WorkerEvent[])=>Object.entries(Object.fromEntries(events.filter(event=>event.type==='journey-step').map(event=>[event.stepId,event.status])));

test('a journey that starts on a landing page signs in on the stage’s sign-in page, and its reviewed checks pass',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.manager.saveConfig(f.context,{targetUrl:f.app.url,signInUrl:`${f.app.url}login#form`,journeyTimeoutSeconds:60});
  const report=await finished(f.manager,f.context,(await f.manager.run(f.context,{credentials:account},{manual:true})).run.id);
  assert.equal(report.run.status,'passed',JSON.stringify(report.results));
  assert.deepEqual(report.progress.cases[0].steps!.map(step=>[step.id,step.status]),[['sign-in','completed'],['week','completed']]);
  assert.deepEqual(report.progress.cases[0].actions.map(action=>action.type),['sign_in_with_test_account','wait','reload_page'],'Opening the sign-in page is part of signing in; reload reports its readiness wait.');
  assert.deepEqual(f.app.posts,['POST /login']);
  assert.ok(secretFree(report)&&!(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).includes(account.password));
  // Every event the worker reports is free of the account.
  f.app.posts.length=0;
  const events=await runSpec(f.app.url,`${f.app.url}login`);
  assert.equal(resultOf(events).stopCause,'none',JSON.stringify(events));
  assert.ok(events.length>3&&secretFree(events),JSON.stringify(events));
});

test('without a sign-in page, a landing page stops the first milestone with an actionable message',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.manager.saveConfig(f.context,{targetUrl:f.app.url,journeyTimeoutSeconds:60});
  const [report,missing]=await Promise.all([
    f.manager.run(f.context,{credentials:account},{manual:true}).then(({run})=>finished(f.manager,f.context,run.id)),
    // A sign-in page that shows no form says so too.
    runSpec(f.app.url,`${f.app.url}missing`),
  ]);
  assert.equal(report.results[0].status,'needs_review');
  assert.equal(report.results[0].error,'Action failed at “Sign in”: The application URL shows no sign-in form. Set the sign-in page.');
  assert.deepEqual(report.progress.cases[0].steps!.map(step=>step.status),['unconfirmed','pending']);
  assert.equal(resultOf(missing).error,'Action failed at “Sign in”: The sign-in page shows no sign-in form. Check the sign-in page.');
  assert.deepEqual(f.app.posts,[],'The account was entered nowhere.');
  assert.ok(secretFree(report)&&secretFree(missing));
});

test('a landing page with a sign-up form signs in on the sign-in page, and the sign-up form never receives the account',{timeout:120000},async t=>{
  // A sign-up form marks its password new-password, or asks for it twice.
  const forms=['<form method=post action=/signup><label>Email <input type=email name=email></label><label>Choose a password <input type=password name=password autocomplete=new-password></label><button type=submit>Create account</button></form>',
    '<form method=post action=/signup><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><label>Repeat it <input type=password name=confirm></label><button type=submit>Create account</button></form>'];
  const apps=await Promise.all(forms.map(form=>served(t,{landing:`<h1>Plan your week</h1>${form}`})));
  const [marked,repeated,unset]=await Promise.all([...apps.map(app=>runSpec(app.url,`${app.url}login`)),runSpec(apps[0].url)]);
  for(const events of [marked,repeated]){
    assert.equal(resultOf(events).stopCause,'none',JSON.stringify(events));
    assert.deepEqual(milestones(events),[['sign-in','completed'],['week','completed']]);
    assert.ok(secretFree(events));
  }
  // Without a sign-in page, a sign-up form is no sign-in form either.
  assert.equal(resultOf(unset).error,'Action failed at “Sign in”: The application URL shows no sign-in form. Set the sign-in page.');
  assert.deepEqual(apps.map(app=>app.posts),[['POST /login'],['POST /login']],'The account was entered only into the sign-in form.');
});

test('a hash-routed application signs in on the sign-in page its hash names',{timeout:120000},async t=>{
  const router=`<main id=view></main><script>const show=()=>{document.getElementById('view').innerHTML=location.hash==='#/login'?${JSON.stringify(SIGN_IN_FORM)}:'<h1>Plan your week</h1><a href="#/login">Sign in</a>';};addEventListener('hashchange',show);show();</script>`;
  const f=await setup(t,{landing:router});
  await f.manager.saveConfig(f.context,{targetUrl:f.app.url,signInUrl:`${f.app.url}#/login`,journeyTimeoutSeconds:60});
  assert.equal((await f.manager.view(f.context)).config.signInUrl,`${f.app.url}#/login`,'A person’s sign-in page keeps its hash.');
  const report=await finished(f.manager,f.context,(await f.manager.run(f.context,{credentials:account},{manual:true})).run.id);
  assert.equal(report.run.status,'passed',JSON.stringify(report.results));
  assert.deepEqual(f.app.posts,['POST /login']);
});

test('a sign-in page that redirects off the application origin never receives the account there',{timeout:120000},async t=>{
  const other=await served(t);
  const app=await served(t,{elsewhere:`${other.url}login`});
  const [approved,refused]=await Promise.all([
    runSpec(app.url,{signInUrl:`${app.url}elsewhere`,origins:[new URL(app.url).origin,new URL(other.url).origin]}),
    runSpec(app.url,{signInUrl:`${app.url}elsewhere`}),
  ]);
  // On an approved origin the form is shown but never filled; on any other the navigation is refused.
  assert.equal(resultOf(approved).error,'Action failed at “Sign in”: The sign-in form is not on the application origin.');
  assert.equal(resultOf(refused).error,'Action failed at “Sign in”: Navigation is outside approved origins.');
  assert.deepEqual([app.posts,other.posts],[[],[]]);
  assert.ok(secretFree(approved)&&secretFree(refused));
});

const saving={...journey,id:'save',name:'Save the planned week',steps:[journey.steps[0],{id:'save',title:'Save the week',checks:[{type:'text-visible',value:'Week saved'}]}]} satisfies Omit<BrowserCase,'evidence'>;
const saveSpec=`import { test } from 'perpetual';

test('Save the planned week', async ({ page, journey }) => {
  await journey.milestone('sign-in', async () => {
    await journey.signIn();
  });
  await journey.milestone('save', async () => {
    await page.getByRole('button', { name: 'Save the week' }).click();
  });
});
`;
test('a control run lets the sign-in on the sign-in page through and blocks every later write',{timeout:120000},async t=>{
  const [control,plain]=await Promise.all([served(t),served(t)]);
  const [blocked,saved]=await Promise.all([
    runSpec(control.url,{signInUrl:`${control.url}login`,blockWrites:true,item:saving,code:saveSpec}),
    runSpec(plain.url,{signInUrl:`${plain.url}login`,item:saving,code:saveSpec}),
  ]);
  assert.deepEqual(milestones(blocked),[['sign-in','completed'],['save','failed']]);
  assert.deepEqual(control.posts,['POST /login'],'Only the sign-in reached the application.');
  // Without write blocking, the same code saves the week.
  assert.deepEqual(milestones(saved),[['sign-in','completed'],['save','completed']]);
  assert.deepEqual(plain.posts,['POST /login','POST /dashboard/save']);
});

test('the journey runtime refuses a sign-in page off its application URL’s origin',()=>{
  const runtime=createPlaywrightRuntime(),input:JourneyRunInput={mode:'run',targetUrl:'http://127.0.0.1:3000/',timeoutSeconds:40,credentials:account,case:journey,spec:{code:spec,hash:specHash(spec)}};
  for(const signInUrl of ['http://127.0.0.1:3001/login','https://127.0.0.1:3000/login','http://localhost:3000/login','/login','',42])
    assert.throws(()=>runtime.start({...input,signInUrl:signInUrl as string},()=>{}),{message:'A Playwright journey’s sign-in page must be on its application URL’s origin.'},String(signInUrl));
});

test('a journey that fails while a filled sign-in form is open leaves no file holding the account',{timeout:120000},async t=>{
  // A sign-in form that keeps what was typed and never signs in, until the journey's time limit.
  const app=await served(t,{landing:'<form onsubmit="event.preventDefault()"><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>'});
  // The workspace, config and environment a journey process gets, kept after Playwright exits so its files can be read.
  const workspace=await mkdtemp(join(tmpdir(),'perpetual-failed-journey-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const config=await writeJourneyWorkspace(workspace,{item:journey,targetUrl:app.url,timeoutSeconds:8,video:false});
  await writeFile(join(workspace,'journey.spec.mjs'),spec);
  const env=journeyEnvironment(process.env,workspace,{hash:specHash(spec),targetUrl:app.url,allowedOrigins:[new URL(app.url).origin],credentials:account,events:false});
  const stdout=await new Promise<string>(resolve=>execFile(process.execPath,[PLAYWRIGHT_CLI,'test','--config',config],{cwd:workspace,env},(_error,out)=>resolve(String(out))));
  const facts=stdout.split('\n').filter(line=>line.startsWith('{"type":"result"')).map(line=>JSON.parse(line).result);
  assert.deepEqual(facts.map(result=>result.stopCause),['deadline'],'The journey ran out of time signing in.');
  const files=(await readdir(workspace,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name));
  assert.ok(files.some(file=>file.includes(join(workspace,'output'))),'Playwright wrote its output for the failed test.');
  for(const file of files)assert.ok(!(await readFile(file,'utf8')).includes(account.password),file);
});
