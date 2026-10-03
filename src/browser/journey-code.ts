import type { AuthoringRecord } from '../../contract/authoring.ts';
import {randomUUID} from 'node:crypto';
import {hasJourneyChecks} from '../business/browser-cases.ts';
import {caseHash,specHash,validateJourneySpec} from '../journeys/playwright/specs.ts';
import {CHECK_VERSION} from '../journeys/playwright/checks.ts';
import type {BrowserCase} from '../business/browser-cases.ts';
import type {JourneyResult} from './results.ts';

import type { Verification, SpecVerification, SpecSummary, SpecCodeReply } from '../../contract/browser.ts';
export type { Verification, SpecSummary } from '../../contract/browser.ts';

type VerificationState=Omit<SpecVerification,'status'>&{status:Exclude<SpecVerification['status'],'running'>};
type StoredVerification=VerificationState&{id:string;checkVersion:number;readPolicy?:string;runIds:string[]};
type StoredSpec={code:string;hash:string;caseHash:string;savedAt:string;provenance?:unknown;verification?:StoredVerification};
type ApprovedSpec=StoredSpec&{approvedAt:string;approvedRunIds:string[];checkVersion?:number;readPolicy?:string};
type CaseSpecs={approved:ApprovedSpec|null;draft:StoredSpec|null};
type LegacySpec=StoredSpec&{approvedAt?:string;approvedRunId?:string};
export type GenerationFailure={caseHash:string;error:string;rejected?:string};
/** Durable journey code belongs to the browser manager's state file, never a second store. */
export type JourneyCodeState={specs:Record<string,CaseSpecs>;generationFailures:Record<string,GenerationFailure>;authoring?:Record<string,AuthoringRecord[]>};
export type VerificationIdentity={id:string;hash:string;caseHash:string;checkVersion:number;readPolicy?:string};
type VerificationRun={id:string;status:string;caseIds:readonly string[];verification?:Verification;specHashes?:Record<string,string>;results?:readonly JourneyResult[];error?:string;progress?:{cases:readonly {id:string;steps?:readonly {status:string}[]}[]}};
type LiveVerification=VerificationIdentity&{caseId:string;done:boolean;error?:string};
type LiveGeneration={status:'running'|'failed';step?:string;error?:string;rejected?:string;discarded?:true};
export type RunnableCode={code:string;hash:string;checkVersion:number;missing?:undefined}|{missing:string;code?:undefined;hash?:undefined;checkVersion?:undefined};
/** Read at the call/commit, including current execution facts; the code owner never retains a worker or lease. */
export type JourneyCodeSnapshot={readPolicy?:string;cases:readonly BrowserCase[];code:JourneyCodeState;runs:readonly VerificationRun[];verifications:readonly LiveVerification[];generations:ReadonlyMap<string,LiveGeneration>};
type Persistence={
  read(scope:string):JourneyCodeSnapshot;
  transact(scope:string,change:(current:JourneyCodeSnapshot)=>JourneyCodeState):Promise<void>;
};

const now=()=>new Date().toISOString();
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const NO_CODE='Generate and approve code for this journey.',STALE_CODE='The approved code is for an earlier version of this journey.';
const OLD_CODE='Reuse and verify the approved code again: its control evidence is out of date.';
const UNREAD='The control did not check freshly read business data. Reload after the change, then check a run-unique value or a number against its earlier value.';
const MISSED='The journey passed with every change blocked. Strengthen its checks.',UNJUDGED='No reviewed check noticed the blocked changes.',CHANGED='The journey changed during its verification. Verify its code again.';
const policyMatches=(current:JourneyCodeSnapshot,value:{readPolicy?:string}|null|undefined)=>(current.readPolicy??'')===(value?.readPolicy??'');
const active=(run:VerificationRun)=>['queued','running'].includes(run.status);
const drafted=(item:BrowserCase,code:string,provenance?:unknown):StoredSpec=>({code,hash:specHash(code),caseHash:caseHash(item),savedAt:now(),...(provenance?{provenance:structuredClone(provenance)}:{})});
const caseOf=(current:JourneyCodeSnapshot,id:unknown)=>{
  const item=current.cases.find(item=>item.id===id);
  if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
  return item;
};
const attemptsOf=(current:JourneyCodeSnapshot,id:string)=>current.runs.filter((run):run is VerificationRun&{verification:Verification}=>run.verification?.id===id).sort((a,b)=>a.verification.attempt-b.verification.attempt);
const noticed=(run:VerificationRun,caseId:string,result:JourneyResult)=>Boolean(run.progress?.cases.find(item=>item.id===caseId)?.steps?.some(step=>step.status==='failed')||result.assertions?.some(item=>item.passed===false&&item.reached!==false));

/** Recover older code formats without granting an approval that never named a whole verification. */
export function restoreJourneyCode(value:{specs:unknown;generationFailures:unknown},cases:readonly BrowserCase[],diagnostic:(value:unknown,limit?:number)=>string):JourneyCodeState{
  if(!isRecord(value.specs)||!isRecord(value.generationFailures))throw new Error('Unsupported code generation failure state.');
  const specs={...value.specs} as Record<string,CaseSpecs|LegacySpec>;
  for(const [caseId,spec] of Object.entries(specs)){
    if(typeof (spec as Partial<LegacySpec>|null)?.code==='string'){
      const {approvedAt,approvedRunId,...kept}=spec as LegacySpec;specs[caseId]={approved:null,draft:kept};
    }else{
      const pair=spec as CaseSpecs;
      if(pair.approved&&(!Array.isArray(pair.approved.approvedRunIds)||pair.approved.approvedRunIds.length!==4)){
        const {approvedAt,approvedRunIds,...kept}=pair.approved;specs[caseId]={approved:null,draft:pair.draft??kept};
      }
    }
  }
  const generationFailures=Object.fromEntries(Object.entries(value.generationFailures).flatMap(([id,failure])=>{
    if(!isRecord(failure)||typeof failure.caseHash!=='string'||!/^[a-f0-9]{64}$/.test(failure.caseHash)||typeof failure.error!=='string'||failure.rejected!==undefined&&typeof failure.rejected!=='string')throw new Error('Unsupported code generation failure state.');
    const item=cases.find(item=>item.id===id);
    return item&&caseHash(item)===failure.caseHash?[[id,{caseHash:failure.caseHash,error:diagnostic(failure.error),...(failure.rejected?{rejected:diagnostic(failure.rejected,20000)}:{})}]]:[];
  }));
  return {specs:specs as Record<string,CaseSpecs>,generationFailures};
}

/** Compose a case replacement with the manager's case/analysis save, so code disappears in that same transaction. */
export function replaceJourneyCases(code:JourneyCodeState,cases:readonly BrowserCase[]):JourneyCodeState{
  return {
    ...(code.authoring?{authoring:Object.fromEntries(Object.entries(code.authoring).filter(([id])=>cases.some(item=>item.id===id)))}:{}),
    specs:Object.fromEntries(Object.entries(code.specs).filter(([id])=>cases.some(item=>item.id===id))),
    generationFailures:Object.fromEntries(Object.entries(code.generationFailures).filter(([id,failure])=>cases.some(item=>item.id===id&&caseHash(item)===failure.caseHash))),
  };
}

function verificationState(current:JourneyCodeSnapshot,caseId:string,id:string,error?:string):VerificationState{
  let passes=0;
  for(const run of attemptsOf(current,id)){
    if(active(run))break;
    if(run.verification.attempt!==passes+1)return {status:'cancelled',passes:0,control:null};
    const result=run.results?.find(item=>item.caseId===caseId),failed=(error=result?.error||run.error||'The journey did not pass.'):VerificationState=>({status:'failed',passes,control:null,error});
    if(run.status==='cancelled'||result?.status==='cancelled'||result?.status==='skipped')return {status:'cancelled',passes,control:null};
    if(run.specHashes?.[caseId]!==run.verification.hash)return failed();
    if(!run.verification.control){if(result?.status!=='passed')return failed();passes++;continue;}
    if(passes<3)return {status:'cancelled',passes,control:null};
    if(!result)return failed();
    if(result.status==='passed')return {status:'failed',passes,control:'missed',error:MISSED};
    if(noticed(run,caseId,result)&&result.controlRead!==true)return {status:'failed',passes,control:'missed',error:UNREAD};
    return noticed(run,caseId,result)?{status:'passed',passes,control:'caught'}:failed(result.error?`${UNJUDGED} ${result.error}`:UNJUDGED);
  }
  return error?{status:'failed',passes,control:null,error}:{status:'cancelled',passes,control:null};
}

// A single evidence decision feeds both the public view and approval's run IDs. The draft's durable record is newer
// than historical attempts even when its verification failed before admitting a run. Only unrecorded drafts use history.
function verificationEvidence(current:JourneyCodeSnapshot,caseId:string,draft:StoredSpec):{view:SpecVerification;runIds:string[]}|null{
  const live=current.verifications.find(item=>item.caseId===caseId);
  const matches=(value:{hash:string;caseHash:string;checkVersion?:number;readPolicy?:string}|undefined)=>value?.hash===draft.hash&&value.caseHash===draft.caseHash&&(value.checkVersion??1)===CHECK_VERSION&&policyMatches(current,value);
  const record=draft.verification?.checkVersion===CHECK_VERSION&&policyMatches(current,draft.verification)?draft.verification:null;
  const id=matches(live)?live!.id:record?.id??current.runs.find(run=>run.caseIds[0]===caseId&&matches(run.verification))?.verification?.id;
  const running=Boolean(live&&live.id===id&&!live.done);
  if(!running&&record&&(!id||id===record.id)){
    const {id:_id,checkVersion:_version,readPolicy:_policy,runIds,...view}=record;return {view,runIds};
  }
  if(!id)return null;
  const {status,error,...counts}=verificationState(current,caseId,id,live?.id===id?live.error:undefined);
  return {view:running?{status:'running',...counts}:{status,...counts,...(error?{error}:{})},runIds:attemptsOf(current,id).map(run=>run.id)};
}

/** Owns journey-code transitions; persistence evaluates them against queue-time state and publishes only after save. */
export function createJourneyCode(storage:Persistence){
  const clearFailure=(code:JourneyCodeState,caseId:string)=>({...code,generationFailures:Object.fromEntries(Object.entries(code.generationFailures).filter(([id])=>id!==caseId))});
  function changeSpec(scope:string,caseId:string,change:(current:JourneyCodeSnapshot,item:BrowserCase,specs:CaseSpecs)=>CaseSpecs){
    return storage.transact(scope,current=>{
      const item=caseOf(current,caseId),next=change(current,item,current.code.specs[caseId]||{approved:null,draft:null}),code=clearFailure(current.code,caseId);
      const specs={...code.specs};if(next.approved||next.draft)specs[caseId]=next;else delete specs[caseId];
      return {...code,specs};
    });
  }
  return {
    summary(scope:string){
      const current=storage.read(scope);
      return Object.fromEntries(current.cases.filter(item=>current.code.specs[item.id]||current.generations.has(item.id)||current.code.generationFailures[item.id]).map((item):[string,SpecSummary]=>{
        const {approved,draft}=current.code.specs[item.id]||{},storedFailure=current.code.generationFailures[item.id];
        const verification=draft&&verificationEvidence(current,item.id,draft)?.view;
        const generation=current.generations.get(item.id)||(storedFailure?{status:'failed' as const,...storedFailure}:undefined);
        const provenance=(spec:StoredSpec)=>spec.provenance?{provenance:structuredClone(spec.provenance)}:{};
        return [item.id,{
          ...(approved?{approved:{hash:approved.hash,stale:approved.caseHash!==caseHash(item)||(approved.checkVersion??1)!==CHECK_VERSION||!policyMatches(current,approved),approvedAt:approved.approvedAt,...provenance(approved)}}:{}),
          ...(draft?{draft:{hash:draft.hash,stale:draft.caseHash!==caseHash(item),...provenance(draft),...(verification?{verification}:{})}}:{}),
          ...(generation?{generation:{status:generation.status,...(generation.step?{step:generation.step}:{}),...(generation.error?{error:generation.error}:{}),...(generation.rejected?{rejected:generation.rejected}:{})}}:{}),
        }];
      }));
    },
    code(scope:string,caseId:unknown):SpecCodeReply{
      const current=storage.read(scope),item=caseOf(current,caseId),{approved,draft}=current.code.specs[item.id]||{};
      return {...(current.code.authoring?.[item.id]?.length?{authoring:structuredClone(current.code.authoring[item.id])}:{}),...(draft?{draft:{hash:draft.hash,code:draft.code}}:{}),...(approved?{approved:{hash:approved.hash,code:approved.code}}:{})};
    },
    runnable(scope:string,item:BrowserCase,{manual=false,verification}:{manual?:boolean;verification?:Verification}={}):RunnableCode{
      const snapshot=storage.read(scope),{approved,draft}=snapshot.code.specs[item.id]||{},current=(spec:StoredSpec|null|undefined)=>spec?.caseHash===caseHash(item);
      const approvedCurrent=current(approved)&&(approved?.checkVersion??1)===CHECK_VERSION&&policyMatches(snapshot,approved);
      const spec=verification?(draft?.hash===verification.hash&&draft.caseHash===verification.caseHash&&current(draft)&&policyMatches(snapshot,verification)?draft:null):approvedCurrent?approved:manual&&current(draft)?draft:null;
      if(!spec)return {missing:verification?CHANGED:approved&&!current(approved)?STALE_CODE:approved&&!approvedCurrent?OLD_CODE:NO_CODE};
      try{validateJourneySpec(spec.code,item);}catch(error){return {missing:`Generate code for this journey again: ${(error as Error).message}`};}
      return {code:spec.code,hash:spec.hash,checkVersion:spec===approved?approved.checkVersion??1:CHECK_VERSION};
    },
    saveDraft(scope:string,caseId:string,code:unknown){return changeSpec(scope,caseId,(_,item,{approved})=>({approved,draft:drafted(item,validateJourneySpec(code,item))}));},
    generatedDraft(scope:string,item:BrowserCase,code:string,provenance:unknown){
      return storage.transact(scope,current=>{
        const kept=clearFailure(current.code,item.id),specs={...kept.specs};
        // A removed case keeps no generated code; an edited one may retain the draft, explicitly stale.
        if(current.cases.some(value=>value.id===item.id))specs[item.id]={approved:specs[item.id]?.approved??null,draft:drafted(item,code,provenance)};
        else delete specs[item.id];
        return {...kept,specs};
      });
    },
    approve(scope:string,caseId:string,hash:unknown){return changeSpec(scope,caseId,(current,item,{draft})=>{
      if(!draft)throw Object.assign(new Error('Generate code for this test first.'),{statusCode:404});
      if(item.needsReview)throw new Error('Review this test before approving its code.');
      if(typeof hash!=='string'||draft.hash!==hash)throw conflict('The code changed. Reload it and approve again.');
      if(draft.caseHash!==caseHash(item))throw conflict('The test changed after this code was saved. Generate it again.');
      const evidence=verificationEvidence(current,item.id,draft);
      if(evidence?.view.status!=='passed')throw conflict('Verify this code first: it needs three passing runs and a caught control run.');
      const {verification:ended,...code}=draft;
      return {approved:{...code,approvedAt:now(),approvedRunIds:[...evidence.runIds],checkVersion:CHECK_VERSION,...(current.readPolicy?{readPolicy:current.readPolicy}:{})},draft:null};
    });},
    discard(scope:string,caseId:string,hash:unknown){return changeSpec(scope,caseId,(_,item,{approved,draft})=>{
      if(!draft)throw Object.assign(new Error('This test has no draft code.'),{statusCode:404});
      if(typeof hash!=='string'||draft.hash!==hash)throw conflict('The code changed. Reload it and discard again.');
      return {approved,draft:null};
    });},
    reuse(scope:string,caseId:string){return changeSpec(scope,caseId,(current,item,{approved,draft})=>{
      if(!approved)throw Object.assign(new Error('This test has no approved code to reuse.'),{statusCode:404});
      if(approved.caseHash===caseHash(item)&&(approved.checkVersion??1)===CHECK_VERSION&&policyMatches(current,approved))throw conflict('The approved code is current.');
      if(draft&&draft.caseHash===caseHash(item))throw conflict('Discard the draft first.');
      let code:string;try{code=validateJourneySpec(approved.code,item);}catch(error){throw new Error(`Generate code for this test again: ${(error as Error).message}`);}
      return {approved,draft:drafted(item,code,approved.provenance)};
    });},
    verification(scope:string,caseId:string,hash:unknown){
      const current=storage.read(scope),item=caseOf(current,caseId),draft=current.code.specs[item.id]?.draft;
      if(item.needsReview)throw new Error('Review this test before verifying its code.');
      if(!hasJourneyChecks(item))throw new Error('Add at least one milestone check or final assertion before verifying code.');
      if(!draft)throw Object.assign(new Error('Generate code for this test first.'),{statusCode:404});
      if(typeof hash!=='string'||draft.hash!==hash)throw conflict('The code changed. Reload it and verify again.');
      if(draft.caseHash!==caseHash(item))throw conflict('The test changed after this code was saved. Generate it again.');
      const identity:Readonly<VerificationIdentity>=Object.freeze({id:randomUUID(),hash:draft.hash,caseHash:draft.caseHash,checkVersion:CHECK_VERSION,...(current.readPolicy?{readPolicy:current.readPolicy}:{})});
      return {
        identity,
        // Start before admitting an attempt, checkpoint after each, and finish before releasing the live activity.
        checkpoint(error?:string){return storage.transact(scope,current=>{
          const draft=current.code.specs[caseId]?.draft;
          if(draft?.hash!==identity.hash||draft.caseHash!==identity.caseHash)return current.code;
          const verification:StoredVerification={id:identity.id,checkVersion:identity.checkVersion,...(identity.readPolicy?{readPolicy:identity.readPolicy}:{}),...verificationState(current,caseId,identity.id,error),runIds:attemptsOf(current,identity.id).map(run=>run.id)};
          return {...current.code,specs:{...current.code.specs,[caseId]:{...current.code.specs[caseId],draft:{...draft,verification}}}};
        });},
      };
    },
    generationFeedback(scope:string,caseId:string){
      const current=storage.read(scope),item=caseOf(current,caseId),draft=current.code.specs[caseId]?.draft;
      if(!draft||draft.caseHash!==caseHash(item))return undefined;
      const verification=verificationEvidence(current,caseId,draft)?.view;
      return verification?.status==='failed'&&verification.error?{error:verification.error}:undefined;
    },
    clearGenerationFailure(scope:string,caseId:string){
      if(!storage.read(scope).code.generationFailures[caseId])return Promise.resolve();
      return storage.transact(scope,current=>clearFailure(current.code,caseId));
    },
    generationFailed(scope:string,caseId:string,failure:GenerationFailure){return storage.transact(scope,current=>{
      const code=replaceJourneyCases(current.code,current.cases);
      if(!current.generations.get(caseId)?.discarded&&current.cases.some(item=>item.id===caseId&&caseHash(item)===failure.caseHash))code.generationFailures[caseId]=failure;
      return code;
    });},
  };
}
