import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,readFile,readdir,access,realpath,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import {createBrowserManager} from '../src/browser/manager.ts';
import {createPlaywrightRuntime} from '../src/journeys/playwright/runtime.ts';
import {generateJourneySpec,generatePrompt,generationPlan,generationRules,opencodeHarness,repairPrompt,seedSpec} from '../src/journeys/playwright/generation.ts';
import {specHash,validateJourneySpec} from '../src/journeys/playwright/specs.ts';
import {codeFor} from './fixtures/journey-code.ts';
import type {BrowserManager,BrowserManagerOptions,BrowserStageContext,TargetEnvironment} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

type JourneyRuntime=NonNullable<BrowserManagerOptions['playwright']>;
type Events=(input:JourneyRunInput)=>WorkerEvent[];
/** One run of the fake harness, as it logs what it saw (test/fixtures/fake-opencode.ts). */
type HarnessCall={prompt:string;cwd:string;workspaceMode:number;git:boolean;prompts:boolean;agent:unknown;permission:unknown;mcp:string[];config:{projects:unknown};modes:unknown;env:unknown;mcpEnvironment:unknown;seed:string;plan:string;pids?:number[];
  generation:{setups:unknown;refused:Record<string,unknown>;written:Record<string,unknown>;wrote:unknown;leaked:unknown;exposed:unknown}};
type StoredState={specs:Record<string,Record<string,{approved:unknown;draft:{code:string;hash:string}}>>};

// Code generation with a fake harness in place of OpenCode: no network, no key, no model.
const fake=fileURLToPath(new URL('./fixtures/fake-opencode.ts',import.meta.url));
const key='or-fixture-key-7731',password='pw-fixture-4821',model='openai/gpt-4.1-mini';
const journey={id:'rename',name:'Rename the display name',goal:'Change my display name and see it kept after a reload.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'open-settings',title:'Sign in and open Settings',checks:[{type:'url-contains',value:'/settings'}]},{id:'save-name',title:'Save the display name',checks:[{type:'text-visible',value:'Saved'}]}],
  preconditions:['A test account'],expectedOutcomes:['Settings shows the new name.'],assertions:[]} satisfies Omit<BrowserCase,'evidence'>;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const lines=async(file:string):Promise<HarnessCall[]>=>(await readFile(file,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(line=>JSON.parse(line));

async function setup(t:TestContext,{mode='valid',target='http://localhost:3000/',environment:overrides={},playwright,runtime:agentRuntime,timeoutMs=20000,events}:{mode?:string;target?:string;environment?:Partial<TargetEnvironment>;playwright?:JourneyRuntime;runtime?:BrowserManagerOptions['runtime'];timeoutMs?:number;events?:Events}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-generation-'));await mkdir(join(dataDir,'repo'));
  const log=join(dataDir,'harness.jsonl'),launches:JourneyRunInput[]=[],state={mode},uncertain:string[]=[];
  const environment:TargetEnvironment={id:'twin-1',status:'ready',stageId:'beta',apps:[{id:'web',url:target}],accounts:[{id:'owner',label:'Owner',username:'tester@example.com'}],services:[],...overrides};
  // The seed signs in before the generator starts, as the journey runtime runs it; unless events say otherwise, it does.
  const seeded:Events=input=>[{type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:[]}}];
  playwright??={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(input,onEvent){launches.push(input);const promise=wait(10).then(()=>{for(const event of (events??seeded)(input))onEvent(event);});return {promise,cancel(){}};}};
  const runtime=agentRuntime??{capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(){throw new Error('The browser-use runtime must not start.');}};
  const options=():BrowserManagerOptions=>({dataDir,runtime,playwright,onEnvironmentUncertain:async id=>{uncertain.push(id);},resolveEnvironment:url=>new URL(url).origin===new URL(target).origin?environment:null,twinAccount:async(_environment,accountId)=>accountId==='owner'?{username:'tester@example.com',password}:null,
    generation:{harness:({model:requested,prompt})=>({command:process.execPath,args:[fake,state.mode,log,prompt,requested]}),timeoutMs,cleanupGraceMs:1000}});
  const manager=await createBrowserManager(options());
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  await manager.saveModel(context,{apiKey:key,model});
  await manager.saveConfig(context,{targetUrl:target,journeyTimeoutSeconds:60});
  await manager.saveCases(context,[journey]);
  return {manager,context,dataDir,log,launches,state,environment,options,uncertain};
}
// The generation's view once it is no longer running.
async function settled({manager,context}:{manager:BrowserManager;context:BrowserStageContext},caseId:string=journey.id,seconds=30){
  for(const end=Date.now()+seconds*1000;Date.now()<end;await wait(50)){const spec=(await manager.view(context)).specs[caseId];if(spec?.generation?.status!=='running')return spec;}
  throw new Error('The generation did not finish.');
}
const userHome=process.env.HOME||homedir();
const secretFree=(value:unknown)=>!JSON.stringify(value).includes(key)&&!JSON.stringify(value).includes(password);

test('the default harness is OpenCode running Playwright’s generator agent against OpenRouter',()=>{
  assert.deepEqual(opencodeHarness({model:`openrouter/${model}`,prompt:'Go',cwd:'/workspace/project'}),{command:'npx',args:['-y','opencode-ai@1.18.32','run','--agent','playwright-test-generator','--model','openrouter/openai/gpt-4.1-mini','Go']});
});

test('generation and repair identify the configured seed project for the setup tool',()=>{
  assert.match(generationPlan(journey,{signIn:true}),/\*\*Seed project:\*\* `seed`/);
  for(const prompt of [generatePrompt,repairPrompt('No test file was written.','tests/journey.spec.mjs',[])]){
    assert.match(prompt,/generator_setup_page.*`project: "seed"`.*`seedFile: "seed\.spec\.mjs"`/);
  }
});

test('generation and repair receive the complete reviewed acceptance contract in their read-only plan',async t=>{
  const f=await setup(t,{mode:'repair'});
  await f.manager.saveCases(f.context,[{...journey,name:'Create and reopen a quote',
    goal:'Create a new quote, reopen its saved details, and check the remaining budget.',
    preconditions:['A dedicated buyer account with at least 10 credits.','The quote must be created during this run.'],
    steps:[
      {id:'budget',title:'Read the initial budget',checks:[{type:'read-number',label:'Budget',name:'before'},{type:'text-absent',value:'Account suspended'}]},
      {id:'save-quote',title:'Save a new quote',checks:[{type:'text-visible',value:'Quote {run} saved'}]},
      {id:'reopen-quote',title:'Reopen the saved quote',checks:[{type:'url-contains',value:'/quotes/'},{type:'compare-number',label:'Budget',name:'after',op:'<',than:'before'}]},
    ],
    expectedOutcomes:['The new quote retains its approved terms after reopening.','The remaining budget decreases only after the quote is saved.'],
    assertions:[{type:'text-visible',value:'Payment terms: "net 30"\nApproved'},{type:'text-absent',value:'Unsaved changes'}],
  }]);
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.ok((await settled(f))?.draft);
  const calls=await lines(f.log);
  assert.equal(calls.length,2,'An invalid first spec causes the existing grammar repair.');
  for(const call of calls){
    const serialized=call.plan.match(/\*\*Reviewed acceptance contract \(read-only\):\*\*\n\n```json\n([\s\S]*?)\n```/);
    assert.ok(serialized,'The actual harness input must include every reviewed expectation, not just milestone titles and {run} texts.');
    assert.deepEqual(JSON.parse(serialized[1]),{
      id:'rename',name:'Create and reopen a quote',goal:'Create a new quote, reopen its saved details, and check the remaining budget.',
      preconditions:['A dedicated buyer account with at least 10 credits.','The quote must be created during this run.'],
      steps:[
        {id:'budget',title:'Read the initial budget',checks:[{type:'read-number',label:'Budget',name:'before'},{type:'text-absent',value:'Account suspended'}]},
        {id:'save-quote',title:'Save a new quote',checks:[{type:'text-visible',value:'Quote {run} saved'}]},
        {id:'reopen-quote',title:'Reopen the saved quote',checks:[{type:'url-contains',value:'/quotes/'},{type:'compare-number',label:'Budget',name:'after',op:'<',than:'before'}]},
      ],
      expectedOutcomes:['The new quote retains its approved terms after reopening.','The remaining budget decreases only after the quote is saved.'],
      assertions:[{type:'text-visible',value:'Payment terms: "net 30"\nApproved'},{type:'text-absent',value:'Unsaved changes'}],
    });
    assert.equal((call.modes as {plan:number}).plan,0o444);
    assert.ok(secretFree(call));
  }
});

test('the generation rules keep navigation on the current run’s records',()=>{
  const rule="An entity or record URL observed during exploration belongs to that exploration, not to a future run. Reopen data created by this run through its visible links, using journey.run only where the rules allow it. Use `await page.reload();` to check persistence on the current record; never hard-code an explored record's URL in `page.goto`.";
  const rules=generationRules(journey,{signIn:true});
  assert.ok(rules.includes(rule));
  assert.ok(generationPlan(journey,{signIn:true}).includes(rule));
  assert.ok(repairPrompt('Invalid code','tests/journey.spec.mjs',rules).includes(rule));
});

test('a reviewed journey’s code is generated in a private workspace and saved as a draft',async t=>{
  const f=await setup(t);
  const started=await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal(started.specs[journey.id].generation?.status,'running');
  assert.equal(f.manager.isActive(f.context),true);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409,message:'Code for this test is already being generated.'});
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:journey.id,code:'x'}),{statusCode:409});
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:'0'.repeat(64)}),{statusCode:409,message:'Code for this test is being generated. Stop it first.'},'The generator holds the twin a verification needs.');
  await assert.rejects(f.manager.saveModel(f.context,{model:'openai/gpt-5.4-mini'}),{statusCode:409},'The model stays while code is generated.');
  const spec=await settled(f);
  const stored:StoredState=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')),{approved,draft:saved}=Object.values(stored.specs)[0][journey.id];
  assert.deepEqual(spec,{draft:{hash:saved.hash,stale:false,provenance:{harness:'opencode@1.18.32',generator:'playwright-test-generator@1.63.0',model:'openrouter/openai/gpt-4.1-mini'}}});
  assert.equal(validateJourneySpec(saved.code,journey),saved.code);assert.equal(saved.hash,specHash(saved.code));assert.equal(approved,null,'Generated code is only a draft.');
  const [call,...more]=await lines(f.log);
  assert.equal(more.length,0,'One harness run.');
  assert.equal(call.prompt,generatePrompt);
  // The workspace: private, under the browser data dir. OpenCode's project is its own git root with Playwright's
  // generator agent as a primary agent with no other tools; what the seed's process loads is beside it, read-only.
  const workspace=dirname(call.cwd),run=join(workspace,'run');
  assert.equal(call.workspaceMode,0o700);assert.equal(dirname(workspace),join(await realpath(f.dataDir),'browser','generations'));assert.equal(call.cwd,join(workspace,'project'));
  assert.equal(call.git,true);assert.equal(call.prompts,true);
  assert.deepEqual(call.agent,{mode:'primary',model:'openrouter/openai/gpt-4.1-mini',allTools:false});
  assert.deepEqual(call.permission,{edit:'deny',bash:'deny',webfetch:'deny',external_directory:'deny'});
  assert.deepEqual(call.mcp.slice(0,3),[process.execPath,fileURLToPath(new URL('../node_modules/@playwright/test/cli.js',import.meta.url)),'run-test-mcp-server']);
  assert.deepEqual(call.mcp.slice(3),['--headless','--config',join(run,'playwright.config.mjs')]);
  // The only test folder under the project is where the spec is written; no project loads it.
  assert.deepEqual(call.config.projects,[{name:'seed',testDir:join(run,'seed'),testMatch:'seed.spec.mjs'},{name:'tests',testDir:join(call.cwd,'tests'),testIgnore:'**'}]);
  assert.deepEqual(call.modes,{config:0o444,seed:0o444,case:0o444,opencode:0o444,plan:0o444});
  // The fixture's environment as a run passes it, without an event channel; the key and account only in the environment.
  // OpenCode's HOME is the workspace's own; npx and OpenCode keep the user's caches.
  assert.deepEqual(call.env,{key:true,account:'tester@example.com',password:true,channel:null,caseFile:join(run,'case.json'),target:'http://localhost:3000/',
    home:join(workspace,'home'),xdg:null,cache:process.env.XDG_CACHE_HOME||join(userHome,'.cache'),npm:join(userHome,'.npm'),claude:'1'});
  // The test MCP server runs the seed with the user's HOME and without the model key.
  assert.deepEqual(call.mcpEnvironment,{HOME:userHome,OPENROUTER_API_KEY:''});
  assert.match(call.seed,/test\('seed', async \(\{ page, journey \}\) => \{\n  await journey\.signIn\(\);\n\}\);/);
  assert.match(call.plan,/^# Rename the display name\n\n\*\*Seed:\*\* `seed\.spec\.mjs`\n\n\*\*Seed project:\*\* `seed`\n\nGoal: Change my display name and see it kept after a reload\.\n/);
  assert.match(call.plan,/\*\*Steps:\*\*\n1\. Sign in and open Settings \(milestone id: open-settings\)\n2\. Save the display name \(milestone id: save-name\)\n/);
  for(const rule of ["`import { test } from 'perpetual';`",'exactly one `test("Rename the display name", async ({ page, journey }) => { … });`',"`await journey.milestone('<milestone id>', async () => { … });`",'Start the first milestone with `await journey.signIn();`','No variables, `expect` or other assertions',
    'When a step creates or changes data that a later check reads, type a value that includes `journey.run`, such as `` `QA ${journey.run}` ``, never a fixed literal that an earlier run may already have stored.',
    'A check never reads a form field the journey typed into or chose on the current page, nor the fields of a page reached with `goBack` or `goForward`: to see a saved value in a field, reload or open the page again.','`journey.run` names no element or address in this journey, as no milestone follows one whose reviewed check shows or reads `{run}`: type it only with `fill`, `type` or `pressSequentially`.','`page.goto` takes a literal URL or path; `journey.run` never makes its address.',"Locate controls by names that stay the same across runs, apart from this run's own data where `journey.run` may name it: never by a fixed text this journey types or saves, nor by text an earlier run may have saved, such as a name shown in an account menu; when a control's name holds such text, use its stable part, such as a label, an email or a test id.",'Prefer role, label or id locators'])assert.ok(call.plan.includes(rule),rule);
  assert.ok(!call.plan.includes('Reviewed checks read'),'No reviewed check names {run}.');
  assert.deepEqual(await readdir(join(f.dataDir,'browser','generations')),[],'The workspace is removed.');
  assert.ok(secretFree(stored)&&secretFree(await f.manager.view(f.context))&&secretFree(f.manager.summary(f.context))&&secretFree(await lines(f.log)));
  // Opening the stage or restarting never generates again.
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  await restarted.view(f.context);restarted.summary(f.context);await wait(100);
  assert.equal((await lines(f.log)).length,1);
  assert.equal((await restarted.view(f.context)).specs[journey.id]?.generation,undefined);
});

test('a generated draft is approved only after its verification, and regenerating keeps the approved code',async t=>{
  let result='passed';
  // A journey whose checks notice: the control run blocks every change, so its first check fails.
  const events=(input:JourneyRunInput):WorkerEvent[]=>{const passed=result==='passed'&&!input.blockWrites;return [...input.case.steps!.flatMap(step=>[{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'running'},{type:'journey-step',caseId:input.case.id,stepId:step.id,status:passed?'completed':'failed',evidence:'Reviewed checks evaluated.',checks:step.checks!.map(check=>({...check,passed}))}].slice(0,passed||step===input.case.steps![0]?2:0)),{type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:[]}}];};
  const f=await setup(t,{events});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const hash=(await settled(f))!.draft!.hash;
  const approve=()=>f.manager.approveSpec(f.context,{caseId:journey.id,hash});
  await assert.rejects(approve(),{statusCode:409});
  result='failed';
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash});
  assert.equal((await verification(f)).status,'failed');
  await assert.rejects(approve(),{statusCode:409},'A verification that failed approves nothing.');
  result='passed';
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash});
  assert.deepEqual(await verification(f),{status:'passed',passes:3,control:'caught'});
  assert.ok(f.launches.slice(-4).every(input=>input.spec.hash===hash&&input.credentials?.username==='tester@example.com'));assert.equal(f.launches.at(-1)?.blockWrites,true);
  assert.equal((await approve()).spec.approved?.hash,hash);
  // Regenerating writes a new draft beside the approved code, which it never replaces by itself.
  f.state.mode='repair';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const next=(await settled(f))!;
  assert.equal(next.approved?.hash,hash);assert.notEqual(next.draft?.hash,hash);assert.equal(next.draft?.verification,undefined);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:next.draft!.hash}),{statusCode:409});
});
async function verification({manager,context}:{manager:BrowserManager;context:BrowserStageContext}){
  for(let i=0;i<400;i++){const value=(await manager.view(context)).specs[journey.id]?.draft?.verification;if(value&&value.status!=='running')return value;await wait(10);}
  throw new Error('The verification did not finish.');
}

test('an invalid spec is repaired once with only its validation error and the rules',async t=>{
  const f=await setup(t,{mode:'repair'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const spec=(await settled(f))!;
  assert.deepEqual(Object.keys(spec),['draft']);assert.equal(spec.generation,undefined);
  const [first,repair]=await lines(f.log);
  assert.equal(first.prompt,generatePrompt);
  assert.match(repair.prompt,/^The test in `tests\/rename-the-display-name\.spec\.ts` is invalid: Line 8: expect\(\)\.toBeVisible is not an allowed journey action\.\n\nRules:\n- Write JavaScript\./);
  assert.match(repair.prompt,/write the corrected test with generator_write_test to `tests\/rename-the-display-name\.spec\.ts`\.$/);
  assert.ok(!repair.prompt.includes(journey.goal)&&!repair.prompt.includes('milestone id: open-settings'),'Only the error and the rules.');
  assert.ok(repair.prompt.includes('type a value that includes `journey.run`'),'The rules include run-unique values.');
});

test('the plan names the milestones where journey.run may name an element, as the grammar judges them',()=>{
  const item=(checks:{create?:BrowserCase['steps'][number]['checks'];verify?:BrowserCase['steps'][number]['checks']})=>({...journey,
    steps:[{id:'create',title:'Create the item',checks:checks.create||[{type:'text-visible' as const,value:'Saved'}]},{id:'open',title:'Open the item',checks:[]},{id:'verify',title:'See the item kept',checks:checks.verify||[{type:'text-visible' as const,value:'Opened'}]}],
    assertions:[{type:'text-visible' as const,value:'Item {run}'}]});
  const named=item({create:[{type:'text-visible',value:'Item {run}'}]}),late=item({verify:[{type:'text-visible',value:'Item {run}'}]}),none=item({}),absent=item({create:[{type:'text-absent',value:'Could not save Item {run}'}]});
  const from="`journey.run` names an element or a `waitForURL` address only from milestone open on, after milestone create's reviewed check shows or reads `{run}`";
  assert.ok(generationRules(named,{signIn:false}).some(rule=>rule.startsWith(from)));
  for(const other of [late,none,absent]){
    assert.ok(generationRules(other,{signIn:false}).some(rule=>rule.startsWith('`journey.run` names no element or address in this journey')),JSON.stringify(other.steps));
    assert.notEqual(generationPlan(other,{signIn:false}),generationPlan(named,{signIn:false}));
  }
  // Final assertions are judged after every milestone, so they stay apart from the milestone that holds a check.
  assert.ok(generationRules(late,{signIn:false}).includes('Reviewed checks read "Item {run}" in milestone verify; "Item {run}" in the final assertions: type the data they read with `${journey.run}` in place of `{run}`.'));
  // Rules and grammar agree: the same code is accepted exactly where the plan allows it.
  const code="import { test } from 'perpetual';\n\ntest('x', async ({ page, journey }) => {\n  await journey.milestone('create', async () => {\n    await page.getByLabel('Name').fill(`Item ${journey.run}`);\n  });\n  await journey.milestone('open', async () => {\n    await page.getByRole('link', { name: `Item ${journey.run}` }).click();\n  });\n  await journey.milestone('verify', async () => {});\n});\n";
  assert.equal(validateJourneySpec(code,named),code);
  for(const other of [late,none,absent])assert.throws(()=>validateJourneySpec(code,other),/journey\.run names an element or address only after a milestone/);
  // The address rule and the locator rule agree with the grammar too.
  const rules=generationRules(named,{signIn:false});
  assert.ok(rules.includes('`page.goto` takes a literal URL or path; `journey.run` never makes its address.'));
  assert.ok(!rules.some(rule=>rule.includes('never by text this journey types or saves')),'This run\'s own data may be located by journey.run where the grammar allows it.');
  assert.ok(rules.some(rule=>rule.startsWith('Locate controls by names that stay the same across runs, apart from this run\'s own data where `journey.run` may name it: never by a fixed text this journey types or saves')));
});

test('the plan and a repair name the reviewed check texts that hold {run}, to be typed with journey.run',()=>{
  const unique={...journey,steps:[journey.steps[0],{...journey.steps[1],checks:[{type:'text-visible' as const,value:'Signed in as  QA {run}'},{type:'read-number' as const,label:'Tasks of QA {run}',name:'tasks'}]}],assertions:[{type:'text-visible' as const,value:'Signed in as QA {run}'},{type:'text-absent' as const,value:'Original Name'}]};
  const rule='Reviewed checks read "Signed in as QA {run}", "Tasks of QA {run}" in milestone save-name; "Signed in as QA {run}" in the final assertions: type the data they read with `${journey.run}` in place of `{run}`.';
  assert.ok(generationRules(unique,{signIn:true}).includes(rule));
  assert.ok(generationPlan(unique,{signIn:true}).includes(`- ${rule}\n`));
  assert.ok(!generationRules(journey,{signIn:true}).some(item=>item.startsWith('Reviewed checks read')));
  // The rules keep checks out of the code: the token is the one value an argument reads.
  assert.ok(generationRules(unique,{signIn:false}).some(item=>item.includes('No variables, `expect` or other assertions')&&item.includes('Perpetual evaluates the reviewed checks itself')));
});

test('a spec still invalid after its repair fails with the validation message and saves nothing',async t=>{
  const f=await setup(t,{mode:'invalid'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const failed=(await settled(f))!;
  // What the generator wrote stays visible with the failure.
  assert.match(failed.generation?.rejected??'',/expect\(/);
  assert.deepEqual({...failed,generation:{...failed.generation,rejected:undefined}},{generation:{status:'failed',error:'The generated code is invalid: Line 8: expect().toBeVisible is not an allowed journey action.',rejected:undefined}});
  assert.equal((await lines(f.log)).length,2);
  const stored:StoredState=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));
  assert.deepEqual(Object.values(stored.specs).flatMap(Object.keys),[]);
  // A later generation starts over.
  f.state.mode='valid';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal((await settled(f))?.draft?.stale,false);
});

test('a harness that stops reports its redacted output; the key and password appear nowhere',async t=>{
  const f=await setup(t,{mode:'fail'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const {generation}=(await settled(f))!;
  assert.equal(generation?.status,'failed');
  assert.equal(generation?.error,'The code generator stopped. Provider rejected key [REDACTED] for [REDACTED]');
  assert.ok(secretFree(await f.manager.view(f.context))&&secretFree(await readFile(join(f.dataDir,'browser','state.json'),'utf8')));
});

test('a failed generation stays explained beside its stale draft after restart without running the model again',async t=>{
  const f=await setup(t,{mode:'fail'});
  await f.manager.saveSpec(f.context,{caseId:journey.id,code:codeFor(journey)});
  await f.manager.saveCases(f.context,[{...journey,expectedOutcomes:['The changed display name is kept after reopening Settings.']}]);
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const failed=(await settled(f))!;
  assert.equal(failed.draft?.stale,true);
  assert.equal(failed.generation?.status,'failed');
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  assert.deepEqual((await restarted.view(f.context)).specs[journey.id],failed);
  assert.equal(restarted.isActive(f.context),false);
  await wait(100);
  assert.equal((await lines(f.log)).length,1,'A restored failure starts no paid generation.');
  assert.ok(secretFree(await readFile(join(f.dataDir,'browser','state.json'),'utf8')));
});

test('an accepted replacement generation clears an older failure even when the replacement is cancelled',async t=>{
  const f=await setup(t,{mode:'fail'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal((await settled(f))?.generation?.status,'failed');
  f.state.mode='hang';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  await f.manager.cancelSpecGeneration(f.context,{caseId:journey.id});
  assert.equal(await settled(f),undefined);
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  assert.equal((await restarted.view(f.context)).specs[journey.id],undefined);
});

test('saving code or replacing its reviewed case removes an obsolete generation failure across restart',async t=>{
  for(const change of ['code','case','delete'] as const)await t.test(change,async t=>{
    const f=await setup(t,{mode:'fail'});
    await f.manager.generateSpec(f.context,{caseId:journey.id});
    assert.equal((await settled(f))?.generation?.status,'failed');
    if(change==='code')await f.manager.saveSpec(f.context,{caseId:journey.id,code:codeFor(journey)});
    else await f.manager.saveCases(f.context,change==='delete'?[]:[{...journey,expectedOutcomes:['The new reviewed outcome.']}]);
    assert.equal((await f.manager.view(f.context)).specs[journey.id]?.generation,undefined);
    await f.manager.close();
    const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
    if(change==='delete')await restarted.saveCases(f.context,[journey]);
    assert.equal((await restarted.view(f.context)).specs[journey.id]?.generation,undefined);
  });
});

test('an in-flight generation failure cannot attach itself to a replacement case',async t=>{
  let rejectSeed:((error:Error)=>void)|undefined;
  const f=await setup(t,{playwright:{capabilities:async()=>({browserInstalled:true}),start(){return {promise:new Promise<void>((_,reject)=>{rejectSeed=reject;}),cancel(){rejectSeed?.(new Error('Cancelled.'));}};}}});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  for(let i=0;i<100&&!rejectSeed;i++)await wait(10);
  assert.ok(rejectSeed);
  await f.manager.saveCases(f.context,[{...journey,expectedOutcomes:['A different reviewed outcome.']}]);
  rejectSeed(new Error('The original seed failed.'));
  assert.equal(await settled(f),undefined);
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  assert.equal((await restarted.view(f.context)).specs[journey.id],undefined);
});

test('discovery replacing a case cannot attach its old generation failure to the new journey',async t=>{
  const f=await setup(t,{mode:'fail',runtime:{capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(_input,onEvent){
    return {promise:Promise.resolve().then(()=>{onEvent({type:'discovery',summary:'A new Settings journey.',cases:[{...journey,expectedOutcomes:['The new reviewed outcome.']}]});}),cancel(){}};
  }}});
  await f.manager.generateSpec(f.context,{caseId:journey.id});assert.equal((await settled(f))?.generation?.status,'failed');
  const {run}=await f.manager.discover(f.context,{accountId:null,replaceCaseIds:[journey.id],baseCases:(await f.manager.view(f.context)).cases});
  for(let i=0;i<100&&f.manager.isActive(f.context);i++)await wait(10);
  assert.equal((await f.manager.runProgress(f.context,run.id)).run.status,'completed');
  const view=await f.manager.view(f.context);
  assert.equal(view.cases[0].id,journey.id);assert.equal(view.cases[0].needsReview,true);
  assert.equal(view.specs[journey.id],undefined,'A replaced journey must not inherit the old generation error.');
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  assert.equal((await restarted.view(f.context)).specs[journey.id],undefined);
});

test('a generation failure that cannot be saved keeps its original cause and an explicit storage error',async t=>{
  let rejectSeed:((error:Error)=>void)|undefined;
  const f=await setup(t,{playwright:{capabilities:async()=>({browserInstalled:true}),start(){return {promise:new Promise<void>((_,reject)=>{rejectSeed=reject;}),cancel(){rejectSeed?.(new Error('Cancelled.'));}};}}});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  for(let i=0;i<100&&!rejectSeed;i++)await wait(10);
  assert.ok(rejectSeed);
  const file=join(f.dataDir,'browser','state.json'),saved=await readFile(file,'utf8');
  await rm(file);await mkdir(file);
  try{
    rejectSeed(new Error('The seed could not sign in.'));
    const result=await settled(f);
    assert.equal(result?.generation?.status,'failed');
    assert.match(result?.generation?.error??'',/The seed could not sign in\./);
    assert.match(result?.generation?.error??'',/generation failure could not be saved/i);
    assert.equal(f.manager.isActive(f.context),false);
    assert.equal((await lines(f.log)).length,0);
  }finally{await rm(file,{recursive:true});await writeFile(file,saved);}
});

test('a refused generation cannot restore an unsaved old failure onto a replacement case',async t=>{
  let rejectSeed:((error:Error)=>void)|undefined,refuseNext=false,refuse:((value:{browserInstalled:boolean})=>void)|undefined;
  const f=await setup(t,{playwright:{capabilities:async()=>refuseNext?new Promise(resolve=>{refuseNext=false;refuse=resolve;}):{browserInstalled:true},start(){return {promise:new Promise<void>((_,reject)=>{rejectSeed=reject;}),cancel(){rejectSeed?.(new Error('Cancelled.'));}};}}});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  for(let i=0;i<100&&!rejectSeed;i++)await wait(10);
  assert.ok(rejectSeed);
  const file=join(f.dataDir,'browser','state.json'),saved=await readFile(file,'utf8');
  await rm(file);await mkdir(file);
  try{rejectSeed(new Error('The original seed failed.'));assert.match((await settled(f))?.generation?.error??'',/could not be saved/);}
  finally{await rm(file,{recursive:true});await writeFile(file,saved);}
  refuseNext=true;
  const rejected=assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),/Install Chromium/);
  for(let i=0;i<100&&!refuse;i++)await wait(10);
  assert.ok(refuse);
  await f.manager.saveCases(f.context,[{...journey,expectedOutcomes:['A different reviewed outcome.']}]);
  refuse({browserInstalled:false});await rejected;
  assert.equal((await f.manager.view(f.context)).specs[journey.id],undefined);
  assert.equal(f.manager.isActive(f.context),false);
});

test('stored generation failures are bounded, redacted before clipping and validated as data',async t=>{
  const f=await setup(t,{mode:'fail'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});await settled(f);await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),stored=JSON.parse(await readFile(file,'utf8'));
  const failures=Object.values(stored.generationFailures)[0] as Record<string,{caseHash:string;error:string;rejected?:string}>;
  failures[journey.id].error=`${'x'.repeat(795)}${key}end`;
  failures[journey.id].rejected=`${'x'.repeat(19995)}${key}end`;
  await writeFile(file,JSON.stringify(stored));
  const restarted=await createBrowserManager(f.options());
  try{
    const generation=(await restarted.view(f.context)).specs[journey.id].generation!;
    assert.equal(generation.status,'failed');
    assert.equal(generation.error?.length,800);assert.equal(generation.rejected?.length,20000);
    assert.doesNotMatch(generation.error??'',/or-fi/,'Clip only after hiding the whole configured key.');
    assert.doesNotMatch(generation.rejected??'',/or-fi/);
    assert.ok(secretFree(await readFile(file,'utf8')));
  }finally{await restarted.close();}
  stored.generationFailures={invalid:{[journey.id]:{caseHash:'not-a-hash',error:12}}};
  await writeFile(file,JSON.stringify(stored));
  await assert.rejects(createBrowserManager(f.options()),/Unsupported code generation failure state/);
});

test('a harness that exits successfully without a spec keeps redacted diagnostics from both attempts',async t=>{
  const f=await setup(t,{mode:'missing'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const {generation}=(await settled(f))!;
  assert.equal(generation?.status,'failed');
  assert.match(generation?.error??'',/No test file was written/);
  assert.match(generation?.error??'',/generator_setup_page: The seed could not pause/);
  assert.match(generation?.error??'',/generator_write_test: No test runner found/);
  assert.ok(secretFree(await f.manager.view(f.context)));
  assert.equal((await lines(f.log)).length,2,'Diagnostics do not add another generation attempt.');
  assert.deepEqual(await readdir(join(f.dataDir,'browser','generations')),[],'A cleaned worker leaves no credential-bearing workspace.');
});

test('cancelling or timing out kills the harness’s whole process tree',async t=>{
  const f=await setup(t,{mode:'hang',timeoutMs:60000});
  const pidsOf=async(count:number)=>{for(let i=0;i<200;i++){const found=(await lines(f.log)).filter(line=>line.pids);if(found.length>=count)return found.at(-1)!.pids!;await wait(50);}throw new Error('The harness did not start.');};
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const pids=await pidsOf(1);
  assert.ok(pids.every(alive));
  // The generator holds the twin like a run.
  await assert.rejects(f.manager.run(f.context,{},{manual:true}),{statusCode:409});
  assert.equal((await f.manager.cancelSpecGeneration(f.context,{caseId:journey.id})).specs[journey.id].generation?.step,'cancelling');
  assert.equal(await settled(f),undefined,'A cancelled generation leaves no state.');
  assert.ok(!pids.some(alive),'The harness and its child are gone.');
  assert.equal(f.manager.isActive(f.context),false);
  await f.manager.close();
  const short=await createBrowserManager({...f.options(),generation:{...f.options().generation,timeoutMs:1500}});t.after(()=>short.close());
  await short.generateSpec(f.context,{caseId:journey.id});
  const timed=await pidsOf(2);
  const {generation}=(await settled({manager:short,context:f.context}))!;
  assert.deepEqual(generation,{status:'failed',error:'Code generation exceeded its time limit.'});
  assert.ok(!timed.some(alive));
  await assert.rejects(short.cancelSpecGeneration(f.context,{caseId:journey.id}),{statusCode:404});
});

test('code generation requires review and a model, and an owned twin must be ready and belong to the stage',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:'missing'}),{statusCode:404});
  await f.manager.saveCases(f.context,[{...journey,needsReview:true,selected:false}]);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),/Review this test before generating its code\./);
  await f.manager.saveCases(f.context,[journey]);
  for(const overrides of [{status:'creating'},{stageId:'gamma'}]){
    Object.assign(f.environment,{status:'ready',stageId:'beta',...overrides});
    await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409,message:'Set the application URL to this stage’s ready twin first.'},JSON.stringify(overrides));
  }
  Object.assign(f.environment,{status:'ready',stageId:'beta'});
  assert.equal((await lines(f.log)).length,0,'No harness ran.');
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-generation-nomodel-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const bare=await createBrowserManager({...f.options(),dataDir});t.after(()=>bare.close());
  await bare.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});await bare.saveCases(f.context,[journey]);
  if(!process.env.OPENROUTER_API_KEY&&!process.env.PERPETUAL_MODEL_API_KEY)await assert.rejects(bare.generateSpec(f.context,{caseId:journey.id}),/Add your OpenRouter API key in Settings first\./);
  // Deleting the case stops its generation.
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});
  f.state.mode='hang';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  await f.manager.saveCases(f.context,[]);
  for(let i=0;i<200&&f.manager.isActive(f.context);i++)await wait(50);
  assert.equal(f.manager.isActive(f.context),false);
});

test('code generation for an existing URL accepts a temporary test account without a twin',async t=>{
  const f=await setup(t);
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:4000/',signInUrl:'http://localhost:4000/login'});
  await f.manager.generateSpec(f.context,{caseId:journey.id,credentials:{username:'manual@example.test',password:'manual-fixture-password'}});
  assert.equal((await settled(f))?.draft?.stale,false);
  assert.deepEqual(f.launches.map(input=>({targetUrl:input.targetUrl,signInUrl:input.signInUrl,credentials:input.credentials})),[
    {targetUrl:'http://localhost:4000/',signInUrl:'http://localhost:4000/login',credentials:{username:'manual@example.test',password:'manual-fixture-password'}},
  ]);
  assert.doesNotMatch(await readFile(join(f.dataDir,'browser','state.json'),'utf8'),/manual@example\.test|manual-fixture-password/);
});

test('code generation validates explicit account choices and can opt out of a twin account',async t=>{
  const f=await setup(t);
  for(const input of [{accountId:'missing'},{accountId:1},{credentials:{username:'u',password:'p'},accountId:'owner'}]) {
    await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id,...input}),/account/i);
    assert.equal(f.manager.isActive(f.context),false,'Invalid account input must release its reservation.');
  }
  await f.manager.generateSpec(f.context,{caseId:journey.id,accountId:null});
  assert.equal((await settled(f))?.draft?.stale,false);
  assert.equal(f.launches.length,0,'No sign-in seed is run when the person chooses no account.');
});

test('stored journeys without checks refuse code generation and verification before starting work',async t=>{
  const f=await setup(t);
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),stored=JSON.parse(await readFile(file,'utf8'));
  const cases=Object.values(stored.cases)[0] as BrowserCase[];
  cases[0].steps=cases[0].steps.map(({checks,...step})=>step);
  await writeFile(file,JSON.stringify(stored));
  const manager=await createBrowserManager(f.options());t.after(()=>manager.close());
  assert.equal((await manager.view(f.context)).cases[0].needsReview,false,'Historical cases are preserved.');
  await assert.rejects(manager.generateSpec(f.context,{caseId:journey.id}),/check/i);
  await assert.rejects(manager.verifySpec(f.context,{caseId:journey.id,hash:'0'.repeat(64)}),/check/i);
  assert.equal(manager.isActive(f.context),false);
  assert.equal((await lines(f.log)).length,0);
});

test('a seed that cannot sign in stops the generation before the generator runs, and saves nothing',async t=>{
  let signedIn=false;
  // As the reporter lists it, the seed's one action is the sign-in.
  const events:Events=input=>[{type:'case',caseId:input.case.id,actions:[{type:'sign_in_with_test_account',status:signedIn?'passed':'failed'}]},
    {type:'result',result:{caseId:input.case.id,assertions:[],...(signedIn?{stopCause:'none'}:{stopCause:'action',error:'The application URL shows no sign-in form. Set the sign-in page.'})}}];
  const f=await setup(t,{events});
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/',signInUrl:'http://localhost:3000/login',journeyTimeoutSeconds:60});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.deepEqual(await settled(f),{generation:{status:'failed',error:'The test account could not sign in: The application URL shows no sign-in form. Set the sign-in page.'}});
  assert.equal((await lines(f.log)).length,0,'No model call was spent.');
  assert.deepEqual(Object.values<object>(JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).specs).flatMap(Object.keys),[]);
  // The seed ran once as a journey runs: the twin's account, the stage's sign-in page, no write blocking.
  const [seed,...more]=f.launches;
  assert.equal(more.length,0);
  assert.deepEqual([seed.mode,seed.spec.code,seed.spec.hash,seed.case.id,seed.credentials?.username,seed.signInUrl,seed.targetUrl,seed.timeoutSeconds,seed.blockWrites],
    ['run',seedSpec(true),specHash(seedSpec(true)),journey.id,'tester@example.com','http://localhost:3000/login','http://localhost:3000/',60,undefined]);
  assert.ok(secretFree(await f.manager.view(f.context)));
  // Once the seed signs in, the generator runs; without a test account there is no seed to check.
  signedIn=true;
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal((await settled(f))?.draft?.stale,false);
  assert.deepEqual([f.launches.length,(await lines(f.log)).length],[2,1]);
  f.environment.accounts=[];
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal((await settled(f))?.draft?.stale,false);
  assert.deepEqual([f.launches.length,(await lines(f.log)).length],[2,2]);
});

test('cancelling a generation while its seed signs in stops the seed, and the generator never starts',{timeout:60000},async t=>{
  // A seed that only ends once it is cancelled.
  const seeds:{cancelled:boolean}[]=[];
  const playwright:JourneyRuntime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(){
    const seed={cancelled:false};let stop=()=>{};seeds.push(seed);
    return {promise:new Promise<void>((_resolve,reject)=>{stop=()=>reject(new Error('Browser operation cancelled.'));}),cancel(){seed.cancelled=true;stop();}};
  }};
  const started=async(count:number)=>{for(let i=0;i<400&&seeds.length<count;i++)await wait(50);assert.equal(seeds.length,count,'The seed started.');};
  const f=await setup(t,{playwright});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  await started(1);
  assert.equal((await f.manager.cancelSpecGeneration(f.context,{caseId:journey.id})).specs[journey.id].generation?.step,'cancelling');
  assert.equal(await settled(f),undefined,'A cancelled generation leaves no state.');
  assert.deepEqual([seeds[0].cancelled,(await lines(f.log)).length,f.manager.isActive(f.context)],[true,0,false]);
  // Its job says it was cancelled.
  const workspace=await mkdtemp(join(tmpdir(),'perpetual-seed-cancel-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const job=generateJourneySpec({workspace,item:journey,targetUrl:'http://localhost:3000/',timeoutSeconds:60,credentials:{username:'tester@example.com',password},apiKey:key,model,playwright,
    harness:({model:requested,prompt})=>({command:process.execPath,args:[fake,'valid',f.log,prompt,requested]})});
  await started(2);
  job.cancel();
  await assert.rejects(job.promise,{message:'Code generation cancelled.'});
  assert.deepEqual([seeds[1].cancelled,(await lines(f.log)).length],[true,0]);
});

test('a seed whose browser outlives its cancel keeps its cleanup failure, so the twin is marked uncertain',{timeout:60000},async t=>{
  // The seed's browser does not exit within the grace period once it is cancelled, as the worker supervisor reports it.
  let seeds=0;
  const started=async(count:number)=>{for(let i=0;i<400&&seeds<count;i++)await wait(50);assert.equal(seeds,count,'The seed started.');};
  const playwright:JourneyRuntime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(){
    let stop=()=>{};seeds++;
    return {promise:new Promise<void>((_resolve,reject)=>{stop=()=>reject(Object.assign(new Error('Browser operation cancelled. Cleanup incomplete after forced termination; an owned browser or temporary profile may remain.'),{cleanupIncomplete:true}));}),cancel(){stop();}};
  }};
  const f=await setup(t,{playwright});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  await started(1);
  await f.manager.cancelSpecGeneration(f.context,{caseId:journey.id});
  assert.equal(await settled(f),undefined);
  assert.deepEqual(f.uncertain,[f.environment.id]);
  // The job says it was cancelled, with the cleanup failure.
  const workspace=await mkdtemp(join(tmpdir(),'perpetual-seed-cleanup-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const job=generateJourneySpec({workspace,item:journey,targetUrl:'http://localhost:3000/',timeoutSeconds:60,credentials:{username:'tester@example.com',password},apiKey:key,model,playwright,
    harness:({model:requested,prompt})=>({command:process.execPath,args:[fake,'valid',f.log,prompt,requested]})});
  await started(2);job.cancel();
  await assert.rejects(job.promise,{message:'Code generation cancelled.',cleanupIncomplete:true});
});

test('a spec is accepted only while the workspace the generator cannot write is unchanged',async t=>{
  const f=await setup(t,{mode:'tamper'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.deepEqual(await settled(f),{generation:{status:'failed',error:'The code generation workspace changed.'}});
  assert.equal((await lines(f.log)).length,1,'No repair run.');
  assert.deepEqual(Object.values<object>(JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).specs).flatMap(Object.keys),[]);
});

// The generation workspace's seed, run by the pinned test MCP server as the generator's setup does, against a real app
// whose URL is a landing page: its sign-in form is at /login.
function application():Promise<{server:http.Server;signedIn:()=>number;url:string}>{
  let signedIn=0;
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const url=new URL(req.url!,'http://app'),session=/session=1/.test(req.headers.cookie||''),form=new URLSearchParams(body);
      const send=(html:string)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><body>${html}</body>`);};
      if(url.pathname==='/login'&&req.method==='POST'){if(form.get('email')==='tester@example.com'&&form.get('password')===password){signedIn++;res.writeHead(303,{location:'/settings','set-cookie':'session=1; Path=/'});}else res.writeHead(303,{location:'/login'});return res.end();}
      if(url.pathname==='/login')return send('<form method=post action=/login><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>');
      if(!session&&url.pathname==='/')return send('<h1>Plan your week</h1><a href="/login">Sign in</a>');
      if(!session){res.writeHead(303,{location:'/login'});return res.end();}
      send('<h1>Settings</h1><button>Save</button>');
    });
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,signedIn:()=>signedIn,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/`})));
}

test('the test MCP server’s seed signs in with the twin account on the sign-in page, and a generator can write no code that runs beside it',{timeout:180000},async t=>{
  const playwright=createPlaywrightRuntime();
  if(!(await playwright.capabilities()).browserInstalled)return t.skip('Chromium for Playwright is not installed.');
  const app=await application();t.after(()=>{app.server.closeAllConnections();app.server.close();});
  const f=await setup(t,{mode:'seed',target:app.url,playwright});
  // Without the sign-in page, the landing page stops the generation before the generator runs.
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.deepEqual(await settled(f,journey.id,90),{generation:{status:'failed',error:'The test account could not sign in: The application URL shows no sign-in form. Set the sign-in page.'}});
  assert.deepEqual([(await lines(f.log)).length,app.signedIn()],[0,0]);
  await f.manager.saveConfig(f.context,{targetUrl:app.url,signInUrl:`${app.url}login`,journeyTimeoutSeconds:60});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const spec=(await settled(f,journey.id,90))!;
  const [{generation}]=await lines(f.log);
  // Both setups paused on the signed-in page; nothing the generator wrote ran, and no tool output held the password.
  assert.deepEqual(generation.setups,[false,false],JSON.stringify(generation));
  assert.equal(app.signedIn(),3,'The seed signed in once before the generator started, then once in each setup, with the twin account.');
  assert.ok(Object.values(generation.refused).every(Boolean),JSON.stringify(generation.refused));
  assert.ok(Object.values(generation.written).every(error=>!error),JSON.stringify(generation.written));
  assert.deepEqual([generation.wrote,generation.leaked,generation.exposed],[false,false,false]);
  assert.deepEqual([Object.keys(spec),Object.keys(spec.draft!)],[['draft'],['hash','stale','provenance']],JSON.stringify(spec));
  await access(join(f.dataDir,'browser','generations')).then(async()=>assert.deepEqual(await readdir(join(f.dataDir,'browser','generations')),[]));
});

test('a seed whose application does not open says so, never that the test account could not sign in',{timeout:120000},async t=>{
  const playwright=createPlaywrightRuntime();
  if(!(await playwright.capabilities()).browserInstalled)return t.skip('Chromium for Playwright is not installed.');
  // A port nothing listens on any more.
  const closed=http.createServer();await new Promise<void>(resolve=>closed.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(closed.address() as AddressInfo).port}/`;await new Promise(resolve=>closed.close(resolve));
  const f=await setup(t,{mode:'seed',target:url,playwright});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.deepEqual(await settled(f,journey.id,90),{generation:{status:'failed',error:`The application could not be opened: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`}});
  assert.equal((await lines(f.log)).length,0,'No model call was spent.');
});
