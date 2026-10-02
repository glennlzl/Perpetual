import test from 'node:test';
import assert from 'node:assert/strict';
import { retainAuthoring, restoreAuthoring, restoreAuthoringRecord } from '../src/browser/authoring.ts';
import { hide } from '../src/redaction.ts';
import type { AuthoringRecord } from '../contract/authoring.ts';

const now=Date.now(),when=new Date(now).toISOString();
const record:AuthoringRecord={id:'11111111-1111-1111-1111-111111111111',startedAt:when,completedAt:when,durationMs:0,caseHash:'a'.repeat(64),outcome:'draft',outputHash:'b'.repeat(64),cleanup:'complete',provenance:{harness:'opencode@1.18.32',generator:'playwright-test-generator@1.63.0',model:'openrouter/example/model'},attempts:[{phase:'generation',startedAt:when,completedAt:when,durationMs:0,outcome:'completed',outputHash:'c'.repeat(64),codeHash:'b'.repeat(64),outputBytes:20,eventsTruncated:false,events:[{tool:'browser_click',outcome:'completed'}],reportedFinishReason:'unknown',usage:null}]};

test('authoring retention bounds all sources together and removes deleted cases',()=>{
  const cases=Object.fromEntries(Array.from({length:110},(_,i)=>[`source-${i}`,[{id:'journey'}]]));
  const history=Object.fromEntries(Object.keys(cases).map((scope,i)=>[scope,{journey:[{...record,completedAt:new Date(now-i*1000).toISOString()}]}]));
  const kept=retainAuthoring(history,cases,now);
  assert.equal(Object.keys(kept).length,100);assert.ok(kept['source-0']);assert.equal(kept['source-109'],undefined);
  assert.deepEqual(Object.keys(retainAuthoring(history,{},now)),[]);
});

test('saved authoring is validated from unknown objects and no untrusted fields enter a reply',()=>{
  const unsafe={...record,provenance:{...record.provenance,model:'openrouter/example/https://account.invalid/private'},payload:'private request',attempts:[{...record.attempts[0],events:[{tool:'private-account',outcome:'completed',input:'private payload'}],reportedFinishReason:'private terminal prose',usage:{input:Infinity}}]};
  const restored=restoreAuthoringRecord(unsafe,hide([]));
  assert.equal(restored.provenance.model,'unknown');assert.equal(restored.attempts[0].reportedFinishReason,'unknown');assert.equal(restored.attempts[0].usage,null);
  assert.deepEqual(restored.attempts[0].events,[{tool:'unknown',outcome:'completed'}]);
  assert.ok(!JSON.stringify(restored).includes('private'));
  for(const invalid of [null,{}, {...record,durationMs:-1},{...record,completedAt:'garbage'},{...record,attempts:[...record.attempts,...record.attempts,...record.attempts]}, {...record,attempts:[{...record.attempts[0],events:Array(65).fill({tool:'browser_click',outcome:'completed'})}]}])assert.throws(()=>restoreAuthoringRecord(invalid,hide([])),/Unsupported journey authoring state/);
  assert.throws(()=>restoreAuthoring({scope:{journey:{}}},{scope:[{id:'journey'}]},hide([])),/Unsupported journey authoring state/);
});
