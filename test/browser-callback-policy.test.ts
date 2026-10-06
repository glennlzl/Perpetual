import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCallbackBindings, callbackPolicyHash, callbackApplication, resolveCallbackOrigins} from '../src/browser/callbacks.ts';
import type {CallbackResolutionInput} from '../src/browser/callbacks.ts';
const context={key:'acme/app',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317'};
const bindings=[{applicationId:'web',hostname:'localhost' as const}];
function published(port=41000,id='twin-a'):CallbackResolutionInput {
 const url=`http://127.0.0.1:${port}/`;
 return {context,targetUrl:url,target:{environmentId:id,url,applicationId:'web'},environment:{id,sandboxId:id,status:'ready',pipelineKey:context.key,stageId:context.stageId,apps:[{id:'web',url}]}};
}
test('reviewed aliases follow only the selected owned application across ports',()=>{
 assert.deepEqual(resolveCallbackOrigins(bindings,published()),['http://localhost:41000']);
 assert.deepEqual(resolveCallbackOrigins(bindings,published(41001,'twin-b')),['http://localhost:41001']);
 const two=[...bindings,{applicationId:'web',hostname:'127.0.0.1' as const}];
 assert.deepEqual(resolveCallbackOrigins(two,published()),['http://localhost:41000','http://127.0.0.1:41000']);
 assert.equal(callbackPolicyHash('scope',two),callbackPolicyHash('scope',[...two].reverse()));
 assert.notEqual(callbackPolicyHash('scope',bindings),callbackPolicyHash('other-scope',bindings));
 assert.notEqual(callbackPolicyHash('scope',bindings),callbackPolicyHash('scope',two.slice(1)));
 assert.equal(callbackPolicyHash('scope',undefined),'');
 assert.equal(callbackPolicyHash('scope',[]),'');
 const named=published(); named.target!.applicationId='constructor'; named.environment!.apps=[{id:'constructor',url:named.targetUrl}];
 assert.deepEqual(resolveCallbackOrigins([{applicationId:'constructor',hostname:'localhost'}],named),['http://localhost:41000']);
});
test('missing ownership and ambiguous or changed application identity grant no callbacks',()=>{
 const input=published();
 for(const patch of [{pipelineKey:'other'},{pipelineKey:undefined},{stageId:'gamma'},{stageId:undefined},{sandboxId:'other'},{sandboxId:undefined},{status:'destroyed'},
 {apps:[{id:'other',url:input.targetUrl}]},{apps:[{id:'web',url:input.targetUrl},{id:'web',url:'http://127.0.0.1:41002/'}]},
 {apps:[{id:'web',url:input.targetUrl},{id:'api',url:input.targetUrl}]}]){
  const candidate={...input,environment:{...input.environment!,...patch}};
  assert.equal(callbackApplication(candidate),null);assert.throws(()=>resolveCallbackOrigins(bindings,candidate),/Choose a ready managed application/);
 }
 for(const candidate of [{...input,target:undefined},{...input,target:{...input.target!,environmentId:'other'}},{...input,targetUrl:'http://127.0.0.1:41002/'},{...input,environment:null}]){
  assert.equal(callbackApplication(candidate),null);assert.throws(()=>resolveCallbackOrigins(bindings,candidate));
 }
 assert.throws(()=>resolveCallbackOrigins([{applicationId:'other',hostname:'localhost'}],input));
 assert.deepEqual(resolveCallbackOrigins([],{...input,environment:null}),[]);
});
test('remote, default-port and controller application origins are ineligible',()=>{
 for(const url of ['https://127.0.0.1:41000/','http://example.test:41000/','http://127.0.0.1/','http://localhost:4317/','http://127.0.0.1:4317/']){
  const input=published();input.targetUrl=url;input.target!.url=url;input.environment!.apps=[{id:'web',url}];assert.equal(callbackApplication(input),null);
 }
});
test('untrusted bindings reject extra authority and count separately from fixed origins',()=>{
 assert.deepEqual(validateCallbackBindings(undefined),[]);
 for(const value of [null,{},[42],[{...bindings[0],port:41000}],[{...bindings[0],hostname:'*.localhost'}],[{...bindings[0],hostname:'host.docker.internal'}],[{...bindings[0],pipelineKey:'other'}],[bindings[0],bindings[0]],[{applicationId:'',hostname:'localhost'}],[{applicationId:'x'.repeat(1025),hostname:'localhost'}]]) assert.throws(()=>validateCallbackBindings(value));
 assert.throws(()=>validateCallbackBindings(bindings,10));assert.deepEqual(validateCallbackBindings(bindings,9),bindings);
});
test('callback hosts must be exact strings and cannot create duplicate origins through coercion',()=>{
 for(const hostname of [['localhost'],[['localhost']],['127.0.0.1'],null,42,{}]){
  assert.throws(()=>validateCallbackBindings([{applicationId:'web',hostname}]),/supported callback host/);
 }
 assert.throws(()=>validateCallbackBindings([...bindings,{applicationId:'web',hostname:['localhost']}]),/supported callback host/);
});
