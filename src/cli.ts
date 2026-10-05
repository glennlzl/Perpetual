#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scanRepository } from './scanner.ts';
import { startServer } from './server.ts';
import { getProviderStatus, parseGitHubRemote } from './providers.ts';
import { redact } from './redaction.ts';
import { getGitHubFailure } from './repair/github.ts';

// Every option takes a value, as `--name value` or `--name=value`; an option no command knows, or one without its value,
// is refused rather than ignored.
const OPTIONS=['repo','data','port','run','output','id','image','cpus','memory','command','timeout','input','to','from','action','driver-path','user'];
let values: Record<string,string|boolean|undefined>={};
function option(name: string): string|undefined;
function option(name: string,fallback: string): string;
function option(name: string,fallback?: string){const value=values[name];return typeof value==='string'?value:fallback;}
// An absent option stays undefined so the called module's default applies.
const number=(name: string)=>{const value=option(name);return value===undefined?undefined:Number(value);};
const output=(data: unknown)=>console.log(JSON.stringify(data,null,2));
async function main(){
  const parsed=parseArgs({options:{help:{type:'boolean',short:'h'},...Object.fromEntries(OPTIONS.map(name=>[name,{type:'string' as const}]))},allowPositionals:true});
  values=parsed.values;
  const [command='help',action]=parsed.positionals;
  const repo=resolve(option('repo',process.cwd())),dataDir=resolve(option('data','.perpetual'));
  if(command==='help'||values.help)return help();
  if(command==='serve') {
    const port=number('port');
    if(port!==undefined&&!(Number.isInteger(port)&&port>=0&&port<=65535))throw new Error('--port needs a whole number from 0 to 65535.');
    if(!(await stat(repo).catch(()=>null))?.isDirectory())throw new Error(`No repository directory at ${repo}.`);
    const app=await startServer({port,repo,dataDir});
    console.log(`Perpetual is ready at ${app.url}\nRepository: ${repo}\nData: ${dataDir}`);
    // Shutdown drains the controller's work, which can take a while; a second signal stops at once, with that work left.
    let stopping=false;
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
      if(stopping){console.error('Stopped before shutdown finished.');process.exit(1);}
      stopping=true;console.log('Stopping…');
      app.close().then(()=>process.exit(0),(error: Error)=>{console.error(redact(error.message));process.exit(1);});
    });
    return;
  }
  if(command==='scan')return output(await scanRepository(repo));
  if(command==='twin'){const {twinReport}=await import('./twin/report.ts');return output(await twinReport(await scanRepository(repo)));}
  if(command==='sandbox') {
    const cua=await import('./sandbox/cua.ts');
    const id=option('id',''),context={dataDir,id};
    if(action==='create')return output(await cua.createSandbox({dataDir,image:option('image'),cpus:number('cpus'),memoryMiB:number('memory')}));
    if(action==='list')return output(await cua.listSandboxes({dataDir}));
    if(action==='inspect')return output(await cua.inspectSandbox(context));
    if(action==='destroy')return output(await cua.destroySandbox(context));
    if(action==='exec') {
      const result=await cua.executeSandbox({...context,command:option('command',''),timeoutSeconds:number('timeout')});
      output(result);if(result.returncode!==0)process.exitCode=1;return;
    }
    if(action==='screenshot')return output(await cua.screenshotSandbox({...context,output:option('output','')}));
    if(action==='upload')return output(await cua.uploadSandboxFile({...context,input:option('input',''),destination:option('to','')}));
    if(action==='download')return output(await cua.downloadSandboxFile({...context,source:option('from',''),output:option('output','')}));
    if(action==='act'){const input: unknown=JSON.parse(option('action','{}'));return output(await cua.sandboxAction({...context,action:input}));}
    if(action==='mcp') {
      process.exitCode=await cua.runSandboxMcp({...context,driverPath:option('driver-path'),user:option('user')});return;
    }
    throw new Error('Use sandbox create, list, inspect, destroy, exec, screenshot, upload, download, act, or mcp.');
  }
  if(command==='providers')return output(await getProviderStatus(await scanRepository(repo)));
  if(command==='failure')return output(await getGitHubFailure({repository:parseGitHubRemote((await scanRepository(repo)).repo.remote),runId:option('run','')}));
  if(command==='init-ci') {
    const scan=await scanRepository(repo);
    if(scan.workflows.length)throw new Error('Existing workflows detected. Reuse the current CI; no new workflow was generated.');
    if(!scan.plan?.workflow)throw new Error('No supported build workflow can be generated for this repository.');
    const path=resolve(option('output',join(dataDir,'exports','perpetual-ci.yml')));await mkdir(dirname(path),{recursive:true});await writeFile(path,scan.plan.workflow,{flag:'wx'});console.log(`Review this starter workflow before adding it to your repository: ${path}`);return;
  }
  console.error(`Unknown command: ${command}`);help();process.exitCode=1;
}
function help(){
  console.log(`Perpetual 0.1 — local release control room\n\n  perpetual serve --repo /path/to/repo [--port 4317]\n  perpetual scan --repo /path/to/repo\n  perpetual twin --repo /path/to/repo\n  perpetual providers --repo /path/to/repo\n  perpetual failure --repo /path/to/repo --run RUN_ID\n  perpetual init-ci --repo /path/to/repo [--output file]\n  perpetual sandbox create [--image IMAGE] [--cpus 2] [--memory 4096]\n  perpetual sandbox list\n  perpetual sandbox inspect --id ID\n  perpetual sandbox exec --id ID --command 'guest command'\n  perpetual sandbox screenshot --id ID --output screenshot.png\n  perpetual sandbox mcp --id ID [--driver-path /guest/path/cua-driver]\n  perpetual sandbox destroy --id ID\n\nUse --data PATH to choose where local reports and history are stored.\nQuickstart: ${resolve(dirname(fileURLToPath(import.meta.url)),'../README.md')}`);
}
main().catch((error: Error&{sandboxId?: string})=>{console.error(redact(error.message));if(error.sandboxId)console.error(`Sandbox: ${error.sandboxId}`);process.exitCode=1;});
