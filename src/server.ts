import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile, mkdir, rename, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository, createPreviewPlan, DISCOVERY_VERSION } from './scanner.ts';
import { getProviderStatus, parseGitHubRemote } from './providers.ts';
import { failureText, redact } from './redaction.ts';
import { gitReadOnly } from './process.ts';
import { defaultPipeline, normalizedPipeline, applyPipelineAction } from './pipeline.ts';
import { getGitHubSession, listGitHubRepositories, listGitHubBranches, prepareGitHubSource, ensureGitHubHistory, updateGitHubSource } from './github-source.ts';
import { readGitHubActions, readServiceConfig, type ConfigFile } from './service-config.ts';
import { withDeliveryGraph } from './delivery.ts';
import { readGitHistory } from './git-history.ts';
import { createGitHubAuthManager } from './github-auth.ts';
import { createGitHubRunsReader } from './github-runs.ts';
import { createGitHubDeploymentsReader } from './github-deployments.ts';
import { createEnvironmentManager } from './environments/manager.ts';
import { createBrowserManager, type BrowserManagerOptions } from './browser/manager.ts';
import { sendVideo } from './browser/video-file.ts';
import {holdsResources, createEnvironmentUsage } from './environments/usage.ts';
import { createStageRemovalManager } from './environments/stage-removal.ts';
import { acquireControllerOwnership } from './controller-ownership.ts';
import { environmentInputs, fromAppSettings } from './environments/runtime.ts';
import { createTwinInputs, services as twinServices } from './twin/index.ts';
import { missingInputs } from './twin/inputs.ts';
import { createGateManager, type SourceHead } from './gate/manager.ts';
import { createGateSteps, createReadiness } from './gate/steps.ts';
import { assertCheckoutAt } from './gate/checkout.ts';
import { readBranchHead, postCommitStatus } from './gate/github.ts';
import { createRepairManager, type Repair } from './repair/manager.ts';
import { createRepairPullRequests, getGitHubFailure, rerunFailedJobs } from './repair/github.ts';
import { createRepairAgent, type CI, type ModelFactory, type RepairAgentGitHub } from './repair/agent.ts';
import { createRepairMerge, type MERGE, type MergeGitHub } from './repair/merge.ts';
import { createRepairBoxes, type RepairBoxes } from './repair/box.ts';
import { createRepairHost, type RepairHost } from './repair/clone.ts';
import { autopilotMode, autopilotView as autopilotOf } from './repair/view.ts';
import { createBrowserModelSettings } from './browser/model.ts';
import { isOpenRouterEndpoint } from './browser/openrouter-models.ts';
import type { Scan, ScanRepo } from './scanner.ts';
import type { EnvironmentContext, EnvironmentPlan, ManagedRuntime } from './environments/manager.ts';
import type { Pipeline, Stage } from './pipeline.ts';
import type { GitHubSession, PreparedGitHubSource } from './github-source.ts';
import type { ProviderStatus } from './providers.ts';
import type { GitHubAuthManager } from './github-auth.ts';
import type { GitHubRunsReader } from './github-runs.ts';
import type { GitHubDeploymentsReader } from './github-deployments.ts';

/** A connected GitHub branch: its managed clone, and the account that connected it. A moved clone keeps the commit
 * its rescan read, which is null when Git could not read one. */
export interface GitHubSource extends Omit<PreparedGitHubSource, 'sha'> { sha: string | null; connectedAccount: string; savedAt: string }
/** The account the user connected; a null record is a deliberate Disconnect. */
export interface GitHubConnectionRecord { login: string; connectedAt: string }
/** state.json (schema 1). Saved pipelines are normalized again on every read. */
export interface ControllerState {
  scan: Scan | null; providers: ProviderStatus[]; pipelines: Record<string, Pipeline>;
  source?: GitHubSource | null; githubConnection?: GitHubConnectionRecord | null;
  /** Retired repair reports and HTTP checks: removed on load, so the next save omits them. */
  runs?: unknown; checks?: unknown;
}
export interface ServerOptions {
  port?: number; repo?: string; dataDir?: string; publicDir?: string;
  /**
   * Tests supply the sign-in manager, runs and deployments readers, branch head, commit status, failed-run reader, rerun
   * and the managed source copy's move to a commit; no CLI is spawned for them.
   */
  github?: { auth?: GitHubAuthManager; runs?: GitHubRunsReader; deployments?: GitHubDeploymentsReader; head?: typeof readBranchHead; status?: typeof postCommitStatus; failure?: typeof getGitHubFailure; rerun?: typeof rerunFailedJobs; update?: typeof updateGitHubSource };
  /** Tests supply a shorter branch head poll. */
  gate?: { pollInterval?: number };
  /** Tests supply provisioning's docker and git email; no container runs for them. */
  twin?: Omit<Parameters<typeof createTwinInputs>[0], 'dataDir'>;
  /** Tests supply the twins' runtime, and the browser agent's and journeys' Playwright runtimes; no container or browser runs for them. */
  environments?: { runtime?: ManagedRuntime };
  browser?: Pick<BrowserManagerOptions, 'runtime' | 'playwright'>;
  /**
   * Tests supply the repair box, host copy, model, pull request writes and merge calls, and shorter CI and merge waits; no
   * container, model, push or merge runs for them.
   */
  repair?: { boxes?: RepairBoxes; host?: RepairHost; model?: ModelFactory; pullRequests?: RepairAgentGitHub['pullRequests']; merges?: Omit<MergeGitHub, 'connection' | 'head'>; ci?: Partial<typeof CI>; timing?: Partial<typeof MERGE> };
}
export interface Controller { url: string; server: ReturnType<typeof createServer>; close(): Promise<void> }
type HttpError = Error & { statusCode?: number };
/** A request's JSON object or query parameters: every field is checked where it is used. */
type RequestInput = { readonly [key: string]: unknown };
type Transaction<R> = { state?: ControllerState; commit?(): void; result?: R };
type SavedStage = Stage & { tests?: unknown };
type ConnectionSource = GitHubSource | { repository: string; branch: string | null; rootDirectory: string };
/** A Sandbox stage's context. A repair gate's names its repair, and its scan is of the pull request checkout. */
type StageContext = EnvironmentContext;
/** A request's text field. Any other value names nothing, which each lookup then rejects as it would an unknown name. */
const text=(value: unknown)=>typeof value==='string'?value:'';

const defaultPublicDir=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const staticFiles: Record<string, [string, string]>={'/':['build/index.html','text/html']};
// Exact style-block hash from the embedded preview's reported CSP violation.
// Its injection source is unverified; this grants no other inline CSS or script access.
const reportedPreviewStyleHash="'sha256-UjmwW5hqkbmZat2z0a4MIudqMdHHunQ57o+t2nldQPQ='";

// Read-only Git queries against a scanned or original checkout; never fetches or writes.
const readGit=(path: string,args: string[])=>gitReadOnly(path,args,{timeout:2000,maxBuffer:4096});

async function configurationLinks(scan: Scan,files: ConfigFile[]): Promise<ConfigFile[]> {
  const repository=parseGitHubRemote(scan.repo.remote);
  if(!repository || !scan.repo.branch)return files;
  try {
    // Link only a branch GitHub has: the origin tracking ref is local evidence of that, without a network call.
    const [{stdout},remote]=await Promise.all([
      readGit(scan.repo.path,['rev-parse','--show-prefix']),
      readGit(scan.repo.path,['rev-parse','--verify','--quiet',`refs/remotes/origin/${scan.repo.branch}`]).then(()=>true,()=>false),
    ]);
    if(!remote)return files.map(file=>({...file,local:true}));
    const prefix=stdout.trim();
    if(prefix && (prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').some(part=>part==='..')))return files;
    return files.map(file=>({...file,editUrl:`https://github.com/${repository}/edit/${encodeURIComponent(scan.repo.branch!)}/${(prefix+file.path).split('/').map(encodeURIComponent).join('/')}`}));
  }catch {return files;}
}

// The original --repo checkout, so a GitHub source can switch back to it by rescanning.
async function localCheckout(repo: string) {
  const path=resolve(repo);
  try {return {path,branch:(await readGit(path,['symbolic-ref','--short','--quiet','HEAD'])).stdout.trim()||null};}
  catch {return {path,branch:null};}
}

// A Sandbox stage's twin services and the inputs each still needs; views never carry values.
// A service that can be provisioned adds its provision inputs and, once provisioned, its expiry, claim link and the
// keys that replace it (from the inputs view `stored`).
function twinServiceView(config: EnvironmentPlan | null | undefined,values: Record<string, Record<string, unknown> | undefined>,stored: Awaited<ReturnType<ReturnType<typeof createTwinInputs>['view']>>=[]) {
  const field=({name,label,secret}: {name: string; label?: string; secret?: boolean})=>({name,label:label??name,secret:Boolean(secret)});
  return Object.entries(config?.services??{}).filter(([id])=>Object.hasOwn(twinServices,id)).map(([id,options])=>{
    const service=twinServices[id],missing=missingInputs(service,values[id]),settings=fromAppSettings(id,options),entry=settings?null:stored.find(item=>item.id===id);
    return {id,title:service.title,fidelity:service.fidelity,...(settings?{source:'settings'}:{}),blocked:missing.length>0,
      missing:settings?[]:(service.inputs??[]).filter(input=>missing.includes(input.name)).map(field),
      ...(entry?.provision?{provision:entry.provision}:{}),
      ...(entry?.provisioned&&!missing.length?{provisioned:entry.provisioned,keys:(service.inputs??[]).filter(input=>!input.optional).map(field)}:{})};
  });
}

async function assetFiles(publicDir: string) {
  const assets: Record<string, [string, string]>={};
  // Serve only generated asset filenames, never arbitrary filesystem paths.
  let built: Dirent[]=[];try{built=await readdir(join(publicDir,'build/assets'),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const file of built) {
    if(!file.isFile()||!/^[a-z0-9_-]+\.(js|css)$/i.test(file.name))continue;
    const path=`build/assets/${file.name}`;
    assets[`/${path}`]=[path,file.name.endsWith('.js')?'text/javascript':'text/css'];
  }
  for(const folder of ['brand','providers','fonts']) {
    const relative=`assets/${folder}`;
    let files: Dirent[]=[];try{files=await readdir(join(publicDir,relative),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const file of files) {
      if(!file.isFile()||!/^[a-z0-9-]+\.(svg|woff2|ttf)$/i.test(file.name))continue;
      const path=`${relative}/${file.name}`;
      assets[`/${path}`]=[path,file.name.endsWith('.svg')?'image/svg+xml':file.name.endsWith('.ttf')?'font/ttf':'font/woff2'];
    }
  }
  return assets;
}

export async function startServer(options: ServerOptions={}): Promise<Controller> {
  const dataDir=resolve(options.dataDir??'.perpetual');
  const release=await acquireControllerOwnership(dataDir),cleanup: (() => unknown)[]=[];
  try {
    const app=await createController({...options,dataDir},dispose=>cleanup.push(dispose));
    let closing;
    return {...app,close(){return closing??=(async()=>{await app.close();await release();})();}};
  }catch(error){
    const results=await Promise.allSettled(cleanup.map(dispose=>Promise.resolve().then(dispose)));
    // Keep ownership if shutdown cannot establish a clean boundary.
    if(results.every(result=>result.status==='fulfilled'))await release();
    throw error;
  }
}

async function createController({port=4317,repo=process.cwd(),dataDir,github={},gate={},twin={},repair={},environments:runtimes={},browser:journeys={},publicDir=defaultPublicDir}: ServerOptions & {dataDir: string},onCleanup: (dispose: () => unknown) => void): Promise<Controller> {
  await mkdir(dataDir,{recursive:true,mode:0o700});
  let publicFiles={...staticFiles,...await assetFiles(publicDir)},assetScans=0,appliedAssetScan=0;
  // A rebuild replaces hashed asset names while the server runs; rescan instead of requiring a restart.
  // Each miss scans after it arrives, and an older scan finishing late never replaces a newer listing.
  const refreshAssets=async()=>{const scan=++assetScans,assets=await assetFiles(publicDir);if(scan>appliedAssetScan){appliedAssetScan=scan;publicFiles={...staticFiles,...assets};}};
  const stateFile=join(dataDir,'state.json');
  let state: ControllerState={scan:null,providers:[],pipelines:{}};
  // The controller's own state file: a JSON null or a schema 1 file without a state object cannot be read; any other file without schema 1 starts afresh.
  try {const saved: unknown=JSON.parse(await readFile(stateFile,'utf8'));if(saved===null)throw new Error('Invalid state.');if(typeof saved==='object'&&'schema' in saved&&saved.schema===1){const stored='state' in saved?saved.state:undefined;if(!stored||typeof stored!=='object')throw new Error('Invalid state.');state=stored as ControllerState;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Cannot load saved state; preserve it and use a different --data directory.');}
  if(!state.pipelines || typeof state.pipelines!=='object' || Array.isArray(state.pipelines))state.pipelines={};
  // Retired repair reports, HTTP checks and their stage drafts; the next save omits them.
  delete state.runs;delete state.checks;
  for(const pipeline of Object.values(state.pipelines))if(Array.isArray(pipeline?.stages))for(const stage of pipeline.stages as SavedStage[])delete stage?.tests;
  const token=randomBytes(32).toString('hex');
  // `github` lets tests supply the sign-in manager, runs reader, branch head and commit status; no CLI is spawned for them.
  const githubAuth=github.auth??createGitHubAuthManager(),githubRuns=github.runs??createGitHubRunsReader(),githubDeployments=github.deployments??createGitHubDeploymentsReader();
  onCleanup(()=>githubAuth.dispose());
  const usage=createEnvironmentUsage();let environments: Awaited<ReturnType<typeof createEnvironmentManager<StageContext>>> | undefined;
  onCleanup(()=>usage.stopAdmissions());
  const browser=await createBrowserManager({dataDir,usage,...journeys,resolveEnvironment:url=>environments?.resolveTarget(url),onEnvironmentUncertain:(id,error)=>environments!.markUsageUncertain(id,error)});
  onCleanup(()=>browser.close());
  // `twin` lets tests supply provisioning's docker and git email; no container runs for them.
  const twinInputs=createTwinInputs({dataDir,...twin});
  const twinsReady=createReadiness();
  environments=await createEnvironmentManager<StageContext>({dataDir,usage,...runtimes,interruptedEnvironmentIds:browser.interruptedEnvironmentIds(),onReady:(context,environment)=>browser.prepareEnvironment(context,environment,{isCurrent:()=>isPreparationSourceCurrent(context)}).finally(()=>twinsReady.done(environment.id))});
  onCleanup(()=>environments.close());
  let saving: Promise<unknown>=Promise.resolve(),tickTask: Promise<void> | null=null,sourceBusy=false,closed=false,closing: Promise<void> | undefined;
  // A fresh checkout must not reset stage definitions for the same repository/root.
  const sourceKey=(source: {repository: string; rootDirectory: string})=>`github:${source.repository.toLowerCase()}:${source.rootDirectory}`;
  // Every caller has a scanned repository, so a key always exists.
  const pipelineKey=(current: ControllerState)=>current.source?.scanPath===current.scan?.repo?.path
    ? sourceKey(current.source!) : current.scan?.repo?.path as string;
  function currentPipeline(current: ControllerState) {
    const repoPath=current.scan?.repo?.path;
    if(!repoPath)throw new Error('Scan a repository first.');
    return normalizedPipeline({... (current.pipelines[pipelineKey(current)] ?? defaultPipeline(repoPath)),repoPath});
  }
  // A repair gate's twin is built from its pull request checkout, never the scanned source, so only its pipeline and stage count.
  function isPreparationSourceCurrent(context: {key: string; stageId: string; repair?: string; scan: {repo: Pick<ScanRepo, 'path'> & Partial<Pick<ScanRepo, 'sha' | 'branch'>>}}) {
    return !closed&&!sourceBusy&&pipelineKey(state)===context.key
      &&(context.repair!==undefined||state.scan?.repo.path===context.scan.repo.path&&state.scan?.repo.sha===context.scan.repo.sha&&state.scan?.repo.branch===context.scan.repo.branch)
      &&currentPipeline(state).stages.some(stage=>stage.id===context.stageId&&stage.kind==='sandbox');
  }
  // Source admission. A request names the source it is for, and a reply never describes another one:
  // the active scan is checked before the work and again after it, a source change holds the source
  // busy until it is saved, and only a Sandbox stage holds environments and tests.
  const conflict=(message: string)=>Object.assign(new Error(message),{statusCode:409});
  const SOURCE_BUSY='A source change is still being saved. Please wait.',SOURCE_CHANGED='The active repository changed. Reload its pipeline.';
  function requireNoPendingSignIn(){if(githubAuth.isPending())throw conflict('Finish or cancel GitHub sign-in first.');}
  function requireSourceIdle() {
    if(sourceBusy)throw conflict(SOURCE_BUSY);
    requireNoPendingSignIn();
  }
  function requireSourceChangeIdle(){
    requireSourceIdle();
    if(browser.hasPendingInput())throw conflict('Finish adding this test before changing the source.');
  }
  /** Holds the source busy while a change to it runs; `guard` says what may not be in progress and runs before the hold. */
  async function withSourceHeld<R>(guard: () => void,work: () => Promise<R>): Promise<R>{guard();sourceBusy=true;try{return await work();}finally{sourceBusy=false;}}
  /** The active scan, which `repoPath` must name; 409 otherwise, with `hint` on what to reload. */
  function activeScan(repoPath: unknown,hint=SOURCE_CHANGED): Scan{const scan=state.scan;if(!scan||repoPath!==scan.repo.path)throw conflict(hint);return scan;}
  /** Runs `work` on the active scan and refuses its result when the scan changed meanwhile. */
  async function withActiveScan<R>(repoPath: unknown,work: (scan: Scan) => Promise<R>,hint=SOURCE_CHANGED): Promise<R>{const scan=activeScan(repoPath,hint);const result=await work(scan);if(state.scan!==scan)throw conflict(hint);return result;}
  /** The Sandbox stage `stageId` names in the active pipeline; a removal keeps its own lookup, since it outlives its stage. */
  function sandboxStage(stageId: unknown){const stage=currentPipeline(state).stages.find(item=>item.id===stageId);if(!stage||stage.kind!=='sandbox')throw new Error('Choose a Sandbox stage.');return stage;}
  /** A stage's context for the environments and browser managers. */
  const stageContext=(scan: Scan,stageId: string,port: number | undefined)=>({key:pipelineKey(state),stageId,scan,controllerOrigin:`http://127.0.0.1:${port}`});
  async function githubConnection(knownSession?: GitHubSession) {
    const session=knownSession ?? await getGitHubSession();
    const detected=parseGitHubRemote(state.scan?.repo?.remote);
    // A local GitHub project already has a source. Reuse its verified CLI
    // session unless this instance has an explicit connection choice. A null
    // record is a deliberate Disconnect, whereas an absent record is legacy.
    const reuseLocalSession=Boolean(detected) && !Object.hasOwn(state,'githubConnection');
    const connected=!githubAuth.isPending() && session.authenticated && (reuseLocalSession || state.githubConnection?.login===session.account.login);
    const source: ConnectionSource | null=state.source ?? (detected ? {
      repository:detected,branch:state.scan!.repo.branch,rootDirectory:'/',
    } : null);
    // Connected only with the session's account, so a connected result always names it.
    return connected ? {...session,connected:true as const,source} : {...session,connected:false as const,source};
  }
  async function requireGitHub(session?: GitHubSession) {
    requireNoPendingSignIn();
    const connection=await githubConnection(session);
    if(!connection.connected)throw new Error(connection.message || 'Connect your GitHub account before selecting a repository.');
    return connection;
  }
  function save<R>(prepare?: (current: ControllerState) => Transaction<R>): Promise<R | undefined> {
    const operation=saving.then(async()=>{
      const transaction=prepare?.(state);
      const content=JSON.stringify({schema:1,state:transaction?.state ?? state},null,2);
      const temp=stateFile+'.tmp';await writeFile(temp,content,{mode:0o600});await rename(temp,stateFile);
      transaction?.commit?.();
      return transaction?.result;
    });
    saving=operation.catch(()=>{});
    return operation;
  }
  // Refresh older discovery snapshots without resetting the user's stages or source.
  if (state.scan && (state.scan.discoveryVersion ?? 0) < DISCOVERY_VERSION) {
    try {
      const scan = await scanRepository(state.scan.repo.path);
      await save(current => ({
        state: { ...current, scan, providers: [] },
        commit() { state.scan = scan; state.providers = []; },
      }));
    } catch (error) {
      process.stderr.write(`Could not refresh repository discovery; retaining saved data: ${redact((error as Error).message)}\n`);
    }
  }
  // Journey gate: each pushed commit of the managed source moves the source copy in place, rebuilds
  // a Sandbox stage's twin and runs its reviewed journeys. Without a Sandbox stage the copy follows the branch head
  // instead. The user's own checkout never moves.
  const gateStop=new AbortController();
  async function moveSource(sha: string) {
    const source=state.source;
    if(!source||source.scanPath!==state.scan!.repo.path)throw new Error('Connect a GitHub repository to test pushed commits.');
    return await withSourceHeld(requireSourceChangeIdle,async()=>{
      // The account is verified through the reader the watcher and gates read GitHub with.
      await requireGitHub(await githubRuns.session());
      await (github.update??updateGitHubSource)({source,dataDir,sha});
      const scan=await scanRepository(source.scanPath),next={...source,sha:scan.repo.sha,savedAt:new Date().toISOString()};
      await save(current=>({state:{...current,scan,source:next,providers:[]},commit(){state.scan=scan;state.source=next;state.providers=[];}}));
    });
  }
  // A repair gate's checkout: a directory under <dataDir>/repairs by its real path, which a repair's merge step owns.
  async function repairSnapshot(snapshot: unknown) {
    const invalid=()=>new Error('The pull request checkout is unavailable.');
    if(typeof snapshot!=='string'||!isAbsolute(snapshot))throw invalid();
    const [root,path]=await Promise.all([realpath(join(dataDir,'repairs')),realpath(snapshot)]).catch(()=>{throw invalid();});
    const inside=relative(root,path);
    if(!inside||inside.startsWith('..')||isAbsolute(inside))throw invalid();
    return path;
  }
  // Only the connected account reads heads, runs and failed logs and reports statuses, as for workflow runs.
  async function connectedAccount(){
    if(state.githubConnection===null||githubAuth.isPending())return null;
    const connection=await githubConnection(await githubRuns.session());
    return connection.connected&&connection.source?.repository?{login:connection.account.login,repository:connection.source.repository}:null;
  }
  // The watcher moves a managed source whose pipeline has no Sandbox stage to its branch head, never during a stage's
  // removal or another source change: it tries again at its next poll.
  async function followHead({key,branch,sha}: SourceHead) {
    if(!state.scan||pipelineKey(state)!==key||(state.scan.repo.branch||null)!==branch||state.scan.repo.sha===sha||currentPipeline(state).stages.some(stage=>stage.kind==='sandbox'))return;
    if(removals.summaries(key).some(item=>item.status==='queued'||item.status==='removing'))throw conflict('A stage is being removed.');
    await moveSource(sha);
  }
  const gates=await createGateManager({dataDir,pollInterval:gate.pollInterval,follow:followHead,
    source(){
      if(!state.scan)return null;
      const managed=state.source?.scanPath===state.scan.repo.path;
      return {key:pipelineKey(state),branch:state.scan.repo.branch||null,sha:state.scan.repo.sha||null,repository:managed?state.source!.repository:null,stages:currentPipeline(state).stages.map(({id,name,kind})=>({id,name,kind}))};
    },
    github:{
      connection:connectedAccount,
      head:input=>(github.head??readBranchHead)(input),
      post:input=>(github.status??postCommitStatus)(input),
    },
    steps:createGateSteps<StageContext>({environments,browser,readiness:twinsReady,signal:gateStop.signal,async checkout({key,branch,stageId,sha,repair,snapshot}): Promise<StageContext>{
      // A repair gate scans its pull request checkout; the source, its scan and the watched head never move.
      if(repair!==undefined){
        requireSourceIdle();
        if(!state.scan||pipelineKey(state)!==key)throw conflict('The active source changed.');
        usage.assertAvailable({key,stageId});
        const scan=await scanRepository(await repairSnapshot(snapshot));
        if(scan.repo.sha!==sha)throw new Error('The pull request checkout is not at its head.');
        return {key,stageId,scan,repair,controllerOrigin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`};
      }
      requireSourceChangeIdle();
      if(!state.scan||pipelineKey(state)!==key||(state.scan.repo.branch||null)!==branch)throw conflict('The active source changed.');
      usage.assertAvailable({key,stageId});
      if(state.scan.repo.sha!==sha)await moveSource(sha);
      return stageContext(state.scan,stageId,(server.address() as AddressInfo).port);
    },
    // A twin copies a local checkout as it is on disk, so the commit status the gate reports holds only for a clean
    // checkout at the gate's commit; a managed copy is reset to it before every gate.
    async checkoutAt({scan}){if(state.source?.scanPath!==scan.repo.path)await assertCheckoutAt(scan.repo.path,String(scan.repo.sha));}}),
  });
  onCleanup(()=>{gateStop.abort();return gates.close();});
  // Build repair: a failed head of the managed source's target branch is triaged without a model, then repaired by the
  // agent step through a pull request. The user's own checkout is never repaired.
  // The agent runs on the App Settings models, read when a repair needs them; the key never enters a repair or its box.
  const repairModels=async()=>{
    const store=await createBrowserModelSettings({dataDir}),model=store.configuration();
    return model.modelConfigured&&isOpenRouterEndpoint(model.baseUrl)?{apiKey:model.apiKey,model:model.model,escalationModel:store.escalationModel()??model.model}:null;
  };
  // Deploy configuration the scan found for the repair's own source, relative to the repository: a change to it is
  // rejected before any push (ADR 0002).
  const deployFiles=({key,rootDirectory}: Pick<Repair,'key'|'rootDirectory'>)=>{
    if(!state.scan||pipelineKey(state)!==key)return [];
    const prefix=rootDirectory.split('/').filter(Boolean).join('/');
    const files=state.scan.nodes.filter(node=>node.kind==='deployment').flatMap(node=>[...node.evidence.map(item=>item.file),node.configFile]);
    return [...new Set(files.filter((file): file is string=>typeof file==='string'&&Boolean(file)))].map(file=>prefix?`${prefix}/${file}`:file);
  };
  const repairBoxes=repair.boxes??createRepairBoxes({dataDir}),repairHost=repair.host??createRepairHost({dataDir});
  // A pull request that passed CI goes through each Sandbox stage's journey gate at its head, over its own checkout, then
  // merges when everything passed and the Build stage's Autopilot mode merges (ADR 0002).
  const repairMerge=createRepairMerge({gates,host:repairHost,timing:repair.timing,
    github:{...(repair.merges??createRepairPullRequests()),connection:connectedAccount,head:input=>(github.head??readBranchHead)(input)}});
  const repairAgent=createRepairAgent({
    models:repairModels,boxes:repairBoxes,host:repairHost,model:repair.model,deployFiles,ci:repair.ci,merge:repairMerge,
    github:{connection:connectedAccount,runs:input=>githubRuns.read(input),failure:input=>(github.failure??getGitHubFailure)(input),pullRequests:repair.pullRequests??createRepairPullRequests()},
  });
  const repairs=await createRepairManager({dataDir,
    source(){
      if(!state.scan)return null;
      const managed=state.source?.scanPath===state.scan.repo.path?state.source:null;
      return {key:pipelineKey(state),branch:state.scan.repo.branch||null,repository:managed?.repository??null,checkoutPath:managed?.checkoutPath??null,rootDirectory:managed?.rootDirectory??null};
    },
    github:{
      connection:connectedAccount,
      head:input=>(github.head??readBranchHead)(input),
      runs:input=>githubRuns.read(input),
      failure:input=>(github.failure??getGitHubFailure)(input),
      rerun:input=>(github.rerun??rerunFailedJobs)(input),
    },
    steps:{
      async unavailable(){return await repairModels()?repairBoxes.available():'Add an OpenRouter API key in Settings.';},
      repair:repairAgent.repair,state:repairAgent.state,close:repairAgent.close,recover:repairAgent.recover,
    },
  });
  onCleanup(()=>repairs.close());
  // Autopilot as the pipeline reads it: the Build stage carries the repairs, and its mode is the pipeline's auto-merge switch.
  const buildStage=()=>state.scan?currentPipeline(state).stages.find(stage=>stage.kind==='build')??null:null;
  const autopilotView=(scan: Scan)=>autopilotOf(repairs.view(),{repoPath:scan.repo.path,stageId:buildStage()?.id??null});
  function autopilotStage(stageId: unknown){const build=buildStage();if(!build||build.id!==stageId)throw new Error('Autopilot is available for Build.');return build;}
  const removals=await createStageRemovalManager({dataDir,usage,environments,browser,removeStage:context=>save(current=>{
    // Deletion belongs to the confirmed source, even after the user changes
    // repositories or closes the browser. A prior final commit is idempotent.
    const existing=current.pipelines[context.key];
    if(!existing||!existing.stages.some(stage=>stage.id===context.stageId))return {result:null};
    if(browser.isActive(context)||environments.summaries(context.key).some(item=>item.stageId===context.stageId&&holdsResources(item)))throw new Error('Stage cleanup is not complete.');
    const pipeline=applyPipelineAction(existing,{action:'remove-stage',stageId:context.stageId});
    const pipelines={...current.pipelines,[context.key]:pipeline};
    return {state:{...current,pipelines},commit(){state.pipelines=pipelines;},result:pipeline};
  })});
  onCleanup(()=>removals.close());
  // A paused recording stream would otherwise hold shutdown open.
  const videoStreams=new Set<ServerResponse>();
  const reply=(res: ServerResponse,status: number,data: unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  async function body(req: IncomingMessage,limit=65536): Promise<RequestInput> {
    const chunks: Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('Request exceeds the allowed size.');chunks.push(chunk);}
    const content=Buffer.concat(chunks).toString('utf8');
    const input: unknown=content?JSON.parse(content):{};
    // A JSON null or scalar has no fields: reject it here instead of failing on its first field.
    if(!input||typeof input!=='object')throw new Error('Send a JSON object.');
    return input as RequestInput;
  }
  const server=createServer(async(req,res)=>{
    const styleNonce=randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}' ${reportedPreviewStyleHash}; style-src-attr 'none'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    const actualPort=(server.address() as AddressInfo | null)?.port;
    const hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
    const origin=req.headers.origin;
    if(!hosts.includes(req.headers.host!) || (origin&&!hosts.some(h=>origin===`http://${h}`)) || req.headers['sec-fetch-site']==='cross-site')return reply(res,403,{error:'This local control room accepts same-origin requests only.'});
    if(req.method==='POST'&&req.headers['x-perpetual-token']!==token)return reply(res,403,{error:'Session expired. Refresh the page before making changes.'});
    if(closed)return reply(res,503,{error:'The controller is shutting down.'});
    try {
      const requestUrl=new URL(req.url!,'http://localhost'),path=requestUrl.pathname;
      if(req.method==='GET'&&!publicFiles[path]&&/^\/(build\/)?assets\//.test(path))await refreshAssets();
      if(req.method==='GET'&&publicFiles[path]) {
        const [file,type]=publicFiles[path];
        let content: Buffer | string;
        try { content=await readFile(join(publicDir,file)); }
        catch(error) {
          const code=(error as NodeJS.ErrnoException).code;
          if(code==='ENOENT'&&path==='/')return reply(res,503,{error:'Build the interface with npm run build.'});
          if(code==='ENOENT'){await refreshAssets();return reply(res,404,{error:'Not found.'});}
          throw error;
        }
        if(type==='text/html')content=content.toString('utf8').replace('__PERPETUAL_STYLE_NONCE__',styleNonce);
        res.setHeader('Content-Type',`${type}; charset=utf-8`);
        return res.end(content);
      }
      if(req.method==='GET'&&path==='/favicon.ico'){res.writeHead(204);return res.end();}
      if(req.method==='GET'&&path==='/api/session')return reply(res,200,{token});
      if(req.method==='GET'&&path==='/api/settings/model')return reply(res,200,await browser.viewModel());
      if(req.method==='GET'&&path==='/api/settings/models')return reply(res,200,await browser.listModels());
      if(req.method==='POST'&&path==='/api/settings/model')return reply(res,200,await browser.saveModelSettings(await body(req,16384)));
      // Only on the user's explicit action: a provision may send its inputs, such as an email, to the vendor.
      if(req.method==='POST'&&path==='/api/twin/inputs/provision'){
        const input=await body(req,16384);
        // The store looks a service up by its name and rejects any other.
        return reply(res,200,{services:await twinInputs.provision(String(input.service),input.inputs)});
      }
      if(path==='/api/twin/inputs') {
        if(req.method==='GET')return reply(res,200,{services:await twinInputs.view()});
        if(req.method!=='PUT')return reply(res,404,{error:'Not found.'});
        if(req.headers['x-perpetual-token']!==token)return reply(res,403,{error:'Session expired. Refresh the page before making changes.'});
        const input=await body(req,16384);
        return reply(res,200,{services:await twinInputs.set(String(input.service),input.inputs)});
      }
      if(req.method==='GET'&&path==='/api/twin/services') {
        requireSourceIdle();
        return reply(res,200,await withActiveScan(requestUrl.searchParams.get('repoPath'),async scan=>{
          const stage=sandboxStage(requestUrl.searchParams.get('stageId'));
          const {plan}=await environments.view(stageContext(scan,stage.id,actualPort));
          // A view never renews a provision; only creating a twin does. It reads the controller's store, whose docker tests supply.
          const services=twinServiceView(plan,await environmentInputs({dataDir,config:plan,refresh:false,store:twinInputs}),await twinInputs.view());
          // generated: an agent wrote the stage's plan (its provenance is in GET /api/environments).
          return {services,generated:'provenance' in plan};
        }));
      }
      if(req.method==='GET'&&path==='/api/state')return reply(res,200,{...state,scan:withDeliveryGraph(state.scan),pipeline:state.scan?currentPipeline(state):null,environments:state.scan?environments.summaries(pipelineKey(state)):[],stageRemovals:state.scan?removals.summaries(pipelineKey(state)):[],browserTests:state.scan?Object.fromEntries(currentPipeline(state).stages.filter(stage=>stage.kind==='sandbox').map(stage=>[stage.id,browser.summary({key:pipelineKey(state),stageId:stage.id})])):{},autopilot:state.scan?autopilotView(state.scan):null,defaultRepo:repo,capabilities:{modelConfigured:!!((process.env.PERPETUAL_MODEL_API_KEY&&process.env.PERPETUAL_MODEL)||process.env.OPENROUTER_API_KEY),browserAgent:true,localBrowser:true,cloudProvisioning:false,businessDiscovery:true}});
      if(path==='/api/stages/remove'||path==='/api/stages/removal'){
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req);
        activeScan(input.repoPath);
        const context={key:pipelineKey(state),stageId:text(input.stageId)};
        const stage=currentPipeline(state).stages.find(item=>item.id===input.stageId),previous=removals.view(context);
        if(stage?stage.kind!=='sandbox':!previous.removal)throw new Error('Choose a Sandbox stage.');
        if(req.method==='GET'&&path==='/api/stages/removal')return reply(res,200,previous);
        if(req.method==='POST'&&path==='/api/stages/remove')return reply(res,202,await removals.start(context));
        return reply(res,404,{error:'Stage operation not found.'});
      }
      if(path==='/api/gate'||path.startsWith('/api/gate/')) {
        const scan=state.scan;
        if(!scan)throw new Error('Scan a repository first.');
        // The view names the active source, so a page on an older commit reloads it.
        if(req.method==='GET'&&path==='/api/gate')return reply(res,200,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...gates.view()});
        if(req.method!=='POST')return reply(res,404,{error:'Gate operation not found.'});
        const input=await body(req);
        if(input.repoPath!==scan.repo.path)throw conflict('The active source changed. Reload the pipeline.');
        if(path==='/api/gate/run')return reply(res,202,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...await gates.run({stageId:input.stageId})});
        if(path==='/api/gate/release') {
          const connection=state.githubConnection===null?null:await githubConnection(await githubRuns.session());
          if(!connection?.connected)throw new Error('Connect GitHub to release.');
          return reply(res,200,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...await gates.release({stageId:input.stageId,sha:input.sha,login:connection.account.login})});
        }
        return reply(res,404,{error:'Gate operation not found.'});
      }
      if(path==='/api/autopilot'||path.startsWith('/api/autopilot/')) {
        // GET reads the view; a mode, a person's Repair of a failed run at the watched head, and Stop are posted for the Build stage.
        const operation=path.slice('/api/autopilot'.length);
        if(!['','/mode','/repair','/stop'].includes(operation)||(req.method==='GET')!==(operation===''))return reply(res,404,{error:'Autopilot operation not found.'});
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req);
        return reply(res,operation==='/repair'?202:200,await withActiveScan(input.repoPath,async scan=>{
          if(operation==='/mode'){autopilotStage(input.stageId);await repairs.setAutoMerge({enabled:autopilotMode(input.mode)==='merge'});}
          if(operation==='/repair'){autopilotStage(input.stageId);await repairs.repair({runId:input.runId});}
          if(operation==='/stop'){autopilotStage(input.stageId);await repairs.stop({id:input.id});}
          return autopilotView(scan);
        }));
      }
      if(path==='/api/browser'||path.startsWith('/api/browser/')) {
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req,path==='/api/browser/transcribe'?12*1024*1024:1024*1024);
        const scan=activeScan(input.repoPath),stage=sandboxStage(input.stageId),context=stageContext(scan,stage.id,actualPort);
        const browserRun=path.match(/^\/api\/browser\/runs\/([a-f0-9-]{36})(\/frame|\/video)?$/);
        if(req.method==='GET'&&browserRun) {
          if(!browserRun[2])return reply(res,200,await browser.runProgress(context,browserRun[1]));
          if(browserRun[2]==='/video'){
            const recording=await browser.video(context,browserRun[1],input.caseId,input.file);
            videoStreams.add(res);res.once('close',()=>videoStreams.delete(res));
            return await sendVideo(req,res,recording);
          }
          const frame=await browser.frame(context,browserRun[1],input.caseId);
          if(!frame){res.writeHead(204);return res.end();}
          res.setHeader('Content-Type','image/jpeg');res.setHeader('Content-Length',frame.length);return res.end(frame);
        }
        if(req.method==='GET'&&path==='/api/browser')return reply(res,200,await browser.view(context));
        if(req.method==='GET'&&path==='/api/browser/specs/code')return reply(res,200,await browser.specCode(context,{caseId:input.caseId}));
        if(req.method==='POST') {
          const operation=path.slice('/api/browser/'.length);
          if(operation==='config')return reply(res,200,await browser.saveConfig(context,input.config));
          if(operation==='model')return reply(res,200,await browser.saveModel(context,{...Object.fromEntries(['apiKey','model','baseUrl'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))}));
          if(operation==='cases')return reply(res,200,await browser.saveCases(context,input.cases,input.baseCases));
          if(operation==='specs')return reply(res,200,await browser.saveSpec(context,{caseId:input.caseId,code:input.code}));
          if(operation==='specs/approve')return reply(res,200,await browser.approveSpec(context,{caseId:input.caseId,hash:input.hash}));
          if(operation==='specs/discard')return reply(res,200,await browser.discardSpec(context,{caseId:input.caseId,hash:input.hash}));
          if(operation==='specs/reuse')return reply(res,200,await browser.reuseSpec(context,{caseId:input.caseId}));
          if(operation==='specs/verify')return reply(res,202,await browser.verifySpec(context,{caseId:input.caseId,hash:input.hash}));
          if(operation==='specs/verify/cancel')return reply(res,200,await browser.cancelSpecVerification(context,{caseId:input.caseId}));
          if(operation==='specs/generate')return reply(res,202,await browser.generateSpec(context,{caseId:input.caseId}));
          if(operation==='specs/generate/cancel')return reply(res,200,await browser.cancelSpecGeneration(context,{caseId:input.caseId}));
          if(operation==='draft'||operation==='transcribe'){
            const controller=new AbortController();
            const cancel=()=>{if(!res.writableEnded)controller.abort();};
            res.once('close',cancel);
            if(res.destroyed)controller.abort();
            try{
              const options={signal:controller.signal,isCurrent:()=>isPreparationSourceCurrent(context)};
              const result=operation==='draft'?await browser.draft(context,input.description,options):await browser.transcribe(context,input,options);
              return reply(res,200,result);
            }finally{res.off('close',cancel);}
          }
          if(operation==='discover')return reply(res,202,await browser.discover(context,input));
          if(operation==='run')return reply(res,202,await browser.run(context,input,{manual:true}));
          if(operation==='skip')return reply(res,200,await browser.skip(context,input.id,input.caseId));
          if(operation==='stop')return reply(res,200,await browser.stop(context,input.id));
        }
        return reply(res,404,{error:'Browser operation not found.'});
      }
      if(path==='/api/environments'||path.startsWith('/api/environments/')) {
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req,1024*1024);
        const scan=activeScan(input.repoPath),stage=sandboxStage(input.stageId),context=stageContext(scan,stage.id,actualPort);
        if(req.method==='GET'&&path==='/api/environments')return reply(res,200,await environments.view(context));
        if(req.method==='POST') {
          const operation=path.slice('/api/environments/'.length);
          if(operation==='plan')return reply(res,200,await environments.savePlan(context,input.plan));
          // A person's creation may have an agent write a detected stage's twin config first; a gate's never does.
          if(operation==='create')return reply(res,202,await environments.create(context,{generate:true}));
          if(operation==='destroy')return reply(res,202,await environments.destroy(context,text(input.id)));
          if(operation==='logs')return reply(res,200,await environments.logs(context,text(input.id)));
        }
        return reply(res,404,{error:'Environment operation not found.'});
      }
      if(req.method==='GET'&&path==='/api/github/connection'){
        const [connection,local]=await Promise.all([githubConnection(),localCheckout(repo)]);
        return reply(res,200,{...connection,localCheckout:local});
      }
      if(req.method==='POST'&&path==='/api/github/auth/start') {
        await body(req);
        if(sourceBusy)throw conflict(SOURCE_BUSY);
        return reply(res,200,githubAuth.start());
      }
      if(req.method==='POST'&&path==='/api/github/auth/status') {
        const input=await body(req);
        return reply(res,200,githubAuth.status(input.id));
      }
      if(req.method==='POST'&&path==='/api/github/auth/cancel') {
        const input=await body(req);
        return reply(res,200,githubAuth.cancel(input.id));
      }
      if(req.method==='POST'&&path==='/api/github/connect') {
        return await withSourceHeld(requireSourceIdle,async()=>{
          const session=await getGitHubSession();
          if(!session.authenticated)throw new Error(session.message || 'Sign in with GitHub CLI on this computer, then connect again.');
          const connectionRecord={login:session.account.login,connectedAt:new Date().toISOString()};
          await save(current=>({state:{...current,githubConnection:connectionRecord},commit(){state.githubConnection=connectionRecord;}}));
          return reply(res,200,await githubConnection(session));
        });
      }
      if(req.method==='POST'&&path==='/api/github/disconnect') {
        return await withSourceHeld(requireSourceIdle,async()=>{
          await save(current=>({state:{...current,githubConnection:null},commit(){state.githubConnection=null;}}));
          return reply(res,200,await githubConnection());
        });
      }
      if(req.method==='GET'&&path==='/api/github/repositories') {
        await requireGitHub();
        return reply(res,200,await listGitHubRepositories({page:requestUrl.searchParams.get('page') ?? 1}));
      }
      if(req.method==='GET'&&path==='/api/github/branches') {
        await requireGitHub();
        return reply(res,200,await listGitHubBranches({repository:requestUrl.searchParams.get('repository'),page:requestUrl.searchParams.get('page') ?? 1,preferredBranch:requestUrl.searchParams.get('preferredBranch') || undefined}));
      }
      if(req.method==='POST'&&path==='/api/source/github') {
        return await withSourceHeld(requireSourceChangeIdle,async()=>{
          const connection=await requireGitHub(),input=await body(req);
          const prepared=await prepareGitHubSource({repository:input.repository,branch:input.branch,rootDirectory:input.rootDirectory,dataDir});
          const scan=await scanRepository(prepared.scanPath);
          const source: GitHubSource={...prepared,connectedAccount:connection.account.login,savedAt:new Date().toISOString()};
          const result=await save(current=>{
            const key=sourceKey(source),detected=parseGitHubRemote(current.scan?.repo?.remote);
            const pipelines={...current.pipelines};
            // Preserve the outgoing local repository even if a different one is selected first.
            if(!current.source && detected && current.pipelines[current.scan!.repo.path]) {
              const legacyKey=sourceKey({repository:detected,rootDirectory:'/'});
              pipelines[legacyKey] ??= current.pipelines[current.scan!.repo.path];
            }
            const saved=pipelines[key];
            const pipeline=normalizedPipeline({... (saved ?? defaultPipeline(scan.repo.path)),repoPath:scan.repo.path});
            pipelines[key]=pipeline;
            return {state:{...current,scan,source,providers:[],pipelines},
              commit(){state.scan=scan;state.source=source;state.providers=[];state.pipelines=pipelines;},
              result:{scan,source,pipeline}};
          });
          return reply(res,200,result);
        });
      }
      if(req.method==='POST'&&path==='/api/scan') {
        return await withSourceHeld(requireSourceChangeIdle,async()=>{
          const input=await body(req),scan=await scanRepository(input.path||repo);
          await save(current=>({state:{...current,providers:[],scan,source:null},commit(){state.providers=[];state.scan=scan;state.source=null;}}));
          return reply(res,200,scan);
        });
      }
      if(req.method==='GET'&&path==='/api/pipeline') {
        return reply(res,200,{pipeline:currentPipeline(state)});
      }
      if(req.method==='GET'&&path==='/api/git-history') {
        requireSourceIdle();
        const source=state.source;
        return reply(res,200,await withActiveScan(requestUrl.searchParams.get('repoPath'),async scan=>{
          let sync=null;
          if(source?.scanPath===scan.repo.path) {
            await requireGitHub();
            sync=await ensureGitHubHistory({source,dataDir,refresh:requestUrl.searchParams.get('refresh')==='1'});
          }
          const history=await readGitHistory(scan,{
            scope:requestUrl.searchParams.get('scope')??'all',
            limit:Number(requestUrl.searchParams.get('limit')??100),
            ...(sync ? {currentRef:`refs/remotes/origin/${source!.branch}`} : {}),
          });
          return {...history,...sync};
        },'The active repository changed. Reopen its Git graph.'));
      }
      if(req.method==='GET'&&path==='/api/github-actions') {
        requireSourceIdle();
        return reply(res,200,await withActiveScan(requestUrl.searchParams.get('repoPath'),scan=>readGitHubActions(scan)));
      }
      if(req.method==='GET'&&path==='/api/service-config') {
        requireSourceIdle();
        return reply(res,200,await withActiveScan(requestUrl.searchParams.get('repoPath'),async scan=>{
          const configuration=await readServiceConfig(scan,requestUrl.searchParams.get('nodeId'));
          configuration.files=await configurationLinks(scan,configuration.files);
          return configuration;
        },'The active repository changed. Reopen its settings.'));
      }
      if(req.method==='POST'&&path==='/api/pipeline/action') {
        requireSourceIdle();
        const input=await body(req);
        const pipeline=await save(current=>{
          const repoPath=current.scan?.repo?.path;
          if(!repoPath || input?.repoPath!==repoPath) {
            const error: HttpError=new Error('The active repository changed. Reload its pipeline before editing.');
            error.statusCode=409;throw error;
          }
          if(input.action==='remove-stage')throw new Error('Use confirmed stage deletion to remove this stage and its sandbox.');
          // Only a stage ID can be in use; any other value names no stage and the action rejects it.
          for(const stageId of [input.stageId,input.afterStageId,input.sourceStageId,input.targetStageId].filter((id): id is string=>typeof id==='string'&&Boolean(id)))usage.assertAvailable({key:pipelineKey(current),stageId});
          const pipeline=applyPipelineAction(currentPipeline(current),input);
          if(input.action==='set-github-workflow' && input.workflowFile!==null && !current.scan!.workflows?.some(workflow=>workflow.file===input.workflowFile)) {
            throw new Error('The selected GitHub Actions workflow is no longer available. Reload the pipeline.');
          }
          const pipelines={...current.pipelines,[pipelineKey(current)]:pipeline};
          return {state:{...current,pipelines},commit(){state.pipelines=pipelines;},result:pipeline};
        });
        return reply(res,200,{pipeline});
      }
      if(req.method==='GET'&&path==='/api/providers') {
        if(!state.scan)throw new Error('Scan a repository first.');
        const scan=state.scan,providers=await getProviderStatus(scan);
        if(state.scan===scan){state.providers=providers;await save();}
        return reply(res,200,{providers});
      }
      // A current-commit GitHub read as the connected account: an explicit Disconnect refuses before any
      // session read, the session is verified once per request, and the reply never describes another source.
      async function connectedRead<R>(reader: {session(): Promise<GitHubSession>; read(input: {repository?: unknown; sha?: unknown; login?: unknown}): Promise<R>},subject: string): Promise<R> {
        requireSourceIdle();
        return withActiveScan(requestUrl.searchParams.get('repoPath'),async scan=>{
          if(state.githubConnection===null)throw new Error(`Connect your GitHub account to read ${subject}.`);
          const connection=await githubConnection(await reader.session());
          if(!connection.connected)throw new Error(connection.message||`Connect your GitHub account to read ${subject}.`);
          return reader.read({repository:connection.source?.repository,sha:scan.repo.sha,login:connection.account?.login});
        });
      }
      if(req.method==='GET'&&path==='/api/github/runs')return reply(res,200,await connectedRead(githubRuns,'workflow runs'));
      // The deployments GitHub records for the scanned commit, as the apps that made them reported them.
      if(req.method==='GET'&&path==='/api/github/deployments')return reply(res,200,await connectedRead(githubDeployments,'deployments'));
      const failedRun=path.match(/^\/api\/providers\/github\/runs\/(\d+)\/failure$/);
      if(req.method==='GET'&&failedRun){
        // The connected, verified account's repository, never the scan remote or an unverified gh session.
        const connection=await connectedAccount();
        if(!connection)throw new Error('Connect your GitHub account to read workflow runs.');
        return reply(res,200,await (github.failure??getGitHubFailure)({repository:connection.repository,runId:failedRun[1]}));
      }
      if(req.method==='POST'&&path==='/api/plan') {
        if(!state.scan)throw new Error('Scan a repository first.');
        const input=await body(req);return reply(res,200,createPreviewPlan(state.scan,input.environment||'alpha'));
      }
      return reply(res,404,{error:'Not found.'});
    } catch(error) {const statusCode=(error as HttpError).statusCode??400;return reply(res,[404,409,502].includes(statusCode)?statusCode:400,{error:failureText(error,1000)});}
  });
  onCleanup(()=>server.listening?new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())):undefined);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const timer=setInterval(()=>{
    if(tickTask||closed)return;
    tickTask=(async()=>{
      try {await environments.tick();}
      catch(e){process.stderr.write(`Environment runner: ${redact((e as Error).message)}\n`);}finally{tickTask=null;}
    })();
  },1000);timer.unref();
  gates.start();
  repairs.start();
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,server,close(){
    if(closing)return closing;closed=true;clearInterval(timer);githubAuth.dispose();usage.stopAdmissions();gateStop.abort();
    for(const res of videoStreams)res.destroy();
    const stopped=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    const draining=[gates.close(),repairs.close(),removals.close(),environments.close(),browser.close(),tickTask,stopped];
    closing=(async()=>{const results=await Promise.allSettled(draining);await saving;const failed=results.find(item=>item.status==='rejected');if(failed)throw failed.reason;})();return closing;
  }};
}
