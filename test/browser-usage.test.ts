import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';
import type {BrowserManagerOptions} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';
import {createEnvironmentUsage} from '../src/environments/usage.ts';
import {draftCode,manual} from './fixtures/journey-code.ts';

const caseItem={id:'journey',name:'Save workspace',goal:'Save and reopen the workspace',steps:[{id:'save',title:'Save the workspace'},{id:'reopen',title:'Reopen the saved workspace'}],expectedOutcomes:['Saved workspace is visible'],assertions:[{type:'text-visible',value:'Workspace'}],selected:true,needsReview:false};
const deferred=()=>{let resolve!:(value?:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
type Gate=ReturnType<typeof deferred>;
async function fixture(t:TestContext,options:Partial<BrowserManagerOptions>={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-usage-'));const repo=join(dataDir,'repo');await mkdir(repo);await writeFile(join(repo,'app.js'),'export const workspace = true;');
  const usage=createEnvironmentUsage(),workers:{gate:Gate;input:JourneyRunInput;event:(event:WorkerEvent)=>void}[]=[];let capabilityGate:Gate|null=null,ownedStatus='ready';
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const runtime={async capabilities(){if(capabilityGate)await capabilityGate.promise;return {runtimeInstalled:true,browserInstalled:true,modelConfigured:true};},start(input:JourneyRunInput,event:(event:WorkerEvent)=>void){const gate=deferred();workers.push({gate,input,event});return {promise:gate.promise,cancel:()=>gate.resolve()};}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime,usage,resolveEnvironment:(target:string)=>new URL(target).port==='3000'?{id:'owned-app',status:ownedStatus}:null,...options});
  t.after(async()=>{for(const worker of workers)worker.gate.resolve();capabilityGate?.resolve();await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',scan:{repo:{path:repo,sha:'abc'}}};
  for(const stageId of ['beta','gamma']){await manager.saveConfig({...context,stageId},{targetUrl:'http://localhost:3000'});await manager.saveCases({...context,stageId},[caseItem]);await draftCode(manager,{...context,stageId},[caseItem]);}
  return {manager,context,usage,workers,dataDir,runtime,setCapabilityGate:(value:Gate)=>capabilityGate=value,setOwnedStatus:(value:string)=>ownedStatus=value};
}
async function terminal(f:Awaited<ReturnType<typeof fixture>>,id:string){for(let i=0;i<100;i++){const {run}=await f.manager.runProgress(f.context,id);if(!['queued','running'].includes(run.status))return run;await new Promise(r=>setTimeout(r,2));}throw Error('Run did not finish');}

test('browser protects its owned target across stages and releases after failed execution',async t=>{
  const f=await fixture(t);const {run}=await f.manager.run(f.context,{},manual);
  assert.equal(run.environmentId,'owned-app');
  assert.throws(()=>f.usage.acquire(f.context,{environmentId:'owned-app',operation:'reset'}),{statusCode:409});
  await assert.rejects(f.manager.run({...f.context,stageId:'gamma'},{},manual),{statusCode:409});
  const other=f.usage.acquire(f.context,{environmentId:'another-app',operation:'script'});other();
  await f.manager.stop(f.context,run.id);assert.equal((await terminal(f,run.id)).status,'cancelled');
  for(let i=0;i<100&&f.usage.isBusy('owned-app');i++)await new Promise(r=>setTimeout(r,2));
  const reset=f.usage.acquire(f.context,{environmentId:'owned-app',operation:'reset'});reset();
});
test('browser refuses an occupied or stale owned application but external URLs need no guest',async t=>{
  const f=await fixture(t),reset=f.usage.acquire(f.context,{environmentId:'owned-app',operation:'reset'});
  await assert.rejects(f.manager.run(f.context,{},manual),{statusCode:409});reset();
  f.setOwnedStatus('destroyed');await assert.rejects(f.manager.discover(f.context),/ready|available/);
  await f.manager.saveConfig(f.context,{targetUrl:'https://preview.example.test'});
  const {run}=await f.manager.run(f.context,{},manual);assert.equal(run.environmentId,undefined);
  await f.manager.stop(f.context,run.id);await terminal(f,run.id);
});
test('close joins a browser admission and blocks stage deletion until admission settles',async t=>{
  const f=await fixture(t),gate=deferred();f.setCapabilityGate(gate);
  const starting=f.manager.run(f.context,{},manual);const rejected=assert.rejects(starting,/shutting down/);
  assert.throws(()=>f.usage.beginRemoval(f.context,['owned-app']),{statusCode:409});
  let stopped=false;const closing=f.manager.close().then(()=>stopped=true);
  await new Promise(r=>setTimeout(r,10));assert.equal(stopped,false);
  gate.resolve();await rejected;await closing;assert.equal(f.usage.isBusy('owned-app'),false);assert.equal(f.workers.length,0);
});

test('automatic case preparation reserves its stage before the first persistence await',async t=>{
  const f=await fixture(t);
  const preparing=f.manager.prepareEnvironment(f.context,{id:'owned-app',stageId:'beta',status:'ready'});
  assert.throws(()=>f.usage.beginRemoval(f.context,['owned-app']),{statusCode:409});
  await preparing;
  const token=f.usage.beginRemoval(f.context,['owned-app']);f.usage.endRemoval(token);
  assert.equal(f.workers.length,0,'Existing reviewed cases must not be rediscovered.');
});

test('interrupted browser ownership survives repeated restarts until its environment can be recovered',async t=>{
  const f=await fixture(t);await f.manager.run(f.context,{},manual);await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),saved=JSON.parse(await readFile(file,'utf8'));
  saved.runs[0].status='running';delete saved.runs[0].completedAt;await writeFile(file,JSON.stringify(saved));
  for(let restart=0;restart<2;restart++){
    const manager=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});
    try{
      assert.deepEqual(manager.interruptedEnvironmentIds(),['owned-app']);
      assert.equal((await manager.view(f.context)).runs[0].status,'failed');
    }finally{await manager.close();}
  }
});

test('uncertain cleanup durably quarantines the target before releasing its environment lease',async t=>{
  const gate=deferred(),calls:{id:string;error:string}[]=[];
  t.after(()=>gate.resolve());
  const f=await fixture(t,{onEnvironmentUncertain:async(id,error)=>{calls.push({id,error});await gate.promise;f.setOwnedStatus('cleanup_failed');}});
  const {run}=await f.manager.run(f.context,{},manual);
  for(let i=0;i<100&&!f.workers.length;i++)await new Promise(r=>setTimeout(r,2));
  f.workers[0].gate.reject(Object.assign(new Error('Cleanup incomplete after forced termination.'),{cleanupIncomplete:true}));
  for(let i=0;i<100&&!calls.length;i++)await new Promise(r=>setTimeout(r,2));
  assert.deepEqual(calls,[{id:'owned-app',error:'Cleanup incomplete after forced termination.'}]);
  assert.equal(f.usage.isBusy('owned-app'),true,'Quarantine must finish before another manager can mutate the target.');
  const saved=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));
  assert.equal(saved.runs.find((item:{id:string})=>item.id===run.id).environmentUseUncertain,true);
  try { assert.equal(f.manager.isActive(f.context),true,'A terminal result stays active until resource finalization completes.'); }
  finally { gate.resolve(); }
  await f.manager.close();
  assert.equal(f.manager.isActive(f.context),false);
  assert.equal(f.usage.isBusy('owned-app'),false,'Explicit cleanup may proceed after quarantine.');
  assert.deepEqual(f.manager.interruptedEnvironmentIds(),['owned-app']);
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime,resolveEnvironment:()=>({id:'owned-app',status:'ready'})});
  t.after(()=>restarted.close());
  await assert.rejects(restarted.run(f.context,{},manual),/cleanup|unavailable|ready/);
});
