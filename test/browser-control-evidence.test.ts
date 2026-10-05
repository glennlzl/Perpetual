import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBlocks } from '../src/browser/control-evidence.ts';

test('control diagnostics hide full credentials before path parameters are discarded',()=>{
  for(const secret of ['private;tail','private%21','private%2521','private-sk-1234567890!tail'])for(const value of [secret,encodeURIComponent(secret),encodeURIComponent(encodeURIComponent(secret))]){
    const result=controlBlocks([{kind:'http',method:'POST',url:`https://app.test/${value}?token=private#private`,afterRead:true}],[secret]);
    assert.deepEqual(result,[{kind:'http',method:'POST',url:'https://app.test/[REDACTED]',afterRead:true}]);
    assert.deepEqual(controlBlocks(result),result,'Already concealed diagnostics survive every downstream boundary.');
  }
});

test('concealed origins and methods retain an idempotent fixed redaction marker',()=>{
  for(const secret of ['https','app','POST']){
    const result=controlBlocks([{kind:'http',method:'POST',url:'https://app.test/read',afterRead:true}],[secret]);
    assert.ok(result?.length);assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(controlBlocks(result),result);
  }
});

test('every bounded blocked HTTP token can be diagnosed without allowing safe-read methods',()=>{
  for(const method of ['PROPFIND','REPORT','X-CUSTOM','custom'])assert.deepEqual(controlBlocks([{kind:'http',method,url:'https://app.test/read',afterRead:true}]),[{kind:'http',method,url:'https://app.test/read',afterRead:true}]);
  for(const method of ['GET','HEAD','OPTIONS','bad method','x'.repeat(33)])assert.equal(controlBlocks([{kind:'http',method,url:'https://app.test/read',afterRead:true}]),null);
});

test('unresolved nested URI encodings stay opaque across secret-free revalidation',()=>{
  for(const secret of ['private;tail','private%21'])for(const depth of [5,9,16]){
    let value=secret;for(let i=0;i<depth;i++)value=encodeURIComponent(value);
    const result=controlBlocks([{kind:'http',method:'POST',url:`https://app.test/${value}`,afterRead:true}],[secret]);
    assert.deepEqual(result,[{kind:'http',method:'POST',url:'[REDACTED]',afterRead:true}]);
    assert.deepEqual(controlBlocks(result),result);
  }
  const result=controlBlocks([{kind:'http',method:'X-%74%65%73%74',url:'https://app.example/read',afterRead:true}],['test']);
  assert.deepEqual(result,[{kind:'http',method:'[REDACTED]',url:'https://app.example/read',afterRead:true}]);
  assert.deepEqual(controlBlocks(result),result);
});
