import { createHash } from 'node:crypto';

/** A stage by its pipeline key and id. */
export type StageRef={key:string;stageId:string};
/** The id a stage's records are keyed by, one per pipeline key and stage; existing data directories are keyed by it. */
export const scopeId=({key,stageId}:StageRef)=>createHash('sha256').update(`${key}\0${stageId}`).digest('hex');
/** The statuses of an environment operation still under way; a restart never finds one of these intact. */
export const IN_PROGRESS: readonly string[]=['queued','creating','preparing','destroying'];
/** Whether an environment still holds resources: every one but a destroyed one, and a failed one that never got a sandbox or was cleaned up. */
export const holdsResources=(item:{status:string;sandboxId?:string|null;cleanedAt?:string|null})=>item.status!=='destroyed'&&!(item.status==='failed'&&(!item.sandboxId||item.cleanedAt));
export type UsageOptions={environmentId?:string|null;removalToken?:symbol|null;operation?:string};
type Lease={stage:string;environmentId:string|null;operation:string};
type Removal={stage:string;environmentIds:Set<string|null>};
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
/** A temporary reservation conflict, before an environment operation has started. */
export const environmentBusy=()=>Object.assign(conflict('This environment has an operation in progress.'),{code:'ENVIRONMENT_BUSY' as const});
export const isEnvironmentBusy=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ENVIRONMENT_BUSY';
const stageKey=({key,stageId}:StageRef)=>JSON.stringify([key,stageId]);

// Leases last until execution and its durable result have settled. Stage
// membership prevents removal; only the same environment requires exclusivity.
export function createEnvironmentUsage(){
  const leases=new Set<Lease>(),removals=new Map<symbol,Removal>();let closed=false;
  function assertAvailable(context:StageRef,{environmentId=null,removalToken=null}:UsageOptions={}){
    if(closed)throw conflict('The controller is shutting down.');
    const stage=stageKey(context);
    for(const [token,removal] of removals){
      if(removal.stage!==stage&&!removal.environmentIds.has(environmentId))continue;
      if(token===removalToken&&removal.stage===stage&&removal.environmentIds.has(environmentId))continue;
      throw conflict('This stage is being deleted. Retry deletion to finish its cleanup.');
    }
  }
  return {
    assertAvailable,
    acquire(context:StageRef,options:UsageOptions={}){
      assertAvailable(context,options);
      const {environmentId=null,operation='operation'}=options;
      if(environmentId&&[...leases].some(item=>item.environmentId===environmentId))throw environmentBusy();
      const lease:Lease={stage:stageKey(context),environmentId,operation};leases.add(lease);
      return ()=>leases.delete(lease);
    },
    isBusy:(environmentId:string)=>[...leases].some(item=>item.environmentId===environmentId)||[...removals.values()].some(item=>item.environmentIds.has(environmentId)),
    beginRemoval(context:StageRef,environmentIds:string[]=[]){
      assertAvailable(context);
      const stage=stageKey(context),ids=new Set<string|null>(environmentIds);
      if([...leases].some(item=>item.stage===stage||ids.has(item.environmentId)))throw conflict('Wait for this stage’s environment operations to finish before deleting it.');
      for(const removal of removals.values())if([...ids].some(id=>removal.environmentIds.has(id)))throw conflict('This environment is already being deleted.');
      const token=Symbol('stage-removal');removals.set(token,{stage,environmentIds:ids});return token;
    },
    endRemoval:(token:symbol)=>removals.delete(token),
    stopAdmissions(){closed=true;},
  };
}
export type EnvironmentUsage=ReturnType<typeof createEnvironmentUsage>;
