import {createHash} from 'node:crypto';
import type {ApplicationCallbackBinding,CallbackApplication} from '../../contract/browser.ts';
import {applicationOrigin} from '../environments/usage.ts';
import {validateBrowserTarget} from './runtime.ts';
export interface AutomaticCallbackTarget {environmentId:string;url:string;applicationId?:string}
export interface CallbackEnvironment {id:string;status:string;sandboxId?:string|null;pipelineKey?:string|null;stageId?:string|null;apps?:readonly unknown[]|null}
export interface CallbackResolutionInput {context:{key:string;stageId:string;controllerOrigin?:string};targetUrl:string;target?:AutomaticCallbackTarget;environment?:CallbackEnvironment|null}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateCallbackBindings(value:unknown,fixedOriginsCount=0):ApplicationCallbackBinding[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||!Number.isInteger(fixedOriginsCount)||fixedOriginsCount<0||fixedOriginsCount+value.length>10)throw new Error('Review at most ten fixed sites and application callbacks.');
 const seen=new Set<string>();
 return value.map((item:unknown)=>{
  if(!record(item)||Object.keys(item).length!==2||typeof item.applicationId!=='string'||!item.applicationId.length||item.applicationId.length>1024||!['localhost','127.0.0.1'].includes(String(item.hostname)))throw new Error('Choose an application and a supported callback host.');
  const binding:ApplicationCallbackBinding={applicationId:item.applicationId,hostname:item.hostname as ApplicationCallbackBinding['hostname']};
  const key=JSON.stringify([binding.applicationId,binding.hostname]);if(seen.has(key))throw new Error('Review each application callback once.');seen.add(key);return binding;
 });
}
export function callbackPolicyHash(scope:string,bindings?:readonly ApplicationCallbackBinding[]):string{
 if(!bindings?.length)return '';
 const pairs=bindings.map(item=>[item.applicationId,item.hostname]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
 return createHash('sha256').update(JSON.stringify([scope,pairs])).digest('hex');
}
export function callbackApplication(input:CallbackResolutionInput):CallbackApplication|null{
 const env=input.environment,target=input.target;
 if(!env||env.status!=='ready'||env.sandboxId!==env.id||env.pipelineKey!==input.context.key||env.stageId!==input.context.stageId||!target||target.environmentId!==env.id||target.url!==input.targetUrl||!target.applicationId||!Array.isArray(env.apps))return null;
 const apps=env.apps.filter(record),selected=apps.filter(app=>app.id===target.applicationId),origin=applicationOrigin(input.targetUrl);
 if(selected.length!==1||!origin||typeof selected[0].url!=='string'||applicationOrigin(selected[0].url)!==origin||apps.filter(app=>typeof app.url==='string'&&applicationOrigin(app.url)===origin).length!==1)return null;
 try{const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)return null;validateBrowserTarget(url.href,{controllerOrigin:input.context.controllerOrigin});return {applicationId:target.applicationId,origin};}catch{return null;}
}
export function resolveCallbackOrigins(bindings:readonly ApplicationCallbackBinding[],input:CallbackResolutionInput):string[]{
 if(!bindings.length)return [];
 const application=callbackApplication(input);
 if(!application||bindings.some(item=>item.applicationId!==application.applicationId))throw new Error('Choose a ready managed application for its callback bindings.');
 return bindings.map(item=>{const url=new URL(application.origin);url.hostname=item.hostname;return url.origin;});
}
