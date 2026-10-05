import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { scanRepository } from '../src/scanner.ts';

// Optional acceptance check against any local checkout:
//   node scripts/validate-repository.ts <repo> <expectations.json>
// Expectations are per-repository data (see docs/cli.md); this script has no product-specific rules.
// Copies only the listed configuration contracts; no application startup or deployment.
const [repoArg,expectArg]=process.argv.slice(2);
if(!repoArg||!expectArg)throw new Error('Usage: node scripts/validate-repository.ts <repo> <expectations.json>');
/** An acceptance file the developer supplies; each expectation below is asserted against the scan. */
interface Expectations{workflows?:string[];deployments?:Record<string,number>;keepsExistingCi?:boolean;copiedTests?:{files:string[];run:string[]}}
const texts=(value: unknown): value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
// A misspelled key would otherwise be ignored, and a file that asserts nothing would still report success.
const only=(value: object,keys: string[])=>Object.keys(value).every(key=>keys.includes(key));
function expectations(value: unknown): Expectations{
  const input=value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null,deployments=input?.deployments,copied=input?.copiedTests;
  if(!input||!only(input,['workflows','deployments','keepsExistingCi','copiedTests'])||(input.workflows!==undefined&&!texts(input.workflows))
    ||(deployments!==undefined&&(deployments===null||typeof deployments!=='object'||Array.isArray(deployments)||Object.values(deployments).some(count=>typeof count!=='number')))
    ||(input.keepsExistingCi!==undefined&&typeof input.keepsExistingCi!=='boolean')
    ||(copied!==undefined&&(copied===null||typeof copied!=='object'||!only(copied,['files','run'])||!('files' in copied)||!texts(copied.files)||!('run' in copied)||!texts(copied.run)||!copied.run.length)))throw new Error('Expectations must list workflows, deployment counts, keepsExistingCi and copiedTests { files, run } only in their documented types, with at least one file to run.');
  if(!(input.workflows as string[]|undefined)?.length&&!Object.keys(deployments??{}).length&&input.keepsExistingCi!==true&&copied===undefined)throw new Error('Expectations assert nothing: list a workflow, a deployment count, keepsExistingCi: true or copiedTests.');
  return input as Expectations;
}
const root=resolve(repoArg),expect=expectations(JSON.parse(await readFile(resolve(expectArg),'utf8')));
const scan=await scanRepository(root);
for(const name of expect.workflows||[])assert.ok(scan.workflows.some(w=>w.name===name),`Workflow ${name} was not detected.`);
for(const [provider,count] of Object.entries(expect.deployments||{}))assert.ok(scan.nodes.filter(n=>n.provider===provider&&n.kind==='deployment').length>=count,`Expected at least ${count} ${provider} deployments.`);
if(expect.keepsExistingCi)assert.ok(!scan.plan.workflow,'An existing CI must not be replaced by a generated starter.');
let configurationChecks: {status:'passed';workspace:string;files:string[];output:string}|null=null;
if(expect.copiedTests){
  const workspace=await mkdtemp(join(tmpdir(),'perpetual-repository-check-')),{files,run}=expect.copiedTests;
  for(const file of files){await mkdir(dirname(join(workspace,file)),{recursive:true});await copyFile(join(root,file),join(workspace,file));}
  const {stdout}=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',...run],{cwd:workspace,timeout:30000,env:{PATH:process.env.PATH,CI:'1'},maxBuffer:65536});
  // node --test exits 0 when its patterns match no test file, so a pass needs at least one passing test.
  if(!(Number(/^# pass (\d+)$/m.exec(stdout)?.[1])>0))throw new Error(`copiedTests.run found no passing test: ${run.join(', ')}.`);
  configurationChecks={status:'passed',workspace,files,output:stdout};
}
const report={checkedAt:new Date().toISOString(),repository:scan.repo,nodes:scan.nodes.length,edges:scan.edges.length,services:scan.services.map(s=>({name:s.name,path:s.path,provider:s.provider})),workflows:scan.workflows.map(w=>({name:w.name,file:w.file})),configurationChecks,scope:'Read-only discovery and copied existing configuration-contract tests. Does not run the full application, cloud deployment or business end-to-end suite.'};
await mkdir('artifacts',{recursive:true});await writeFile(join('artifacts',`${basename(expectArg,'.json')}-validation.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
