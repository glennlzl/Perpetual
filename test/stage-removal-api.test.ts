import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fetch,startServer} from './fixtures/controller.ts';

type Stage={id:string;name:string};
type Removal={id:string;status:string;error?:string;completedAt?:string};
// The replies these tests read: the session token, a removal, and the current and saved pipelines.
type Body={token:string;removal:Removal;pipeline:{stages:Stage[]};pipelines:Record<string,{stages:Stage[]}>};
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'perpetual-stage-api-')),dataDir=join(dir,'data'),repos=[join(dir,'a'),join(dir,'b')];
  for(const repo of repos){await mkdir(repo);await writeFile(join(repo,'package.json'),JSON.stringify({name:'fixture'}));}
  let app:Awaited<ReturnType<typeof startServer>>|undefined,token:string|undefined;
  async function request(path:string,body?:Record<string,unknown>,withToken=true):Promise<{status:number;body:Body}>{const res=await fetch(app!.url+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',...(withToken?{'X-Perpetual-Token':token!}:{})}:{},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json()};}
  async function start(){app=await startServer({port:0,dataDir,repo:repos[0]});token=(await request('/api/session')).body.token;}
  async function add(repo:string,name:string){await request('/api/scan',{path:repo});const r=await request('/api/pipeline/action',{repoPath:repo,action:'add-stage',name});assert.equal(r.status,200);return r.body.pipeline.stages.find(s=>s.name===name)!.id;}
  await start();const beta=await add(repos[0],'Beta');
  t.after(async()=>{await app!.close();await rm(dir,{recursive:true,force:true});});
  return {dataDir,repos,beta,request,add,start,close:()=>app!.close()};
}
async function completed(f:Fixture,repo:string,stageId:string){
  for(let n=0;n<100;n++){const r=await f.request(`/api/stages/removal?${new URLSearchParams({repoPath:repo,stageId})}`);assert.equal(r.status,200);assert.notEqual(r.body.removal?.status,'failed',r.body.removal?.error??'Stage removal failed.');if(r.body.removal?.status==='completed')return r.body.removal;await new Promise(r=>setTimeout(r,5));}throw Error('Deletion did not finish');
}

test('confirmed stage removal is durable, scoped, authenticated and idempotent over HTTP',async t=>{
  const f=await fixture(t),input={repoPath:f.repos[0],stageId:f.beta};
  assert.equal((await f.request('/api/stages/remove',input,false)).status,403);
  assert.equal((await f.request('/api/stages/remove',{...input,stageId:'production'})).status,400);
  assert.equal((await f.request('/api/stages/remove',{...input,repoPath:f.repos[1]})).status,409);
  const accepted=await f.request('/api/stages/remove',input);assert.equal(accepted.status,202);
  const finished=await completed(f,f.repos[0],f.beta);assert.equal(finished.id,accepted.body.removal.id);
  const pipeline=(await f.request('/api/state')).body.pipeline;assert.equal(pipeline.stages.some(s=>s.id===f.beta),false);
  const again=await f.request('/api/stages/remove',input);assert.equal(again.status,202);assert.equal(again.body.removal.id,finished.id);
  await f.close();await f.start();assert.equal((await completed(f,f.repos[0],f.beta)).id,finished.id);
});

test('restart finishes accepted deletion in its original pipeline even when another source is selected',async t=>{
  const f=await fixture(t);const gamma=await f.add(f.repos[1],'Gamma');await f.close();
  const file=join(f.dataDir,'stage-removals','state.json');
  await writeFile(file,JSON.stringify({version:1,removals:[{id:randomUUID(),context:{key:f.repos[0],stageId:f.beta},stageId:f.beta,status:'queued',environmentIds:[],completedEnvironmentIds:[],createdAt:new Date().toISOString()}]}));
  await f.start();
  // The unrelated current pipeline survives; completion does not rely on its UI.
  // The pipeline commit lands before the removal records its completion, so wait for both.
  let state:Body|undefined,saved:{removals:Removal[]}|undefined;
  for(let n=0;n<100;n++){
    state=(await f.request('/api/state')).body;saved=JSON.parse(await readFile(file,'utf8'));
    if(!state.pipelines[f.repos[0]].stages.some(s=>s.id===f.beta)&&saved!.removals[0].status==='completed')break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(state!.pipelines[f.repos[0]].stages.some(s=>s.id===f.beta),false);
  assert.equal(state!.pipeline.stages.some(s=>s.id===gamma),true);
  assert.equal(saved!.removals[0].status,'completed');
});

test('restart completes a removal whose pipeline commit already persisted without changing remaining stages',async t=>{
  const f=await fixture(t),gamma=await f.add(f.repos[0],'Gamma');
  const input={repoPath:f.repos[0],stageId:f.beta};
  assert.equal((await f.request('/api/stages/remove',input)).status,202);
  const removed=await completed(f,f.repos[0],f.beta);
  const committed=(await f.request('/api/state')).body.pipeline;
  assert.equal(committed.stages.some(stage=>stage.id===f.beta),false);
  assert.equal(committed.stages.some(stage=>stage.id===gamma),true);
  await f.close();

  // A crash after the pipeline file is committed can leave only the workflow's
  // final completion write outstanding. Preserve exactly that durable boundary.
  const file=join(f.dataDir,'stage-removals','state.json');
  const saved:{removals:Removal[]}=JSON.parse(await readFile(file,'utf8'));
  const unfinished=saved.removals.find(item=>item.id===removed.id)!;
  unfinished.status='removing';
  delete unfinished.completedAt;
  await writeFile(file,JSON.stringify(saved));

  await f.start();
  const recovered=await completed(f,f.repos[0],f.beta);
  assert.equal(recovered.id,removed.id);
  assert.equal(recovered.error,undefined);
  assert.deepEqual((await f.request('/api/state')).body.pipeline,committed);
  const repeated=await f.request('/api/stages/remove',input);
  assert.equal(repeated.status,202);
  assert.equal(repeated.body.removal.id,removed.id);
  assert.equal(repeated.body.removal.status,'completed');
});
