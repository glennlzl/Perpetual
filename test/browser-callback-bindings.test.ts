import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,rename} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';import type {BrowserManager,BrowserStageContext,TargetEnvironment} from '../src/browser/manager.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';import type {WorkerEvent} from '../src/browser/runtime.ts';
import {readStateFile,writeStateFile} from '../src/store.ts';import {browserCaseFixture} from './fixtures/browser-view.ts';import {draftCode} from './fixtures/journey-code.ts';
const bindings=[{applicationId:'web',hostname:'localhost' as const}];const wait=()=>new Promise(done=>setTimeout(done,5));
function twin(id:string,port:number,context:BrowserStageContext):TargetEnvironment{return {id,sandboxId:id,status:'ready',pipelineKey:context.key,stageId:context.stageId,repoPath:context.scan.repo.path,apps:[{id:'web',url:`http://127.0.0.1:${port}/`}],services:[]};}
async function terminal(manager:BrowserManager,context:BrowserStageContext,id:string){for(let i=0;i<500;i++){const r=await manager.runProgress(context,id);if(!['queued','running'].includes(r.run.status)&&!manager.isActive(context))return r;await wait();}assert.fail('Run did not settle.');}
async function fixture(t:TestContext,{hold=false}={}){
 const dataDir=await mkdtemp(join(tmpdir(),'perpetual-callback-unit-'));await mkdir(join(dataDir,'repo'));const context:BrowserStageContext={key:'acme/app',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'a'.repeat(40)}}};
 const first=twin('twin-a',41000,context),next=twin('twin-b',41001,context),envs=[first];const inputs:JourneyRunInput[]=[];const finishes:(()=>void)[]=[];
 const item=browserCaseFixture({expectedOutcomes:['Saved data is kept.'],selected:true,steps:[{id:'open',title:'Open'},{id:'save',title:'Save',checks:[{type:'text-visible',value:'Saved'}]}]});
 const options={dataDir,runtime:{capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('Discovery forbidden.');}},
 playwright:{capabilities:async()=>({browserInstalled:true}),start(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void){inputs.push(structuredClone(input));let finish!:()=>void;const promise=new Promise<void>((resolve,reject)=>{finish=()=>{try{for(const step of item.steps){onEvent({type:'journey-step',caseId:item.id,stepId:step.id,status:'running'});onEvent({type:'journey-step',caseId:item.id,stepId:step.id,status:input.blockWrites&&step.id==='save'?'failed':'completed',evidence:'Reviewed checks evaluated.',checks:(step.checks??[]).map(check=>({...check,passed:!input.blockWrites}))});}onEvent({type:'result',result:{caseId:item.id,stopCause:'none',controlRead:input.blockWrites===true,assertions:[]}});resolve();}catch(error){reject(error);}};});finishes.push(finish);if(!hold)queueMicrotask(finish);return {promise,cancel:finish};}},
 resolveEnvironment:(url:string)=>envs.find(env=>env.apps?.some(app=>app!==null&&typeof app==='object'&&'url'in app&&typeof app.url==='string'&&new URL(app.url).origin===new URL(url).origin))??null};
 let manager=await createBrowserManager(options);await manager.saveCases(context,[item]);await draftCode(manager,context,[item]);await manager.prepareEnvironment(context,first);
 t.after(async()=>{await manager.cancelSpecVerification(context,{caseId:item.id}).catch(()=>{});finishes.forEach(f=>f());await manager.close();await rm(dataDir,{recursive:true,force:true});});
 return {get manager(){return manager;},context,first,next,item,inputs,finishes,envs,dataDir,file:join(dataDir,'browser','state.json'),async reopen(){await manager.close();manager=await createBrowserManager(options);return manager;},async bind(){await manager.saveConfig(context,{...(await manager.view(context)).config,callbackBindings:bindings});}};
}
test('exact reviewed callbacks follow owned rebuilds while fixed origins remain fixed and restart starts nothing',async t=>{
 const f=await fixture(t);await f.manager.saveConfig(f.context,{...(await f.manager.view(f.context)).config,externalOrigins:['http://localhost:41000','https://checkout.example.test'],callbackBindings:bindings});
 const {run}=await f.manager.run(f.context,{accountId:null},{manual:true});await terminal(f.manager,f.context,run.id);
 assert.ok(f.inputs[0].allowedOrigins!.includes('http://localhost:41000'));assert.deepEqual((await f.manager.runProgress(f.context,run.id)).run.callbackOrigins,['http://localhost:41000']);assert.deepEqual(f.manager.summary(f.context).runs[0].callbackOrigins,['http://localhost:41000']);
 f.envs.push(f.next);await f.manager.prepareEnvironment(f.context,f.next);const view=await f.manager.view(f.context);assert.equal(view.callbacks?.application?.origin,'http://127.0.0.1:41001');assert.deepEqual(view.config.externalOrigins,['http://localhost:41000','https://checkout.example.test']);
 const second=await f.manager.run(f.context,{accountId:null},{manual:true});await terminal(f.manager,f.context,second.run.id);assert.ok(f.inputs[1].allowedOrigins!.includes('http://localhost:41001'));assert.equal(f.inputs.length,2);
 await f.reopen();assert.deepEqual((await f.manager.view(f.context)).config.callbackBindings,bindings);assert.equal(f.inputs.length,2);
});
test('unresolved retained bindings block admission and permit removal without granting new authority',async t=>{
 const f=await fixture(t);await f.bind();await f.manager.saveConfig(f.context,{...(await f.manager.view(f.context)).config,targetUrl:'http://127.0.0.1:41002/'});
 assert.equal((await f.manager.view(f.context)).callbacks?.application,null);assert.match((await f.manager.view(f.context)).callbacks?.error??'',/ready managed/);
 await assert.rejects(f.manager.run(f.context,{accountId:null},{manual:true}),/ready managed/);const hash=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!.hash;await assert.rejects(f.manager.verifySpec(f.context,{caseId:f.item.id,hash}),/ready managed/);
 await assert.rejects(f.manager.generateSpec(f.context,{caseId:f.item.id}),/ready managed/);
 await assert.rejects(f.manager.saveConfig(f.context,{...(await f.manager.view(f.context)).config,callbackBindings:[{applicationId:'web',hostname:'127.0.0.1'}]}),/ready managed/);assert.equal(f.inputs.length,0);
 await f.manager.saveConfig(f.context,{...(await f.manager.view(f.context)).config,callbackBindings:[]});assert.equal((await f.manager.view(f.context)).config.callbackBindings,undefined);
});
test('missing ownership, changed identity and ambiguous app records refuse workers',async t=>{
 for(const patch of [{pipelineKey:undefined},{stageId:'other'},{sandboxId:'other'},{apps:[{id:'other',url:'http://127.0.0.1:41000/'}]},{apps:[{id:'web',url:'http://127.0.0.1:41000/'},{id:'api',url:'http://127.0.0.1:41000/'}]}]){
 const f=await fixture(t);await f.bind();Object.assign(f.first,patch);await assert.rejects(f.manager.run(f.context,{accountId:null},{manual:true}),/ready managed/);assert.equal(f.inputs.length,0);
 }
});
test('failed save publishes neither configuration nor automatic target changes',async t=>{
 const f=await fixture(t);const before=(await f.manager.view(f.context)).config;await rename(f.file,`${f.file}.saved`);await mkdir(f.file);
 try{await assert.rejects(f.manager.saveConfig(f.context,{...before,callbackBindings:bindings}));assert.deepEqual((await f.manager.view(f.context)).config,before);}finally{await rm(f.file,{recursive:true});await rename(`${f.file}.saved`,f.file);}
 await f.bind();assert.equal((await f.manager.view(f.context)).callbacks?.application?.applicationId,'web');
});
test('verification captures callback origins through four attempts and defers retargeting',async t=>{
 const f=await fixture(t,{hold:true});await f.bind();const hash=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!.hash;await f.manager.verifySpec(f.context,{caseId:f.item.id,hash,accountId:null});
 for(let i=0;i<500&&!f.inputs.length;i++)await wait();f.envs.push(f.next);await f.manager.prepareEnvironment(f.context,f.next);
 for(let i=0;i<4;i++){for(let tries=0;tries<500&&f.finishes.length<=i;tries++)await wait();assert.ok(f.inputs[i].allowedOrigins!.includes('http://localhost:41000'));assert.ok(!f.inputs[i].allowedOrigins!.includes('http://localhost:41001'));f.finishes[i]();}
 for(let i=0;i<500&&f.manager.isActive(f.context);i++)await wait();assert.equal((await f.manager.view(f.context)).specs[f.item.id].draft?.verification?.status,'passed');
 for(let i=0;i<500&&(await f.manager.view(f.context)).config.targetUrl!=='http://127.0.0.1:41001/';i++)await wait();assert.equal((await f.manager.view(f.context)).callbacks?.application?.origin,'http://127.0.0.1:41001');
});
test('queued settings edit cannot change policy after verification admission',async t=>{
 const f=await fixture(t,{hold:true});await f.bind();const config=(await f.manager.view(f.context)).config;const hash=(await f.manager.specCode(f.context,{caseId:f.item.id})).draft!.hash;
 const save=f.manager.saveConfig(f.context,{...config,callbackBindings:[]});const refusal=assert.rejects(save,{statusCode:409});await f.manager.verifySpec(f.context,{caseId:f.item.id,hash,accountId:null});await refusal;assert.deepEqual((await f.manager.view(f.context)).config.callbackBindings,bindings);await f.manager.cancelSpecVerification(f.context,{caseId:f.item.id});
});
test('malformed stored bindings and run provenance are refused before views',async t=>{
 for(const corrupt of ['binding','array-binding','nested-binding','duplicate-binding','origins','policy','verification']){
 const f=await fixture(t);await f.bind();const {run}=await f.manager.run(f.context,{accountId:null},{manual:true});await terminal(f.manager,f.context,run.id);await f.manager.close();
 const state=await readStateFile(f.file,{limit:16*1024*1024,invalid:'Invalid'}) as {configs:Record<string,{callbackBindings:unknown}>;runs:{callbackOrigins?:unknown;callbackPolicy?:unknown;verification?:unknown}[]};
 if(corrupt==='binding')Object.values(state.configs)[0].callbackBindings=[{applicationId:'web',hostname:'*.localhost'}];if(corrupt==='origins')state.runs[0].callbackOrigins=['http://localhost:41000/path'];if(corrupt==='policy')state.runs[0].callbackPolicy='bad';if(corrupt==='verification')state.runs[0].verification={callbackPolicy:'bad'};
 if(corrupt==='array-binding')Object.values(state.configs)[0].callbackBindings=[{applicationId:'web',hostname:['localhost']}];
 if(corrupt==='nested-binding')Object.values(state.configs)[0].callbackBindings=[{applicationId:'web',hostname:[['localhost']]}];
 if(corrupt==='duplicate-binding')Object.values(state.configs)[0].callbackBindings=[...bindings,{applicationId:'web',hostname:['localhost']}];
 await writeStateFile(f.file,JSON.stringify(state));await assert.rejects(f.reopen());
 }
});
