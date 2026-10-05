import {DEFAULT_MODEL,OPENROUTER_BASE_URL,isOpenRouterEndpoint} from './openrouter-models.ts';
import type {BrowserModelView} from '../../contract/settings.ts';

const OPENAI_URL='https://api.openai.com/v1';

/** The browser agent's model: its API key, model ID and provider endpoint. */
export type BrowserModelSettings={apiKey:string;model:string;baseUrl:string};
/** Settings as entered or stored, before they are checked. */
export type BrowserModelInput={apiKey?:unknown;model?:unknown;baseUrl?:unknown;escalationModel?:unknown};
/** Only checked settings configure a model; otherwise modelError says why, and each field keeps only text, for a view. */
export type BrowserModelConfiguration=BrowserModelSettings&({modelConfigured:true;modelError?:undefined}|{modelConfigured:false;modelError:string});
export type BrowserModelEnvironment={PERPETUAL_MODEL_API_KEY:string;PERPETUAL_MODEL:string;PERPETUAL_MODEL_BASE_URL:string};

const validUrl=(value:string)=>{try{const url=new URL(value);return value.length<=2048&&['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}};
// An endpoint as the controller saves it: host in lower case, without a default port, fragment or trailing slash.
const endpoint=(value:string)=>{try{const url=new URL(value);url.hash='';value=url.href;}catch{}return value.replace(/\/$/,'');};
/** The settings once every field is checked, or why they configure no model. */
function checked({apiKey,model,baseUrl}:BrowserModelInput):BrowserModelSettings|string{
  if(typeof apiKey!=='string'||!apiKey.trim())return 'Configure a model API key to use the browser agent.';
  if(apiKey.length>4096||/\s/.test(apiKey))return 'Enter a valid model API key.';
  if(typeof model!=='string'||!model.trim()||model.length>200||/[\s\u0000-\u001f]/.test(model))return 'Enter a model ID.';
  if(/(?:^|\/)jev(?:-|$)/i.test(model))return 'Choose a chat model; Jev uses a separate decisions API.';
  if(typeof baseUrl!=='string'||!validUrl(baseUrl))return 'Enter a valid model API URL without embedded credentials.';
  return {apiKey,model,baseUrl};
}

/** Resolve provider defaults once, before configuration crosses the worker seam. */
export function resolveBrowserModel({saved=null,env={}}:{saved?:BrowserModelInput|null;env?:NodeJS.ProcessEnv}={}):BrowserModelConfiguration{
  const openRouter=Boolean(env.OPENROUTER_API_KEY&&!env.PERPETUAL_MODEL_API_KEY);
  const environment={
    apiKey:env.PERPETUAL_MODEL_API_KEY||env.OPENROUTER_API_KEY||'',
    model:env.PERPETUAL_MODEL||(openRouter?DEFAULT_MODEL:''),
    baseUrl:env.PERPETUAL_MODEL_BASE_URL||(env.PERPETUAL_MODEL_API_KEY?OPENAI_URL:OPENROUTER_BASE_URL),
  };
  // Saved settings without a key use the environment's key, and only for the endpoint the environment names, however
  // its address is written.
  const sameEndpoint=typeof saved?.baseUrl==='string'&&endpoint(saved.baseUrl)===endpoint(environment.baseUrl);
  const value=saved?(saved.apiKey===undefined&&sameEndpoint?{...saved,apiKey:environment.apiKey}:saved):environment;
  const configuration={apiKey:value.apiKey||'',model:value.model||(value.apiKey?'':DEFAULT_MODEL),baseUrl:value.baseUrl||OPENROUTER_BASE_URL};
  const settings=checked(configuration);
  if(typeof settings!=='string')return {...settings,modelConfigured:true};
  // Only checked strings configure a model, and the controller saves nothing else; a stored non-text value shows as empty.
  const text=(value:unknown)=>typeof value==='string'?value:'';
  return {apiKey:text(configuration.apiKey),model:text(configuration.model),baseUrl:text(configuration.baseUrl),modelConfigured:false,modelError:settings};
}

export function browserModelView(configuration:BrowserModelConfiguration):BrowserModelView{
  const {model,baseUrl,modelConfigured,modelError}=configuration;
  return {provider:isOpenRouterEndpoint(baseUrl)?'openrouter':'custom',model,baseUrl,keyConfigured:Boolean(configuration.apiKey),modelConfigured,...(modelError?{modelError}:{})};
}

export function browserModelEnvironment({apiKey,model,baseUrl}:BrowserModelSettings):BrowserModelEnvironment{
  return {PERPETUAL_MODEL_API_KEY:apiKey,PERPETUAL_MODEL:model,PERPETUAL_MODEL_BASE_URL:baseUrl};
}
