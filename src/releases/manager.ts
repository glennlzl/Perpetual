import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { SHA, isRepository } from '../github-cli.ts';
import { failureText } from '../redaction.ts';
import { createReleaseGitHub } from './github.ts';
import type { ReleaseRecord, ReleaseTarget, ReleaseView } from '../../contract/releases.ts';

export interface ReleaseSource { key: string; repository: string; branch: string; sha: string; login: string }
export interface ReleaseGate { id: string; stageId: string; sha: string; context: string; status: 'passed' | 'released'; updatedAt: string; releasedBy?: string; releasedAt?: string }
export interface ReleaseEvidence { source: ReleaseSource | null; ready: boolean; reason?: string; gates: ReleaseGate[] }
export interface ReleaseWorkflow { defaultBranch: string; defaultSha: string; workflowSha: string; defaultWorkflowSha: string }
export interface ReleaseRequest { id: string; source: ReleaseSource; target: ReleaseTarget; gates: ReleaseGate[]; workflow: ReleaseWorkflow }
export interface ReleaseRemote { deploymentId: string; status: 'queued' | 'deploying' | 'deployed' | 'failed' | 'inactive'; statusId?: string; url?: string; logUrl?: string }
export interface ReleaseGitHub {
  verifyTarget(source: ReleaseSource, target: ReleaseTarget): Promise<ReleaseWorkflow>;
  verifyCommit(source: ReleaseSource): Promise<void>;
  create(request: ReleaseRequest): Promise<ReleaseRemote>;
  read(request: ReleaseRequest & { deploymentId?: string }): Promise<ReleaseRemote | null>;
}
interface StoredRelease extends ReleaseRequest { record: ReleaseRecord }
interface State { version: 1; targets: Record<string, ReleaseTarget>; releases: StoredRelease[] }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max = 255): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const scope = (source: ReleaseSource) => JSON.stringify([source.key, source.repository.toLowerCase(), source.branch]);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const active = (record: ReleaseRecord) => ['requesting', 'unknown', 'queued', 'deploying'].includes(record.status);
const sourceValid = (value: unknown): value is ReleaseSource => object(value) && bounded(value.key, 4096) && isRepository(value.repository) && bounded(value.branch) && typeof value.sha === 'string' && SHA.test(value.sha) && bounded(value.login);
const gateValid = (value: unknown): value is ReleaseGate => object(value) && bounded(value.id) && bounded(value.stageId) && typeof value.sha === 'string' && SHA.test(value.sha) && bounded(value.context, 140) && ['passed','released'].includes(String(value.status)) && bounded(value.updatedAt) && (value.status !== 'released' || bounded(value.releasedBy) && bounded(value.releasedAt));
const workflowValid = (value: unknown): value is ReleaseWorkflow => object(value) && bounded(value.defaultBranch) && ['defaultSha','workflowSha','defaultWorkflowSha'].every(key => typeof value[key] === 'string' && SHA.test(value[key]));

export function releaseTarget(value: unknown): ReleaseTarget {
  if (!object(value) || !bounded(value.environment) || value.environment !== value.environment.trim() || typeof value.productionEnvironment !== 'boolean'
    || typeof value.workflowPath !== 'string' || !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(value.workflowPath)) throw new Error('Choose a deployment environment and a workflow file in .github/workflows.');
  return { environment: value.environment, productionEnvironment: value.productionEnvironment, workflowPath: value.workflowPath };
}
function evidenceReason(evidence: ReleaseEvidence): string | null {
  if (!sourceValid(evidence.source)) return 'Connect a GitHub source before deploying.';
  if (!evidence.ready) return evidence.reason || 'Every Sandbox gate must pass or be explicitly released for this commit.';
  if (!Array.isArray(evidence.gates) || !evidence.gates.length || evidence.gates.some(gate => !gateValid(gate) || gate.sha !== evidence.source!.sha)
    || new Set(evidence.gates.map(gate => gate.stageId)).size !== evidence.gates.length || new Set(evidence.gates.map(gate => gate.context)).size !== evidence.gates.length) return 'Verified gate evidence is unavailable for this commit.';
  return null;
}
function publicRecord(record:ReleaseRecord):ReleaseRecord{
  const {id,sha,environment,productionEnvironment,workflowPath,status,createdAt,updatedAt,deploymentId,statusId,url,logUrl,error}=record;
  return {id,sha,environment,productionEnvironment,workflowPath,status,createdAt,updatedAt,...(deploymentId?{deploymentId}:{}),...(statusId?{statusId}:{}),...(url?{url}:{}),...(logUrl?{logUrl}:{}),...(error?{error:failureText(error,500)}:{})};
}
function load(value: unknown): State {
  if (value === undefined) return {version:1,targets:{},releases:[]};
  const invalid = () => new Error('Release state is invalid. Preserve its directory for recovery.');
  if (!object(value) || value.version !== 1 || !object(value.targets) || !Array.isArray(value.releases) || value.releases.length > 1000) throw invalid();
  const targets: Record<string, ReleaseTarget> = Object.create(null) as Record<string, ReleaseTarget>;
  for (const [key,target] of Object.entries(value.targets)) { if (!bounded(key,8192)) throw invalid(); targets[key]=releaseTarget(target); }
  for (const entry of value.releases) {
    if (!object(entry) || !bounded(entry.id) || !sourceValid(entry.source) || !workflowValid(entry.workflow) || !Array.isArray(entry.gates) || !entry.gates.length || entry.gates.some(gate=>!gateValid(gate)) || !object(entry.record)) throw invalid();
    const record=entry.record, target=releaseTarget(entry.target);
    if (record.id !== entry.id || record.sha !== entry.source.sha || record.environment !== target.environment || record.workflowPath !== target.workflowPath || record.productionEnvironment !== target.productionEnvironment
      || !['requesting','unknown','queued','deploying','deployed','failed','inactive'].includes(String(record.status)) || !bounded(record.createdAt) || !bounded(record.updatedAt)
      || ['deploymentId','statusId'].some(key=>record[key]!==undefined&&(typeof record[key]!=='string'||!/^\d+$/.test(record[key])))
      || ['url','logUrl','error'].some(key=>record[key]!==undefined&&!bounded(record[key],4096))) throw invalid();
  }
  return {version:1,targets,releases:value.releases as unknown as StoredRelease[]};
}

/** Only deploy() may submit a request. Restart and refresh only reconcile existing requests. */
export async function createReleaseManager({dataDir,getEvidence,github=createReleaseGitHub(),pollInterval=5000}: {
  dataDir: string; getEvidence(): ReleaseEvidence | Promise<ReleaseEvidence>; github?: ReleaseGitHub; pollInterval?: number;
}) {
  const root=await privateDirectory(join(dataDir,'releases'),'Release storage must not be a symbolic link.'),file=join(root,'state.json');
  let state=load(await readStateFile(file,{limit:8*1024*1024,invalid:'Release state is unavailable. Preserve its directory for recovery.'}));
  const saves=createSaveQueue();let busy=false,closed=false,inFlight:Promise<unknown>|undefined,timer:ReturnType<typeof setInterval>|undefined;
  const save=(change:(next:State)=>void)=>saves.run(async()=>{const next=structuredClone(state);change(next);await writeStateFile(file,JSON.stringify(next),{removeTemporary:true});state=next;});
  if(state.releases.some(entry=>entry.record.status==='requesting'))await save(next=>{for(const entry of next.releases)if(entry.record.status==='requesting')Object.assign(entry.record,{status:'unknown',error:'The deployment request was interrupted. Check its status before deploying again.'});});
  const own=(source:ReleaseSource)=>state.releases.filter(entry=>scope(entry.source)===scope(source));
  async function view(): Promise<ReleaseView> {
    const evidence=await getEvidence(),source=sourceValid(evidence.source)?evidence.source:null;
    const target=source?state.targets[scope(source)]??null:null,history=source?own(source):[],recent=history.slice(-20).reverse().map(entry=>publicRecord(entry.record));
    const selected=target?history.findLast(entry=>entry.source.sha===source?.sha&&same(entry.target,target)):undefined,current=selected?publicRecord(selected.record):null;
    let blockedReason=evidenceReason(evidence);
    if(!blockedReason&&!target)blockedReason='Configure a deployment target.';
    if(!blockedReason&&source&&own(source).some(entry=>active(entry.record)))blockedReason='A deployment is unresolved. Check its status before deploying again.';
    if(!blockedReason&&current?.status==='deployed'&&target&&same(target,{environment:current.environment,productionEnvironment:current.productionEnvironment,workflowPath:current.workflowPath}))blockedReason='This commit is already deployed to this target.';
    if(!blockedReason&&(busy||closed))blockedReason=closed?'The controller is shutting down.':'A release operation is in progress.';
    return {sha:source?.sha??null,target:target?structuredClone(target):null,canDeploy:!blockedReason,blockedReason,current,recent};
  }
  function exclusive<T>(work:()=>Promise<T>):Promise<T>{if(closed)return Promise.reject(conflict('The controller is shutting down.'));if(busy)return Promise.reject(conflict('A release operation is in progress.'));busy=true;
    const operation=work().finally(()=>{busy=false;if(inFlight===operation)inFlight=undefined;});inFlight=operation;return operation;}
  async function unchanged(before:ReleaseEvidence,target?:ReleaseTarget){
    const current=await getEvidence();
    if(closed||!same(before,current)||target&&!same(target,state.targets[scope(before.source!)]))throw conflict('The source, gates or deployment target changed. Reload the pipeline.');
  }
  const update=(id:string,changes:Partial<ReleaseRecord>)=>save(next=>{const entry=next.releases.find(item=>item.id===id);if(!entry)throw new Error('Release record is unavailable.');Object.assign(entry.record,changes,{updatedAt:new Date().toISOString()});});
  const manager={
    view,
    async configure(input:unknown){
      await exclusive(async()=>{const target=releaseTarget(input),before=await getEvidence();if(!sourceValid(before.source))throw new Error('Connect a GitHub source before configuring a deployment.');
        if(own(before.source).some(entry=>active(entry.record)))throw conflict('A deployment is unresolved. Check its status before changing the target.');
        await github.verifyTarget(before.source,target);await unchanged(before);await save(next=>{next.targets[scope(before.source!)]=target;});
      });return view();
    },
    async deploy(input:{sha?:unknown;target?:unknown}){
      await exclusive(async()=>{
        const before=await getEvidence(),reason=evidenceReason(before);if(reason)throw conflict(reason);
        const source=before.source!,target=state.targets[scope(source)];
        if(!target)throw conflict('Configure a deployment target.');
        if(input?.sha!==source.sha)throw conflict('The selected commit changed. Reload the pipeline.');
        if(!same(releaseTarget(input?.target),target))throw conflict('The deployment target changed. Review and confirm it again.');
        if(own(source).some(entry=>active(entry.record)))throw conflict('A deployment is unresolved. Check its status before deploying again.');
        if(own(source).some(entry=>entry.source.sha===source.sha&&same(entry.target,target)&&entry.record.status==='deployed'))throw conflict('This commit is already deployed to this target.');
        const workflow=await github.verifyTarget(source,target);if(!workflowValid(workflow))throw new Error('Deployment workflow evidence is invalid.');
        await unchanged(before,target);
        const id=randomUUID(),time=new Date().toISOString(),entry:StoredRelease={id,source:structuredClone(source),target:structuredClone(target),gates:structuredClone(before.gates),workflow,
          record:{id,sha:source.sha,...target,status:'requesting',createdAt:time,updatedAt:time}};
        await save(next=>{if(next.releases.length>=1000)throw new Error('Release history is full. Preserve its records before continuing.');next.releases.push(entry);});
        try{await github.verifyCommit(source);await unchanged(before,target);}catch(error){await update(id,{status:'failed',error:failureText(error,500)});throw error;}
        let remote:ReleaseRemote;
        try{remote=await github.create(entry);}catch(error){const refused=object(error)&&(error as {definitive?:unknown}).definitive===true;
          await update(id,{status:refused?'failed':'unknown',error:refused?'GitHub refused the deployment request. Check the workflow, permissions and required commit statuses.':'The deployment request outcome is unknown. Check its status before deploying again.'});return;
        }
        await update(id,{...remote,error:undefined});
      });return view();
    },
    async refresh(){
      await exclusive(async()=>{
        const before=await getEvidence();if(!sourceValid(before.source))throw new Error('Connect a GitHub source before checking deployments.');
        const pending=own(before.source).filter(entry=>active(entry.record)||entry.source.sha===before.source!.sha).slice(-20);
        for(const entry of pending){
          // The current account must match the one which requested this deployment.
          if(entry.source.login!==before.source.login)continue;
          try{const remote=await github.read({...entry,...(entry.record.deploymentId?{deploymentId:entry.record.deploymentId}:{})});await unchanged(before);
            if(remote)await update(entry.id,{...remote,error:undefined});
          }catch(error){if(closed||!same(before,await getEvidence()))throw conflict('The source changed. Reload the pipeline.');
            await update(entry.id,{error:failureText(error,500)||'Could not confirm the deployment status. Check the connection and try again.'});}
        }
      });return view();
    },
    async close(){closed=true;clearInterval(timer);await inFlight?.catch(()=>{});await saves.idle();},
  };
  if(pollInterval>0){timer=setInterval(()=>{if(!closed&&!busy&&state.releases.some(entry=>active(entry.record)))void manager.refresh().catch(()=>{});},Math.max(1000,pollInterval));timer.unref();}
  return manager;
}
