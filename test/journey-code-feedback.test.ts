import test from 'node:test';
import assert from 'node:assert/strict';
import {createJourneyCode,type JourneyCodeSnapshot} from '../src/browser/journey-code.ts';
import {validateBrowserCases} from '../src/business/browser-cases.ts';
import {caseHash,specHash} from '../src/journeys/playwright/specs.ts';
import {CHECK_VERSION} from '../src/journeys/playwright/checks.ts';

test('regeneration remembers bounded failures of the same reviewed contract without historical code or unrelated evidence',()=>{
  const [item]=validateBrowserCases([{id:'rename',name:'Rename workspace',goal:'Save and reopen my workspace name',steps:[{id:'save',title:'Save and reopen',checks:[{type:'text-visible',value:'Workspace {run}'}]}],expectedOutcomes:['The new name persists'],needsReview:false}]);
  const contract=caseHash(item),policy='a'.repeat(64),code='historical private input literal',hash=specHash(code);
  const failed=(error:string,index:number):JourneyCodeSnapshot['runs'][number]=>({
    id:`run-${index}`,status:'needs_review',caseIds:[item.id],specHashes:{[item.id]:hash},
    verification:{id:`verify-${index}`,hash,caseHash:contract,checkVersion:CHECK_VERSION,readPolicy:policy,attempt:1,control:false},
    results:[{caseId:item.id,status:'needs_review',assertions:[],error}],
    codeFeedback:{[item.id]:error},
  });
  const latest=failed('Response wait missed the actual request',0),otherCase=failed('Other journey',1),otherContract=failed('Earlier contract',2),otherPolicy=failed('Other read permission',3),olderChecks=failed('Historical checks',4),control=failed('Expected control failure',5),unexecuted=failed('Code identity mismatch',6);
  otherCase.caseIds=['other'];otherCase.results=[{caseId:'other',status:'needs_review',assertions:[],error:'Other journey'}];
  otherContract.verification!.caseHash='b'.repeat(64);otherPolicy.verification!.readPolicy='c'.repeat(64);olderChecks.verification!.checkVersion=CHECK_VERSION-1;control.verification!.control=true;unexecuted.specHashes={[item.id]:'d'.repeat(64)};
  const cancelled=failed('Cancelled attempt',12),passing=failed('Passing attempt',13),skipped=failed('Skipped attempt',14);
  cancelled.status='cancelled';passing.status='passed';skipped.results=[{caseId:item.id,status:'skipped',assertions:[],error:'Skipped attempt'}];
  const snapshot:JourneyCodeSnapshot={readPolicy:policy,cases:[item],generations:new Map(),verifications:[],
    code:{generationFailures:{},specs:{[item.id]:{approved:null,draft:{code,hash,caseHash:contract,savedAt:'2026-10-01T00:00:00.000Z',verification:{id:'verify-0',checkVersion:CHECK_VERSION,readPolicy:policy,status:'failed',passes:0,control:null,error:'Response wait missed the actual request',runIds:[latest.id]}}}}},
    runs:[latest,otherCase,otherContract,otherPolicy,olderChecks,control,unexecuted,cancelled,passing,skipped,failed('Ambiguous action name',7),failed('Ambiguous action name',8),failed('Unsettled navigation',9),failed('Missing record scope',10),failed('Oldest failure outside the bound',11)],
  };
  const owner=createJourneyCode({read:()=>snapshot,transact:async()=>{throw new Error('Reading feedback must not write.');}});
  assert.deepEqual(owner.generationFeedback('scope',item.id),{error:'Response wait missed the actual request',previousErrors:['Ambiguous action name','Unsettled navigation','Missing record scope']});
  assert.ok(!JSON.stringify(owner.generationFeedback('scope',item.id)).includes(code));
  // Old runs have no origin-account scrubbed feedback; a later account cannot sanitize their raw diagnostics.
  snapshot.runs=[latest,{...failed("getByRole('link', { name: 'former-private-user' }) failed",15),codeFeedback:undefined},...snapshot.runs.slice(1)];
  assert.ok(!JSON.stringify(owner.generationFeedback('scope',item.id)).includes('former-private-user'));
  latest.codeFeedback=undefined;
  assert.equal(owner.generationFeedback('scope',item.id),undefined);
  snapshot.cases=[{...item,goal:'A newly reviewed outcome'}];
  assert.equal(owner.generationFeedback('scope',item.id),undefined);
});

test('regeneration receives an ineligible control diagnosis without its raw error or historical code',()=>{
  const [item]=validateBrowserCases([{id:'rename',name:'Rename workspace',goal:'Save and reopen my workspace name',steps:[{id:'save',title:'Save and reopen',checks:[{type:'text-visible',value:'Workspace {run}'}]}],expectedOutcomes:['The new name persists'],needsReview:false}]);
  const code='historical private input',hash=specHash(code),contract=caseHash(item);
  const runs:JourneyCodeSnapshot['runs']=Array.from({length:4},(_,index)=>({id:`run-${index}`,status:index===3?'failed':'passed',caseIds:[item.id],specHashes:{[item.id]:hash},verification:{id:'verify',hash,caseHash:contract,checkVersion:CHECK_VERSION,attempt:index+1,control:index===3},results:[{caseId:item.id,status:index===3?'failed':'passed',assertions:[],...(index===3?{controlRead:false,controlReadReason:'url-changed',error:'private former account'}:{})}],progress:{cases:[{id:item.id,steps:[{status:index===3?'failed':'completed'}]}]}}));
  const snapshot:JourneyCodeSnapshot={cases:[item],generations:new Map(),verifications:[],runs,code:{generationFailures:{},specs:{[item.id]:{approved:null,draft:{code,hash,caseHash:contract,savedAt:'2026-10-01T00:00:00.000Z',verification:{id:'verify',checkVersion:CHECK_VERSION,status:'failed',passes:3,control:'missed',error:'The control did not check freshly read business data.',runIds:runs.map(run=>run.id)}}}}}};
  const owner=createJourneyCode({read:()=>snapshot,transact:async()=>{throw new Error('Reading feedback must not write.');}});
  const feedback=owner.generationFeedback('scope',item.id);
  assert.match(feedback?.error||'',/address changed/);
  assert.ok(!JSON.stringify(feedback).includes('private'));
});

test('a failed read reaches the person and regeneration as its kind and status, never its address',()=>{
  const [item]=validateBrowserCases([{id:'rename',name:'Rename workspace',goal:'Save and reopen my workspace name',steps:[{id:'save',title:'Save and reopen',checks:[{type:'text-visible',value:'Workspace {run}'}]}],expectedOutcomes:['The new name persists'],needsReview:false}]);
  const code='historical private input',hash=specHash(code),contract=caseHash(item);
  const controlFailedRead={resourceType:'fetch' as const,method:'GET',url:'http://app.test/private-path',status:500};
  const runs:JourneyCodeSnapshot['runs']=Array.from({length:4},(_,index)=>({id:`run-${index}`,status:index===3?'failed':'passed',caseIds:[item.id],specHashes:{[item.id]:hash},verification:{id:'verify',hash,caseHash:contract,checkVersion:CHECK_VERSION,attempt:index+1,control:index===3},results:[{caseId:item.id,status:index===3?'failed':'passed',assertions:[],...(index===3?{controlRead:false,controlReadReason:'read-failed' as const,controlFailedRead}:{})}],progress:{cases:[{id:item.id,steps:[{status:index===3?'failed':'completed'}]}]}}));
  const snapshot:JourneyCodeSnapshot={cases:[item],generations:new Map(),verifications:[],runs,code:{generationFailures:{},specs:{[item.id]:{approved:null,draft:{code,hash,caseHash:contract,savedAt:'2026-10-01T00:00:00.000Z'}}}}};
  const owner=createJourneyCode({read:()=>snapshot,transact:async()=>{throw new Error('Reading feedback must not write.');}});
  const verification=owner.summary('scope')[item.id].draft?.verification;
  assert.deepEqual(verification,{status:'failed',passes:3,control:'missed',error:'A request carrying the judged page or its data failed. Resolve the failed read before checking persistence. The failed request was a fetch request (HTTP 500).'});
  assert.deepEqual(owner.generationFeedback('scope',item.id),{error:verification!.error});
  assert.ok(!JSON.stringify(owner.generationFeedback('scope',item.id)).includes('private'));
});
