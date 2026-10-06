import { parseDocument } from 'yaml';
import { SHA, isRepository, runGitHub, parseGitHubResponse, githubHttpStatus, type GitHubRun } from '../github-cli.ts';
import { getGitHubSession, type GitHubSession } from '../github-source.ts';
import { readBranchHead } from '../gate/github.ts';
import { readBuild } from '../gate/build.ts';
import type { ReleaseGitHub, ReleaseRemote, ReleaseRequest, ReleaseSource } from './manager.ts';
import type { ReleaseTarget } from '../../contract/releases.ts';

const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
// The encoded address is what a record stores, so its length is bounded too: percent-encoding can multiply it.
function link(value:unknown):string|undefined{if(typeof value!=='string'||value.length>2048)return;try{const url=new URL(value);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=2048)return url.href;}catch{}}
const safeSource=(source:ReleaseSource)=>{if(!isRepository(source.repository)||!SHA.test(source.sha))throw new Error('Invalid deployment source.');};
const payloadOf=(value:unknown):Record<string,unknown>|null=>{if(typeof value==='string'){try{value=JSON.parse(value) as unknown;}catch{return null;}}return object(value)?value:null;};
function matches(value:unknown,request:ReleaseRequest):value is Record<string,unknown>{
  if(!object(value))return false;const payload=payloadOf(value.payload),proof=payload?.perpetual;
  return value.sha===request.source.sha&&value.environment===request.target.environment&&value.production_environment===request.target.productionEnvironment&&value.task==='deploy'
    &&object(proof)&&proof.releaseId===request.id&&proof.workflowPath===request.target.workflowPath&&proof.sha===request.source.sha&&id(value.id)!==null;
}
function handler(file:unknown){
  if(!object(file)||file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string'||file.content.length>140000||typeof file.sha!=='string'||!SHA.test(file.sha))throw new Error('The deployment workflow file is unavailable.');
  let data:unknown;
  try{const document=parseDocument(Buffer.from(file.content,'base64').toString('utf8'));if(document.errors.length)throw new Error('yaml');data=document.toJS({maxAliasCount:10}) as unknown;}catch{throw new Error('The deployment workflow is not valid YAML.');}
  const trigger=object(data)?data.on:undefined,enabled=trigger==='deployment'||Array.isArray(trigger)&&trigger.includes('deployment')||object(trigger)&&Object.hasOwn(trigger,'deployment')&&(trigger.deployment===null||object(trigger.deployment));
  if(!enabled)throw new Error('The workflow must listen for the deployment event at this commit and on the default branch.');
  if(!object(data)||!object(data.jobs)||!Object.keys(data.jobs).length)throw new Error('The deployment workflow has no jobs.');
  return file.sha;
}
function remote(deployment:unknown,request:ReleaseRequest,status?:unknown):ReleaseRemote{
  if(!matches(deployment,request))throw new Error('GitHub returned a deployment for a different request.');
  const result:ReleaseRemote={deploymentId:id(deployment.id)!,status:'queued'};
  if(status===undefined)return result;
  if(!Array.isArray(status))throw new Error('GitHub returned invalid deployment statuses.');
  if(!status.length)return result;
  const last=status[0];if(!object(last)||!id(last.id))throw new Error('GitHub returned invalid deployment status evidence.');
  const states:Record<string,ReleaseRemote['status']>={pending:'queued',queued:'queued',in_progress:'deploying',success:'deployed',failure:'failed',error:'failed',inactive:'inactive'};
  const state=typeof last.state==='string'&&Object.hasOwn(states,last.state)?states[last.state]:undefined;
  if(!state)throw new Error('GitHub returned an unknown deployment status.');
  return {...result,status:state,statusId:id(last.id)!,...(link(last.environment_url)?{url:link(last.environment_url)}:{}),...(link(last.log_url??last.target_url)?{logUrl:link(last.log_url??last.target_url)}:{})};
}

/** GitHub is the delivery channel. The repository's configured workflow performs the actual deployment. */
export function createReleaseGitHub({run,session=getGitHubSession}:{run?:GitHubRun;session?:()=>Promise<GitHubSession>}={}):ReleaseGitHub{
  async function request(method:'GET'|'POST',endpoint:string,fields:string[]=[]){
    try{const {stdout}=await runGitHub(['api','--hostname','github.com','--method',method,'--include','-H','Accept: application/vnd.github+json',...fields,endpoint],{run,maxBuffer:2*1024*1024});
      const reply=parseGitHubResponse(stdout);if(reply.status!==(method==='POST'?201:200))throw new Error('Unexpected response.');return reply.data;
    }catch(error){const status=githubHttpStatus(error),definitive=method==='POST'&&status!==null&&status>=400&&status<500&&status!==408;
      throw Object.assign(new Error(method==='POST'?'Could not confirm the GitHub deployment request.':'Could not read the GitHub deployment configuration or status.'),{definitive,status});}
  }
  // GitHub answers 404 for a deployment it no longer has, and for a repository the account cannot read: only a readable
  // repository makes it the former, which is reported with why it ended (the manager ends only an unresolved release with
  // it). Any other failure is thrown as it was.
  async function gone(error:unknown,repository:string,deploymentId:string):Promise<ReleaseRemote>{
    if((error as {status?:unknown}|null)?.status!==404)throw error;
    await request('GET',`repos/${repository}`);
    return {deploymentId,status:'failed',error:'The deployment no longer exists on GitHub.'};
  }
  async function verifyTarget(source:ReleaseSource,target:ReleaseTarget){
    safeSource(source);
    if(!/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(target.workflowPath))throw new Error('Choose a deployment workflow file.');
    const repo=await request('GET',`repos/${source.repository}`),defaultBranch=object(repo)&&typeof repo.default_branch==='string'?repo.default_branch:null;
    if(!defaultBranch)throw new Error('The repository has no default branch.');
    const branch=await request('GET',`repos/${source.repository}/branches/${encodeURIComponent(defaultBranch)}`),defaultSha=object(branch)&&object(branch.commit)&&typeof branch.commit.sha==='string'?branch.commit.sha:null;
    if(!defaultSha||!SHA.test(defaultSha))throw new Error('The default branch commit is unavailable.');
    const path=target.workflowPath.split('/').map(encodeURIComponent).join('/');
    const [atCommit,atDefault]=await Promise.all([request('GET',`repos/${source.repository}/contents/${path}?ref=${source.sha}`),request('GET',`repos/${source.repository}/contents/${path}?ref=${defaultSha}`)]);
    return {defaultBranch,defaultSha,workflowSha:handler(atCommit),defaultWorkflowSha:handler(atDefault)};
  }
  return {
    verifyTarget,
    async verifyCommit(source){
      safeSource(source);const get=async(endpoint:string)=>({status:200,data:await request('GET',endpoint)});
      const current=async()=>{const head=await readBranchHead({repository:source.repository,branch:source.branch,etag:null},{request:get});
        if(head.status!==200||head.sha!==source.sha)throw new Error('The branch head changed. Run its gates before deploying.');};
      await current();const build=await readBuild(source,{request:get,session});
      // A gate released for a commit GitHub Actions never built does not stand in for Build.
      if(build.status==='none')throw new Error('GitHub Actions has no push or dispatch run for this commit. Dispatch a workflow at it, then deploy.');
      if(build.status!=='passed')throw new Error(build.reason||'GitHub Actions Build has not passed for this commit.');
      await current();
    },
    async create(input){
      safeSource(input.source);
      const contexts=input.gates.map(gate=>gate.context);
      if(!contexts.length||input.gates.some(gate=>gate.sha!==input.source.sha)||contexts.some(context=>!context||context.length>140)||new Set(contexts).size!==contexts.length)throw Object.assign(new Error('Exact commit gate evidence is required.'),{definitive:true});
      const payload=['-f',`payload[perpetual][releaseId]=${input.id}`,'-f',`payload[perpetual][workflowPath]=${input.target.workflowPath}`,'-f',`payload[perpetual][sha]=${input.source.sha}`,...input.gates.flatMap(gate=>['-f',`payload[perpetual][gateIds][]=${gate.id}`])];
      const data=await request('POST',`repos/${input.source.repository}/deployments`,['-f',`ref=${input.source.sha}`,'-f','task=deploy','-F','auto_merge=false','-f',`environment=${input.target.environment}`,'-F',`production_environment=${input.target.productionEnvironment}`,'-F','transient_environment=false','-f',`description=Perpetual release ${input.id}`,...payload,...contexts.flatMap(context=>['-f',`required_contexts[]=${context}`])]);
      return remote(data,input);
    },
    async read(input){
      safeSource(input.source);let deployment:unknown;
      if(input.deploymentId){if(!/^\d+$/.test(input.deploymentId))throw new Error('Invalid deployment identifier.');
        try{deployment=await request('GET',`repos/${input.source.repository}/deployments/${input.deploymentId}`);}catch(error){return gone(error,input.source.repository,input.deploymentId);}}
      else{
        const found:unknown[]=[];
        for(let page=1;page<=5;page++){
          const items=await request('GET',`repos/${input.source.repository}/deployments?sha=${input.source.sha}&task=deploy&per_page=100&page=${page}`);
          if(!Array.isArray(items))throw new Error('GitHub returned an invalid deployment list.');found.push(...items.filter(item=>matches(item,input)));if(items.length<100)break;
        }
        if(!found.length)return null;if(found.length!==1)throw new Error('Multiple deployments claim this release. Review them on GitHub.');deployment=found[0];
      }
      if(!matches(deployment,input)||input.deploymentId&&id(deployment.id)!==input.deploymentId)throw new Error('The deployment does not match this release.');
      let statuses:unknown;
      try{statuses=await request('GET',`repos/${input.source.repository}/deployments/${id(deployment.id)!}/statuses?per_page=1`);}catch(error){return gone(error,input.source.repository,id(deployment.id)!);}
      return remote(deployment,input,statuses);
    },
  };
}
