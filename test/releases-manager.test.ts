import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a stale confirmation cannot deploy to a destination changed by another tab',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.configure({...target,environment:'other'});
  const confirmed={sha:SHA,target};await assert.rejects(f.manager.deploy(confirmed),/target changed/);assert.equal(f.requests.length,0);
});

test('fresh remote Build or branch refusal prevents deployment despite cached gate success',async t=>{
  const f=await fixture(t);await f.manager.configure(target);
  Object.assign(f.options.github,{verifyCommit:async()=>{throw new Error('The branch head changed.');}});
  await assert.rejects(f.manager.deploy({sha:SHA,target}),/branch head changed/);assert.equal(f.requests.length,0);
});

test('restart recovers an interrupted request as unknown and only reads the remote receipt',async t=>{
  const f=await fixture(t);await f.manager.configure(target);await f.manager.deploy({sha:SHA,target});await f.manager.close();
  const path=join(f.dataDir,'releases','state.json'),stored=JSON.parse(await readFile(path,'utf8'));
  stored.releases[0].record.status='requesting';delete stored.releases[0].record.deploymentId;await writeFile(path,JSON.stringify(stored));
  const reopened=await createReleaseManager(f.options);t.after(()=>reopened.close());
  assert.equal((await reopened.view()).current?.status,'unknown');assert.equal(f.requests.length,1);
  await reopened.refresh();assert.equal((await reopened.view()).current?.status,'deployed');assert.equal(f.requests.length,1);
});
