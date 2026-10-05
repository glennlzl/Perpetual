import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {Readable} from 'node:stream';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {hide,redact} from '../redaction.ts';
import {resolveBrowserModel,browserModelEnvironment} from './model-policy.ts';
import type {BrowserModelConfiguration,BrowserModelSettings} from './model-policy.ts';
import {validateRunCredentials} from './run-credentials.ts';
import {localBrowserHost} from './local-host.ts';

/** One JSON event a worker printed on its stdout: untrusted until its consumer checks it. */
export type WorkerEvent=Record<string,unknown>;
export type WorkerStream='stdout'|'stderr';
/** A worker's terminal error; cleanupIncomplete says an owned process or profile may remain. */
export type WorkerError=Error&{cleanupIncomplete?:true;timedOut?:true};
export type WorkerJob<T=void>={promise:Promise<T>;cancel():void};
/** Supervisor-owned facts; child diagnostics use a separate, untrusted callback. Neither carries error text. */
export type WorkerLifecycle={name:'worker-start'|'worker-stop'|'worker-signal'|'worker-exit'|'worker-close'|'worker-done'|'worker-diagnostic-truncated';reason?:'cancel'|'deadline'|'protocol'|'consumer'|'descendants';signal?:string;code?:number;failed?:boolean;cleanupIncomplete?:boolean;timedOut?:boolean};
export type SuperviseWorkerOptions={command:string;args:string[];cwd?:string;env:NodeJS.ProcessEnv;stdin?:string;timeoutMs:number;cleanupGraceMs?:number;settleMs?:number;stopSignal?:NodeJS.Signals;secrets?:unknown[];errorSecrets?:unknown[];unavailable?:string;onLifecycle?:(event:WorkerLifecycle)=>void;onDiagnostic?:(event:unknown)=>void}
  // A worker speaks the event protocol, or only prints output.
  &({onEvent:(event:WorkerEvent)=>void;onOutput?:undefined}|{onOutput:(chunk:string,stream:WorkerStream)=>void;onEvent?:undefined});
/** What a browser worker reads on its stdin: its mode and that mode's inputs. */
export type BrowserWorkerInput={mode:string;timeoutSeconds?:number;credentials?:unknown;[key:string]:unknown};
type Preflight={runtimeInstalled:boolean;browserInstalled:boolean};
export type BrowserCapabilities={runtimeInstalled:boolean;browserInstalled:boolean;modelConfigured:boolean;modelError?:string;runtimeProject?:string};
export type WorkerStartOptions={timeoutMs?:number;cleanupGraceMs?:number};
export type BrowserRuntime={capabilities():Promise<BrowserCapabilities>;start(input:BrowserWorkerInput,onEvent:(event:WorkerEvent)=>void,options?:WorkerStartOptions):WorkerJob};

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
// An error's message, or anything else thrown as it is.
const messageOf=(error:unknown):unknown=>typeof error==='object'&&error!==null&&'message' in error?error.message:undefined;
// Fields of a run's events that a consumer matches exactly against its reviewed case or a fixed vocabulary: milestone
// checks, result assertions and blockers, case actions, video files and a blocked request's method. Every other string
// is free text, as is all of a discovery or sign-in-page event, which the model writes. A secret is hidden in free text
// only, so one that also spells part of a key, a number, a status or a step id, as a password `test` does in
// `create-test-workflow`, cannot turn a valid event into an invalid one.
const IDENTIFIERS:ReadonlySet<string>=new Set(['type','status','caseId','stepId','kind','stopCause','errorCode','method','value','resolved','files']);
const RUN_EVENTS:ReadonlySet<unknown>=new Set(['case','journey-step','result','video','blocked-request']);
function hideText(value:unknown,conceal:(text:string)=>string,exempt?:ReadonlySet<string>,key?:string):unknown{
  if(typeof value==='string')return key!==undefined&&exempt?.has(key)?value:conceal(value);
  if(Array.isArray(value))return value.map(item=>hideText(item,conceal,exempt,key));
  return isRecord(value)?Object.fromEntries(Object.entries(value).map(([name,item])=>[name,hideText(item,conceal,exempt,name)])):value;
}

const base=fileURLToPath(new URL('../../integrations/browser-use/',import.meta.url));
export function validateBrowserTarget(value:string,{controllerOrigin}:{controllerOrigin?:string}={}):string {
  let url;try{url=new URL(value);}catch{throw new Error('Enter a valid application URL.');}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(value.length>2048||url.username||url.password||!['http:','https:'].includes(url.protocol))throw new Error('Use an application URL without embedded credentials.');
  if(url.protocol==='http:'&&!localBrowserHost(host))throw new Error('Use HTTPS for previews or localhost for a local application.');
  if(!localBrowserHost(host)&&(host.includes(':')||/^(?:0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||host.endsWith('.internal')||host==='metadata'))throw new Error('This address is not an application test target.');
  if(controllerOrigin){
    // Every loopback alias reaches a local controller on its port; another host is the controller only by its own name.
    const controller=new URL(controllerOrigin),controllerHost=controller.hostname.toLowerCase().replace(/\.$/,'');
    if(url.port===controller.port&&(localBrowserHost(host)?localBrowserHost(controllerHost):host===controllerHost))throw new Error('Choose the application URL, not the Perpetual controller.');
  }
  url.hash='';return url.href;
}

export function browserError(error:unknown,env:NodeJS.ProcessEnv=process.env,limit=800):string {
  let text=String(messageOf(error)||error||'Browser operation failed.');
  text=hide([env.PERPETUAL_MODEL_API_KEY,env.OPENROUTER_API_KEY])(text);
  // Each address is scanned once: its query and fragment are cut after it is found, never searched for from every start.
  return redact(text).replace(/https?:\/\/\S+/g,url=>url.replace(/[?#][\s\S]*$/,'')).slice(0,limit);
}

/**
 * The controller's kill timer is a last resort. A run worker executes one journey's Playwright code with its own
 * deadline, then finishes its recording and reports, so fire later; discovery's limit is the request's.
 */
export function workerTimeoutMs({mode,timeoutSeconds}:{mode?:string;timeoutSeconds?:number}={}):number{
  const seconds=timeoutSeconds||300;
  return mode==='run'?(seconds+15+30)*1000:seconds*1000+15000;
}

/**
 * Runs one owned worker process that speaks the browser worker contract: one JSON event per stdout line,
 * `error` events carrying the terminal error, and a zero exit once its work is reported. The worker's
 * process group is joined before completion: descendants still running settleMs after the worker exits count as
 * owned processes remaining. stopSignal asks it to clean up before the group is killed.
 * With onOutput, the process speaks no event protocol: its stdout and stderr chunks go to onOutput, and a zero exit completes it.
 */
export function superviseWorker({command,args,cwd,env,stdin='',onEvent,onOutput,onLifecycle,onDiagnostic,timeoutMs,cleanupGraceMs=40000,settleMs=0,stopSignal='SIGTERM',secrets=[],errorSecrets=[],unavailable='Browser runtime is unavailable.'}:SuperviseWorkerOptions):WorkerJob {
  const child=spawn(command,args,{stdio:onDiagnostic?['pipe','pipe','pipe','pipe']:['pipe','pipe','pipe'],env,cwd,detached:process.platform!=='win32'}) as ChildProcessWithoutNullStreams;
  const lifecycle=(event:WorkerLifecycle)=>{try{onLifecycle?.(event);}catch{/* Evidence cannot interfere with supervision. */}};
  lifecycle({name:'worker-start'});
  // A separate pipe cannot spend the business event budget or enter its secret-sensitive protocol parser.
  // Drain it even after its bound, ignoring malformed input and forbidding child-authored supervisor facts.
  const diagnostic=child.stdio[3] as Readable|undefined;
  if(diagnostic){let pending='',bytes=0,truncated=false;
    const truncate=()=>{if(!truncated){truncated=true;lifecycle({name:'worker-diagnostic-truncated'});}};
    diagnostic.setEncoding('utf8');diagnostic.on('error',truncate);diagnostic.on('data',(chunk:string)=>{
    if(bytes>256*1024)return;bytes+=Buffer.byteLength(chunk);if(bytes>256*1024){pending='';truncate();return;}
    pending+=chunk;
    let newline;while((newline=pending.indexOf('\n'))!==-1){
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.length>2048){truncate();continue;}
      try{const event:unknown=JSON.parse(line);if(isRecord(event)&&(event.source==='fixture'||event.source==='reporter'))onDiagnostic?.(event);}catch{truncate();}
    }
    if(pending.length>2048){pending='';truncate();}
  });}
  const hidden=secrets.filter((value):value is string=>typeof value==='string'&&Boolean(value)),conceal=hide(hidden);
  // Error-only account values must be hidden before clipping without rewriting reviewed check evidence.
  const failure=(error:unknown)=>browserError(hide([...hidden,...errorSecrets])(String(messageOf(error)||error||'Browser operation failed.')),env);
  let buffer='',broken=false,eventBytes=0,terminalError:Error|null=null,settled=false,timer:NodeJS.Timeout|undefined,killTimer:NodeJS.Timeout|undefined,forcedAt=0,cleanupIncomplete=false,timedOut=false;
  function signal(name:NodeJS.Signals){lifecycle({name:'worker-signal',signal:name});try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,name);else child.kill(name);}catch{}}
  function groupAlive(){if(process.platform==='win32'||!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
  function stop(message:string,reason:WorkerLifecycle['reason']='protocol'){
    if(settled||killTimer)return;terminalError ||= new Error(message);lifecycle({name:'worker-stop',reason});lifecycle({name:'worker-signal',signal:stopSignal});try{child.kill(stopSignal);}catch{}
    // Python closes its agent, Chromium and driver with separate 10-second bounds,
    // after up to 5 seconds finishing recordings. Give those cleanups time before killing the owned process group.
    killTimer=setTimeout(()=>{forcedAt=Date.now();cleanupIncomplete=true;terminalError=new Error(`${terminalError?.message||'Browser operation stopped.'} Cleanup incomplete after forced termination; an owned browser or temporary profile may remain.`);signal('SIGKILL');},cleanupGraceMs);killTimer.unref();
  }
  // A stream that broke the protocol is drained, never buffered or parsed again: what follows may be part of what broke it.
  function refuse(message:string){broken=true;buffer='';stop(message);}
  const promise=new Promise<void>((resolve,reject)=>{
    function done(error:unknown){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);lifecycle({name:'worker-done',failed:Boolean(error),cleanupIncomplete,timedOut});error?reject(Object.assign(new Error(failure(error)),cleanupIncomplete?{cleanupIncomplete:true}:{},timedOut?{timedOut:true}:{})):resolve();}
    child.once('error',()=>done(new Error(unavailable)));
    child.stdout.setEncoding('utf8');
    if(onOutput){child.stderr.setEncoding('utf8');for(const stream of ['stdout','stderr'] as const)child[stream].on('data',(chunk:string)=>{try{onOutput(chunk,stream);}catch(error){stop(failure(error),'consumer');}});}
    else child.stdout.on('data',(chunk:string)=>{
      if(broken)return;
      buffer+=chunk;if(Buffer.byteLength(buffer)>3*1024*1024)return refuse('Browser event exceeded its size limit.');
      let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
        let parsed:unknown;try{parsed=JSON.parse(line);}catch{return refuse('Browser runtime returned an invalid event.');}
        if(!isRecord(parsed))return refuse('Browser runtime returned an invalid event.');
        let event:WorkerEvent=parsed;
        // A frame or an action snapshot replaces the previous one, so neither spends the event history.
        if(event.type!=='frame'&&event.type!=='case'){eventBytes+=Buffer.byteLength(line);if(eventBytes>8*1024*1024)return refuse('Browser event history exceeded its size limit.');}
        if(event.type==='error'){cleanupIncomplete ||= event.cleanupIncomplete===true;terminalError=new Error(failure(event.error));continue;}
        // Nesting too deep to walk stops the run rather than throwing out of this listener.
        if(event.type!=='frame'&&hidden.length)try{event=hideText(event,conceal,RUN_EVENTS.has(event.type)?IDENTIFIERS:undefined) as WorkerEvent;}catch{return refuse('Browser runtime returned an invalid event.');}
        // Without onOutput, the options carry onEvent.
        try{onEvent!(event);}catch(error){return stop(failure(error),'consumer');}
      }
    });
    // Runtime libraries can log page contents or credentials to stderr. Do not retain them.
    if(!onOutput)child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('exit',(code,signal)=>lifecycle({name:'worker-exit',...(code===null?{}:{code}),...(signal?{signal}:{})}));
    child.once('close',async(code,exitSignal)=>{
      lifecycle({name:'worker-close',...(code===null?{}:{code}),...(exitSignal?{signal:exitSignal}:{})});
      for(const end=Date.now()+settleMs;!killTimer&&groupAlive()&&Date.now()<end;)await new Promise(resolve=>setTimeout(resolve,50));
      if(groupAlive()){
        stop('Browser runtime exited with owned child processes remaining.','descendants');signal('SIGTERM');
        // The wrapper's stdio can close before Chromium and other owned
        // descendants exit. Keep the job (and its environment lease) alive
        // through graceful cleanup, forced termination, and signal delivery.
        while(groupAlive()&&(!forcedAt||Date.now()-forcedAt<1000))await new Promise(resolve=>setTimeout(resolve,10));
        if(groupAlive()){cleanupIncomplete=true;terminalError=new Error(`${terminalError?.message||'Browser operation stopped.'} Cleanup incomplete; owned child processes could not be confirmed stopped.`);}
      }
      done(terminalError||(code!==0?new Error('Browser runtime exited before completing the operation.'):buffer.trim()?new Error('Browser runtime returned an incomplete event.'):null));
    });
    timer=setTimeout(()=>{if(!killTimer)timedOut=true;stop('Browser operation exceeded its time limit.','deadline');},timeoutMs);timer.unref();
    child.stdin.end(stdin);
  });
  return {promise,cancel(){stop('Browser operation cancelled.','cancel');}};
}

export function createBrowserRuntime({python=process.env.PERPETUAL_BROWSER_PYTHON||`${base}.venv/bin/python`,runner=`${base}runner.py`,env=process.env,model}:{python?:string;runner?:string;env?:NodeJS.ProcessEnv|(()=>NodeJS.ProcessEnv);model?:BrowserModelConfiguration|(()=>BrowserModelConfiguration)}={}):BrowserRuntime {
  let preflight:Preflight|null=null,checkedAt=0,pending:Promise<Preflight>|null=null;
  const modelConfiguration=()=>model?(typeof model==='function'?model():model):resolveBrowserModel({env:typeof env==='function'?env():env});
  function childEnvironment(configuration:BrowserModelSettings){
    const result:Record<string,string>={PYTHONUNBUFFERED:'1',ANONYMIZED_TELEMETRY:'false',BROWSER_USE_LOGGING_LEVEL:'error'};
    const values=typeof env==='function'?env():env;
    // Chromium's install folder, as the journey worker reads it, and the proxy that model requests go through, as
    // OpenCode's do.
    for(const key of ['PATH','HOME','TMPDIR','LANG','DISPLAY','PLAYWRIGHT_BROWSERS_PATH','HTTPS_PROXY','HTTP_PROXY','NO_PROXY']){const value=values[key];if(typeof value==='string')result[key]=value;}
    Object.assign(result,browserModelEnvironment(configuration));
    return result;
  }
  const runtime:BrowserRuntime={
    async capabilities(){
      if(!preflight||Date.now()-checkedAt>15000){
        pending ||= (async()=>{
          const result={runtimeInstalled:false,browserInstalled:false};
          try{
            if(!isAbsolute(python))throw new Error('Invalid runtime path.');
            await access(python,constants.X_OK);await access(runner,constants.R_OK);
            const job=runtime.start({mode:'preflight'},event=>{if(event.type==='status'){result.runtimeInstalled=event.runtimeInstalled===true;result.browserInstalled=event.browserInstalled===true;}},{timeoutMs:10000});
            await job.promise;
          }catch{result.runtimeInstalled=false;result.browserInstalled=false;}
          preflight=result;checkedAt=Date.now();pending=null;return result;
        })();
        await pending;
      }
      // The check above has set preflight.
      const {modelConfigured,modelError}=modelConfiguration();return {...preflight!,modelConfigured,...(modelError?{modelError}:{}),...(python===`${base}.venv/bin/python`?{runtimeProject:base.replace(/\/$/,'')}:{})};
    },
    start(input,onEvent,{timeoutMs=workerTimeoutMs(input),cleanupGraceMs=40000}={}) {
      // The agent discovers journeys; runs execute approved Playwright code instead (src/journeys/playwright).
      if(!['preflight','discover'].includes(input.mode))throw new Error('The browser agent only discovers journeys.');
      const credentials=validateRunCredentials(input.credentials);
      if(credentials&&input.mode!=='discover')throw new Error('A test account is only available for discovery.');
      if(!isAbsolute(python)||!isAbsolute(runner))throw new Error('Configure an absolute Browser Use Python path.');
      const configuration=modelConfiguration();
      if(input.mode!=='preflight'&&!configuration.modelConfigured)throw new Error(configuration.modelError);
      const env=childEnvironment(configuration);
      return superviseWorker({command:python,args:[runner],cwd:base,env,stdin:JSON.stringify(input),onEvent,timeoutMs,cleanupGraceMs,secrets:[env.PERPETUAL_MODEL_API_KEY],unavailable:'Browser runtime is unavailable. Install integrations/browser-use first.'});
    },
  };
  return runtime;
}
