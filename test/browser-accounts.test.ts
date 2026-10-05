import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserManager} from '../src/browser/manager.ts';
import {createEnvironmentUsage} from '../src/environments/usage.ts';
import {createTwinRuntime} from '../src/twin/runtime.ts';
import {draftCode,manual} from './fixtures/journey-code.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {RunCredentials} from '../src/browser/run-credentials.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';
import type {Json} from '../src/twin/config.ts';
import type {ServiceContext, TwinService} from '../src/twin/registry.ts';

// A twin whose service signs up two test accounts. The actual twin runtime writes its private
// state; only the Docker CLI is replaced. The browser manager reads the password from that state.
type Users={users?:Json};
// What the fake worker receives: a run-only account and, for discovery, auth endpoints.
type Request=JourneyRunInput&{credentials?:RunCredentials;authEndpoints?:string[]};
const auth={id:'auth',title:'Auth',fidelity:'actual' as const,containers:()=>[{name:'auth',image:'auth/server:1.0',ports:{api:9999}}],env:(ctx:ServiceContext<Users>)=>({AUTH_URL:ctx.url('api')}),
  accounts:async(ctx:ServiceContext<Users>)=>(Array.isArray(ctx.options.users)?ctx.options.users.map(String):[]).map(id=>({id,label:`${id[0].toUpperCase()}${id.slice(1)}`,username:`${id}@example.test`,password:`pw-${id}-${Math.random().toString(36).slice(2)}`}))};
const journey=(id:string,name:string)=>({id,name,goal:`${name} and see it saved`,steps:[{id:'sign-in',title:'Sign in'},{id:'save',title:name}],expectedOutcomes:['It is saved'],assertions:[{type:'text-visible',value:'It is saved'}],selected:true,needsReview:false,isolation:'isolated'});
const journeys=[journey('create','Create a workspace'),journey('invite','Invite a teammate')];

async function fixture(t:TestContext,{authEndpoints=[],service=auth}:{authEndpoints?:string[];service?:TwinService<Users>}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-accounts-')),source=join(dataDir,'source'),repo=join(dataDir,'repo');
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await mkdir(source);await mkdir(repo);await writeFile(join(repo,'app.js'),'export const page="Workspace";');
  const twin=createTwinRuntime({exec:async()=>({stdout:'',stderr:''}),services:{auth:service},isFree:async()=>true});
  const prepared=await twin.prepare({dataDir,id:'twin-beta',source,config:{services:{auth:{users:['owner','viewer']}},apps:{web:{start:'node server.js',port:3000}}}});
  const state=JSON.parse(await readFile(join(dataDir,'environments','twin-beta','twin','twin.json'),'utf8'));
  const passwords:Record<string,string>=Object.fromEntries(state.accounts.map((account:{id:string;password:string})=>[account.id,account.password]));
  const environment={id:'twin-beta',stageId:'beta',status:'ready',sandboxId:'twin-beta',apps:prepared.apps,services:prepared.services,accounts:prepared.accounts};
  const environments=[environment];
  const requests:Request[]=[];
  // The worker names the account it signed in with, as its evidence might.
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input:Request,onEvent:(event:WorkerEvent)=>void){
    requests.push(structuredClone(input));
    const seen=input.credentials?.username||'nobody';
    return {cancel(){},promise:delay(5).then(()=>{
      if(input.mode==='discover')onEvent({type:'discovery',summary:`Explored as ${seen}`,authenticated:!!input.credentials,cases:[{...journey('drafted','Archive a workspace'),selected:false,needsReview:true}]});
      else{
        const stepId=input.case.steps![0].id;
        onEvent({type:'journey-step',caseId:input.case.id,stepId,status:'running'});onEvent({type:'journey-step',caseId:input.case.id,stepId,status:'completed',evidence:`Signed in as ${seen}`});
        onEvent({type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:[]}});
      }
    })};
  }};
  const resolveEnvironment=(url:string)=>environments.find(item=>item.apps.some(app=>new URL(app.url).origin===new URL(url).origin))||null;
  const usage=createEnvironmentUsage();
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime,usage,resolveEnvironment});
  t.after(()=>manager.close());
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:repo,sha:'abc'},services:[]}};
  const web=prepared.apps[0].url;
  await manager.saveConfig(context,{targetUrl:`${web}/`,authEndpoints});
  await manager.saveCases(context,journeys);await draftCode(manager,context,journeys);
  // A run releases its environment once its result is saved, so the next run on it waits for that too.
  // Test files run at once, so a loaded runner can take seconds where a quiet one takes milliseconds.
  const finished=async(id:string)=>{for(const deadline=Date.now()+10000;Date.now()<deadline;await delay(5)){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status)&&!(report.run.environmentId&&usage.isBusy(report.run.environmentId)))return report;}throw new Error('Run did not finish.');};
  const run=async(input:Parameters<typeof manager.run>[1])=>{const response=await manager.run(context,input,manual);return {response,report:await finished(response.run.id),request:requests.at(-1)!};};
  return {dataDir,manager,context,requests,passwords,environment,environments,web,run,finished};
}
const hidesPasswords=(f:{passwords:Record<string,string>},value:unknown,where:string)=>{const text=typeof value==='string'?value:JSON.stringify(value);for(const password of Object.values(f.passwords))assert.ok(!text.includes(password),where);};

test('the browser view offers the target twin\'s accounts by label and username, never a password',async t=>{
  const f=await fixture(t);
  const view=await f.manager.view(f.context);
  assert.deepEqual(view.accounts,[{id:'owner',label:'Owner',username:'owner@example.test'},{id:'viewer',label:'Viewer',username:'viewer@example.test'}]);
  hidesPasswords(f,view,'view');
  // A twin that is not ready offers nothing to sign in with.
  f.environment.status='failed';
  assert.deepEqual((await f.manager.view(f.context)).accounts,[]);
});

test('a run without an entered account signs in with the twin\'s first account, which only the worker receives',async t=>{
  const f=await fixture(t);
  const {response,report,request}=await f.run({});
  assert.deepEqual(request.credentials,{username:'owner@example.test',password:f.passwords.owner});
  // One account shares application state, so even independent journeys run one at a time.
  assert.deepEqual([response.run.effectiveConcurrency,response.run.concurrencyLimit],[1,'account']);
  // A twin account is generated test data, so evidence naming it is kept as reported.
  assert.equal(report.progress.cases[0].steps![0].evidence,'Signed in as owner@example.test');
  hidesPasswords(f,response,'run response');
  hidesPasswords(f,report,'run progress');
  hidesPasswords(f,f.manager.summary(f.context),'summary');
  hidesPasswords(f,await f.manager.view(f.context),'view');
  hidesPasswords(f,await readFile(join(f.dataDir,'browser','state.json'),'utf8'),'browser state');
});

test('a run can choose another twin account, an entered account or none, and refuses unknown or mixed choices',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.run({accountId:'viewer'})).request.credentials,{username:'viewer@example.test',password:f.passwords.viewer});
  const entered={username:'someone@example.test',password:'entered-password'};
  assert.deepEqual((await f.run({credentials:entered})).request.credentials,entered);
  const none=await f.run({accountId:null});
  assert.equal('credentials' in none.request,false);
  assert.deepEqual([none.response.run.effectiveConcurrency,none.response.run.concurrencyLimit],[2,null]);
  const runs=f.requests.length;
  await assert.rejects(f.manager.run(f.context,{accountId:'nobody'},manual),/Choose a test account of this environment/);
  await assert.rejects(f.manager.run(f.context,{accountId:'owner',credentials:entered},manual),/Choose one test account/);
  await assert.rejects(f.manager.run(f.context,{accountId:null,credentials:entered},manual),/Choose one test account/);
  await assert.rejects(f.manager.run(f.context,{accountId:7},manual),/Choose one test account/);
  assert.equal(f.requests.length,runs,'A refused choice starts no worker.');
});

test('discovery explores signed in with the same twin account',async t=>{
  const f=await fixture(t,{authEndpoints:[]});
  await f.manager.saveConfig(f.context,{targetUrl:`${f.web}/`,authEndpoints:[`${f.web}/auth/v1/token`]});
  const {run}=await f.manager.discover(f.context,{});
  const report=await f.finished(run.id);
  const request=f.requests.at(-1)!;
  assert.equal(request.mode,'discover');
  assert.deepEqual(request.credentials,{username:'owner@example.test',password:f.passwords.owner});
  assert.deepEqual(request.authEndpoints,[`${f.web}/auth/v1/token`]);
  assert.equal(report.discovery!.authenticated,true);
  assert.equal(report.discovery!.summary,'Explored as owner@example.test');
  hidesPasswords(f,report,'discovery');
  hidesPasswords(f,await f.manager.view(f.context),'view');
});

test('discovery with an entered or twin account requires a sign-in endpoint before starting any work',async t=>{
  const f=await fixture(t),credentials={username:'entered@example.test',password:'fixture-only-password'};
  for(const input of [{credentials},{},{accountId:'viewer'}]){
    await assert.rejects(f.manager.discover(f.context,input),/Add a sign-in API endpoint in Test settings/);
    assert.equal(f.requests.length,0,'Missing endpoint never starts a browser or model.');
    assert.equal((await f.manager.view(f.context)).runs.length,0,'Rejected discovery creates no run.');
  }
  // The refusal releases its reservation and does not block explicitly signed-out discovery.
  const {run}=await f.manager.discover(f.context,{accountId:null});await f.finished(run.id);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].credentials,undefined);
  await f.manager.saveConfig(f.context,{targetUrl:`${f.web}/`,authEndpoints:[`${f.web}/signin`]});
  const signedIn=await f.manager.discover(f.context,{credentials});await f.finished(signedIn.run.id);
  assert.deepEqual(f.requests.at(-1)!.authEndpoints,[`${f.web}/signin`]);
});

test('a manually entered account does not borrow an unselected twin account sign-in endpoint',async t=>{
  const signingIn={...auth,accounts:async(ctx:ServiceContext<Users>)=>(await auth.accounts(ctx)).map(account=>({...account,authEndpoints:[ctx.url('api','/auth/v1/token')]}))};
  const f=await fixture(t,{service:signingIn});
  await assert.rejects(f.manager.discover(f.context,{credentials:{username:'entered@example.test',password:'fixture-only-password'}}),/Add a sign-in API endpoint in Test settings/);
  assert.equal(f.requests.length,0);
  const {run}=await f.manager.discover(f.context,{accountId:'viewer'});await f.finished(run.id);
  assert.equal(f.requests[0].credentials!.username,'viewer@example.test');
});

test('the selected twin account supplies its own sign-in endpoint, not another account’s',async t=>{
  const signingIn={...auth,accounts:async(ctx:ServiceContext<Users>)=>(await auth.accounts(ctx)).map(account=>({...account,authEndpoints:[ctx.url('api',`/auth/${account.id}`)]}))};
  const f=await fixture(t,{service:signingIn});
  const {run}=await f.manager.discover(f.context,{accountId:'viewer'});await f.finished(run.id);
  assert.equal(f.requests[0].credentials!.username,'viewer@example.test');
  assert.equal(f.requests[0].authEndpoints?.length,1);
  assert.match(f.requests[0].authEndpoints![0],/^http:\/\/host\.docker\.internal:\d+\/auth\/viewer$/);
});

test('discovery lets through the sign-in endpoint the twin publishes for its test account',async t=>{
  // A service whose accounts sign in against its own API, as Supabase does with /auth/v1/token.
  const signingIn={...auth,accounts:async(ctx:ServiceContext<Users>)=>(await auth.accounts(ctx)).map(account=>({...account,authEndpoints:[ctx.url('api','/auth/v1/token')]}))};
  const f=await fixture(t,{service:signingIn});
  const {run}=await f.manager.discover(f.context,{});
  await f.finished(run.id);
  const request=f.requests.at(-1)!;
  assert.equal(request.authEndpoints!.length,1,'the account endpoint is the only one; none is configured');
  assert.match(request.authEndpoints![0],/^http:\/\/host\.docker\.internal:\d+\/auth\/v1\/token$/);
  assert.equal(request.credentials!.username,'owner@example.test');
  hidesPasswords(f,await f.manager.view(f.context),'view');
  // Runs may submit anyway, so they get no auth endpoint allowance.
  const {request:runRequest}=await f.run({caseIds:['create']});
  assert.equal(runRequest.authEndpoints,undefined);
});

test('an invalid twin sign-in endpoint fails discovery and releases its environment before another run',async t=>{
  const invalid={...auth,accounts:async(ctx:ServiceContext<Users>)=>(await auth.accounts(ctx)).map(account=>({...account,authEndpoints:['https://other.example/auth/v1/token']}))};
  const f=await fixture(t,{service:invalid});
  await assert.rejects(f.manager.discover(f.context,{}),/Auth endpoints must be on the application host/);
  assert.equal((await f.manager.view(f.context)).runs.length,0);
  assert.equal(f.requests.length,0,'No browser worker starts with invalid sign-in endpoints.');
  await f.run({caseIds:['create']});
});

test('outside a twin with accounts nothing is injected, and a listed account missing from the twin is an error',async t=>{
  const f=await fixture(t);
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});
  assert.deepEqual((await f.manager.view(f.context)).accounts,[]);
  assert.equal('credentials' in (await f.run({})).request,false);
  await assert.rejects(f.manager.run(f.context,{accountId:'owner'},manual),/Choose a test account of this environment/);
  // The environment still lists an account, but its twin state is gone.
  await f.manager.saveConfig(f.context,{targetUrl:`${f.web}/`});
  f.environments[0]={...f.environment,id:'twin-gone',sandboxId:'twin-gone'};
  const runs=f.requests.length;
  await assert.rejects(f.manager.run(f.context,{},manual),/test account is unavailable/);
  assert.equal(f.requests.length,runs);
});
