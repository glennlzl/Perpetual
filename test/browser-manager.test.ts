import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,access,symlink,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';
import {draftCode,manual} from './fixtures/journey-code.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

const scenario={id:'workspace',name:'Open workspace',goal:'Reach the workspace',steps:[{id:'open',title:'Open the workspace'},{id:'verify',title:'Verify the workspace'}],expectedOutcomes:['Workspace is visible'],assertions:[{type:'text-visible',value:'Workspace'}],selected:true,needsReview:false};
const milestones=scenario.steps.flatMap(step=>[{type:'journey-step',caseId:scenario.id,stepId:step.id,status:'running'},{type:'journey-step',caseId:scenario.id,stepId:step.id,status:'completed',evidence:`Observed: ${step.title}`}]);
type Events=WorkerEvent[]|((input:JourneyRunInput)=>WorkerEvent[]);
type Start=(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void)=>{promise:Promise<void>;cancel:()=>void};
// events may depend on the worker input, as a recording names files in input.videoDir; start replaces the worker.
// One fake serves discovery (the browser agent) and runs (Playwright code).
async function fixture(t:TestContext,events:Events,start?:Start){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-manager-'));await mkdir(join(dataDir,'repo'));await writeFile(join(dataDir,'repo','app.js'),'export const page="Workspace";');
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start:start||function(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void){let cancel!:()=>void;const promise=new Promise<void>((resolve,reject)=>{cancel=()=>reject(new Error('cancelled'));setTimeout(()=>{try{for(const event of (typeof events==='function'?events(input):events)||[])onEvent(event);resolve();}catch(error){reject(error);}},20);});return {promise,cancel};}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime});t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,[scenario]);await draftCode(manager,context,[scenario]);
  return {manager,context,dataDir,runtime};
}
async function completed(f:Awaited<ReturnType<typeof fixture>>,id:string){for(let i=0;i<100;i++){const report=await f.manager.runProgress(f.context,id);if(!['queued','running'].includes(report.run.status))return report;await new Promise(r=>setTimeout(r,5));}throw Error('run did not finish');}
// A finished run prunes older recordings after reporting its status.
async function removed(path:string){for(let i=0;i<100;i++){try{await access(path);}catch{return;}await new Promise(r=>setTimeout(r,5));}throw Error(`${path} was kept`);}

test('scoped reviewed cases run without Docker and require matching immutable assertions',async t=>{
  const facts={caseId:scenario.id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Workspace is visible'}],assertions:[{...scenario.assertions[0],passed:true}]};
  const f=await fixture(t,[{type:'case',caseId:scenario.id,actions:[{type:'click',status:'passed',text:'password secret'}]},...milestones,{type:'result',result:facts}]);
  const {run}=await f.manager.run(f.context,{},manual);
  await assert.rejects(f.manager.run({...f.context},{}),/in progress/);
  await assert.rejects(f.manager.runProgress({...f.context,stageId:'gamma'},run.id),/not found/);
  const report=await completed(f,run.id);assert.equal(report.run.status,'passed');assert.equal(JSON.stringify(report).includes('password secret'),false);
  // Agent claims a worker reports are never kept: the reviewed checks decide.
  assert.deepEqual(report.results,[{caseId:scenario.id,status:'passed',engine:'playwright',assertions:facts.assertions}]);
  await f.manager.saveCases(f.context,[{...scenario,name:'Updated case',expectedOutcomes:['A different outcome']}]);
  assert.equal((await f.manager.runProgress(f.context,run.id)).run.caseSummaries[0].name,'Open workspace');
  assert.equal((await f.manager.view({...f.context,stageId:'gamma'})).cases.length,0);
});

test('results survive public run history, changed case drafts and controller restart',async t=>{
  const f=await fixture(t,[...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[{...scenario.assertions[0],passed:false}]}}]);
  const approved={...scenario,expectedOutcomes:['Workspace is visible','Delivery reaches the test inbox']};
  await f.manager.saveCases(f.context,[approved]);await draftCode(f.manager,f.context,[approved]);
  const {run}=await f.manager.run(f.context,{},manual);
  const report=await completed(f,run.id);
  assert.equal(report.run.status,'failed');assert.equal(report.results[0].error,'A final assertion failed.');
  await f.manager.saveCases(f.context,[{...scenario,expectedOutcomes:['Edited after execution']}]);
  await f.manager.close();
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  const persisted=await restarted.runProgress(f.context,run.id);
  assert.deepEqual(persisted.results,report.results);
  assert.deepEqual(persisted.run.caseSummaries[0].expectedOutcomes,approved.expectedOutcomes);
  assert.deepEqual((await restarted.view(f.context)).runs[0].results,report.results);
});

test('code feedback is scrubbed with its originating account, stays private and survives restart',async t=>{
  const username=`former-${'y'.repeat(305)}`,password='former-private-test-password';
  const f=await fixture(t,[{type:'result',result:{caseId:scenario.id,stopCause:'action',error:`Missing link ${'detail '.repeat(85)} ${username}; input ${password}`,actionFeedback:`Edited control removed: Email. Current field Email: empty, invalid. ${username} ${password}`,assertions:[]}}]);
  const {run}=await f.manager.run(f.context,{credentials:{username,password}},manual);
  const report=await completed(f,run.id);await f.manager.close();
  const stored=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).runs.find((item:{id:string})=>item.id===run.id);
  assert.ok(stored.codeFeedback[scenario.id].includes('Missing link'));
  assert.ok(stored.codeFeedback[scenario.id].includes('Edited control removed: Email'));
  assert.ok(!JSON.stringify(report).includes('Edited control removed'));
  assert.ok(!JSON.stringify(stored.codeFeedback).includes(username));assert.ok(!JSON.stringify(stored.codeFeedback).includes(password));
  assert.ok(!JSON.stringify(stored.codeFeedback).includes(username.slice(0,50)));
  assert.ok(!('codeFeedback' in report.run));
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  assert.ok(!('codeFeedback' in (await restarted.runProgress(f.context,run.id)).run));
  assert.ok(!('codeFeedback' in (await restarted.view(f.context)).runs[0]));
});

test('restart refuses malformed stored control limitations before publishing run history',async t=>{
  const f=await fixture(t,[...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[{...scenario.assertions[0],passed:true}]}}]);
  const {run}=await f.manager.run(f.context,{},manual);const report=await completed(f,run.id);await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),saved=JSON.parse(await readFile(file,'utf8'));
  for(const fields of [{controlRead:false,controlBlocker:{}},{controlRead:false,controlBlocker:'unknown'},{controlRead:true,controlBlocker:'shared-worker'},{controlBlocker:'unguarded-transport'}]){
    const corrupt=structuredClone(saved);Object.assign(corrupt.runs[0].results[0],fields);await writeFile(file,JSON.stringify(corrupt));
    await assert.rejects(createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime}),/Invalid stored control limitation/);
  }
  for(const fields of [{controlRead:false,controlReadReason:{}},{controlRead:false,controlReadReason:'private page text'},{controlRead:true,controlReadReason:'url-changed'},{controlReadReason:'url-changed'}]){
    const corrupt=structuredClone(saved);Object.assign(corrupt.runs[0].results[0],fields);await writeFile(file,JSON.stringify(corrupt));
    await assert.rejects(createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime}),/Invalid stored control read diagnosis/);
  }
  for(const fields of [{controlRead:false,controlBlocks:{}},{controlRead:false,controlBlocks:[{kind:'socket',transport:'websocket',afterRead:true,message:'private'}]},{controlRead:true,controlBlocks:[]}]){
    const corrupt=structuredClone(saved);Object.assign(corrupt.runs[0].results[0],fields);await writeFile(file,JSON.stringify(corrupt));
    await assert.rejects(createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime}),/Invalid stored control transport evidence/);
  }
  await writeFile(file,JSON.stringify(saved));
  const restored=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restored.close());
  assert.deepEqual((await restored.runProgress(f.context,run.id)).results,report.results,'Legacy evidence without a limitation stays unchanged.');
});

test('control transport evidence is scrubbed with the run account and survives history and restart',async t=>{
  const username='viewer@example.test',password='private-'+ 'p'.repeat(600);
  const f=await fixture(t,[...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',controlRead:false,controlReadReason:'blocked-after-read',controlBlocks:[{kind:'http',method:'POST',url:`http://app.test/${encodeURIComponent(username)}/${encodeURIComponent(password)}?secret=private`,afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}],assertions:[{...scenario.assertions[0],passed:false}]}}]);
  const {run}=await f.manager.run(f.context,{credentials:{username,password}},manual),report=await completed(f,run.id);
  assert.deepEqual(report.results[0].controlBlocks,[{kind:'http',method:'POST',url:'http://app.test/[REDACTED]/[REDACTED]',afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}]);
  assert.equal(report.run.status,'failed');assert.equal(report.results[0].controlRead,false);
  await f.manager.close();
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  assert.deepEqual((await restarted.runProgress(f.context,run.id)).results,report.results);
  assert.deepEqual((await restarted.view(f.context)).runs[0].results,report.results);
});

test('unverified passed claims and missing results cannot become business passes',async t=>{
  const f=await fixture(t,[...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',status:'passed',agentCompleted:true,assertions:[]}}]);
  const {run}=await f.manager.run(f.context,{},manual);const report=await completed(f,run.id);assert.equal(report.run.status,'needs_review');assert.equal(report.results[0].status,'needs_review');
  const other=await fixture(t,[]);const started=await other.manager.run(other.context,{},manual);assert.equal((await completed(other,started.run.id)).run.status,'failed');
});

test('action failure codes survive history without accepting raw errors or unknown diagnostic values',async t=>{
  const actions=[{type:'report_journey_step',status:'failed',errorCode:'journey_progress_invalid'}, {type:'input',status:'failed',errorCode:'credential_field_type_mismatch',error:'private input value'},{type:'click',status:'failed',errorCode:'private-provider-error'},{type:'input',status:'passed',errorCode:'credential_field_unavailable'}];
  const f=await fixture(t,[{type:'case',caseId:scenario.id,actions},{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[]}}]);
  const {run}=await f.manager.run(f.context,{},manual);
  const report=await completed(f,run.id);
  assert.deepEqual(report.progress.cases[0].actions,[{type:'report_journey_step',status:'failed',errorCode:'journey_progress_invalid'}, {type:'input',status:'failed',errorCode:'credential_field_type_mismatch'},{type:'click',status:'failed'},{type:'input',status:'passed'}]);
  assert.ok(!JSON.stringify(report).includes('private'));
  await f.manager.close();
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  assert.deepEqual((await restarted.runProgress(f.context,run.id)).progress,report.progress);
});

test('discovery adds unselected drafts, preserving reviewed cases and persisted configuration',async t=>{
  const f=await fixture(t,[{type:'case',caseId:'discovery',actions:[{type:'navigate',status:'passed'}]},{type:'discovery',summary:'Workspace product',cases:[{...scenario,steps:[{id:'open',title:'Open workspace'},{id:'verify',title:'Verify saved workspace'}],id:'new-case',selected:true,needsReview:false}]}]);
  const {run}=await f.manager.discover(f.context);assert.equal((await completed(f,run.id)).run.status,'completed');
  const view=await f.manager.view(f.context);assert.equal(view.cases.find(c=>c.id==='workspace')!.selected,true);assert.equal(view.cases.find(c=>c.id==='new-case')!.selected,false);assert.equal(view.cases.find(c=>c.id==='new-case')!.needsReview,true);
  await f.manager.close();const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());assert.deepEqual((await restarted.view(f.context)).cases,view.cases);
});

test('scoped frames never cross stages and cancelling preserves terminal status on restart',async t=>{
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);
  const f=await fixture(t,[{type:'frame',data:jpeg.toString('base64')},{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[{...scenario.assertions[0],passed:true}]}}]);
  const {run}=await f.manager.run(f.context,{},manual);await completed(f,run.id);
  assert.deepEqual(await f.manager.frame(f.context,run.id),jpeg);
  await assert.rejects(f.manager.frame({...f.context,stageId:'gamma'},run.id),/not found/);
  const next=await f.manager.run(f.context,{},manual);await f.manager.stop(f.context,next.run.id);
  assert.equal((await completed(f,next.run.id)).run.status,'cancelled');
  await f.manager.close();const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  assert.equal((await restarted.runProgress(f.context,next.run.id)).run.status,'cancelled');
  assert.equal(await restarted.frame(f.context,run.id),null);
});

test('journeys keep the recordings they report for the stage\'s latest runs only',async t=>{
  const facts={caseId:scenario.id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Workspace is visible'}],assertions:[{...scenario.assertions[0],passed:true}]};
  const recorded:string[]=[];
  const f=await fixture(t,input=>{
    const name=`page@${randomBytes(16).toString('hex')}.webm`;writeFileSync(join(input.videoDir!,name),'webm');recorded.push(name);
    return [{type:'video',caseId:scenario.id,files:[name,name]},...milestones,{type:'result',result:facts}];
  });
  const runs:string[]=[];
  for(let i=0;i<6;i++){const {run}=await f.manager.run(f.context,{},manual);const report=await completed(f,run.id);assert.equal(report.run.status,'passed');runs.push(run.id);}
  const [first,second]=runs,latest=runs.at(-1)!,name=recorded.at(-1)!;
  assert.deepEqual((await f.manager.runProgress(f.context,latest)).progress.cases[0].videos,[name]);
  const video=await f.manager.video(f.context,latest,scenario.id,name);
  assert.equal(video.size,4);assert.ok(video.path.endsWith(join('videos',latest,name)));
  const requests:[typeof f.context,string,string|undefined][]=[[{...f.context,stageId:'gamma'},scenario.id,name],[f.context,'other',name],[f.context,scenario.id,recorded[0]],[f.context,scenario.id,'../state.json'],[f.context,scenario.id,undefined]];
  for(const [context,caseId,file] of requests)
    await assert.rejects(f.manager.video(context,latest,caseId,file),{statusCode:404});
  // The oldest run past the stage's five loses its folder and its reference.
  const videos=join(f.dataDir,'browser','videos');
  await removed(join(videos,first));
  assert.equal((await f.manager.runProgress(f.context,first)).progress.cases[0].videos,undefined);
  await assert.rejects(f.manager.video(f.context,first,scenario.id,recorded[0]),{statusCode:404});
  await access(join(videos,second,recorded[1]));
  // A restart removes run folders no run keeps, such as one left by a crash, and nothing else.
  const orphan=join(videos,randomUUID());await mkdir(orphan);
  const outside=join(f.dataDir,'outside');await mkdir(outside);await writeFile(join(outside,'clip.mp4'),'mp4');
  const linked=join(videos,randomUUID());await symlink(outside,linked);
  await mkdir(join(videos,'Holiday'));await writeFile(join(videos,'notes.txt'),'notes');
  await f.manager.close();
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>restarted.close());
  await assert.rejects(access(orphan));
  for(const path of [linked,join(outside,'clip.mp4'),join(videos,'Holiday'),join(videos,'notes.txt')])await access(path);
  assert.equal((await restarted.video(f.context,latest,scenario.id,name)).size,4);
});

test('a symbolically linked recording folder is refused, and its target is left intact',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-manager-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const outside=join(dataDir,'outside');await mkdir(join(outside,'Holiday'),{recursive:true});await writeFile(join(outside,'notes.txt'),'notes');
  await mkdir(join(dataDir,'browser'));await symlink(outside,join(dataDir,'browser','videos'));
  // A stub runtime: creating the manager fails before it is used.
  await assert.rejects(createBrowserManager({dataDir,runtime:{capabilities:async()=>({}),start(){throw new Error('The stub runtime never starts.');}}}),/recording storage must not be a symbolic link/);
  assert.deepEqual((await readdir(outside)).sort(),['Holiday','notes.txt']);
});

test('a skipped journey keeps the recording its worker finishes while stopping',async t=>{
  const name=`page@${'c'.repeat(32)}.webm`;let started=false;
  // Like the runner, the worker reports its recording after the skip cancelled it.
  const f=await fixture(t,[],(input,onEvent)=>{let cancel!:()=>void;const promise=new Promise<void>((_resolve,reject)=>{started=true;cancel=()=>setTimeout(()=>{writeFileSync(join(input.videoDir!,name),'webm');onEvent({type:'video',caseId:scenario.id,files:[name]});reject(new Error('cancelled'));},5);});return {promise,cancel};});
  const {run}=await f.manager.run(f.context,{},manual);
  for(let i=0;i<100&&!started;i++)await new Promise(r=>setTimeout(r,5));
  await f.manager.skip(f.context,run.id,scenario.id);
  const report=await completed(f,run.id);
  assert.equal(report.progress.cases[0].status,'skipped');assert.equal(report.results[0].status,'skipped');
  assert.deepEqual(report.progress.cases[0].videos,[name]);
  assert.equal((await f.manager.video(f.context,run.id,scenario.id,name)).size,4);
});

test('an invalid recording report is ignored and never fails its journey',async t=>{
  const facts={caseId:scenario.id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Workspace is visible'}],assertions:[{...scenario.assertions[0],passed:true}]};
  const valid=`page@${'a'.repeat(32)}.webm`;
  const f=await fixture(t,[...[['../state.json'],valid,Array(21).fill(valid),[`page@${'A'.repeat(32)}.webm`],[valid,7]].map(files=>({type:'video',caseId:scenario.id,files})),...milestones,{type:'result',result:facts}]);
  const {run}=await f.manager.run(f.context,{},manual);
  const report=await completed(f,run.id);
  assert.equal(report.run.status,'passed');
  assert.equal(report.progress.cases[0].videos,undefined);
});


test('public browser projections keep full evidence, graph summaries and code review distinct',async t=>{
  const f=await fixture(t,[{type:'case',caseId:scenario.id,actions:[{type:'click',status:'passed'}]},...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[{...scenario.assertions[0],passed:true}]}}]);
  const {run}=await f.manager.run(f.context,{},manual),report=await completed(f,run.id);
  const view=await f.manager.view(f.context),summary=f.manager.summary(f.context),listed=summary.runs[0];
  for(const value of [report.run,view.runs[0],listed]){
    for(const privateField of ['scope','approvedCases','environmentUseUncertain','credentials','codeFeedback'])assert.equal(Object.hasOwn(value,privateField),false,privateField);
    assert.deepEqual(Object.keys(value.caseSummaries[0]).sort(),['assertions','expectedOutcomes','goal','id','isolation','name','preconditions','steps']);
  }
  assert.deepEqual(report.progress.cases[0].actions,[{type:'click',status:'passed'}]);
  assert.ok(listed.progress);assert.equal(Object.hasOwn(listed.progress.cases[0],'actions'),false);
  assert.equal(Object.hasOwn(listed,'specHashes'),false);assert.equal(Object.hasOwn(listed,'discovery'),false);
  assert.ok(report.run.specHashes?.[scenario.id]);
  assert.equal(Object.hasOwn(view.specs[scenario.id].draft!,'code'),false);
  const code=await f.manager.specCode(f.context,{caseId:scenario.id});
  assert.deepEqual(Object.keys(code.draft!).sort(),['code','hash']);assert.match(code.draft!.code,/journey.milestone/);
  assert.equal(typeof view.capabilities.playwright.browserInstalled,'boolean');
  assert.equal(Object.hasOwn(view.capabilities,'apiKey'),false);
});

test('public history preserves missing progress, old revision and immutable legacy definitions',async t=>{
  const f=await fixture(t,[...milestones,{type:'result',result:{caseId:scenario.id,stopCause:'none',assertions:[{...scenario.assertions[0],passed:true}]}}]);
  const {run}=await f.manager.run(f.context,{},manual);await completed(f,run.id);await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=JSON.parse(await readFile(file,'utf8')),old=state.runs[0];
  old.engine='browser-use';delete old.progress.revision;delete old.progress.cases[0].actionCount;old.progress.cases[0].steps[0].provenance='agent';
  for(const field of ['goal','preconditions','expectedOutcomes','assertions','steps','isolation'])delete old.approvedCases[0][field];
  const absent=structuredClone(old);absent.id=randomUUID();absent.status='legacy-completed';delete absent.progress;state.runs.unshift(absent);
  await writeFile(file,JSON.stringify(state));
  const manager=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.runtime});t.after(()=>manager.close());
  const historical=await manager.runProgress(f.context,run.id),missing=await manager.runProgress(f.context,absent.id);
  assert.equal(historical.run.engine,'browser-use');assert.equal(historical.progress.revision,undefined);assert.equal(historical.progress.cases[0].steps?.[0].provenance,'agent');
  assert.equal(historical.run.caseSummaries[0].goal,undefined);assert.deepEqual(historical.run.caseSummaries[0].steps,[]);assert.equal(historical.run.caseSummaries[0].isolation,'shared');
  assert.equal(missing.run.status,'legacy-completed');assert.equal(Object.hasOwn(missing.run,'progress'),false);assert.deepEqual(missing.progress,{cases:[]});
  assert.equal((await manager.view(f.context)).cases[0].goal,scenario.goal,'Editable cases normalize independently of historical approvals.');
  assert.equal(manager.summary(f.context).runs[0].progress,undefined);
});
