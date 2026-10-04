import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';
import {codeFor} from './fixtures/journey-code.ts';
import {caseHash} from '../src/journeys/playwright/specs.ts';
import {CHECK_VERSION} from '../src/journeys/playwright/checks.ts';
import type {BrowserManagerOptions} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import {createPlaywrightRuntime,journeyEnvironment} from '../src/journeys/playwright/runtime.ts';
import {createEnvironmentUsage} from '../src/environments/usage.ts';
import type {StageRef,UsageOptions} from '../src/environments/usage.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

type JourneyRuntime=NonNullable<BrowserManagerOptions['playwright']>;
/** One attempt the fake runtime holds until the test finishes or cancels it. */
type Worker={input:JourneyRunInput;cancelled:boolean;promise:Promise<void>;finish(events:WorkerEvent[]):void;cancel():void};
type Verification={id:string;attempt:number;control:boolean;hash:string;caseHash:string;checkVersion?:number};
/** A run as the browser manager saves it, as far as these tests read it. */
type StoredRun={id:string;mode:string;status:string;caseIds:string[];environmentId?:string;completedAt?:string;results:{status:string;controlRead?:boolean}[];specHashes:Record<string,string>;verification?:Verification;progress:{cases:{status:string;steps:{status:string}[]}[]}};
type StoredState={runs:StoredRun[];specs:Record<string,Record<string,{approved:{approvedRunIds?:string[];checkVersion?:number}|null;draft?:{verification?:{checkVersion:number}}|null}>>};

// A draft is verified before approval: three passing runs of exactly its code, then a control run with every
// state-changing request blocked, in which a reviewed check must fail. A fake Playwright runtime plays each attempt.
const journey={id:'rename',name:'Rename the workspace',goal:'Rename the workspace and see it kept.',isolation:'shared',selected:false,needsReview:false,
  steps:[{id:'open',title:'Open Settings',checks:[{type:'text-visible',value:'Workspace name'}]},{id:'rename',title:'Rename and reload',checks:[{type:'text-visible',value:'Renamed'}]}],
  preconditions:[],expectedOutcomes:['The new name is kept.'],assertions:[{type:'text-visible',value:'Renamed'}]} satisfies Omit<BrowserCase,'evidence'>;
const code=codeFor(journey);
const step=(stepId:string,status:string,checks?:unknown[])=>({type:'journey-step',caseId:journey.id,stepId,status,...(status==='running'?{}:{evidence:'Reviewed checks evaluated.',checks})});
const passing:WorkerEvent[]=[...journey.steps.flatMap(item=>[step(item.id,'running'),step(item.id,'completed',item.checks.map(check=>({...check,passed:true})))]),{type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[{...journey.assertions[0],passed:true}]}}];
// The worker reports a reviewed check failure after freshly reading the blocked change's outcome.
const unkept:WorkerEvent[]=[step('open','running'),step('open','completed',[{...journey.steps[0].checks[0],passed:true}]),step('rename','running'),step('rename','failed',[{...journey.steps[1].checks[0],passed:false}]),{type:'result',result:{caseId:journey.id,stopCause:'none',controlRead:true,assertions:[]}}];
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function setup(t:TestContext,extra:Partial<BrowserManagerOptions>={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-verification-'));await mkdir(join(dataDir,'repo'));
  const workers:Worker[]=[];
  const playwright:JourneyRuntime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(input,onEvent){
    // Its promise, finish and cancel are set at once, as the promise starts.
    const worker={input,cancelled:false} as Worker;
    worker.promise=new Promise<void>((resolve,reject)=>{worker.finish=events=>{for(const event of events)onEvent(event);resolve();};worker.cancel=()=>{worker.cancelled=true;reject(new Error('Browser operation cancelled.'));};});
    workers.push(worker);return {promise:worker.promise,cancel:()=>worker.cancel()};
  }};
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('The browser agent must not run a journey.');}};
  const options:BrowserManagerOptions={dataDir,runtime,playwright,...extra};
  let manager=await createBrowserManager(options);
  t.after(async()=>{for(const worker of workers)worker.cancel?.();await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,[journey]);
  const hash=(await manager.saveSpec(context,{caseId:journey.id,code})).spec.draft!.hash;
  const f={dataDir,context,workers,playwright,hash,get manager(){return manager;},async restart(){await manager.close();manager=await createBrowserManager(options);return manager;},
    verification:async()=>(await manager.view(context)).specs[journey.id]?.draft?.verification,
    async worker(count:number){for(let i=0;i<400;i++){if(workers.length>=count)return workers[count-1];await wait(5);}throw new Error('The attempt did not start.');},
    async settled(){for(let i=0;i<400;i++){const verification=await f.verification();if(verification&&verification.status!=='running'&&!manager.isActive(context))return verification;await wait(5);}throw new Error('The verification did not settle.');}};
  return f;
}
const stored=async(f:{dataDir:string}):Promise<StoredState>=>JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));

test('three passing runs and a caught control run verify the draft, while the stage stays busy for a gate and a person',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:'0'.repeat(64)}),{statusCode:409,message:'The code changed. Reload it and verify again.'});
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:'missing',hash:f.hash}),{statusCode:404});
  const started=await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.deepEqual(started.specs[journey.id].draft?.verification,{status:'running',passes:0,control:null});
  for(let attempt=1;attempt<=4;attempt++){
    const worker=await f.worker(attempt);
    // Between and inside attempts: a gate waits, and a person's run, another verification, generation and approval are refused.
    assert.equal(f.manager.isActive(f.context),true);
    await assert.rejects(f.manager.run(f.context,{},{manual:true}),{statusCode:409});
    await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
    await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409});
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Code for this test is being verified. Stop it first.'});
    assert.deepEqual([worker.input.case.id,worker.input.spec.hash,worker.input.blockWrites],[journey.id,f.hash,attempt===4?true:undefined],`attempt ${attempt}`);
    assert.equal((await f.verification())?.passes,attempt-1);
    worker.finish(attempt===4?unkept:passing);
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.workers.length,4);
  // Each attempt is an ordinary run of the one case, which need not be selected.
  const attempts=(await stored(f)).runs.filter((run):run is StoredRun&{verification:Verification}=>Boolean(run.verification)).reverse();
  assert.deepEqual(attempts.map(run=>[run.mode,run.caseIds,run.verification.attempt,run.verification.control,run.verification.hash,run.results[0].status]),
    [1,2,3,4].map(attempt=>['run',[journey.id],attempt,attempt===4,f.hash,attempt===4?'failed':'passed']));
  assert.equal(new Set(attempts.map(run=>run.verification.id)).size,1);
  // Each attempt names the reviewed journey it verified and the code it ran.
  assert.ok(attempts.every(run=>run.verification.caseHash===caseHash(journey)&&run.specHashes[journey.id]===f.hash));
  // A control run never counts as the journey's current status: the graph carries the latest other run's progress.
  const summary=f.manager.summary(f.context).runs,control=summary.find(run=>run.verification?.control);
  assert.equal(control?.progress,undefined);assert.equal(summary.find(run=>run.verification?.attempt===3)?.progress?.cases[0].status,'passed');
  const {specs}=await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal(specs[journey.id].approved?.hash,f.hash);assert.equal(specs[journey.id].draft,undefined);
  assert.deepEqual((await stored(f)).specs[Object.keys((await stored(f)).specs)[0]][journey.id].approved?.approvedRunIds,attempts.map(run=>run.id));
});

test('the first attempt that does not pass stops the verification with its error',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);
  (await f.worker(2)).finish([{type:'result',result:{caseId:journey.id,stopCause:'action',error:'Action failed at “Open Settings”: locator.click: Timeout 10000ms exceeded.',assertions:[]}}]);
  assert.deepEqual(await f.settled(),{status:'failed',passes:1,control:null,error:'Action failed at “Open Settings”: locator.click: Timeout 10000ms exceeded.'});
  await wait(30);assert.equal(f.workers.length,2,'No later attempt runs.');
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
  // It can be verified again.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal((await f.verification())?.status,'running');
});

test('a control run that passes with every change blocked fails the verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(passing);
  assert.deepEqual(await f.settled(),{status:'failed',passes:3,control:'missed',error:'The journey passed with every change blocked. Strengthen its checks.'});
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
});

for(const controlRead of [undefined,false]){
  test(`a failed control check with ${controlRead===undefined?'missing':'false'} fresh-read evidence cannot approve code`,async t=>{
    const f=await setup(t);
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=1;attempt<=3;attempt++)(await f.worker(attempt)).finish(passing);
    const events=[...unkept.slice(0,-1),{type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[],...(controlRead===undefined?{}:{controlRead})}}];
    (await f.worker(4)).finish(events);
    const expected={status:'failed',passes:3,control:'missed',error:'The control did not check freshly read business data. Reload after the change, then check a run-unique value or a number against its earlier value.'};
    assert.deepEqual(await f.settled(),expected);
    const control=(await stored(f)).runs.find(run=>run.verification?.control)!;
    assert.equal(control.results[0].status,'failed','The underlying failed check remains a failed run.');
    assert.equal(control.results[0].controlRead,controlRead);
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
    await f.restart();
    assert.deepEqual(await f.verification(),expected);
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
    assert.equal(f.workers.length,4,'Restart launches no new attempt.');
  });
}

test('stopping a verification cancels its attempt, and a restart ends an unfinished one as cancelled',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);
  const second=await f.worker(2);
  assert.equal((await f.manager.cancelSpecVerification(f.context,{caseId:journey.id})).specs[journey.id].draft?.verification?.status,'running','It stops once its attempt has cleaned up.');
  assert.equal(second.cancelled,true);
  assert.deepEqual(await f.settled(),{status:'cancelled',passes:1,control:null});
  assert.equal(f.workers.length,2);
  await assert.rejects(f.manager.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
  // A controller that stops inside an attempt: the attempt and its verification end cancelled, never failed.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(3)).finish(passing);await f.worker(4);
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=await stored(f),interrupted=state.runs[0];
  assert.equal(interrupted.verification?.attempt,2);
  Object.assign(interrupted,{status:'running'});delete interrupted.completedAt;interrupted.results=[];Object.assign(interrupted.progress.cases[0],{status:'running'});interrupted.progress.cases[0].steps[0].status='running';
  await writeFile(file,JSON.stringify(state));
  const restarted=await f.restart();
  assert.deepEqual(await f.verification(),{status:'cancelled',passes:1,control:null});
  const run=(await restarted.runProgress(f.context,interrupted.id));
  assert.deepEqual([run.run.status,run.results[0].status,run.progress?.cases[0].steps?.[0].status],['cancelled','cancelled','cancelled']);
  assert.equal(restarted.isActive(f.context),false);
  await assert.rejects(restarted.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
});

test('a verification kept without its record verifies nothing once its passing runs leave the run history',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  // A draft an older controller verified keeps no record of it, so its attempts judge it, and the stored history keeps the
  // latest runs only: the first passing attempt, or all three, can be pruned before an approval.
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=await stored(f),unrecorded=structuredClone(state);
  for(const specs of Object.values(unrecorded.specs))for(const spec of Object.values(specs))delete spec.draft?.verification;
  for(const pruned of [1,3]){
    await writeFile(file,JSON.stringify({...unrecorded,runs:state.runs.filter(run=>!run.verification||run.verification.attempt>pruned)}));
    const restarted=await f.restart();
    assert.deepEqual(await f.verification(),{status:'cancelled',passes:0,control:null},`${pruned} pruned`);
    await assert.rejects(restarted.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
    await restarted.close();
  }
});

test('deleting the case stops its verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  const first=await f.worker(1);
  await f.manager.saveCases(f.context,[]);
  assert.equal(first.cancelled,true);
  for(let i=0;i<400&&f.manager.isActive(f.context);i++)await wait(5);
  assert.equal(f.manager.isActive(f.context),false);assert.equal(f.workers.length,1);
});

test('a verification holds only for the journey it ran against, so the same code saved for weaker checks is unverified',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  // The rename's check and the final assertion go, and the identical code is saved again for the weaker journey.
  await f.manager.saveCases(f.context,[{...journey,steps:[journey.steps[0],{...journey.steps[1],checks:[]}],assertions:[]}]);
  const {spec:{draft}}=await f.manager.saveSpec(f.context,{caseId:journey.id,code});
  assert.deepEqual([draft?.hash,draft?.stale,draft?.verification],[f.hash,false,undefined]);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
  assert.equal(f.workers.length,4);
});

test('an attempt that did not run the draft, as after its journey changed, fails the verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);(await f.worker(2)).finish(passing);
  const third=await f.worker(3);
  await f.manager.saveCases(f.context,[{...journey,goal:`${journey.goal} (edited)`}]);
  third.finish(passing);
  assert.deepEqual(await f.settled(),{status:'failed',passes:3,control:null,error:'The journey changed during its verification. Verify its code again.'});
  assert.equal(f.workers.length,3,'The control run never ran the draft.');
  // Back to the verified journey, the draft is current again, and still unverified.
  await f.manager.saveCases(f.context,[journey]);
  assert.equal((await f.manager.view(f.context)).specs[journey.id].draft?.stale,false);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
});

test('only a failed reviewed check catches the control run; any other end of it is inconclusive',async t=>{
  const passed=journey.steps.map(item=>item.checks.map(check=>({...check,passed:true})));
  const ends:[WorkerEvent[],{status:string;passes:number;control:string|null;error?:string}][]=[
    // The final assertion on the reached end state noticed that the rename was not kept.
    [[...journey.steps.flatMap((item,index)=>[step(item.id,'running'),step(item.id,'completed',passed[index])]),{type:'result',result:{caseId:journey.id,stopCause:'none',controlRead:true,assertions:[{...journey.assertions[0],passed:false}]}}],{status:'passed',passes:3,control:'caught'}],
    // An action the block broke judges nothing.
    [[step('open','running'),step('open','completed',passed[0]),step('rename','running'),{type:'result',result:{caseId:journey.id,stopCause:'action',error:'Action failed at “Rename and reload”: page.reload: Not attached to an active page.',assertions:[]}}],
      {status:'failed',passes:3,control:null,error:'No reviewed check noticed the blocked changes. Action failed at “Rename and reload”: page.reload: Not attached to an active page.'}],
    [[{type:'result',result:{caseId:journey.id,stopCause:'exception',error:'The browser crashed.',assertions:[]}}],{status:'failed',passes:3,control:null,error:'No reviewed check noticed the blocked changes. The browser crashed.'}],
  ];
  for(const [events,expected] of ends){
    const f=await setup(t);
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?events:passing);
    assert.deepEqual(await f.settled(),expected);
    if(expected.control!=='caught')await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
  }
});

test('a verification outlives the run history, which keeps only the controller\'s latest runs',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  const attempts=(await stored(f)).runs.filter(run=>run.verification).map(run=>run.id).reverse();
  // A person selects the case and runs the draft fifty times before approving it: the history no longer holds the attempts.
  await f.manager.saveCases(f.context,[{...journey,selected:true}]);
  for(let count=5;count<55;count++){
    await f.manager.run(f.context,{caseIds:[journey.id]},{manual:true});
    (await f.worker(count)).finish(passing);
    for(let i=0;i<400&&f.manager.isActive(f.context);i++)await wait(5);
  }
  assert.equal((await stored(f)).runs.some(run=>run.verification),false);
  assert.deepEqual(await f.verification(),{status:'passed',passes:3,control:'caught'});
  await f.restart();
  assert.deepEqual(await f.verification(),{status:'passed',passes:3,control:'caught'},'A restart keeps it.');
  const {specs}=await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal(specs[journey.id].approved?.hash,f.hash);
  assert.deepEqual((await stored(f)).specs[Object.keys((await stored(f)).specs)[0]][journey.id].approved?.approvedRunIds,attempts);
});

test('a draft verified under older checks must be verified again before its code runs under current checks',async t=>{
  const f=await setup(t),file=join(f.dataDir,'browser','state.json');
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.deepEqual(f.workers.map(worker=>worker.input.checkVersion),[CHECK_VERSION,CHECK_VERSION,CHECK_VERSION,CHECK_VERSION]);
  // An older controller's verification judged older checks: its draft is unverified until it is verified again.
  await f.manager.close();
  const older=await stored(f);
  assert.ok(older.runs.every(run=>run.verification?.checkVersion===CHECK_VERSION));
  for(const run of older.runs)delete run.verification!.checkVersion;
  // How it ended, kept with the draft, names the check version it ran with too.
  const draft=older.specs[Object.keys(older.specs)[0]][journey.id].draft!;
  assert.equal(draft.verification?.checkVersion,CHECK_VERSION);
  draft.verification!.checkVersion=CHECK_VERSION-1;
  await writeFile(file,JSON.stringify(older));
  await f.restart();
  assert.equal(await f.verification(),undefined);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=5;attempt<=8;attempt++)(await f.worker(attempt)).finish(attempt===8?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal((await stored(f)).specs[Object.keys((await stored(f)).specs)[0]][journey.id].approved?.checkVersion,CHECK_VERSION);
  // The new approval runs with the current checks that verified it.
  await f.manager.saveCases(f.context,[{...journey,selected:true}]);
  const ran=async(count:number)=>{const {run}=await f.manager.run(f.context,{});const worker=await f.worker(count);worker.finish(passing);for(let i=0;i<400&&f.manager.isActive(f.context);i++)await wait(5);return [worker.input.checkVersion,(await f.manager.runProgress(f.context,run.id)).run.status];};
  assert.deepEqual(await ran(9),[CHECK_VERSION,'passed']);
});

for(const checkVersion of [undefined,1,2,3]){
  test(`an approval with ${checkVersion===undefined?'unversioned':`version ${checkVersion}`} control evidence stays historical until explicit reuse and verification`,async t=>{
    const f=await setup(t);
    await f.manager.saveCases(f.context,[{...journey,selected:true}]);
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
    assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
    await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
    await f.manager.close();
    const legacy=await stored(f),scope=Object.keys(legacy.specs)[0],approval=legacy.specs[scope][journey.id].approved!;
    if(checkVersion===undefined)delete approval.checkVersion;else approval.checkVersion=checkVersion;
    for(const run of legacy.runs){
      if(checkVersion===undefined)delete run.verification!.checkVersion;else run.verification!.checkVersion=checkVersion;
      for(const result of run.results)delete result.controlRead;
    }
    await writeFile(join(f.dataDir,'browser','state.json'),JSON.stringify(legacy));
    await f.restart();
    const summary=(await f.manager.view(f.context)).specs[journey.id];
    assert.equal(summary.approved?.stale,true);assert.equal(summary.draft,undefined);
    assert.deepEqual((await stored(f)).specs[scope][journey.id].approved,approval,'Migration retains the historical approval.');
    assert.deepEqual((await stored(f)).runs,legacy.runs,'Migration leaves recorded evidence unchanged.');
    assert.equal(f.workers.length,4);
    for(const options of [{},{manual:true}]){
      const {run}=await f.manager.run(f.context,{},options);await idle(f,f.context);
      const report=await f.manager.runProgress(f.context,run.id);
      assert.equal(report.results[0].status,'needs_review');
      assert.equal(report.results[0].error,'Reuse and verify the approved code again: its control evidence is out of date.');
    }
    assert.equal(f.workers.length,4,'Neither automatic nor manual runs execute the stale approval.');
    const reused=await f.manager.reuseSpec(f.context,{caseId:journey.id});
    assert.deepEqual([reused.spec.approved?.stale,reused.spec.draft?.hash,reused.spec.draft?.stale,reused.spec.draft?.verification],[true,f.hash,false,undefined]);
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=5;attempt<=8;attempt++)(await f.worker(attempt)).finish(attempt===8?unkept:passing);
    assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
    assert.deepEqual(f.workers.slice(4).map(worker=>worker.input.checkVersion),[CHECK_VERSION,CHECK_VERSION,CHECK_VERSION,CHECK_VERSION]);
    await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
    const current=await stored(f),currentApproval=current.specs[scope][journey.id].approved!;
    assert.equal(currentApproval.checkVersion,CHECK_VERSION);
    assert.deepEqual(current.runs.filter(run=>legacy.runs.some(old=>old.id===run.id)),legacy.runs,'Reverification does not rewrite previous results.');
    assert.ok(currentApproval.approvedRunIds?.every(id=>!legacy.runs.some(run=>run.id===id)));
    const {run}=await f.manager.run(f.context,{}),worker=await f.worker(9);
    assert.equal(worker.input.checkVersion,CHECK_VERSION);worker.finish(passing);await idle(f,f.context);
    assert.equal((await f.manager.runProgress(f.context,run.id)).run.status,'passed');
  });
}

test('a journey process learns the check version its code was verified under',()=>{
  const options={hash:'0'.repeat(64),targetUrl:'http://localhost:3000/'};
  assert.equal(journeyEnvironment({},'/workspace',options).PERPETUAL_CHECK_VERSION,String(CHECK_VERSION));
  assert.equal(journeyEnvironment({PERPETUAL_CHECK_VERSION:'1'},'/workspace',{...options,checkVersion:1}).PERPETUAL_CHECK_VERSION,'1');
  assert.equal(journeyEnvironment({PERPETUAL_CHECK_VERSION:'1'},'/workspace',options).PERPETUAL_CHECK_VERSION,String(CHECK_VERSION),'The controller environment never sets it.');
  for(const checkVersion of [0,CHECK_VERSION+1,1.5])
    assert.throws(()=>createPlaywrightRuntime().start({mode:'run',targetUrl:'http://localhost:3000/',timeoutSeconds:60,case:journey,spec:{code,hash:'0'.repeat(64)},checkVersion},()=>{}),/A Playwright journey needs a known check version\./,String(checkVersion));
});

// Waits until a stage has no browser operation left, as after one run of it.
async function idle(f:{manager:{isActive(context:{key:string;stageId:string}):boolean}},context:{key:string;stageId:string}){for(let i=0;i<400&&f.manager.isActive(context);i++)await wait(5);}
const verificationRuns=async(f:{dataDir:string},id?:string)=>(await stored(f)).runs.filter(run=>run.verification&&(!id||run.verification.id===id)).map(run=>run.id).reverse();

test('approval records the attempts of the verification it judged, when the controller stopped before that verification was saved',async t=>{
  const f=await setup(t);
  // The first verification fails at its first attempt and is saved with the draft.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish([{type:'result',result:{caseId:journey.id,stopCause:'action',error:'Action failed at “Open Settings”.',assertions:[]}}]);
  assert.equal((await f.settled()).status,'failed');
  // The second passes, and the controller stops as soon as its control run has settled.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=2;attempt<=4;attempt++)(await f.worker(attempt)).finish(passing);
  const control=await f.worker(5),controlRun=(await stored(f)).runs[0].id;
  control.finish(unkept);
  let closing:Promise<void>|undefined;
  for(let i=0;i<400&&!closing;i++){await new Promise(resolve=>setImmediate(resolve));if(!['queued','running'].includes((await f.manager.runProgress(f.context,controlRun)).run.status))closing=f.manager.close();}
  await closing;
  const second=(await stored(f)).runs[0].verification!.id;
  await f.restart();
  assert.deepEqual(await f.verification(),{status:'passed',passes:3,control:'caught'});
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.deepEqual((await stored(f)).specs[Object.keys((await stored(f)).specs)[0]][journey.id].approved?.approvedRunIds,await verificationRuns(f,second));
});

test('an interrupted verification keeps its own verdict after its attempts leave the run history, never an older one',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  // A second verification of the same draft stops with the controller in its second attempt.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(5)).finish(passing);await f.worker(6);
  await f.restart();
  assert.deepEqual(await f.verification(),{status:'cancelled',passes:1,control:null});
  // Fifty later runs push every attempt out of the history.
  await f.manager.saveCases(f.context,[{...journey,selected:true}]);
  for(let count=7;count<57;count++){await f.manager.run(f.context,{caseIds:[journey.id]},{manual:true});(await f.worker(count)).finish(passing);await idle(f,f.context);}
  assert.deepEqual(await verificationRuns(f),[]);
  assert.deepEqual(await f.verification(),{status:'cancelled',passes:1,control:null});
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
});

test('a verification that fails before its first run keeps that verdict after restart and cannot approve older evidence',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  // A new verification is recorded, but missing Chromium prevents its first run from being admitted.
  t.mock.method(f.playwright,'capabilities',async()=>({browserInstalled:false}));
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  const failed={status:'failed',passes:0,control:null,error:'Install Chromium for Playwright: npx playwright install chromium.'};
  assert.deepEqual(await f.settled(),failed);
  assert.equal(f.workers.length,4);
  await f.restart();
  assert.deepEqual(await f.verification(),failed);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
});

test('a failed draft verification leaves older approved code runnable after restart',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  await f.settled();
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  const draft=(await f.manager.saveSpec(f.context,{caseId:journey.id,code:`${code}// New draft.\n`})).spec.draft!;
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:draft.hash});
  (await f.worker(5)).finish([{type:'result',result:{caseId:journey.id,stopCause:'action',error:'The new draft could not open Settings.',assertions:[]}}]);
  const failed=await f.settled();assert.equal(failed.status,'failed');
  await f.restart();
  const view=(await f.manager.view(f.context)).specs[journey.id];
  assert.equal(view.approved?.hash,f.hash);assert.deepEqual(view.draft?.verification,failed);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:draft.hash}),{statusCode:409});
  await f.manager.saveCases(f.context,[{...journey,selected:true}]);
  const {run}=await f.manager.run(f.context,{}),worker=await f.worker(6);
  assert.deepEqual(worker.input.spec,{code,hash:f.hash});
  worker.finish(passing);await idle(f,f.context);
  assert.equal((await f.manager.runProgress(f.context,run.id)).run.status,'passed');
});

test('a failed code approval save publishes no approval and the next save can approve the same evidence',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  await f.settled();
  const before=(await f.manager.view(f.context)).specs[journey.id],file=join(f.dataDir,'browser','state.json'),saved=await readFile(file,'utf8');
  await rm(file);await mkdir(file);
  try{
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}));
    assert.deepEqual((await f.manager.view(f.context)).specs[journey.id],before);
  }finally{await rm(file,{recursive:true});await writeFile(file,saved);}
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  await f.restart();
  const after=(await f.manager.view(f.context)).specs[journey.id];
  assert.equal(after.approved?.hash,f.hash);assert.equal(after.draft,undefined);
});

test('another stage\'s runs never push a running verification\'s attempts out of the history',async t=>{
  const f=await setup(t);
  const gamma={...f.context,stageId:'gamma'};
  await f.manager.saveConfig(gamma,{targetUrl:'http://localhost:3001'});await f.manager.saveCases(gamma,[{...journey,selected:true}]);await f.manager.saveSpec(gamma,{caseId:journey.id,code});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=3;attempt++)(await f.worker(attempt)).finish(passing);
  const control=await f.worker(4);
  // While the control run runs, the other stage runs fifty times.
  for(let count=5;count<55;count++){await f.manager.run(gamma,{caseIds:[journey.id]},{manual:true});(await f.worker(count)).finish(passing);await idle(f,gamma);}
  control.finish(unkept);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.equal((await verificationRuns(f)).length,4);
});

test('a person saving tests while an attempt ends never fails the verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  const first=await f.worker(1);
  // A person keeps saving the stage's tests, each save right after the last, as the first attempt ends.
  let saving=true;
  const saves=(async()=>{while(saving){await f.manager.saveCases(f.context,[journey]).catch(()=>{});await new Promise(resolve=>setImmediate(resolve));}})();
  first.finish(passing);
  for(let i=0;i<400&&f.workers.length<2&&(await f.verification())?.status==='running';i++)await wait(5);
  saving=false;await saves;
  assert.equal(f.workers.length,2,JSON.stringify(await f.verification()));
  for(let attempt=2;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
});

test('the app-wide model settings wait for a verification, so saving them as it records its start or an attempt never fails it',async t=>{
  // The public OpenRouter catalog the saved model is checked against.
  t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{id:'openai/gpt-5.4-mini',name:'GPT-5.4 Mini',architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}]}));
  const f=await setup(t),settings={model:'openai/gpt-5.4-mini',apiKey:`sk-or-v1-${'a'.repeat(64)}`},accepted:string[]=[];
  // A person saves Settings, which belongs to no stage; a save the verification lets in is noted with when it came.
  const save=(moment:string)=>f.manager.saveModelSettings(settings).then(()=>{accepted.push(moment);},(error:{statusCode?:number})=>{if(error.statusCode!==409)throw error;});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  // As Verify returns, while the verification records its start.
  await save('start');
  for(let attempt=1;attempt<=4;attempt++){
    for(let i=0;i<400&&f.workers.length<attempt&&(await f.verification())?.status==='running';i++)await wait(5);
    f.workers[attempt-1]?.finish(attempt===4?unkept:passing);
    // As the attempt ends and the verification records it, until the next attempt starts or the verification ends.
    while(f.workers.length===attempt&&f.manager.isActive(f.context)){await save(`after attempt ${attempt}`);await new Promise(resolve=>setImmediate(resolve));}
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.deepEqual(accepted,[]);
  // Once it has ended, the settings save.
  assert.equal((await f.manager.saveModelSettings(settings)).capabilities.model,settings.model);
});

test('a health check between attempts never takes the twin, so it never fails a passing verification',async t=>{
  const usage=createEnvironmentUsage(),twin={id:'twin',status:'ready',stageId:'beta'},beta={key:'repo',stageId:'beta'};
  // As the environments' health tick does, a check takes the twin as soon as nothing holds it, and holds it a while.
  const health=()=>{if(!usage.isBusy(twin.id))setTimeout(usage.acquire(beta,{environmentId:twin.id,operation:'health'}),20);};
  const leases={assertAvailable:usage.assertAvailable,acquire(context:StageRef,options?:UsageOptions){
    const release=usage.acquire(context,options);
    return ()=>{const released=release();if(options?.operation==='browser run')setImmediate(health);return released;};
  }};
  const f=await setup(t,{usage:leases,resolveEnvironment:url=>new URL(url).port==='3000'?twin:null});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++){
    for(let i=0;i<400&&f.workers.length<attempt&&(await f.verification())?.status==='running';i++)await wait(5);
    f.workers[attempt-1]?.finish(attempt===4?unkept:passing);
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.workers.length,4);
  for(let i=0;i<100&&usage.isBusy(twin.id);i++)await wait(5);
  assert.equal(usage.isBusy(twin.id),false,'The verification lets the twin go as it ends.');
});

test('a verification holds its twin from the moment it starts, so a health check never takes it before the first attempt',async t=>{
  const usage=createEnvironmentUsage(),twin={id:'twin',status:'ready',stageId:'beta'},beta={key:'repo',stageId:'beta'};
  let f:Awaited<ReturnType<typeof setup>>|undefined,during=0;
  // As the environments' health tick does, a check takes the twin whenever nothing holds it, and holds it a while.
  const health=()=>{if(usage.isBusy(twin.id))return;if(f?.manager.isActive(f.context))during++;setTimeout(usage.acquire(beta,{environmentId:twin.id,operation:'health'}),20);};
  f=await setup(t,{usage,resolveEnvironment:url=>new URL(url).port==='3000'?twin:null});
  // A check already running as Verify is clicked refuses it, and records nothing on the draft.
  health();
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'This environment has an operation in progress.'});
  assert.equal(await f.verification(),undefined);
  for(let i=0;i<100&&usage.isBusy(twin.id);i++)await wait(5);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  // The tick lands just after the request returns, while the verification records its start, and keeps landing.
  setImmediate(health);
  const ticking=setInterval(health,1);t.after(()=>clearInterval(ticking));
  for(let attempt=1;attempt<=4;attempt++){
    for(let i=0;i<400&&f.workers.length<attempt&&(await f.verification())?.status==='running';i++)await wait(5);
    f.workers[attempt-1]?.finish(attempt===4?unkept:passing);
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  clearInterval(ticking);
  assert.equal(during,0,'No health check took the twin while the verification ran.');
});

test('a verification started as the stage\'s last run lets its twin go takes the twin from that run',async t=>{
  const usage=createEnvironmentUsage(),twin={id:'twin',status:'ready',stageId:'beta'},beta={key:'repo',stageId:'beta'};
  let f:Awaited<ReturnType<typeof setup>>|undefined,during=0;
  const health=()=>{if(usage.isBusy(twin.id))return;if(f?.manager.isActive(f.context))during++;setTimeout(usage.acquire(beta,{environmentId:twin.id,operation:'health'}),20);};
  // A health tick lands as soon as anything lets the twin go.
  const leases={assertAvailable:usage.assertAvailable,acquire(context:StageRef,options?:UsageOptions){
    const release=usage.acquire(context,options);
    return ()=>{const released=release();setImmediate(health);return released;};
  }};
  f=await setup(t,{usage:leases,resolveEnvironment:url=>new URL(url).port==='3000'?twin:null});
  await f.manager.saveCases(f.context,[{...journey,selected:true}]);
  for(let i=0;i<100&&usage.isBusy(twin.id);i++)await wait(5);
  const {run}=await f.manager.run(f.context,{caseIds:[journey.id]},{manual:true});
  (await f.worker(1)).finish(passing);
  // Verify is clicked as soon as the run has ended, while it still records its end on the twin it holds.
  // The verdict is terminal before cleanup ends; isActive correctly stays true through that cleanup.
  while(['queued','running'].includes((await f.manager.runProgress(f.context,run.id)).run.status))await new Promise(resolve=>setImmediate(resolve));
  assert.equal(usage.isBusy(twin.id),true,'The run still holds its twin.');
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=2;attempt<=5;attempt++){
    for(let i=0;i<400&&f.workers.length<attempt&&(await f.verification())?.status==='running';i++)await wait(5);
    f.workers[attempt-1]?.finish(attempt===5?unkept:passing);
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.equal(during,0,'No health check took the twin while the verification ran.');
});

test('a twin of the stage that becomes ready during a verification waits for it, so every attempt runs on the twin it started on',async t=>{
  // Each twin has its own test account, as a twin config's accounts are made per twin.
  const twin=(id:string,port:number)=>({id,status:'ready',stageId:'beta',apps:[{id:'app',url:`http://localhost:${port}`}],accounts:[{id:`owner-${id}`,label:'Owner',username:'owner@example.test'}]});
  const first=twin('twin-a',3000),next=twin('twin-b',3001),twins=[first,next];
  const f=await setup(t,{resolveEnvironment:url=>twins.find(item=>item.apps.some(app=>app.url===new URL(url).origin))||null,
    twinAccount:async(environment,accountId)=>environment.accounts?.some(account=>account.id===accountId)?{username:'owner@example.test',password:`secret-${environment.id}`}:null});
  // The stage's automatic target is the first twin's application.
  await f.manager.saveConfig(f.context,{targetUrl:''});
  await f.manager.prepareEnvironment(f.context,first);
  assert.equal((await f.manager.view(f.context)).config.targetUrl,'http://localhost:3000/');
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash,accountId:`owner-${first.id}`});
  await f.worker(1);
  // Another twin of the stage becomes ready during the first attempt.
  await f.manager.prepareEnvironment(f.context,next);
  assert.equal((await f.manager.view(f.context)).config.targetUrl,'http://localhost:3000/');
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.deepEqual(f.workers.map(worker=>[worker.input.targetUrl,worker.input.credentials?.password]),Array(4).fill(['http://localhost:3000/',`secret-${first.id}`]));
  const attempts=(await stored(f)).runs.filter(run=>run.verification);
  assert.deepEqual(attempts.map(run=>run.environmentId),Array(4).fill(first.id));
  // The approval's evidence is runs on that one twin.
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  const state=await stored(f),approved=Object.values(state.specs)[0][journey.id].approved!;
  assert.deepEqual(approved.approvedRunIds?.map(id=>state.runs.find(run=>run.id===id)?.environmentId),Array(4).fill(first.id));
  // Once the verification has ended, the new twin is prepared and the target moves to it.
  for(let i=0;i<400&&f.manager.summary(f.context).preparation?.environmentId!==next.id;i++)await wait(5);
  assert.deepEqual([f.manager.summary(f.context).preparation?.status,(await f.manager.view(f.context)).config.targetUrl],['completed','http://localhost:3001/']);
});

test('writes of the same case\'s code are serialized, so a second writer is refused instead of silently lost',async t=>{
  const verified=async()=>{
    const f=await setup(t);
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
    assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
    return f;
  };
  // Approving and discarding together: the approval commits, and the discard finds no draft.
  const a=await verified();
  const [approved,discarded]=await Promise.allSettled([a.manager.approveSpec(a.context,{caseId:journey.id,hash:a.hash}),a.manager.discardSpec(a.context,{caseId:journey.id,hash:a.hash})]);
  assert.equal(approved.status,'fulfilled');assert.equal(discarded.status,'rejected');
  assert.equal((await a.manager.view(a.context)).specs[journey.id]?.approved?.hash,a.hash);
  // Saving edited code and approving together: the saved draft is kept, and the approval of the draft it replaced is refused.
  const b=await verified(),edited=`${code}// Edited.\n`;
  const [saved,approval]=await Promise.allSettled([b.manager.saveSpec(b.context,{caseId:journey.id,code:edited}),b.manager.approveSpec(b.context,{caseId:journey.id,hash:b.hash})]);
  assert.equal(saved.status,'fulfilled');assert.equal(approval.status,'rejected');
  assert.equal((approval as PromiseRejectedResult).reason.statusCode,409);
  const view=(await b.manager.view(b.context)).specs[journey.id];
  assert.equal(view?.approved,undefined);assert.equal(view?.draft?.stale,false);assert.notEqual(view?.draft?.hash,b.hash);
});
