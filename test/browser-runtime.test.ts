import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {validateBrowserTarget,createBrowserRuntime,superviseWorker,browserError} from '../src/browser/runtime.ts';
import {createBrowserModelSettings} from '../src/browser/model.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';

test('browser target allows explicit local apps and previews but excludes controller, credentials and metadata', () => {
  assert.equal(validateBrowserTarget('http://localhost:3000/dashboard',{controllerOrigin:'http://127.0.0.1:4317'}),'http://localhost:3000/dashboard');
  assert.equal(validateBrowserTarget('https://preview.example/app'),'https://preview.example/app');
  // The runner's Chromium resolves a twin's host name to loopback, so twin URLs are local apps.
  assert.equal(validateBrowserTarget('http://host.docker.internal:43100/billing',{controllerOrigin:'http://127.0.0.1:4317'}),'http://host.docker.internal:43100/billing');
  for(const url of ['http://localhost:4317','http://127.1:4317','http://[::1]:4317','http://host.docker.internal:4317','https://user:secret@example.com','https://169.254.169.254/latest','https://[::ffff:169.254.169.254]/latest','http://10.0.0.1','file:///etc/passwd','https://metadata.google.internal','http://gateway.docker.internal:43100','https://metadata','http://127.example.com:43100'])assert.throws(()=>validateBrowserTarget(url,{controllerOrigin:'http://127.0.0.1:4317'}),Error,url);
  // Only the controller's own host shares its port: a remote preview on the same port number is another application.
  assert.equal(validateBrowserTarget('https://preview.example.com:4317/app',{controllerOrigin:'http://127.0.0.1:4317'}),'https://preview.example.com:4317/app');
  assert.equal(validateBrowserTarget('https://preview.example.com/app',{controllerOrigin:'https://perpetual.example.com'}),'https://preview.example.com/app');
  for(const url of ['https://perpetual.example.com/','https://perpetual.example.com./'])assert.throws(()=>validateBrowserTarget(url,{controllerOrigin:'https://perpetual.example.com'}),/not the Perpetual controller/,url);
});

test('runtime consumes bounded events and keeps model credentials out of errors',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-runtime-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=join(directory,'runner.mjs');
  await writeFile(runner,`process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'case',caseId:'a',status:'running',actions:[]})); console.log(JSON.stringify({type:'error',error:'failed '+process.env.PERPETUAL_MODEL_API_KEY+' bearer abcdefghijklmnop'})); });`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL:'fixture',PERPETUAL_MODEL_API_KEY:'secret-value-0123456789'}});
  const events:WorkerEvent[]=[];const job=runtime.start({mode:'discover'},event=>events.push(event));
  await assert.rejects(job.promise,{message:'failed [REDACTED] Bearer [REDACTED]'});
  assert.equal(events[0].caseId,'a');
});

test('a model key too short to be a real credential, such as a local placeholder, rewrites no text',async t=>{
  assert.equal(browserError('Browser operation exceeded its time limit.',{PERPETUAL_MODEL_API_KEY:'x'}),'Browser operation exceeded its time limit.');
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-short-key-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const discovery={type:'discovery',cases:[{id:'export-xlsx',name:'Export the next invoice',steps:[{id:'export',title:'Export',checks:[{type:'text-visible',value:'Exported'}]}]}],summary:'Explored the inbox'};
  const runner=join(directory,'runner.mjs');
  await writeFile(runner,`process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(discovery))});console.log(JSON.stringify({type:'error',error:'The next export exceeded its time limit.'}));});`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL:'fixture-chat',PERPETUAL_MODEL_API_KEY:'x',PERPETUAL_MODEL_BASE_URL:'http://localhost:11434/v1'}}),events:WorkerEvent[]=[];
  await assert.rejects(runtime.start({mode:'discover'},event=>events.push(event)).promise,{message:'The next export exceeded its time limit.'});
  assert.deepEqual(events,[discovery]);
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

test('the discovery worker finds Chromium where it was installed and reaches its model through the configured proxy and certificates, and nothing else',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-environment-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const proxy='http://proxy.example.test:3128',bundle=join(directory,'ca.pem');
  const forwarded={PLAYWRIGHT_BROWSERS_PATH:join(directory,'browsers'),HTTPS_PROXY:proxy,HTTP_PROXY:proxy,NO_PROXY:'localhost,127.0.0.1',https_proxy:proxy,http_proxy:proxy,no_proxy:'localhost',SSL_CERT_FILE:bundle,SSL_CERT_DIR:directory,REQUESTS_CA_BUNDLE:bundle};
  const runner=join(directory,'runner.mjs'),names=[...Object.keys(forwarded),'UNRELATED_SECRET'];
  await writeFile(runner,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'status',runtimeInstalled:true,browserInstalled:Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH),environment:Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))})));`);
  const env={PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture-chat',...forwarded,UNRELATED_SECRET:'not-for-the-worker'};
  const runtime=createBrowserRuntime({python:process.execPath,runner,env}),events:WorkerEvent[]=[];
  await runtime.start({mode:'preflight'},event=>events.push(event)).promise;
  assert.deepEqual(events[0].environment,{...forwarded,UNRELATED_SECRET:null});
  assert.equal((await runtime.capabilities()).browserInstalled,true,'The preflight looks where Chromium was installed.');
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

test('a discovery or sign-in-page event is free text throughout, its check values included',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-discovery-text-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  // The model reports back a page that shows its key.
  const reported=JSON.stringify([
    {type:'discovery',cases:[{id:'orders',name:'Place an order',steps:[{id:'pay',title:'Pay',checks:[{type:'text-visible',value:'KEY'}]}],assertions:[{type:'text-visible',value:'Key KEY'}]}],summary:'Explored'},
    {type:'sign-in-page',caseId:'discovery',url:'https://app.example/sign-in/KEY'},
  ]);
  const runner=join(directory,'runner.mjs');
  await writeFile(runner,`process.stdin.resume();process.stdin.on('end',()=>{for(const event of JSON.parse(${JSON.stringify(reported)}.replaceAll('KEY',process.env.PERPETUAL_MODEL_API_KEY)))console.log(JSON.stringify(event));});`);
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL:'fixture-chat',PERPETUAL_MODEL_API_KEY:'fixture-model-key-0123456789'}}),events:WorkerEvent[]=[];
  await runtime.start({mode:'discover'},event=>events.push(event)).promise;
  assert.deepEqual(events,JSON.parse(reported.replaceAll('KEY','[REDACTED]')));
});

// A worker that runs script; its events are what the supervisor accepted.
function supervise(script:string,{cleanupGraceMs=200}={}){
  const events:WorkerEvent[]=[];
  const job=superviseWorker({command:process.execPath,args:['-e',script],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs,onEvent:event=>{events.push(event);}});
  return {promise:job.promise,events};
}

test('the worker protocol refuses malformed, incomplete and unfinished output',async()=>{
  for(const [script,message] of [
    ['console.log("not json")','Browser runtime returned an invalid event.'],
    ['console.log("[]")','Browser runtime returned an invalid event.'],
    ['process.stdout.write(JSON.stringify({type:"status"}))','Browser runtime returned an incomplete event.'],
    ['console.log(JSON.stringify({type:"status"}));process.exitCode=1','Browser runtime exited before completing the operation.'],
  ] as const)await assert.rejects(supervise(script).promise,{message},script);
});

test('after a protocol error the worker output is drained, never parsed or delivered again',async t=>{
  // The worker ignores the stop signal and goes on writing a valid event.
  const worker=supervise('process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"status",order:1}));console.log("not json");setTimeout(()=>{console.log(JSON.stringify({type:"status",order:2}));setTimeout(()=>process.exit(0),50);},100);',{cleanupGraceMs:10000});
  await assert.rejects(worker.promise,{message:'Browser runtime returned an invalid event.'});
  assert.deepEqual(worker.events,[{type:'status',order:1}]);
  // An event over its size limit is dropped as it arrives. The worker ignores the stop signal and writes 256 MiB more:
  // the controller reads all of it before the cleanup grace ends, without keeping it.
  const before=process.memoryUsage().heapUsed;let held=0;
  const sample=setInterval(()=>{held=Math.max(held,process.memoryUsage().heapUsed-before);},10);t.after(()=>clearInterval(sample));
  const flood=supervise('process.on("SIGTERM",()=>{});const chunk="x".repeat(65536);let left=4096;const write=()=>left--?process.stdout.write(chunk,write):process.exit(0);write();',{cleanupGraceMs:10000});
  await assert.rejects(flood.promise.finally(()=>clearInterval(sample)),{message:'Browser event exceeded its size limit.'});
  assert.deepEqual(flood.events,[]);
  assert.ok(held<192*1024*1024,`The controller held ${Math.round(held/1024/1024)} MiB of the 256 MiB it dropped.`);
});

test('the event history is bounded, while replaced action snapshots do not spend it',async()=>{
  // About 9 MiB of other events stops the worker.
  const padded=supervise('const pad="x".repeat(10240);for(let i=0;i<900;i++)console.log(JSON.stringify({type:"status",i,pad}));');
  await assert.rejects(padded.promise,{message:'Browser event history exceeded its size limit.'});
  assert.ok(padded.events.length<900);
  // A journey re-sends its last 150 actions as each action starts and ends: about 9 MiB for 900 actions reaches its end.
  const actions=supervise('const actions=Array.from({length:150},()=>({type:"click",status:"passed"}));for(let i=0;i<1800;i++)console.log(JSON.stringify({type:"case",caseId:"c",status:"running",actions}));console.log(JSON.stringify({type:"result",result:{caseId:"c"}}));');
  await actions.promise;
  assert.equal(actions.events.length,1801);
});

test('cancelling a worker leaves none of its process running',async()=>{
  let pid=0,ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  const job=superviseWorker({command:process.execPath,args:['-e','console.log(JSON.stringify({type:"status",pid:process.pid}));setInterval(()=>{},1000);'],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs:10000,onEvent:event=>{pid=event.pid as number;ready();}});
  await started;job.cancel();
  await assert.rejects(job.promise,{message:'Browser operation cancelled.'});
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('error text drops URL queries and fragments in time linear in its length',{timeout:20000},()=>{
  assert.equal(browserError('Open https://app.example/a?token=1#top and http://app.example/b, then https://app.example/c#x',{}),'Open https://app.example/a and http://app.example/b, then https://app.example/c');
  // About 400 KB of addresses without spaces, queries or fragments, as a minified output tail holds them.
  const text='"https://a.example/c",'.repeat(18000),started=performance.now();
  assert.equal(browserError(text,{},Infinity),text);
  assert.ok(performance.now()-started<1000,'Each address is scanned once.');
});

test('error-only account values are masked before clipping without changing business evidence',async()=>{
  const username=`former-${'x'.repeat(900)}`,events:WorkerEvent[]=[];
  const job=superviseWorker({command:process.execPath,args:['-e','const username=process.argv[1]; console.log(JSON.stringify({type:"journey-step",checks:[{type:"text-visible",value:username,passed:true}]})); console.log(JSON.stringify({type:"error",error:"Missing control for "+username}));',username],env:{PATH:process.env.PATH},timeoutMs:20000,cleanupGraceMs:200,onEvent:event=>{events.push(event);},errorSecrets:[username]});
  await assert.rejects(job.promise,(error:Error)=>error.message.includes('[REDACTED]')&&!error.message.includes(username.slice(0,50)));
  assert.deepEqual(events,[{type:'journey-step',checks:[{type:'text-visible',value:username,passed:true}]}]);
});
