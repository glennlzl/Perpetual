import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,stat,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserModelSettings} from '../src/browser/model.ts';
import {createOpenRouterModelCatalog} from '../src/browser/openrouter-models.ts';

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

test('the escalation model defaults to a strong model the catalog has, else the Settings model',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  // The public catalog as OpenRouter lists it; no request leaves the test.
  const catalog=(ids:string[])=>{globalThis.fetch=(async()=>new Response(JSON.stringify({data:ids.map(id=>({id,name:`Vendor: ${id}`,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}))}),{status:200})) as typeof fetch;};
  catalog(['openai/gpt-6-luna','openai/gpt-5.4-mini','anthropic/claude-sonnet-4.6','openai/gpt-6']);
  assert.deepEqual((({defaultModel,defaultEscalationModel})=>[defaultModel,defaultEscalationModel])(await createOpenRouterModelCatalog().view()),['openai/gpt-6-luna','openai/gpt-6']);
  assert.equal((await createOpenRouterModelCatalog().view(undefined,'anthropic/claude-sonnet-4.6')).defaultEscalationModel,'anthropic/claude-sonnet-4.6','A saved escalation model stays selected.');
  catalog(['openai/gpt-5.4-mini','qwen/qwen3']);
  assert.equal((await createOpenRouterModelCatalog().view('qwen/qwen3')).defaultEscalationModel,'qwen/qwen3','Without a strong model, repairs escalate to the Settings model.');
});


test('draft effort uses cached catalog capabilities and never guesses support from a model name',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    calls++;assert.equal(new Headers(options.headers).has('Authorization'),false);
    return Response.json({data:[
      ['low',{supported_efforts:['high','medium','low']}],['high',{supported_efforts:['high']}],
      ['any',{supported_efforts:null}],['missing',{}],['malformed',{supported_efforts:'low'}],
    ].map(([name,reasoning])=>({id:`vendor/${name}`,name,reasoning,architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools']}))});
  });
  const catalog=createOpenRouterModelCatalog();
  await catalog.view();
  for(const name of ['low','any'])assert.deepEqual(await catalog.draftReasoning(`vendor/${name}`),{effort:'low',exclude:true});
  for(const name of ['high','missing','malformed','unknown'])assert.deepEqual(await catalog.draftReasoning(`vendor/${name}`),{exclude:true});
  assert.equal(calls,1,'Drafting reuses the settings catalog without transmitting credentials');
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Catalog unavailable');});
  assert.deepEqual(await createOpenRouterModelCatalog().draftReasoning('vendor/low'),{exclude:true},'An unavailable catalog retains provider defaults rather than guessing an unsupported effort');
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
