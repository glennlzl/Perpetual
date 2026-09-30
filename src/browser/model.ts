import {createSaveQueue,readStateFile,writeStateFile} from '../store.ts';
import {join} from 'node:path';
import {validateBrowserTarget} from './runtime.ts';
import {resolveBrowserModel,browserModelView,browserModelEnvironment} from './model-policy.ts';
import type {BrowserModelInput} from './model-policy.ts';
import type {ModelSettingsView} from '../../contract/settings.ts';
import {OPENROUTER_BASE_URL,isOpenRouterEndpoint} from './openrouter-models.ts';

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
// A model ID as the Settings Select stores it; the escalation model is checked like the model.
const modelId=(value:unknown):value is string=>typeof value==='string'&&Boolean(value.trim())&&value.length<=200&&!/[\s\u0000-\u001f]/.test(value)&&!/(?:^|\/)jev(?:-|$)/i.test(value);

/** The saved browser model settings; the stored file may hold only what the controller saved. */
export type BrowserModelSettingsStore=Awaited<ReturnType<typeof createBrowserModelSettings>>;

export async function createBrowserModelSettings({dataDir,env=process.env}:{dataDir:string;env?:NodeJS.ProcessEnv}){
  const file=join(dataDir,'browser-model.json');let saved:BrowserModelInput|null=null;
  {const parsed=await readStateFile(file,{limit:16384,invalid:'Invalid browser model settings.'});if(parsed!==undefined)saved=parsed===null?null:isRecord(parsed)?parsed:{};}
  const configuration=()=>resolveBrowserModel({saved,env});
  /** The model build repairs and twin config authoring escalate to after two failed attempts; null until one is saved. */
  const escalationModel=()=>modelId(saved?.escalationModel)?saved.escalationModel:null;
  const view=():ModelSettingsView=>({...browserModelView(configuration()),escalationModel:escalationModel()??''});
  const saves=createSaveQueue();
  function save(input:unknown,{openRouterOnly=false}={}):Promise<ModelSettingsView>{
      return saves.run(async()=>{
        const fields=openRouterOnly?['apiKey','model','escalationModel']:['apiKey','model','baseUrl'];
        if(!isRecord(input)||Object.keys(input).some(key=>!fields.includes(key)))throw new Error(openRouterOnly?'Provide an OpenRouter model and API key.':'Provide model, API key or API URL.');
        if(openRouterOnly&&(typeof input.model!=='string'||!input.model.trim()))throw new Error('Choose an OpenRouter model.');
        if(input.escalationModel!==undefined&&!modelId(input.escalationModel))throw new Error('Choose an OpenRouter escalation model.');
        const current=configuration();
        if(openRouterOnly&&input.apiKey===undefined&&!isOpenRouterEndpoint(current.baseUrl))throw new Error('Enter your OpenRouter API key to switch providers.');
        const apiKey=input.apiKey===undefined?current.apiKey:input.apiKey,model=input.model??current.model,baseUrl=openRouterOnly?OPENROUTER_BASE_URL:input.baseUrl??current.baseUrl;
        const resolved=resolveBrowserModel({saved:{apiKey,model,baseUrl}});
        if(!resolved.modelConfigured)throw new Error(resolved.modelError);
        const normalizedUrl=validateBrowserTarget(String(baseUrl)).replace(/\/$/,'');
        const escalation=input.escalationModel??escalationModel();
        const next={apiKey,model,baseUrl:normalizedUrl,...(escalation?{escalationModel:escalation}:{})};
        await writeStateFile(file,JSON.stringify(next),{prefix:'.browser-model-'});saved=next;return view();
      });
  }
  return {
    view,configuration,escalationModel,save,
    saveOpenRouter:(input:unknown)=>save(input,{openRouterOnly:true}),
    environment:()=>browserModelEnvironment(configuration()),
  };
}
