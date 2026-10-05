import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRemote, normalizeGitHubRuns, diagnoseFailure, redact, getProviderStatus } from '../src/providers.ts';
import { getGitHubFailure, type CommandRunner } from '../src/repair/github.ts';
test('GitHub remote parser rejects non-GitHub and user-supplied command material',()=>{
  assert.equal(parseGitHubRemote('git@github.com:acme/storefront.git'),'acme/storefront');
  assert.equal(parseGitHubRemote('https://github.com/acme/storefront.git'),'acme/storefront');
  assert.equal(parseGitHubRemote('https://evil.com/acme/storefront'),null);
  assert.equal(parseGitHubRemote('$(cat ~/.env)'),null);
});
test('old successful SHA and skipped run never count as current commit success',()=>{
  const runs=normalizeGitHubRuns([{id:1,head_sha:'old',conclusion:'success',status:'completed'},{id:2,head_sha:'new',conclusion:'skipped',status:'completed'}],'new');
  assert.equal(runs[0].matchesCommit,false); assert.equal(runs[1].conclusion,'skipped');
});
test('missing credentials are classified as configuration, not a code failure',()=>{
  assert.equal(diagnoseFailure('Error: VERCEL_TOKEN is required').category,'configuration');
  assert.equal(diagnoseFailure('ERR_PNPM_OUTDATED_LOCKFILE').category,'dependency');
});
test('a failed assertion about a 401 or 403 is the application\'s code, not the run\'s credentials',()=>{
  for(const log of ["AssertionError: expected '401 Unauthorized' to equal '200 OK'",'FAIL src/auth.test.ts > signs in\n    Expected: "403 Forbidden"\n    Received: "200 OK"'])
    assert.equal(diagnoseFailure(log).category,'test-regression',log);
  assert.equal(diagnoseFailure('Error: HTTP 401').category,'configuration','A client refused outside an assertion still needs credentials.');
  assert.equal(diagnoseFailure("AssertionError: expected 3 to equal 4\nremote: Permission to acme/app.git denied to github-actions[bot].").category,'configuration');
});
// node:test's report of assert.equal(statusText, expected) failing, as its spec and TAP reporters print it.
const spec=(actual: string,expected: string)=>['✖ signs in (0.7ms)','  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:','  + actual - expected','',`  + '${actual}'`,`  - '${expected}'`,'',
  '      at TestContext.<anonymous> (file:///home/runner/work/app/app/test/auth.test.ts:3:62) {','    generatedMessage: true,',"    code: 'ERR_ASSERTION',",`    actual: '${actual}',`,`    expected: '${expected}',`,"    operator: 'strictEqual',","    diff: 'simple'",'  }'];
const tap=(actual: string,expected: string)=>['not ok 1 - signs in','  ---',"  failureType: 'testCodeFailure'",'  error: |-','    Expected values to be strictly equal:','    + actual - expected','',`    + '${actual}'`,`    - '${expected}'`,'',
  "  code: 'ERR_ASSERTION'","  name: 'AssertionError'",`  expected: '${expected}'`,`  actual: '${actual}'`,"  operator: 'strictEqual'",'  ...'];
test('node:test\'s failed assertion about a 401 or 403, as either reporter prints it, is the application\'s code',async()=>{
  for(const report of [spec,tap])for(const [actual,expected] of [['200 OK','401 Unauthorized'],['403 Forbidden','200 OK']]){
    // The failed-step log as gh prints it, read through the repair's own reader, which keeps only error lines.
    const log=report(actual,expected).map(line=>`test\tTest\t2026-09-25T10:14:01.0000000Z ${line}`).join('\n');
    const run: CommandRunner=async(_file,args)=>({stdout:args[0]==='run'?log:'{"jobs":[]}'});
    assert.equal((await getGitHubFailure({repository:'acme/app',runId:'1'},{run})).diagnosis.category,'test-regression',`${report.name}: expected ${expected}, got ${actual}`);
  }
  for(const log of ["  expected: 'HTTP 403'","Expected substring: \"401 Unauthorized\"","Received message:   \"403 Forbidden\""])
    assert.equal(diagnoseFailure(`AssertionError [ERR_ASSERTION]: failed\n${log}`).category,'test-regression',log);
});
test('redacts common credential strings before persistence',()=>{
  const input='Authorization: Bearer abc123\nAPI_KEY=abcdef\nhttps://u:pass@example.com';
  const result=redact(input);assert.ok(!result.includes('abc123'));assert.ok(!result.includes('abcdef'));assert.ok(!result.includes('u:pass'));
});
test('redaction handles long ordinary source without corrupting it',()=>{
  const source='a'.repeat(220000);assert.equal(redact(source),source);
});
test('a provider reply of another shape is not connected, and each run field is text or nothing',async t=>{
  const env={VERCEL_TOKEN:'v',VERCEL_PROJECT_ID:'p',RAILWAY_API_TOKEN:'r',RAILWAY_PROJECT_ID:'p',RAILWAY_ENVIRONMENT_ID:'e'};
  const status=async(vercel:unknown,railway:unknown)=>{
    t.mock.method(globalThis,'fetch',async(url:string)=>new Response(JSON.stringify(new URL(url).hostname==='api.vercel.com'?vercel:railway)));
    const [,v,r]=await getProviderStatus({repo:{name:'app',path:'/repo',branch:'main',sha:'abc',remote:null}},env);
    t.mock.restoreAll();
    return [v,r];
  };
  for(const [vercel,railway] of [[{deployments:'READY'},{data:{deployments:{edges:'x'}}}],[{deployments:{}},{errors:'boom'}],[{deployments:[null]},{data:{deployments:{edges:[{node:null}]}}}],[7,'x']])
    assert.deepEqual((await status(vercel,railway)).map(item=>item.status),['not-connected','not-connected'],JSON.stringify([vercel,railway]));
  const [v,r]=await status({deployments:[{uid:'d1',name:'web',state:{x:1},url:'web.vercel.app',meta:{githubCommitSha:'abc'}}]},{data:{deployments:{edges:[{node:{id:'x',status:{nested:true},createdAt:'2026-09-25T00:00:00Z',meta:null}}]}}});
  assert.deepEqual([v.status,v.runs],['connected',[{id:'d1',name:'web',status:null,conclusion:null,sha:'abc',url:'https://web.vercel.app',matchesCommit:true}]]);
  assert.deepEqual([r.status,r.runs],['connected',[{id:'x',name:'Railway deployment',status:null,conclusion:null,sha:null,createdAt:'2026-09-25T00:00:00Z',matchesCommit:false}]]);
  // GitHub's workflow runs are a list of runs.
  for(const runs of ['abc',[1,'x'],{id:1}])assert.throws(()=>normalizeGitHubRuns(runs,'new'),/unreadable/,JSON.stringify(runs));
  assert.deepEqual(normalizeGitHubRuns([{id:3,name:{},head_sha:'new',status:'completed',conclusion:'success'}],'new'),[{id:'3',name:null,status:'completed',conclusion:'success',sha:'new',url:null,branch:null,createdAt:null,matchesCommit:true}]);
});
test('redacts JSON credential fields and Basic authorization payloads',()=>{
  const result=redact('{"API_KEY":"sensitive-value"}\nAuthorization: Basic abcDEF123==');
  assert.ok(!result.includes('sensitive-value'));assert.ok(!result.includes('abcDEF123'));
});
