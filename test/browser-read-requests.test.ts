import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedRead, validateReadRequests, readPolicyHash, blockedRequest } from '../src/browser/read-requests.ts';

const body='{"query":"query Workspace { workspace { title } }","variables":{}}';
const rule={url:'https://app.example.test/graphql',body}, headers={'Content-Type':'application/json; charset=utf-8'};

test('a reviewed read admits only its complete request, not other operations at a shared endpoint', () => {
  const rules=validateReadRequests([rule],'https://app.example.test/');
  assert.equal(reviewedRead(rules,'POST',rule.url,body,headers),true);
  for(const [method,url,data,head] of [
    ['PUT',rule.url,body,headers],['POST',rule.url+'?operation=write',body,headers],['POST',rule.url+'/write',body,headers],
    ['POST','https://elsewhere.example.test/graphql',body,headers],['POST',rule.url,'{"query":"mutation { deleteWorkspace }"}',headers],
    ['POST',rule.url,'['+body+']',headers],['POST',rule.url,body,{'content-type':'text/plain'}],
    ['POST',rule.url,body,{'content-type':'application/json; charset=iso-8859-1'}],['POST',rule.url,body,{...headers,'X-HTTP-Method-Override':'DELETE'}],
    ['POST',rule.url,undefined,headers],
  ] as const) assert.equal(reviewedRead(rules,method,url,data,head),false);
});

test('read policy identity ignores rule order and changes when request bytes change', () => {
  const second={url:'https://app.example.test/rpc',body:'{}'};
  assert.equal(readPolicyHash([]),'');
  assert.equal(readPolicyHash([rule,second]),readPolicyHash([second,rule]));
  assert.notEqual(readPolicyHash([rule]),readPolicyHash([{...rule,body:body+' '}])) ;
  assert.equal(readPolicyHash([rule], 'app'),readPolicyHash([{...rule,url:'https://rebuilt.example.test/graphql'}], 'app'));
  assert.notEqual(readPolicyHash([rule], 'app'),readPolicyHash([rule], 'different-app'));
  assert.notEqual(readPolicyHash([rule], 'app'),readPolicyHash([rule]));
});

test('blocked request evidence excludes credentials, query values, path parameters and bodies', () => {
  assert.deepEqual(blockedRequest('POST','https://user:password@app.example.test/rpc;session=private?token=private#private'),{method:'POST',url:'https://app.example.test/rpc'});
  assert.equal(blockedRequest('POST','https://app.example.test/'+('a'.repeat(900)))?.url.length,512);
  assert.equal(blockedRequest('nonsense','https://app.example.test/rpc'),null);
  assert.equal(blockedRequest('POST',{},),null);
});


test('durable read rules reject short and escaped duplicate credential members', () => {
  for (const body of ['{"password":"short"}', '{"\\u0070assword":"private-value","password":"{{ref}}"}', '{"variables":{"api_key":"x"}}']) {
    assert.throws(() => validateReadRequests([{...rule,body}], 'https://app.example.test/'), /secrets|credentials/);
  }
});


test('encoded credentials cannot enter read URLs or blocked request evidence', () => {
  for (const path of ['/sk%2Dabcdefghijklmnop','/token%3Dprivate-value','/%ZZ/sk%2Dabcdefghijklmnop']) {
    assert.throws(() => validateReadRequests([{...rule,url:'https://app.example.test'+path}], 'https://app.example.test/'), /secrets|credentials/);
    assert.ok(!blockedRequest('POST','https://app.example.test'+path)?.url.includes('private-value'));
    assert.ok(!blockedRequest('POST','https://app.example.test'+path)?.url.includes('abcdefghijklmnop'));
  }
});
