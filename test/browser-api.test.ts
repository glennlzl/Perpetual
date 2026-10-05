import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../src/server.ts';

test('browser API uses controller session and source/stage scope, keeps provider key private, and persists without Docker',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-api-')),repo=join(dataDir,'repo');await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  let app=await startServer({port:0,repo,dataDir});t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  let token=(await(await fetch(app.url+'/api/session')).json()).token;
  async function request(path:string,body?:unknown,headers:Record<string,string>={}){const response=await fetch(app.url+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','X-Perpetual-Token':token}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
  assert.equal((await request('/api/scan',{path:repo})).status,200);
  const stage=(await request('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).body.pipeline.stages.find((item:{id:string;name:string})=>item.name==='Beta').id;
  const query=new URLSearchParams({repoPath:repo,stageId:stage}),context={repoPath:repo,stageId:stage};
  assert.equal((await request(`/api/browser?${query}`,undefined,{Origin:'https://other.example'})).status,403);
  for(const operation of ['model','config','cases','discover','run','stop'])assert.equal((await request(`/api/browser/${operation}`,context,{'X-Perpetual-Token':'wrong'})).status,403);
  assert.equal((await request('/api/browser/config',{...context,stageId:'production',config:{targetUrl:'http://localhost:3000'}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,repoPath:'/not-active',config:{targetUrl:'http://localhost:3000'}})).status,409);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:app.url}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',externalOrigins:['https://checkout.stripe.com/pay']}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',authEndpoints:['http://elsewhere.test/auth']}})).status,400);
  const journeyConfig=await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',journeyTimeoutSeconds:600,externalOrigins:['https://checkout.stripe.com'],authEndpoints:['http://localhost:55888/auth/v1/token']}});
  assert.equal(journeyConfig.status,200);assert.deepEqual([journeyConfig.body.config.journeyTimeoutSeconds,journeyConfig.body.config.externalOrigins,journeyConfig.body.config.authEndpoints],[600,['https://checkout.stripe.com'],['http://localhost:55888/auth/v1/token']]);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000'}})).status,200);
  const invalidAccount=await request('/api/browser/run',{...context,credentials:{username:'private-login-fixture-only'}});
  assert.equal(invalidAccount.status,400);assert.match(invalidAccount.body.error,/test account/i);
  assert.equal(JSON.stringify(invalidAccount).includes('private-login-fixture-only'),false);
  const key='private-openrouter-fixture-only';
  const configured=await request('/api/browser/model',{...context,apiKey:key});assert.equal(configured.status,200);assert.equal(configured.body.capabilities.model,'openai/gpt-6-luna');assert.equal(JSON.stringify(configured).includes(key),false);
  let view=await request(`/api/browser?${query}`);assert.equal(view.body.config.targetUrl,'http://localhost:3000/');assert.equal(view.body.capabilities.keyConfigured,true);assert.equal(JSON.stringify(view).includes(key),false);
  assert.equal((await request(`/api/browser/runs/00000000-0000-0000-0000-000000000000/frame?${query}`)).status,404);
  const recording=`/api/browser/runs/00000000-0000-0000-0000-000000000000/video?${new URLSearchParams({...context,caseId:'x',file:`page@${'0'.repeat(32)}.webm`})}`;
  assert.equal((await request(recording)).status,404);
  assert.equal((await request(recording,undefined,{Origin:'https://other.example'})).status,403);
  const original={id:'checkout',name:'Complete checkout',goal:'Buy a product',expectedOutcomes:['Order saved'],needsReview:true,selected:false};
  const saved=await request('/api/browser/cases',{...context,cases:[original]});assert.equal(saved.status,200);
  const baseCases=saved.body.cases;
  const newer=await request('/api/browser/cases',{...context,cases:[...baseCases,{...original,id:'refund',name:'Complete refund'}],baseCases});assert.equal(newer.status,200);
  const stale=await request('/api/browser/cases',{...context,cases:[{...baseCases[0],needsReview:false}],baseCases});assert.equal(stale.status,409);assert.match(stale.body.error,/changed/i);
  assert.deepEqual((await request(`/api/browser?${query}`)).body.cases,newer.body.cases);
  await app.close();app=await startServer({port:0,repo,dataDir});token=(await(await fetch(app.url+'/api/session')).json()).token;
  view=await request(`/api/browser?${query}`);assert.equal(view.body.capabilities.keyConfigured,true);assert.equal(view.body.config.targetUrl,'http://localhost:3000/');assert.deepEqual(view.body.runs,[]);assert.deepEqual(view.body.cases,newer.body.cases);
});

test('journey specs are saved and approved through the stage API',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-specs-api-')),repo=join(dataDir,'repo');await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  const app=await startServer({port:0,repo,dataDir});t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const token=(await(await fetch(app.url+'/api/session')).json()).token;
  async function request(path:string,body:unknown,headers:Record<string,string>={}){const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token,...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
  await request('/api/scan',{path:repo});
  const stageId=(await request('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).body.pipeline.stages.find((item:{id:string;name:string})=>item.name==='Beta').id,context={repoPath:repo,stageId};
  await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000'}});
  const item={id:'rename',name:'Rename',goal:'Rename the workspace',steps:[{id:'open',title:'Open Settings'},{id:'rename',title:'Rename it'}],expectedOutcomes:['Renamed'],assertions:[{type:'text-visible',value:'Renamed'}],needsReview:false,selected:true};
  assert.equal((await request('/api/browser/cases',{...context,cases:[item]})).status,200);
  const code="import { test } from 'perpetual';\ntest('Rename', async ({ journey }) => {\n  await journey.milestone('open', async () => {});\n  await journey.milestone('rename', async () => {});\n});\n";
  for(const operation of ['specs','specs/approve','specs/discard','specs/verify','specs/verify/cancel','specs/generate','specs/generate/cancel'])assert.equal((await request(`/api/browser/${operation}`,{...context,caseId:item.id,code},{'X-Perpetual-Token':'wrong'})).status,403);
  assert.equal((await request('/api/browser/specs',{...context,caseId:item.id,code:code.replace("'open'","'other'")})).status,400);
  const saved=await request('/api/browser/specs',{...context,caseId:item.id,code}),hash=saved.body.spec.draft?.hash;
  assert.equal(saved.status,200);assert.deepEqual(saved.body.spec,{caseId:item.id,draft:{hash,stale:false}});
  assert.equal((await request('/api/browser/specs/approve',{...context,caseId:item.id,hash:'0'.repeat(64)})).status,409);
  assert.equal((await request('/api/browser/specs/approve',{...context,caseId:'missing',hash})).status,404);
  // A draft is approved only after its verification: three passing runs and a caught control run.
  const unverified=await request('/api/browser/specs/approve',{...context,caseId:item.id,hash});
  assert.equal(unverified.status,409);assert.match(unverified.body.error,/three passing runs and a caught control run/);
  assert.equal((await request('/api/browser/specs/verify',{...context,caseId:item.id,hash:'0'.repeat(64)})).status,409);
  assert.equal((await request('/api/browser/specs/verify/cancel',{...context,caseId:item.id})).status,404);
  const view=await(await fetch(`${app.url}/api/browser?${new URLSearchParams(context)}`)).json();
  assert.deepEqual(view.specs,{[item.id]:{draft:{hash,stale:false}}});assert.equal(JSON.stringify(view).includes('journey.milestone'),false,'The view never carries spec code.');
  // The code itself is read for review from the same scope, and only from this origin.
  const reading=`${app.url}/api/browser/specs/code?${new URLSearchParams({...context,caseId:item.id})}`;
  assert.deepEqual(await(await fetch(reading)).json(),{draft:{hash,code}});
  assert.equal((await fetch(reading,{headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(`${app.url}/api/browser/specs/code?${new URLSearchParams({...context,caseId:'missing'})}`)).status,404);
  assert.equal((await request('/api/browser/specs/discard',{...context,caseId:item.id,hash:'0'.repeat(64)})).status,409);
  const discarded=await request('/api/browser/specs/discard',{...context,caseId:item.id,hash});
  assert.equal(discarded.status,200);assert.deepEqual(discarded.body.specs,{});
  // Generation needs a reviewed case, a model and the stage's ready twin; it never starts on its own.
  assert.equal((await request('/api/browser/specs/generate',{...context,caseId:'missing'})).status,404);
  const noModel=await request('/api/browser/specs/generate',{...context,caseId:item.id});
  assert.equal(noModel.status,400);assert.match(noModel.body.error,/OpenRouter API key/);
  const invalidGenerationAccount=await request('/api/browser/specs/generate',{...context,caseId:item.id,credentials:{username:'tester@example.test'}});
  assert.equal(invalidGenerationAccount.status,400);assert.match(invalidGenerationAccount.body.error,/test account/i);
  const mixedGenerationAccounts=await request('/api/browser/specs/generate',{...context,caseId:item.id,credentials:{username:'tester@example.test',password:'fixture-only'},accountId:null});
  assert.equal(mixedGenerationAccounts.status,400);assert.match(mixedGenerationAccounts.body.error,/Choose one test account/);
  assert.equal((await request('/api/browser/specs/generate/cancel',{...context,caseId:item.id})).status,404);
});

test('HTTP verification carries the temporary account through three real browser runs and a caught control',async t=>{
  const {createServer}=await import('node:http');
  const {createPlaywrightRuntime}=await import('../src/journeys/playwright/runtime.ts');
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-verify-account-')),repo=join(dataDir,'repo');
  await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  let notes=0;
  const application=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const redirect=(location:string,headers:Record<string,string>={})=>{res.writeHead(303,{location,...headers});res.end();};
      const html=(value:string)=>{res.writeHead(200,{'content-type':'text/html'});res.end(value);};
      if(req.url==='/login'&&req.method==='POST'){
        const form=new URLSearchParams(body);
        return form.get('email')==='tester@example.test'&&form.get('password')==='account-fixture-only'
          ?redirect('/notes',{'set-cookie':'session=1; Path=/'}) :redirect('/login');
      }
      if(req.url==='/login')return html('<form method="post" action="/login"><label>Email<input name="email" type="email" autocomplete="username"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>');
      if(!/session=1/.test(req.headers.cookie??''))return redirect('/login');
      if(req.url==='/notes'&&req.method==='POST'){notes++;return redirect('/notes');}
      html(`<p>Notes ${notes}</p><form method="post" action="/notes"><button>Add note</button></form>`);
    });
  });
  await new Promise<void>(resolve=>application.listen(0,'127.0.0.1',resolve));
  const address=application.address();assert.ok(address&&typeof address==='object');
  const app=await startServer({port:0,repo,dataDir,browser:{playwright:createPlaywrightRuntime({checkTimeoutMs:1000})}});
  t.after(async()=>{await app.close();application.closeAllConnections();await new Promise<void>(resolve=>application.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});});
  const {token}=await(await fetch(app.url+'/api/session')).json();
  const post=async(path:string,body:unknown)=>{const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  await post('/api/scan',{path:repo});
  const added=await post('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'});
  const context={repoPath:repo,stageId:added.body.pipeline.stages.find((stage:{name:string})=>stage.name==='Beta').id};
  const item={id:'notes',name:'Create a note',goal:'Save a note and see its count increase after reload',isolation:'shared',needsReview:false,selected:true,expectedOutcomes:['A saved note'],steps:[{id:'open',title:'Sign in',checks:[{type:'read-number',label:'Notes',name:'before'}]},{id:'save',title:'Save and reload',checks:[{type:'compare-number',label:'Notes',name:'after',op:'>',than:'before'}]}]};
  await post('/api/browser/config',{...context,config:{targetUrl:`http://127.0.0.1:${address.port}/notes`,journeyTimeoutSeconds:60}});
  assert.equal((await post('/api/browser/cases',{...context,cases:[item]})).status,200);
  // Clicking commits the form's navigation before its document finishes loading. Finish that navigation before
  // reloading; the write-blocked control keeps its already-loaded document and still fails the same reviewed check.
  const code="import { test } from 'perpetual'; test('Create a note', async ({ page, journey }) => { await journey.milestone('open', async () => { await journey.signIn(); }); await journey.milestone('save', async () => { await page.getByRole('button', { name: 'Add note' }).click(); await page.waitForLoadState('load'); await page.reload(); }); });";
  const saved=await post('/api/browser/specs',{...context,caseId:item.id,code}),hash=saved.body.spec.draft.hash;
  const credentials={username:'tester@example.test',password:'account-fixture-only'};
  const accepted=await post('/api/browser/specs/verify',{...context,caseId:item.id,hash,credentials});assert.equal(accepted.status,202);
  let view;
  for(let attempt=0;attempt<900;attempt++){
    view=await(await fetch(app.url+'/api/browser?'+new URLSearchParams(context))).json();
    const status=view.specs[item.id].draft.verification.status;
    if(!['queued','running'].includes(status))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const verification=view.specs[item.id].draft.verification;
  assert.equal(verification.status,'passed',JSON.stringify(verification));
  assert.equal(verification.passes,3);assert.equal(verification.control,'caught');
  assert.equal((await post('/api/browser/specs/approve',{...context,caseId:item.id,hash})).status,200);
  assert.doesNotMatch(JSON.stringify(view),/account-fixture-only/,'Temporary credentials never enter the response');
  const {readFile}=await import('node:fs/promises');
  assert.doesNotMatch(await readFile(join(dataDir,'browser','state.json'),'utf8'),/account-fixture-only/,'Temporary credentials never enter saved browser state');
});
