import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserManager} from '../src/browser/manager.ts';
import {draftCode,manual} from './fixtures/journey-code.ts';
import type {BrowserStageContext} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

// A twin environment as the twin runtime reports it: app URLs on host.docker.internal and
// each service's status, with a blocked service's missing inputs.
const WEB='http://host.docker.internal:43100',API='http://host.docker.internal:43101';
const twin={id:'twin-beta',stageId:'beta',status:'ready',apps:[{id:'service-api',url:API},{id:'service-web',url:WEB}],
  services:[{id:'postgres',fidelity:'actual',status:'ready'},{id:'stripe',fidelity:'official-sandbox',status:'blocked',missing:['secretKey']}]};
const journey={id:'upgrade',name:'Upgrade the plan',goal:'Sign in, pay for the Pro plan and see it active',steps:[{id:'open',title:'Open billing'},{id:'pay',title:'Pay for the Pro plan',checks:[{type:'text-visible',value:'Pro plan active'}]}],
  expectedOutcomes:['The Pro plan is active'],assertions:[{type:'text-visible',value:'Pro'}],selected:true,needsReview:false};

async function fixture(t:TestContext,{environments=[twin],events=()=>[],hold=()=>delay(5)}:{environments?:(typeof twin)[];events?:(input:JourneyRunInput)=>WorkerEvent[];hold?:(input:JourneyRunInput)=>Promise<unknown>}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-twin-'));
  await mkdir(join(dataDir,'repo'));await writeFile(join(dataDir,'repo','app.js'),'export const page="Billing";');
  const requests:JourneyRunInput[]=[];
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void){
    requests.push(structuredClone(input));
    return {cancel(){},promise:hold(input).then(()=>{for(const event of events(input))onEvent(event);})};
  }};
  const resolveEnvironment=(url:string)=>environments.find(item=>item.apps.some(app=>app.url===new URL(url).origin))||null;
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime,resolveEnvironment});
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context=(stageId:string)=>({key:'repo',stageId,controllerOrigin:'http://127.0.0.1:4317',
    scan:{repo:{path:join(dataDir,'repo'),sha:'abc'},services:[{id:'service:web',framework:'Next.js'},{id:'service:api',framework:'Hono'}]}});
  return {manager,context,requests,dataDir};
}
async function settled<T>(read:()=>T|false|null|Promise<T|false|null>):Promise<T>{for(let i=0;i<200;i++){const value=await read();if(value)return value;await delay(5);}throw new Error('Operation did not settle.');}
const prepared=(f:Awaited<ReturnType<typeof fixture>>,context:BrowserStageContext)=>settled(()=>{const {preparation}=f.manager.summary(context);return preparation&&!['preparing','discovering'].includes(preparation.status)&&preparation;});
const finished=(f:Awaited<ReturnType<typeof fixture>>,context:BrowserStageContext,id:string)=>settled(async()=>{const report=await f.manager.runProgress(context,id);return !['queued','running'].includes(report.run.status)&&report;});
const discovered=()=>[{type:'discovery',summary:'Billing observed',cases:[{...journey,id:'drafted',selected:false,needsReview:true}]}];

test('a twin stage targets its web app by default and keeps an explicit target',async t=>{
  const single={...twin,id:'twin-gamma',stageId:'gamma',apps:[{id:'app',url:'http://host.docker.internal:43200'}],services:[]};
  const f=await fixture(t,{environments:[twin,single],events:discovered});
  const beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,twin);
  assert.equal((await prepared(f,beta)).status,'completed');
  assert.equal((await f.manager.view(beta)).config.targetUrl,`${WEB}/`);
  // Discovery may open every app of the twin; unavailable services only matter to runs.
  assert.deepEqual(f.requests[0],{...f.requests[0],mode:'discover',targetUrl:`${WEB}/`,allowedOrigins:[WEB,API]});
  assert.equal('unavailableServices' in f.requests[0],false);
  // Without a recognized web frontend, the twin's only app is the target.
  const gamma=f.context('gamma');
  await f.manager.prepareEnvironment(gamma,single);
  await prepared(f,gamma);
  assert.equal((await f.manager.view(gamma)).config.targetUrl,'http://host.docker.internal:43200/');
  // A target the user chose survives a new twin.
  const chosen=f.context('chosen');
  await f.manager.saveConfig(chosen,{targetUrl:'https://preview.example/billing'});
  await f.manager.prepareEnvironment(chosen,{...twin,id:'twin-chosen',stageId:'chosen'});
  await prepared(f,chosen);
  assert.equal((await f.manager.view(chosen)).config.targetUrl,'https://preview.example/billing');
  assert.equal(f.requests.at(-1)!.targetUrl,'https://preview.example/billing');
});

test('a discovery whose admission cannot be saved leaves the stage\'s preparation as it was',async t=>{
  const f=await fixture(t,{events:discovered}),beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,twin);
  const before=await prepared(f,beta);
  assert.equal(before.status,'completed');
  // The state file cannot be replaced when a person's discovery is admitted.
  const file=join(f.dataDir,'browser','state.json'),saved=await readFile(file,'utf8');
  await rm(file);await mkdir(file);
  try{await assert.rejects(f.manager.discover(beta,{}));}
  finally{await rm(file,{recursive:true});await writeFile(file,saved);}
  assert.deepEqual(f.manager.summary(beta).preparation,before,'The stage still shows its completed preparation.');
  assert.equal(f.requests.length,1,'No worker started.');
  // No unfinished preparation holds the model settings.
  await f.manager.saveModel(beta,{apiKey:'fixture-only',model:'openai/gpt-4.1-mini'});
});

test('verifying code is refused before it starts without an application URL or a ready twin',async t=>{
  const failed={...twin,id:'twin-failed',status:'failed',apps:[{id:'service-web',url:'http://host.docker.internal:43120'}]};
  const f=await fixture(t,{environments:[twin,failed]}),beta=f.context('beta');
  await f.manager.saveCases(beta,[journey]);await draftCode(f.manager,beta,[journey]);
  const verify=async()=>f.manager.verifySpec(beta,{caseId:journey.id,hash:(await f.manager.view(beta)).specs[journey.id].draft!.hash});
  await assert.rejects(verify(),{message:'Set the application URL first.'});
  await f.manager.saveConfig(beta,{targetUrl:'http://host.docker.internal:43120/'});
  await assert.rejects(verify(),{statusCode:409,message:'The selected application environment is not ready. Choose an available application URL.'});
  assert.equal((await f.manager.view(beta)).specs[journey.id].draft!.verification,undefined,'Nothing is recorded against the draft.');
  assert.equal(f.requests.length,0);
});

test('a twin with several apps and no web frontend asks for the application URL',async t=>{
  const f=await fixture(t,{events:discovered});
  const beta={...f.context('beta'),scan:{...f.context('beta').scan,services:[]}};
  await f.manager.prepareEnvironment(beta,twin);
  const preparation=await prepared(f,beta);
  assert.equal(preparation.status,'needs_setup');
  assert.match(preparation.error!,/Choose the application URL/);
  assert.equal((await f.manager.view(beta)).config.targetUrl,'');
  assert.equal(f.requests.length,0);
});

test('saving the public view of an owned legacy target keeps automatic retargeting after a rebuild',async t=>{
  const owned={...twin,sandboxId:twin.id};
  const next={...owned,id:'rebuilt-beta',sandboxId:'rebuilt-beta',apps:[{id:'service-web',url:'http://127.0.0.1:43300'}]};
  const f=await fixture(t,{environments:[owned,next],events:discovered}),beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,owned);await prepared(f,beta);
  const {config}=await f.manager.view(beta);
  assert.equal(config.targetUrl,'http://127.0.0.1:43100/');
  await f.manager.saveConfig(beta,{...config,scope:'Billing outcomes'});
  await f.manager.prepareEnvironment(beta,next);await prepared(f,beta);
  const current=await f.manager.view(beta);
  assert.equal(current.config.targetUrl,'http://127.0.0.1:43300/');
  assert.equal(current.config.scope,'Billing outcomes');
});

test('a twin run preserves a failed business check despite an unavailable service',async t=>{
  const events=(input:JourneyRunInput)=>input.mode!=='run'?[]:[
    {type:'journey-step',caseId:journey.id,stepId:'open',status:'running'},
    {type:'journey-step',caseId:journey.id,stepId:'open',status:'completed',evidence:'Actions completed; this milestone has no reviewed checks.'},
    {type:'journey-step',caseId:journey.id,stepId:'pay',status:'running'},
    {type:'journey-step',caseId:journey.id,stepId:'pay',status:'failed',evidence:'Reviewed check failed: Text visible “Pro plan active”.',checks:[{type:'text-visible',value:'Pro plan active',passed:false}]},
    {type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[]}},
  ];
  const f=await fixture(t,{events});
  const beta=f.context('beta');
  await f.manager.saveConfig(beta,{targetUrl:`${WEB}/billing`,externalOrigins:['https://checkout.stripe.com']});
  await f.manager.saveCases(beta,[journey]);await draftCode(f.manager,beta,[journey]);
  const {run}=await f.manager.run(beta,{},manual);
  const report=await finished(f,beta,run.id);
  assert.deepEqual(f.requests[0].allowedOrigins,[WEB,API,'https://checkout.stripe.com']);
  // The missing dependency is not evidence of what caused a confirmed business failure.
  assert.equal('unavailableServices' in f.requests[0],false);
  assert.equal(report.run.status,'failed');
  assert.equal(report.results[0].status,'failed');
  assert.equal(report.results[0].error,'Milestone check failed: Pay for the Pro plan.');
  assert.equal(report.results[0].blockers,undefined);
});

test('a run outside a twin is blocked on no service',async t=>{
  const events=(input:JourneyRunInput)=>[{type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:[]}}];
  const f=await fixture(t,{events});
  const beta=f.context('beta');
  await f.manager.saveConfig(beta,{targetUrl:'http://localhost:3000/'});
  await f.manager.saveCases(beta,[journey]);await draftCode(f.manager,beta,[journey]);
  const {run}=await f.manager.run(beta,{},manual);
  const report=await finished(f,beta,run.id);
  assert.deepEqual(f.requests[0].allowedOrigins,['http://localhost:3000']);
  assert.equal(report.results[0].status,'needs_review');assert.equal(report.results[0].blockers,undefined);
});

for(const scenario of [
  {name:'passing checks',complete:true,stopCause:'none',assertions:[{type:'text-visible',value:'Pro',passed:true}],status:'passed',error:undefined},
  {name:'a failed final assertion',complete:true,stopCause:'none',assertions:[{type:'text-visible',value:'Pro',passed:false}],status:'failed',error:'A final assertion failed.'},
  {name:'an execution error',complete:false,stopCause:'exception',assertions:[],status:'failed',error:'Browser transport failed'},
  {name:'an incomplete journey',complete:false,stopCause:'action',assertions:[],status:'needs_review',error:'Action could not finish.'},
])test(`unavailable twin services preserve ${scenario.name}`,async t=>{
  const f=await fixture(t,{events:input=>[
    ...(scenario.complete?[
      {type:'journey-step',caseId:input.case.id,stepId:'open',status:'running'},
      {type:'journey-step',caseId:input.case.id,stepId:'open',status:'completed',evidence:'Actions completed; this milestone has no reviewed checks.'},
      {type:'journey-step',caseId:input.case.id,stepId:'pay',status:'running'},
      {type:'journey-step',caseId:input.case.id,stepId:'pay',status:'completed',evidence:'Reviewed check passed.',checks:[{type:'text-visible',value:'Pro plan active',passed:true}]},
    ]:[]),
    {type:'result',result:{caseId:input.case.id,stopCause:scenario.stopCause,assertions:scenario.assertions,error:scenario.stopCause==='exception'?'Browser transport failed':'Action could not finish.'}},
  ]});
  const beta=f.context('beta');
  await f.manager.saveConfig(beta,{targetUrl:`${WEB}/billing`});
  await f.manager.saveCases(beta,[journey]);await draftCode(f.manager,beta,[journey]);
  const {run}=await f.manager.run(beta,{},manual);
  const report=await finished(f,beta,run.id);
  assert.equal(report.run.status,scenario.status);
  assert.equal(report.results[0].status,scenario.status);
  assert.equal(report.results[0].error,scenario.error);
  assert.equal(report.results[0].blockers,undefined);
});

test('a twin ready while its stage is busy moves the target at once and prepares once the stage is idle',async t=>{
  const NEXT_WEB='http://host.docker.internal:43110',next={...twin,id:'twin-beta-2',apps:[{id:'service-api',url:'http://host.docker.internal:43111'},{id:'service-web',url:NEXT_WEB}]};
  let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(t,{environments:[twin,next],events:input=>input.mode==='run'?[]:discovered(),hold:input=>input.mode==='run'?held:delay(5)});
  const beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,twin);
  assert.equal((await prepared(f,beta)).status,'completed');
  await f.manager.saveCases(beta,[journey]);await draftCode(f.manager,beta,[journey]);
  const {run}=await f.manager.run(beta,{},manual);
  // The next twin is ready during the run: the stage's automatic target moves to it, and its preparation waits.
  // A failed assertion still lets the run end, so the manager can close.
  try{
    await f.manager.prepareEnvironment(beta,next);
    assert.equal((await f.manager.view(beta)).config.targetUrl,`${NEXT_WEB}/`);
    assert.deepEqual([f.manager.summary(beta).preparation?.environmentId,f.manager.summary(beta).preparation?.status],[twin.id,'completed']);
  }finally{release();}
  await finished(f,beta,run.id);
  const preparation=await settled(()=>{const current=f.manager.summary(beta).preparation;return current?.environmentId===next.id&&current.status!=='preparing'&&current;});
  assert.equal(preparation.status,'completed');assert.equal(preparation.targetUrl,`${NEXT_WEB}/`);
  // Its one attempt is spent now, and only now.
  await f.manager.prepareEnvironment(beta,next);
  assert.equal(f.requests.filter(input=>input.mode==='discover').length,1,'The stage\'s cases are reused.');
});


test('reviewed reads follow the same owned application through host links, rebuilt ports and ambiguity', async t => {
  const owned={...twin,sandboxId:twin.id};
  const next={...owned,id:'rebuilt-reads',sandboxId:'rebuilt-reads',apps:[{id:'service-web',url:'http://127.0.0.1:43300'}]};
  const ambiguous={...owned,id:'ambiguous-reads',sandboxId:'ambiguous-reads'};
  const restored={...next,id:'restored-reads',sandboxId:'restored-reads',apps:[{id:'service-web',url:'http://127.0.0.1:43400'}]};
  const other={...next,id:'different-reads',sandboxId:'different-reads',apps:[{id:'other-app',url:'http://127.0.0.1:43500'}]};
  const f=await fixture(t,{environments:[owned,next,ambiguous,restored,other],events:discovered}),beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,owned);await prepared(f,beta);
  const config=(await f.manager.view(beta)).config;
  await f.manager.saveConfig(beta,{...config,readOnlyRequests:[{url:'http://127.0.0.1:43100/rpc',body:'{}'}]});
  await f.manager.prepareEnvironment(beta,next);await prepared(f,beta);
  assert.deepEqual((await f.manager.view(beta)).config.readOnlyRequests,[{url:'http://127.0.0.1:43300/rpc',body:'{}'}]);
  const unknown={...beta,scan:{...beta.scan,services:[]}};
  await f.manager.prepareEnvironment(unknown,ambiguous);await prepared(f,beta);
  assert.equal((await f.manager.view(beta)).config.targetUrl,'');
  await f.manager.prepareEnvironment(beta,restored);await prepared(f,beta);
  assert.deepEqual((await f.manager.view(beta)).config.readOnlyRequests,[{url:'http://127.0.0.1:43400/rpc',body:'{}'}]);
  await f.manager.prepareEnvironment(beta,other);await prepared(f,beta);
  assert.deepEqual((await f.manager.view(beta)).config.readOnlyRequests??[],[],'Read authority cannot transfer to another app service.');
});
