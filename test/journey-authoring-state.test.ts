import test from 'node:test';
import assert from 'node:assert/strict';
import { retainAuthoring, restoreAuthoring, restoreAuthoringRecord } from '../src/browser/authoring.ts';
import { hide } from '../src/redaction.ts';
import type { AuthoringRecord } from '../contract/authoring.ts';

const now=Date.now(),when=new Date(now).toISOString();
const record:AuthoringRecord={id:'11111111-1111-1111-1111-111111111111',startedAt:when,completedAt:when,durationMs:0,caseHash:'a'.repeat(64),outcome:'draft',outputHash:'b'.repeat(64),cleanup:'complete',provenance:{harness:'opencode@1.18.32',generator:'playwright-test-generator@1.63.0',model:'openrouter/example/model'},attempts:[{phase:'generation',startedAt:when,completedAt:when,durationMs:0,outcome:'completed',outputHash:'c'.repeat(64),codeHash:'b'.repeat(64),outputBytes:20,eventsTruncated:false,events:[{tool:'browser_click',outcome:'completed'}],reportedFinishReason:'unknown',usage:null}]};

test('a tool failure category survives restart while arbitrary stored diagnostic text is discarded',()=>{
  const saved={...record,attempts:[{...record.attempts[0],lastToolError:{tool:'browser_handle_dialog',kind:'no-native-dialog',error:'private page contents'}}]};
  const restored=restoreAuthoringRecord(saved,hide([]));
  assert.deepEqual(restored.attempts[0].lastToolError,{tool:'browser_handle_dialog',kind:'no-native-dialog'});
  assert.ok(!JSON.stringify(restored).includes('private page'));
  const unknown=restoreAuthoringRecord({...record,attempts:[{...record.attempts[0],lastToolError:{tool:'private-tool',kind:'private-account'}}]},hide([]));
  assert.deepEqual(unknown.attempts[0].lastToolError,{tool:'unknown',kind:'unknown'});
  assert.equal(restoreAuthoringRecord(record,hide([])).attempts[0].lastToolError,undefined,'Existing records remain valid.');
});

test('a reported blocker survives restart with no arbitrary text and older records remain valid',()=>{
  const saved={...record,attempts:[{...record.attempts[0],reportedFinishReason:'stop',reportedBlocker:{milestone:2,kind:'request-unobserved',detail:'private page'}}]};
  const restored=restoreAuthoringRecord(saved,hide([]));
  assert.deepEqual(restored.attempts[0].reportedBlocker,{milestone:2,kind:'request-unobserved'});
  assert.ok(!JSON.stringify(restored).includes('private page'));
  assert.equal(restoreAuthoringRecord(record,hide([])).attempts[0].reportedBlocker,undefined);
  for(const report of [null,{milestone:13,kind:'unknown'},{milestone:2,kind:'private page'}])assert.throws(()=>restoreAuthoringRecord({...record,attempts:[{...record.attempts[0],reportedBlocker:report}]},hide([])),/Unsupported journey authoring state/);
  for(const terminal of [{outcome:'failed'},{reportedFinishReason:'unknown'}])assert.throws(()=>restoreAuthoringRecord({...saved,attempts:[{...saved.attempts[0],...terminal}]},hide([])),/Unsupported journey authoring state/);
});

test('fixed authoring fields are matched before an ordinary-word account value is hidden',()=>{
  const saved={...record,attempts:[{...record.attempts[0],lastToolError:{tool:'browser_click',kind:'timeout'},reportedFinishReason:'stop',reportedBlocker:{milestone:2,kind:'request-unobserved'}}]};
  const restored=restoreAuthoringRecord(saved,hide(['test','browser_click','timeout','stop','request-unobserved','opencode','1.63.0']));
  assert.deepEqual(restored.provenance,record.provenance);
  assert.deepEqual(restored.attempts[0].events,[{tool:'browser_click',outcome:'completed'}]);
  assert.deepEqual(restored.attempts[0].lastToolError,{tool:'browser_click',kind:'timeout'});
  assert.equal(restored.attempts[0].reportedFinishReason,'stop');
  assert.deepEqual(restored.attempts[0].reportedBlocker,{milestone:2,kind:'request-unobserved'});
  // The model is a free identifier: an account value in it is still hidden, which leaves it unknown.
  assert.equal(restoreAuthoringRecord(saved,hide(['example'])).provenance.model,'unknown');
});

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
