import type { AuthoringRecord } from '../../contract/authoring.ts';
import { restoreAuthoring, restoreAuthoringRecord, retainAuthoring, type AuthoringHistory } from './authoring.ts';
import {createSaveQueue,privateDirectory,readStateFile,writeStateFile} from '../store.ts';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,readdir,rm} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {hide,redact} from '../redaction.ts';
import {validateCallbackBindings,callbackPolicyHash,callbackApplication,resolveCallbackOrigins} from './callbacks.ts';
import type {AutomaticCallbackTarget,CallbackResolutionInput} from './callbacks.ts';
import {validateReadRequests,readPolicyHash,blockedRequest} from './read-requests.ts';
import {createBrowserRuntime,validateBrowserTarget,browserError,modelKeys} from './runtime.ts';
import {validateBrowserCases,browserDiscoveryContext,discoveredBrowserCases,assertReviewedJourneys,assertExecutableJourneyChecks,hasJourneyChecks} from '../business/browser-cases.ts';
import {createBrowserModelSettings} from './model.ts';
import {createOpenRouterModelCatalog,isOpenRouterEndpoint} from './openrouter-models.ts';
import {draftBrowserCase,transcribeBrowserAudio,validateTestDescription} from './openrouter-input.ts';
import {journeyResult,runStatus} from './results.ts';
import {controlBlockerText,controlReadReasonText} from '../journeys/playwright/control.ts';
import {controlBlocks,controlFailedRead} from './control-evidence.ts';
import {createJourneyScheduler,journeyConcurrency} from './journey-scheduler.ts';
import {createJourneyCode,restoreJourneyCode,replaceJourneyCases} from './journey-code.ts';
import type {GenerationFailure,JourneyCodeState,JourneyCodeSnapshot,Verification,VerificationIdentity,RunnableCode} from './journey-code.ts';
export type {SpecSummary} from './journey-code.ts';
import {applicationHost as canonicalHost,applicationOrigin,createEnvironmentUsage,scopeId,stageHeld} from '../environments/usage.ts';
import {accountSecrets,selectRunAccount} from './run-credentials.ts';
import type {AccountSignIn,RunCredentials} from './run-credentials.ts';
import {appId} from '../twin/detect.ts';
import {createTwinRuntime} from '../twin/runtime.ts';
import {createPlaywrightRuntime} from '../journeys/playwright/runtime.ts';
import {caseHash,signsIn} from '../journeys/playwright/specs.ts';
import {RUN,checkTemplate,resolvedFrom} from '../journeys/playwright/checks.ts';
import {CANCELLED,generateJourneySpec} from '../journeys/playwright/generation.ts';
import {privateWorkspace} from '../agents/opencode.ts';
import type {BrowserCase,MilestoneCheck} from '../business/browser-cases.ts';
import type {BrowserModelConfiguration} from './model-policy.ts';
import type {ModelSettingsReply} from '../../contract/settings.ts';
import type {BlockedRequest,ReadOnlyRequest,BrowserConfig,BrowserPreparation,BrowserDiscovery,BrowserAnalysis,MilestoneCheckResult,StepProgress as PublicStepProgress,BrowserAction,CaseProgress as PublicCaseProgress,RunProgress as PublicRunProgress,PublicRun,RunSummary,RunProgressReply,BrowserViewReply,BrowserSummaryReply,BrowserCapabilities as PublicCapabilities} from '../../contract/browser.ts';
export type {BrowserConfig,PublicRun,RunSummary} from '../../contract/browser.ts';
import type {BrowserCapabilities,BrowserWorkerInput,WorkerError,WorkerEvent,WorkerJob} from './runtime.ts';
import type {JourneyResult,RunStatus} from './results.ts';
import type {JourneyRunInput} from '../journeys/playwright/runtime.ts';
import type {EnvironmentAccount} from '../environments/manager.ts';
import type {EnvironmentUsage} from '../environments/usage.ts';
import type {ScanRepo,ScanService} from '../scanner.ts';

/** The active source scan, as far as browser tests read it (src/scanner.ts). */
type StageScan={repo:Pick<ScanRepo,'path'>&Partial<Pick<ScanRepo,'sha'>>;services?:readonly (Pick<ScanService,'id'>&Partial<Pick<ScanService,'framework'|'path'>>)[]};
/** The Sandbox stage a browser operation belongs to, with its active source. */
export type BrowserStageContext={key:string;stageId:string;scan:StageScan;controllerOrigin?:string};
/** The environment behind a target URL, as the environments manager resolves it (src/environments/manager.ts). */
export type TargetEnvironment={id:string;status:string;sandboxId?:string|null;stageId?:string|null;pipelineKey?:string|null;repoPath?:string|null;apps?:readonly unknown[]|null;services?:readonly unknown[]|null;accounts?:readonly EnvironmentAccount[]|null};
/** What the manager uses of environment leases. */
type Leases=Pick<EnvironmentUsage,'assertAvailable'|'acquire'>;
/** Runs one journey's approved Playwright code (src/journeys/playwright/runtime.ts). */
type JourneyRuntime={capabilities():Promise<{browserInstalled?:boolean}>;start(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void):WorkerJob<unknown>};
/** The browser agent, which discovers journeys; an absent capability is unknown. */
type AgentRuntime={capabilities():Promise<Partial<BrowserCapabilities>>;start(input:BrowserWorkerInput,onEvent:(event:WorkerEvent)=>void):WorkerJob<unknown>};

type CheckResult=MilestoneCheckResult&{provenance:'independent'};
type StepProgress=Omit<PublicStepProgress,'checks'>&{title:string;checks?:CheckResult[]};
type ActionProgress=BrowserAction;
/** Current execution always has initialized counts; old public history may predate them. */
export type CaseProgress=Omit<PublicCaseProgress,'steps'>&{actionCount:number;steps?:StepProgress[]};
export type RunProgress=Omit<PublicRunProgress,'cases'>&{revision:number;cases:CaseProgress[]};
type Discovery=BrowserDiscovery;
type Analysis=BrowserAnalysis;
/** A browser run (its journeys) or discovery, persisted with the approved case snapshots it executes. */
export type BrowserRun=Omit<PublicRun,'caseSummaries'|'progress'|'status'|'engine'>&{
  scope:string;status:'queued'|'running'|RunStatus;engine?:'playwright';approvedCases:BrowserCase[];progress:RunProgress;environmentUseUncertain?:boolean;codeFeedback?:Record<string,string>;
};
type Preparation=BrowserPreparation;
/** Browser ownership on a target Perpetual does not host; retained when process cleanup is unconfirmed. */
type ExternalOperation={id:string;scope:string;operation:'run'|'discover'|'generate';startedAt:string;cleanupIncomplete?:true;workspace?:string};
type BrowserState={
  version:1;configs:Record<string,BrowserConfig>;cases:Record<string,BrowserCase[]>;analyses:Record<string,Analysis>;runs:BrowserRun[];
  preparations:Record<string,Preparation>;preparationAttempts:Record<string,true>;configTargets:Record<string,{environmentId:string;url:string;applicationId?:string;signInPath?:string;suspendedReads?:{applicationId?:string;requests:ReadOnlyRequest[]}}>;specs:Record<string,JourneyCodeState['specs']>;externalOperations:Record<string,ExternalOperation>;generationFailures:Record<string,JourneyCodeState['generationFailures']>;authoring:AuthoringHistory;
};
/**
 * keepLease takes the run's lease as the run ends, instead of it being released, for a caller that goes on using the twin.
 * target: the config and twin a verification started with, which each of its attempts runs with instead of the stage's current ones.
 */
type StartOptions={manual?:boolean;verification?:Verification;preparation?:Preparation;isCurrent?:()=>boolean;keepLease?:(release:()=>void)=>void;target?:{config:BrowserConfig;environmentId:string|null;automaticTarget?:AutomaticCallbackTarget;callbackOrigins:string[]}};
/** A run request's fields; each is checked before use. */
type StartInput={credentials?:unknown;accountId?:unknown;concurrency?:unknown;caseIds?:unknown;replaceCaseIds?:unknown;baseCases?:unknown};
type InputOptions={signal?:AbortSignal;isCurrent?:()=>boolean};
/** A run's execution while it is active; kept in memory only. */
type RunJob={cancelled:boolean;cancel:()=>void;promise:Promise<void>|null;skips:Set<string>;scheduler?:{skip(id:string):boolean;cancel():void}};
/** A case's code generation: running, or why it failed until the next attempt. */
type Generation={scope:string;caseHash:string;discarded?:true;status:'running'|'failed';step?:string;error?:string;rejected?:string;cancelled:boolean;cancel():void};
/** A case's verification while it is between or inside attempts, or why it could not go on. */
type VerificationEntry=VerificationIdentity&{scope:string;caseId:string;cancelled:boolean;done:boolean;run:string|null;error?:string};
type StoredFrames={latest:Buffer|null;cases:Map<string,Buffer>};
/** The browser manager of a controller, as createBrowserManager returns it. */
export type BrowserManager=Awaited<ReturnType<typeof createBrowserManager>>;
export type BrowserManagerOptions={
  dataDir:string;runtime?:AgentRuntime;playwright?:JourneyRuntime;generation?:Partial<Parameters<typeof generateJourneySpec>[0]>;usage?:Leases;
  resolveEnvironment?:(url:string)=>TargetEnvironment|null|undefined;onEnvironmentUncertain?:(environmentId:string,error:string)=>Promise<unknown>;
  twinAccount?:(environment:TargetEnvironment,accountId:string)=>Promise<AccountSignIn|null|undefined>;
};

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const includes=<T>(list:readonly T[],value:unknown):value is T=>(list as readonly unknown[]).includes(value);
// An error's message, or anything else thrown as it is.
const messageOf=(error:unknown):unknown=>typeof error==='object'&&error!==null&&'message' in error?error.message:undefined;
const now=()=>new Date().toISOString();
const runConcurrency=(value:unknown)=>{if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>4)throw new Error('Choose 1–4 concurrent journeys.');return value;};
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const publicRun=({scope,approvedCases,environmentUseUncertain,codeFeedback,...run}:StoredRun):PublicRun=>structuredClone({...run,caseSummaries:(approvedCases||[]).map(({id,name,goal,preconditions,expectedOutcomes,assertions,steps,isolation})=>({id,name,goal,preconditions,expectedOutcomes,assertions,steps:steps||[],isolation:isolation||'shared'}))});
const summaryKeys=new Set<string>(['id','stageId','environmentId','mode','engine','verification','status','createdAt','startedAt','completedAt','targetUrl','sourceRevision','caseIds','caseSummaries','results','error','blockedRequests','frameUpdatedAt','frameCapturedAt','concurrency','effectiveConcurrency','concurrencyLimit','callbackPolicy','callbackOrigins']);
type StoredRun=Omit<BrowserRun,'progress'>&{progress?:RunProgress};
// Graph polling carries live state only; full action lists stay in runProgress.
function summaryRun({progress,...run}:BrowserRun,withProgress:boolean):RunSummary{
  // Only the summary keys of the public run.
  const view=Object.fromEntries(Object.entries(publicRun(run)).filter(([key])=>summaryKeys.has(key))) as RunSummary;
  if(withProgress&&progress)view.progress=structuredClone({...progress,cases:progress.cases.map(({actions,...item})=>item)});
  return view;
}
const defaults:BrowserConfig={targetUrl:'',signInUrl:'',scope:'',requirements:'',maxSteps:60,journeyTimeoutSeconds:900,externalOrigins:[],authEndpoints:[]};
// The twin a verification started on is gone or no longer ready, so its attempts cannot go on there.
const TWIN_CHANGED='The environment changed during its verification. Verify its code again.';
const active=(run:StoredRun)=>['queued','running'].includes(run.status);
// Playwright names each tab's recording; a stage keeps the recordings of its latest runs.
const VIDEO_RUNS_PER_STAGE=5,videoName=/^page@[a-f0-9]{32}\.webm$/,runFolder=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeText=(value:unknown,limit:number)=>value?browserError(String(value),process.env,limit):'';
const touch=(run:BrowserRun)=>{run.progress.revision=(run.progress.revision||0)+1;};
const settleSteps=(progress:{steps?:StepProgress[]},status:string)=>{for(const step of progress.steps||[])if(step.status==='running')step.status=['skipped','cancelled'].includes(status)?status:'unconfirmed';};
const actionErrorCodes:ReadonlySet<string>=new Set(['action_not_allowed','navigation_not_allowed','attachments_not_allowed','credential_literal_rejected','credential_reference_invalid','credential_origin_mismatch','credential_field_unavailable','credential_target_mismatch','credential_frame_mismatch','credential_field_type_mismatch','credential_verification_failed','browser_action_failed','action_result_missing','journey_progress_invalid']);
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const webFrontend=/^(?:next(?:\.js)?|vite|nuxt|react|sveltekit|astro|remix)$/i;
const originOf=(value:string)=>{try{return new URL(value).origin;}catch{return null;}};
const externalOrigin=(value:string)=>{const origin=applicationOrigin(value);if(!origin)throw new Error('Invalid application origin.');return origin;};
// An environment's browser-reachable apps. A detected twin names each after its repository service id; a generated one
// may not, so its directory identifies the service too.
const applications=(environment:TargetEnvironment|null|undefined)=>(environment?.apps??[]).filter((app):app is {id?:unknown;url:string;directory?:unknown}=>isRecord(app)&&typeof app.url==='string'&&Boolean(originOf(app.url)));
const folder=(value:unknown)=>typeof value==='string'?value.replace(/^(?:\.\/)+|\/+$/g,'').replace(/^\.$/,''):null;
/** The target an environment implies: its one web-frontend app, else its only app; null when ambiguous. */
function applicationUrl(environment:TargetEnvironment,scan:StageScan){
  const apps=applications(environment);
  const serves=(app:{id?:unknown;directory?:unknown},service:{id:string;path?:string})=>appId(service.id)===appId(app.id)||(folder(app.directory)!==null&&folder(app.directory)===folder(service.path));
  const frontends=apps.filter(app=>(scan.services||[]).some(service=>serves(app,service)&&webFrontend.test(service.framework||'')));
  return frontends.length===1?frontends[0].url:apps.length===1?apps[0].url:null;
}
function externalOrigins(value:unknown,context:{controllerOrigin?:string}){
  if(!Array.isArray(value)||value.length>10)throw new Error('Add at most 10 external origins.');
  return [...new Set(value.map(item=>{
    let url=null;try{url=new URL(item);validateBrowserTarget(item,context);}catch{url=null;}
    // validateBrowserTarget applies the same local HTTP, internal-address and controller exclusion rules as the app.
    if(typeof item!=='string'||!url||url.username||url.password||url.pathname!=='/'||/[?#]/.test(item))throw new Error('External origins must use HTTPS or a local application host, without credentials, paths or queries.');
    return url.origin;
  }))];
}
function authEndpoints(value:unknown,targetUrl:string){
  if(!Array.isArray(value)||value.length>3)throw new Error('Add at most 3 auth endpoints.');
  return [...new Set(value.map(item=>{
    let url=null;try{url=new URL(item);}catch{url=null;}
    if(typeof item!=='string'||item.length>2048||!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||/[?#]/.test(item))throw new Error('Auth endpoints must be absolute URLs without credentials or queries.');
    // A bare origin would admit every POST on that port; the runner rejects it too.
    if(url.pathname==='/')throw new Error('Auth endpoints need a path such as /auth/v1/token.');
    if(targetUrl&&canonicalHost(url.hostname)!==canonicalHost(new URL(targetUrl).hostname))throw new Error('Auth endpoints must be on the application host.');
    return url.href;
  }))];
}
// The sign-in page is on the application URL's origin, without credentials. A person's value keeps its hash, since a
// hash-routed application shows its form only on its route, such as #/login; an empty hash is none. A person's save that
// moves the application URL to another origin while the sign-in page stays on the old one is refused, so a person's
// value is never dropped silently.
function signInPage(value:unknown,targetUrl:string){
  if(value===undefined||value==='')return '';
  const long=new Error('Use a sign-in page of at most 2048 characters.');
  if(typeof value==='string'&&value.length>2048)throw long;
  let url:URL|null=null;try{url=typeof value==='string'?new URL(value):null;}catch{url=null;}
  if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Enter the sign-in page as an HTTP or HTTPS URL without credentials.');
  if(!targetUrl||url.origin!==new URL(targetUrl).origin)throw new Error('Use a sign-in page on the application URL’s origin.');
  // The stored value is the normalized URL, which is read back as it was saved, so it fits the limit too.
  if(!url.hash)url.hash='';if(url.href.length>2048)throw long;return url.href;
}
// The page discovery's sign-in form was on, as a sign-in page: only its path on the application URL's origin, since a
// query, credentials or a segment's ;-parameters, such as a servlet's ;jsessionid=, can carry tokens. A page with a
// hash is ignored too: the hash can carry a token, and the path alone may not show the form, as on a hash route.
// Anything else is ignored.
function discoveredSignInPage(value:unknown,targetUrl:string){
  let url:URL|null=null;try{url=typeof value==='string'&&value.length<=2048?new URL(value):null;}catch{url=null;}
  if(!url||!['http:','https:'].includes(url.protocol)||url.origin!==originOf(targetUrl)||url.hash)return null;
  // Dropping a first segment's parameters, as in /;jsessionid=…/login, leaves one leading slash, never a // path.
  return `${url.origin}${url.pathname.split('/').map(segment=>segment.split(';')[0]).join('/').replace(/^\/+/,'/')}`;
}
// A sign-in page's path, query and hash on another origin, as a new twin of the same application serves it; empty when
// that is no sign-in page for it. The path is appended to the origin, so a path that starts with // stays a path.
function movedSignInPage(path:string,targetUrl:string){try{return signInPage(`${new URL(targetUrl).origin}${path}`,targetUrl);}catch{return '';}}
const signInPath=(value:string)=>{const {pathname,search,hash}=new URL(value);return `${pathname}${search}${hash}`;};
function normalizedConfig(input:unknown,context:{controllerOrigin?:string}):BrowserConfig{
  if(!isRecord(input))throw new Error('Provide browser test settings.');
  for(const [key,limit] of [['scope',4000],['requirements',12000]] as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>limit))throw new Error(`${key} exceeds its allowed size.`);
  const maxSteps=input.maxSteps??defaults.maxSteps;if(typeof maxSteps!=='number'||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100)throw new Error('Choose 1–100 browser actions per case.');
  const journeyTimeoutSeconds=input.journeyTimeoutSeconds??defaults.journeyTimeoutSeconds;if(typeof journeyTimeoutSeconds!=='number'||!Number.isInteger(journeyTimeoutSeconds)||journeyTimeoutSeconds<60||journeyTimeoutSeconds>1800)throw new Error('Choose a journey time limit of 60–1800 seconds.');
  const targetUrl=input.targetUrl?validateBrowserTarget(String(input.targetUrl),context):'';
  const fixed=externalOrigins(input.externalOrigins??[],context),bindings=validateCallbackBindings(input.callbackBindings,fixed.length);
  const reads=validateReadRequests(input.readOnlyRequests===undefined?[]:input.readOnlyRequests,targetUrl);
  // scope and requirements are strings or empty now.
  return {targetUrl,signInUrl:signInPage(input.signInUrl,targetUrl),scope:(input.scope||'') as string,requirements:(input.requirements||'') as string,maxSteps,journeyTimeoutSeconds,externalOrigins:fixed,...(bindings.length?{callbackBindings:bindings}:{}),authEndpoints:authEndpoints(input.authEndpoints??[],targetUrl),...(reads.length?{readOnlyRequests:reads}:{})};
}

// Mirrors the runner: evaluated checks accompany completed or failed milestones only,
// and a milestone fails only from an independent check. Definitions come from the approved snapshot.
function milestoneChecks(definitions:readonly MilestoneCheck[],received:unknown,status:string):CheckResult[]|null{
  const invalid=()=>new Error('Browser progress returned invalid milestone checks.');
  const list=received??[];
  if(!Array.isArray(list))throw invalid();
  if(!['completed','failed'].includes(status)||!definitions.length){if(list.length||status==='failed')throw invalid();return null;}
  if(status==='completed'?list.length!==definitions.length:!list.length||list.length>definitions.length)throw invalid();
  const checks=list.map((item:unknown,index):CheckResult=>{
    const definition=definitions[index];
    if(!isRecord(item)||item.type!==definition.type||('value' in definition&&item.value!==definition.value)||typeof item.passed!=='boolean'||(item.observed!=null&&(typeof item.observed!=='number'||!Number.isFinite(item.observed)))||(item.error!=null&&typeof item.error!=='string'))throw invalid();
    // A check that names the run's token as {run} reports the text it looked for; any other reports none.
    const template=checkTemplate(definition);
    if(template.includes(RUN)?!resolvedFrom(template,item.resolved):item.resolved!==undefined)throw invalid();
    return {...definition,passed:item.passed,...(item.observed!=null?{observed:item.observed}:{}),...(typeof item.resolved==='string'?{resolved:item.resolved}:{}),...(item.error?{error:safeText(item.error,800)}:{}),provenance:'independent'};
  });
  if(status==='completed'?checks.some(check=>!check.passed):checks.every(check=>check.passed))throw invalid();
  return checks;
}
// Mirrors the fixture: it starts the first unfinished milestone running, without evidence, then ends it
// completed, blocked or failed with the evidence of its reviewed checks. All three are terminal.
function acceptMilestone(progress:CaseProgress,event:WorkerEvent,approved:BrowserCase|undefined){
  const step=progress.steps?.find(item=>item.id===event.stepId);
  if(!step||!includes(['running','completed','blocked','failed'],event.status))throw new Error('Browser progress referenced an invalid journey step.');
  const start=event.status==='running',evidence=event.evidence;
  if(start?evidence!==undefined:typeof evidence!=='string'||!evidence.trim()||evidence.length>2000||controls.test(evidence))throw new Error('Milestones start without evidence and end with 1–2000 characters of observed evidence.');
  if(step.status!==(start?'pending':'running')||start&&step!==progress.steps!.find(item=>item.status!=='completed'))throw new Error('Browser milestones must follow the reviewed journey order.');
  const status=event.status as string;
  const checks=milestoneChecks(approved?.steps?.find(item=>item.id===step.id)?.checks||[],event.checks,status);
  Object.assign(step,{status,...(start?{}:{evidence:safeText(evidence,2000)})});
  if(checks)step.checks=checks;
}

// twinAccount(environment, accountId) reads a test account's credentials from the environment's twin, named by its id.
// generation holds generateJourneySpec options, such as a harness in place of OpenCode.
export async function createBrowserManager({dataDir,runtime,playwright=createPlaywrightRuntime(),generation={},usage=createEnvironmentUsage(),resolveEnvironment=()=>null,onEnvironmentUncertain=async()=>{},twinAccount=(environment,accountId)=>createTwinRuntime().account({dataDir,id:environment.id,accountId})}:BrowserManagerOptions){
  const root=await privateDirectory(resolve(dataDir,'browser'),'Browser storage must not be a symbolic link.');const file=join(root,'state.json');
  // <runId>/page@<hex>.webm; each journey's worker names its own files in its video event.
  const videoRoot=join(root,'videos');await mkdir(videoRoot,{recursive:true,mode:0o700});
  // Pruning deletes inside this folder, so it must be the controller's own.
  const videoInfo=await lstat(videoRoot);if(videoInfo.isSymbolicLink()||!videoInfo.isDirectory())throw new Error('Browser recording storage must not be a symbolic link.');
  // <uuid>/ per code generation; unconfirmed external browser ownership keeps its workspace across a restart.
  const generationRoot=join(root,'generations');await mkdir(generationRoot,{recursive:true,mode:0o700});
  const generationInfo=await lstat(generationRoot);if(generationInfo.isSymbolicLink()||!generationInfo.isDirectory())throw new Error('Code generation storage must not be a symbolic link.');
  const modelSettings=await createBrowserModelSettings({dataDir});
  const generationDiagnostic=(value:unknown,limit=800,secrets:unknown[]=[])=>browserError(hide([...modelKeys(modelSettings.configuration().apiKey),...secrets])(String(messageOf(value)||value||'Code generation failed.')),process.env,limit);
  const modelCatalog=createOpenRouterModelCatalog();
  runtime ||= createBrowserRuntime({model:()=>modelSettings.configuration()});
  let state:BrowserState={version:1,configs:{},cases:{},analyses:{},runs:[],preparations:{},preparationAttempts:{},configTargets:{},specs:{},externalOperations:{},generationFailures:{},authoring:{}};
  // The file is data: every record the restart and the views read is checked first. A run from an older controller may
  // lack its progress, results or newer fields.
  const records=(value:unknown)=>isRecord(value)&&Object.values(value).every(isRecord);
  const optionalRecords=(value:unknown)=>value==null||Array.isArray(value)&&value.every(isRecord);
  const storedRun=(run:unknown)=>isRecord(run)&&['id','scope','status'].every(key=>typeof run[key]==='string')&&Array.isArray(run.caseIds)&&optionalRecords(run.approvedCases)&&optionalRecords(run.results)
    &&(run.progress==null||isRecord(run.progress)&&Array.isArray(run.progress.cases)&&run.progress.cases.every(item=>isRecord(item)&&optionalRecords(item.steps)));
  {const saved=await readStateFile(file,{limit:16*1024*1024,invalid:'Invalid browser state.'});if(saved!==undefined){if(!isRecord(saved)||saved.version!==1||!Array.isArray(saved.runs)||!saved.runs.every(storedRun)||!records(saved.configs)||!isRecord(saved.cases)||!isRecord(saved.analyses))throw new Error('Unsupported browser state.');state=saved as BrowserState;}}
  for(const key of ['preparations','preparationAttempts','configTargets','specs'] as const){state[key]??={};if(typeof state[key]!=='object'||Array.isArray(state[key])||(key==='preparations'||key==='configTargets')&&!records(state[key]))throw new Error('Unsupported browser preparation state.');}
  // A stored transport refusal has the same fixed shape as live worker facts, before history or
  // verification is reconstructed. Legacy results without this optional field remain unchanged.
  for(const run of state.runs)for(const result of run.results||[]){
    const facts:unknown=result;
    if(!isRecord(facts)||facts.controlBlocker!==undefined&&(facts.controlRead!==false||!controlBlockerText(facts.controlBlocker)))throw new Error('Invalid stored control limitation.');
    if(facts.controlReadReason!==undefined&&(facts.controlRead!==false||!controlReadReasonText(facts.controlReadReason)))throw new Error('Invalid stored control read diagnosis.');
    const transports=controlBlocks(facts.controlBlocks);
    if(!transports||facts.controlBlocks!==undefined&&facts.controlRead!==false)throw new Error('Invalid stored control transport evidence.');
    if(facts.controlBlocks!==undefined)result.controlBlocks=transports;
    const failedRead=controlFailedRead(facts.controlFailedRead);
    if(failedRead===null||facts.controlFailedRead!==undefined&&(facts.controlRead!==false||facts.controlReadReason!=='read-failed'))throw new Error('Invalid stored failed control read.');
    if(failedRead)result.controlFailedRead=failedRead;
  }
  // New policy and evidence fields are untrusted file data too: reject unsafe rules before any view or fingerprint,
  // and retain only the same bounded redacted diagnostic shape that live worker events can publish.
  for(const config of Object.values(state.configs))validateCallbackBindings(config.callbackBindings,externalOrigins(config.externalOrigins??[],{}).length);
  const storedPolicy=(value:unknown)=>value===undefined||value===''||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  for(const run of state.runs){
    if(!storedPolicy(run.callbackPolicy)||run.verification&&!storedPolicy(run.verification.callbackPolicy))throw new Error('Invalid stored callback policy.');
    if(run.callbackOrigins!==undefined){
      const origins:unknown=run.callbackOrigins;
      if(!Array.isArray(origins)||origins.length>2||new Set(origins).size!==origins.length||origins.some(value=>{try{if(typeof value!=='string')return true;const url=new URL(value);return url.origin!==value||url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||!url.port;}catch{return true;}}))throw new Error('Invalid stored callback origins.');
    }
  }
  for(const config of Object.values(state.configs))if(config.readOnlyRequests!==undefined){
    try{config.readOnlyRequests=validateReadRequests(config.readOnlyRequests,config.targetUrl);}catch{throw new Error('Invalid stored read-only POST requests.');}
  }
  for(const target of Object.values(state.configTargets)){
    if(target.applicationId!==undefined&&(typeof target.applicationId!=='string'||!target.applicationId||target.applicationId.length>1024))throw new Error('Invalid stored POST-read application.');
    if(target.suspendedReads!==undefined){
      const suspended:unknown=target.suspendedReads;
      try{
        if(!isRecord(suspended)||suspended.applicationId!==undefined&&(typeof suspended.applicationId!=='string'||!suspended.applicationId||suspended.applicationId.length>1024)||!Array.isArray(suspended.requests))throw new Error();
        const first=suspended.requests[0];
        target.suspendedReads={...(typeof suspended.applicationId==='string'?{applicationId:suspended.applicationId}:{}),requests:validateReadRequests(suspended.requests,isRecord(first)&&typeof first.url==='string'?first.url:'')};
      }catch{throw new Error('Invalid stored read-only POST requests.');}
    }
  }
  for(const run of state.runs)if(run.codeFeedback!==undefined){
    const feedback:unknown=run.codeFeedback;
    if(!isRecord(feedback)||Object.keys(feedback).length>30||Object.entries(feedback).some(([id,error])=>!run.caseIds.includes(id)||typeof error!=='string'||!error||error.length>4000))throw new Error('Invalid stored code feedback.');
    run.codeFeedback=Object.fromEntries(Object.entries(feedback).map(([id,error])=>[id,generationDiagnostic(error,4000)]));
  }
  for(const run of state.runs)if(run.blockedRequests!==undefined){
    const found:BlockedRequest[]=[];
    for(const item of Array.isArray(run.blockedRequests)?run.blockedRequests:[]){
      const request=isRecord(item)?blockedRequest(item.method,item.url):null;
      if(request&&found.length<10&&!found.some(value=>value.method===request.method&&value.url===request.url))found.push(request);
    }
    run.blockedRequests=found;
  }
  const external:unknown=state.externalOperations??{};
  if(!isRecord(external)||Object.entries(external).some(([origin,item])=>{
    if(!isRecord(item)||typeof item.id!=='string'||typeof item.scope!=='string'||typeof item.startedAt!=='string'||typeof item.operation!=='string'||!['run','discover','generate'].includes(item.operation)||item.cleanupIncomplete!==undefined&&item.cleanupIncomplete!==true)return true;
    try{if(externalOrigin(origin)!==origin)return true;}catch{return true;}
    return item.workspace!==undefined&&(typeof item.workspace!=='string'||!runFolder.test(item.workspace));
  }))throw new Error('Unsupported external browser ownership state.');
  state.externalOperations=external as Record<string,ExternalOperation>;
  // A restart cannot prove that the previous controller's processes exited. Preserve their hold and workspace.
  for(const operation of Object.values(state.externalOperations))operation.cleanupIncomplete=true;
  const retainedWorkspaces=new Set(Object.values(state.externalOperations).map(operation=>operation.workspace));
  await Promise.all((await readdir(generationRoot)).filter(name=>runFolder.test(name)&&!retainedWorkspaces.has(name)).map(name=>rm(join(generationRoot,name),{recursive:true,force:true})));
  // Add current draft defaults without rewriting immutable historical approvals.
  for(const [scope,cases] of Object.entries(state.cases))state.cases[scope]=validateBrowserCases(cases,{draft:true});
  const failures:unknown=state.generationFailures??{};
  if(!isRecord(failures))throw new Error('Unsupported code generation failure state.');
  state.generationFailures={};
  for(const scope of new Set([...Object.keys(state.specs),...Object.keys(failures)])){
    const code=restoreJourneyCode({specs:state.specs[scope]??{},generationFailures:failures[scope]??{}},state.cases[scope]||[],generationDiagnostic);
    state.specs[scope]=code.specs;state.generationFailures[scope]=code.generationFailures;
  }
  state.authoring=restoreAuthoring(state.authoring??{},state.cases,hide([modelSettings.configuration().apiKey]));
  const saves=createSaveQueue();let closed=false,modelSaving=false,closing:Promise<void>|undefined;const jobs=new Map<string,RunJob>(),inputJobs=new Map<AbortController,Promise<unknown>>(),busy=new Set<string>(),frames=new Map<string,StoredFrames>(),admissions=new Set<Promise<unknown>>();
  // Only this controller's jobs and an unsaved failure need live entries. Durable failures contain no worker callbacks.
  const generations=new Map<string,Generation>(),generationJobs=new Set<Promise<void>>(),generationKey=(scope:string,caseId:string)=>`${scope}\0${caseId}`;
  const generating=(scope?:string)=>[...generations.values()].some(entry=>entry.status==='running'&&(scope===undefined||entry.scope===scope));
  // One verification per case, keyed like generations: {id,scope,caseId,hash,cancelled,done,error?,run?}. Its state
  // is derived from its runs; this marker only says it is still between or inside attempts, or why it could not go on.
  const verifications=new Map<string,VerificationEntry>(),verificationJobs=new Set<Promise<void>>();
  const verifying=(scope?:string,caseId?:string)=>[...verifications.values()].some(entry=>!entry.done&&(scope===undefined||entry.scope===scope)&&(caseId===undefined||entry.caseId===caseId));
  // The run history keeps the controller's latest 50 runs, and every attempt of a verification still running.
  const kept=(run:BrowserRun,index:number)=>index<50||active(run)||[...verifications.values()].some(entry=>!entry.done&&entry.id===run.verification?.id);
  // An operation holds its stage in busy until it ends; whenFree(scope) resolves once the stage's holder lets go.
  const waiters=new Map<string,(()=>void)[]>();
  const free=(scope:string)=>{busy.delete(scope);const resolved=waiters.get(scope)||[];waiters.delete(scope);for(const resolve of resolved)resolve();resumePreparations();};
  const whenFree=(scope:string)=>new Promise<void>(resolve=>{waiters.set(scope,[...waiters.get(scope)||[],resolve]);});
  // A stage's own operations that a preparation's discovery must wait for, as requireIdle refuses them.
  const stageBusy=(scope:string)=>modelSaving||busy.has(scope)||verifying(scope)||state.runs.some(run=>run.scope===scope&&active(run));
  // A twin that became ready while its stage was busy is prepared once the stage is idle, by scope; kept in memory only.
  const pendingPreparations=new Map<string,()=>Promise<unknown>>();
  function resumePreparations(){
    for(const [scope,prepare] of pendingPreparations)if(!closed&&!stageBusy(scope)){pendingPreparations.delete(scope);admit(prepare).catch(()=>{});}
  }
  function admit<T>(work:()=>T|PromiseLike<T>):Promise<T>{
    if(closed)return Promise.reject(conflict('The controller is shutting down.'));
    let promise:Promise<T>;try{promise=Promise.resolve(work());}catch(error){return Promise.reject(error);}admissions.add(promise);
    promise.finally(()=>admissions.delete(promise)).catch(()=>{});return promise;
  }
  // Recordings of each stage's latest runs are kept; a run's recordings go with it.
  async function pruneVideos(){
    const kept=new Set<string>(),count=new Map<string,number>();
    for(const run of state.runs){
      if(active(run)){kept.add(run.id);continue;}
      if(run.mode!=='run')continue;
      const n=count.get(run.scope)||0;
      if(n<VIDEO_RUNS_PER_STAGE){kept.add(run.id);count.set(run.scope,n+1);}
      else for(const item of run.progress?.cases||[])delete item.videos;
    }
    // Only run folders are removed; anything else placed here is left alone.
    const names=(await readdir(videoRoot).catch(()=>[])).filter(name=>runFolder.test(name)&&!kept.has(name));
    await Promise.all(names.map(name=>{const path=join(videoRoot,name);return lstat(path).then((info):unknown=>info.isDirectory()&&rm(path,{recursive:true,force:true})).catch(()=>{});}));
  }
  function persist(project:()=>BrowserState=()=>state,commit=()=>{}):Promise<void>{return saves.run(async()=>{const projected=project(),authoring=retainAuthoring(projected.authoring??{},projected.cases);const content=JSON.stringify({...projected,authoring});if(Buffer.byteLength(content)>16*1024*1024)throw new Error('Browser metadata storage is full.');await writeStateFile(file,content);commit();state.authoring=authoring;});}
  const externalLeases=new Set<string>();
  const externalCleanup='Browser cleanup for this application is unconfirmed. Stop the remaining browser processes and confirm cleanup before using this URL again.';
  function takeTarget(context:BrowserStageContext,url:string,environmentId:string|null|undefined,operation:string){
    const origin=externalOrigin(url);
    // An earlier external operation may still be acting on an origin that a newly owned twin now uses.
    const retained=state.externalOperations[origin];
    if(retained&&(retained.cleanupIncomplete||!externalLeases.has(origin)))throw conflict(externalCleanup);
    if(externalLeases.has(origin))throw conflict('This application has a browser operation in progress.');
    const release=usage.acquire(context,{environmentId,operation});
    if(environmentId)return release;
    externalLeases.add(origin);
    let released=false;
    return ()=>{if(released)return;released=true;externalLeases.delete(origin);release();};
  }
  async function beginExternal(context:BrowserStageContext,url:string,environment:TargetEnvironment|null|undefined,operation:ExternalOperation['operation'],workspace?:string){
    if(environment)return null;
    const origin=externalOrigin(url),entry:ExternalOperation={id:randomUUID(),scope:scopeId(context),operation,startedAt:now(),...(workspace?{workspace:basename(workspace)}:{})};
    await persist(()=>({...state,externalOperations:{...state.externalOperations,[origin]:entry}}),()=>{state.externalOperations[origin]=entry;});
    return {origin,entry};
  }
  async function finishExternal(owned:Awaited<ReturnType<typeof beginExternal>>,uncertain=false){
    if(!owned||state.externalOperations[owned.origin]?.id!==owned.entry.id)return;
    if(uncertain){owned.entry.cleanupIncomplete=true;await persist();return;}
    try{await persist(()=>({...state,externalOperations:Object.fromEntries(Object.entries(state.externalOperations).filter(([origin])=>origin!==owned.origin))}),()=>{delete state.externalOperations[owned.origin];});}
    catch(error){owned.entry.cleanupIncomplete=true;throw error;}
  }
  // Journeys that never started are cancelled, not failed; interrupted milestones stay unconfirmed. A restart ends a
  // verification, so its interrupted attempt is cancelled rather than judged.
  const interrupted:Partial<Record<string,'cancelled'|'failed'|'skipped'>>={pending:'cancelled',queued:'cancelled',running:'failed',skipping:'skipped',cancelling:'cancelled'};
  for(const run of state.runs)if(active(run)){
    if(!run.environmentId)state.externalOperations[externalOrigin(run.targetUrl)]??={id:run.id,scope:run.scope,operation:run.mode,startedAt:run.createdAt,cleanupIncomplete:true};
    const attempt=Boolean(run.verification);
    Object.assign(run,{status:attempt?'cancelled':'failed',error:attempt?'The controller stopped during this verification.':'The controller stopped during this operation.',completedAt:now(),...(run.environmentId?{environmentUseUncertain:true}:{})});
    for(const item of run.progress?.cases||[])if(interrupted[item.status]){
      const status=attempt&&item.status==='running'?'cancelled':interrupted[item.status]!,unstarted=status==='cancelled'&&['pending','queued'].includes(item.status);
      Object.assign(item,{status,completedAt:run.completedAt});settleSteps(item,status);
      if(run.mode!=='run'||(run.results||[]).some(result=>result.caseId===item.id))continue;
      // An interrupted journey ended on the controller's exception; cancelled and skipped journeys have no verdict.
      // A run's journeys are its approved cases.
      const result=status==='failed'?journeyResult((run.approvedCases||[]).find(value=>value.id===item.id)??{id:item.id},{caseId:item.id,stopCause:'exception',error:'The controller stopped during this journey.'},item.steps):{caseId:item.id,status,assertions:[],...(unstarted?{error:'Controller stopped before this journey started'}:{})};
      run.results=[...(run.results||[]),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
    }
    if(run.progress)touch(run);
  }
  for(const preparation of Object.values(state.preparations))if(['preparing','discovering'].includes(preparation.status))Object.assign(preparation,{status:'failed',error:'The controller stopped while preparing integration tests. Discover cases to try again.',completedAt:now()});
  // Also removes folders left by a crash or by runs past the history limit.
  await pruneVideos();
  await persist();
  const codeState=(scope:string):JourneyCodeState=>({specs:state.specs[scope]||{},generationFailures:state.generationFailures[scope]||{},authoring:retainAuthoring(state.authoring,state.cases)[scope]||{}});
  const codeSnapshot=(scope:string):JourneyCodeSnapshot=>({
    callbackPolicy:callbackPolicyHash(scope,state.configs[scope]?.callbackBindings),readPolicy:readPolicyHash(state.configs[scope]?.readOnlyRequests,state.configTargets[scope]?.url===state.configs[scope]?.targetUrl?state.configTargets[scope]?.applicationId:undefined),code:codeState(scope),cases:state.cases[scope]||[],runs:state.runs.filter(run=>run.scope===scope),
    verifications:[...verifications.values()].filter(entry=>entry.scope===scope),
    generations:new Map((state.cases[scope]||[]).flatMap(item=>{const entry=generations.get(generationKey(scope,item.id));return entry?[[item.id,entry] as const]:[];})),
  });
  const journeyCode=createJourneyCode({read:codeSnapshot,async transact(scope:string,change:(current:JourneyCodeSnapshot)=>JourneyCodeState){
    let next:JourneyCodeState;
    await persist(()=>{
      next=change(codeSnapshot(scope));
      return {...state,specs:{...state.specs,[scope]:next.specs},generationFailures:{...state.generationFailures,[scope]:next.generationFailures},authoring:{...state.authoring,[scope]:next.authoring||{}}};
    },()=>{state.specs[scope]=next.specs;state.generationFailures[scope]=next.generationFailures;state.authoring[scope]=next.authoring||{};});
  }});
  const specView=(scope:string)=>journeyCode.summary(scope);
  function discardObsoleteGenerations(scope:string,cases:readonly BrowserCase[]){
    for(const [key,entry] of generations)if(entry.scope===scope){
      const item=cases.find(item=>generationKey(scope,item.id)===key);
      if(!item||caseHash(item)!==entry.caseHash){entry.discarded=true;if(entry.status==='failed')generations.delete(key);else if(!item)entry.cancel();}
    }
  }
  // Admission owns stage/worker conflicts; the code owner judges each write against its queue-time state.
  function writeSpec(context:BrowserStageContext,caseId:unknown,write:(scope:string,caseId:string)=>Promise<unknown>){return admit(async()=>{
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is being generated. Stop it first.');
    if(verifying(scope,item.id))throw conflict('Code for this test is being verified. Stop it first.');
    await write(scope,item.id);
    if(generations.get(key)?.status==='failed')generations.delete(key);
    return {spec:{caseId:item.id,...specView(scope)[item.id]},specs:specView(scope)};
  });}
  /**
   * Verifies a case's current draft before it may be approved: up to three ordinary runs of exactly that code for its
   * one case, then a control run with every state-changing request blocked. The journey must pass each run, and a
   * reviewed check must fail in the control run. Only this request starts it; a gate waits while it runs.
   */
  function verifySpec(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown;credentials?:unknown;accountId?:unknown}){
    requireIdle(context);
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===input?.caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is being generated. Stop it first.');
    // A generation holds the twin the attempts need.
    if(generating(scope))throw conflict('Code is being generated in this stage. Wait or stop it first.');
    const verification=journeyCode.verification(scope,item.id,input.hash);
    // The attempts sign in as a person's run does: the entered account, the chosen twin account, else the twin's first.
    const account=Object.fromEntries((['credentials','accountId'] as const).filter(name=>input[name]!==undefined).map((name):[string,unknown]=>[name,input[name]]));
    // Every attempt runs with the config and on the twin the verification starts with, so another twin of the stage that
    // becomes ready meanwhile never takes over some of its attempts.
    const config=normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
    // A twin a run would refuse is refused before anything is recorded; only a change between attempts ends a verification.
    const environment=resolveEnvironment(config.targetUrl);
    if(environment&&environment.status!=='ready')throw conflict('The selected application environment is not ready. Choose an available application URL.');
    if(environment&&state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
    const automaticTarget=structuredClone(state.configTargets[scope]);
    const callbackOrigins=resolveCallbackOrigins(config.callbackBindings??[],callbackResolution(context,config,automaticTarget));
    const target={config,environmentId:environment?.id||null,automaticTarget,callbackOrigins};
    // The verification holds that twin from its start to its end: it takes it here, and each attempt's lease passes to the
    // next, so nothing else, such as a health check, takes it while the verification records its start or an attempt, or
    // waits for the stage. A twin in use refuses the verification.
    const take=()=>takeTarget(context,config.targetUrl,target.environmentId,'verify journey code');
    // A run of the stage that just finished may still be releasing its twin; the verification takes it as that run lets go.
    const finishing=state.runs.filter(run=>run.scope===scope&&jobs.has(run.id)).map(run=>jobs.get(run.id)!.promise);
    let held:(()=>void)|null=null;
    try{held=take();}catch(error){if(!finishing.length)throw error;}
    const letGo=()=>{const release=held;held=null;release?.();};
    const entry:VerificationEntry={...verification.identity,scope,caseId:item.id,cancelled:false,done:false,run:null};
    verifications.set(key,entry);
    const promise=(async()=>{
      try{
        if(!held){await Promise.allSettled(finishing);held=take();}
        await verification.checkpoint();
        for(let attempt=1;attempt<=4&&!entry.cancelled&&!closed;attempt++){
          // A person's test save or draft may hold the stage as an attempt ends; the next attempt waits for it.
          while(busy.has(scope)&&!entry.cancelled&&!closed)await whenFree(scope);
          if(entry.cancelled||closed)break;
          const control=attempt===4;
          // start takes the twin before it first awaits, so nothing comes between letting go and taking it again.
          letGo();
          const {run}=await start(context,'run',{caseIds:[item.id],concurrency:1,...account},{manual:true,verification:{...verification.identity,attempt,control},target,keepLease:release=>{held=release;}});
          entry.run=run.id;
          const job=jobs.get(run.id);
          if(job&&(entry.cancelled||closed)){job.cancelled=true;job.cancel();}
          await job?.promise;
          entry.run=null;
          await verification.checkpoint().catch(()=>{/* Storage is full: its end is recorded below if it can be. */});
          const result=state.runs.find(value=>value.id===run.id)?.results?.find(value=>value.caseId===item.id);
          if(!control&&result?.status!=='passed')break;
        }
      }catch(error){if(!entry.cancelled&&!closed)entry.error=browserError(error);}
      finally{
        entry.run=null;
        await verification.checkpoint(entry.error).catch(()=>{/* Storage is full: the view derives it from the runs while they last. */});
        letGo();entry.done=true;resumePreparations();
      }
    })();
    verificationJobs.add(promise);promise.finally(()=>verificationJobs.delete(promise));
    return {specs:specView(scope)};
  }
  function cancelVerification(context:BrowserStageContext,caseId:unknown){
    const scope=scopeId(context),entry=verifications.get(generationKey(scope,String(caseId)));
    if(!entry||entry.done)throw Object.assign(new Error('No code is being verified for this test.'),{statusCode:404});
    entry.cancelled=true;
    const job=entry.run&&jobs.get(entry.run);if(job){job.cancelled=true;job.cancel();}
    return {specs:specView(scope)};
  }
  // Generates against the selected application URL, reserving its twin when Perpetual owns one. Only this request
  // starts it: never a view, a restart or a gate. The code remains a draft until verified and approved by a person.
  async function generateSpec(context:BrowserStageContext,input:{caseId?:unknown;credentials?:unknown;accountId?:unknown}){
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===input?.caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    if(item.needsReview)throw new Error('Review this test before generating its code.');
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is already being generated.');
    // The generator would hold the twin a verification's next attempt needs.
    if(verifying(scope))throw conflict('Code is being verified in this stage. Wait or stop it first.');
    const [snapshot]=validateBrowserCases([item],{draft:false});
    if(!snapshot.steps.length)throw new Error('Add journey steps before generating code.');
    if(!hasJourneyChecks(snapshot))throw new Error('Add at least one milestone check or final assertion before generating code.');
    assertExecutableJourneyChecks(snapshot);
    const feedback=journeyCode.generationFeedback(scope,item.id);
    const account=selectRunAccount(input);let credentials:RunCredentials|undefined;
    const config=normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
    const callbackOrigins=resolveCallbackOrigins(config.callbackBindings??[],callbackResolution(context,config,state.configTargets[scope]));
    const configuration=modelSettings.configuration();
    if(!configuration.modelConfigured||!isOpenRouterEndpoint(configuration.baseUrl))throw new Error('Add your OpenRouter API key in Settings first.');
    const environment=resolveEnvironment(config.targetUrl);
    if(environment&&(environment.status!=='ready'||(environment.stageId&&environment.stageId!==context.stageId)))throw conflict('Set the application URL to this stage’s ready twin first.');
    if(environment&&state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
    // An existing URL needs no twin. An owned environment keeps the same reservation as a run.
    const release=takeTarget(context,config.targetUrl,environment?.id,'generate journey code');
    const previous=generations.get(key),entry:Generation={scope,caseHash:caseHash(snapshot),status:'running',step:'preparing',cancelled:false,cancel(){entry.cancelled=true;}};
    generations.set(key,entry);
    try{
      if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');
      ({credentials}=await account(environment,twinAccount));
      if(closed||entry.cancelled)throw conflict('Code generation cancelled.');
      // Only an admitted new attempt replaces the previous terminal failure, before any worker starts.
      await journeyCode.clearGenerationFailure(scope,item.id);
    }catch(error){
      if(previous&&!previous.discarded&&!entry.discarded&&state.cases[scope]?.some(current=>current.id===item.id&&caseHash(current)===previous.caseHash))generations.set(key,previous);
      else generations.delete(key);
      release();throw error;
    }
    const origins=[new URL(config.targetUrl).origin,...(environment?applications(environment):[]).map(app=>originOf(app.url)!),...config.externalOrigins,...callbackOrigins];
    const promise=(async()=>{
      let workspace:Awaited<ReturnType<typeof privateWorkspace>>|null=null;
      let external:Awaited<ReturnType<typeof beginExternal>>=null,uncertain=false;
      // The generation stays running until the twin is released, so a verification started next can hold it.
      let failure:unknown=null,authoring:AuthoringRecord|null=null;
      try{
        workspace=await privateWorkspace(generationRoot);
        external=await beginExternal(context,config.targetUrl,environment,'generate',workspace.path);
        const reasoning=await modelCatalog.generationReasoning(configuration.model);
        // The seed signs in first with the runtime that runs journeys, on the stage's sign-in page when one is set.
        const job=generateJourneySpec({...generation,workspace:workspace.path,item:snapshot,targetUrl:config.targetUrl,allowedOrigins:[...new Set(origins)],timeoutSeconds:config.journeyTimeoutSeconds,credentials,...(config.signInUrl?{signInUrl:config.signInUrl}:{}),playwright,apiKey:configuration.apiKey,model:configuration.model,reasoning,feedback,onStep:(step:string)=>{if(!entry.cancelled)entry.step=step;}});
        entry.cancel=()=>{entry.cancelled=true;entry.step='cancelling';job.cancel();};
        if(entry.cancelled)job.cancel();
        const generated=await job.promise;
        authoring=generated.authoring;
        const {code,provenance}=generated;
        if(entry.cancelled)throw new Error(CANCELLED);
        entry.step='saving';
        // Generated code is a draft beside the approved code, which it never replaces by itself.
        await journeyCode.generatedDraft(scope,snapshot,code,provenance);
      }catch(error){
        authoring=(error as {authoring?:AuthoringRecord})?.authoring??authoring;
        uncertain=(error as WorkerError|undefined)?.cleanupIncomplete===true;
        if(!entry.cancelled||uncertain&&external)failure=uncertain&&external?new Error(externalCleanup):error;
        if(environment&&(error as WorkerError|undefined)?.cleanupIncomplete)await onEnvironmentUncertain(environment.id,browserError(error)).catch(()=>{});
      }finally{
        try{if(workspace&&(!uncertain||!external))await rm(workspace.path,{recursive:true,force:true});}
        catch(error){uncertain=true;failure??=error;}
        finally{try{await finishExternal(external,uncertain);}catch(error){failure??=error;}finally{release();}}
        // Project evidence before workspace removal; persist after owned cleanup releases the target.
        if(authoring){
          try{
            const record=restoreAuthoringRecord({...authoring,cleanup:uncertain?'incomplete':authoring.cleanup},hide([configuration.apiKey,...accountSecrets(credentials)]));
            let retained:AuthoringHistory;
            await persist(()=>{
              retained=retainAuthoring({...state.authoring,[scope]:{...state.authoring[scope],[item.id]:[record,...state.authoring[scope]?.[item.id]||[]]}},state.cases);
              return {...state,authoring:retained};
            },()=>{state.authoring=retained;});
          }catch(error){failure??=new Error(`The authoring diagnostics could not be saved: ${generationDiagnostic(error)}`);}
        }
        // A saved or cancelled generation leaves no live state. Only a failure for the same case is durable.
        if(!failure||entry.discarded)generations.delete(key);
        else{
          const rejected=(failure as {rejected?:unknown}).rejected;
          const secrets=[configuration.apiKey,credentials?.password],result:GenerationFailure={caseHash:caseHash(snapshot),error:generationDiagnostic(failure,800,secrets),...(typeof rejected==='string'?{rejected:generationDiagnostic(rejected,20000,secrets)}:{})};
          try{
            await journeyCode.generationFailed(scope,item.id,result);
            generations.delete(key);
          }catch(error){if(entry.discarded)generations.delete(key);else{Object.assign(entry,{status:'failed',error:`${result.error} The generation failure could not be saved: ${browserError(error)}`,...(result.rejected?{rejected:result.rejected}:{})});delete entry.step;}}
        }
      }
    })();
    generationJobs.add(promise);promise.finally(()=>generationJobs.delete(promise));
    return {specs:specView(scope)};
  }
  function cancelGeneration(context:BrowserStageContext,caseId:unknown){
    const scope=scopeId(context),entry=generations.get(generationKey(scope,String(caseId)));
    if(entry?.status!=='running')throw Object.assign(new Error('No code is being generated for this test.'),{statusCode:404});
    entry.cancel();
    return {specs:specView(scope)};
  }
  function find(context:BrowserStageContext,id:unknown):BrowserRun{const run=state.runs.find(r=>r.id===id&&r.scope===scopeId(context));if(!run)throw Object.assign(new Error('Browser run not found in this stage.'),{statusCode:404});return run;}
  // A test run executes an immutable case snapshot, so case writes may overlap it; discovery may not.
  // A verification holds its stage between attempts too, except for its own attempts and the writes a run allows.
  function requireIdle(context:BrowserStageContext,{duringRun=false,verification=false}={}){if(closed)throw conflict('The controller is shutting down.');usage.assertAvailable(context);if(modelSaving)throw stageHeld('Model settings are being saved. Please wait.');const scope=scopeId(context);if(busy.has(scope)||state.runs.some(r=>r.scope===scope&&active(r)&&!(duringRun&&r.mode==='run'))||!duringRun&&!verification&&verifying(scope))throw stageHeld('A browser operation is already in progress for this stage.');}
  async function viewModel():Promise<ModelSettingsReply>{return {capabilities:{...modelSettings.view(),...await runtime!.capabilities()}};}
  // Discovery and code generation need the browser agent's runtime and model; runs need only Playwright's Chromium.
  async function capabilities():Promise<PublicCapabilities>{
    const [agent,coded]=await Promise.all([runtime!.capabilities(),playwright.capabilities().catch(()=>({browserInstalled:false}))]);
    return {...modelSettings.view(),...agent,playwright:{browserInstalled:coded.browserInstalled===true}};
  }
  async function listModels(){const current=modelSettings.configuration();return modelCatalog.view(isOpenRouterEndpoint(current.baseUrl)&&current.modelConfigured?current.model:undefined,modelSettings.escalationModel()??undefined);}
  async function updateModel(save:()=>Promise<unknown>){
    if(closed)throw conflict('The controller is shutting down.');
    // A verification's next attempt refuses to start while the model is saved, so it holds the model between attempts too.
    if(modelSaving||busy.size||jobs.size||generating()||verifying()||state.runs.some(active)||Object.values(state.preparations).some(preparation=>['preparing','discovering'].includes(preparation.status)))throw conflict('Wait for browser operations to finish before changing the model.');
    modelSaving=true;
    try{await save();return await viewModel();}finally{modelSaving=false;resumePreparations();}
  }
  async function saveModelSettings(input:unknown){
    if(!isRecord(input)||Object.keys(input).some(key=>!['model','apiKey','escalationModel'].includes(key)))throw new Error('Provide an OpenRouter model and API key.');
    if(typeof input.model!=='string'||!input.model.trim())throw new Error('Choose an OpenRouter model.');
    return updateModel(async()=>{
      const {models}=await listModels();
      if(!models.some(model=>model.id===input.model))throw new Error('Choose an available OpenRouter model from the list.');
      if(input.escalationModel!==undefined&&!models.some(model=>model.id===input.escalationModel))throw new Error('Choose an available OpenRouter escalation model from the list.');
      await modelSettings.saveOpenRouter(input);
    });
  }
  function withInput<T>(context:BrowserStageContext,work:(operation:{scope:string;configuration:BrowserModelConfiguration;signal:AbortSignal;assertCurrent:()=>void})=>Promise<T>,{signal,isCurrent=()=>true}:InputOptions={}):Promise<T>{
    requireIdle(context,{duringRun:true});const scope=scopeId(context),controller=new AbortController();
    const operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const assertCurrent=()=>{
      if(closed||operationSignal.aborted)throw conflict('Operation cancelled.');
      if(!isCurrent())throw conflict('The active source changed. Reopen this stage.');
    };
    const release=usage.acquire(context,{operation:'test input'});
    busy.add(scope);
    const promise=Promise.resolve().then(async()=>{
      assertCurrent();
      const configuration=modelSettings.configuration();
      if(!configuration.modelConfigured||!isOpenRouterEndpoint(configuration.baseUrl))throw new Error('Add your OpenRouter API key in Settings first.');
      return work({scope,configuration,signal:operationSignal,assertCurrent});
    }).finally(()=>{free(scope);inputJobs.delete(controller);release();});
    inputJobs.set(controller,promise);
    return promise;
  }
  function draft(context:BrowserStageContext,description:unknown,options?:InputOptions){
    const normalized=validateTestDescription(description);
    return withInput(context,async({scope,configuration,signal,assertCurrent})=>{
      if((state.cases[scope]||[]).length>=60)throw new Error('Delete a test before adding another. This stage supports 60 tests.');
      const sourceContext=await browserDiscoveryContext({repoPath:context.scan.repo.path,scope:normalized.slice(0,4000),requirements:normalized});
      const reasoning=await modelCatalog.draftReasoning(configuration.model);
      assertCurrent();
      const item=await draftBrowserCase({configuration,description:normalized,sourceContext,signal,reasoning});
      assertCurrent();
      const previous=state.cases[scope];
      state.cases[scope]=[...(previous||[]),item];
      try{await persist();}catch(error){state.cases[scope]=previous;throw error;}
      return {case:structuredClone(item),cases:structuredClone(state.cases[scope])};
    },options);
  }
  function transcribe(context:BrowserStageContext,input:{audio?:unknown;format?:unknown},options?:InputOptions){
    return withInput(context,async({configuration,signal,assertCurrent})=>{
      const result=await transcribeBrowserAudio({configuration,audio:input.audio,format:input.format,signal});
      assertCurrent();return result;
    },options);
  }
  const report=(run:BrowserRun):RunProgressReply=>({run:publicRun(run),results:run.results||[],progress:run.progress||{cases:[]},...(run.discovery?{discovery:run.discovery}:{})});
  function acceptFrame(run:BrowserRun,event:WorkerEvent,progress:CaseProgress){
    if(typeof event.data!=='string'||event.data.length>2800000||!(/^[a-zA-Z0-9+/]+={0,2}$/.test(event.data)))throw new Error('Browser runtime returned an invalid frame.');
    const bytes=Buffer.from(event.data,'base64');if(bytes.length>2*1024*1024||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)throw new Error('Browser runtime returned an invalid JPEG frame.');
    // The worker's capture time is kept apart from the controller's receipt time.
    const captured=event.timestamp;
    if(captured!==undefined&&(typeof captured!=='number'||!Number.isSafeInteger(captured)||captured<Date.parse(run.createdAt)-60000||captured>Date.now()+60000))throw new Error('Browser runtime returned an invalid frame timestamp.');
    let stored=frames.get(run.id);if(!stored){stored={latest:null,cases:new Map()};frames.set(run.id,stored);}
    stored.latest=bytes;run.frameUpdatedAt=now();if(captured!==undefined)run.frameCapturedAt=new Date(captured).toISOString();
    stored.cases.set(progress.id,bytes);progress.frameUpdatedAt=run.frameUpdatedAt;if(captured!==undefined)progress.frameCapturedAt=run.frameCapturedAt;
    for(const id of [...frames.keys()].slice(0,-5))if(!jobs.has(id))frames.delete(id);
  }
  async function startWork(context:BrowserStageContext,mode:'run'|'discover',input:StartInput={},options:StartOptions={}){
    // Run-only account values: never persisted; discovery may use them to see authenticated pages.
    // Without entered values, the target twin's test account (accountId, else its first) signs in; accountId null uses none.
    const account=selectRunAccount(input);
    // Checked for a run, the only mode that uses it: set exactly when the mode is run.
    const concurrency=mode==='run'?runConcurrency(input.concurrency??2):undefined;
    requireIdle(context,{verification:Boolean(options.verification)});const scope=scopeId(context);busy.add(scope);
    let release:(()=>void)|undefined,handedOff=false,external:Awaited<ReturnType<typeof beginExternal>>=null;
    let replaceIds:string[]=[];
    try{
      if(mode==='discover'&&input.replaceCaseIds!==undefined){
        const current=state.cases[scope]||[];
        if(!Array.isArray(input.replaceCaseIds)||input.replaceCaseIds.length>60||new Set(input.replaceCaseIds).size!==input.replaceCaseIds.length||input.replaceCaseIds.some(id=>!current.some(item=>item.id===id)))throw new Error('Choose existing tests to replace.');
        if(!Array.isArray(input.baseCases)||!isDeepStrictEqual(validateBrowserCases(input.baseCases,{draft:true}),validateBrowserCases(current,{draft:true})))throw conflict('Tests changed. Reopen Generate and try again.');
        replaceIds=input.replaceCaseIds;
      }
      const config=options.target?.config??normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
      const callbackOrigins=resolveCallbackOrigins(config.callbackBindings??[],callbackResolution(context,config,options.target?options.target.automaticTarget:state.configTargets[scope]));
      if(options.target&&!isDeepStrictEqual(callbackOrigins,options.target.callbackOrigins))throw conflict(TWIN_CHANGED);
      const environment=resolveEnvironment(config.targetUrl);
      if(options.target&&((environment?.id??null)!==options.target.environmentId||environment&&environment.status!=='ready'))throw conflict(TWIN_CHANGED);
      if(environment&&environment.status!=='ready')throw conflict('The selected application environment is not ready. Choose an available application URL.');
      if(environment&&state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
      try{release=takeTarget(context,config.targetUrl,environment?.id,`browser ${mode}`);}
      catch(error){
        // A terminal row may already be visible while its final save releases the target. Join only this stage's
        // finishing work, then take the reservation again; running work and unconfirmed cleanup still refuse it.
        const finishing=state.runs.filter(run=>run.scope===scope&&!active(run)&&jobs.has(run.id)).map(run=>jobs.get(run.id)!.promise);
        if(!finishing.length)throw error;
        await Promise.allSettled(finishing);
        release=takeTarget(context,config.targetUrl,environment?.id,`browser ${mode}`);
      }
      // A journey runs its Playwright code, which needs no model; discovery needs the browser agent.
      if(mode==='run'){if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');}
      else{const capabilities=await runtime!.capabilities();if(!capabilities.runtimeInstalled)throw new Error('Install the local Browser Use runtime first.');if(capabilities.browserInstalled===false)throw new Error('Install Chromium for the local browser runtime.');if(!capabilities.modelConfigured)throw new Error(capabilities.modelError||'Configure a model API key to use the browser agent.');}
      const {credentials,authEndpoints:accountEndpoints}=await account(environment,twinAccount);
      // An entered account authorizes using its credentials, not arbitrary POSTs. Discover only
      // with configured endpoints or the selected twin account's own reviewed sign-in endpoints.
      const discoveryEndpoints=mode==='discover'&&credentials?authEndpoints([...new Set([...config.authEndpoints,...accountEndpoints])],config.targetUrl):undefined;
      if(discoveryEndpoints&&!discoveryEndpoints.length)throw new Error('Add a sign-in API endpoint in Test settings before exploring with a test account.');
      let cases:BrowserCase[]=[];
      if(mode==='run'){
        const available=state.cases[scope]||[],ids=input.caseIds??available.filter(c=>c.selected&&!c.needsReview).map(c=>c.id);
        if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length)throw new Error('Choose 1–30 distinct reviewed cases.');
        // A verification attempt runs its one reviewed case, selected or not.
        cases=ids.map(id=>{const item=available.find(c=>c.id===id);if(!item||item.needsReview||!item.selected&&!options.verification)throw new Error('Review and select each case before running.');return item;});
        cases=validateBrowserCases(cases,{draft:false});
      }
      // What each journey runs, kept in memory for this run; a journey without code is settled without a browser.
      const codes=Object.fromEntries(cases.map((item):[string,RunnableCode]=>[item.id,journeyCode.runnable(scope,item,options)]));
      const coded=cases.filter(item=>codes[item.id].code);
      const sourceContext=mode==='discover'?await browserDiscoveryContext({repoPath:context.scan.repo.path,scope:config.scope,requirements:config.requirements}):'';
      if(closed)throw conflict('The controller is shutting down.');
      if(options.isCurrent&&!options.isCurrent())throw conflict('The active source changed. Open this source and discover cases to continue.');
      external=await beginExternal(context,config.targetUrl,environment,mode);
      const progressCases:CaseProgress[]=mode==='discover'?[{id:'discovery',caseId:'discovery',name:'Explore application',status:'pending',actions:[],actionCount:0}]:cases.map(c=>({id:c.id,caseId:c.id,name:c.name,status:'queued',actions:[],actionCount:0,steps:c.steps.map(({id,title})=>({id,title,status:'pending'}))}));
      const run:BrowserRun={id:randomUUID(),scope,stageId:context.stageId,mode,status:'queued',createdAt:now(),targetUrl:config.targetUrl,sourceRevision:context.scan.repo.sha||null,caseIds:cases.map(c=>c.id),approvedCases:structuredClone(cases),progress:{revision:0,cases:progressCases},...(concurrency!==undefined?{engine:'playwright',concurrency,...journeyConcurrency({cases:coded,concurrency,account:!!credentials}),specHashes:Object.fromEntries(coded.map((item):[string,string]=>[item.id,codes[item.id].hash!]))}:{})};
      if(callbackOrigins.length){run.callbackOrigins=[...callbackOrigins];run.callbackPolicy=callbackPolicyHash(scope,config.callbackBindings);}
      if(environment)run.environmentId=environment.id;
      if(options.verification)run.verification=structuredClone(options.verification);
      const preparation=mode==='discover'?(options.preparation||state.preparations[scope]):null,before=preparation&&{...preparation};
      if(preparation){Object.assign(preparation,{status:'discovering',targetUrl:config.targetUrl,runId:run.id});delete preparation.error;delete preparation.completedAt;}
      const admittedRuns=()=>[run,...state.runs].filter(kept);
      // A discovery that could not be admitted leaves the stage's preparation as it was.
      try{await persist(()=>({...state,runs:admittedRuns()}),()=>{state.runs=admittedRuns();});}
      catch(error){if(preparation){delete preparation.runId;delete preparation.targetUrl;Object.assign(preparation,before);}throw error;}
      if(closed){run.status='cancelled';run.completedAt=now();await persist();throw conflict('The controller is shutting down.');}
      const execution=async()=>{
        const diagnostic=(error:unknown,limit=800)=>generationDiagnostic(error,limit,accountSecrets(credentials));
        // Set by the worker's discovery event.
        let discovery=null as Discovery|null,omittedCount=0,progressPersistence:Promise<unknown>=Promise.resolve(),progressError:unknown,progressQueued=false;
        // Registered before execution starts.
        const entry=jobs.get(run.id)!;
        // A journey's start, its milestones and its end survive a controller interruption, so a restart judges what it
        // began. A save not yet started takes every later change with it.
        const saveProgress=()=>{
          if(progressQueued||progressError)return;progressQueued=true;
          progressPersistence=progressPersistence.then(()=>{progressQueued=false;return persist();}).catch(error=>{progressError||=error;entry.cancel();});
        };
        const assertCurrent=()=>{if(options.isCurrent&&!options.isCurrent())throw new Error('The active source changed. Open this source and discover cases to continue.');};
        function progressEvent(event:WorkerEvent,caseId:string){
          if(event.caseId!==undefined&&event.caseId!==caseId)throw new Error('Browser progress referenced another journey.');
          const progress=run.progress.cases.find(item=>item.id===caseId);
          if(!progress)throw new Error('Browser progress referenced an unknown case.');
          // A skipped journey keeps its recording; an invalid one is ignored, never a journey failure.
          if(event.type==='video'){
            if(mode==='run'&&Array.isArray(event.files)&&event.files.length<=20&&event.files.every(name=>typeof name==='string'&&videoName.test(name))){progress.videos=[...new Set(event.files)];touch(run);}
            return;
          }
          if(['skipping','cancelling','skipped','cancelled'].includes(progress.status))return;
          if(event.type==='blocked-request'){
            const remove=hide(accountSecrets(credentials));
            const request=blockedRequest(event.method,event.url,value=>safeText(remove(redact(value,{decodeUri:true})),512));
            if(request&&!(run.blockedRequests??[]).some(item=>item.method===request.method&&item.url===request.url)){
              if((run.blockedRequests??[]).length<10)(run.blockedRequests??=[]).push(request);touch(run);
            }
            return;
          }
          if(event.type==='frame'){acceptFrame(run,event,progress);touch(run);return;}
          if(event.type==='case'){
            if(mode==='discover')progress.status='running';
            if(Array.isArray(event.actions)){
              // An action that is not an object is an invalid event, which stops the run; an action without a valid type is a browser action.
              progress.actions=event.actions.slice(-150).map((a:unknown):ActionProgress=>{if(!isRecord(a))throw new Error('Browser runtime returned an invalid event.');return {type:typeof a.type==='string'&&/^[a-z][a-z0-9_-]{0,40}$/i.test(a.type)?a.type:'browser',status:includes(['pending','running','passed','failed','cancelled'],a.status)?a.status:'running',...(a.status==='failed'&&typeof a.errorCode==='string'&&actionErrorCodes.has(a.errorCode)?{errorCode:a.errorCode}:{})};});
              // A worker that sends only its latest actions names how many there were in all.
              progress.actionCount=typeof event.actionCount==='number'&&Number.isSafeInteger(event.actionCount)&&event.actionCount>=event.actions.length?event.actionCount:event.actions.length;
              const last=progress.actions.at(-1);if(last)progress.lastAction={type:last.type,status:last.status};else delete progress.lastAction;
            }
          }else if(event.type==='journey-step'){acceptMilestone(progress,event,run.approvedCases.find(item=>item.id===caseId));saveProgress();}
          else return;
          touch(run);
        }
        const actionFeedback=new Map<string,string>();
        try{
          // Runs may reach reviewed external origins (such as Stripe test checkout); discovery stays on
          // the target environment's apps and receives auth endpoints only with a supplied test account.
          // Validate worker input inside the terminal handler so refusal also settles the run and its lease.
          const origins=[new URL(config.targetUrl).origin,...applications(environment).map(app=>originOf(app.url)!)];
          const workerInput={mode,...(config.readOnlyRequests?.length?{readOnlyRequests:config.readOnlyRequests}:{}),targetUrl:config.targetUrl,allowedOrigins:[...new Set(mode==='run'?[...origins,...config.externalOrigins,...callbackOrigins]:origins)],timeoutSeconds:config.journeyTimeoutSeconds,...(credentials?{credentials}:{}),
            ...(mode==='discover'?{scope:config.scope,requirements:config.requirements,sourceContext,maxSteps:config.maxSteps,...(discoveryEndpoints?{authEndpoints:discoveryEndpoints}:{})}:{})};
          run.status='running';run.startedAt=now();await persist();
          if(closed||entry?.cancelled)throw new Error('Browser operation cancelled.');
          assertCurrent();
          if(mode==='run'){
            // One supplied account shares application state even across fresh profiles.
            const scheduledCases=credentials?cases.map((item):BrowserCase=>({...item,isolation:'shared'})):cases;
            // Without its folder the run is only unrecorded.
            const videoDir=await mkdir(join(videoRoot,run.id),{recursive:true,mode:0o700}).then(()=>join(videoRoot,run.id),()=>null);
            // A journey without code, or whose code signs in without an account, is settled before any browser
            // starts, since nothing could judge it; the other journeys still run. One a person skipped before this
            // stays skipped, as its skip reported.
            for(const item of cases){
              const {code,missing}=codes[item.id],progress=run.progress.cases.find(value=>value.id===item.id)!;
              const result:JourneyResult|null=entry.skips.has(item.id)?{caseId:item.id,status:'skipped',assertions:[]}:!code?journeyResult(item,{caseId:item.id,stopCause:'action',error:missing,assertions:[]},progress.steps)
                :!credentials&&signsIn(code)?journeyResult(item,{caseId:item.id,stopCause:'none',assertions:[],blockers:[{kind:'account',evidence:'The code signs in, and no test account is available.'}]},progress.steps):null;
              if(!result)continue;
              if(result.status==='skipped')settleSteps(progress,'skipped');
              Object.assign(progress,{status:result.status,completedAt:now()});
              run.results=[...(run.results||[]),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
              touch(run);
            }
            if(run.results?.length)await persist();
            const scheduler=createJourneyScheduler<BrowserCase,JourneyResult>({cases:scheduledCases.filter(item=>!run.results?.some(result=>result.caseId===item.id)),concurrency,
              onState(caseId,status,item){
                const progress=run.progress.cases.find(item=>item.id===caseId)!;progress.status=status;
                // A supplied account is scheduled as shared data; report the account as the wait.
                if(status==='queued')progress.queueReason=credentials&&item.queueReason==='shared-data'?'account':item.queueReason||'browser';else delete progress.queueReason;
                if(status==='running')progress.startedAt=now();
                if(!['queued','running','skipping','cancelling'].includes(status)){
                  progress.completedAt=now();
                  // A worker error is the journey's exception; skipped and cancelled journeys have no verdict.
                  const result=item.result||(status==='failed'?journeyResult(item.item,{caseId,stopCause:'exception',error:diagnostic(item.error)},progress.steps):{caseId,status:status as JourneyResult['status'],assertions:[]});
                  run.results=[...(run.results||[]).filter(previous=>previous.caseId!==caseId),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
                  // An unreported milestone is unconfirmed, never a blocked prerequisite.
                  settleSteps(progress,status);
                }
                if(status!=='queued')saveProgress();
                touch(run);
              },
              launch(item){
                let facts:unknown=null;
                assertCurrent();
                const steps=()=>run.progress.cases.find(progress=>progress.id===item.id)!.steps;
                const onEvent=(event:WorkerEvent)=>{
                  if(event.type==='result'){
                    if(facts)throw new Error('Browser runtime returned duplicate results.');
                    if(isRecord(event.result)&&event.result.caseId===item.id&&event.result.stopCause==='action'&&typeof event.result.actionFeedback==='string'&&event.result.actionFeedback.length<=2000)
                      actionFeedback.set(item.id,generationDiagnostic(event.result.actionFeedback,2000,accountSecrets(credentials)));
                    // Scrub only diagnostics before journeyResult bounds them; check identities stay unchanged.
                    facts=isRecord(event.result)&&typeof event.result.error==='string'?{...event.result,error:diagnostic(event.result.error,4000)}:event.result;
                    if(isRecord(facts)&&facts.controlBlocks!==undefined)facts={...facts,controlBlocks:controlBlocks(facts.controlBlocks,accountSecrets(credentials))??facts.controlBlocks};
                    if(isRecord(facts)&&facts.controlFailedRead!==undefined)facts={...facts,controlFailedRead:controlFailedRead(facts.controlFailedRead,accountSecrets(credentials))??facts.controlFailedRead};
                  }else if(event.type==='discovery')throw new Error('Browser runtime returned unexpected discovery.');
                  else progressEvent(event,item.id);
                };
                // Service availability stays on the environment. It does not establish which dependency
                // this journey used or why an action failed; only the journey's own evidence decides it.
                // Journeys without code were settled before scheduling.
                const {code,hash,checkVersion}=codes[item.id] as {code:string;hash:string;checkVersion:number};
                // A control run blocks every state-changing request, so a reviewed check of a journey that keeps something fails.
                // The account signs in on the sign-in page when the application URL shows no sign-in form.
                const job=playwright.start({...workerInput,case:item,spec:{code,hash},checkVersion,...(config.signInUrl?{signInUrl:config.signInUrl}:{}),...(videoDir?{videoDir}:{}),...(run.verification?.control?{blockWrites:true}:{})},onEvent);
                return {cancel:()=>job.cancel(),promise:job.promise.then(()=>{
                  assertCurrent();if(!facts)throw new Error('Browser runtime did not return results.');
                  return journeyResult(item,facts,steps());
                },(error:WorkerError|undefined)=>{
                  // The kill timer is the journey's deadline too; facts the worker reported before it still count.
                  if(!error?.timedOut||error.cleanupIncomplete)throw error;
                  assertCurrent();
                  return journeyResult(item,facts||{caseId:item.id,stopCause:'deadline'},steps());
                })};
              },
            });
            entry.scheduler=scheduler;entry.cancel=()=>scheduler.cancel();
            for(const caseId of entry.skips)scheduler.skip(caseId);
            if(entry.cancelled)scheduler.cancel();
            // Every journey's result row is recorded as it settles.
            const finished=await scheduler.promise;
            await progressPersistence;
            if(progressError)throw progressError;
            const uncertain=finished.find(item=>(item.error as WorkerError|null)?.cleanupIncomplete);
            if(uncertain)throw uncertain.error;
            const errors=finished.filter(item=>item.error&&item.status==='failed');
            if(errors.length)run.error=diagnostic(errors[0].error);
            // Every journey has a result row by now.
            run.status=runStatus(run.results!,run.caseIds);
          }else{
            const job=runtime!.start(workerInput,event=>{
              if(event.type==='discovery'){
                if(discovery)throw new Error('Browser runtime returned unexpected discovery.');
                // A journey the controller cannot accept is named in the summary; the valid ones are kept.
                const {cases:drafts,omitted}=discoveredBrowserCases(event.cases,sourceContext);
                const note=safeText(omitted.map(item=>`Omitted “${item.name}”: ${item.reason}`).join('\n'),2000);
                const blockedNote=run.blockedRequests?.length?`Blocked ${run.blockedRequests.slice(0,3).map(item=>`${item.method} ${item.url}`).join('; ')}. Review read-only POST requests in Test settings.`:'';
                const suffix=[note,blockedNote].filter(Boolean).join('\n');
                discovery={cases:drafts,summary:[safeText(event.summary,4000-(suffix?1+suffix.length:0)),suffix].filter(Boolean).join('\n'),authenticated:!!credentials&&event.authenticated===true};omittedCount=omitted.length;
              }else if(event.type==='result')throw new Error('Browser runtime returned unexpected results.');
              else if(event.type==='sign-in-page'){
                // Where the account signed in becomes the stage's sign-in page while it has none, so a person's value
                // is never replaced; the run's end persists it.
                const page=credentials?discoveredSignInPage(event.url,config.targetUrl):null,stored=state.configs[scope];
                if(page&&stored?.targetUrl===config.targetUrl&&!stored.signInUrl)state.configs[scope]={...stored,signInUrl:page};
              }
              else progressEvent(event,'discovery');
            });
            entry.cancel=()=>job.cancel();if(entry.cancelled)job.cancel();
            await job.promise;
            if(entry.cancelled)throw new Error('Browser operation cancelled.');
            assertCurrent();
            if(!discovery)throw new Error('Browser agent did not return business cases.');
            const analysis:Analysis={...discovery,createdAt:now(),sourceRevision:run.sourceRevision};
            if(!discovery.cases.length&&(replaceIds.length||omittedCount)){
              // The run fails and every test is retained, but the agent's summary and omissions are kept.
              const failed={...analysis,error:'No acceptable journeys were discovered. Existing tests were retained.'};
              run.discovery=discovery;
              await persist(()=>({...state,analyses:{...state.analyses,[scope]:failed}}),()=>{state.analyses[scope]=failed;});
              throw new Error(failed.error);
            }
            const current=state.cases[scope]||[],retained=current.filter(item=>!replaceIds.includes(item.id)),known=new Set(retained.map(item=>item.id));
            const nextCases=[...retained,...discovery.cases.filter(item=>!known.has(item.id))].slice(0,60);
            let code:JourneyCodeState;
            await persist(()=>{
              code=replaceJourneyCases(codeState(scope),nextCases);
              return {...state,cases:{...state.cases,[scope]:nextCases},specs:{...state.specs,[scope]:code.specs},authoring:{...state.authoring,[scope]:code.authoring||{}},generationFailures:{...state.generationFailures,[scope]:code.generationFailures},analyses:{...state.analyses,[scope]:analysis}};
            },()=>{state.specs[scope]=code.specs;state.generationFailures[scope]=code.generationFailures;state.authoring[scope]=code.authoring||{};state.cases[scope]=nextCases;state.analyses[scope]=analysis;});
            discardObsoleteGenerations(scope,nextCases);
            run.discovery=discovery;run.status='completed';run.progress.cases[0].status='completed';touch(run);
          }
        }catch(error){
          run.status=entry?.cancelled?'cancelled':'failed';run.error=diagnostic(error);
          if(mode==='discover'&&run.blockedRequests?.length)run.error=safeText(`${run.error} Blocked ${run.blockedRequests.slice(0,3).map(item=>`${item.method} ${item.url}`).join('; ')}. Review read-only POST requests in Test settings.`,4000);
          for(const item of run.progress.cases)if(['pending','queued','running','skipping','cancelling'].includes(item.status)){item.status=run.status;settleSteps(item,run.status);}
          touch(run);
          if((error as WorkerError|undefined)?.cleanupIncomplete===true&&external)external.entry.cleanupIncomplete=true;
          if((error as WorkerError|undefined)?.cleanupIncomplete===true&&run.environmentId){
            run.status='failed';run.environmentUseUncertain=true;
            try{await persist();}finally{await onEnvironmentUncertain(run.environmentId,run.error);}
          }
        }finally{
          run.completedAt=now();
          // Retain model feedback while this run's account is still available. Historical UI evidence
          // stays as recorded; its raw errors never substitute for these private, bounded summaries.
          if(mode==='run')run.codeFeedback=Object.fromEntries(cases.flatMap(item=>{
            const result=run.results?.find(result=>result.caseId===item.id),error=result?.error||run.error;
            return error&&result&&['failed','needs_review','blocked'].includes(result.status)?[[item.id,generationDiagnostic([generationDiagnostic(error,1800,accountSecrets(credentials)),actionFeedback.get(item.id)].filter(Boolean).join('\n'),4000,accountSecrets(credentials))]]:[];
          }));
          if(preparation?.runId===run.id){
            const empty=run.status==='completed'&&!(state.cases[scope]||[]).length;
            Object.assign(preparation,{status:empty?'needs_setup':run.status==='completed'?'completed':'failed',completedAt:run.completedAt,...(empty?{error:'No integration cases were discovered. Set a scope or add a case.'}:run.error?{error:run.error}:{})});
          }
          try{await pruneVideos();}catch{}
          try{await persist();await finishExternal(external,external?.entry.cleanupIncomplete);}finally{jobs.delete(run.id);if(options.keepLease)options.keepLease(release!);else release!();resumePreparations();}
        }
      };
      const entry:RunJob={cancelled:false,cancel:()=>{},promise:null,skips:new Set()};jobs.set(run.id,entry);entry.promise=Promise.resolve().then(execution);entry.promise.catch(()=>{});
      handedOff=true;
      return {run:publicRun(run)};
    }finally{free(scope);if(!handedOff)try{await finishExternal(external);}finally{release?.();}}
  }
  function start(...args:Parameters<typeof startWork>){
    // startWork runs synchronously to its first await, reserving the target
    // before another manager can admit a mutation of the same environment.
    if(closed)return Promise.reject(conflict('The controller is shutting down.'));
    const promise=startWork(...args);admissions.add(promise);
    promise.finally(()=>admissions.delete(promise)).catch(()=>{});return promise;
  }
  // The target twin's test accounts for the account choice, without passwords.
  function targetAccounts(url:string|undefined){const environment=url?resolveEnvironment(url):null;return environment?.status==='ready'?(environment.accounts||[]).map(({id,label,username})=>({id,label,username})):[];}
  function callbackResolution(context:BrowserStageContext,config:BrowserConfig,target:AutomaticCallbackTarget|undefined):CallbackResolutionInput{
    return {context,targetUrl:config.targetUrl,target,environment:config.targetUrl?resolveEnvironment(config.targetUrl):null};
  }
  function callbackReview(context:BrowserStageContext){
    const config={...defaults,...state.configs[scopeId(context)]},input=callbackResolution(context,config,state.configTargets[scopeId(context)]);
    const application=callbackApplication(input);
    try{resolveCallbackOrigins(config.callbackBindings??[],input);return {application};}catch{return {application,error:'Choose a ready managed application for its callback bindings.'};}
  }
  function publicConfig(scope:string):BrowserConfig{
    const config=structuredClone({...defaults,...state.configs[scope]});
    const environment=config.targetUrl?resolveEnvironment(config.targetUrl):null;
    if(!environment||environment.sandboxId!==environment.id)return config;
    try{
      const target=new URL(config.targetUrl);
      if(target.protocol!=='http:'||target.hostname!=='host.docker.internal')return config;
      const app=applications(environment).find(app=>externalOrigin(app.url)===externalOrigin(target.href));
      if(!app)return config;
      // The inspector opens this URL in an ordinary host browser. Preserve its route and the stored config.
      const origin=externalOrigin(app.url);
      config.targetUrl=`${origin}${signInPath(target.href)}`;
      if(config.readOnlyRequests)config.readOnlyRequests=moveReads(config.readOnlyRequests,config.targetUrl);
      if(config.signInUrl&&originOf(config.signInUrl)===target.origin)config.signInUrl=`${origin}${signInPath(config.signInUrl)}`;
    }catch{/* An invalid saved URL remains available for the person to edit. */}
    return config;
  }
  function summary(context:{key:string;stageId:string}):BrowserSummaryReply{
    const scope=scopeId(context),cases=state.cases[scope]||[],runs=state.runs.filter(r=>r.scope===scope).slice(0,30);
    // A control run never counts as a journey's current status.
    const latest=new Set(cases.map(item=>runs.find(run=>run.mode==='run'&&!run.verification?.control&&run.caseIds.includes(item.id))?.id).filter(Boolean));
    return {cases:structuredClone(cases),specs:specView(scope),runs:runs.map(run=>summaryRun(run,active(run)||latest.has(run.id))),preparation:structuredClone(state.preparations[scope]||null)};
  }
  /**
   * The stage's config for a ready twin: an explicit target stays, and an automatic one becomes the twin's application
   * URL, with the sign-in page moved to its origin. A new twin runs the same application, so when its URL moves to another
   * origin, as a changed port does, the sign-in page moves with it; the stage's cases are reused without discovery, so
   * nothing else would record it again. null when the twin has no single application URL, which clears an automatic target.
   */
  const moveReads=(requests:readonly ReadOnlyRequest[],targetUrl:string)=>requests.map(rule=>({...rule,url:`${new URL(targetUrl).origin}${new URL(rule.url).pathname}`}));
  function retarget(scope:string,context:BrowserStageContext,environment:TargetEnvironment){
    const config=normalizedConfig(state.configs[scope]||defaults,context);
    const previousTarget=state.configTargets[scope];
    if(config.targetUrl&&previousTarget?.url!==config.targetUrl)return config;
    // While a twin has no single application URL, the automatic target is unset, and the sign-in page's path, query and
    // hash wait beside it for the next twin, so a person's value is not dropped silently.
    const path=config.signInUrl?signInPath(config.signInUrl):previousTarget?.signInPath;
    const url=applicationUrl(environment,context.scan);
    const previousApp=previousTarget?.applicationId;
    const suspended=previousTarget?.suspendedReads??(config.readOnlyRequests?.length?{...(previousApp?{applicationId:previousApp}:{}),requests:config.readOnlyRequests}:undefined);
    if(!url){
      if(previousTarget){state.configs[scope]={...config,targetUrl:'',signInUrl:'',readOnlyRequests:undefined};state.configTargets[scope]={environmentId:environment.id,url:'',...(path?{signInPath:path}:{}),...(suspended?{suspendedReads:suspended}:{})};}
      return null;
    }
    config.targetUrl=validateBrowserTarget(url,context);
    if(path&&(!config.signInUrl||originOf(config.signInUrl)!==originOf(config.targetUrl)))config.signInUrl=movedSignInPage(path,config.targetUrl);
    const application=applications(environment).find(app=>originOf(app.url)===originOf(config.targetUrl));
    const applicationId=typeof application?.id==='string'?application.id:undefined;
    const restored=suspended?.applicationId&&suspended.applicationId===applicationId;
    if(suspended)config.readOnlyRequests=restored?moveReads(suspended.requests,config.targetUrl):undefined;
    state.configs[scope]=config;state.configTargets[scope]={environmentId:environment.id,url:config.targetUrl,...(applicationId?{applicationId}:{}),...(suspended&&!restored?{suspendedReads:suspended}:{})};
    return config;
  }
  async function prepareEnvironment(context:BrowserStageContext,environment:TargetEnvironment,{isCurrent=()=>true}:{isCurrent?:()=>boolean}={}){
    const scope=scopeId(context),attempt=`${scope}:${environment.id}`;
    if(environment.status!=='ready'||environment.stageId!==context.stageId
      ||(environment.pipelineKey&&environment.pipelineKey!==context.key)||(environment.repoPath&&environment.repoPath!==context.scan.repo.path)
      ||state.preparationAttempts[attempt])return summary(context);
    const release=usage.acquire(context,{operation:'prepare integration cases'});
    // A busy stage defers the preparation, with its one attempt unspent, until the stage is idle; the automatic target
    // moves to the new twin at once, which only writes config, so nothing later goes on using a superseded twin. A
    // verification runs every attempt on the twin it started on, so the target moves only as the deferred preparation
    // runs once it ends. A restart drops a deferred preparation, as it never starts discovery.
    if(!closed&&stageBusy(scope)){
      // A twin that is no longer ready by then, or whose address another twin took, is not prepared.
      pendingPreparations.set(scope,async()=>applications(environment).some(app=>{const current=resolveEnvironment(app.url);return current&&(current.id!==environment.id||current.status!=='ready');})?null:prepareEnvironment(context,environment,{isCurrent}));
      try{if(isCurrent()&&!verifying(scope)){retarget(scope,context,environment);await persist();}}catch{/* The preparation reports it once the stage is idle. */}
      finally{release();}
      return summary(context);
    }
    pendingPreparations.delete(scope);
    // Persist the attempt before any runtime/model work. Restart and read-only
    // views never replay this hook, including a previously blocked attempt.
    const preparation:Preparation={environmentId:environment.id,status:'preparing',createdAt:now()};
    state.preparationAttempts[attempt]=true;state.preparations[scope]=preparation;
    try{
      await persist();
      requireIdle(context);
      if(!isCurrent())throw conflict('The active source changed. Open this source and discover cases to continue.');
      const config=retarget(scope,context,environment);
      if(!config)throw new Error('Choose the application URL before discovering integration tests.');
      preparation.targetUrl=config.targetUrl;
      // Reusing the stage's cases avoids overwriting reviews or charging for
      // duplicate discovery whenever another application environment is made.
      if((state.cases[scope]||[]).length){preparation.status='completed';preparation.completedAt=now();await persist();return summary(context);}
      await start(context,'discover',{}, {preparation,isCurrent});
    }catch(error){Object.assign(preparation,{status:'needs_setup',error:browserError(error),completedAt:now()});await persist();}
    finally{release();}
    return summary(context);
  }
  return {
    summary,prepareEnvironment:(...args:Parameters<typeof prepareEnvironment>)=>admit(()=>prepareEnvironment(...args)),viewModel,listModels,saveModelSettings:(input:unknown)=>admit(()=>saveModelSettings(input)),
    interruptedEnvironmentIds:()=>[...new Set(state.runs.filter((run):run is BrowserRun&{environmentId:string}=>Boolean(run.environmentUseUncertain&&run.environmentId)).map(run=>run.environmentId))],
    draft:(...args:Parameters<typeof draft>)=>admit(()=>draft(...args)),transcribe:(...args:Parameters<typeof transcribe>)=>admit(()=>transcribe(...args)),
    hasPendingInput:()=>inputJobs.size>0,
    async view(context:BrowserStageContext):Promise<BrowserViewReply>{const scope=scopeId(context);return {config:publicConfig(scope),callbacks:callbackReview(context),cases:structuredClone(state.cases[scope]||[]),specs:specView(scope),runs:state.runs.filter(r=>r.scope===scope).slice(0,30).map(publicRun),preparation:structuredClone(state.preparations[scope]||null),analysis:structuredClone(state.analyses[scope]||null),accounts:targetAccounts(state.configs[scope]?.targetUrl),capabilities:await capabilities()};},
    saveModel(context:BrowserStageContext,input:unknown){return admit(()=>{requireIdle(context);return updateModel(()=>modelSettings.save(input));});},
    async saveConfig(context:BrowserStageContext,config:unknown){
      requireIdle(context);const normalized=normalizedConfig(config,context),scope=scopeId(context);
      let nextTarget:BrowserState['configTargets'][string]|undefined;
      const candidate=()=>{
        requireIdle(context);
        const target=state.configTargets[scope],sameTarget=target?.url===state.configs[scope]?.targetUrl&&publicConfig(scope).targetUrl===normalized.targetUrl;
        nextTarget=target&&(target.url===normalized.targetUrl||sameTarget)?{...structuredClone(target),url:normalized.targetUrl}:undefined;
        if(nextTarget)delete nextTarget.suspendedReads;
        const previous=state.configs[scope]?.callbackBindings??[];
        const added=(normalized.callbackBindings??[]).filter(binding=>!previous.some(item=>item.applicationId===binding.applicationId&&item.hostname===binding.hostname));
        if(added.length)resolveCallbackOrigins(added,callbackResolution(context,normalized,nextTarget));
      };
      candidate();let saving=false;
      try{await persist(()=>{
        candidate();busy.add(scope);saving=true;
        const targets={...state.configTargets};if(nextTarget)targets[scope]=nextTarget;else delete targets[scope];
        const preparations={...state.preparations};if(normalized.targetUrl&&preparations[scope]?.status==='needs_setup')delete preparations[scope];
        return {...state,configs:{...state.configs,[scope]:normalized},configTargets:targets,preparations};
      },()=>{
        state.configs[scope]=normalized;if(nextTarget)state.configTargets[scope]=nextTarget;else delete state.configTargets[scope];
        if(normalized.targetUrl&&state.preparations[scope]?.status==='needs_setup')delete state.preparations[scope];
      });return {config:structuredClone(normalized)};}finally{if(saving)free(scope);}
    },
    saveCases(context:BrowserStageContext,cases:unknown,baseCases?:unknown){return admit(async()=>{
      requireIdle(context,{duringRun:true});
      const scope=scopeId(context),normalized=validateBrowserCases(cases,{draft:true});
      if(baseCases!==undefined&&!isDeepStrictEqual(validateBrowserCases(baseCases,{draft:true}),state.cases[scope]||[]))throw conflict('Tests changed. Reopen the test and apply your changes again.');
      assertReviewedJourneys(normalized,state.cases[scope]||[]);
      const release=usage.acquire(context,{operation:'save integration cases'});
      busy.add(scope);
      try{
        // Publish only after durable persistence. Other stages keep their own
        // updates, and failed writes never approve a case in memory.
        let code:JourneyCodeState;
        await persist(()=>{
          code=replaceJourneyCases(codeState(scope),normalized);
          return {...state,cases:{...state.cases,[scope]:normalized},specs:{...state.specs,[scope]:code.specs},authoring:{...state.authoring,[scope]:code.authoring||{}},generationFailures:{...state.generationFailures,[scope]:code.generationFailures}};
        },()=>{state.specs[scope]=code.specs;state.generationFailures[scope]=code.generationFailures;state.authoring[scope]=code.authoring||{};state.cases[scope]=normalized;});
        // A deleted case's code generation stops with it.
        discardObsoleteGenerations(scope,normalized);
        // So does its verification.
        for(const entry of verifications.values())if(entry.scope===scope&&!entry.done&&!normalized.some(item=>item.id===entry.caseId))cancelVerification(context,entry.caseId);
        return {cases:structuredClone(normalized)};
      }finally{free(scope);release();}
    });},
    saveSpec:(context:BrowserStageContext,input:{caseId?:unknown;code?:unknown})=>writeSpec(context,input?.caseId,(scope,id)=>journeyCode.saveDraft(scope,id,input.code)),
    approveSpec:(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown})=>writeSpec(context,input?.caseId,(scope,id)=>journeyCode.approve(scope,id,input.hash)),
    discardSpec:(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown})=>writeSpec(context,input?.caseId,(scope,id)=>journeyCode.discard(scope,id,input.hash)),
    reuseSpec:(context:BrowserStageContext,input:{caseId?:unknown})=>writeSpec(context,input?.caseId,(scope,id)=>journeyCode.reuse(scope,id)),
    async specCode(context:BrowserStageContext,input:{caseId?:unknown}){return journeyCode.code(scopeId(context),input?.caseId);},
    verifySpec:(context:BrowserStageContext,input:Parameters<typeof verifySpec>[1])=>admit(()=>verifySpec(context,input)),
    cancelSpecVerification:async(context:BrowserStageContext,input:{caseId?:unknown})=>cancelVerification(context,input?.caseId),
    generateSpec:(context:BrowserStageContext,input:Parameters<typeof generateSpec>[1])=>admit(()=>generateSpec(context,input)),
    cancelSpecGeneration:async(context:BrowserStageContext,input:{caseId?:unknown})=>cancelGeneration(context,input?.caseId),
    // options.manual: a person started the run, so a journey without current approved code may run its current draft.
    run:(context:BrowserStageContext,input?:StartInput,options?:StartOptions)=>start(context,'run',input,options),discover:(context:BrowserStageContext,input?:StartInput)=>start(context,'discover',input),
    async runProgress(context:BrowserStageContext,id:string){return report(find(context,id));},
    async frame(context:BrowserStageContext,id:string,caseId?:unknown){const run=find(context,id);if(caseId!==undefined&&!run.progress?.cases.some(item=>item.id===caseId))throw Object.assign(new Error('Journey not found in this run.'),{statusCode:404});const stored=frames.get(id);return (caseId===undefined?stored?.latest:stored?.cases.get(caseId as string))||null;},
    // Only a file its journey reported, in this stage's run, is served.
    async video(context:BrowserStageContext,id:string,caseId:unknown,file:unknown){
      const run=find(context,id),progress=run.progress?.cases.find(item=>item.id===caseId);
      const notFound=()=>Object.assign(new Error('Recording not found.'),{statusCode:404});
      if(typeof file!=='string'||!progress?.videos?.includes(file))throw notFound();
      const path=join(videoRoot,id,file),info=await lstat(path).catch(()=>null);
      // Under lstat a symbolic link is not a file.
      if(!info?.isFile()||!info.size)throw notFound();
      return {path,size:info.size};
    },
    async skip(context:BrowserStageContext,id:unknown,caseId:unknown){const run=find(context,id);if(run.mode!=='run'||!includes(run.caseIds,caseId))throw Object.assign(new Error('Journey not found in this run.'),{statusCode:404});const journey=caseId,entry=jobs.get(run.id);if(entry){entry.skips.add(journey);if(entry.scheduler)entry.scheduler.skip(journey);else if(!run.results?.some(result=>result.caseId===journey)){/* A journey settled before the scheduler started keeps its verdict. */const item=run.progress.cases.find(item=>item.id===journey)!;item.status='skipped';item.completedAt=now();touch(run);}}return report(run);},
    async stop(context:BrowserStageContext,id:unknown){const run=find(context,id),entry=jobs.get(run.id);if(entry){entry.cancelled=true;entry.cancel();}return {run:publicRun(run)};},
    // A terminal verdict can still be saving results and releasing its target.
    isActive(context:{key:string;stageId:string}){const scope=scopeId(context);return busy.has(scope)||generating(scope)||verifying(scope)||state.runs.some(r=>r.scope===scope&&(active(r)||jobs.has(r.id)));},
    close(){
      if(closing)return closing;closed=true;
      const cancel=()=>{for(const entry of verifications.values())entry.cancelled=true;for(const entry of jobs.values()){entry.cancelled=true;entry.cancel();}for(const controller of inputJobs.keys())controller.abort();for(const entry of generations.values())if(entry.status==='running')entry.cancel();};cancel();
      closing=(async()=>{await Promise.allSettled([...admissions]);cancel();await Promise.allSettled([...jobs.values()].map(job=>job.promise));await Promise.allSettled([...generationJobs,...verificationJobs]);await saves.idle();})();return closing;
    },
  };
}
