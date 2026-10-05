import {browserError} from './runtime.ts';
import {RUN,resolvedFrom} from '../journeys/playwright/checks.ts';
import {controlBlockerText} from '../journeys/playwright/control.ts';
import type {BrowserCase} from '../business/browser-cases.ts';

import type { BlockerKind, Blocker, AssertionResult, JourneyVerdict, JourneyResult, RunStatus, ControlBlocker } from '../../contract/browser.ts';
export type { BlockerKind, Blocker, AssertionResult, JourneyVerdict, JourneyResult, RunStatus } from '../../contract/browser.ts';
/** A milestone's progress as the controller accepted it. */
export type MilestoneState={id:string;title:string;status:string};
/** What a verdict reads of the approved case snapshot. */
export type ApprovedJourney=Pick<BrowserCase,'id'>&Partial<Pick<BrowserCase,'steps'|'assertions'>>;

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const safeText=(value:unknown,limit=800)=>value?browserError(String(value),process.env,limit):'';
const blockerKinds:ReadonlySet<unknown>=new Set<BlockerKind>(['account','fixture','integration','permission','environment']);
// How a journey ended: none (its code ran to its end or to a failed check), deadline (its time limit), action (an
// action, the milestone order or the approved code could not be carried out) or exception (it could not continue).
const stopCauses:ReadonlySet<unknown>=new Set(['none','deadline','action','exception']);

// Missing accounts, fixtures or integrations stay explicit; a malformed list is never partially trusted.
function reportedBlockers(original:ApprovedJourney,value:unknown):Blocker[]|null{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>10)return null;
  const steps:ReadonlySet<unknown>=new Set((original.steps||[]).map(step=>step.id));
  const valid=value.every((item:unknown):item is Blocker=>isRecord(item)&&Object.keys(item).every(key=>['stepId','kind','evidence'].includes(key))&&blockerKinds.has(item.kind)&&typeof item.evidence==='string'&&Boolean(item.evidence.trim())&&(item.stepId===undefined||steps.has(item.stepId)));
  return valid?value.map(({stepId,kind,evidence}:Blocker)=>({...(stepId===undefined?{}:{stepId}),kind,evidence:safeText(evidence.trim(),2000)})):null;
}

// Independent final assertion results count only for exactly the approved assertions, in order, each with the text it
// looked for when its value names {run}.
function finalChecks(original:ApprovedJourney,received:unknown):AssertionResult[]|null{
  const expected=original.assertions||[];
  const matches=Array.isArray(received)&&received.length===expected.length&&expected.every((a,i)=>a.type===received[i]?.type&&a.value===received[i]?.value&&typeof received[i]?.passed==='boolean'&&(a.value.includes(RUN)?resolvedFrom(a.value,received[i].resolved):received[i].resolved===undefined));
  return matches?expected.map(({type,value},i)=>{const {passed,resolved}=(received as {passed:boolean;resolved?:string}[])[i];return {type,value,passed,...(resolved===undefined?{}:{resolved})};}):null;
}

/**
 * The only journey verdict: untrusted worker facts, accepted milestone progress and the approved case
 * snapshot decide status and message, failed before blocked before needs review before passed.
 * A journey runs approved Playwright code, which has no agent: its reviewed checks alone can pass it.
 */
export function journeyResult(approved:ApprovedJourney,reported:unknown,steps:readonly MilestoneState[]=[]):JourneyResult{
  // Untrusted worker facts: only their checked fields count.
  const facts=isRecord(reported)?reported:{};
  if(facts.caseId!==approved.id)throw new Error('Browser runtime returned an unknown case.');
  if(facts.controlRead!==undefined&&typeof facts.controlRead!=='boolean')throw new Error('Browser runtime returned invalid control evidence.');
  if(facts.controlBlocker!==undefined&&(facts.controlRead!==false||!controlBlockerText(facts.controlBlocker)))throw new Error('Browser runtime returned an invalid control limitation.');
  const stop=facts.stopCause;
  if(!stopCauses.has(stop))throw new Error('Browser runtime returned an invalid stop cause.');
  const blockers=reportedBlockers(approved,facts.blockers),checks=finalChecks(approved,facts.assertions);
  const failed=steps.find(step=>step.status==='failed'),blocked=steps.find(step=>step.status==='blocked');
  // Final assertions describe the end state. The journey stopped short of it at a blocked or failed milestone
  // or a reported blocker, or when it ended early before every milestone completed; a case without
  // milestones never shows it finished. An unreached assertion is context, never a failure or a pass.
  const short=Boolean(failed||blocked||blockers?.length)||stop!=='none'&&(!steps.length||steps.some(step=>step.status!=='completed'));
  const assertions=(checks||[]).map((item):AssertionResult=>short?{...item,reached:false}:item);
  function decide():[JourneyVerdict,string|null]{
    if(failed)return ['failed',`Milestone check failed: ${failed.title}.`];
    if(assertions.some(item=>!item.passed&&!short))return ['failed','A final assertion failed.'];
    if(stop==='exception')return ['failed',safeText(facts.error)||'The journey stopped on an error.'];
    if(blocked||blockers?.length){
      // Without a blocked milestone, a blocker was reported.
      const first=blockers?.[0];
      const title=blocked?.title||steps.find(step=>step.id===first?.stepId)?.title;
      return ['blocked',title?`Blocked at milestone: ${title}.`:`Blocked: ${first?.kind} prerequisite unavailable.`];
    }
    if(stop==='deadline')return ['needs_review','Journey exceeded its time limit.'];
    if(stop==='action')return ['needs_review',safeText(facts.error)||'A journey action could not be completed.'];
    if(steps.some(step=>step.status!=='completed'))return ['needs_review','Not every reviewed business milestone has observed completion evidence.'];
    if(!checks||!blockers)return ['needs_review','The final assertions were not evaluated.'];
    return assertions.length||(approved.steps||[]).some(step=>step.checks?.length)?['passed',null]:['needs_review','The journey has no reviewed checks or final assertions.'];
  }
  const [status,error]=decide();
  return {caseId:approved.id,status,engine:'playwright',assertions,...(facts.controlRead===undefined?{}:{controlRead:facts.controlRead as boolean}),...(facts.controlBlocker===undefined?{}:{controlBlocker:facts.controlBlocker as ControlBlocker}),...(blockers?.length?{blockers}:{}),...(error?{error}:{})};
}

const rollUp=['failed','blocked','needs_review','cancelled'] as const;
export const runStatus=(results:readonly {status:string}[]):RunStatus=>rollUp.find(status=>results.some(item=>item.status===status))||(results.some(item=>item.status==='skipped')?'completed':'passed');
