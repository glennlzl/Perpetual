import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import JourneyReporter from '../src/journeys/playwright/reporter.ts';

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
