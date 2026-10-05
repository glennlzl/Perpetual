import type {OpenRouterModel,OpenRouterModelView} from '../../contract/settings.ts';

export const OPENROUTER_BASE_URL='https://openrouter.ai/api/v1';
export const isOpenRouterEndpoint=(value:unknown):boolean=>typeof value==='string'&&value.replace(/\/$/,'')===OPENROUTER_BASE_URL;
const CATALOG_URL=`${OPENROUTER_BASE_URL}/models`;
export const DEFAULT_MODEL='openai/gpt-6-luna';
/** Strong coding models a build repair escalates to, in order of preference; the first the catalog has is the default. */
export const ESCALATION_MODELS=['anthropic/claude-sonnet-5','openai/gpt-6','anthropic/claude-sonnet-4.6','openai/gpt-5.4','google/gemini-3-pro-preview'];
const CACHE_TTL_MS=5*60*1000,RETRY_MS=60*1000;
const CATALOG_LIMIT=8*1024*1024;

type CatalogModel={id:string;name:string;expiration_date?:unknown;reasoning?:unknown};
export type DraftReasoning={effort?:'low';exclude:true};
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

function eligible(model:unknown,time:number):model is CatalogModel{
  if(!isRecord(model)||typeof model.id!=='string'||model.id.length>200||!/^[a-z0-9][a-z0-9._-]*\/[^\s\u0000-\u001f]+$/i.test(model.id))return false;
  if(typeof model.name!=='string'||!model.name.trim()||model.name.length>400||/[\u0000-\u001f]/.test(model.name))return false;
  if(/:batch(?:$|:)/i.test(model.id)||model.deprecated===true||model.is_deprecated===true||/\bdeprecated\b/i.test(model.name))return false;
  if(model.expiration_date){const expires=Date.parse(String(model.expiration_date));if(!Number.isFinite(expires)||expires<=time)return false;}
  const {input_modalities:input,output_modalities:output}=isRecord(model.architecture)?model.architecture:{};
  return Array.isArray(input)&&input.includes('text')&&input.includes('image')
    &&Array.isArray(output)&&output.includes('text')
    &&Array.isArray(model.supported_parameters)&&model.supported_parameters.includes('tools');
}

export function createOpenRouterModelCatalog(){
  let cached:OpenRouterModel[]|null=null,expiresAt=0,pending:Promise<OpenRouterModel[]>|null=null;
  let lowEffort=new Set<string>(),mediumEffort=new Set<string>(),expirations=new Map<string,number>();
  async function fetchModels():Promise<{models:OpenRouterModel[];validUntil:number}>{
    try{
      // This public catalog request never receives saved credentials or model settings.
      const response=await fetch(CATALOG_URL,{headers:{Accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok||!response.body||Number(response.headers.get('content-length'))>CATALOG_LIMIT){await response.body?.cancel();throw new Error('Unavailable catalog.');}
      const chunks:Uint8Array[]=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>CATALOG_LIMIT)throw new Error('Oversized catalog.');chunks.push(chunk);}
      const payload:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!isRecord(payload)||!Array.isArray(payload.data))throw new Error('Invalid catalog.');
      const time=Date.now(),unique=new Map<string,OpenRouterModel>(),supportsLow=new Set<string>(),supportsMedium=new Set<string>(),expires=new Map<string,number>();let validUntil=time+CACHE_TTL_MS;
      for(const model of payload.data)if(eligible(model,time)){
        unique.set(model.id,{id:model.id,name:model.name.trim(),provider:model.id.split('/')[0]});
        const efforts=isRecord(model.reasoning)?model.reasoning.supported_efforts:undefined;
        if(efforts===null||(Array.isArray(efforts)&&efforts.includes('low')))supportsLow.add(model.id);
        if(Array.isArray(efforts)&&efforts.includes('medium'))supportsMedium.add(model.id);
        if(model.expiration_date){expires.set(model.id,Date.parse(String(model.expiration_date)));validUntil=Math.min(validUntil,expires.get(model.id)!);}
      }
      const models=[...unique.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
      if(!models.length)throw new Error('Empty catalog.');
      lowEffort=supportsLow;mediumEffort=supportsMedium;expirations=expires;
      return {models,validUntil};
    }catch{throw Object.assign(new Error('Could not load OpenRouter models. Try again.'),{statusCode:502});}
  }
  async function load():Promise<OpenRouterModel[]>{
    if(cached&&expiresAt>Date.now())return cached;
    pending ||= fetchModels().then(({models,validUntil})=>{cached=models;expiresAt=validUntil;return models;},error=>{
      // A refresh that fails serves the last catalog, and its efforts, without the models that have expired since, and is
      // tried again a minute later.
      const time=Date.now(),kept=cached?.filter(model=>!((expirations.get(model.id)??Infinity)<=time));
      if(!kept?.length)throw error;
      cached=kept;expiresAt=Math.min(time+RETRY_MS,...kept.map(model=>expirations.get(model.id)??Infinity));return kept;
    }).finally(()=>{pending=null;});
    return pending;
  }
  return {
    async generationReasoning(model:string):Promise<{effort:'medium'}|undefined>{
      // Code generation needs reasoning, but only an explicit catalog capability authorizes an effort override.
      try{await load();}catch{return undefined;}
      return mediumEffort.has(model)?{effort:'medium'}:undefined;
    },
    async draftReasoning(model:string):Promise<DraftReasoning>{
      // An unavailable or incomplete catalog cannot authorize a new effort.
      try{await load();}catch{return {exclude:true};}
      return {...(lowEffort.has(model)?{effort:'low' as const}:{}),exclude:true};
    },
    async view(preferredModel?:string,preferredEscalation?:string):Promise<OpenRouterModelView>{
      const models=await load(),listed=(id:string|undefined)=>models.some(model=>model.id===id);
      const defaultModel=[preferredModel,DEFAULT_MODEL].find(listed)||models[0].id;
      // Without a strong model in the catalog, repairs escalate to the Settings model itself.
      const defaultEscalationModel=[preferredEscalation,...ESCALATION_MODELS].find(listed)||defaultModel;
      return {models:structuredClone(models),defaultModel,defaultEscalationModel};
    },
  };
}
