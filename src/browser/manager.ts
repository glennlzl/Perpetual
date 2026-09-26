import {createSaveQueue,privateDirectory,readStateFile,writeStateFile} from '../store.ts';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createBrowserRuntime,validateBrowserTarget,browserError} from './runtime.ts';
import {validateBrowserCases,browserDiscoveryContext,discoveredBrowserCases,assertReviewedJourneys} from '../business/browser-cases.ts';
import {createBrowserModelSettings} from './model.ts';
import {createOpenRouterModelCatalog,isOpenRouterEndpoint} from './openrouter-models.ts';
import {draftBrowserCase,transcribeBrowserAudio,validateTestDescription} from './openrouter-input.ts';
import {journeyResult,runStatus} from './results.ts';
import {createJourneyScheduler,journeyConcurrency} from './journey-scheduler.ts';
import {createEnvironmentUsage,scopeId} from '../environments/usage.ts';
import {validateRunCredentials} from './run-credentials.ts';
import {services as twinServices} from '../twin/registry.ts';
import {appId} from '../twin/detect.ts';
import {createTwinRuntime} from '../twin/runtime.ts';
import {createPlaywrightRuntime} from '../journeys/playwright/runtime.ts';
import {caseHash,signsIn,specHash,validateJourneySpec} from '../journeys/playwright/specs.ts';
import {CHECK_VERSION,RUN,checkTemplate,resolvedFrom} from '../journeys/playwright/checks.ts';
import {CANCELLED,generateJourneySpec} from '../journeys/playwright/generation.ts';
import {privateWorkspace} from '../agents/opencode.ts';
import type {BrowserCase,MilestoneCheck} from '../business/browser-cases.ts';
import type {BrowserModelConfiguration} from './model-policy.ts';
import type {BrowserCapabilities,BrowserWorkerInput,WorkerError,WorkerEvent,WorkerJob} from './runtime.ts';
import type {Blocker,JourneyResult,RunStatus} from './results.ts';
import type {ConcurrencyLimit} from './journey-scheduler.ts';
import type {RunCredentials} from './run-credentials.ts';
import type {JourneyRunInput} from '../journeys/playwright/runtime.ts';
import type {EnvironmentAccount} from '../environments/manager.ts';
import type {EnvironmentUsage} from '../environments/usage.ts';
import type {ScanRepo,ScanService} from '../scanner.ts';
import type {TwinAccount} from '../twin/runtime.ts';

/** The active source scan, as far as browser tests read it (src/scanner.ts). */
type StageScan={repo:Pick<ScanRepo,'path'>&Partial<Pick<ScanRepo,'sha'>>;services?:readonly (Pick<ScanService,'id'>&Partial<Pick<ScanService,'framework'|'path'>>)[]};
/** The Sandbox stage a browser operation belongs to, with its active source. */
export type BrowserStageContext={key:string;stageId:string;scan:StageScan;controllerOrigin?:string};
/**
 * A stage's browser test settings. signInUrl is the sign-in page, where a journey's test account signs in when the
 * application URL shows no sign-in form: '' or a URL on the application URL's origin.
 */
export type BrowserConfig={targetUrl:string;signInUrl:string;scope:string;requirements:string;maxSteps:number;journeyTimeoutSeconds:number;externalOrigins:string[];authEndpoints:string[]};
/** The environment behind a target URL, as the environments manager resolves it (src/environments/manager.ts). */
export type TargetEnvironment={id:string;status:string;stageId?:string|null;pipelineKey?:string|null;repoPath?:string|null;apps?:readonly unknown[]|null;services?:readonly unknown[]|null;accounts?:readonly EnvironmentAccount[]|null};
/** One test account's sign-in, read from the twin's private state for one operation. */
type AccountSignIn=Pick<TwinAccount,'username'|'password'|'authEndpoints'>;
/** What the manager uses of environment leases. */
type Leases=Pick<EnvironmentUsage,'assertAvailable'|'acquire'>;
/** Runs one journey's approved Playwright code (src/journeys/playwright/runtime.ts). */
type JourneyRuntime={capabilities():Promise<{browserInstalled?:boolean}>;start(input:JourneyRunInput,onEvent:(event:WorkerEvent)=>void):WorkerJob<unknown>};
/** The browser agent, which discovers journeys; an absent capability is unknown. */
type AgentRuntime={capabilities():Promise<Partial<BrowserCapabilities>>;start(input:BrowserWorkerInput,onEvent:(event:WorkerEvent)=>void):WorkerJob<unknown>};

/**
 * A case's journey code as saved; approved once a person approved it after its verification, whose runs it names, under
 * the check version its attempts ran with (1 when an older controller approved it). A draft keeps how its latest
 * verification ended, since the run history keeps only the controller's latest runs.
 */
type StoredSpec={code:string;hash:string;caseHash:string;savedAt:string;provenance?:unknown;verification?:StoredVerification};
type ApprovedSpec=StoredSpec&{approvedAt:string;approvedRunIds:string[];checkVersion?:number};
type CaseSpecs={approved:ApprovedSpec|null;draft:StoredSpec|null};
// A spec stored before approved and draft code were kept apart.
type LegacySpec=StoredSpec&{approvedAt?:string;approvedRunId?:string};
/** One attempt of a draft's verification: three ordinary runs, then a control run; an older controller's has no checkVersion. */
type Verification={id:string;hash:string;caseHash:string;checkVersion?:number;attempt:number;control:boolean};
type VerificationState={status:'passed'|'failed'|'cancelled';passes:number;control:'missed'|'caught'|null;error?:string};
type StoredVerification=VerificationState&{id:string;checkVersion:number;runIds:string[]};
type CheckResult=MilestoneCheck&{passed:boolean;observed?:number;resolved?:string;error?:string;provenance:'independent'};
type StepProgress={id:string;title:string;status:string;evidence?:string;checks?:CheckResult[]};
type ActionProgress={type:string;status:string;errorCode?:string};
/** One journey's live progress in a run, or discovery's. */
export type CaseProgress={id:string;caseId:string;name:string;status:string;actions:ActionProgress[];actionCount:number;steps?:StepProgress[];lastAction?:{type:string;status:string};queueReason?:string;startedAt?:string;completedAt?:string;frameUpdatedAt?:string;frameCapturedAt?:string;videos?:string[]};
export type RunProgress={revision:number;cases:CaseProgress[]};
type Discovery={cases:BrowserCase[];summary:string;authenticated:boolean};
type Analysis=Discovery&{createdAt:string;sourceRevision:string|null;error?:string};
/** A browser run (its journeys) or discovery, persisted with the approved case snapshots it executes. */
export type BrowserRun={
  id:string;scope:string;stageId:string;mode:'run'|'discover';status:'queued'|'running'|RunStatus;createdAt:string;startedAt?:string;completedAt?:string;
  targetUrl:string;sourceRevision:string|null;caseIds:string[];approvedCases:BrowserCase[];progress:RunProgress;results?:JourneyResult[];error?:string;
  engine?:'playwright';concurrency?:number;effectiveConcurrency?:number;concurrencyLimit?:ConcurrencyLimit;specHashes?:Record<string,string>;
  environmentId?:string;environmentUseUncertain?:boolean;verification?:Verification;discovery?:Discovery;frameUpdatedAt?:string;frameCapturedAt?:string;
};
type VerificationRun=BrowserRun&{verification:Verification};
type Preparation={environmentId:string;status:string;createdAt:string;targetUrl?:string;runId?:string;error?:string;completedAt?:string};
type BrowserState={
  version:1;configs:Record<string,BrowserConfig>;cases:Record<string,BrowserCase[]>;analyses:Record<string,Analysis>;runs:BrowserRun[];
  preparations:Record<string,Preparation>;preparationAttempts:Record<string,true>;configTargets:Record<string,{environmentId:string;url:string;signInPath?:string}>;specs:Record<string,Record<string,CaseSpecs>>;
};
type RunnableCode={code:string;hash:string;checkVersion:number;missing?:undefined}|{missing:string;code?:undefined;hash?:undefined;checkVersion?:undefined};
/**
 * keepLease takes the run's lease as the run ends, instead of it being released, for a caller that goes on using the twin.
 * target: the config and twin a verification started with, which each of its attempts runs with instead of the stage's current ones.
 */
type StartOptions={manual?:boolean;verification?:Verification;preparation?:Preparation;isCurrent?:()=>boolean;keepLease?:(release:()=>void)=>void;target?:{config:BrowserConfig;environmentId:string|null}};
/** A run request's fields; each is checked before use. */
type StartInput={credentials?:unknown;accountId?:unknown;concurrency?:unknown;caseIds?:unknown;replaceCaseIds?:unknown;baseCases?:unknown};
type InputOptions={signal?:AbortSignal;isCurrent?:()=>boolean};
/** A run's execution while it is active; kept in memory only. */
type RunJob={cancelled:boolean;cancel:()=>void;promise:Promise<void>|null;skips:Set<string>;scheduler?:{skip(id:string):boolean;cancel():void}};
/** A case's code generation: running, or why it failed until the next attempt. */
type Generation={scope:string;status:'running'|'failed';step?:string;error?:string;rejected?:string;cancelled:boolean;cancel():void};
/** A case's verification while it is between or inside attempts, or why it could not go on. */
type VerificationEntry={id:string;scope:string;caseId:string;hash:string;caseHash:string;checkVersion:number;cancelled:boolean;done:boolean;run:string|null;error?:string};
type StoredFrames={latest:Buffer|null;cases:Map<string,Buffer>};
/** A draft's verification as a view shows it: running until this controller's attempts have settled. */
type SpecVerification=Omit<VerificationState,'status'>&{status:VerificationState['status']|'running'};
/** A case's journey code as a view shows it, without the code: its approval, draft verification and generation. */
export type SpecSummary={
  approved?:{hash:string;stale:boolean;approvedAt:string;provenance?:unknown};
  draft?:{hash:string;stale:boolean;provenance?:unknown;verification?:SpecVerification};
  generation?:Pick<Generation,'status'|'step'|'error'|'rejected'>;
};
/** The browser manager of a controller, as createBrowserManager returns it. */
export type BrowserManager=Awaited<ReturnType<typeof createBrowserManager>>;
export type BrowserManagerOptions={
  dataDir:string;runtime?:AgentRuntime;playwright?:JourneyRuntime;generation?:Partial<Parameters<typeof generateJourneySpec>[0]>;usage?:Leases;
  resolveEnvironment?:(url:string)=>TargetEnvironment|null|undefined;onEnvironmentUncertain?:(environmentId:string,error:string)=>Promise<unknown>;
  twinAccount?:(environment:TargetEnvironment,accountId:string)=>Promise<AccountSignIn|null|undefined>;
};

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const includes=<T>(list:readonly T[],value:unknown):value is T=>(list as readonly unknown[]).includes(value);
const isLegacySpec=(spec:CaseSpecs|LegacySpec):spec is LegacySpec=>typeof (spec as Partial<LegacySpec>|null)?.code==='string';
// Approved code names its verification's runs: three passing runs, then the control run.
const verifiedApproval=(spec:ApprovedSpec)=>Array.isArray(spec.approvedRunIds)&&spec.approvedRunIds.length===4;
// An error's message, or anything else thrown as it is.
const messageOf=(error:unknown):unknown=>typeof error==='object'&&error!==null&&'message' in error?error.message:undefined;
const now=()=>new Date().toISOString();
const runConcurrency=(value:unknown)=>{if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>4)throw new Error('Choose 1–4 concurrent journeys.');return value;};
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const publicRun=({scope,approvedCases,environmentUseUncertain,...run}:StoredRun)=>structuredClone({...run,caseSummaries:(approvedCases||[]).map(({id,name,goal,preconditions,expectedOutcomes,assertions,steps,isolation})=>({id,name,goal,preconditions,expectedOutcomes,assertions,steps:steps||[],isolation:isolation||'shared'}))});
const summaryKeys=new Set<string>(['id','stageId','environmentId','mode','engine','verification','status','createdAt','startedAt','completedAt','targetUrl','sourceRevision','caseIds','caseSummaries','results','error','frameUpdatedAt','frameCapturedAt','concurrency','effectiveConcurrency','concurrencyLimit']);
type StoredRun=Omit<BrowserRun,'progress'>&{progress?:RunProgress};
/** A run as a view shows it: without its stage scope or the approved snapshots, with case summaries. */
export type PublicRun=ReturnType<typeof publicRun>;
type SummaryProgress={revision:number;cases:Omit<CaseProgress,'actions'>[]};
/** A run as graph polling shows it: summary fields, with live progress for active and latest runs. */
export type RunSummary=Partial<Omit<PublicRun,'progress'>>&{progress?:SummaryProgress};
// Graph polling carries live state only; full action lists stay in runProgress.
function summaryRun({progress,...run}:BrowserRun,withProgress:boolean){
  // Only the summary keys of the public run.
  const view=Object.fromEntries(Object.entries(publicRun(run)).filter(([key])=>summaryKeys.has(key))) as RunSummary;
  if(withProgress&&progress)view.progress=structuredClone({...progress,cases:progress.cases.map(({actions,...item})=>item)});
  return view;
}
const defaults:BrowserConfig={targetUrl:'',signInUrl:'',scope:'',requirements:'',maxSteps:60,journeyTimeoutSeconds:900,externalOrigins:[],authEndpoints:[]};
// Why a journey of a run has no code to run; it needs review without a browser.
const NO_CODE='Generate and approve code for this journey.',STALE_CODE='The approved code is for an earlier version of this journey.';
// A control run's journey passed although every state-changing request was blocked: its checks cannot tell. It ended
// another way before a reviewed check failed: nothing judged it. An attempt ran no draft since its journey changed.
const MISSED='The journey passed with every change blocked. Strengthen its checks.',UNJUDGED='No reviewed check noticed the blocked changes.',CHANGED='The journey changed during its verification. Verify its code again.';
// The twin a verification started on is gone or no longer ready, so its attempts cannot go on there.
const TWIN_CHANGED='The environment changed during its verification. Verify its code again.';
// A reviewed check noticed that nothing the journey did was kept: a milestone check, or a final assertion on the end state it reached, failed.
const noticed=(run:BrowserRun,caseId:string,result:JourneyResult|undefined)=>Boolean(run.progress?.cases.find(item=>item.id===caseId)?.steps?.some(step=>step.status==='failed')||result?.assertions?.some(item=>item.passed===false&&item.reached!==false));
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
// Twin services left out for missing test inputs. Nothing substitutes for them, so a journey that needs one is blocked.
const unavailableServices=(environment:TargetEnvironment|null|undefined)=>(environment?.services??[]).filter((service):service is {id:string;missing?:unknown}=>isRecord(service)&&service.status==='blocked'&&typeof service.id==='string')
  .map(({id,missing})=>({id,title:Object.hasOwn(twinServices,id)?twinServices[id].title:id,missing:(Array.isArray(missing)?missing:[]).filter(name=>typeof name==='string'&&name.trim()).slice(0,20)}));

function externalOrigins(value:unknown,context:{controllerOrigin?:string}){
  if(!Array.isArray(value)||value.length>10)throw new Error('Add at most 10 external origins.');
  return [...new Set(value.map(item=>{
    let url=null;try{url=new URL(item);validateBrowserTarget(item,context);}catch{url=null;}
    if(typeof item!=='string'||!url||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||/[?#]/.test(item))throw new Error('External origins must be HTTPS origins without credentials, paths or queries.');
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
    if(targetUrl&&url.hostname!==new URL(targetUrl).hostname)throw new Error('Auth endpoints must be on the application host.');
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
  // scope and requirements are strings or empty now.
  return {targetUrl,signInUrl:signInPage(input.signInUrl,targetUrl),scope:(input.scope||'') as string,requirements:(input.requirements||'') as string,maxSteps,journeyTimeoutSeconds,externalOrigins:externalOrigins(input.externalOrigins??[],context),authEndpoints:authEndpoints(input.authEndpoints??[],targetUrl)};
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
  // <uuid>/ per code generation, removed when it ends; none survives a restart.
  const generationRoot=join(root,'generations');await mkdir(generationRoot,{recursive:true,mode:0o700});
  const generationInfo=await lstat(generationRoot);if(generationInfo.isSymbolicLink()||!generationInfo.isDirectory())throw new Error('Code generation storage must not be a symbolic link.');
  await Promise.all((await readdir(generationRoot)).filter(name=>runFolder.test(name)).map(name=>rm(join(generationRoot,name),{recursive:true,force:true})));
  const modelSettings=await createBrowserModelSettings({dataDir});
  const modelCatalog=createOpenRouterModelCatalog();
  runtime ||= createBrowserRuntime({model:()=>modelSettings.configuration()});
  let state:BrowserState={version:1,configs:{},cases:{},analyses:{},runs:[],preparations:{},preparationAttempts:{},configTargets:{},specs:{}};
  {const saved=await readStateFile(file,{limit:16*1024*1024,invalid:'Invalid browser state.'});if(saved!==undefined){if(!isRecord(saved)||saved.version!==1||!Array.isArray(saved.runs)||!saved.configs||!saved.cases||!saved.analyses)throw new Error('Unsupported browser state.');state=saved as BrowserState;}}
  for(const key of ['preparations','preparationAttempts','configTargets','specs'] as const){state[key]??={};if(typeof state[key]!=='object'||Array.isArray(state[key]))throw new Error('Unsupported browser preparation state.');}
  // Add current draft defaults without rewriting immutable historical approvals.
  for(const [scope,cases] of Object.entries(state.cases))state.cases[scope]=validateBrowserCases(cases,{draft:true});
  // A case's journey code is its approved spec beside a draft. Code approved without a verification, as a stored single
  // spec was after one passing run, is a draft again, so no gate runs it before it is verified and approved; a draft
  // already beside it is newer and stays instead.
  for(const specs of Object.values(state.specs))for(const [caseId,spec] of Object.entries(specs)){
    if(isLegacySpec(spec)){const {approvedAt,approvedRunId,...kept}=spec;specs[caseId]={approved:null,draft:kept};}
    else if(spec.approved&&!verifiedApproval(spec.approved)){const {approvedAt,approvedRunIds,...kept}=spec.approved;specs[caseId]={approved:null,draft:spec.draft??kept};}
  }
  const saves=createSaveQueue();let closed=false,modelSaving=false,closing:Promise<void>|undefined;const jobs=new Map<string,RunJob>(),inputJobs=new Map<AbortController,Promise<unknown>>(),busy=new Set<string>(),frames=new Map<string,StoredFrames>(),admissions=new Set<Promise<unknown>>();
  // One code generation per case: `${scope}\0${caseId}` → {scope,status,step,error,cancel}; kept in memory only.
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
  function persist(project:()=>BrowserState=()=>state,commit=()=>{}):Promise<void>{return saves.run(async()=>{const content=JSON.stringify(project());if(Buffer.byteLength(content)>16*1024*1024)throw new Error('Browser metadata storage is full.');await writeStateFile(file,content);commit();});}
  // Journeys that never started are cancelled, not failed; interrupted milestones stay unconfirmed. A restart ends a
  // verification, so its interrupted attempt is cancelled rather than judged.
  const interrupted:Partial<Record<string,'cancelled'|'failed'|'skipped'>>={pending:'cancelled',queued:'cancelled',running:'failed',skipping:'skipped',cancelling:'cancelled'};
  for(const run of state.runs)if(active(run)){
    const attempt=Boolean(run.verification);
    Object.assign(run,{status:attempt?'cancelled':'failed',error:attempt?'The controller stopped during this verification.':'The controller stopped during this operation.',completedAt:now(),...(run.environmentId?{environmentUseUncertain:true}:{})});
    for(const item of run.progress?.cases||[])if(interrupted[item.status]){
      const status=attempt&&item.status==='running'?'cancelled':interrupted[item.status]!,unstarted=status==='cancelled'&&['pending','queued'].includes(item.status);
      Object.assign(item,{status,completedAt:run.completedAt});settleSteps(item,status);
      if(run.mode!=='run'||(run.results||[]).some(result=>result.caseId===item.id))continue;
      // An interrupted journey ended on the controller's exception; cancelled and skipped journeys have no verdict.
      // A run's journeys are its approved cases.
      const result=status==='failed'?journeyResult(run.approvedCases.find(value=>value.id===item.id)!,{caseId:item.id,stopCause:'exception',error:'The controller stopped during this journey.'},item.steps):{caseId:item.id,status,assertions:[],...(unstarted?{error:'Controller stopped before this journey started'}:{})};
      run.results=[...(run.results||[]),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
    }
    if(run.progress)touch(run);
  }
  for(const preparation of Object.values(state.preparations))if(['preparing','discovering'].includes(preparation.status))Object.assign(preparation,{status:'failed',error:'The controller stopped while preparing integration tests. Discover cases to try again.',completedAt:now()});
  // Also removes folders left by a crash or by runs past the history limit.
  await pruneVideos();
  await persist();
  // A draft's attempts, first to last: ordinary runs of exactly that code for its one case, the fourth a control run.
  const attemptsOf=(id:string)=>state.runs.filter((run):run is VerificationRun=>run.verification?.id===id).sort((a,b)=>a.verification.attempt-b.verification.attempt);
  /**
   * The latest verification of a case's draft, from its runs: three passing runs, then a control run with every change
   * blocked in which a reviewed check must fail. It holds only for exactly that code and reviewed journey, under the
   * current check version, so the same code saved for other checks, or verified by checks that read less, is unverified.
   * It stops at the first attempt that does not pass; an unfinished one this controller no longer runs, as after a
   * restart, was cancelled.
   */
  const latestVerification=(scope:string,caseId:string,draft:StoredSpec):string|undefined=>{
    const live=verifications.get(generationKey(scope,caseId)),of=(value:{hash:string;caseHash:string;checkVersion?:number}|undefined):value is {hash:string;caseHash:string}=>value?.hash===draft.hash&&value.caseHash===draft.caseHash&&(value.checkVersion??1)===CHECK_VERSION;
    return of(live)?live.id:state.runs.find((run):run is VerificationRun=>run.scope===scope&&run.caseIds[0]===caseId&&of(run.verification))?.verification.id;
  };
  function verificationView(scope:string,caseId:string,draft:StoredSpec):SpecVerification|null{
    const live=verifications.get(generationKey(scope,caseId)),id=latestVerification(scope,caseId,draft);
    // How it ended counts once this controller's attempts have settled, so a gate and an approval still wait for it.
    if(!(live&&live.id===id&&!live.done)&&draft.verification?.checkVersion===CHECK_VERSION&&(!id||id===draft.verification.id)){const {id:_id,checkVersion:_version,runIds:_runIds,...ended}=draft.verification;return ended;}
    if(!id)return null;
    const {status,error,...counts}=verificationOf(caseId,id,live?.id===id?live:null);
    // It runs until this controller's attempts have settled, so a gate and an approval wait for it.
    return live?.id===id&&!live.done?{status:'running',...counts}:{status,...counts,...(error?{error}:{})};
  }
  function verificationOf(caseId:string,id:string,live:VerificationEntry|null):VerificationState{
    let passes=0;
    for(const run of attemptsOf(id)){
      if(active(run))break;
      // Every attempt before this one passed; one the history no longer holds leaves the verification unknown.
      if(run.verification.attempt!==passes+1)return {status:'cancelled',passes:0,control:null};
      const result=run.results?.find(item=>item.caseId===caseId),failed=(error=result?.error||run.error||'The journey did not pass.'):VerificationState=>({status:'failed',passes,control:null,error});
      if(run.status==='cancelled'||includes(['cancelled','skipped'],result?.status))return {status:'cancelled',passes,control:null};
      // An attempt counts only when it ran the draft; one settled without it, as after its journey changed, judged nothing.
      if(run.specHashes?.[caseId]!==run.verification.hash)return failed();
      if(!run.verification.control){if(result?.status!=='passed')return failed();passes++;continue;}
      // A control run follows three passing runs; without them on record, as once older runs are pruned, it verified nothing.
      if(passes<3)return {status:'cancelled',passes,control:null};
      if(!result)return failed();
      if(result.status==='passed')return {status:'failed',passes,control:'missed',error:MISSED};
      // Only a reviewed check that failed noticed that nothing the journey did was kept; an action the block broke,
      // a blocker or an error judged nothing.
      return noticed(run,caseId,result)?{status:'passed',passes,control:'caught'}:failed(result.error?`${UNJUDGED} ${result.error}`:UNJUDGED);
    }
    return live?.error?{status:'failed',passes,control:null,error:live.error}:{status:'cancelled',passes,control:null};
  }
  // A case's journey code: the approved spec and a draft beside it. Only code for the case's current reviewed contract is
  // current, and code goes with its case. generation: code being generated, or why it failed.
  function specView(scope:string){
    const specs=state.specs[scope]||{};
    return Object.fromEntries((state.cases[scope]||[]).filter(item=>specs[item.id]||generations.has(generationKey(scope,item.id))).map((item):[string,SpecSummary]=>{
      const {approved,draft}=specs[item.id]||{},generation=generations.get(generationKey(scope,item.id)),verification=draft&&verificationView(scope,item.id,draft);
      const provenance=(spec:StoredSpec)=>spec.provenance?{provenance:structuredClone(spec.provenance)}:{};
      return [item.id,{
        ...(approved?{approved:{hash:approved.hash,stale:approved.caseHash!==caseHash(item),approvedAt:approved.approvedAt,...provenance(approved)}}:{}),
        ...(draft?{draft:{hash:draft.hash,stale:draft.caseHash!==caseHash(item),...provenance(draft),...(verification?{verification}:{})}}:{}),
        ...(generation?{generation:{status:generation.status,...(generation.step?{step:generation.step}:{}),...(generation.error?{error:generation.error}:{}),...(generation.rejected?{rejected:generation.rejected}:{})}}:{}),
      }];
    }));
  }
  // The code a journey runs: the approved spec for exactly its reviewed case or, for a person's run only, the current
  // draft when no approved spec is current, so a new journey can be tried; a gate never runs a draft. A verification
  // attempt runs exactly the draft it verifies, for exactly the journey it verifies. Approved code runs under the check version
  // it was verified with, a draft under the current one. Otherwise why the journey needs review instead.
  function runnableCode(scope:string,item:BrowserCase,{manual=false,verification}:StartOptions={}):RunnableCode{
    const {approved,draft}=state.specs[scope]?.[item.id]||{},current=(spec:StoredSpec|null|undefined)=>spec?.caseHash===caseHash(item);
    const spec=verification?(draft?.hash===verification.hash&&draft.caseHash===verification.caseHash&&current(draft)?draft:null):current(approved)?approved:manual&&current(draft)?draft:null;
    if(!spec)return {missing:verification?CHANGED:approved&&!current(approved)?STALE_CODE:NO_CODE};
    // An approval kept from an older grammar never runs code the current one rejects.
    try{validateJourneySpec(spec.code,item);}catch(error){return {missing:`Generate code for this journey again: ${(error as Error).message}`};}
    return {code:spec.code,hash:spec.hash,checkVersion:spec===approved?approved.checkVersion??1:CHECK_VERSION};
  }
  const keptSpecs=(scope:string,cases:readonly BrowserCase[])=>Object.fromEntries(Object.entries(state.specs[scope]||{}).filter(([id])=>cases.some(item=>item.id===id)));
  // A case deleted while it is saved keeps no code; a case with neither approved nor draft code keeps no entry.
  // next(specs) computes the case's code from the state as the write commits, after every earlier write, so a second
  // writer of the same case judges the first one's code and is refused rather than silently overwriting it.
  function storeSpec(scope:string,caseId:string,next:(specs:CaseSpecs)=>CaseSpecs){
    let value:CaseSpecs|undefined;
    const specs=()=>{
      value??=next(state.specs[scope]?.[caseId]||{approved:null,draft:null});
      const kept={...state.specs[scope]};
      if((state.cases[scope]||[]).some(item=>item.id===caseId)&&(value.approved||value.draft))kept[caseId]=value;else delete kept[caseId];
      return kept;
    };
    return persist(()=>({...state,specs:{...state.specs,[scope]:specs()}}),()=>{state.specs[scope]=specs();});
  }
  // next(item, {approved, draft}) returns the case's new code; it never runs while the case's code is generated or verified.
  function writeSpec(context:BrowserStageContext,caseId:unknown,next:(item:BrowserCase,specs:CaseSpecs)=>CaseSpecs){return admit(async()=>{
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is being generated. Stop it first.');
    if(verifying(scope,item.id))throw conflict('Code for this test is being verified. Stop it first.');
    await storeSpec(scope,item.id,specs=>next(item,specs));
    if(generations.get(key)?.status==='failed')generations.delete(key);
    return {spec:{caseId:item.id,...specView(scope)[item.id]},specs:specView(scope)};
  });}
  const drafted=(item:BrowserCase,code:string,extra:{provenance?:unknown}={}):StoredSpec=>({code,hash:specHash(code),caseHash:caseHash(item),savedAt:now(),...extra});
  /**
   * Verifies a case's current draft before it may be approved: up to three ordinary runs of exactly that code for its
   * one case, then a control run with every state-changing request blocked. The journey must pass each run, and a
   * reviewed check must fail in the control run. Only this request starts it; a gate waits while it runs.
   */
  function verifySpec(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown;credentials?:unknown;accountId?:unknown}){
    requireIdle(context);
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===input?.caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    if(item.needsReview)throw new Error('Review this test before verifying its code.');
    const key=generationKey(scope,item.id),draft=state.specs[scope]?.[item.id]?.draft;
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is being generated. Stop it first.');
    // A generation holds the twin the attempts need.
    if(generating(scope))throw conflict('Code is being generated in this stage. Wait or stop it first.');
    if(!draft)throw Object.assign(new Error('Generate code for this test first.'),{statusCode:404});
    if(typeof input.hash!=='string'||draft.hash!==input.hash)throw conflict('The code changed. Reload it and verify again.');
    if(draft.caseHash!==caseHash(item))throw conflict('The test changed after this code was saved. Generate it again.');
    // The attempts sign in as a person's run does: the entered account, the chosen twin account, else the twin's first.
    const account=Object.fromEntries((['credentials','accountId'] as const).filter(name=>input[name]!==undefined).map((name):[string,unknown]=>[name,input[name]]));
    // Every attempt runs with the config and on the twin the verification starts with, so another twin of the stage that
    // becomes ready meanwhile never takes over some of its attempts.
    const config=normalizedConfig(state.configs[scope]||defaults,context),target={config,environmentId:config.targetUrl&&resolveEnvironment(config.targetUrl)?.id||null};
    // The verification holds that twin from its start to its end: it takes it here, and each attempt's lease passes to the
    // next, so nothing else, such as a health check, takes it while the verification records its start or an attempt, or
    // waits for the stage. A twin in use refuses the verification.
    const take=()=>usage.acquire(context,{environmentId:target.environmentId,operation:'verify journey code'});
    // A run of the stage that just finished may still be releasing its twin; the verification takes it as that run lets go.
    const finishing=state.runs.filter(run=>run.scope===scope&&jobs.has(run.id)).map(run=>jobs.get(run.id)!.promise);
    let held:(()=>void)|null=null;
    try{held=take();}catch(error){if(!finishing.length)throw error;}
    const letGo=()=>{const release=held;held=null;release?.();};
    const entry:VerificationEntry={id:randomUUID(),scope,caseId:item.id,hash:draft.hash,caseHash:draft.caseHash,checkVersion:CHECK_VERSION,cancelled:false,done:false,run:null};
    verifications.set(key,entry);
    // How the verification stands stays with the draft it verifies, while that is still the case's draft: from its start,
    // after every attempt and at its end, stopped or not, so neither a restart nor a history that no longer holds its
    // attempts brings back an older verification's verdict. Between attempts it reads as a restart would end it.
    const record=async(live:VerificationEntry|null)=>{
      const current=state.specs[scope]?.[item.id]?.draft;
      if(current?.hash!==entry.hash||current.caseHash!==entry.caseHash)return;
      current.verification={id:entry.id,checkVersion:entry.checkVersion,...verificationOf(item.id,entry.id,live),runIds:attemptsOf(entry.id).map(run=>run.id)};
      await persist();
    };
    const promise=(async()=>{
      try{
        if(!held){await Promise.allSettled(finishing);held=take();}
        await record(null);
        for(let attempt=1;attempt<=4&&!entry.cancelled&&!closed;attempt++){
          // A person's test save or draft may hold the stage as an attempt ends; the next attempt waits for it.
          while(busy.has(scope)&&!entry.cancelled&&!closed)await whenFree(scope);
          if(entry.cancelled||closed)break;
          const control=attempt===4;
          // start takes the twin before it first awaits, so nothing comes between letting go and taking it again.
          letGo();
          const {run}=await start(context,'run',{caseIds:[item.id],concurrency:1,...account},{manual:true,verification:{id:entry.id,hash:draft.hash,caseHash:draft.caseHash,checkVersion:entry.checkVersion,attempt,control},target,keepLease:release=>{held=release;}});
          entry.run=run.id;
          const job=jobs.get(run.id);
          if(job&&(entry.cancelled||closed)){job.cancelled=true;job.cancel();}
          await job?.promise;
          entry.run=null;
          await record(null).catch(()=>{/* Storage is full: its end is recorded below if it can be. */});
          const result=state.runs.find(value=>value.id===run.id)?.results?.find(value=>value.caseId===item.id);
          if(!control&&result?.status!=='passed')break;
        }
      }catch(error){if(!entry.cancelled&&!closed)entry.error=browserError(error);}
      finally{
        entry.run=null;
        await record(entry).catch(()=>{/* Storage is full: the view derives it from the runs while they last. */});
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
  // Generates a reviewed case's spec with Playwright's generator agent against the stage's ready twin; the code is a
  // draft until a person approves it after a passing run. Only this request starts it: never a view, a restart or a gate.
  async function generateSpec(context:BrowserStageContext,caseId:unknown){
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    if(item.needsReview)throw new Error('Review this test before generating its code.');
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is already being generated.');
    // The generator would hold the twin a verification's next attempt needs.
    if(verifying(scope))throw conflict('Code is being verified in this stage. Wait or stop it first.');
    const [snapshot]=validateBrowserCases([item],{draft:false});
    if(!snapshot.steps.length)throw new Error('Add journey steps before generating code.');
    const configuration=modelSettings.configuration();
    if(!configuration.modelConfigured||!isOpenRouterEndpoint(configuration.baseUrl))throw new Error('Add your OpenRouter API key in Settings first.');
    const config=normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
    const environment=resolveEnvironment(config.targetUrl);
    if(environment?.status!=='ready'||(environment.stageId&&environment.stageId!==context.stageId))throw conflict('Set the application URL to this stage’s ready twin first.');
    if(state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
    // The generator drives the twin as a journey does, so it holds the environment like a run.
    const release=usage.acquire(context,{environmentId:environment.id,operation:'generate journey code'});
    const entry:Generation={scope,status:'running',step:'preparing',cancelled:false,cancel(){entry.cancelled=true;}};
    generations.set(key,entry);
    let credentials:RunCredentials|undefined;
    try{
      if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');
      // The twin's first test account, as a run uses by default; its password reaches only the harness environment.
      const accounts=environment.accounts||[];
      if(accounts.length){
        const account=await twinAccount(environment,accounts[0].id);
        credentials=account?validateRunCredentials({username:account.username,password:account.password}):undefined;
        if(!credentials)throw new Error('The environment test account is unavailable. Recreate the environment.');
      }
      if(closed||entry.cancelled)throw conflict('Code generation cancelled.');
    }catch(error){generations.delete(key);release();throw error;}
    const origins=[new URL(config.targetUrl).origin,...applications(environment).map(app=>originOf(app.url)!),...config.externalOrigins];
    const promise=(async()=>{
      let workspace:Awaited<ReturnType<typeof privateWorkspace>>|null=null;
      // The generation stays running until the twin is released, so a verification started next can hold it.
      let failure:unknown=null;
      try{
        workspace=await privateWorkspace(generationRoot);
        // The seed signs in first with the runtime that runs journeys, on the stage's sign-in page when one is set.
        const job=generateJourneySpec({...generation,workspace:workspace.path,item:snapshot,targetUrl:config.targetUrl,allowedOrigins:[...new Set(origins)],timeoutSeconds:config.journeyTimeoutSeconds,credentials,...(config.signInUrl?{signInUrl:config.signInUrl}:{}),playwright,apiKey:configuration.apiKey,model:configuration.model,onStep:(step:string)=>{if(!entry.cancelled)entry.step=step;}});
        entry.cancel=()=>{entry.cancelled=true;entry.step='cancelling';job.cancel();};
        if(entry.cancelled)job.cancel();
        const {code,provenance}=await job.promise;
        if(entry.cancelled)throw new Error(CANCELLED);
        entry.step='saving';
        // Generated code is a draft beside the approved code, which it never replaces by itself.
        await storeSpec(scope,item.id,({approved})=>({approved,draft:drafted(snapshot,code,{provenance})}));
      }catch(error){
        if(!entry.cancelled)failure=error;
        if((error as WorkerError|undefined)?.cleanupIncomplete)await onEnvironmentUncertain(environment.id,browserError(error)).catch(()=>{});
      }finally{
        await workspace?.remove();
        release();
        // A saved or cancelled generation leaves no state; a failed one says why until the next attempt.
        if(!failure)generations.delete(key);
        else{const rejected=(failure as {rejected?:unknown}).rejected;Object.assign(entry,{status:'failed',error:browserError(failure),...(typeof rejected==='string'?{rejected}:{})});delete entry.step;}
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
  function requireIdle(context:BrowserStageContext,{duringRun=false,verification=false}={}){if(closed)throw conflict('The controller is shutting down.');usage.assertAvailable(context);if(modelSaving)throw conflict('Model settings are being saved. Please wait.');const scope=scopeId(context);if(busy.has(scope)||state.runs.some(r=>r.scope===scope&&active(r)&&!(duringRun&&r.mode==='run'))||!duringRun&&!verification&&verifying(scope))throw conflict('A browser operation is already in progress for this stage.');}
  async function viewModel(){return {capabilities:{...modelSettings.view(),...await runtime!.capabilities()}};}
  // Discovery and code generation need the browser agent's runtime and model; runs need only Playwright's Chromium.
  async function capabilities(){
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
      assertCurrent();
      const item=await draftBrowserCase({configuration,description:normalized,sourceContext,signal});
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
  const report=(run:BrowserRun)=>({run:publicRun(run),results:run.results||[],progress:run.progress||{cases:[]},...(run.discovery?{discovery:run.discovery}:{})});
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
    let credentials=validateRunCredentials(input.credentials);
    const accountId=input.accountId;
    if(accountId!==undefined&&(credentials||(accountId!==null&&typeof accountId!=='string')))throw new Error('Choose one test account.');
    // Checked for a run, the only mode that uses it: set exactly when the mode is run.
    const concurrency=mode==='run'?runConcurrency(input.concurrency??2):undefined;
    requireIdle(context,{verification:Boolean(options.verification)});const scope=scopeId(context);busy.add(scope);
    let release:(()=>void)|undefined,handedOff=false;
    let replaceIds:string[]=[];
    try{
      if(mode==='discover'&&input.replaceCaseIds!==undefined){
        const current=state.cases[scope]||[];
        if(!Array.isArray(input.replaceCaseIds)||input.replaceCaseIds.length>60||new Set(input.replaceCaseIds).size!==input.replaceCaseIds.length||input.replaceCaseIds.some(id=>!current.some(item=>item.id===id)))throw new Error('Choose existing tests to replace.');
        if(!Array.isArray(input.baseCases)||!isDeepStrictEqual(validateBrowserCases(input.baseCases,{draft:true}),validateBrowserCases(current,{draft:true})))throw conflict('Tests changed. Reopen Generate and try again.');
        replaceIds=input.replaceCaseIds;
      }
      const config=options.target?.config??normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
      const environment=resolveEnvironment(config.targetUrl);
      if(options.target&&((environment?.id??null)!==options.target.environmentId||environment&&environment.status!=='ready'))throw conflict(TWIN_CHANGED);
      if(environment&&environment.status!=='ready')throw conflict('The selected application environment is not ready. Choose an available application URL.');
      if(environment&&state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
      release=usage.acquire(context,{environmentId:environment?.id,operation:`browser ${mode}`});
      // A journey runs its Playwright code, which needs no model; discovery needs the browser agent.
      if(mode==='run'){if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');}
      else{const capabilities=await runtime!.capabilities();if(!capabilities.runtimeInstalled)throw new Error('Install the local Browser Use runtime first.');if(capabilities.browserInstalled===false)throw new Error('Install Chromium for the local browser runtime.');if(!capabilities.modelConfigured)throw new Error(capabilities.modelError||'Configure a model API key to use the browser agent.');}
      const accounts=environment?.accounts||[];let accountEndpoints:readonly unknown[]=[];
      if(typeof accountId==='string'&&!accounts.some(account=>account.id===accountId))throw new Error('Choose a test account of this environment.');
      if(!credentials&&accountId!==null&&accounts.length){
        // The password is read from the twin's private state here and never reaches a view.
        // Accounts come from the environment, and accountId is a string or undefined by now.
        const account=await twinAccount(environment!,(accountId as string|undefined)??accounts[0].id);
        credentials=account?validateRunCredentials({username:account.username,password:account.password}):undefined;
        if(!account||!credentials)throw new Error('The environment test account is unavailable. Recreate the environment.');
        // The twin says where its sign-in posts, so read-only discovery can let exactly that request through.
        accountEndpoints=account.authEndpoints||[];
      }
      let cases:BrowserCase[]=[];
      if(mode==='run'){
        const available=state.cases[scope]||[],ids=input.caseIds??available.filter(c=>c.selected&&!c.needsReview).map(c=>c.id);
        if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length)throw new Error('Choose 1–30 distinct reviewed cases.');
        // A verification attempt runs its one reviewed case, selected or not.
        cases=ids.map(id=>{const item=available.find(c=>c.id===id);if(!item||item.needsReview||!item.selected&&!options.verification)throw new Error('Review and select each case before running.');return item;});
        cases=validateBrowserCases(cases,{draft:false});
      }
      // What each journey runs, kept in memory for this run; a journey without code is settled without a browser.
      const codes=Object.fromEntries(cases.map((item):[string,RunnableCode]=>[item.id,runnableCode(scope,item,options)]));
      const coded=cases.filter(item=>codes[item.id].code);
      const sourceContext=mode==='discover'?await browserDiscoveryContext({repoPath:context.scan.repo.path,scope:config.scope,requirements:config.requirements}):'';
      if(closed)throw conflict('The controller is shutting down.');
      if(options.isCurrent&&!options.isCurrent())throw conflict('The active source changed. Open this source and discover cases to continue.');
      const progressCases:CaseProgress[]=mode==='discover'?[{id:'discovery',caseId:'discovery',name:'Explore application',status:'pending',actions:[],actionCount:0}]:cases.map(c=>({id:c.id,caseId:c.id,name:c.name,status:'queued',actions:[],actionCount:0,steps:c.steps.map(({id,title})=>({id,title,status:'pending'}))}));
      const run:BrowserRun={id:randomUUID(),scope,stageId:context.stageId,mode,status:'queued',createdAt:now(),targetUrl:config.targetUrl,sourceRevision:context.scan.repo.sha||null,caseIds:cases.map(c=>c.id),approvedCases:structuredClone(cases),progress:{revision:0,cases:progressCases},...(concurrency!==undefined?{engine:'playwright',concurrency,...journeyConcurrency({cases:coded,concurrency,account:!!credentials}),specHashes:Object.fromEntries(coded.map((item):[string,string]=>[item.id,codes[item.id].hash!]))}:{})};
      if(environment)run.environmentId=environment.id;
      if(options.verification)run.verification=structuredClone(options.verification);
      const preparation=mode==='discover'?(options.preparation||state.preparations[scope]):null;
      if(preparation){Object.assign(preparation,{status:'discovering',targetUrl:config.targetUrl,runId:run.id});delete preparation.error;delete preparation.completedAt;}
      const admittedRuns=()=>[run,...state.runs].filter(kept);
      await persist(()=>({...state,runs:admittedRuns()}),()=>{state.runs=admittedRuns();});
      if(closed){run.status='cancelled';run.completedAt=now();await persist();throw conflict('The controller is shutting down.');}
      const execution=async()=>{
        // Set by the worker's discovery event.
        let discovery=null as Discovery|null,omittedCount=0,progressPersistence:Promise<unknown>=Promise.resolve(),progressError:unknown;
        // Registered before execution starts.
        const entry=jobs.get(run.id)!;
        // Runs may reach reviewed external origins (such as Stripe test checkout); discovery stays on
        // the target environment's apps and receives auth endpoints only with a supplied test account.
        // Scope, requirements, source and the action budget are discovery's; unavailable twin services block runs.
        const origins=[new URL(config.targetUrl).origin,...applications(environment).map(app=>originOf(app.url)!)],unavailable=unavailableServices(environment);
        const workerInput={mode,targetUrl:config.targetUrl,allowedOrigins:[...new Set(mode==='run'?[...origins,...config.externalOrigins]:origins)],timeoutSeconds:config.journeyTimeoutSeconds,...(credentials?{credentials}:{}),
          ...(mode==='discover'?{scope:config.scope,requirements:config.requirements,sourceContext,maxSteps:config.maxSteps,...(credentials&&(config.authEndpoints.length||accountEndpoints.length)?{authEndpoints:authEndpoints([...new Set([...config.authEndpoints,...accountEndpoints])],config.targetUrl)}:{})}:{})};
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
          if(event.type==='frame'){acceptFrame(run,event,progress);touch(run);return;}
          if(event.type==='case'){
            if(mode==='discover')progress.status='running';
            if(Array.isArray(event.actions)){
              // An action that is not an object is an invalid event, which stops the run; an action without a valid type is a browser action.
              progress.actions=event.actions.slice(-150).map((a:unknown):ActionProgress=>{if(!isRecord(a))throw new Error('Browser runtime returned an invalid event.');return {type:typeof a.type==='string'&&/^[a-z][a-z0-9_-]{0,40}$/i.test(a.type)?a.type:'browser',status:includes(['pending','running','passed','failed','cancelled'],a.status)?a.status:'running',...(a.status==='failed'&&typeof a.errorCode==='string'&&actionErrorCodes.has(a.errorCode)?{errorCode:a.errorCode}:{})};});
              progress.actionCount=event.actions.length;
              const last=progress.actions.at(-1);if(last)progress.lastAction={type:last.type,status:last.status};else delete progress.lastAction;
            }
          }else if(event.type==='journey-step')acceptMilestone(progress,event,run.approvedCases.find(item=>item.id===caseId));
          else return;
          touch(run);
        }
        try{
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
                  const result=item.result||(status==='failed'?journeyResult(item.item,{caseId,stopCause:'exception',error:browserError(messageOf(item.error)||String(item.error))},progress.steps):{caseId,status:status as JourneyResult['status'],assertions:[]});
                  run.results=[...(run.results||[]).filter(previous=>previous.caseId!==caseId),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
                  // An unreported milestone is unconfirmed, never a blocked prerequisite.
                  settleSteps(progress,status);
                  // Completed journeys survive a later worker/controller interruption.
                  progressPersistence=progressPersistence.then(()=>persist()).catch(error=>{progressError||=error;entry.cancel();});
                }
                touch(run);
              },
              launch(item){
                let facts:unknown=null;
                assertCurrent();
                const steps=()=>run.progress.cases.find(progress=>progress.id===item.id)!.steps;
                const onEvent=(event:WorkerEvent)=>{
                  if(event.type==='result'){
                    if(facts)throw new Error('Browser runtime returned duplicate results.');
                    facts=event.result;
                  }else if(event.type==='discovery')throw new Error('Browser runtime returned unexpected discovery.');
                  else progressEvent(event,item.id);
                };
                // A missing service may not be needed: the code runs, and only a journey that does not pass is
                // blocked on it, since nothing tells whether the missing service caused its failure.
                const judged=(result:JourneyResult):JourneyResult=>unavailable.length&&result.status!=='passed'?{...result,status:'blocked',
                  blockers:[...unavailable.map(({title,missing}):Blocker=>({kind:'integration',evidence:`${title} is unavailable${missing.length?`: missing ${missing.join(', ')}`:''}.`})),...(result.blockers||[])].slice(0,10),
                  error:`Blocked: ${unavailable.map(({title})=>title).join(', ')} unavailable.${result.error?` ${result.error}`:''}`}:result;
                // Journeys without code were settled before scheduling.
                const {code,hash,checkVersion}=codes[item.id] as {code:string;hash:string;checkVersion:number};
                // A control run blocks every state-changing request, so a reviewed check of a journey that keeps something fails.
                // The account signs in on the sign-in page when the application URL shows no sign-in form.
                const job=playwright.start({...workerInput,case:item,spec:{code,hash},checkVersion,...(config.signInUrl?{signInUrl:config.signInUrl}:{}),...(videoDir?{videoDir}:{}),...(run.verification?.control?{blockWrites:true}:{})},onEvent);
                return {cancel:()=>job.cancel(),promise:job.promise.then(()=>{
                  assertCurrent();if(!facts)throw new Error('Browser runtime did not return results.');
                  return judged(journeyResult(item,facts,steps()));
                },(error:WorkerError|undefined)=>{
                  // The kill timer is the journey's deadline too; facts the worker reported before it still count.
                  if(!error?.timedOut||error.cleanupIncomplete)throw error;
                  assertCurrent();
                  return judged(journeyResult(item,facts||{caseId:item.id,stopCause:'deadline'},steps()));
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
            if(errors.length)run.error=browserError(messageOf(errors[0].error)||String(errors[0].error));
            // Every journey has a result row by now.
            run.status=runStatus(run.results!);
          }else{
            const job=runtime!.start(workerInput,event=>{
              if(event.type==='discovery'){
                if(discovery)throw new Error('Browser runtime returned unexpected discovery.');
                // A journey the controller cannot accept is named in the summary; the valid ones are kept.
                const {cases:drafts,omitted}=discoveredBrowserCases(event.cases,sourceContext);
                const note=safeText(omitted.map(item=>`Omitted “${item.name}”: ${item.reason}`).join('\n'),2000);
                discovery={cases:drafts,summary:[safeText(event.summary,note?3999-note.length:4000),note].filter(Boolean).join('\n'),authenticated:!!credentials&&event.authenticated===true};omittedCount=omitted.length;
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
            await persist(()=>({...state,cases:{...state.cases,[scope]:nextCases},specs:{...state.specs,[scope]:keptSpecs(scope,nextCases)},analyses:{...state.analyses,[scope]:analysis}}),()=>{state.specs[scope]=keptSpecs(scope,nextCases);state.cases[scope]=nextCases;state.analyses[scope]=analysis;});
            run.discovery=discovery;run.status='completed';run.progress.cases[0].status='completed';touch(run);
          }
        }catch(error){
          run.status=entry?.cancelled?'cancelled':'failed';run.error=browserError(messageOf(error)||String(error));
          for(const item of run.progress.cases)if(['pending','queued','running','skipping','cancelling'].includes(item.status)){item.status=run.status;settleSteps(item,run.status);}
          touch(run);
          if((error as WorkerError|undefined)?.cleanupIncomplete===true&&run.environmentId){
            run.status='failed';run.environmentUseUncertain=true;
            try{await persist();}finally{await onEnvironmentUncertain(run.environmentId,run.error);}
          }
        }finally{
          run.completedAt=now();
          if(preparation?.runId===run.id){
            const empty=run.status==='completed'&&!(state.cases[scope]||[]).length;
            Object.assign(preparation,{status:empty?'needs_setup':run.status==='completed'?'completed':'failed',completedAt:run.completedAt,...(empty?{error:'No integration cases were discovered. Set a scope or add a case.'}:run.error?{error:run.error}:{})});
          }
          try{await pruneVideos();}catch{}
          try{await persist();}finally{jobs.delete(run.id);if(options.keepLease)options.keepLease(release!);else release!();resumePreparations();}
        }
      };
      const entry:RunJob={cancelled:false,cancel:()=>{},promise:null,skips:new Set()};jobs.set(run.id,entry);entry.promise=Promise.resolve().then(execution);entry.promise.catch(()=>{});
      handedOff=true;
      return {run:publicRun(run)};
    }finally{free(scope);if(!handedOff)release?.();}
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
  function summary(context:{key:string;stageId:string}){
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
  function retarget(scope:string,context:BrowserStageContext,environment:TargetEnvironment){
    const config=normalizedConfig(state.configs[scope]||defaults,context);
    const previousTarget=state.configTargets[scope];
    if(config.targetUrl&&previousTarget?.url!==config.targetUrl)return config;
    // While a twin has no single application URL, the automatic target is unset, and the sign-in page's path, query and
    // hash wait beside it for the next twin, so a person's value is not dropped silently.
    const path=config.signInUrl?signInPath(config.signInUrl):previousTarget?.signInPath;
    const url=applicationUrl(environment,context.scan);
    if(!url){
      if(previousTarget){state.configs[scope]={...config,targetUrl:'',signInUrl:''};state.configTargets[scope]={environmentId:environment.id,url:'',...(path?{signInPath:path}:{})};}
      return null;
    }
    config.targetUrl=validateBrowserTarget(url,context);
    if(path&&(!config.signInUrl||originOf(config.signInUrl)!==originOf(config.targetUrl)))config.signInUrl=movedSignInPage(path,config.targetUrl);
    state.configs[scope]=config;state.configTargets[scope]={environmentId:environment.id,url:config.targetUrl};
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
    async view(context:BrowserStageContext){const scope=scopeId(context);return {config:structuredClone({...defaults,...state.configs[scope]}),cases:structuredClone(state.cases[scope]||[]),specs:specView(scope),runs:state.runs.filter(r=>r.scope===scope).slice(0,30).map(publicRun),preparation:structuredClone(state.preparations[scope]||null),analysis:structuredClone(state.analyses[scope]||null),accounts:targetAccounts(state.configs[scope]?.targetUrl),capabilities:await capabilities()};},
    saveModel(context:BrowserStageContext,input:unknown){return admit(()=>{requireIdle(context);return updateModel(()=>modelSettings.save(input));});},
    async saveConfig(context:BrowserStageContext,config:unknown){
      requireIdle(context);const normalized=normalizedConfig(config,context),scope=scopeId(context);state.configs[scope]=normalized;if(state.configTargets[scope]?.url!==normalized.targetUrl)delete state.configTargets[scope];
      // A saved target settles the setup an automatic preparation asked for; Generate stays the person's to start.
      if(normalized.targetUrl&&state.preparations[scope]?.status==='needs_setup')delete state.preparations[scope];
      await persist();return {config:normalized};
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
        await persist(()=>({...state,cases:{...state.cases,[scope]:normalized},specs:{...state.specs,[scope]:keptSpecs(scope,normalized)}}),()=>{state.specs[scope]=keptSpecs(scope,normalized);state.cases[scope]=normalized;});
        // A deleted case's code generation stops with it.
        for(const [key,entry] of generations)if(entry.scope===scope&&!normalized.some(item=>generationKey(scope,item.id)===key)){if(entry.status==='running')entry.cancel();else generations.delete(key);}
        // So does its verification.
        for(const entry of verifications.values())if(entry.scope===scope&&!entry.done&&!normalized.some(item=>item.id===entry.caseId))cancelVerification(context,entry.caseId);
        return {cases:structuredClone(normalized)};
      }finally{free(scope);release();}
    });},
    // Saved code replaces the case's draft; the approved code stays until a person approves another draft.
    saveSpec:(context:BrowserStageContext,input:{caseId?:unknown;code?:unknown})=>writeSpec(context,input?.caseId,(item,{approved})=>({approved,draft:drafted(item,validateJourneySpec(input.code,item))})),
    // Approval takes exactly the draft a person reviewed, for the case's current contract, once its latest
    // verification passed three times and its control run was caught. The draft then becomes the approved code.
    approveSpec:(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown})=>writeSpec(context,input?.caseId,(item,{draft})=>{
      if(!draft)throw Object.assign(new Error('Generate code for this test first.'),{statusCode:404});
      if(item.needsReview)throw new Error('Review this test before approving its code.');
      if(typeof input.hash!=='string'||draft.hash!==input.hash)throw conflict('The code changed. Reload it and approve again.');
      if(draft.caseHash!==caseHash(item))throw conflict('The test changed after this code was saved. Generate it again.');
      const verification=verificationView(scopeId(context),item.id,draft);
      if(verification?.status!=='passed')throw conflict('Verify this code first: it needs three passing runs and a caught control run.');
      // The evidence is the attempts of the verification the view judged, never an older one kept with the draft.
      const {verification:ended,...code}=draft,judged=latestVerification(scopeId(context),item.id,draft);
      const approvedRunIds=judged&&judged!==ended?.id?attemptsOf(judged).map(run=>run.id):ended!.runIds;
      return {approved:{...code,approvedAt:now(),approvedRunIds,checkVersion:CHECK_VERSION},draft:null};
    }),
    // Discarding removes only the draft a person saw; the approved code stays.
    discardSpec:(context:BrowserStageContext,input:{caseId?:unknown;hash?:unknown})=>writeSpec(context,input?.caseId,(item,{approved,draft})=>{
      if(!draft)throw Object.assign(new Error('This test has no draft code.'),{statusCode:404});
      if(typeof input.hash!=='string'||draft.hash!==input.hash)throw conflict('The code changed. Reload it and discard again.');
      return {approved,draft:null};
    }),
    // A person takes the stale approved code as the draft for the edited journey, to verify and approve again, when its
    // actions still fit the journey's milestones. The draft keeps the approved code's provenance.
    reuseSpec:(context:BrowserStageContext,input:{caseId?:unknown})=>writeSpec(context,input?.caseId,(item,{approved,draft})=>{
      if(!approved)throw Object.assign(new Error('This test has no approved code to reuse.'),{statusCode:404});
      if(approved.caseHash===caseHash(item))throw conflict('The approved code is current.');
      if(draft&&draft.caseHash===caseHash(item))throw conflict('Discard the draft first.');
      let code:string;
      try{code=validateJourneySpec(approved.code,item);}catch(error){throw new Error(`Generate code for this test again: ${(error as Error).message}`);}
      return {approved,draft:drafted(item,code,approved.provenance?{provenance:structuredClone(approved.provenance)}:{})};
    }),
    // The code itself, for a person to review before approval. It is stage data and never holds the account.
    async specCode(context:BrowserStageContext,input:{caseId?:unknown}){
      const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===input?.caseId);
      if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
      const {approved,draft}=state.specs[scope]?.[item.id]||{};
      return {...(draft?{draft:{hash:draft.hash,code:draft.code}}:{}),...(approved?{approved:{hash:approved.hash,code:approved.code}}:{})};
    },
    verifySpec:(context:BrowserStageContext,input:Parameters<typeof verifySpec>[1])=>admit(()=>verifySpec(context,input)),
    cancelSpecVerification:async(context:BrowserStageContext,input:{caseId?:unknown})=>cancelVerification(context,input?.caseId),
    generateSpec:(context:BrowserStageContext,input:{caseId?:unknown})=>admit(()=>generateSpec(context,input?.caseId)),
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
    isActive(context:{key:string;stageId:string}){const scope=scopeId(context);return busy.has(scope)||generating(scope)||verifying(scope)||state.runs.some(r=>r.scope===scope&&active(r));},
    close(){
      if(closing)return closing;closed=true;
      const cancel=()=>{for(const entry of verifications.values())entry.cancelled=true;for(const entry of jobs.values()){entry.cancelled=true;entry.cancel();}for(const controller of inputJobs.keys())controller.abort();for(const entry of generations.values())if(entry.status==='running')entry.cancel();};cancel();
      closing=(async()=>{await Promise.allSettled([...admissions]);cancel();await Promise.allSettled([...jobs.values()].map(job=>job.promise));await Promise.allSettled([...generationJobs,...verificationJobs]);await saves.idle();})();return closing;
    },
  };
}
