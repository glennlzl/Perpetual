import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {validateBrowserTarget,createBrowserRuntime,superviseWorker} from '../src/browser/runtime.ts';
import {createBrowserModelSettings} from '../src/browser/model.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';

test('browser target allows explicit local apps and previews but excludes controller, credentials and metadata', () => {
  assert.equal(validateBrowserTarget('http://localhost:3000/dashboard',{controllerOrigin:'http://127.0.0.1:4317'}),'http://localhost:3000/dashboard');
  assert.equal(validateBrowserTarget('https://preview.example/app'),'https://preview.example/app');
  // The runner's Chromium resolves a twin's host name to loopback, so twin URLs are local apps.
  assert.equal(validateBrowserTarget('http://host.docker.internal:43100/billing',{controllerOrigin:'http://127.0.0.1:4317'}),'http://host.docker.internal:43100/billing');
  for(const url of ['http://localhost:4317','http://127.1:4317','http://[::1]:4317','http://host.docker.internal:4317','https://user:secret@example.com','https://169.254.169.254/latest','https://[::ffff:169.254.169.254]/latest','http://10.0.0.1','file:///etc/passwd','https://metadata.google.internal','http://gateway.docker.internal:43100','https://metadata','http://127.example.com:43100'])assert.throws(()=>validateBrowserTarget(url,{controllerOrigin:'http://127.0.0.1:4317'}),Error,url);
});

test('runtime consumes bounded events and keeps model credentials out of errors',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-runtime-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');
  await writeFile(runner,`process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'case',caseId:'a',status:'running',actions:[]})); console.log(JSON.stringify({type:'error',error:'failed secret-value bearer abcdefghijklmnop'})); });`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL:'fixture',PERPETUAL_MODEL_API_KEY:'secret-value'}});
  const events:WorkerEvent[]=[];const job=runtime.start({mode:'discover'},event=>events.push(event));
  await assert.rejects(job.promise,/\[REDACTED\]/);
  assert.equal(events[0].caseId,'a');
});

test('runtime cancellation terminates owned child and deadline does not leave it running',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-cancel-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');await writeFile(runner,'setInterval(()=>{},1000);');
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat'}});
  const job=runtime.start({mode:'discover'},()=>{});job.cancel();
  await assert.rejects(job.promise,/cancelled/i);
  const timed=runtime.start({mode:'discover'},()=>{},{timeoutMs:50});
  await assert.rejects(timed.promise,/time limit/i);
});

test('runtime capability preflight detects missing browser and is cached without inference',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-preflight-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');await writeFile(runner,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'status',runtimeInstalled:true,browserInstalled:false})));`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{OPENROUTER_API_KEY:'fixture-only'}});
  assert.deepEqual(await runtime.capabilities(),{runtimeInstalled:true,browserInstalled:false,modelConfigured:true});
  await writeFile(runner,'process.exit(1);');assert.equal((await runtime.capabilities()).runtimeInstalled,true);
});

test('forced termination reports that browser cleanup could not be confirmed',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-force-stop-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');await writeFile(runner,`process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'status',status:'ready'}));setInterval(()=>{},1000);`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat'}});
  let ready!:(value?:unknown)=>void;const started=new Promise(resolve=>{ready=resolve;});
  const job=runtime.start({mode:'discover'},()=>ready(),{cleanupGraceMs:30});await started;job.cancel();
  await assert.rejects(job.promise,{message:/Cleanup incomplete.*forced termination/,cleanupIncomplete:true});
});

test('runtime joins owned descendants after the wrapper exits before releasing completion',async t=>{
  if(process.platform==='win32'){t.skip('Process-group ownership requires POSIX signals.');return;}
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-descendant-'));
  let workerPid:number|undefined;
  t.after(async()=>{if(workerPid)try{process.kill(workerPid,'SIGKILL');}catch{}await rm(directory,{recursive:true,force:true});});
  const worker=join(directory,'worker.mjs'),runner=join(directory,'runner.mjs');
  await writeFile(worker,`process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);`);
  await writeFile(runner,`import {fork} from 'node:child_process';const child=fork(${JSON.stringify(worker)},[],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{console.log(JSON.stringify({type:'status',pid:child.pid}));child.disconnect();child.unref();});`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat'}});
  const job=runtime.start({mode:'discover'},event=>{workerPid=event.pid as number;},{cleanupGraceMs:40});
  await assert.rejects(job.promise,/owned child processes|forced termination/);
  assert.ok(workerPid,'The fixture must start an actual owned descendant.');
  assert.throws(()=>process.kill(workerPid!,0),{code:'ESRCH'},'Runtime completion must wait until the owned descendant has stopped.');
});

test('owned descendants get settleMs to exit on their own after the worker exits',async t=>{
  if(process.platform==='win32'){t.skip('Process-group ownership requires POSIX signals.');return;}
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-settle-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  // The worker exits at once; its descendant finishes its own cleanup 400 ms later, or never.
  const worker=join(directory,'worker.mjs');
  await writeFile(worker,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',process.argv[2]==='never'?"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)":'setTimeout(()=>{},400)'],{stdio:'ignore'});child.unref();console.log(child.pid);`);
  const run=(mode:string,settleMs:number)=>{let output='';const job=superviseWorker({command:process.execPath,args:[worker,mode],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs:200,settleMs,onOutput(chunk){output+=chunk;}});return {promise:job.promise,pid:()=>Number(output.trim())};};
  await assert.rejects(run('linger',0).promise,/owned child processes remaining/,'Without settling, a descendant still running fails the worker.');
  const settled=run('linger',5000);await settled.promise;
  assert.throws(()=>process.kill(settled.pid(),0),{code:'ESRCH'},'Completion waits until the descendant has exited.');
  const stuck=run('never',300);
  await assert.rejects(stuck.promise,/owned child processes remaining/);
  assert.throws(()=>process.kill(stuck.pid(),0),{code:'ESRCH'},'A descendant still running after settleMs is stopped.');
});

test('runtime preserves structured cleanup uncertainty from the browser adapter',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-cleanup-event-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');
  await writeFile(runner,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'error',error:'Cleanup incomplete: owned Chromium',cleanupIncomplete:true})));`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat'}});
  await assert.rejects(runtime.start({mode:'discover'},()=>{}).promise,{cleanupIncomplete:true});
});

test('real Python preflight keeps installed dependencies distinct from an unsupported model',async t=>{
  const python=fileURLToPath(new URL('../integrations/browser-use/.venv/bin/python',import.meta.url));
  try{await access(python);}catch{t.skip('Optional local Python browser runtime is not installed.');return;}
  const baseline=createBrowserRuntime({python,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat'}});
  const installed=await baseline.capabilities();
  if(!installed.runtimeInstalled){t.skip('Optional locked Python browser dependencies are not installed.');return;}
  const runtime=createBrowserRuntime({python,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'typesafe/jev-1'}});
  const capabilities=await runtime.capabilities();
  assert.equal(capabilities.runtimeInstalled,installed.runtimeInstalled);
  assert.equal(capabilities.browserInstalled,installed.browserInstalled);
  assert.equal(capabilities.modelConfigured,false);
  assert.match(capabilities.modelError!,/chat model|decisions API/i);
});

test('saved model settings reach Python unchanged and do not revive environment credentials',async t=>{
  const python=fileURLToPath(new URL('../integrations/browser-use/.venv/bin/python',import.meta.url));
  try{await access(python);}catch{t.skip('Optional local Python browser runtime is not installed.');return;}
  const directory=await mkdtemp(join(tmpdir(),'perpetual-resolved-model-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir:directory,env:{OPENROUTER_API_KEY:'environment-fixture-only'}});
  await model.save({apiKey:'saved-fixture-only',model:'custom/jevil-chat',baseUrl:'https://model.example/v1'});
  const runtime=createBrowserRuntime({python,env:{OPENROUTER_API_KEY:'wrong-fixture-only',PERPETUAL_MODEL:'typesafe/jev-1'},model:()=>model.configuration()});
  const events:WorkerEvent[]=[];
  await runtime.start({mode:'preflight'},event=>events.push(event)).promise;
  const status=events.find(event=>event.type==='status')!;
  assert.equal(status.modelConfigured,true);
  assert.equal(status.modelError,undefined);
  assert.equal((await runtime.capabilities()).modelConfigured,true);
  assert.doesNotMatch(JSON.stringify(events),/saved-fixture-only|environment-fixture-only|wrong-fixture-only/);
});

test('a short or common secret is hidden in free text without changing keys, numbers, statuses or step ids',async()=>{
  // Each password also spells part of the protocol: a key, a number's digits, a status, a step id or a check value.
  const sent=[
    {type:'case',caseId:'c',status:'running',actionCount:1234,actions:[{type:'click',status:'passed'}]},
    {type:'journey-step',caseId:'c',stepId:'create-test-workflow',status:'completed',evidence:'Created the test workflow; pass 1234 accepted',checks:[{type:'text-visible',value:'Test run complete',passed:true,error:'run test'}]},
    {type:'result',result:{caseId:'c',stopCause:'none',assertions:[{type:'text-visible',value:'Test run complete',passed:true,resolved:'Test run complete'}],blockers:[{stepId:'create-test-workflow',kind:'account',evidence:'test account'}],error:'pass'}},
  ];
  for(const secret of ['pass','test','run','1234']){
    const events:WorkerEvent[]=[];
    const job=superviseWorker({command:process.execPath,args:['-e','for(const event of JSON.parse(process.argv[1]))console.log(JSON.stringify(event));',JSON.stringify(sent)],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs:200,onEvent:event=>{events.push(event);},secrets:[secret]});
    await job.promise;
    const text=(value:string)=>value.split(secret).join('[REDACTED]');
    assert.deepEqual(events,[
      sent[0],
      {...sent[1],evidence:text(sent[1].evidence as string),checks:[{type:'text-visible',value:'Test run complete',passed:true,error:text('run test')}]},
      {type:'result',result:{caseId:'c',stopCause:'none',assertions:[{type:'text-visible',value:'Test run complete',passed:true,resolved:'Test run complete'}],blockers:[{stepId:'create-test-workflow',kind:'account',evidence:text('test account')}],error:text('pass')}},
    ],secret);
  }
});

test('error-only account values are masked before clipping without changing business evidence',async()=>{
  const username=`former-${'x'.repeat(900)}`,events:WorkerEvent[]=[];
  const job=superviseWorker({command:process.execPath,args:['-e','const username=process.argv[1]; console.log(JSON.stringify({type:"journey-step",checks:[{type:"text-visible",value:username,passed:true}]})); console.log(JSON.stringify({type:"error",error:"Missing control for "+username}));',username],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs:200,onEvent:event=>{events.push(event);},errorSecrets:[username]});
  await assert.rejects(job.promise,(error:Error)=>error.message.includes('[REDACTED]')&&!error.message.includes(username.slice(0,50)));
  assert.deepEqual(events,[{type:'journey-step',checks:[{type:'text-visible',value:username,passed:true}]}]);
});
