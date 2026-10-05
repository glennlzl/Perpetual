// Optional transport acceptance: real controller, Browser Use and owned Chromium discover journeys against a disposable
// page, with deterministic local model responses. This does not evaluate model intelligence. Runs execute approved
// Playwright code, never this agent; test/playwright-journeys.test.ts covers them with a real Chromium.
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer,type Controller} from '../src/server.ts';

// The controller's JSON replies, as far as this contract reads them; assertions check every value used.
type RunReport={run:{id:string;status:string};progress:{cases:{actionCount:number}[]}};
type BrowserView={cases:{selected?:boolean;needsReview?:boolean;isolation?:string}[];specs:unknown};
type PipelineReply={pipeline:{stages:{id:string;name:string}[]}};

const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-contract-'));
const repo=join(directory,'repo');await mkdir(repo);
await writeFile(join(repo,'package.json'),'{}');
await writeFile(join(repo,'app.js'),'// Fixture product: Save updates workspace; Use credit runs work and spends one credit.\nexport const title="Workspace";');
const html='<!doctype html><html><body><h1>Workspace</h1><p>Credits <span id="credits">10</span></p><p id="result"></p><button onclick="document.querySelector(\'h1\').textContent=\'Saved workspace\'">Save</button><button onclick="document.getElementById(\'credits\').textContent=\'9\';document.getElementById(\'result\').textContent=\'Run complete\'">Use credit</button></body></html>';
const fixture=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
const plans={
  'Use a credit':{done:'Run complete',steps:['start','run']},
  'Save workspace':{done:'Saved workspace',steps:['enter','save']},
};
let observations=0;
const model=createServer((req,res)=>{void(async()=>{
  const chunks: Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  JSON.parse(Buffer.concat(chunks).toString('utf8'));observations++;
  // One read-only look first, then the proposals.
  const action=observations===1?{scroll:{down:true}}:{done:{data:{summary:'Fixture workspace observed',cases:Object.entries(plans).map(([name,plan])=>({name,goal:`${name} and verify the result`,steps:plan.steps.map(id=>({id,title:`${name}: ${id}`})),preconditions:[],expectedOutcomes:[`${plan.done} visible`],assertions:[{type:'text-visible',value:plan.done}],evidence:[]}))}}};
  const output={evaluation_previous_goal:'Observed fixture page',memory:'Choose from current page',next_goal:'Propose journeys',action:[action]};
  // The worker takes each decision as exactly one browser_decision tool call (integrations/browser-use/decision_model.py).
  const call={id:`call-${observations}`,type:'function',function:{name:'browser_decision',arguments:JSON.stringify(output)}};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[call]}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
})().catch(error=>{res.statusCode=500;res.end(JSON.stringify({error:error.message}));});});
let app: Controller|undefined,token='',stageId='',frames=0,frameBytes=0,activity=0;
async function listen(server: Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function call<T=unknown>(path: string,body?: object): Promise<T>{const response=await fetch(app!.url+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Perpetual-Token':token}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
const context=()=>({repoPath:repo,stageId});
const query=(extra: Record<string,string>={})=>new URLSearchParams({...context(),...extra});
async function frame(id: string){
  const response=await fetch(`${app!.url}/api/browser/runs/${id}/frame?${query()}`);
  if(response.status!==200)return;
  assert.equal(response.headers.get('content-type'),'image/jpeg');const bytes=await response.arrayBuffer();frames++;frameBytes+=bytes.byteLength;
}
async function finish(id: string){
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const report=await call<RunReport>(`/api/browser/runs/${id}?${query()}`);
    await frame(id);
    activity=Math.max(activity,...report.progress.cases.map(item=>item.actionCount));
    if(!['queued','running'].includes(report.run.status))return report;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('Browser controller contract timed out.');
}
try{
  const targetUrl=await listen(fixture),baseUrl=await listen(model);
  app=await startServer({port:0,repo,dataDir:join(directory,'controller')});
  token=(await call<{token:string}>('/api/session')).token;await call('/api/scan',{path:repo});
  stageId=(await call<PipelineReply>('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).pipeline.stages.find(stage=>stage.name==='Beta')!.id;
  await call('/api/browser/model',{...context(),apiKey:'fixture-not-a-real-key',model:'fixture',baseUrl:baseUrl+'/v1'});
  await call('/api/browser/config',{...context(),config:{targetUrl,maxSteps:10,journeyTimeoutSeconds:300}});
  const generated=await call<RunReport>('/api/browser/discover',context());
  const generation=await finish(generated.run.id);assert.equal(generation.run.status,'completed',JSON.stringify(generation));
  // Discovered journeys are drafts: unselected, needing review, with shared data and no code.
  const view=await call<BrowserView>(`/api/browser?${query()}`);assert.equal(view.cases.length,2);assert.ok(view.cases.every(item=>!item.selected&&item.needsReview&&item.isolation==='shared'));
  assert.deepEqual(view.specs,{});
  assert.ok(frames>0,'Discovery streams live frames.');assert.ok(activity>0);
  process.stdout.write(JSON.stringify({kind:'deterministic-protocol-fixture',discovery:generation.run.status,reviewRequired:true,journeys:view.cases.length,frames,frameBytes,activity,observations,realModelInference:false})+'\n');
}finally{
  await app?.close();for(const server of [fixture,model]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(directory,{recursive:true,force:true});
}
