import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserManager} from '../src/browser/manager.ts';
import {createEnvironmentUsage} from '../src/environments/usage.ts';
import {draftCode,manual} from './fixtures/journey-code.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

const deferred=()=>{let resolve!:(value?:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
type Worker={input:JourneyRunInput;gate:ReturnType<typeof deferred>;completed:Set<unknown>;cancelled:boolean;event(value:WorkerEvent):void};
const journey=(id:string,isolation='isolated')=>({id,name:id,goal:'Complete the user journey',isolation,steps:[{id:'entry',title:'Enter application'},{id:'outcome',title:'Verify saved result'}],expectedOutcomes:['Saved result visible'],assertions:[{type:'text-visible',value:'Saved'}],selected:true,needsReview:false});
const outcome=(item:{id:string})=>({caseId:item.id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Saved result visible'}],assertions:[{type:'text-visible',value:'Saved',passed:true}]});
// Test files run at once, so a loaded runner can take seconds where a quiet one takes milliseconds.
async function until(predicate:()=>unknown){for(const deadline=Date.now()+10000;Date.now()<deadline;await new Promise(resolve=>setTimeout(resolve,2)))if(await predicate())return;throw new Error('Condition did not settle.');}
async function fixture(t:TestContext,cases:ReturnType<typeof journey>[]){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-journeys-')),repo=join(dataDir,'repo');
  await mkdir(repo);await writeFile(join(repo,'app.js'),'export const saved="Saved";');
  const workers:Worker[]=[],usage=createEnvironmentUsage();
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input:JourneyRunInput,emit:(event:WorkerEvent)=>void){const gate=deferred(),completed=new Set(),worker={input,gate,completed,cancelled:false,event(value:WorkerEvent){emit(value);if(value.type==='journey-step'&&value.status==='completed')completed.add(value.stepId);}};workers.push(worker);return {promise:gate.promise,cancel(){worker.cancelled=true;}};}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime,usage,resolveEnvironment:()=>({id:'app',status:'ready'})});
  const context={key:'repo',stageId:'beta',scan:{repo:{path:repo,sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,cases);await draftCode(manager,context,cases);
  t.after(async()=>{const closing=manager.close();for(const worker of workers)worker.gate.resolve();await closing;await rm(dataDir,{recursive:true,force:true});});
  const finish=(index:number)=>{const worker=workers[index],item=worker.input.case;for(const step of item.steps!)if(!worker.completed.has(step.id))reach(worker,item.id,step.id,'Observed '+step.title);worker.event({type:'result',result:outcome(item)});worker.gate.resolve();};
  return {manager,context,workers,usage,finish,runtime,dataDir};
}
// The runner starts a milestone without evidence and ends it with the agent's evidence.
const reach=(worker:Worker,caseId:string,stepId:string,evidence:string)=>{worker.event({type:'journey-step',caseId,stepId,status:'running'});worker.event({type:'journey-step',caseId,stepId,status:'completed',evidence});};
const report=(f:Awaited<ReturnType<typeof fixture>>,id:string)=>f.manager.runProgress(f.context,id);
// A run keeps its environment lease until its final state is persisted.
const terminal=async(f:Awaited<ReturnType<typeof fixture>>,id:string)=>{await until(async()=>!['queued','running'].includes((await report(f,id)).run.status)&&!f.usage.isBusy('app'));return report(f,id);};

test('isolated journeys overlap within a bound, while shared state is an exclusive FIFO barrier',async t=>{
  const f=await fixture(t,[journey('one'),journey('two'),journey('shared','shared'),journey('four'),journey('five')]);
  const {run}=await f.manager.run(f.context,{concurrency:2},manual);await until(()=>f.workers.length===2);
  assert.deepEqual(f.workers.map(worker=>worker.input.case.id),['one','two'],'Each worker runs exactly one journey.');
  f.finish(0);await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await report(f,run.id)).results[0].status,'passed');await until(async()=>JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).runs[0].results?.[0]?.status==='passed');assert.equal(f.workers.length,2,'Shared case waits for every isolated worker.');
  f.finish(1);await until(()=>f.workers.length===3);assert.equal(f.workers[2].input.case.id,'shared');
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.workers.length,3);
  f.finish(2);await until(()=>f.workers.length===5);f.finish(3);f.finish(4);
  const completed=await terminal(f,run.id);assert.equal(completed.run.status,'passed');assert.equal(completed.results.length,5);
});

test('queued skip never launches, running skip waits for cleanup and cannot become passed',async t=>{
  const f=await fixture(t,[journey('one'),journey('two'),journey('three')]);
  const {run}=await f.manager.run(f.context,{concurrency:1},manual);await until(()=>f.workers.length===1);
  await f.manager.skip(f.context,run.id,'two');await f.manager.skip(f.context,run.id,'one');
  assert.equal((await report(f,run.id)).progress.cases[0].status,'skipping');
  assert.equal((await report(f,run.id)).progress.cases[1].status,'skipped');
  assert.equal(f.workers[0].cancelled,true);assert.equal(f.usage.isBusy('app'),true);assert.equal(f.workers.length,1);
  f.finish(0);await until(()=>f.workers.length===2);assert.equal(f.workers[1].input.case.id,'three');f.finish(1);
  const completed=await terminal(f,run.id);assert.equal(completed.run.status,'completed');assert.deepEqual(completed.results.map(item=>item.status),['skipped','skipped','passed']);
  await assert.rejects(f.manager.skip({...f.context,stageId:'gamma'},run.id,'three'),{statusCode:404});
  await assert.rejects(f.manager.skip(f.context,run.id,'unknown'),{statusCode:404});
});

test('stop cancels every worker and retains ownership until all cleanup joins',async t=>{
  const f=await fixture(t,[journey('one'),journey('two'),journey('three')]);
  const {run}=await f.manager.run(f.context,{concurrency:2},manual);await until(()=>f.workers.length===2);
  await f.manager.stop(f.context,run.id);assert.ok(f.workers.every(worker=>worker.cancelled));
  f.workers[0].gate.resolve();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await report(f,run.id)).run.status,'running');assert.equal(f.usage.isBusy('app'),true);
  f.workers[1].gate.resolve();assert.equal((await terminal(f,run.id)).run.status,'cancelled');
  await until(()=>!f.usage.isBusy('app'));assert.equal(f.workers.length,2);
});

test('live frames and observed business milestones remain scoped to their own journey and survive public summaries',async t=>{
  const f=await fixture(t,[journey('one'),journey('two')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===2);
  const images=[Buffer.from([0xff,0xd8,1,0xff,0xd9]),Buffer.from([0xff,0xd8,2,0xff,0xd9])];
  for(let index=0;index<2;index++)f.workers[index].event({type:'frame',data:images[index].toString('base64')});
  reach(f.workers[0],'one','entry','Observed entry');
  assert.deepEqual(await f.manager.frame(f.context,run.id,'one'),images[0]);assert.deepEqual(await f.manager.frame(f.context,run.id,'two'),images[1]);assert.deepEqual(await f.manager.frame(f.context,run.id),images[1]);
  await assert.rejects(f.manager.frame(f.context,run.id,'unknown'),{statusCode:404});
  const progress=f.manager.summary(f.context).runs[0].progress!.cases;
  assert.ok(progress.every(item=>item.frameUpdatedAt));assert.equal(progress[0].steps![0].status,'completed');assert.equal(progress[1].steps![0].status,'pending');
  assert.throws(()=>f.workers[1].event({type:'frame',caseId:'one',data:images[1].toString('base64')}),/another journey/);
  f.finish(0);f.finish(1);await terminal(f,run.id);await f.manager.close();
  const reopened=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime});t.after(()=>reopened.close());
  const saved=await reopened.runProgress(f.context,run.id);assert.equal(saved.results.length,2);assert.equal(saved.run.caseSummaries[0].steps[0].title,'Enter application');assert.equal(saved.progress.cases[0].steps![0].evidence,'Observed entry');
});

test('cleanup uncertainty stops queued admission and joins other workers before target quarantine',async t=>{
  const f=await fixture(t,[journey('one'),journey('two'),journey('three')]);
  const {run}=await f.manager.run(f.context,{concurrency:2},manual);await until(()=>f.workers.length===2);
  f.workers[0].gate.reject(Object.assign(new Error('Cleanup incomplete.'),{cleanupIncomplete:true}));await until(()=>f.workers[1].cancelled);
  assert.equal(f.usage.isBusy('app'),true);assert.equal(f.workers.length,2);
  f.workers[1].gate.resolve();const completed=await terminal(f,run.id);assert.equal(completed.run.status,'failed');assert.deepEqual(f.manager.interruptedEnvironmentIds(),['app']);
});

test('discovery replacement is explicit and transactional, retaining old run snapshots and cases on failure',async t=>{
  const f=await fixture(t,[journey('old')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);f.finish(0);await terminal(f,run.id);
  const current=(await f.manager.view(f.context)).cases;
  await assert.rejects(f.manager.discover(f.context,{replaceCaseIds:['old'],baseCases:[]}),{statusCode:409});
  let next=await f.manager.discover(f.context,{replaceCaseIds:['old'],baseCases:current});await until(()=>f.workers.length===2);
  f.workers[1].event({type:'discovery',cases:[],summary:''});f.workers[1].gate.resolve();assert.equal((await terminal(f,next.run.id)).run.status,'failed');assert.equal((await f.manager.view(f.context)).cases[0].id,'old');
  next=await f.manager.discover(f.context,{replaceCaseIds:['old'],baseCases:current});await until(()=>f.workers.length===3);
  f.workers[2].event({type:'discovery',cases:[journey('new')],summary:'New journey'});f.workers[2].gate.resolve();assert.equal((await terminal(f,next.run.id)).run.status,'completed');
  assert.deepEqual((await f.manager.view(f.context)).cases.map(item=>item.id),['new']);assert.equal((await report(f,run.id)).run.caseSummaries[0].name,'old');assert.equal((await report(f,run.id)).results[0].status,'passed');
});


test('legacy current cases gain defaults without changing saved approval snapshots or causing edit conflicts',async t=>{
  const f=await fixture(t,[journey('legacy')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);f.finish(0);await terminal(f,run.id);await f.manager.close();
  const path=join(f.dataDir,'browser','state.json'),state=JSON.parse(await readFile(path,'utf8'));
  for(const cases of Object.values<Record<string,unknown>[]>(state.cases))for(const item of cases){delete item.steps;delete item.isolation;}
  const snapshot=state.runs[0].approvedCases;await writeFile(path,JSON.stringify(state));
  const reopened=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime});t.after(()=>reopened.close());
  const current=(await reopened.view(f.context)).cases;assert.deepEqual(current[0].steps,[]);assert.equal(current[0].isolation,'shared');
  await reopened.saveCases(f.context,[{...current[0],selected:false}],current);
  await assert.rejects(reopened.saveCases(f.context,[{...current[0],name:'Edited legacy journey'}]),/2–12 milestones/,'Editing a reviewed legacy case makes it a new journey.');
  await reopened.saveCases(f.context,[{...current[0],name:'Edited legacy journey',needsReview:false,steps:journey('legacy').steps}]);
  const saved=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(saved.runs[0].approvedCases,snapshot);
});

test('worker status claims are ignored, and run credentials cannot rewrite milestone IDs',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{credentials:{username:'entry',password:'test-password-only'}},manual);await until(()=>f.workers.length===1);
  reach(f.workers[0],'one','entry','entry signed in');
  f.workers[0].event({type:'result',result:{...outcome(journey('one')),status:'skipped'}});f.workers[0].gate.resolve();
  const completed=await terminal(f,run.id);assert.equal(completed.results[0].status,'needs_review');assert.equal(completed.progress.cases[0].steps![0].id,'entry');assert.equal(completed.progress.cases[0].steps![0].evidence,'entry signed in');
});


test('passing page checks cannot bypass missing or reordered business milestones',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);
  assert.throws(()=>f.workers[0].event({type:'journey-step',caseId:'one',stepId:'outcome',status:'running'}),/reviewed journey order/);
  f.workers[0].event({type:'result',result:outcome(journey('one'))});f.workers[0].gate.resolve();
  const completed=await terminal(f,run.id);assert.equal(completed.run.status,'needs_review');assert.match(completed.results[0].error!,/milestone/);
});


test('a supplied shared account serializes even independently reviewed browser profiles',async t=>{
  const f=await fixture(t,[journey('one'),journey('two')]);
  const {run}=await f.manager.run(f.context,{concurrency:4,credentials:{username:'dedicated-test-user',password:'test-password-only'}},manual);await until(()=>f.workers.length===1);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.workers.length,1);
  const pending=await report(f,run.id);assert.equal(pending.run.effectiveConcurrency,1);assert.equal(pending.progress.cases[1].queueReason,'account','The queued journey waits for the test account, not shared data.');assert.equal(pending.run.caseSummaries[0].isolation,'isolated','Approval snapshot remains immutable.');
  f.finish(0);await until(()=>f.workers.length===2);f.finish(1);assert.equal((await terminal(f,run.id)).run.status,'passed');
});


test('safe journey progress failures have a concise label while unknown provider values stay hidden',async()=>{
  const {browserActionError}=await import('../client/src/lib/browser-test-ui.ts');
  assert.equal(browserActionError('journey_progress_invalid'),'Invalid journey progress');
  assert.equal(browserActionError('private-provider-error'),'');
  assert.equal(browserActionError('toString'),'');
});
