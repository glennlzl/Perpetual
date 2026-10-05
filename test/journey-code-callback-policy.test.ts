import test from 'node:test';import assert from 'node:assert/strict';
import {createJourneyCode,restoreJourneyCode} from '../src/browser/journey-code.ts';import type {JourneyCodeSnapshot} from '../src/browser/journey-code.ts';
import {caseHash,specHash} from '../src/journeys/playwright/specs.ts';import {CHECK_VERSION} from '../src/journeys/playwright/checks.ts';import {callbackPolicyHash} from '../src/browser/callbacks.ts';
import {browserCaseFixture} from './fixtures/browser-view.ts';import {codeFor} from './fixtures/journey-code.ts';
const item=browserCaseFixture({selected:true,needsReview:false,steps:[{id:'open',title:'Open'},{id:'save',title:'Save',checks:[{type:'text-visible',value:'Saved'}]}]});
const code=codeFor(item),hash=specHash(code),policy=callbackPolicyHash('scope',[{applicationId:'web',hostname:'localhost'}]);
function fixture(approvedPolicy?:unknown){
 let state=restoreJourneyCode({specs:{[item.id]:{draft:null,approved:{code,hash,caseHash:caseHash(item),savedAt:'2026-01-01T00:00:00Z',approvedAt:'2026-01-01T00:00:01Z',approvedRunIds:['a','b','c','d'],checkVersion:CHECK_VERSION,...(approvedPolicy===undefined?{}:{callbackPolicy:approvedPolicy})}}},generationFailures:{}},[item],String);
 let currentPolicy='';const runs:JourneyCodeSnapshot['runs'][number][]=[];
 const snapshot=():JourneyCodeSnapshot=>({callbackPolicy:currentPolicy,cases:[item],code:state,runs,verifications:[],generations:new Map()});
 const owner=createJourneyCode({read:snapshot,transact:async(_scope,change)=>{state=change(snapshot());}});
 return {owner,runs,snapshot,setPolicy:(value:string)=>{currentPolicy=value;}};
}
test('adding or removing a binding stales approval while reuse preserves code',async()=>{
 const f=fixture();assert.equal(f.owner.summary('scope')[item.id].approved?.stale,false);f.setPolicy(policy);
 assert.equal(f.owner.summary('scope')[item.id].approved?.stale,true);assert.ok(f.owner.runnable('scope',item,{}).missing);
 await f.owner.reuse('scope',item.id);assert.deepEqual(f.owner.code('scope',item.id).draft,{code,hash});assert.equal(f.owner.verification('scope',item.id,hash).identity.callbackPolicy,policy);
 const bound=fixture(policy);bound.setPolicy(policy);assert.equal(bound.owner.summary('scope')[item.id].approved?.stale,false);bound.setPolicy('');assert.ok(bound.owner.runnable('scope',item,{}).missing);
});
test('approval and historical attempts cannot cross callback policies',async()=>{
 const f=fixture();f.setPolicy(policy);await f.owner.reuse('scope',item.id);const verification=f.owner.verification('scope',item.id,hash);
 for(let attempt=1;attempt<=4;attempt++)f.runs.push({id:String(attempt),status:attempt===4?'failed':'passed',caseIds:[item.id],specHashes:{[item.id]:hash},verification:{...verification.identity,attempt,control:attempt===4},results:[{caseId:item.id,status:attempt===4?'failed':'passed',controlRead:attempt===4,assertions:[{type:'text-visible',value:'Saved',passed:attempt!==4}]}]});
 f.runs[3].verification!.callbackPolicy='';await assert.rejects(f.owner.approve('scope',item.id,hash),/Verify this code first/);
 f.runs[3].verification!.callbackPolicy=policy;await verification.checkpoint();f.setPolicy('');await assert.rejects(f.owner.approve('scope',item.id,hash),/Verify this code first/);
 f.setPolicy(policy);await f.owner.approve('scope',item.id,hash);assert.equal(f.snapshot().code.specs[item.id].approved?.callbackPolicy,policy);assert.deepEqual(f.snapshot().code.specs[item.id].approved?.approvedRunIds,['1','2','3','4']);
});
test('malformed private callback identity never restores approval or a checkpoint',()=>{
 for(const invalid of [null,12,'invalid','A'.repeat(64)])assert.throws(()=>fixture(invalid),/Unsupported/);
 for(const legacy of [undefined,'']){const f=fixture(legacy);assert.equal(f.owner.summary('scope')[item.id].approved?.stale,false);}
 const restored=restoreJourneyCode({specs:{[item.id]:{approved:null,draft:{code,hash,caseHash:caseHash(item),savedAt:'now',verification:{id:'verification',checkVersion:CHECK_VERSION,passes:3,control:'caught',status:'passed',runIds:['1','2','3','4'],callbackPolicy:'malformed'}}}},generationFailures:{}},[item],String);
 assert.equal(restored.specs[item.id].draft?.verification,undefined);
});
