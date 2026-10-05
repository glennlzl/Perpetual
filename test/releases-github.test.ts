import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { createReleaseGitHub } from '../src/releases/github.ts';
import type { ReleaseRequest } from '../src/releases/manager.ts';
import type { GitHubRun } from '../src/github-cli.ts';

const SHA='a'.repeat(40),DEFAULT='b'.repeat(40),BLOB='c'.repeat(40);
const deployment={id:12,sha:SHA,environment:'production',production_environment:true,task:'deploy',payload:{perpetual:{releaseId:'release-1',workflowPath:'.github/workflows/deploy.yml',sha:SHA}}};
const input:ReleaseRequest={id:'release-1',source:{key:'acme',repository:'acme/app',branch:'main',sha:SHA,login:'owner'},target:{environment:'production',productionEnvironment:true,workflowPath:'.github/workflows/deploy.yml'},gates:[{id:'gate-1',stageId:'beta',sha:SHA,context:'perpetual/Beta',status:'passed',updatedAt:'2026-01-01T00:00:00Z'}],workflow:{defaultBranch:'main',defaultSha:DEFAULT,workflowSha:BLOB,defaultWorkflowSha:BLOB}};
const reply=(data:unknown,status=200)=>({stdout:`HTTP/2.0 ${status} OK\n\n${JSON.stringify(data)}`});
const content=(text:string)=>({type:'file',encoding:'base64',sha:BLOB,content:Buffer.from(text).toString('base64')});
const yaml='on: deployment\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deployment-handler\n';

const modulePath='../src/releases/github.ts';
test('the deployment adapter verifies real workflow files before accepting a target',async()=>{
  const module=await import(modulePath).catch(()=>null);
  assert.equal(typeof module?.createReleaseGitHub,'function','The deployment adapter is not implemented.');
  const sha='a'.repeat(40),blob='b'.repeat(40),calls:string[][]=[];
  const adapter=module.createReleaseGitHub({run:async(_file:string,args:string[])=>{
    calls.push(args);const endpoint=args.at(-1)!;
    const data=endpoint==='repos/acme/app'?{default_branch:'main'}:endpoint.includes('/branches/')?{commit:{sha}}:{type:'file',encoding:'base64',sha:blob,content:Buffer.from('on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deployed\n').toString('base64')};
    return {stdout:`HTTP/2.0 200 OK\n\n${JSON.stringify(data)}`};
  }});
  await assert.rejects(adapter.verifyTarget({key:'acme',repository:'acme/app',branch:'main',sha,login:'owner'},{environment:'production',productionEnvironment:true,workflowPath:'.github/workflows/deploy.yml'}),/deployment event/);
  assert.ok(calls.length>=3);
  assert.ok(calls.every(args=>!args.includes('POST')));
});

test('handler evidence checks both the exact requested commit and the resolved default branch commit',async()=>{
  const seen:string[]=[];
  const run:GitHubRun=async(_file,args)=>{const endpoint=args.at(-1)!;seen.push(endpoint);
    return reply(endpoint==='repos/acme/app'?{default_branch:'main'}:endpoint.includes('/branches/')?{commit:{sha:DEFAULT}}:content(yaml));};
  const proof=await createReleaseGitHub({run}).verifyTarget(input.source,input.target);
  assert.equal(proof.defaultSha,DEFAULT);assert.equal(proof.workflowSha,BLOB);
  assert.ok(seen.includes(`repos/acme/app/contents/.github/workflows/deploy.yml?ref=${SHA}`));
  assert.ok(seen.includes(`repos/acme/app/contents/.github/workflows/deploy.yml?ref=${DEFAULT}`));
});

test('a handler missing from the default branch cannot become configured from an unmerged file',async()=>{
  const run:GitHubRun=async(_file,args)=>{const endpoint=args.at(-1)!;
    return reply(endpoint==='repos/acme/app'?{default_branch:'main'}:endpoint.includes('/branches/')?{commit:{sha:DEFAULT}}:content(endpoint.endsWith(DEFAULT)?yaml.replace('on: deployment','on: push'):yaml));};
  await assert.rejects(createReleaseGitHub({run}).verifyTarget(input.source,input.target),/deployment event/);
});

test('the example handler passes target verification, and its job environment creates no deployment of its own',async()=>{
  const example=await readFile(new URL('../docs/examples/github-deployment.yml.example',import.meta.url),'utf8');
  const run:GitHubRun=async(_file,args)=>{const endpoint=args.at(-1)!;
    return reply(endpoint==='repos/acme/app'?{default_branch:'main'}:endpoint.includes('/branches/')?{commit:{sha:DEFAULT}}:content(example));};
  await createReleaseGitHub({run}).verifyTarget(input.source,{environment:'preview',productionEnvironment:false,workflowPath:'.github/workflows/deploy.yml'});
  // A job deployment's success would mark the requested non-production deployment inactive.
  const jobs=Object.values((parse(example) as {jobs:Record<string,{environment?:unknown}>}).jobs);
  assert.ok(jobs.length>0);
  for(const job of jobs)assert.ok(job.environment===undefined||(job.environment as {deployment?:unknown}).deployment===false,JSON.stringify(job.environment));
});

test('deployment transport pins SHA, disables merging, requires gate contexts and embeds request identity',async()=>{
  let writes=0;
  const run:GitHubRun=async(_file,args)=>{
    writes++;assert.equal(args[args.indexOf('--method')+1],'POST');assert.equal(args.at(-1),'repos/acme/app/deployments');
    assert.ok(args.includes(`ref=${SHA}`));assert.ok(args.includes('auto_merge=false'));assert.ok(args.includes('required_contexts[]=perpetual/Beta'));
    assert.ok(args.includes('payload[perpetual][releaseId]=release-1'));
    assert.ok(args.includes('payload[perpetual][workflowPath]=.github/workflows/deploy.yml'));
    assert.ok(args.includes(`payload[perpetual][sha]=${SHA}`));assert.ok(args.includes('payload[perpetual][gateIds][]=gate-1'));
    assert.equal(args.some(value=>value.startsWith('payload=')),false,'The event handler needs a structured payload, not a JSON string.');
    return reply(deployment,201);
  };
  const github=createReleaseGitHub({run});assert.deepEqual(await github.create(input),{deploymentId:'12',status:'queued'});assert.equal(writes,1);
  await assert.rejects(github.create({...input,gates:[]}),/gate evidence/);assert.equal(writes,1);
});

test('a deployment receipt for a different commit is not accepted',async()=>{
  const github=createReleaseGitHub({run:async()=>reply({...deployment,sha:DEFAULT},201)});
  await assert.rejects(github.create(input),/different request/);
});

test('reconciliation observes only the matching deployment and real status, discarding unsafe URLs',async()=>{
  const seen:string[]=[];
  const github=createReleaseGitHub({run:async(_file,args)=>{const endpoint=args.at(-1)!;seen.push(endpoint);
    return reply(endpoint.includes('/statuses')?[{id:51,state:'success',environment_url:'https://user:pass@example.test/',log_url:'javascript:alert(1)'}]:endpoint.includes('?sha=')?[{...deployment,id:11,payload:{}},deployment]:deployment);
  }});
  assert.deepEqual(await github.read(input),{deploymentId:'12',status:'deployed',statusId:'51'});
  assert.ok(seen.some(endpoint=>endpoint.includes('/deployments/12/statuses')));
  assert.equal(seen.some(endpoint=>endpoint.includes('/deployments/11/statuses')),false);
});

test('known deployment identity cannot silently switch to another deployment ID',async()=>{
  const github=createReleaseGitHub({run:async()=>reply({...deployment,id:13})});
  await assert.rejects(github.read({...input,deploymentId:'12'}),/does not match/);
});

test('lost POST replies remain uncertain while explicit GitHub refusals are definitive',async()=>{
  for(const [error,definitive]of [[{killed:true,stderr:'request timed out'},false],[{stderr:'HTTP 403: Resource not accessible'},true],[{stderr:'HTTP 503: Unavailable'},false]] as const){
    const github=createReleaseGitHub({run:async()=>{throw error;}});
    await assert.rejects(github.create(input),(caught:unknown)=>Boolean(caught&&typeof caught==='object'&&'definitive'in caught&&caught.definitive===definitive));
  }
});

test('the adapter exposes a fresh commit preflight rather than relying on cached gate success',()=>{
  assert.equal(typeof Reflect.get(createReleaseGitHub(),'verifyCommit'),'function');
});

test('fresh branch and Build preflight rejects pending, failed or changed heads without any mutation',async()=>{
  for(const scenario of ['passed','pending','failed','changed','changes-after-build'] as const){
    let heads=0;const run:GitHubRun=async(_file,args)=>{
      assert.equal(args[args.indexOf('--method')+1],'GET');const endpoint=args.at(-1)!;
      if(endpoint.includes('/branches/')){heads++;return reply({commit:{sha:scenario==='changed'||scenario==='changes-after-build'&&heads>1?DEFAULT:SHA}});}
      assert.ok(endpoint.includes('/actions/runs?'));
      return reply({total_count:1,workflow_runs:[{id:7,workflow_id:3,path:'.github/workflows/ci.yml',head_sha:SHA,head_branch:'main',event:'push',status:scenario==='pending'?'in_progress':'completed',conclusion:scenario==='failed'?'failure':'success'}]});
    };
    const github=createReleaseGitHub({run,session:async()=>({available:true,authenticated:true,account:{login:'owner',name:null}})});
    if(scenario==='passed'){await github.verifyCommit(input.source);assert.equal(heads,2);}
    else await assert.rejects(github.verifyCommit(input.source),/Build|branch head/);
  }
});
