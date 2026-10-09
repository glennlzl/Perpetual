import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,stat,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserModelSettings} from '../src/browser/model.ts';
import {checkOpenRouterKey,createOpenRouterModelCatalog} from '../src/browser/openrouter-models.ts';
import {createBrowserManager} from '../src/browser/manager.ts';

test('OpenRouter key is persisted privately, omitted from view, and retained during model changes',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-model-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir,env:{}});
  assert.equal(model.view().keyConfigured,false);
  await model.save({apiKey:'openrouter-private-fixture'});
  assert.equal(model.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
  assert.equal(model.environment().PERPETUAL_MODEL,'openai/gpt-6-luna');
  assert.equal(JSON.stringify(model.view()).includes('private-fixture'),false);
  assert.equal((await stat(join(dataDir,'browser-model.json'))).mode&0o777,0o600);
  await model.save({model:'anthropic/claude-sonnet-4.6'});
  assert.equal(model.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
  await assert.rejects(model.save({model:'typesafe/jev-1'}),/decisions API/);
  await assert.rejects(model.save({baseUrl:'http://example.com'}),/HTTPS/);
  assert.equal(JSON.parse(await readFile(join(dataDir,'browser-model.json'),'utf8')).model,'anthropic/claude-sonnet-4.6');
  const restored=await createBrowserModelSettings({dataDir,env:{}});assert.equal(restored.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
});

test('a key the environment supplies is never saved, and a saved key never follows a new endpoint',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-model-key-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const file=join(dataDir,'browser-model.json');
  const exported=await createBrowserModelSettings({dataDir,env:{OPENROUTER_API_KEY:'environment-fixture-one'}});
  await exported.saveOpenRouter({model:'anthropic/claude-sonnet-4.6'});
  assert.equal(JSON.parse(await readFile(file,'utf8')).apiKey,undefined,'Choosing a model does not copy the exported key to disk.');
  assert.equal(exported.configuration().apiKey,'environment-fixture-one');
  const rotated=await createBrowserModelSettings({dataDir,env:{OPENROUTER_API_KEY:'environment-fixture-two'}});
  assert.deepEqual([rotated.configuration().apiKey,rotated.configuration().model,rotated.view().modelConfigured],['environment-fixture-two','anthropic/claude-sonnet-4.6',true],'A rotated exported key takes effect.');
  // The exported key is for its own endpoint only.
  await assert.rejects(rotated.save({baseUrl:'https://other-provider.example/v1'}),/API key/);
  await rotated.saveOpenRouter({apiKey:'entered-fixture-only',model:'anthropic/claude-sonnet-4.6'});
  assert.equal(JSON.parse(await readFile(file,'utf8')).apiKey,'entered-fixture-only','An entered key is saved.');
  await assert.rejects(rotated.save({baseUrl:'https://other-provider.example/v1'}),/Enter the API key for the new model API URL/);
  assert.equal(JSON.parse(await readFile(file,'utf8')).baseUrl,'https://openrouter.ai/api/v1','A refused endpoint change saves nothing.');
  await rotated.save({apiKey:'other-fixture-only',baseUrl:'https://other-provider.example/v1'});
  assert.deepEqual([rotated.configuration().apiKey,rotated.configuration().baseUrl],['other-fixture-only','https://other-provider.example/v1']);
  await rotated.save({baseUrl:'https://other-provider.example/v2'});
  assert.equal(rotated.configuration().apiKey,'other-fixture-only','A path on the same host keeps its key.');
});

test('an exported key stays with its endpoint however the environment writes the address',async t=>{
  for(const baseUrl of ['https://API.example.com/v1','https://api.example.com:443/v1/']){
    const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-model-endpoint-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
    const env={PERPETUAL_MODEL_API_KEY:'exported-fixture-only',PERPETUAL_MODEL_BASE_URL:baseUrl};
    await (await createBrowserModelSettings({dataDir,env})).save({model:'vendor/chat'});
    assert.equal(JSON.parse(await readFile(join(dataDir,'browser-model.json'),'utf8')).apiKey,undefined,baseUrl);
    const restored=await createBrowserModelSettings({dataDir,env});
    assert.deepEqual([restored.configuration().apiKey,restored.configuration().baseUrl,restored.view().modelConfigured],['exported-fixture-only','https://api.example.com/v1',true],baseUrl);
  }
});

test('generic provider credentials require an explicit model while an empty install shows OpenRouter defaults',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-generic-model-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const generic=await createBrowserModelSettings({dataDir,env:{PERPETUAL_MODEL_API_KEY:'generic-private-fixture'}});
  assert.equal(generic.view().keyConfigured,true);
  assert.equal(generic.view().modelConfigured,false);
  assert.equal(generic.view().model,'');
  assert.equal(generic.environment().PERPETUAL_MODEL,'');
  assert.equal(generic.environment().PERPETUAL_MODEL_BASE_URL,'https://api.openai.com/v1');
  const empty=await createBrowserModelSettings({dataDir,env:{}});
  assert.equal(empty.view().model,'openai/gpt-6-luna');
  assert.equal(empty.view().baseUrl,'https://openrouter.ai/api/v1');
  assert.equal(empty.view().modelConfigured,false);
  const openRouter=await createBrowserModelSettings({dataDir,env:{OPENROUTER_API_KEY:'openrouter-private-fixture'}});
  assert.equal(openRouter.environment().PERPETUAL_MODEL,'openai/gpt-6-luna');
  assert.equal(openRouter.view().modelConfigured,true);
});

test('generic credentials do not inherit the OpenRouter model or endpoint when both keys exist',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-model-precedence-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir,env:{PERPETUAL_MODEL_API_KEY:'generic-fixture-only',OPENROUTER_API_KEY:'router-fixture-only'}});
  assert.equal(model.view().modelConfigured,false);
  assert.match(model.view().modelError!,/model ID/i);
  assert.equal(model.environment().PERPETUAL_MODEL,'');
  assert.equal(model.environment().PERPETUAL_MODEL_BASE_URL,'https://api.openai.com/v1');
  assert.doesNotMatch(JSON.stringify(model.view()),/generic-fixture-only|router-fixture-only/);
});

test('saved settings that are not text configure no model and show no value',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-model-invalid-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await writeFile(join(dataDir,'browser-model.json'),JSON.stringify({apiKey:12345,model:{id:'x'},baseUrl:['https://x']}));
  const model=await createBrowserModelSettings({dataDir,env:{}});
  assert.deepEqual(model.view(),{provider:'custom',model:'',baseUrl:'',keyConfigured:false,modelConfigured:false,modelError:'Configure a model API key to use the browser agent.',escalationModel:''});
  assert.deepEqual(model.environment(),{PERPETUAL_MODEL_API_KEY:'',PERPETUAL_MODEL:'',PERPETUAL_MODEL_BASE_URL:''});
});

test('the escalation model is saved beside the model, kept across saves that omit it, and never replaces the key',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-escalation-model-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir,env:{}});
  assert.equal(model.escalationModel(),null);
  await model.saveOpenRouter({apiKey:'openrouter-private-fixture',model:'openai/gpt-6-luna',escalationModel:'anthropic/claude-sonnet-5'});
  assert.deepEqual([model.escalationModel(),model.view().escalationModel,model.configuration().model],['anthropic/claude-sonnet-5','anthropic/claude-sonnet-5','openai/gpt-6-luna']);
  await model.saveOpenRouter({model:'openai/gpt-5.4-mini'});
  assert.equal(model.escalationModel(),'anthropic/claude-sonnet-5');
  await assert.rejects(model.saveOpenRouter({model:'openai/gpt-5.4-mini',escalationModel:'bad model id'}),/escalation model/);
  await assert.rejects(model.saveOpenRouter({model:'openai/gpt-5.4-mini',escalationModel:{id:'x'}}),/escalation model/);
  const restored=await createBrowserModelSettings({dataDir,env:{}});
  assert.deepEqual([restored.escalationModel(),restored.environment().PERPETUAL_MODEL_API_KEY],['anthropic/claude-sonnet-5','openrouter-private-fixture']);
  assert.equal(JSON.stringify(restored.view()).includes('private-fixture'),false);
});

test('catalog defaults to Luna for Settings and escalation without substituting another model',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  // The public catalog as OpenRouter lists it; no request leaves the test.
  const catalog=(ids:string[])=>{globalThis.fetch=(async()=>new Response(JSON.stringify({data:ids.map(id=>({id,name:`Vendor: ${id}`,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}))}),{status:200})) as typeof fetch;};
  catalog(['openai/gpt-6-luna','openai/gpt-5.4-mini','anthropic/claude-sonnet-4.6','openai/gpt-6']);
  assert.deepEqual((({defaultModel,defaultEscalationModel})=>[defaultModel,defaultEscalationModel])(await createOpenRouterModelCatalog().view()),['openai/gpt-6-luna','openai/gpt-6-luna']);
  assert.equal((await createOpenRouterModelCatalog().view(undefined,'anthropic/claude-sonnet-4.6')).defaultEscalationModel,'anthropic/claude-sonnet-4.6','A saved escalation model stays selected.');
  await assert.rejects(createOpenRouterModelCatalog().view(undefined,'anthropic/not-listed'),/escalation model anthropic\/not-listed is unavailable/i,'A missing saved escalation model is not replaced.');
  await assert.rejects(createOpenRouterModelCatalog().view('qwen/not-listed'),/model qwen\/not-listed is unavailable/i,'A missing saved Settings model is not replaced.');
  catalog(['openai/gpt-5.4-mini','qwen/qwen3']);
  await assert.rejects(createOpenRouterModelCatalog().view(),/model openai\/gpt-6-luna is unavailable/i,'A missing default fails clearly instead of selecting the first catalog model.');
});


test('draft effort uses cached catalog capabilities and never guesses support from a model name',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    calls++;assert.equal(new Headers(options.headers).has('Authorization'),false);
    return Response.json({data:[
      ['openai/gpt-6-luna',{}],
      ['low',{supported_efforts:['high','medium','low']}],['high',{supported_efforts:['high']}],
      ['any',{supported_efforts:null}],['missing',{}],['malformed',{supported_efforts:'low'}],
    ].map(([name,reasoning])=>({id:name==='openai/gpt-6-luna'?name:`vendor/${name}`,name,reasoning,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}))});
  });
  const catalog=createOpenRouterModelCatalog();
  await catalog.view();
  for(const name of ['low','any'])assert.deepEqual(await catalog.draftReasoning(`vendor/${name}`),{effort:'low',exclude:true});
  for(const name of ['high','missing','malformed','unknown'])assert.deepEqual(await catalog.draftReasoning(`vendor/${name}`),{exclude:true});
  assert.equal(calls,1,'Drafting reuses the settings catalog without transmitting credentials');
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Catalog unavailable');});
  assert.deepEqual(await createOpenRouterModelCatalog().draftReasoning('vendor/low'),{exclude:true},'An unavailable catalog retains provider defaults rather than guessing an unsupported effort');
});

test('a failed catalog refresh serves the last catalog and its efforts, without models that have expired since',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T00:00:00Z')});
  let available=true,calls=0;
  const model=(id:string,extra:Record<string,unknown>={})=>({id,name:id,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools'],...extra});
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;if(!available)throw new Error('Catalog unavailable');
    return Response.json({data:[model('openai/gpt-6-luna'),model('vendor/kept',{reasoning:{supported_efforts:['low','medium']}}),model('vendor/retiring',{expiration_date:'2026-10-01T00:30:00Z'})]});
  });
  const catalog=createOpenRouterModelCatalog(),listed=async()=>(await catalog.view()).models.map(item=>item.id);
  assert.deepEqual(await listed(),['openai/gpt-6-luna','vendor/kept','vendor/retiring']);
  available=false;t.mock.timers.tick(10*60*1000);
  assert.deepEqual(await listed(),['openai/gpt-6-luna','vendor/kept','vendor/retiring'],'Settings can still be saved.');
  assert.equal(calls,2);
  t.mock.timers.tick(30*1000);await listed();
  assert.equal(calls,2,'A failed refresh is tried again a minute later, not on every read.');
  t.mock.timers.tick(25*60*1000);
  assert.deepEqual(await listed(),['openai/gpt-6-luna','vendor/kept'],'A model that expired meanwhile is no longer offered.');
  assert.deepEqual([await catalog.generationReasoning('vendor/kept'),await catalog.draftReasoning('vendor/kept')],[{effort:'medium'},{effort:'low',exclude:true}]);
  await assert.rejects(createOpenRouterModelCatalog().view(),/Could not load OpenRouter models/,'Without an earlier catalog nothing is served.');
});

test('journey code generation enables medium reasoning only when the catalog explicitly supports it',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return Response.json({data:[
      ['medium',{supported_efforts:['none','low','medium','high']}],['high',{supported_efforts:['high']}],
      ['any',{supported_efforts:null}],['missing',{}],['malformed',{supported_efforts:'medium'}],
    ].map(([name,reasoning])=>({id:`vendor/${name}`,name,reasoning,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}))});
  });
  const catalog=createOpenRouterModelCatalog();
  assert.deepEqual(await catalog.generationReasoning('vendor/medium'),{effort:'medium'});
  for(const name of ['high','any','missing','malformed','unknown'])assert.equal(await catalog.generationReasoning(`vendor/${name}`),undefined);
  assert.equal(calls,1);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unavailable');});
  assert.equal(await createOpenRouterModelCatalog().generationReasoning('vendor/medium'),undefined);
});

test('OpenRouter answers whether it accepts a key, and anything else leaves it unknown',async t=>{
  const requests:{url:string;authorization:string|null;redirect?:RequestRedirect}[]=[];
  let reply:()=>Response|Promise<Response>=()=>Response.json({data:{label:'fixture'}});
  t.mock.method(globalThis,'fetch',async(url:string|URL,options:RequestInit={})=>{requests.push({url:String(url),authorization:new Headers(options.headers).get('Authorization'),redirect:options.redirect});return reply();});
  assert.equal(await checkOpenRouterKey('sk-or-v1-fixture-only'),'accepted');
  // The key goes only to the key endpoint, which spends no credits, and never on through a redirect.
  assert.deepEqual(requests,[{url:'https://openrouter.ai/api/v1/key',authorization:'Bearer sk-or-v1-fixture-only',redirect:'error'}]);
  for(const status of [401,403]){reply=()=>Response.json({error:{message:'User not found.',code:status}},{status});assert.equal(await checkOpenRouterKey('sk-or-v1-fixture-only'),'rejected',String(status));}
  for(const status of [404,429,500,503]){reply=()=>new Response('',{status});assert.equal(await checkOpenRouterKey('sk-or-v1-fixture-only'),'unknown',String(status));}
  reply=()=>{throw new TypeError('fetch failed');};
  assert.equal(await checkOpenRouterKey('sk-or-v1-fixture-only'),'unknown');
});

test('Settings refuses a new key OpenRouter does not accept, and saves one it could not check with a warning',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-openrouter-key-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let answer:'accepted'|'rejected'|'offline'|'unavailable'='rejected';const checked:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string|URL,options:RequestInit={})=>{
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'openai/gpt-6-luna',name:'Luna',architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}]});
    checked.push(new Headers(options.headers).get('Authorization')!);
    if(answer==='offline')throw new TypeError('fetch failed');
    if(answer==='unavailable')return new Response('',{status:503});
    return answer==='accepted'?Response.json({data:{label:'fixture'}}):Response.json({error:{message:'User not found.',code:401}},{status:401});
  });
  // A stub runtime: saving settings starts no worker.
  const manager=await createBrowserManager({dataDir,runtime:{capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(){throw new Error('No worker starts.');}}});
  t.after(()=>manager.close());
  const saved=async()=>JSON.parse(await readFile(join(dataDir,'browser-model.json'),'utf8')).apiKey;
  await assert.rejects(manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey:'sk-or-v1-refused-fixture'}),{message:'OpenRouter did not accept this key.'});
  await assert.rejects(access(join(dataDir,'browser-model.json')),'A refused key is not saved.');
  answer='offline';
  const unchecked=await manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey:'sk-or-v1-unchecked-fixture'});
  assert.deepEqual([unchecked.warning,unchecked.capabilities.keyConfigured,await saved()],['OpenRouter could not check this key.',true,'sk-or-v1-unchecked-fixture']);
  // An answer about something else, such as an outage, checks nothing either.
  answer='unavailable';
  const unanswered=await manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey:'sk-or-v1-unanswered-fixture'});
  assert.deepEqual([unanswered.warning,await saved()],['OpenRouter could not check this key.','sk-or-v1-unanswered-fixture']);
  answer='accepted';
  const accepted=await manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey:'sk-or-v1-accepted-fixture'});
  assert.equal(Object.hasOwn(accepted,'warning'),false);assert.equal(await saved(),'sk-or-v1-accepted-fixture');
  assert.deepEqual(checked,['Bearer sk-or-v1-refused-fixture','Bearer sk-or-v1-unchecked-fixture','Bearer sk-or-v1-unanswered-fixture','Bearer sk-or-v1-accepted-fixture']);
  // Choosing a model alone asks nothing; a refused key never replaces the saved one.
  await manager.saveModelSettings({model:'openai/gpt-6-luna'});
  answer='rejected';
  await assert.rejects(manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey:'sk-or-v1-other-fixture'}),{message:'OpenRouter did not accept this key.'});
  assert.equal(checked.length,5);assert.equal(await saved(),'sk-or-v1-accepted-fixture');
});

test('a key that is not printable ASCII is refused and never sent',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-openrouter-key-shape-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const requests:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string|URL)=>{requests.push(String(url));return Response.json({data:[{id:'openai/gpt-6-luna',name:'Luna',architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}]});});
  // A stub runtime: saving settings starts no worker.
  const manager=await createBrowserManager({dataDir,runtime:{capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(){throw new Error('No worker starts.');}}});
  t.after(()=>manager.close());
  // A pasted ellipsis cannot travel in an HTTP header at all, and no key holds an accented letter.
  for(const apiKey of ['sk-or-v1-pasted\u2026','sk-or-v1-caf\u00e9'])await assert.rejects(manager.saveModelSettings({model:'openai/gpt-6-luna',apiKey}),{message:'Enter a valid model API key.'},apiKey);
  assert.deepEqual(requests.filter(url=>!url.endsWith('/models')),[],'OpenRouter is never asked about a key that cannot be sent.');
  await assert.rejects(access(join(dataDir,'browser-model.json')),'Nothing is saved.');
  // An exported one configures no model either.
  const exported=await createBrowserModelSettings({dataDir,env:{OPENROUTER_API_KEY:'sk-or-v1-exported\u2026'}});
  assert.deepEqual([exported.view().modelConfigured,exported.view().modelError],[false,'Enter a valid model API key.']);
});
