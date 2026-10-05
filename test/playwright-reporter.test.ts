import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import JourneyReporter from '../src/journeys/playwright/reporter.ts';
import type {TestCase,TestResult,TestStep} from '@playwright/test/reporter';

test('reporter masks origin account errors before clipping while preserving reviewed check evidence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-reporter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'case.json'),username=`former-${'z'.repeat(305)}`,password='former-password-fixture';
  await writeFile(file,JSON.stringify({id:'case',name:'Save workspace',goal:'Save and reopen my workspace',steps:[],assertions:[]}));
  const keys=['PERPETUAL_CASE','PERPETUAL_ACCOUNT_USERNAME','PERPETUAL_ACCOUNT_PASSWORD','PERPETUAL_EVENT_CHANNEL'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,{PERPETUAL_CASE:file,PERPETUAL_ACCOUNT_USERNAME:username,PERPETUAL_ACCOUNT_PASSWORD:password,PERPETUAL_EVENT_CHANNEL:'channel:'});
    const reporter=new JourneyReporter();
    const error=reporter.safe(`Missing link '${username}' with '${password}'`);
    assert.ok(error.includes('Missing link'));assert.ok(error.includes('[REDACTED]'));
    assert.ok(!error.includes(username.slice(0,50)));assert.ok(!error.includes(password));assert.ok(error.length<=300);
    const emitted:unknown[]=[];reporter.write=event=>{emitted.push(event);};
    const evidence={type:'journey-step',caseId:'case',stepId:'saved',status:'completed',checks:[{type:'text-visible',value:username,passed:true}]};
    reporter.onStdOut(`channel:${JSON.stringify(evidence)}\n`);
    assert.deepEqual(emitted,[evidence]);
  }finally{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});

test('reporter lists every action the journey grammar allows and counts them all',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-reporter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'case.json'),previous=process.env.PERPETUAL_CASE;
  await writeFile(file,JSON.stringify({id:'case',name:'Save workspace',goal:'Save and reopen my workspace',steps:[],assertions:[]}));
  try{
    process.env.PERPETUAL_CASE=file;
    const reporter=new JourneyReporter(),emitted:{actions:{type:string}[];actionCount:number}[]=[];reporter.write=event=>{emitted.push(event as typeof emitted[number]);};
    const run=(title:string)=>{const step={category:'pw:api',title} as TestStep;reporter.onStepBegin({} as TestCase,{} as TestResult,step);reporter.onStepEnd({} as TestCase,{} as TestResult,step);};
    // Playwright 1.63's step titles for the grammar's actions.
    const titles:[string,string][]=[['Navigate to "/settings"','navigate'],['Go forward','navigate'],['Reload','reload_page'],['Go back','go_back'],['Click','click'],['Double click','click'],['Tap','click'],['Check','click'],['Uncheck','click'],['Drag and drop','click'],
      ['Mouse down','click'],['Mouse up','click'],['Fill "QA"','input'],['Type "QA"','input'],['Press sequentially "QA"','input'],['Clear','input'],['Insert "QA"','input'],['Press "Enter"','send_keys'],['Key down "Shift"','send_keys'],['Key up "Shift"','send_keys'],
      ['Select option','select_option'],['Hover','hover'],['Mouse move','hover'],['Scroll into view','scroll'],['Mouse wheel','scroll'],['Focus','focus'],['Blur','blur'],['Wait for selector','wait'],['Wait for URL','wait'],['Wait for load state','wait'],['Wait for timeout','wait']];
    for(const [title] of titles)run(title);
    assert.deepEqual(emitted.at(-1)!.actions.map(action=>action.type),titles.map(([,type])=>type));
    // The case event carries the latest 150 actions and how many there were in all.
    for(let index=0;index<160;index++)run('Click');
    assert.deepEqual([emitted.at(-1)!.actions.length,emitted.at(-1)!.actionCount],[150,titles.length+160]);
  }finally{if(previous===undefined)delete process.env.PERPETUAL_CASE;else process.env.PERPETUAL_CASE=previous;}
});

test('reporter retains a fixed rejected-read reason without forwarding arbitrary diagnostics',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-reporter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'case.json');await writeFile(file,JSON.stringify({id:'case',name:'Save workspace',goal:'Save and reopen my workspace',steps:[],assertions:[]}));
  const keys=['PERPETUAL_CASE','PERPETUAL_EVENT_CHANNEL'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,{PERPETUAL_CASE:file,PERPETUAL_EVENT_CHANNEL:'channel:'});
    const reporter=new JourneyReporter();reporter.write=()=>{};
    reporter.onStdOut('channel:'+JSON.stringify({type:'control-read',caseId:'case',eligible:false,reason:'url-changed'})+'\n');
    assert.equal(reporter.facts().controlReadReason,'url-changed');
    for(const reason of ['private page address','constructor',{}]){
      const invalid=new JourneyReporter();invalid.write=()=>{};
      invalid.onStdOut('channel:'+JSON.stringify({type:'control-read',caseId:'case',eligible:true,reason})+'\n');
      assert.notEqual(invalid.facts().controlRead,true);
      assert.equal(invalid.facts().controlReadReason,undefined);
    }
  }finally{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});

test('reporter hides encoded account paths before clipping and refuses malformed transport evidence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-reporter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'case.json');await writeFile(file,JSON.stringify({id:'case',name:'Save workspace',goal:'Save and reopen my workspace',steps:[],assertions:[]}));
  const keys=['PERPETUAL_CASE','PERPETUAL_EVENT_CHANNEL','PERPETUAL_ACCOUNT_USERNAME','PERPETUAL_ACCOUNT_PASSWORD'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const username='viewer@example.test',password='private-'+ 'p'.repeat(600);
  try{
    Object.assign(process.env,{PERPETUAL_CASE:file,PERPETUAL_EVENT_CHANNEL:'channel:',PERPETUAL_ACCOUNT_USERNAME:username,PERPETUAL_ACCOUNT_PASSWORD:password});
    const controlBlocks=[{kind:'http',method:'POST',url:`https://app.test/${encodeURIComponent(username)}/${encodeURIComponent(password)}?token=private`,afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}];
    const reporter=new JourneyReporter();reporter.write=()=>{};
    reporter.onStdOut('channel:'+JSON.stringify({type:'control-read',caseId:'case',eligible:false,reason:'blocked-after-read',controlBlocks})+'\n');
    assert.deepEqual((reporter.facts() as unknown as {controlBlocks:unknown}).controlBlocks,[{kind:'http',method:'POST',url:'https://app.test/[REDACTED]/[REDACTED]',afterRead:true},controlBlocks[1]]);
    for(const changes of [{eligible:true},{controlBlocks:[{...controlBlocks[1],message:password}]},{controlBlocks:Array(11).fill(controlBlocks[0])}]){
      const invalid=new JourneyReporter();invalid.write=()=>{};
      invalid.onStdOut('channel:'+JSON.stringify({type:'control-read',caseId:'case',eligible:false,controlBlocks,...changes})+'\n');
      assert.notEqual(invalid.facts().controlRead,true);assert.equal((invalid.facts() as unknown as {controlBlocks?:unknown}).controlBlocks,undefined);
    }
  }finally{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});
