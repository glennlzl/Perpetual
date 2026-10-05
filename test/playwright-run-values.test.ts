import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';
import {journeyResult} from '../src/browser/results.ts';
import {journeyEnvironment,runToken,writeJourneyWorkspace} from '../src/journeys/playwright/runtime.ts';
import {RUN_TOKEN,checkText,resolveCheck,resolvedFrom,approvedCase} from '../src/journeys/playwright/checks.ts';
import {validateBrowserCases} from '../src/business/browser-cases.ts';
import {codeFor} from './fixtures/journey-code.ts';
import type {BrowserManagerOptions} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

type JourneyRuntime=NonNullable<BrowserManagerOptions['playwright']>;

// A journey that saves a value and later checks it names the run's token as {run}: each run types a value no earlier
// run stored, so a verification's control run, in which nothing is saved, cannot find it.
const journey={id:'profile',name:'Save a display name',goal:'Save a display name and see it kept.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'save',title:'Save the display name QA {run}',checks:[{type:'text-visible',value:'Saved'}]},{id:'reopen',title:'Reopen the profile',checks:[{type:'text-visible',value:'QA {run}'},{type:'read-number',label:'Tasks for QA {run}',name:'tasks'}]}],
  preconditions:[],expectedOutcomes:['The display name is kept.'],assertions:[{type:'url-contains',value:'/profile'},{type:'text-absent',value:'Draft of {run} and {run}'}]} satisfies Omit<BrowserCase,'evidence'>;

test('a reviewed check names the run token as {run}, and the case keeps it as written',()=>{
  const [item]=validateBrowserCases([journey],{draft:false});
  assert.deepEqual([item.steps[1].checks,item.assertions],[journey.steps[1].checks,journey.assertions]);
  // Every {run} in a text check's value or a number check's label is filled in; the rest of the check is unchanged.
  assert.deepEqual(resolveCheck({type:'text-visible',value:'{run} and {run}'},'k3m9x2qa'),{type:'text-visible',value:'k3m9x2qa and k3m9x2qa'});
  assert.deepEqual(resolveCheck({type:'compare-number',label:'Tasks for QA {run}',name:'after',op:'<',than:'before'},'k3m9x2qa'),{type:'compare-number',label:'Tasks for QA k3m9x2qa',name:'after',op:'<',than:'before'});
  assert.deepEqual(resolveCheck({type:'url-contains',value:'/profile'},'k3m9x2qa'),{type:'url-contains',value:'/profile'});
  // A reported text counts only as the template with one run token in place of every {run}.
  assert.equal(resolvedFrom('Draft of {run} and {run}','Draft of k3m9x2qa and k3m9x2qa'),true);
  for(const resolved of ['Draft of k3m9x2qa and k3m9x2qb','Draft of {run} and {run}','Draft of K3M9X2QA and K3M9X2QA','Draft of k3m9x2q and k3m9x2q','draft of k3m9x2qa and k3m9x2qa',' Draft of k3m9x2qa and k3m9x2qa',undefined,1])
    assert.equal(resolvedFrom('Draft of {run} and {run}',resolved),false,String(resolved));
  assert.equal(resolvedFrom('Cost (USD) [x]* {run}','Cost (USD) [x]* 00000000'),true,'The rest of the template matches as written.');
  // A digit right after a later {run} is text of the template, never part of a pattern.
  for(const template of ['{run}{run}1','a {run} b {run}2','Order {run}, copy {run}2','v{run}.{run}1','/items/{run}/{run}0','{run}{run}8']){
    assert.equal(resolvedFrom(template,template.replaceAll('{run}','k3m9x2qa')),true,template);
    for(const resolved of [template.replaceAll('{run}','k3m9x2qa').slice(0,-1),template.replace('{run}','k3m9x2qa').replace('{run}','k3m9x2qb'),`${template.replaceAll('{run}','k3m9x2qa')}0`])
      assert.equal(resolvedFrom(template,resolved),false,`${template} ${resolved}`);
  }
  assert.equal(resolvedFrom('Saved','Saved'),false,'A check without {run} resolves to nothing.');
  // Evidence shows the check as written and the text it looked for.
  assert.equal(checkText({type:'text-visible',value:'QA  {run}',resolved:'QA  k3m9x2qa'}),'Text visible “QA {run}” (“QA k3m9x2qa”)');
  assert.equal(checkText({type:'read-number',label:'Tasks for QA {run}',name:'tasks',observed:3,resolved:'Tasks for QA k3m9x2qa'}),'Tasks for QA {run} (“Tasks for QA k3m9x2qa”) 3');
  assert.equal(checkText({type:'text-visible',value:'Saved'}),'Text visible “Saved”');
});

test('every journey process gets its own run token',()=>{
  const tokens=new Set(Array.from({length:200},runToken));
  assert.equal(tokens.size,200);
  assert.ok([...tokens].every(token=>RUN_TOKEN.test(token)));
  const options={hash:'0'.repeat(64),targetUrl:'http://localhost:3000/'};
  const [first,second]=[journeyEnvironment({},'/workspace',options),journeyEnvironment({},'/workspace',{...options,blockWrites:true})];
  assert.match(first.PERPETUAL_RUN_TOKEN,RUN_TOKEN);assert.match(second.PERPETUAL_RUN_TOKEN,RUN_TOKEN);
  assert.notEqual(first.PERPETUAL_RUN_TOKEN,second.PERPETUAL_RUN_TOKEN,'A control run types values of its own.');
  assert.notEqual(journeyEnvironment({PERPETUAL_RUN_TOKEN:'aaaaaaaa'},'/workspace',options).PERPETUAL_RUN_TOKEN,'aaaaaaaa','The controller environment never sets it.');
});

test('a maximum-size reviewed read policy reaches the worker without a Linux-sized environment string',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'perpetual-read-policy-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const targetUrl='http://localhost:3000/',body=JSON.stringify({value:'x'.repeat(4084)});
  assert.equal(Buffer.byteLength(body),4096);
  const readOnlyRequests=Array.from({length:32},(_,index)=>({url:`${targetUrl}read/${index}`,body}));
  const options={hash:'0'.repeat(64),targetUrl};
  await writeJourneyWorkspace(workspace,{item:approvedCase(journey),targetUrl,timeoutSeconds:60,readOnlyRequests});
  const env=journeyEnvironment({},workspace,options);
  assert.ok(Object.values(env).every(value=>Buffer.byteLength(value)<128*1024),'Valid policies must not exceed Linux’s single environment-string limit.');
  const file=join(workspace,'read-requests.json');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),readOnlyRequests,'The complete exact policy reaches the private worker workspace.');
  assert.equal((await stat(file)).mode&0o777,0o600);
});

test('a final assertion that names {run} counts only with the text it looked for',()=>{
  const done=journey.steps.map(({id,title})=>({id,title,status:'completed'}));
  const facts=(assertions:unknown[])=>journeyResult(journey,{caseId:journey.id,stopCause:'none',assertions},done);
  const url={type:'url-contains',value:'/profile',passed:true},draft={type:'text-absent',value:'Draft of {run} and {run}',passed:true};
  assert.deepEqual(facts([url,{...draft,resolved:'Draft of k3m9x2qa and k3m9x2qa'}]),{caseId:journey.id,status:'passed',engine:'playwright',assertions:[url,{...draft,resolved:'Draft of k3m9x2qa and k3m9x2qa'}]});
  for(const assertions of [[url,draft],[url,{...draft,resolved:'Draft of k3m9x2qa and k3m9x2qb'}],[{...url,resolved:'/profile'},{...draft,resolved:'Draft of k3m9x2qa and k3m9x2qa'}]])
    assert.equal(facts(assertions).error,'The final assertions were not evaluated.',JSON.stringify(assertions));
  const copy={...journey,assertions:[{type:'text-visible' as const,value:'Order {run}, copy {run}2'}]};
  assert.equal(journeyResult(copy,{caseId:journey.id,stopCause:'none',assertions:[{...copy.assertions[0],passed:true,resolved:'Order k3m9x2qa, copy k3m9x2qa2'}]},done).status,'passed');
});

// A manager whose Playwright runtime replays the events a fixture reports for each run.
async function setup(t:TestContext,events:(input:JourneyRunInput)=>WorkerEvent[],item:Omit<BrowserCase,'evidence'>=journey){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-run-values-'));await mkdir(join(dataDir,'repo'));
  const playwright:JourneyRuntime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(input,onEvent){const promise=new Promise<void>((resolve,reject)=>setTimeout(()=>{try{for(const event of events(input))onEvent(event);resolve();}catch(error){reject(error);}},5));return {promise,cancel(){}};}};
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('The browser agent must not run a journey.');}};
  const manager=await createBrowserManager({dataDir,runtime,playwright});
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,[item]);
  const code=codeFor(item).replace('async () => {}','async () => { await page.getByLabel("Name").fill(`QA ${journey.run}`); }');
  await manager.saveSpec(context,{caseId:item.id,code});
  const finished=async()=>{const {run}=await manager.run(context,{},{manual:true});for(let i=0;i<400;i++){const report=await manager.runProgress(context,run.id);if(!['queued','running'].includes(report.run.status))return report;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('The run did not finish.');};
  return {finished};
}
const reported=(token:(template:string)=>unknown)=>(input:JourneyRunInput):WorkerEvent[]=>[
  ...input.case.steps!.flatMap(step=>[{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'running'},{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'completed',evidence:'Reviewed checks passed.',
    checks:step.checks!.map(check=>{const template='value' in check?check.value:check.label,resolved=token(template);return {...check,passed:true,...(check.type==='read-number'?{observed:3}:{}),...(resolved===undefined?{}:{resolved})};})}]),
  {type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:input.case.assertions!.map(check=>{const resolved=token(check.value);return {...check,passed:true,...(resolved===undefined?{}:{resolved})};})}}];
const filled=(template:string)=>template.includes('{run}')?template.replaceAll('{run}','k3m9x2qa'):undefined;

test('a run keeps each check as written with the text it looked for, and refuses a text that is not the template filled in',async t=>{
  const f=await setup(t,reported(filled));
  const report=await f.finished();
  assert.equal(report.run.status,'passed',JSON.stringify(report.results));
  const checks=report.progress.cases[0].steps!.flatMap(step=>step.checks||[]);
  assert.deepEqual(checks.map(check=>[check.type,'value' in check?check.value:check.label,check.resolved]),[['text-visible','Saved',undefined],['text-visible','QA {run}','QA k3m9x2qa'],['read-number','Tasks for QA {run}','Tasks for QA k3m9x2qa']]);
  assert.deepEqual(report.results[0].assertions.map(item=>item.resolved),[undefined,'Draft of k3m9x2qa and k3m9x2qa']);
  // A text other than the template with the run's token, or none where the check names {run}, is not the reviewed check.
  for(const token of [(template:string)=>filled(template)?.replace('k3m9x2qa','Old Name'),()=>undefined,(template:string)=>filled(template)??template]){
    const g=await setup(t,reported(token));
    const failed=await g.finished();
    assert.deepEqual([failed.results[0].status,failed.results[0].error],['failed','Browser progress returned invalid milestone checks.'],String(token));
    assert.ok(failed.progress.cases[0].steps!.every(step=>step.status!=='completed'||step.checks!.every(check=>check.resolved===undefined)),'No forged text is kept.');
  }
  // A digit right after a later {run} is the template's own text.
  const copies={...journey,steps:journey.steps.map(step=>({...step,checks:step.checks.map(check=>check.type==='text-visible'&&check.value.includes('{run}')?{...check,value:'Order {run}, copy {run}2'}:check)}))};
  const copied=await (await setup(t,reported(filled),copies)).finished();
  assert.equal(copied.run.status,'passed',JSON.stringify(copied.results));
  assert.equal(copied.progress.cases[0].steps![1].checks![0].resolved,'Order k3m9x2qa, copy k3m9x2qa2');
});
