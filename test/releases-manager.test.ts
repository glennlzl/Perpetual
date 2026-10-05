import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseGitHub } from '../src/releases/github.ts';
import { createReleaseManager, type ReleaseEvidence, type ReleaseGitHub, type ReleaseRequest } from '../src/releases/manager.ts';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const target={environment:'production',productionEnvironment:true,workflowPath:'.github/workflows/deploy.yml'};
const workflow={defaultBranch:'main',defaultSha:SHA,workflowSha:OTHER,defaultWorkflowSha:OTHER};
const evidence=():ReleaseEvidence=>({source:{key:'github:acme/app:/',repository:'acme/app',branch:'main',sha:SHA,login:'owner'},ready:true,gates:[{id:'gate-1',stageId:'beta',sha:SHA,context:'perpetual/Beta',status:'passed',updatedAt:'2026-01-01T00:00:00Z'}]});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {resolve,promise};};
async function fixture(t:test.TestContext,overrides:Partial<ReleaseGitHub>={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-release-'));let current=evidence();const requests:ReleaseRequest[]=[];
  const github:ReleaseGitHub={verifyTarget:async()=>workflow,verifyCommit:async()=>{},create:async request=>{requests.push(request);return {deploymentId:'12',status:'queued'};},read:async()=>({deploymentId:'12',status:'deployed',statusId:'99',url:'https://app.example.test/'}),...overrides};
  const options={dataDir,getEvidence:()=>structuredClone(current),github};const manager=await createReleaseManager(options);
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  return {manager,options,dataDir,requests,setEvidence:(value:ReleaseEvidence)=>{current=value;}};
}

const modulePath = '../src/releases/manager.ts';
test('manual releases have a durable manager; no deployment starts just by opening it', async t => {
  const module = await import(modulePath).catch(() => null);
  assert.equal(typeof module?.createReleaseManager, 'function', 'The release manager is not implemented.');
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-release-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let writes = 0;
  const manager = await module.createReleaseManager({dataDir,getEvidence:()=>({source:null,ready:false,gates:[]}),github:{create(){writes++;throw new Error('must not dispatch');}}});
  t.after(()=>manager.close());
  const view = await manager.view();
  assert.equal(view.canDeploy, false);
  assert.equal(view.target, null);
  assert.equal(writes, 0);
  assert.equal((await stat(join(dataDir,'releases'))).mode & 0o777, 0o700);
  await assert.rejects(manager.deploy({sha:'a'.repeat(40)}),/GitHub|source/);
  assert.equal(writes,0);
  assert.equal(await readFile(join(dataDir,'releases','state.json'),'utf8').then(()=>true,()=>false),false);
});

test('deployment requires a configured target, the selected SHA and nonempty exact-commit gates',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/Configure/);
  await f.manager.configure(target);
  await assert.rejects(f.manager.deploy({sha:OTHER,target}),/commit changed/);
  f.setEvidence({...evidence(),gates:[]});await assert.rejects(f.manager.deploy({sha:SHA,target}),/evidence/);
  f.setEvidence({...evidence(),gates:[{...evidence().gates[0],sha:OTHER}]});await assert.rejects(f.manager.deploy({sha:SHA,target}),/evidence/);
  f.setEvidence({...evidence(),ready:false,reason:'Beta is running.'});await assert.rejects(f.manager.deploy({sha:SHA,target}),/Beta is running/);
  assert.equal(f.requests.length,0);
});

test('manual deployment persists its identity before dispatch and waits for actual provider status',async t=>{
  const f=await fixture(t,{create:async request=>{
    const disk=JSON.parse(await readFile(join(f.dataDir,'releases','state.json'),'utf8'));
    assert.equal(disk.releases[0].record.status,'requesting');assert.equal(disk.releases[0].id,request.id);
    assert.equal(request.source.sha,SHA);assert.equal(request.gates[0].context,'perpetual/Beta');
    return {deploymentId:'12',status:'queued'};
  }});
  await f.manager.configure(target);const submitted=await f.manager.deploy({sha:SHA,target});
  assert.equal(submitted.current?.status,'queued');assert.equal(submitted.canDeploy,false);assert.equal(submitted.current?.url,undefined);
  assert.equal((await stat(join(f.dataDir,'releases','state.json'))).mode&0o777,0o600);
  const finished=await f.manager.refresh();assert.equal(finished.current?.status,'deployed');assert.equal(finished.current?.statusId,'99');
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/already deployed/);
});

test('unknown POST outcomes survive restart without resubmission and recover by release identity',async t=>{
  let creates=0,reads=0;const f=await fixture(t,{create:async()=>{creates++;throw new Error('connection lost');},read:async()=>{reads++;return reads===1?null:{deploymentId:'21',status:'deploying',statusId:'31'};}});
  await f.manager.configure(target);assert.equal((await f.manager.deploy({sha:SHA,target})).current?.status,'unknown');
  await f.manager.close();const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  assert.equal(creates,1);await assert.rejects(reopened.deploy({sha:SHA,target}),/unresolved/);
  assert.equal((await reopened.refresh()).current?.status,'unknown');assert.equal(creates,1);
  assert.equal((await reopened.refresh()).current?.deploymentId,'21');assert.equal(creates,1);
});

test('source changes while checking the handler cannot configure or dispatch another repository',async t=>{
  const f=await fixture(t);await f.manager.configure(target);
  const wait=deferred<void>();f.options.github.verifyTarget=async()=>{await wait.promise;return workflow;};
  const pending=f.manager.deploy({sha:SHA,target});
  const changed=evidence();changed.source!.repository='acme/other';f.setEvidence(changed);wait.resolve();
  await assert.rejects(pending,/source|changed/);assert.equal(f.requests.length,0);
  const view=await f.manager.view();assert.equal(view.target,null);assert.equal(view.current,null);
});

test('a manual gate exception must retain its approving identity',async t=>{
  const f=await fixture(t);await f.manager.configure(target);
  f.setEvidence({...evidence(),gates:[{...evidence().gates[0],status:'released'}]});await assert.rejects(f.manager.deploy({sha:SHA,target}),/evidence/);
  f.setEvidence({...evidence(),gates:[{...evidence().gates[0],status:'released',releasedBy:'reviewer',releasedAt:'2026-01-01T00:01:00Z'}]});
  await f.manager.deploy({sha:SHA,target});assert.equal(f.requests[0].gates[0].releasedBy,'reviewer');
});

test('closing joins an accepted deployment before releasing controller ownership',async t=>{
  const posted=deferred<void>(),finish=deferred<{deploymentId:string;status:'queued'}>();
  const f=await fixture(t,{create:async()=>{posted.resolve();return finish.promise;}});await f.manager.configure(target);
  const deploy=f.manager.deploy({sha:SHA,target});await posted.promise;let closed=false;
  const close=f.manager.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));
  try{assert.equal(closed,false,'Closing must wait for the in-flight POST and its durable result.');}
  finally{finish.resolve({deploymentId:'51',status:'queued'});await deploy;await close;}
  const stored=JSON.parse(await readFile(join(f.dataDir,'releases','state.json'),'utf8'));assert.equal(stored.releases[0].record.deploymentId,'51');
});

test('persisted extra fields never enter public release records',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});await f.manager.close();
  const path=join(f.dataDir,'releases','state.json'),stored=JSON.parse(await readFile(path,'utf8'));
  stored.releases[0].record.privateDebug='private-record-only';await writeFile(path,JSON.stringify(stored));
  const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  const view=await reopened.view();assert.equal('privateDebug'in view.current!,false);
  assert.equal(JSON.stringify(view).includes('private-record-only'),false);
});

test('an unresolved deployment prevents changing destinations or deploying a newer commit',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  await assert.rejects(f.manager.configure({...target,environment:'other'}),/unresolved/);
  const newer=evidence();newer.source!.sha=OTHER;newer.gates[0].sha=OTHER;f.setEvidence(newer);
  await assert.rejects(f.manager.deploy({sha:OTHER,target}),/unresolved/);assert.equal(f.requests.length,1);
});

test('the connected account resolves an unresolved deployment another login requested, after the source moved on',async t=>{
  let reads=0,status:'queued'|'failed'='queued';const f=await fixture(t,{read:async()=>{reads++;return {deploymentId:'12',status};}});
  await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  // The requesting login was renamed, and the source advanced to a newer tested commit.
  const renamed=evidence();Object.assign(renamed.source!,{login:'owner-renamed',sha:OTHER});renamed.gates[0].sha=OTHER;f.setEvidence(renamed);
  const waiting=await f.manager.refresh();
  assert.deepEqual([reads,waiting.recent[0].status,waiting.recent[0].error,waiting.canDeploy],[1,'queued',undefined,false]);
  status='failed'; // the handler reports, or a person posts a failure to the deployment on GitHub
  const ended=await f.manager.refresh();
  assert.deepEqual([reads,ended.recent[0].status,ended.canDeploy],[2,'failed',true]);
});

test('a status read that fails keeps the deployment unresolved, with the failure shown',async t=>{
  const f=await fixture(t,{read:async()=>{throw new Error('Could not read the GitHub deployment configuration or status.');}});
  await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  const view=await f.manager.refresh();
  assert.deepEqual([view.current?.status,view.current?.error,view.canDeploy],['queued','Could not read the GitHub deployment configuration or status.',false]);
});

test('an unresolved deployment of another branch is neither read nor blocking for the selected one',async t=>{
  let reads=0;const f=await fixture(t,{read:async()=>{reads++;return {deploymentId:'12',status:'queued'};}});
  await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  const release=evidence();release.source!.branch='release';f.setEvidence(release);
  await f.manager.configure(target);const view=await f.manager.refresh();
  assert.equal(reads,0);assert.deepEqual([view.current,view.canDeploy],[null,true]);
});

test('a stale confirmation cannot deploy to a destination changed by another tab',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.configure({...target,environment:'other'});
  const confirmed={sha:SHA,target};await assert.rejects(f.manager.deploy(confirmed),/target changed/);assert.equal(f.requests.length,0);
});

test('fresh remote Build or branch refusal prevents deployment despite cached gate success',async t=>{
  const f=await fixture(t);await f.manager.configure(target);
  Object.assign(f.options.github,{verifyCommit:async()=>{throw new Error('The branch head changed.');}});
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/branch head changed/);assert.equal(f.requests.length,0);
});

test('a stop during the read-only preflight leaves no request to recover as uncertain',async t=>{
  const checking=deferred<void>(),hold=deferred<void>();
  const f=await fixture(t,{verifyCommit:async()=>{checking.resolve();await hold.promise;}});
  await f.manager.configure(target);const deploying=f.manager.deploy({sha:SHA,target});await checking.promise;
  try{
    // What a hard stop at this moment leaves on disk.
    const copy=await mkdtemp(join(tmpdir(),'perpetual-release-'));t.after(()=>rm(copy,{recursive:true,force:true}));
    await cp(join(f.dataDir,'releases'),join(copy,'releases'),{recursive:true});
    const restarted=await createReleaseManager({...f.options,dataDir:copy});t.after(()=>restarted.close());
    const view=await restarted.view();assert.deepEqual([view.current,view.canDeploy],[null,true]);
  }finally{hold.resolve();await deploying;}
  assert.equal(f.requests.length,1);
});

test('a restarted controller observes an unresolved deployment in the background, less often while nothing changes',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});await f.manager.close();
  t.mock.timers.enable({apis:['setInterval']});
  let reads=0,status:'queued'|'deployed'='queued';
  const reopened=await createReleaseManager({...f.options,github:{...f.options.github,read:async()=>{reads++;return {deploymentId:'12',status};}},pollInterval:1000});
  t.after(()=>reopened.close());
  // One second of the controller's time, and the real time any write it starts needs.
  const tick=async(count:number)=>{for(let index=0;index<count;index++){t.mock.timers.tick(1000);await new Promise(resolve=>setTimeout(resolve,20));}};
  const file=join(f.dataDir,'releases','state.json');
  await tick(1);assert.equal(reads,1,'Observation resumes without Check status.');
  const stored=await readFile(file,'utf8');
  await tick(10);assert.equal(reads,3,'Reads that find nothing new come less and less often.');
  assert.equal(await readFile(file,'utf8'),stored,'A read that finds nothing new writes nothing.');
  status='deployed';
  for(const deadline=Date.now()+10_000;(await reopened.view()).current?.status!=='deployed';){assert.ok(Date.now()<deadline,'The reported status must arrive.');await tick(1);}
  const settled=reads;await tick(5);assert.equal(reads,settled,'A resolved deployment is not read again in the background.');
});

test('restart recovers an interrupted request as unknown and only reads the remote receipt',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});await f.manager.close();
  const path=join(f.dataDir,'releases','state.json'),stored=JSON.parse(await readFile(path,'utf8'));
  stored.releases[0].record.status='requesting';delete stored.releases[0].record.deploymentId;await writeFile(path,JSON.stringify(stored));
  const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  assert.equal((await reopened.view()).current?.status,'unknown');assert.equal(f.requests.length,1);
  await reopened.refresh();assert.equal((await reopened.view()).current?.status,'deployed');assert.equal(f.requests.length,1);
});

test('a reported address that encodes beyond the stored limit is dropped, so the state still loads at the next start',async t=>{
  let release='';
  // GitHub, through the real adapter: the deployment of this release, and a success whose address percent-encodes to over 4,000 characters.
  const adapter=createReleaseGitHub({run:async(_file,args)=>{const endpoint=args.at(-1)!;
    const data=endpoint.includes('/statuses')?[{id:51,state:'success',environment_url:`https://app.example.test/${'é'.repeat(700)}`,log_url:'https://ci.example.test/runs/1'}]
      :{id:12,sha:SHA,environment:target.environment,production_environment:target.productionEnvironment,task:'deploy',payload:{perpetual:{releaseId:release,workflowPath:target.workflowPath,sha:SHA}}};
    return {stdout:`HTTP/2.0 200 OK\n\n${JSON.stringify(data)}`};}});
  const f=await fixture(t,{read:adapter.read});await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});release=f.requests[0].id;
  const deployed=(await f.manager.refresh()).current;
  assert.deepEqual([deployed?.status,deployed?.url,deployed?.logUrl],['deployed',undefined,'https://ci.example.test/runs/1']);
  await f.manager.close();const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  assert.equal((await reopened.view()).current?.status,'deployed');
});

test('changing the target at the same commit does not present a previous destination as deployed',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});await f.manager.refresh();
  const deployed=await f.manager.view();assert.equal(deployed.current?.status,'deployed');assert.equal(deployed.current?.url,'https://app.example.test/');
  for(const replacement of [{...target,environment:'other'},{...target,productionEnvironment:false},{...target,workflowPath:'.github/workflows/other.yml'}]){
    const view=await f.manager.configure(replacement);
    assert.deepEqual(view.target,replacement);assert.equal(view.canDeploy,true);
    assert.equal(view.current,null,'Only a deployment to the complete configured target belongs in current.');
    assert.equal(view.recent[0].status,'deployed');assert.equal(view.recent[0].environment,'production');assert.equal(view.recent[0].url,'https://app.example.test/');
  }
  const restored=await f.manager.configure(target);assert.equal(restored.current?.id,deployed.current?.id);assert.equal(restored.canDeploy,false);
});

test('a commit whose earlier attempt later reports success shows deployed, and Deploy is not offered',async t=>{
  const states:Record<string,'failed'|'deployed'>={};let created=0;
  const f=await fixture(t,{create:async()=>({deploymentId:String(++created),status:'queued'}),read:async request=>({deploymentId:request.deploymentId!,status:states[request.deploymentId!]})});
  await f.manager.configure(target);
  await f.manager.deploy({sha:SHA,target});states['1']='failed';await f.manager.refresh();
  await f.manager.deploy({sha:SHA,target});states['2']='failed';await f.manager.refresh();
  states['1']='deployed'; // the first attempt's workflow is run again on GitHub
  const view=await f.manager.refresh();
  assert.deepEqual([view.current?.deploymentId,view.current?.status,view.canDeploy,view.blockedReason],['1','deployed',false,'This commit is already deployed to this target.']);
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/already deployed/);
});

test('current deployment can be older than the recent history display limit',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  const first=(await f.manager.refresh()).current!;
  for(let index=0;index<20;index++){
    const next={...target,environment:`target-${index}`};await f.manager.configure(next);await f.manager.deploy({sha:SHA,target:next});await f.manager.refresh();
  }
  const restored=await f.manager.configure(target);
  assert.equal(restored.recent.length,20);assert.equal(restored.recent.some(record=>record.id===first.id),false);
  assert.equal(restored.current?.id,first.id);assert.equal(restored.canDeploy,false);
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/already deployed/);
});

test('beyond a thousand records the oldest finished ones go, keeping unresolved ones and the latest of each target',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-release-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const time='2026-01-01T00:00:00Z';
  const stored=(index:number,{branch='main',environment='production',status='failed'}:{branch?:string;environment?:string;status?:string}={})=>{
    const id=`release-${index}`,sha=index.toString(16).padStart(40,'0'),destination={...target,environment};
    return {id,source:{...evidence().source!,branch,sha},target:destination,gates:[{...evidence().gates[0],sha}],workflow,record:{id,sha,...destination,status,createdAt:time,updatedAt:time}};
  };
  // The two oldest records: the only deployment to staging, and a deployment of another branch still unresolved.
  const releases=[stored(1,{environment:'staging',status:'deployed'}),stored(2,{branch:'release',status:'queued'}),...Array.from({length:998},(_,index)=>stored(index+3))];
  await mkdir(join(dataDir,'releases'),{mode:0o700});await writeFile(join(dataDir,'releases','state.json'),JSON.stringify({version:1,targets:{},releases}));
  let current=evidence();
  const manager=await createReleaseManager({dataDir,getEvidence:()=>structuredClone(current),github:{verifyTarget:async()=>workflow,verifyCommit:async()=>{},create:async()=>({deploymentId:'12',status:'queued'}),read:async()=>({deploymentId:'12',status:'deployed'})},pollInterval:0});
  t.after(()=>manager.close());
  const ids=async()=>(JSON.parse(await readFile(join(dataDir,'releases','state.json'),'utf8')).releases as {id:string}[]).map(entry=>entry.id);
  await manager.configure(target);
  const first=(await manager.deploy({sha:SHA,target})).current!;
  let saved=await ids();
  assert.deepEqual([saved.length,saved.slice(0,3),saved.at(-1)],[1000,['release-1','release-2','release-4'],first.id],'The oldest finished record of a target with newer records goes first.');
  assert.equal((await manager.refresh()).current?.status,'deployed');
  // The newest record of the main branch's production target is now the one just made, so the next oldest goes.
  current=evidence();current.source!.sha=OTHER;current.gates[0].sha=OTHER;
  const second=(await manager.deploy({sha:OTHER,target})).current!;
  saved=await ids();
  assert.deepEqual([saved.length,saved.slice(0,3),saved.slice(-2)],[1000,['release-1','release-2','release-5'],[first.id,second.id]]);
});

test('an earlier commit\'s unresolved release stays in the view, with its logs, until it ends',async t=>{
  let status:'deploying'|'failed'='deploying';
  const f=await fixture(t,{read:async()=>({deploymentId:'12',status,statusId:'41',logUrl:'https://ci.example.test/runs/7'})});
  await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});
  const deploying=await f.manager.refresh();
  assert.deepEqual([deploying.current?.status,deploying.unresolved],['deploying',null],'This commit\'s release is current, never also unresolved.');
  // A gate moved the source to a newer commit while the deployment runs.
  const newer=evidence();newer.source!.sha=OTHER;newer.gates[0].sha=OTHER;f.setEvidence(newer);
  const moved=await f.manager.view();
  assert.deepEqual([moved.current,moved.unresolved?.sha,moved.unresolved?.status,moved.unresolved?.logUrl,moved.canDeploy],[null,SHA,'deploying','https://ci.example.test/runs/7',false]);
  status='failed';
  const ended=await f.manager.refresh();
  assert.deepEqual([ended.unresolved,ended.canDeploy,ended.recent[0].status],[null,true,'failed']);
});

test('a person abandons an unresolved release: Perpetual stops reading it, and Deploy and Configure return',async t=>{
  let reads=0;const f=await fixture(t,{read:async()=>{reads++;return {deploymentId:'12',status:'queued'};}});
  await f.manager.configure(target);const queued=(await f.manager.deploy({sha:SHA,target})).current!;
  const status=(code:number,pattern=/./)=>(error:Error&{statusCode?:number})=>error.statusCode===code&&pattern.test(error.message);
  await assert.rejects(f.manager.abandon({id:'release-elsewhere'}),status(404));
  const abandoned=await f.manager.abandon({id:queued.id});
  assert.deepEqual([abandoned.current?.status,abandoned.current?.abandonedBy,abandoned.current?.error,abandoned.canDeploy,abandoned.blockedReason],['abandoned','owner',undefined,true,null]);
  await assert.rejects(f.manager.abandon({id:queued.id}),status(409,/no longer unresolved/));
  // GitHub still reports the deployment queued, but Check status never reads an abandoned release.
  const before=reads,checked=await f.manager.refresh();
  assert.deepEqual([reads-before,checked.current?.status],[0,'abandoned']);
  await f.manager.close();const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  assert.equal((await reopened.view()).current?.abandonedBy,'owner','The abandonment survives a restart.');
  const staging={...target,environment:'staging'};await reopened.configure(staging);
  assert.equal((await reopened.deploy({sha:SHA,target:staging})).current?.status,'queued');assert.equal(f.requests.length,2);
});

test('a request GitHub never received can be abandoned, so the commit can be requested again',async t=>{
  let creates=0;const f=await fixture(t,{create:async()=>{if(++creates===1)throw new Error('connection lost');return {deploymentId:'21',status:'queued'};},read:async()=>null});
  await f.manager.configure(target);const lost=(await f.manager.deploy({sha:SHA,target})).current!;
  assert.equal((await f.manager.refresh()).current?.status,'unknown','GitHub has no matching record, so it stays uncertain.');
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/unresolved/);
  await f.manager.abandon({id:lost.id});
  const retried=await f.manager.deploy({sha:SHA,target});
  assert.deepEqual([creates,retried.current?.deploymentId,retried.current?.status,retried.recent[1].status],[2,'21','queued','abandoned']);
});

test('a deployment deleted on GitHub ends its release as failed, so Deploy and Configure return',async t=>{
  let deleted=false,release='';
  const adapter=createReleaseGitHub({run:async(_file,args)=>{const endpoint=args.at(-1)!;
    if(endpoint==='repos/acme/app')return {stdout:`HTTP/2.0 200 OK\n\n${JSON.stringify({default_branch:'main'})}`};
    if(deleted)throw Object.assign(new Error('failed'),{stderr:'gh: Not Found (HTTP 404)'});
    const data=endpoint.includes('/statuses')?[]:{id:12,sha:SHA,environment:target.environment,production_environment:target.productionEnvironment,task:'deploy',payload:{perpetual:{releaseId:release,workflowPath:target.workflowPath,sha:SHA}}};
    return {stdout:`HTTP/2.0 200 OK\n\n${JSON.stringify(data)}`};}});
  const f=await fixture(t,{read:adapter.read});await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});release=f.requests[0].id;
  assert.equal((await f.manager.refresh()).current?.status,'queued','Its handler has reported nothing.');
  deleted=true; // a person deleted the deployment on GitHub
  const ended=await f.manager.refresh();
  assert.deepEqual([ended.current?.status,ended.current?.error,ended.canDeploy],['failed','The deployment no longer exists on GitHub.',true]);
  assert.deepEqual((await f.manager.configure({...target,environment:'staging'})).target?.environment,'staging');
});
