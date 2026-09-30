import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserManager} from '../src/browser/manager.ts';
import {createBrowserRuntime,workerTimeoutMs} from '../src/browser/runtime.ts';
import {journeyConcurrency} from '../src/browser/journey-scheduler.ts';
import {codeFor,draftCode,manual} from './fixtures/journey-code.ts';
import type {WorkerError,WorkerEvent} from '../src/browser/runtime.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

// Contract v2 (docs/architecture/journey-contract.md), controller side.
const deferred=()=>{let resolve!:(value?:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
type Worker={input:JourneyRunInput;event:(event:WorkerEvent)=>void;gate:ReturnType<typeof deferred>;cancelled:boolean};
const credits=[{id:'start',title:'Confirm the starting balance',checks:[{type:'read-number',label:'Credits',name:'before'}]},{id:'run',title:'Run the workflow and see credits decrease',checks:[{type:'text-visible',value:'Run complete'},{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'}]},{id:'reopen',title:'Reopen the result'}];
const journey=(id:string,changes:Record<string,unknown>={})=>({id,name:`Journey ${id}`,goal:'Run a workflow and verify its credit usage',isolation:'isolated',steps:credits,expectedOutcomes:['Result visible and credits debited'],assertions:[{type:'text-visible',value:'Run complete'}],selected:true,needsReview:false,...changes});
// Runner facts: the worker never reports a status, only how the journey stopped.
const outcome=(id:string)=>({caseId:id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Result visible, credits 9'}],assertions:[{type:'text-visible',value:'Run complete',passed:true}]});
// The runner starts a milestone without evidence and ends it with the agent's evidence.
const step=(caseId:string,stepId:string,status:string,extra:Record<string,unknown>={})=>({type:'journey-step',caseId,stepId,status,...(status==='running'?{}:{evidence:`${stepId} ${status} observed`}),...extra});
const reach=(worker:Worker,caseId:string,stepId:string,status:string,extra?:Record<string,unknown>)=>{worker.event(step(caseId,stepId,'running'));worker.event(step(caseId,stepId,status,extra));};
const passedChecks:Record<string,Record<string,unknown>[]>={start:[{type:'read-number',label:'Credits',name:'before',passed:true,observed:10}],run:[{type:'text-visible',value:'Run complete',passed:true},{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before',passed:true,observed:9}]};
async function until(predicate:()=>unknown){for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Condition did not settle.');}
async function fixture(t:TestContext,cases=[journey('one'),journey('two')],config:Record<string,unknown>={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-journey-contract-')),repo=join(dataDir,'repo');
  await mkdir(repo);await writeFile(join(repo,'app.js'),'export const credits="Credits";');
  const workers:Worker[]=[];
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input:JourneyRunInput,event:(event:WorkerEvent)=>void){const gate=deferred(),worker={input,event,gate,cancelled:false};workers.push(worker);return {promise:gate.promise,cancel(){worker.cancelled=true;}};}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:runtime}),managers=[manager];
  const context={key:'repo',stageId:'beta',scan:{repo:{path:repo,sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000/login',...config});await manager.saveCases(context,cases);await draftCode(manager,context,cases);
  t.after(async()=>{const closing=Promise.all(managers.map(manager=>manager.close()));for(const worker of workers)worker.gate.resolve();await closing;await rm(dataDir,{recursive:true,force:true});});
  // A reopened manager can still be saving a terminal discovery. Join every owner before removing their shared state.
  const reopen=async()=>{const reopened=await createBrowserManager({dataDir,runtime});managers.push(reopened);return reopened;};
  const report=(id:string)=>manager.runProgress(context,id);
  const terminal=async(id:string)=>{await until(async()=>!['queued','running'].includes((await report(id)).run.status));return report(id);};
  const complete=(index:number,id:string)=>{for(const item of credits)reach(workers[index],id,item.id,'completed',passedChecks[item.id]?{checks:passedChecks[item.id]}:{});};
  return {dataDir,manager,context,workers,runtime,report,terminal,complete,reopen};
}

test('stage settings bound journey time, reviewed external HTTPS origins and target-host auth endpoints',async t=>{
  const f=await fixture(t);
  const saved=(await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/login',journeyTimeoutSeconds:1800,externalOrigins:['https://checkout.stripe.com/','https://Billing.Stripe.com','https://checkout.stripe.com'],authEndpoints:['http://localhost:55888/auth/v1/token']})).config;
  assert.equal(saved.journeyTimeoutSeconds,1800);
  assert.deepEqual(saved.externalOrigins,['https://checkout.stripe.com','https://billing.stripe.com']);
  assert.deepEqual(saved.authEndpoints,['http://localhost:55888/auth/v1/token']);
  const base={targetUrl:'http://localhost:3000/login'};
  for(const config of [{journeyTimeoutSeconds:59},{journeyTimeoutSeconds:1801},{journeyTimeoutSeconds:'900'},{journeyTimeoutSeconds:900.5}])await assert.rejects(f.manager.saveConfig(f.context,{...base,...config}),/60–1800 seconds/);
  for(const externalOrigins of ['https://checkout.stripe.com',['http://checkout.stripe.com'],['https://checkout.stripe.com/pay'],['https://checkout.stripe.com/?mode=test'],['https://checkout.stripe.com#x'],['https://user:secret@checkout.stripe.com'],['https://169.254.169.254'],['not a url'],[42],Array.from({length:11},(_,i)=>`https://service-${i}.example.com`)])await assert.rejects(f.manager.saveConfig(f.context,{...base,externalOrigins}),/external origins/i,JSON.stringify(externalOrigins));
  for(const endpoints of ['http://localhost:55888/auth',['/auth/v1/token'],['http://other.test/auth/v1/token'],['http://localhost:55888/auth?grant_type=password'],['http://user:pass@localhost:55888/auth'],['ftp://localhost/auth'],Array.from({length:4},(_,i)=>`http://localhost:${55000+i}/auth`)])await assert.rejects(f.manager.saveConfig(f.context,{...base,authEndpoints:endpoints}),/auth endpoints/i,JSON.stringify(endpoints));
  // A bare origin would admit every POST on that port, and the runner rejects it.
  for(const authEndpoints of [['http://localhost:55888'],['http://localhost:55888/'],['http://localhost:55888/auth/v1/token','https://localhost']])await assert.rejects(f.manager.saveConfig(f.context,{...base,authEndpoints}),{message:'Auth endpoints need a path such as /auth/v1/token.'},JSON.stringify(authEndpoints));
  const reset=(await f.manager.saveConfig(f.context,base)).config;
  assert.deepEqual({journeyTimeoutSeconds:reset.journeyTimeoutSeconds,externalOrigins:reset.externalOrigins,authEndpoints:reset.authEndpoints},{journeyTimeoutSeconds:900,externalOrigins:[],authEndpoints:[]});
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=JSON.parse(await readFile(file,'utf8'));
  for(const config of Object.values<Record<string,unknown>>(state.configs)){delete config.journeyTimeoutSeconds;delete config.externalOrigins;delete config.authEndpoints;}
  await writeFile(file,JSON.stringify(state));
  const reopened=await f.reopen();
  const view=(await reopened.view(f.context)).config;
  assert.equal(view.journeyTimeoutSeconds,900,'A stored config without a time limit uses the default.');assert.deepEqual(view.externalOrigins,[]);
});

test('the sign-in page is optional, on the application URL’s origin without credentials, and keeps a hash route',async t=>{
  const f=await fixture(t);
  const base={targetUrl:'http://localhost:3000/'},save=(config:Record<string,unknown>)=>f.manager.saveConfig(f.context,{...base,...config});
  assert.equal((await save({})).config.signInUrl,'','None by default.');
  // A hash-routed application shows its form only on its hash route; an empty hash is no route.
  assert.equal((await save({signInUrl:'http://localhost:3000/#'})).config.signInUrl,'http://localhost:3000/');
  assert.equal((await save({signInUrl:'http://localhost:3000/#/login'})).config.signInUrl,'http://localhost:3000/#/login');
  assert.equal((await save({signInUrl:'http://localhost:3000/account/sign-in?next=%2Fapp'})).config.signInUrl,'http://localhost:3000/account/sign-in?next=%2Fapp');
  assert.equal((await f.manager.view(f.context)).config.signInUrl,'http://localhost:3000/account/sign-in?next=%2Fapp');
  for(const signInUrl of ['http://localhost:3001/login','https://localhost:3000/login','http://127.0.0.1:3000/login'])await assert.rejects(save({signInUrl}),{message:'Use a sign-in page on the application URL’s origin.'},signInUrl);
  for(const signInUrl of ['http://user:secret@localhost:3000/login','javascript:alert(1)','ftp://localhost:3000/login','/login','not a url',42,null])await assert.rejects(save({signInUrl}),{message:'Enter the sign-in page as an HTTP or HTTPS URL without credentials.'},String(signInUrl));
  // A long page, as typed or once normalized, as the settings dialog sends it, gets its own message.
  for(const signInUrl of [`http://localhost:3000/${'x'.repeat(2048)}`,`http://localhost:3000/${'ü'.repeat(1000)}`])await assert.rejects(save({signInUrl}),{message:'Use a sign-in page of at most 2048 characters.'},signInUrl.slice(0,30));
  // A person's save that moves the application URL to another origin cannot keep the old origin's sign-in page.
  await assert.rejects(save({targetUrl:'http://localhost:4000/',signInUrl:'http://localhost:3000/login'}),{message:'Use a sign-in page on the application URL’s origin.'});
  await assert.rejects(save({targetUrl:'',signInUrl:'http://localhost:3000/login'}),{message:'Use a sign-in page on the application URL’s origin.'});
  assert.deepEqual((({targetUrl,signInUrl})=>({targetUrl,signInUrl}))((await f.manager.view(f.context)).config),{targetUrl:'http://localhost:3000/',signInUrl:'http://localhost:3000/account/sign-in?next=%2Fapp'},'A refused save changes nothing.');
  // When a new twin of the same application moves the application URL to another origin, its sign-in page moves with it,
  // so the stage's journeys, which reuse its cases without discovery, still sign in.
  const twin=(id:string,url:string)=>({id,stageId:'beta',status:'ready',apps:[{id:'web',url}]});
  await save({targetUrl:''});
  await f.manager.prepareEnvironment(f.context,twin('twin-a','http://127.0.0.1:45123/'));
  await save({targetUrl:'http://127.0.0.1:45123/',signInUrl:'http://127.0.0.1:45123/login?next=%2Fapp#/form'});
  await f.manager.prepareEnvironment(f.context,twin('twin-b','http://127.0.0.1:45124/'));
  const moved=(await f.manager.view(f.context)).config;
  assert.deepEqual([moved.targetUrl,moved.signInUrl],['http://127.0.0.1:45124/','http://127.0.0.1:45124/login?next=%2Fapp#/form']);
  assert.ok((await readFile(join(f.dataDir,'browser','state.json'),'utf8')).includes('"signInUrl":"http://127.0.0.1:45124/login?next=%2Fapp#/form"'));
});

test('a moved sign-in page keeps its exact path on the new origin, a // path included, and outlives a twin without one application URL',async t=>{
  const f=await fixture(t);
  const twin=(id:string,...urls:string[])=>({id,stageId:'beta',status:'ready',apps:urls.map((url,index)=>({id:`app-${index}`,url}))});
  const config=async()=>(({targetUrl,signInUrl})=>({targetUrl,signInUrl}))((await f.manager.view(f.context)).config);
  await f.manager.saveConfig(f.context,{targetUrl:''});
  await f.manager.prepareEnvironment(f.context,twin('twin-a','http://127.0.0.1:45123/'));
  // A path that starts with // is a path, never another host.
  for(const [path,next] of [['//login','twin-b'],['//evil.example/login','twin-c']] as const){
    const from=(await config()).targetUrl,port=Number(new URL(from).port)+1;
    await f.manager.saveConfig(f.context,{targetUrl:from,signInUrl:`${from.slice(0,-1)}${path}`});
    await f.manager.prepareEnvironment(f.context,twin(next,`http://127.0.0.1:${port}/`));
    assert.deepEqual(await config(),{targetUrl:`http://127.0.0.1:${port}/`,signInUrl:`http://127.0.0.1:${port}${path}`});
  }
  const {run}=await f.manager.run(f.context,{},manual);
  assert.equal(run.status,'queued','The stage stays usable.');
  await f.manager.stop(f.context,run.id);await f.terminal(run.id);
  // A twin with no single application URL clears the target, and the next twin's gets the sign-in page back.
  await f.manager.saveConfig(f.context,{targetUrl:'http://127.0.0.1:45125/',signInUrl:'http://127.0.0.1:45125/account/sign-in?next=%2Fapp#/form'});
  await f.manager.prepareEnvironment(f.context,twin('twin-d','http://127.0.0.1:45200/','http://127.0.0.1:45201/'));
  assert.deepEqual(await config(),{targetUrl:'',signInUrl:''});
  await f.manager.prepareEnvironment(f.context,twin('twin-e','http://127.0.0.1:45300/'));
  assert.deepEqual(await config(),{targetUrl:'http://127.0.0.1:45300/',signInUrl:'http://127.0.0.1:45300/account/sign-in?next=%2Fapp#/form'});
});

test('each journey worker receives its code, run-only origins and its time limit, and nothing only discovery uses',async t=>{
  const long=journey('two',{steps:Array.from({length:12},(_,i)=>({id:`m${i}`,title:`Milestone ${i}`}))});
  const f=await fixture(t,[journey('one'),long],{maxSteps:100,journeyTimeoutSeconds:1200,externalOrigins:['https://checkout.stripe.com'],scope:'Billing only',requirements:'Credits never go negative'});
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===2);
  const [first,second]=f.workers.map(worker=>worker.input);
  assert.deepEqual(first.allowedOrigins,['http://localhost:3000','https://checkout.stripe.com']);
  assert.equal(first.timeoutSeconds,1200);assert.equal(second.spec.code,codeFor(long));
  assert.equal(first.authEndpoints,undefined);
  for(const key of ['scope','requirements','sourceContext','maxSteps','unavailableServices'])assert.equal(key in first,false,`${key} is discovery's.`);
  await f.manager.stop(f.context,run.id);for(const worker of f.workers)worker.gate.resolve();await f.terminal(run.id);
});

test('authenticated discovery takes a run-only account and auth endpoints, stays on the target and records whether it signed in',async t=>{
  const account={username:'discovery-fixture@example.test',password:'discovery-fixture-password'};
  const f=await fixture(t,[journey('one')],{externalOrigins:['https://checkout.stripe.com'],authEndpoints:['http://localhost:55888/auth/v1/token'],journeyTimeoutSeconds:600,scope:'Billing focus'});
  const drafts=[journey('found',{selected:false,needsReview:true,steps:credits.map(({id,title})=>({id,title}))})];
  let {run}=await f.manager.discover(f.context,{credentials:account});await until(()=>f.workers.length===1);
  const input=f.workers[0].input;
  assert.deepEqual(input.credentials,account);assert.deepEqual(input.authEndpoints,['http://localhost:55888/auth/v1/token']);
  assert.deepEqual(input.allowedOrigins,['http://localhost:3000'],'Discovery never navigates to external origins.');assert.equal(input.timeoutSeconds,600);assert.equal(input.scope,'Billing focus');
  f.workers[0].event({type:'discovery',cases:drafts,summary:`Signed in as ${account.username}. `+'Observed billing. '.repeat(300),authenticated:true});f.workers[0].gate.resolve();
  const discovered=await f.terminal(run.id);assert.equal(discovered.run.status,'completed');
  const {analysis}=await f.manager.view(f.context);assert.ok(analysis);
  assert.equal(analysis.authenticated,true);assert.equal(analysis.summary.length,4000,'The discovery summary limit matches the runner.');
  assert.ok(analysis.summary.startsWith(`Signed in as ${account.username}. Observed billing.`),'A summary naming the test account is kept as reported.');
  assert.ok(!(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).includes(account.password),'The account itself is never stored.');
  ({run}=await f.manager.discover(f.context,{}));await until(()=>f.workers.length===2);
  assert.equal(f.workers[1].input.credentials,undefined);assert.equal(f.workers[1].input.authEndpoints,undefined,'Auth endpoints are only opened for a supplied account.');
  f.workers[1].event({type:'discovery',cases:[],summary:'Public pages only',authenticated:true});f.workers[1].gate.resolve();await f.terminal(run.id);
  assert.equal((await f.manager.view(f.context)).analysis?.authenticated,false,'A worker cannot claim authentication without an account.');
});

test('discovery keeps where its account signed in as the sign-in page while the stage has none, as a path on the application’s origin',async t=>{
  const account={username:'discovery-fixture@example.test',password:'discovery-fixture-password'};
  const authEndpoints=['http://localhost:3000/signin'],f=await fixture(t,[journey('one')],{authEndpoints});
  const signInUrl=async()=>(await f.manager.view(f.context)).config.signInUrl;
  const discover=async(input:Record<string,unknown>,events:WorkerEvent[])=>{
    const {run}=await f.manager.discover(f.context,input),count=f.workers.length;await until(()=>f.workers.length===count+1);
    const worker=f.workers.at(-1)!;for(const event of events)worker.event(event);
    worker.event({type:'discovery',cases:[],summary:'Signed in',authenticated:true});worker.gate.resolve();
    assert.equal((await f.terminal(run.id)).run.status,'completed');
  };
  const page=(url:unknown)=>({type:'sign-in-page',caseId:'discovery',url});
  // Without an account nothing signed in.
  await discover({},[page('http://localhost:3000/account/login')]);
  assert.equal(await signInUrl(),'');
  // Another origin and anything but a URL are ignored, and so is a page with a hash, whose path alone may not show the
  // form, as on a hash route. A query, credentials and path parameters, such as a session id, are dropped; the first page
  // is kept.
  await discover({credentials:account},[page('http://localhost:3001/login'),page('https://localhost:3000/login'),page('not a url'),page(42),page(`http://localhost:3000/${'x'.repeat(2048)}`),
    page('http://localhost:3000/#/login'),page('http://localhost:3000/account/login?token=abc#form'),
    page('http://user:secret@localhost:3000/account;v=2/login;jsessionid=0123ABCD?token=abc'),page('http://localhost:3000/other')]);
  assert.equal(await signInUrl(),'http://localhost:3000/account/login');
  const stored=await readFile(join(f.dataDir,'browser','state.json'),'utf8');
  assert.ok(stored.includes('"signInUrl":"http://localhost:3000/account/login"')&&!stored.includes('token=abc')&&!stored.includes('0123ABCD')&&!stored.includes(account.password));
  // A session id dropped from the first segment leaves one leading slash, never a // path.
  for(const url of ['http://localhost:3000/;jsessionid=0123ABCD/login','http://localhost:3000//login']){
    await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/login',authEndpoints,signInUrl:''});
    await discover({credentials:account},[page(url)]);
    assert.equal(await signInUrl(),'http://localhost:3000/login',url);
  }
  // A person's value is never replaced.
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/login',authEndpoints,signInUrl:'http://localhost:3000/sign-in'});
  await discover({credentials:account},[page('http://localhost:3000/account/login')]);
  assert.equal(await signInUrl(),'http://localhost:3000/sign-in');
});

test('milestone transitions match the runner table and every rejection leaves progress unchanged',async t=>{
  const f=await fixture(t,[journey('one'),journey('two'),journey('three')]);
  const {run}=await f.manager.run(f.context,{concurrency:3},manual);await until(()=>f.workers.length===3);
  const [one,two,three]=f.workers,progress=async(id:string)=>(await f.report(run.id)).progress.cases.find(item=>item.id===id)!;
  const revision=async()=>(await f.report(run.id)).progress.revision;
  const rejects=async(worker:Worker,event:WorkerEvent,pattern:RegExp,note?:string)=>{const before=await revision();assert.throws(()=>worker.event(event),pattern,note?`${note} ${JSON.stringify(event)}`:JSON.stringify(event));assert.equal(await revision(),before,'A rejected report is not an accepted event.');};
  await rejects(one,step('one','start','blocked'),/order/);
  await rejects(one,step('one','start','failed',{checks:[{...passedChecks.start[0],passed:false}]}),/order/);
  await rejects(one,step('one','run','running'),/order/);
  await rejects(one,step('one','start','done'),/invalid journey step/);
  await rejects(one,step('one','unknown','running'),/invalid journey step/);
  await rejects(one,step('one','start','running',{evidence:'Opened the balance'}),/evidence/,'A start carries no evidence.');
  await rejects(one,step('one','start','running',{checks:passedChecks.start}),/checks/);
  one.event(step('one','start','running'));
  assert.deepEqual((await progress('one')).steps![0],{id:'start',title:credits[0].title,status:'running'});
  await rejects(one,step('one','start','running'),/order/,'A milestone starts once.');
  for(const evidence of [undefined,'','   ','x'.repeat(2001),'bad\u0007evidence'])await rejects(one,{...step('one','start','completed',{checks:passedChecks.start}),evidence},/evidence/,'The agent\'s evidence ends a milestone.');
  await rejects(one,step('one','start','completed'),/checks/,'Completion of a checked milestone needs its independent results.');
  await rejects(one,step('one','start','completed',{checks:[{...passedChecks.start[0],passed:false}]}),/checks/,'A failing check cannot be reported as completed.');
  await rejects(one,step('one','start','completed',{checks:[{...passedChecks.start[0],type:'text-visible'}]}),/checks/);
  await rejects(one,step('one','start','completed',{checks:[{...passedChecks.start[0],observed:'10'}]}),/checks/);
  await rejects(one,step('one','start','completed',{checks:[{...passedChecks.start[0],passed:'true'}]}),/checks/);
  await rejects(one,step('one','start','failed',{checks:passedChecks.start}),/checks/,'A milestone fails only from a failed independent check.');
  one.event(step('one','start','completed',{evidence:'e'.repeat(2000),checks:[{...passedChecks.start[0],label:'Injected label',error:null}]}));
  let saved=(await progress('one')).steps![0];
  assert.equal(saved.status,'completed');assert.equal('provenance' in saved,false,'The evidence comes from the reviewed checks.');
  assert.equal(saved.evidence,'e'.repeat(2000),'Milestone evidence is stored up to 2000 characters.');
  assert.deepEqual(saved.checks,[{type:'read-number',label:'Credits',name:'before',passed:true,observed:10,provenance:'independent'}],'Definitions come from the approved snapshot.');
  await rejects(one,step('one','start','running'),/order/,'Completed is terminal.');
  await rejects(one,step('one','run','completed',{checks:passedChecks.run}),/order/,'A milestone ends only after it started.');
  reach(one,'one','run','completed',{checks:passedChecks.run});
  assert.equal((await progress('one')).steps![1].status,'completed');
  await rejects(one,step('one','reopen','failed'),/order/,'Pending cannot fail directly.');
  one.event(step('one','reopen','running'));
  await rejects(one,step('one','reopen','failed'),/checks/,'A milestone without checks cannot fail.');
  one.event(step('one','reopen','blocked',{evidence:'Result page requires a paid plan'}));
  await rejects(one,step('one','reopen','running'),/order/,'Blocked is terminal.');
  reach(two,'two','start','completed',{checks:passedChecks.start});two.event(step('two','run','running'));
  two.event(step('two','run','failed',{checks:[passedChecks.run[0],{...passedChecks.run[1],passed:false,observed:10,error:'Credits did not decrease'}]}));
  saved=(await progress('two')).steps![1];
  assert.equal(saved.status,'failed');assert.deepEqual(saved.checks!.map(check=>[check.passed,check.provenance]),[[true,'independent'],[false,'independent']]);assert.equal(saved.checks![1].error,'Credits did not decrease');
  await rejects(two,step('two','reopen','running'),/order/,'Nothing follows a failed milestone.');
  three.event(step('three','start','running'));
  three.event(step('three','start','failed',{checks:[{...passedChecks.start[0],passed:false,error:'No number follows Credits'}]}));
  assert.equal((await progress('three')).steps![0].status,'failed','A partial check list may end at its first failure.');
  for(const [index,id] of ['one','two','three'].entries()){f.workers[index].event({type:'result',result:outcome(id)});f.workers[index].gate.resolve();}
  const completed=await f.terminal(run.id);
  assert.deepEqual(completed.results.map(item=>item.status),['blocked','failed','failed']);
  assert.match(completed.results[0].error!,/Reopen the result/);assert.match(completed.results[1].error!,/Run the workflow/);
  assert.equal(completed.run.status,'failed','A failed journey outranks a blocked one.');
});

test('blocked journeys roll up above review and are never counted as passed or failed',async t=>{
  const f=await fixture(t,[journey('happy'),journey('payment'),journey('settings')]);
  const {run}=await f.manager.run(f.context,{concurrency:3},manual);await until(()=>f.workers.length===3);
  f.complete(0,'happy');f.workers[0].event({type:'result',result:outcome('happy')});f.workers[0].gate.resolve();
  reach(f.workers[1],'payment','start','completed',{checks:passedChecks.start});
  f.workers[1].event({type:'result',result:{...outcome('payment'),blockers:[{stepId:'run',kind:'integration',evidence:'Stripe test keys are not configured in this sandbox'}]}});f.workers[1].gate.resolve();
  f.complete(2,'settings');f.workers[2].event({type:'result',result:{...outcome('settings'),assertions:[]}});f.workers[2].gate.resolve();
  const completed=await f.terminal(run.id);
  assert.deepEqual(completed.results.map(item=>item.status),['passed','blocked','needs_review']);
  assert.deepEqual(completed.results[1].blockers,[{stepId:'run',kind:'integration',evidence:'Stripe test keys are not configured in this sandbox'}]);
  assert.match(completed.results[1].error!,/Run the workflow and see credits decrease/);
  assert.equal(completed.run.status,'blocked');
  assert.deepEqual(completed.progress.cases.map(item=>item.status),['passed','blocked','needs_review']);
});

test('a timed-out worker is judged once from its milestones and any facts it reported, leaving no step running',async t=>{
  const f=await fixture(t,[journey('slow'),journey('checked'),journey('reported')]);
  const {run}=await f.manager.run(f.context,{concurrency:3},manual);await until(()=>f.workers.length===3);
  const timeout=()=>Object.assign(new Error('Browser operation exceeded its time limit.'),{timedOut:true});
  reach(f.workers[0],'slow','start','completed',{checks:passedChecks.start});f.workers[0].event(step('slow','run','running'));f.workers[0].gate.reject(timeout());
  f.workers[1].event(step('checked','start','running'));f.workers[1].event(step('checked','start','failed',{checks:[{...passedChecks.start[0],passed:false}]}));f.workers[1].gate.reject(timeout());
  // The runner reported its facts, then its cleanup outlasted the kill timer.
  f.complete(2,'reported');f.workers[2].event({type:'result',result:outcome('reported')});f.workers[2].gate.reject(timeout());
  const completed=await f.terminal(run.id);
  assert.deepEqual(completed.results[0],{caseId:'slow',status:'needs_review',engine:'playwright',assertions:[],error:'Journey exceeded its time limit.'});
  assert.deepEqual(completed.progress.cases[0].steps!.map(item=>item.status),['completed','unconfirmed','pending']);
  assert.equal(completed.results[1].status,'failed','A failed check still decides a timed-out journey.');
  assert.equal(completed.results[2].status,'passed','Facts reported before the kill timer still count.');
  assert.equal(completed.run.status,'failed');
});

test('the controller kill timer for a run fires only after its one journey’s own deadline',()=>{
  assert.equal(workerTimeoutMs({mode:'run',timeoutSeconds:900}),(900+15+30)*1000);
  assert.ok(workerTimeoutMs({mode:'run',timeoutSeconds:1800})>(1800+15)*1000);
  assert.equal(workerTimeoutMs({mode:'discover',timeoutSeconds:600}),615000);
});

test('blocked and timed-out journeys derive unreached final assertions and are never failed',async t=>{
  const f=await fixture(t,[journey('payment'),journey('slow'),journey('plan')]);
  const {run}=await f.manager.run(f.context,{concurrency:3},manual);await until(()=>f.workers.length===3);
  // The runner reports each final assertion as checked; the controller decides whether its end state was reached.
  const checked={type:'text-visible',value:'Run complete',passed:false},unreached={...checked,reached:false},evidence='Stripe test keys are not configured in this sandbox';
  reach(f.workers[0],'payment','start','completed',{checks:passedChecks.start});f.workers[0].event(step('payment','run','running'));f.workers[0].event(step('payment','run','blocked',{evidence}));
  f.workers[0].event({type:'result',result:{caseId:'payment',stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'uncertain',evidence:'Checkout never opened'}],assertions:[checked],blockers:[{stepId:'run',kind:'integration',evidence}]}});f.workers[0].gate.resolve();
  reach(f.workers[1],'slow','start','completed',{checks:passedChecks.start});f.workers[1].event(step('slow','run','running'));
  f.workers[1].event({type:'result',result:{caseId:'slow',stopCause:'deadline',agentCompleted:false,outcomes:[],assertions:[checked]}});f.workers[1].gate.resolve();
  // A blocked milestone without an agent blocker: only accepted progress shows the journey stopped short.
  f.workers[2].event(step('plan','start','running'));f.workers[2].event(step('plan','start','blocked',{evidence:'Free plan instead of the required paid plan'}));
  f.workers[2].event({type:'result',result:{caseId:'plan',stopCause:'none',agentCompleted:true,outcomes:[],assertions:[checked]}});f.workers[2].gate.resolve();
  const completed=await f.terminal(run.id);
  assert.deepEqual(completed.results.map(item=>item.status),['blocked','needs_review','blocked']);
  assert.deepEqual(completed.results.map(item=>item.assertions),[[unreached],[unreached],[unreached]]);
  assert.equal(completed.results[0].error,'Blocked at milestone: Run the workflow and see credits decrease.');assert.equal(completed.results[1].error,'Journey exceeded its time limit.');
  assert.equal(completed.results[2].error,'Blocked at milestone: Confirm the starting balance.');
  assert.deepEqual(completed.progress.cases[1].steps!.map(item=>item.status),['completed','unconfirmed','pending']);
  assert.equal(completed.run.status,'blocked','A blocked journey is never counted as failed.');
});

test('discovery keeps valid journeys, drops unsupplied citations and names omitted journeys in a bounded summary',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.discover(f.context,{});await until(()=>f.workers.length===1);
  const draft=(changes:Record<string,unknown>)=>journey('found',{selected:false,needsReview:true,isolation:undefined,steps:credits.map(({id,title})=>({id,title})),...changes});
  f.workers[0].event({type:'discovery',summary:'Observed billing. '.repeat(300),cases:[draft({evidence:[{path:'app.js',line:1},{path:'app.js',line:50}]}),draft({id:'short',name:'Single step',steps:[{id:'only',title:'Only step'}]})]});f.workers[0].gate.resolve();
  assert.equal((await f.terminal(run.id)).run.status,'completed');
  const {analysis,cases}=await f.manager.view(f.context);
  assert.deepEqual(cases.map(item=>[item.id,item.evidence]),[['one',[]],['found',[{path:'app.js',line:1}]]]);
  assert.equal(analysis!.summary.length,4000);assert.match(analysis!.summary,/\nOmitted “Single step”: Generated journeys need at least two ordered business steps\.$/);
  const next=await f.manager.discover(f.context,{});await until(()=>f.workers.length===2);
  f.workers[1].event({type:'discovery',summary:'',cases:[draft({id:'another'}),draft({id:'secret',name:'Secret input',goal:'Use [REDACTED] input'})]});f.workers[1].gate.resolve();
  assert.equal((await f.terminal(next.run.id)).run.status,'completed');
  assert.equal((await f.manager.view(f.context)).analysis!.summary,'Omitted “Secret input”: Redacted source content cannot be used as test input.','An empty agent summary stays empty.');
});

test('a discovery without an acceptable journey fails, retains every test and keeps its summary and omissions',async t=>{
  const account={username:'omission-fixture@example.test',password:'omission-fixture-password'};
  const f=await fixture(t,[journey('one')],{authEndpoints:['http://localhost:3000/signin']});
  const before=(await f.manager.view(f.context)).cases,error='No acceptable journeys were discovered. Existing tests were retained.';
  const draft=(changes:Record<string,unknown>={})=>journey('found',{selected:false,needsReview:true,isolation:undefined,steps:credits.map(({id,title})=>({id,title})),...changes});
  const summary=`Signed in as ${account.username}. Billing needs a paid plan.\nOmitted “Short ${account.password}”: Generated journeys need at least two ordered business steps.\nOmitted “Journey found”: Unsupported browser case field: note-${account.password}`;
  const runs:string[]=[];
  // Neither an added nor a replacing discovery changes the stored tests.
  for(const input of [{credentials:account},{credentials:account,replaceCaseIds:['one'],baseCases:before}]){
    const {run}=await f.manager.discover(f.context,input);runs.push(run.id);await until(()=>f.workers.length===runs.length);
    f.workers.at(-1)!.event({type:'discovery',summary:`Signed in as ${account.username}. Billing needs a paid plan.`,authenticated:true,cases:[
      draft({id:'short',name:`Short ${account.password}`,steps:[{id:'only',title:'Only step'}]}),
      {...draft(),[`note-${account.password}`]:'unsupported'},
    ]});
    f.workers.at(-1)!.gate.resolve();
    const report=await f.terminal(run.id);
    assert.equal(report.run.status,'failed');assert.equal(report.run.error,error);assert.equal(report.progress.cases[0].status,'failed');
    assert.deepEqual(report.discovery,{cases:[],summary,authenticated:true});
    const view=await f.manager.view(f.context);
    assert.deepEqual(view.cases,before,'Existing tests are retained and none are replaced.');
    assert.deepEqual({cases:view.analysis!.cases,summary:view.analysis!.summary,error:view.analysis!.error,authenticated:view.analysis!.authenticated},{cases:[],summary,error,authenticated:true});
    assert.equal(view.runs.find(item=>item.id===run.id)!.discovery!.summary,summary);
  }
  await f.manager.close();
  const reopened=await f.reopen();
  assert.equal((await reopened.runProgress(f.context,runs[1])).discovery!.summary,summary,'The failed discovery keeps its summary across restarts.');
  assert.equal((await reopened.view(f.context)).analysis!.error,error);
  const {run}=await reopened.discover(f.context,{});await until(()=>f.workers.length===3);
  f.workers[2].event({type:'discovery',summary:'Billing observed',cases:[draft()]});f.workers[2].gate.resolve();
  await until(async()=>(await reopened.runProgress(f.context,run.id)).run.status==='completed');
  const {analysis,cases}=await reopened.view(f.context);
  assert.equal(analysis!.error,undefined,'A later accepted discovery replaces the failed analysis.');assert.deepEqual(cases.map(item=>item.id),['one','found']);
});

test('uncertain cleanup after a timeout still fails the journey and quarantines instead of needing review',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);
  f.workers[0].gate.reject(Object.assign(new Error('Browser operation exceeded its time limit. Cleanup incomplete.'),{timedOut:true,cleanupIncomplete:true}));
  const completed=await f.terminal(run.id);assert.equal(completed.results[0].status,'failed');assert.equal(completed.run.status,'failed');
});

test('leftover running milestones become unconfirmed, skipped or cancelled at the end, never blocked',async t=>{
  const f=await fixture(t,[journey('review'),journey('skip'),journey('stop')]);
  let {run}=await f.manager.run(f.context,{concurrency:2},manual);await until(()=>f.workers.length===2);
  f.workers[0].event(step('review','start','running'));f.workers[0].event({type:'result',result:outcome('review')});f.workers[0].gate.resolve();
  f.workers[1].event(step('skip','start','running'));await f.manager.skip(f.context,run.id,'skip');f.workers[1].gate.resolve();
  await until(()=>f.workers.length===3);f.workers[2].event(step('stop','start','running'));await f.manager.stop(f.context,run.id);f.workers[2].gate.resolve();
  const completed=await f.terminal(run.id);
  assert.deepEqual(completed.progress.cases.map(item=>item.steps![0].status),['unconfirmed','skipped','cancelled']);
  assert.deepEqual(completed.results.map(item=>item.status),['needs_review','skipped','cancelled']);
  assert.match(completed.results[0].error!,/milestone/);
  assert.equal(completed.run.status,'needs_review');
});

test('progress revision, total action count, last action and worker capture time describe real activity',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);
  const worker=f.workers[0];
  const before=(await f.report(run.id)).progress.revision;assert.ok(typeof before==='number');assert.ok(before>=1,'Admission is a progress change.');
  const actions=Array.from({length:160},(_,index)=>({type:index===159?'input':'click',status:index===159?'failed':'passed',...(index===159?{errorCode:'navigation_not_allowed'}:{})}));
  worker.event({type:'case',caseId:'one',status:'running',actions});
  let current=(await f.report(run.id)).progress;
  assert.equal(current.revision,before+1);assert.equal(current.cases[0].actions.length,150);assert.equal(current.cases[0].actionCount,160);
  assert.deepEqual(current.cases[0].lastAction,{type:'input',status:'failed'});assert.equal(current.cases[0].actions.at(-1)!.errorCode,'navigation_not_allowed');
  const jpeg=Buffer.from([0xff,0xd8,7,0xff,0xd9]).toString('base64'),captured=Date.now()-1500;
  worker.event({type:'frame',caseId:'one',data:jpeg,timestamp:captured});
  current=(await f.report(run.id)).progress;
  assert.equal(current.revision,before+2);assert.equal(current.cases[0].frameCapturedAt,new Date(captured).toISOString());
  assert.ok(Date.parse(current.cases[0].frameUpdatedAt!)>=captured,'Receipt time is kept separately.');
  for(const timestamp of ['1',1.5,Date.now()+120000,Date.parse((await f.report(run.id)).run.createdAt)-120000])assert.throws(()=>worker.event({type:'frame',data:jpeg,timestamp}),/timestamp/);
  assert.equal((await f.report(run.id)).progress.revision,before+2);
  worker.event({type:'status',status:'ready'});assert.equal((await f.report(run.id)).progress.revision,before+2,'Ignored worker events do not change progress.');
  worker.event({type:'case',caseId:'one',status:'running',actions:[]});
  current=(await f.report(run.id)).progress;assert.equal(current.cases[0].actionCount,0);assert.equal(current.cases[0].lastAction,undefined);
  const last=current.revision;assert.ok(typeof last==='number');
  f.complete(0,'one');worker.event({type:'result',result:outcome('one')});worker.gate.resolve();
  const completed=await f.terminal(run.id);assert.equal(completed.run.status,'passed');assert.ok(typeof completed.progress.revision==='number'&&completed.progress.revision>last);
});

test('effective concurrency is limited by a shared account or shared data and records the reason',async t=>{
  const cases=(...isolation:string[])=>isolation.map((value,index)=>({id:String(index),isolation:value}));
  assert.deepEqual(journeyConcurrency({cases:cases('isolated','isolated','isolated'),concurrency:2}),{effectiveConcurrency:2,concurrencyLimit:null});
  assert.deepEqual(journeyConcurrency({cases:cases('isolated','isolated'),concurrency:4}),{effectiveConcurrency:2,concurrencyLimit:null});
  assert.deepEqual(journeyConcurrency({cases:cases('isolated','isolated','shared'),concurrency:4}),{effectiveConcurrency:2,concurrencyLimit:'shared-data'});
  assert.deepEqual(journeyConcurrency({cases:cases('shared','shared'),concurrency:2}),{effectiveConcurrency:1,concurrencyLimit:'shared-data'});
  assert.deepEqual(journeyConcurrency({cases:cases('isolated','shared'),concurrency:2}),{effectiveConcurrency:1,concurrencyLimit:'shared-data'});
  assert.deepEqual(journeyConcurrency({cases:cases('isolated','isolated'),concurrency:2,account:true}),{effectiveConcurrency:1,concurrencyLimit:'account'});
  assert.deepEqual(journeyConcurrency({cases:cases('isolated'),concurrency:2}),{effectiveConcurrency:1,concurrencyLimit:null},'One journey is not limited.');
  assert.deepEqual(journeyConcurrency({cases:cases('shared','shared'),concurrency:1}),{effectiveConcurrency:1,concurrencyLimit:null},'A serial choice is not limited.');
  const f=await fixture(t,[journey('one'),journey('two',{isolation:'shared'})]);
  const {run}=await f.manager.run(f.context,{concurrency:2},manual);
  assert.equal(run.effectiveConcurrency,1);assert.equal(run.concurrencyLimit,'shared-data');
  assert.equal(f.manager.summary(f.context).runs[0].concurrencyLimit,'shared-data');
  await until(()=>f.workers.length===1);
  assert.equal((await f.report(run.id)).progress.cases[1].queueReason,'shared-data','Without a test account, shared data is the wait.');await f.manager.stop(f.context,run.id);f.workers[0].gate.resolve();await f.terminal(run.id);
});

test('graph summaries carry progress only for active runs and each case latest run, without action lists',async t=>{
  const f=await fixture(t,[journey('one'),journey('two')]);
  const finish=async(index:number,id:string)=>{f.complete(index,id);f.workers[index].event({type:'result',result:outcome(id)});f.workers[index].gate.resolve();};
  let started=await f.manager.run(f.context,{caseIds:['one']},manual);await until(()=>f.workers.length===1);await finish(0,'one');await f.terminal(started.run.id);const old=started.run.id;
  started=await f.manager.run(f.context,{caseIds:['one']},manual);await until(()=>f.workers.length===2);await finish(1,'one');await f.terminal(started.run.id);const latest=started.run.id;
  started=await f.manager.run(f.context,{caseIds:['two']},manual);await until(()=>f.workers.length===3);
  f.workers[2].event({type:'case',caseId:'two',status:'running',actions:[{type:'navigate',status:'passed'},{type:'click',status:'running'}]});
  f.workers[2].event({type:'frame',caseId:'two',data:Buffer.from([0xff,0xd8,1,0xff,0xd9]).toString('base64'),timestamp:Date.now()});
  const runs=Object.fromEntries(f.manager.summary(f.context).runs.map(item=>[item.id,item]));
  assert.equal(runs[old].progress,undefined,'An older run of the same case is summarized without progress.');
  assert.equal(runs[latest].progress!.cases[0].steps!.length,3);
  const live=runs[started.run.id].progress!.cases[0];
  assert.equal('actions' in live,false);assert.equal(live.actionCount,2);assert.deepEqual(live.lastAction,{type:'click',status:'running'});
  assert.ok(live.frameUpdatedAt&&live.frameCapturedAt);const revision=runs[started.run.id].progress?.revision;assert.ok(typeof revision==='number'&&revision>0);assert.ok(runs[started.run.id].frameCapturedAt);
  assert.equal((await f.report(started.run.id)).progress.cases[0].actions.length,2,'Full progress remains available.');
  await finish(2,'two');await f.terminal(started.run.id);
});

test('case writes may overlap a test run snapshot but never discovery or another case write',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{},manual);await until(()=>f.workers.length===1);
  const current=(await f.manager.view(f.context)).cases;
  const edited=await f.manager.saveCases(f.context,[{...current[0],name:'Edited during run'},journey('added',{selected:false})],current);
  assert.equal(edited.cases.length,2);
  await assert.rejects(f.manager.draft(f.context,'Pay for credits and verify the balance increases.'),/OpenRouter API key/,'Drafting is admitted during a test run.');
  assert.equal((await f.report(run.id)).run.caseSummaries[0].name,'Journey one','The running snapshot is immutable.');
  await assert.rejects(f.manager.run(f.context,{},manual),/in progress/);
  f.complete(0,'one');f.workers[0].event({type:'result',result:outcome('one')});f.workers[0].gate.resolve();await f.terminal(run.id);
  const discovery=await f.manager.discover(f.context,{});await until(()=>f.workers.length===2);
  const cases=(await f.manager.view(f.context)).cases;
  await assert.rejects(f.manager.saveCases(f.context,cases,cases),/in progress/);
  await assert.rejects(f.manager.draft(f.context,'Change settings and restore them.'),/in progress/);
  await f.manager.stop(f.context,discovery.run.id);f.workers[1].gate.resolve();await f.terminal(discovery.run.id);
  await assert.rejects(f.manager.saveCases(f.context,[journey('empty',{steps:[]})]),/2–12 milestones/);
  await assert.rejects(f.manager.saveCases(f.context,[journey('long',{steps:Array.from({length:13},(_,i)=>({id:`m${i}`,title:`Milestone ${i}`}))})]),/12 journey steps/);
});

test('restart recovery cancels unstarted journeys, fails interrupted ones, finishes skips and appends matching results',async t=>{
  const f=await fixture(t,[journey('running'),journey('queued'),journey('skipping'),journey('done')]);
  const {run}=await f.manager.run(f.context,{concurrency:4},manual);await until(()=>f.workers.length===4);
  for(const [index,id] of ['running','queued','skipping','done'].entries()){f.complete(index,id);f.workers[index].event({type:'result',result:outcome(id)});f.workers[index].gate.resolve();}
  await f.terminal(run.id);await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=JSON.parse(await readFile(file,'utf8')),saved=state.runs[0];
  saved.status='running';delete saved.completedAt;saved.results=saved.results.filter((item:{caseId:string})=>item.caseId==='done');
  const [running,queued,skipping]=saved.progress.cases;
  Object.assign(running,{status:'running'});running.steps[1].status='running';running.steps[2].status='pending';
  Object.assign(queued,{status:'queued',queueReason:'browser'});for(const item of queued.steps)item.status='pending';
  Object.assign(skipping,{status:'skipping'});skipping.steps[1].status='running';skipping.steps[2].status='pending';
  const revision=saved.progress.revision;await writeFile(file,JSON.stringify(state));
  const reopened=await f.reopen();
  const recovered=await reopened.runProgress(f.context,run.id);
  assert.equal(recovered.run.status,'failed');
  assert.deepEqual(recovered.progress.cases.map(item=>item.status),['failed','cancelled','skipped','passed']);
  assert.deepEqual(recovered.progress.cases.map(item=>item.steps!.map(value=>value.status)),[['completed','unconfirmed','pending'],['pending','pending','pending'],['completed','skipped','pending'],['completed','completed','completed']]);
  assert.deepEqual(recovered.results.map(item=>[item.caseId,item.status]),[['running','failed'],['queued','cancelled'],['skipping','skipped'],['done','passed']]);
  assert.equal(recovered.results[1].error,'Controller stopped before this journey started');
  assert.match(recovered.results[0].error!,/controller stopped/i);assert.equal(recovered.results[2].error,undefined);
  assert.ok(typeof recovered.progress.revision==='number'&&recovered.progress.revision>revision);
});

test('evidence naming the test account is kept as reported, with its blocker kinds and check operators',async t=>{
  const f=await fixture(t,[journey('one')]);
  const {run}=await f.manager.run(f.context,{credentials:{username:'account',password:'<'}},manual);await until(()=>f.workers.length===1);
  const evidence='Signed in as account; balance < limit. '.repeat(45).slice(0,1990);
  reach(f.workers[0],'one','start','completed',{evidence,checks:passedChecks.start});
  f.workers[0].event(step('one','run','running'));
  f.workers[0].event(step('one','run','failed',{checks:[passedChecks.run[0],{...passedChecks.run[1],passed:false,observed:10}]}));
  f.workers[0].event({type:'result',result:{...outcome('one'),blockers:[{stepId:'run',kind:'account',evidence:'The account plan differs'}]}});f.workers[0].gate.resolve();
  const completed=await f.terminal(run.id),steps=completed.progress.cases[0].steps!;
  const compared=steps[1].checks![1];
  assert.equal(steps[0].evidence,evidence);assert.equal(compared.type==='compare-number'&&compared.op,'<');
  assert.equal(completed.results[0].status,'failed');assert.deepEqual(completed.results[0].blockers!.map(item=>item.kind),['account']);
});

test('the agent runtime marks only its own time limit, discovers only, and discovery may carry a run-only account',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'perpetual-journey-timeout-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const runner=join(folder,'runner.mjs');await writeFile(runner,'process.stdin.resume();setInterval(()=>{},1000);');
  const runtime=createBrowserRuntime({python:process.execPath,runner,env:{PERPETUAL_MODEL_API_KEY:'fixture-only',PERPETUAL_MODEL:'fixture'}});
  assert.throws(()=>runtime.start({mode:'run'},()=>{}),/only discovers journeys/,'Runs execute Playwright code, never the agent.');
  let job=runtime.start({mode:'discover'},()=>{},{timeoutMs:50,cleanupGraceMs:2000});
  await assert.rejects(job.promise,(error:WorkerError)=>error.timedOut===true&&/time limit/.test(error.message)&&!error.cleanupIncomplete);
  job=runtime.start({mode:'discover'},()=>{},{timeoutMs:5000,cleanupGraceMs:2000});job.cancel();
  await assert.rejects(job.promise,(error:WorkerError)=>error.timedOut===undefined&&/cancelled/.test(error.message));
  job=runtime.start({mode:'discover',credentials:{username:'u@example.test',password:'p'}},()=>{},{timeoutMs:5000,cleanupGraceMs:2000});job.cancel();
  await assert.rejects(job.promise,/cancelled/);
  assert.throws(()=>runtime.start({mode:'preflight',credentials:{username:'u@example.test',password:'p'}},()=>{}),/test account/);
});
