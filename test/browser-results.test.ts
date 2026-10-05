import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyResult,runStatus} from '../src/browser/results.ts';
import type {ApprovedJourney,MilestoneState} from '../src/browser/results.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';

// The controller's verdict is the only one. Worker facts follow docs/architecture/journey-contract.md;
// a journey runs Playwright code, so its reviewed checks alone can pass it.
const journey:Pick<BrowserCase,'id'|'expectedOutcomes'|'assertions'|'steps'>={id:'save-and-reopen',expectedOutcomes:['Saved workspace reopens','Delivery reaches the test inbox'],assertions:[{type:'text-visible',value:'Saved workspace'}],steps:[{id:'account',title:'Confirm the paid plan'},{id:'pay',title:'Pay with a Stripe test card'}]};
const passing={type:'text-visible',value:'Saved workspace',passed:true},missed={...passing,passed:false};
const blocker={stepId:'pay',kind:'integration',evidence:'Stripe Checkout is not configured in this sandbox'};
const facts=(changes:Record<string,unknown>)=>({caseId:journey.id,stopCause:'none',assertions:[passing],...changes});
const progress=(...statuses:string[])=>journey.steps.map((step,index)=>({...step,status:statuses[index]||'pending'}));
const done=progress('completed','completed');
const verdict=(changes:Record<string,unknown>,steps:readonly MilestoneState[]=done,approved:ApprovedJourney=journey)=>journeyResult(approved,facts(changes),steps);

test('a pass needs every milestone completed and every reviewed check passed, and keeps no agent claims',()=>{
  assert.deepEqual(verdict({}),{caseId:journey.id,status:'passed',engine:'playwright',assertions:[passing]});
  // Agent completion, outcome observations and diagnostics a worker claims are never kept.
  assert.deepEqual(verdict({agentCompleted:true,outcomes:[{outcomeIndex:0,status:'failed',evidence:'Claimed'}],diagnostics:{modelCalls:3}}),verdict({}));
  const checked:ApprovedJourney={...journey,assertions:[],steps:[{...journey.steps[0],checks:[{type:'text-visible',value:'Paid plan'}]},journey.steps[1]]};
  const table:[string,Record<string,unknown>,MilestoneState[],ApprovedJourney,string,string|undefined][]=[
    ['milestone checks alone back a pass',{assertions:[]},done,checked,'passed',undefined],
    ['a journey without any check',{assertions:[]},done,{...journey,assertions:[]},'needs_review','The journey has no reviewed checks or final assertions.'],
    ['unevaluated final assertions',{assertions:[]},done,journey,'needs_review','The final assertions were not evaluated.'],
    ['mismatched final assertions',{assertions:[{...passing,value:'Other text'}]},done,journey,'needs_review','The final assertions were not evaluated.'],
    ['incomplete milestones',{},progress('completed','running'),journey,'needs_review','Not every reviewed business milestone has observed completion evidence.'],
  ];
  for(const [name,changes,steps,approved,status,error] of table){
    const result=verdict(changes,steps,approved);
    assert.equal(result.status,status,name);assert.equal(result.error,error,name);assert.equal(result.engine,'playwright',name);
  }
});

test('worker status claims are ignored, and an unknown case or stop cause is a protocol error',()=>{
  assert.equal(verdict({status:'passed',assertions:[]}).status,'needs_review');
  assert.equal(verdict({status:'cancelled',error:'Journey exceeded its time limit.'}).status,'passed','Error text is never a signal.');
  for(const stopCause of [undefined,'cancelled','timeout','forced','Journey exceeded its time limit.'])assert.throws(()=>verdict({stopCause}),/stop cause/,String(stopCause));
  assert.throws(()=>verdict({caseId:'other'}),/unknown case/);
});

test('control limitations are validated facts that cannot change the failed business verdict',()=>{
  const result=verdict({controlRead:false,controlBlocker:'shared-worker',stopCause:'action',error:'The control run cannot block shared-worker communication.'},progress('completed','failed'));
  assert.deepEqual(result,{caseId:journey.id,status:'failed',engine:'playwright',assertions:[{...passing,reached:false}],controlRead:false,controlBlocker:'shared-worker',error:'Milestone check failed: Pay with a Stripe test card.'});
  for(const controlRead of [undefined,true])assert.throws(()=>verdict({controlRead,controlBlocker:'shared-worker'}),/control limitation/);
  for(const controlBlocker of [null,{},'page secret','constructor'])assert.throws(()=>verdict({controlRead:false,controlBlocker}),/control limitation/);
});

test('a fixed control-read diagnosis is retained while arbitrary worker text and a qualified diagnosis are refused',()=>{
  const result=verdict({controlRead:false,controlReadReason:'url-changed'},progress('completed','failed'));
  assert.equal(result.status,'failed');
  assert.equal(result.controlReadReason,'url-changed');
  for(const controlRead of [undefined,true])assert.throws(()=>verdict({controlRead,controlReadReason:'url-changed'}),/control read diagnosis/);
  for(const controlReadReason of [null,{},'private page address','constructor'])assert.throws(()=>verdict({controlRead:false,controlReadReason}),/control read diagnosis/);
});

test('control transport evidence stays bounded and cannot qualify a failed control',()=>{
  const controlBlocks=[{kind:'http',method:'POST',url:'https://viewer:secret@app.test/read;token=private?secret=private#private',afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}];
  const result=verdict({controlRead:false,controlReadReason:'blocked-after-read',controlBlocks},progress('completed','failed'));
  assert.equal(result.status,'failed');assert.equal(result.controlRead,false);
  assert.deepEqual((result as unknown as {controlBlocks:unknown}).controlBlocks,[{kind:'http',method:'POST',url:'https://app.test/read',afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}]);
  for(const controlRead of [undefined,true])assert.throws(()=>verdict({controlRead,controlBlocks}),/control transport evidence/);
  for(const invalid of [null,{},Array(11).fill(controlBlocks[0]),[{...controlBlocks[0],body:'private'}],[{...controlBlocks[1],message:'private'}],[{...controlBlocks[0],afterRead:'true'}]])assert.throws(()=>verdict({controlRead:false,controlBlocks:invalid}),/control transport evidence/);
});

test('one precedence decides status and message: failed, blocked, needs review, then passed',()=>{
  const failedCheck=[{...journey.steps[0],status:'completed'},{...journey.steps[1],status:'failed',checks:[{type:'compare-number',label:'Credits',name:'after',op:'>',than:'before',passed:false,observed:10,provenance:'independent'}]}];
  const table:[string,Record<string,unknown>,MilestoneState[],string,string|undefined][]=[
    ['a failed milestone check names its milestone',{stopCause:'exception',error:'Browser transport failed',blockers:[blocker]},failedCheck,'failed','Milestone check failed: Pay with a Stripe test card.'],
    ['a reached final assertion that did not pass',{assertions:[missed]},done,'failed','A final assertion failed.'],
    ['an exception outranks a blocked milestone',{stopCause:'exception',error:'The controller stopped during this journey.',assertions:[]},progress('blocked'),'failed','The controller stopped during this journey.'],
    ['a blocked milestone',{},progress('completed','blocked'),'blocked','Blocked at milestone: Pay with a Stripe test card.'],
    ['a blocker names its milestone',{blockers:[blocker]},progress('completed','running'),'blocked','Blocked at milestone: Pay with a Stripe test card.'],
    ['a blocker without a milestone names its kind',{blockers:[{kind:'account',evidence:'No test account was supplied'}]},done,'blocked','Blocked: account prerequisite unavailable.'],
    ['a deadline',{stopCause:'deadline',assertions:[]},progress('completed','running'),'needs_review','Journey exceeded its time limit.'],
    ['an action the code could not complete',{stopCause:'action',error:'Action failed at “Pay with a Stripe test card”: locator.click: Timeout 10000ms exceeded.',assertions:[]},progress('completed','running'),'needs_review','Action failed at “Pay with a Stripe test card”: locator.click: Timeout 10000ms exceeded.'],
    ['a milestone order or approval mismatch',{stopCause:'action',error:'The spec did not run every reviewed milestone in order.',assertions:[]},progress('completed'),'needs_review','The spec did not run every reviewed milestone in order.'],
    ['a journey without code',{stopCause:'action',error:'Generate and approve code for this journey.',assertions:[]},progress(),'needs_review','Generate and approve code for this journey.'],
    ['incomplete milestones',{},progress('completed','running'),'needs_review','Not every reviewed business milestone has observed completion evidence.'],
    ['complete evidence',{},done,'passed',undefined],
  ];
  for(const [name,changes,steps,status,error] of table){
    const result=verdict(changes,steps);
    assert.equal(result.status,status,name);assert.equal(result.error,error,name);
  }
});

test('final assertions are unreached only when the journey stopped short of its end state',()=>{
  const unreached={...missed,reached:false};
  const table:[string,Record<string,unknown>,MilestoneState[],string][]=[
    ['a reported blocker',{blockers:[blocker],assertions:[missed]},done,'blocked'],
    ['a blocked milestone',{assertions:[missed]},progress('completed','blocked'),'blocked'],
    ['a deadline before every milestone completed',{stopCause:'deadline',assertions:[missed]},progress('completed','running'),'needs_review'],
    ['an action that stopped before every milestone completed',{stopCause:'action',assertions:[missed]},progress('completed'),'needs_review'],
  ];
  for(const [name,changes,steps,status] of table){
    const result=verdict(changes,steps);
    assert.equal(result.status,status,name);assert.deepEqual(result.assertions,[unreached],name);
  }
  // A case without milestones never shows that it finished before its deadline.
  const legacy={...journey,steps:[]};
  assert.deepEqual(verdict({stopCause:'deadline',assertions:[missed]},[],legacy).assertions,[unreached]);
  // Every milestone completed, or the code ran to its end: the end state was reached.
  const ended:[Record<string,unknown>,MilestoneState[]][]=[[{stopCause:'deadline',assertions:[missed]},done],[{assertions:[missed]},progress('completed','running')],[{assertions:[unreached]},done]];
  for(const [changes,steps] of ended){
    const result=verdict(changes,steps);
    assert.equal(result.status,'failed');assert.deepEqual(result.assertions,[missed],'The worker cannot mark its own assertions unreached.');
  }
  const kept=verdict({stopCause:'deadline'},progress('completed','running'));
  assert.equal(kept.status,'needs_review','An unreached assertion never passes.');assert.deepEqual(kept.assertions,[{...passing,reached:false}]);
});

test('a worker that stopped without a report is judged from its accepted milestones',()=>{
  const stopped=(stopCause:string,steps:MilestoneState[],error?:string)=>journeyResult(journey,{caseId:journey.id,stopCause,...(error?{error}:{})},steps);
  assert.deepEqual(stopped('deadline',progress('completed','running')),{caseId:journey.id,status:'needs_review',engine:'playwright',assertions:[],error:'Journey exceeded its time limit.'});
  assert.equal(stopped('deadline',progress('completed','blocked')).status,'blocked');
  assert.equal(stopped('deadline',progress('failed')).status,'failed');
  assert.deepEqual(stopped('exception',progress('completed','running'),'Browser transport failed'),{caseId:journey.id,status:'failed',engine:'playwright',assertions:[],error:'Browser transport failed'});
  assert.equal(stopped('exception',[]).error,'The journey stopped on an error.');
  assert.equal(stopped('exception',progress('failed'),'Browser transport failed').error,'Milestone check failed: Confirm the paid plan.');
});

test('blockers are bounded and a malformed list is never partially trusted',()=>{
  let result=verdict({blockers:[blocker]},progress('completed','running'));
  assert.equal(result.status,'blocked');assert.deepEqual(result.blockers,[blocker]);
  for(const blockers of ['account',[{kind:'network',evidence:'x'}],[{kind:'account',evidence:''}],[{kind:'account'}],[{kind:'account',evidence:'x',stepId:'unknown'}],[{kind:'account',evidence:'x',detail:'extra'}],Array.from({length:11},()=>({kind:'fixture',evidence:'Missing fixture'}))]){
    result=verdict({blockers});
    assert.notEqual(result.status,'blocked',JSON.stringify(blockers));assert.notEqual(result.status,'passed');assert.equal(result.blockers,undefined);
  }
  result=verdict({blockers:[{kind:'account',evidence:'Bearer secret-token '+'x'.repeat(5000)}]});
  assert.equal(result.status,'blocked');assert.equal(result.blockers![0].evidence.length,2000,'Blocker evidence is stored up to 2000 characters.');assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('run roll-up orders failed, blocked, needs review, cancelled, skipped completion and pass',()=>{
  const statuses=(...values:string[])=>values.map(status=>({status}));
  assert.equal(runStatus(statuses('passed','blocked','failed','needs_review')),'failed');
  assert.equal(runStatus(statuses('passed','needs_review','blocked','cancelled')),'blocked');
  assert.equal(runStatus(statuses('cancelled','needs_review','skipped')),'needs_review');
  assert.equal(runStatus(statuses('skipped','cancelled','passed')),'cancelled');
  assert.equal(runStatus(statuses('skipped','passed')),'completed');
  assert.equal(runStatus(statuses('passed','passed')),'passed');
});
