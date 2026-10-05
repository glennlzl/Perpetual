import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, symlink, writeFile, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import type {Controller} from '../src/server.ts';
import {fetch,signIn,startServer} from './fixtures/controller.ts';

// What a child controller reports back over IPC.
type Outcome={url?:string;launchUrl?:string;error?:string;waiting?:true};

function controllerChild(t: TestContext,dataDir: string,{barrier=false}={}){
  const script=`
    import {startServer} from ${JSON.stringify(new URL('../src/server.ts',import.meta.url).href)};
    let app;
    process.on('message',async message=>{
      if(message==='start'){
        try{app=await startServer({port:0,dataDir:process.argv[1]});process.send({url:app.url,launchUrl:app.launchUrl});}
        catch(error){process.send({error:error.code||error.message});}
      }
      if(message==='close'){await app?.close();process.exit(0);}
    });
    process.send({waiting:true});
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,dataDir],{stdio:['ignore','ignore','ignore','ipc']});
  const waiting=once(child,'message');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  });
  return {child,ready:waiting.then(async(): Promise<Outcome|undefined>=>{
    if(barrier)return;
    const result=once(child,'message');child.send('start');return (await result)[0] as Outcome;
  })};
}

test('a second controller cannot open the same data while its owner is active',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-owner-'));
  const dataDir=join(dir,'data');let first: Controller|undefined,second: Controller|undefined,restarted: Controller|undefined;
  t.after(async()=>{await Promise.all([first?.close(),second?.close(),restarted?.close()]);await rm(dir,{recursive:true,force:true});});
  await mkdir(join(dir,'repo'));await writeFile(join(dir,'repo','package.json'),'{}');
  first=await startServer({port:0,repo:join(dir,'repo'),dataDir});
  await assert.rejects(async()=>{second=await startServer({port:0,dataDir});},/already.*(using|owns)|controller.*running/i);
  await first.close();
  restarted=await startServer({port:0,dataDir});
  assert.equal((await fetch(restarted.url+'/api/state')).status,200);
});

test('data-directory aliases cannot bypass controller ownership',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-alias-'));
  await mkdir(join(dir,'actual'));await symlink(join(dir,'actual'),join(dir,'alias'));
  let first: Controller|undefined,second: Controller|undefined;
  t.after(async()=>{await Promise.all([first?.close(),second?.close()]);await rm(dir,{recursive:true,force:true});});
  first=await startServer({port:0,dataDir:join(dir,'actual')});
  await assert.rejects(async()=>{second=await startServer({port:0,dataDir:join(dir,'alias')});},/already.*(using|owns)|controller.*running/i);
});

for(const viaAlias of [false,true])test(`controller keeps the configured runtime ownership path${viaAlias?' through a data-directory alias':''}`,{timeout:10000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-runtime-owner-')),actual=join(dir,'actual'),repo=join(dir,'repo');
  await mkdir(actual);await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  const dataDir=viaAlias?join(dir,'alias'):actual;
  if(viaAlias)await symlink(actual,dataDir);
  const prepared=Promise.withResolvers<string>();let app:Controller|undefined;
  t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});
  app=await startServer({port:0,dataDir,repo,twin:{gitEmail:async()=>''},environments:{runtime:{
    async prepareEnvironment({dataDir}){prepared.resolve(dataDir);return {status:'ready',services:[],apps:[]};},
    environmentHealth:async()=>({status:'ready'}),environmentLogs:async()=>'',destroySandbox:async()=>{},
  }}});
  assert.equal((await stat(actual)).mode&0o777,0o700);
  assert.equal((await fetch(app.url+'/api/twin/inputs')).status,200,'A supported controller data alias can read its saved inputs.');
  const {token}=await(await fetch(app.url+'/api/session')).json();
  const post=async(path:string,body:unknown,status=200)=>{
    const response=await fetch(app!.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token},body:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  await post('/api/scan',{path:repo});
  const {pipeline}=await post('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'});
  const stageId=pipeline.stages.find((stage:{name:string})=>stage.name==='Beta').id;
  await post('/api/environments/plan',{repoPath:repo,stageId,plan:{services:{},apps:{web:{start:'node app.mjs',port:3000}},fixtures:[]}});
  await post('/api/environments/create',{repoPath:repo,stageId},202);
  assert.equal(await prepared.promise,dataDir,'Existing resource ownership was derived from the configured path, not its realpath.');
});

test('an abrupt owner exit permits recovery of its persisted pipeline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-recover-')),dataDir=join(dir,'data'),repo=join(dir,'repo');
  let restarted: Controller|undefined;
  t.after(async()=>{await restarted?.close();await rm(dir,{recursive:true,force:true});});
  await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  const owner=controllerChild(t,dataDir),{url,launchUrl}=(await owner.ready)!;
  await signIn(launchUrl!);
  const {token}=await (await fetch(url+'/api/session')).json();
  const post=(path: string,value: object)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token},body:JSON.stringify(value)});
  assert.equal((await post('/api/scan',{path:repo})).status,200);
  const added=await post('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'});
  assert.equal(added.status,200);
  const before=(await added.json()).pipeline;
  const other=controllerChild(t,dataDir);
  assert.equal((await other.ready)!.error,'CONTROLLER_ALREADY_RUNNING');
  const exited=once(owner.child,'exit');owner.child.kill('SIGKILL');await exited;
  restarted=await startServer({port:0,dataDir});
  assert.deepEqual((await (await fetch(restarted.url+'/api/state')).json()).pipeline,before);
});

test('simultaneous processes admit at most one controller and release rejected contenders',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-race-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const contenders=Array.from({length:4},()=>controllerChild(t,dir,{barrier:true}));
  await Promise.all(contenders.map(owner=>owner.ready));
  const decisions=contenders.map(({child})=>once(child,'message').then(([message])=>message as Outcome));
  for(const {child} of contenders)child.send('start');
  const outcomes=await Promise.all(decisions);
  assert.ok(outcomes.filter(outcome=>outcome.url).length<=1,'Only one process may recover or write this data');
  for(const outcome of outcomes)if(!outcome.url)assert.equal(outcome.error,'CONTROLLER_ALREADY_RUNNING');
  await Promise.all(contenders.map(async({child})=>{const exited=once(child,'exit');child.send('close');await exited;}));
  const app=await startServer({port:0,dataDir:dir});await app.close();
});

test('a hidden file beside the records is ignored, and a refusal names the record to remove when no controller runs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-records-')),owners=join(dir,'.controller-owners');
  let app: Controller|undefined;
  t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});
  await mkdir(owners);await writeFile(join(owners,'.DS_Store'),'');
  app=await startServer({port:0,dataDir:dir});
  await app.close();app=undefined;
  // A record whose process is alive, here this test's own, as a reused id after a reboot would be.
  const record=join(await realpath(owners),`${process.pid}-${randomUUID()}.lock`);
  await writeFile(record,'');
  await assert.rejects(startServer({port:0,dataDir:dir}),(error: Error&{code?: string})=>error.code==='CONTROLLER_ALREADY_RUNNING'&&error.message.includes(`process ${process.pid}`)&&error.message.includes(record));
});

test('failed startup releases ownership so a different port can retry',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-start-failure-'));
  let first: Controller|undefined,retry: Controller|undefined;
  t.after(async()=>{await Promise.all([first?.close(),retry?.close()]);await rm(dir,{recursive:true,force:true});});
  first=await startServer({port:0,dataDir:join(dir,'first')});
  await assert.rejects(startServer({port:Number(new URL(first.url).port),dataDir:join(dir,'second')}),{code:'EADDRINUSE'});
  retry=await startServer({port:0,dataDir:join(dir,'second')});
  assert.equal((await fetch(retry.url+'/api/state')).status,200);
});
