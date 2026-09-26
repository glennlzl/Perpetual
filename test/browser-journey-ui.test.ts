import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationAttempt, watchedRun, browserActionError, browserActionFailure, browserActionLabel, browserBlockers, browserCaseState, browserConcurrencyLabel, browserFrameLabel, browserInstallCommand, browserJourneySteps, browserReadiness, browserRunLabel, browserUnavailable, checkedOutcome, generateRequestDialog, inspectorTab, JOURNEY_GENERATE_REQUEST, journeyActions, journeyCheckState, journeyCode, journeyElapsed, journeyErrorTone, journeyLastAction, journeyOpenByDefault, journeyQueueLabel, journeyRecordings, journeyRequest, journeyRevision, journeyRunRequest, journeySegments, journeySummary, orderJourneys, browserCaseRun, codeLines, runnableCode, runReady, stageJourneyGroups, testToolbar } from '../client/src/lib/browser-test-ui.ts';
import type { BrowserCase, BrowserRun, CaseProgress, CodeVerification, JourneySpec, JourneyStep } from '../client/src/lib/browser-test-ui.ts';

const journey = { id:'happy', name:'Create and run a workflow', goal:'Execute the workflow and verify credit usage', preconditions:['Test account'], expectedOutcomes:['Result delivered and credits debited'], assertions:[], steps:[{id:'login',title:'Sign in'},{id:'execute',title:'Execute workflow'}], isolation:'shared', needsReview:false } satisfies BrowserCase;
const run = (status: string, cases: CaseProgress[], extra: Partial<BrowserRun> = {}): BrowserRun => ({id:'run',mode:'run',status,createdAt:'2026-09-23T00:00:00Z',caseIds:['happy','payment'],caseSummaries:[journey],progress:{cases},...extra});

test('a queued journey stays queued while another journey is running', () => {
  assert.equal(browserCaseState(journey,[run('running',[{id:'happy',status:'queued'},{id:'payment',status:'running'}])]).status,'queued');
});
test('edited milestones cannot inherit a successful old result', () => {
  const edited={...journey,steps:[...journey.steps,{id:'reopen',title:'Reopen and verify the saved result'}]};
  assert.notEqual(browserCaseState(edited,[run('passed',[],{results:[{caseId:'happy',status:'passed'}]})]).status,'passed');
});
test('a terminal run cannot leave its journey looking actively running', () => {
  assert.equal(browserCaseState(journey,[run('failed',[{id:'happy',status:'running'}])]).status,'failed');
});
test('skip cleanup has a distinct state and does not become success', () => {
  assert.equal(browserCaseState(journey,[run('running',[{id:'happy',status:'skipping'}])]).label,'Skipping…');
  assert.equal(browserCaseState(journey,[run('skipped',[{id:'happy',status:'skipped'}])]).label,'Skipped');
});
test('a finished run with skipped journeys is never labelled discovery or passing', () => {
  assert.equal(browserRunLabel({mode:'run',status:'completed'}),'Finished with skips');
  assert.equal(browserRunLabel({mode:'discover',status:'completed'}),'Cases ready');
  assert.equal(browserRunLabel({mode:'run',status:'blocked'}),'Blocked');
});
test('an uncertain terminal result cannot leave a milestone spinning', () => {
  assert.equal(browserJourneySteps(journey,{steps:[{id:'login',status:'running'}]},'needs_review')[0].status,'unconfirmed');
});

test('a run result needing review is distinct from an unreviewed draft', () => {
  const draft = browserCaseState({...journey,needsReview:true},[]);
  assert.deepEqual([draft.status,draft.label],['needs_review','Needs review']);
  const result = browserCaseState(journey,[run('needs_review',[{id:'happy',status:'needs_review'}],{results:[{caseId:'happy',status:'needs_review'}]})]);
  assert.deepEqual([result.status,result.label],['needs_review','Review result']);
});
test('a finished journey replays its recordings while a live one keeps its frames', () => {
  const files = ['page@' + 'b'.repeat(32) + '.webm', 'page@' + 'a'.repeat(32) + '.webm'];
  const recorded = { ...run('passed', [{ id:'happy', status:'passed', videos:files }]), id:'run/1' };
  const request = { repoPath:'/repo path', stageId:'beta', run:recorded, caseId:'happy' };
  for (const status of ['queued', 'running', 'skipping']) assert.deepEqual(journeyRecordings({ ...request, status }), [], status);
  assert.deepEqual(journeyRecordings({ ...request, run:run('passed', [{ id:'happy', status:'passed' }]), status:'passed' }), []);
  assert.deepEqual(journeyRecordings({ ...request, run:undefined, status:'passed' }), []);
  const urls = journeyRecordings({ ...request, status:'passed' });
  assert.deepEqual(urls.map(url => new URL(url, 'http://127.0.0.1').searchParams.get('file')), files);
  assert.equal(urls[0], `/api/browser/runs/run%2F1/video?repoPath=%2Frepo+path&stageId=beta&caseId=happy&file=${files[0].replace('@', '%40')}`);
});
test('a blocked journey is neither passed nor failed', () => {
  const state = browserCaseState(journey,[run('blocked',[{id:'happy',status:'blocked'}],{results:[{caseId:'happy',status:'blocked',blockers:[{kind:'account',evidence:'No test account'}]}]})]);
  assert.deepEqual([state.status,state.label,state.variant],['blocked','Blocked','outline']);
});
test('the viewport says Review to run only before any run exists', () => {
  assert.equal(browserFrameLabel({status:'needs_review'}),'Review to run');
  assert.equal(browserFrameLabel({status:'needs_review',runId:'run'}),'No browser frame');
  assert.equal(browserFrameLabel({status:'running',runId:'run'}),'Opening browser…');
  assert.equal(browserFrameLabel({status:'running',runId:'run',image:true,fresh:true}),'Live');
  assert.equal(browserFrameLabel({status:'running',runId:'run',image:true,error:'Stream unavailable'}),'Reconnecting');
  assert.equal(browserFrameLabel({status:'passed',runId:'run',image:true}),'Last frame');
});
test('payment live-mode rejections and progress failures have readable labels', () => {
  assert.equal(browserActionError('payment_live_mode_rejected'),'Live payment blocked');
  assert.equal(browserActionError('journey_progress_invalid'),'Invalid journey progress');
  assert.equal(browserActionError('toString'),'');
  assert.equal(browserActionLabel('input_text'),'Enter text');
  assert.equal(browserActionLabel('report_journey_step'),'Report milestone');
  assert.equal(browserActionLabel('sign_in_with_test_account'),'Sign in');
  assert.equal(browserActionLabel('reload_page'),'Reload');
  assert.equal(browserActionLabel('custom_tool'),'custom tool');
});
test('every worker action failure code is kept by the controller and labelled in the client', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  const runner = (await source('../integrations/browser-use/runner.py')).match(/^ACTION_FAILURES = \{\n([\s\S]*?)\n\}/m)![1];
  const worker = [...runner.matchAll(/^\s+"([a-z_]+)":/gm)].map(match => match[1]);
  const controller = JSON.parse((await source('../src/browser/manager.ts')).match(/const actionErrorCodes(?::[^=]+)?=new Set(?:<[^>]*>)?\((\[[^\]]*\])\)/)![1].replaceAll("'", '"'));
  assert.ok(worker.includes('credential_field_unavailable') && worker.includes('navigation_not_allowed'));
  // The controller still accepts a retired code that stored runs contain.
  assert.deepEqual([...controller].sort(), [...worker, 'journey_progress_invalid'].sort());
  for (const code of worker) assert.notEqual(browserActionError(code), '', code);
});

const checks: JourneyStep = { id:'credits', title:'Verify credits decreased', checks:[{type:'read-number',label:'Credits',name:'creditsAfter'},{type:'compare-number',label:'Credits',name:'creditsDelta',op:'<',than:'creditsBefore'},{type:'text-visible',value:'Run complete'}] };
const priced: BrowserCase = {...journey,steps:[{id:'balance',title:'Record starting credits',checks:[{type:'read-number',label:'Credits',name:'creditsBefore'}]},checks]};
test('milestone checks show independent results with observed numbers', () => {
  const steps = browserJourneySteps(priced,{steps:[
    {id:'balance',status:'completed',evidence:'Balance shows 120',checks:[{type:'read-number',label:'Credits',name:'creditsBefore',passed:true,observed:120}]},
    {id:'credits',status:'failed',evidence:'Workflow finished',checks:[{type:'read-number',label:'Credits',name:'creditsAfter',passed:true,observed:100},{type:'compare-number',label:'Credits',name:'creditsDelta',op:'<',than:'creditsBefore',passed:true,observed:100},{type:'text-visible',value:'Run complete',passed:false,error:'Text not visible'}]},
  ]},'failed');
  assert.deepEqual(steps.map(step => step.status),['completed','failed']);
  assert.equal(steps[0].checks[0].text,'Credits 120');
  assert.equal(steps[1].checks[1].text,'Credits 120 → 100');
  assert.deepEqual(steps[1].checks.map(check => check.result),['Passed','Passed','Failed']);
  assert.equal(steps[1].checks[2].error,'Text not visible');
  assert.equal(steps[0].evidence,'Balance shows 120');
});
test('unevaluated checks stay explicitly unchecked', () => {
  const [first] = browserJourneySteps(priced,{steps:[{id:'balance',status:'pending',checks:priced.steps![0].checks}]},'running');
  assert.equal(first.checks[0].result,'Not checked');
  assert.equal(first.checks[0].text,'Credits');
  const [, second] = browserJourneySteps(priced,null,'not_run');
  assert.equal(second.checks[1].text,'Credits < creditsBefore');
});

test('milestone segments fill only on observed completion', () => {
  const segments = journeySegments([{id:'a',status:'completed'},{id:'b',status:'running'},{id:'c',status:'blocked'},{id:'d',status:'failed'},{id:'e',status:'unconfirmed'},{id:'f',status:'pending'}]);
  assert.deepEqual(segments.map(item => item.state),['observed','current','blocked','failed','pending','pending']);
});
test('journey summaries report real milestone progress only', () => {
  const steps = [{id:'a',title:'Sign in',status:'completed'},{id:'b',title:'Execute workflow',status:'running'},{id:'c',title:'Check credits',status:'pending'}];
  assert.equal(journeySummary(steps,'running').text,'1/3 · Execute workflow');
  assert.equal(journeySummary(steps.map(step => step.status === 'running' ? {...step,status:'pending'} : step),'running').text,'1/3');
  assert.equal(journeySummary(steps,'queued').text,'');
  assert.equal(journeySummary(steps.map(step => ({...step,status:'completed'})),'passed').text,'3/3 observed');
  const blocked = journeySummary([steps[0],{...steps[1],status:'blocked'},steps[2]],'blocked');
  assert.deepEqual([blocked.text,blocked.status],['Execute workflow','blocked']);
  assert.equal(journeySummary([{...steps[0],status:'failed'}],'failed').text,'Sign in');
  assert.equal(journeySummary([],'running').text,'');
});
test('elapsed time is plain clock text', () => {
  assert.equal(journeyElapsed('2026-09-23T00:00:00Z',Date.parse('2026-09-23T00:01:05Z')),'01:05');
  assert.equal(journeyElapsed('2026-09-23T00:00:00Z',Date.parse('2026-09-23T01:02:03Z')),'1:02:03');
  assert.equal(journeyElapsed('',Date.now()),'');
  assert.equal(journeyElapsed('2026-09-23T00:00:10Z',Date.parse('2026-09-23T00:00:00Z')),'00:00');
});
test('queue reasons and the latest action come from real progress', () => {
  assert.equal(journeyQueueLabel('shared-data'),'Waiting for shared test data');
  assert.equal(journeyQueueLabel('browser'),'Waiting for a browser');
  assert.equal(journeyQueueLabel('account'),'Waiting for test account');
  assert.equal(journeyQueueLabel(undefined),'Waiting for a browser');
  assert.equal(journeyQueueLabel('toString'),'Waiting for a browser');
  assert.deepEqual(journeyLastAction({actionCount:7,lastAction:{type:'click',status:'running'}}),{type:'click',status:'running',count:7});
  assert.deepEqual(journeyLastAction({actions:[{type:'navigate',status:'passed'},{type:'input',status:'failed',errorCode:'payment_live_mode_rejected'}]}),{type:'input',status:'failed',errorCode:'payment_live_mode_rejected',count:2});
  assert.equal(journeyLastAction({actions:[]}),null);
});
test('finished runs list failures first, then blocked and review', () => {
  const summaries = ['a','b','c','d'].map(id => ({...journey,id,name:id}));
  const finished: BrowserRun = {...run('failed',[]),caseIds:['a','b','c','d'],caseSummaries:summaries,results:[{caseId:'a',status:'passed'},{caseId:'b',status:'needs_review'},{caseId:'c',status:'blocked'},{caseId:'d',status:'failed'}]};
  assert.deepEqual(orderJourneys(summaries,finished).map(entry => entry.item.id),['d','c','b','a']);
  const active = {...finished,status:'running'};
  assert.deepEqual(orderJourneys(summaries,active).map(entry => entry.item.id),['a','b','c','d']);
});
test('forced serial execution is shown with its reason', () => {
  assert.equal(browserConcurrencyLabel({concurrency:4,effectiveConcurrency:1,concurrencyLimit:'shared-data'}),'1 of 4 browsers · Shared test data');
  assert.equal(browserConcurrencyLabel({concurrency:2,effectiveConcurrency:1,concurrencyLimit:'account'}),'1 of 2 browsers · Test account');
  assert.equal(browserConcurrencyLabel({concurrency:2,effectiveConcurrency:2}),'');
  assert.equal(browserConcurrencyLabel({}),'');
});
test('blockers name their milestone and kind', () => {
  assert.deepEqual(browserBlockers({blockers:[{stepId:'execute',kind:'integration',evidence:'Workflow runner is not configured'},{kind:'bogus',evidence:'x'}]},journey.steps),[{kind:'Integration',step:'Execute workflow',evidence:'Workflow runner is not configured'},{kind:'Blocker',step:'',evidence:'x'}]);
  assert.deepEqual(browserBlockers(null,journey.steps),[]);
});
test('the stage card promotes reviewed journeys and groups legacy cases and drafts', () => {
  const legacy = {...journey,id:'legacy',steps:[]};
  const draft = {...journey,id:'draft',needsReview:true};
  const running = {...journey,id:'old',steps:[]};
  const runs = [{...run('running',[{id:'old',status:'running'}]),caseIds:['old'],caseSummaries:[running]}];
  const groups = stageJourneyGroups([legacy,journey,draft,running],runs);
  assert.deepEqual(groups.journeys.map(item => item.id),['happy','old']);
  assert.deepEqual(groups.others.map(item => item.id),['legacy','draft']);
});
test('graph requests are parsed without confusing case IDs', () => {
  assert.deepEqual(journeyRequest(JOURNEY_GENERATE_REQUEST),{kind:'generate',caseId:''});
  assert.deepEqual(journeyRequest('new'),{kind:'new',caseId:''});
  assert.deepEqual(journeyRequest(journeyRunRequest('happy')),{kind:'run',caseId:'happy'});
  assert.deepEqual(journeyRequest('happy'),{kind:'case',caseId:'happy'});
  assert.deepEqual(journeyRequest('run:happy'),{kind:'case',caseId:'run:happy'});
  assert.deepEqual(journeyRequest('generate'),{kind:'case',caseId:'generate'});
  assert.deepEqual(journeyRequest('!unknown'),{kind:'',caseId:''});
  assert.deepEqual(journeyRequest(''),{kind:'',caseId:''});
});
test('only failed journeys show their error as a failure', () => {
  assert.equal(journeyErrorTone('failed'),'text-destructive');
  for (const status of ['blocked','needs_review','cancelled','skipped','passed']) assert.equal(journeyErrorTone(status),'text-muted-foreground');
});
test('lists open only live or failed journeys by default', () => {
  for (const status of ['queued','running','skipping','failed']) assert.equal(journeyOpenByDefault(status),true);
  for (const status of ['passed','cancelled','skipped','blocked','needs_review','completed','not_run']) assert.equal(journeyOpenByDefault(status),false);
});
test('a journey frame revision changes only with that journey\'s own events', () => {
  const first = journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}]});
  assert.equal(first,journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}],frameUpdatedAt:'later'}));
  assert.notEqual(first,journeyRevision({actionCount:4,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}]}));
  assert.notEqual(first,journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'completed'}]}));
  assert.equal(journeyRevision({actions:[{},{}]}),'2:');
  assert.equal(journeyRevision(undefined),undefined);
});
test('browser capabilities list every missing prerequisite, and unknown is not unavailable', () => {
  assert.equal(browserUnavailable(null),'');
  assert.equal(browserUnavailable({runtimeInstalled:false,modelConfigured:true}),'Install the browser runtime');
  assert.equal(browserUnavailable({runtimeInstalled:true,browserInstalled:false,modelConfigured:true}),'Install Chromium');
  assert.equal(browserUnavailable({runtimeInstalled:true,modelConfigured:false}),'Add an OpenRouter API Key');
  assert.equal(browserUnavailable({runtimeInstalled:false,browserInstalled:false,modelConfigured:false}),'Install the browser runtime\nAdd an OpenRouter API Key', 'A missing runtime never hides a missing key');
  assert.equal(browserUnavailable({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),'');
});
test('readiness lists the target URL, browser runtime, OpenRouter API Key and Playwright browser, each with its own fix', () => {
  const none = browserReadiness({runtimeInstalled:false,browserInstalled:false,modelConfigured:false,playwright:{browserInstalled:false}}, false);
  assert.deepEqual(none.map(item => [item.id,item.label,item.ready]), [['target','Target URL',false],['runtime','Browser runtime',false],['model','OpenRouter API Key',false],['playwright','Playwright browser',false]]);
  assert.match(none[1].command!, /^uv sync --project integrations\/browser-use --frozen\n/);
  assert.equal(none[0].command, undefined);
  assert.equal(none[2].command, undefined, 'The key is fixed in Settings, not with a command');
  assert.equal(none[3].command, 'npx playwright install chromium');
  const ready = browserReadiness({runtimeInstalled:true,browserInstalled:true,modelConfigured:true,playwright:{browserInstalled:true}}, true);
  assert.deepEqual(ready.map(item => item.ready), [true,true,true,true]);
  assert.equal(ready[1].command, '');assert.equal(ready[3].command, '');
  assert.deepEqual(browserReadiness(null, false).map(item => item.id), ['target'], 'Unknown capabilities are not listed as missing');
  assert.deepEqual(browserReadiness({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}, true).map(item => item.id), ['target','runtime','model'], 'An unknown Playwright browser is not missing');
});
test('a graph Generate request opens Generate only when the toolbar would allow it', () => {
  assert.equal(generateRequestDialog({validTarget:true}),'generate');
  assert.equal(generateRequestDialog({validTarget:false}),'settings');
  assert.equal(generateRequestDialog({validTarget:true,unavailable:true}),null);
  assert.equal(generateRequestDialog({validTarget:false,unavailable:true}),null);
  assert.equal(generateRequestDialog({validTarget:true,disabled:true}),null);
});
test('an unreached final check is neither passed nor failed', () => {
  const unreached = {type:'text-visible',value:'Payment complete',passed:false,reached:false};
  assert.deepEqual(journeyCheckState(unreached),{label:'Not reached',variant:'outline'});
  assert.deepEqual(journeyCheckState({...unreached,passed:true}),{label:'Not reached',variant:'outline'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete',passed:false}),{label:'Failed',variant:'destructive'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete',passed:true}),{label:'Passed',variant:'outline'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete'}),{label:'Not checked',variant:'outline'});
});
test('finished journeys rank by the controller status alone, never by re-reading their checks', () => {
  const unreached = [{type:'text-visible',value:'Payment complete',passed:false,reached:false}];
  const summaries = ['timeout','blocked','failed'].map(id => ({...journey,id,name:id}));
  const finished = {...run('failed',[]),caseIds:summaries.map(item => item.id),caseSummaries:summaries,results:[
    {caseId:'timeout',status:'needs_review',assertions:unreached},
    {caseId:'blocked',status:'blocked',assertions:unreached,blockers:[{kind:'integration',evidence:'Stripe keys missing'}]},
    {caseId:'failed',status:'failed',assertions:[{type:'text-visible',value:'Payment complete',passed:false}]},
  ]};
  assert.deepEqual(orderJourneys(summaries,finished).map(entry => [entry.item.id,entry.status]),[['failed','failed'],['blocked','blocked'],['timeout','needs_review']]);
});
test('summary progress without an action list still shows the count and latest action', () => {
  assert.deepEqual(journeyActions({actionCount:12,lastAction:{index:11,type:'click',status:'passed'}}),{items:[{index:11,type:'click',status:'passed'}],count:12});
  const actions = [{index:0,type:'navigate',status:'passed'},{index:1,type:'click',status:'running'}];
  assert.deepEqual(journeyActions({actionCount:2,actions,lastAction:actions[1]}),{items:actions,count:2});
  assert.deepEqual(journeyActions({actions}),{items:actions,count:2});
  assert.deepEqual(journeyActions({actionCount:0}),{items:[],count:0});
  assert.deepEqual(journeyActions(undefined),{items:[],count:0});
});
test('journey evidence reads actions and final checks only through shared helpers', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  for (const file of ['JourneyEvidence.tsx','JourneyCard.tsx','RunJourneyGallery.tsx','StageJourney.tsx']) assert.doesNotMatch(await source(file), /progress\??\.actions/, file);
  const evidence = await source('JourneyEvidence.tsx');
  assert.match(evidence, /journeyCheckState\(check\)/);
  assert.doesNotMatch(evidence, /check\.passed \?/);
});
test('a reviewed journey can go back to needs review, which also deselects it', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /\{reviewed\(item\) && <DropdownMenuItem disabled=\{disabled \|\| code\.verifying\} onSelect=\{\(\) => updateCases\(cases\.map\(current => current\.id === item\.id \? \{ \.\.\.current, needsReview: true, selected: false \} : current\)\)\}><Undo2 \/>Needs review<\/DropdownMenuItem>\}/);
});

test('a case clicked on its stage focuses and expands its card, review/edit stays explicit, and its run opens from the status badge', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  const panel = await source('BrowserTestingPanel.tsx');
  assert.doesNotMatch(panel.slice(panel.indexOf('const { kind, caseId } = journeyRequest(initialCaseId);'), panel.indexOf('async function persistConfig')), /openCase|setEditingCase/, 'A stage click never opens the editor');
  assert.match(panel, /onInspect=\{\(\) => openCase\(item\)\}/);
  assert.match(panel, /onViewRun=\{run \? \(\) => setWatching\(\{ \.\.\.watchedRun\(run\), focusCaseId: item\.id \}\) : undefined\}/);
  const open = panel.slice(panel.indexOf('function openCase'), panel.indexOf('async function saveCase'));
  assert.match(open, /setEditingCase\(item\)/);
  assert.doesNotMatch(open, /setWatching|perform|start\(|updateCases|setRunDialog/);
  const card = await source('JourneyCard.tsx');
  assert.match(card, /useEffect\(\(\) => \{ if \(focused\) setOpen\(true\); \}, \[focused\]\);/);
  assert.match(card, /onViewRun \? <Button[^>]*aria-label=\{`View run for \$\{item\.name\}: \$\{statusLabel\}`\} onClick=\{onViewRun\}>\{badge\}<\/Button> : badge/);
  // The title opens review/edit; expanding is a separate, named chevron.
  assert.match(card, /<Button variant="link"[^>]*aria-label=\{`\$\{item\.name\}: \$\{item\.needsReview \? 'Review' : 'Edit'\}`\} onClick=\{onInspect\}>\{item\.name\}<\/Button>/);
  assert.match(card, /<CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm"[^\n]*?aria-label=\{`\$\{item\.name\} details`\}><ChevronDown/);
  assert.doesNotMatch(card, /<CollapsibleTrigger asChild><Button[^>]*><CardTitle/, 'The title never only toggles the card');
  const row = await source('StageJourney.tsx');
  assert.match(row, /aria-label=\{`View run for \$\{item\.name\}: \$\{state\.label\}`\} onClick=\{\(\) => onWatch\?\.\(run\)\}/);
  assert.match(row, /data-selected=\{selected\} onClick=\{onOpen\}/);
});
test('a graph case request selects the tests tab in the same render and waits for that view', async () => {
  const opened = inspectorTab(null, 'browser', 1);
  assert.equal(opened.tab, 'browser');
  const onRuns = { ...opened, tab: 'browser-runs' };
  assert.equal(inspectorTab(onRuns, 'browser', 1), onRuns, 'The viewer keeps its own tab until a new request');
  assert.equal(inspectorTab(onRuns, 'browser', 2).tab, 'browser', 'A case clicked while Runs is showing switches back to tests');
  assert.equal(inspectorTab(null, 'browser-runs', 3).tab, 'browser-runs');
  assert.equal(inspectorTab(null, 'runs', 3).tab, 'browser');
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  const effect = panel.slice(panel.indexOf("if (loading || !initialCaseId"), panel.indexOf('useEffect(() => {\n    if (loading || !initialWatch)'));
  assert.match(effect, /^if \(loading \|\| !initialCaseId \|\| view !== 'tests'\) return;/);
  assert.match(effect, /\}, \[loading, view, initialCaseId, caseRequestKey,/);
  const inspector = await readFile(new URL('../client/src/EnvironmentSettings.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /const requested = inspectorTab\(tabState, initialTab, caseRequestKey\);\n  if \(requested !== tabState\) setTabState\(requested\);/);
  assert.doesNotMatch(inspector, /useEffect\(\(\) => \{ setTab/);
});
test('the runtime and Chromium show their install command; a configured runtime has none', () => {
  assert.equal(browserInstallCommand(null), '');
  assert.equal(browserInstallCommand({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}), '');
  assert.equal(browserInstallCommand({runtimeInstalled:true,browserInstalled:false,modelConfigured:false}), 'uv run --project integrations/browser-use python -m playwright install chromium');
  assert.equal(browserInstallCommand({runtimeInstalled:false,browserInstalled:false,modelConfigured:true}), 'uv sync --project integrations/browser-use --frozen\nuv run --project integrations/browser-use python -m playwright install chromium');
  assert.equal(browserInstallCommand({runtimeInstalled:false,runtimeProject:'/opt/perpetual/integrations/browser-use'}).split('\n')[0], 'uv sync --project /opt/perpetual/integrations/browser-use --frozen');
  assert.match(browserInstallCommand({runtimeInstalled:false,runtimeProject:'/tmp/x; rm -rf ~'}), /^uv sync --project integrations\/browser-use /, 'An unsafe path never reaches a copyable command');
});
test('the first unmet prerequisite is primary and each disabled action lists every blocker', () => {
  const capabilities = {runtimeInstalled:true,browserInstalled:true,modelConfigured:true,playwright:{browserInstalled:true}};
  const base = {readiness:browserReadiness(capabilities, true),caseCount:2,selectedCount:1,maxCases:60,runnable:true};
  assert.deepEqual(testToolbar({...base,readiness:browserReadiness(capabilities, false)}), {primary:'target',blockers:{target:'',generate:'Set a target URL',add:'',run:'Set a target URL'}});
  const nothing = testToolbar({...base,readiness:browserReadiness({runtimeInstalled:false,browserInstalled:false,modelConfigured:false,playwright:{browserInstalled:false}}, false)});
  assert.equal(nothing.primary, 'target');
  assert.equal(nothing.blockers.generate, 'Set a target URL\nInstall the browser runtime\nAdd an OpenRouter API Key', 'A missing target URL never hides the other blockers');
  // A run executes Playwright code: it needs Playwright's browser, never the agent's runtime or a key.
  assert.equal(nothing.blockers.run, 'Set a target URL\nInstall Chromium for Playwright');
  assert.deepEqual(testToolbar({...base,readiness:browserReadiness({...capabilities,runtimeInstalled:false,modelConfigured:false}, true)}).blockers, {target:'',generate:'Install the browser runtime\nAdd an OpenRouter API Key',add:'',run:''});
  assert.deepEqual(testToolbar({...base,readiness:browserReadiness({...capabilities,playwright:{browserInstalled:false}}, true)}).blockers, {target:'',generate:'',add:'',run:'Install Chromium for Playwright'});
  assert.equal(testToolbar({...base,readiness:browserReadiness({...capabilities,playwright:{browserInstalled:false}}, true)}).primary, 'playwright');
  assert.equal(testToolbar({...base,runnable:false}).blockers.run, 'Generate code for the selected tests');
  assert.equal(testToolbar({...base,readiness:browserReadiness({...capabilities,runtimeInstalled:false}, true)}).primary, 'runtime');
  assert.equal(testToolbar({...base,readiness:browserReadiness({...capabilities,modelConfigured:false}, true)}).primary, 'model');
  assert.equal(testToolbar({...base,caseCount:0,selectedCount:0}).primary, 'generate');
  const unselected = testToolbar({...base,selectedCount:0});
  assert.deepEqual([unselected.primary,unselected.blockers.run,unselected.blockers.generate], ['','Select tests','']);
  assert.deepEqual(testToolbar(base), {primary:'run',blockers:{target:'',generate:'',add:'',run:''}});
  assert.deepEqual(testToolbar({...base,wait:'Run in progress'}).blockers, {target:'Run in progress',generate:'Run in progress',add:'Run in progress',run:'Run in progress'});
  assert.equal(testToolbar({...base,caseCount:60}).blockers.add, 'Limit of 60 tests');
});
test('blocked actions stay focusable Buttons with their own Tooltip; readiness hides once met', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  for (const action of ['generate', 'run']) assert.match(panel, new RegExp(`<BlockedButton reason=\\{toolbar\\.blockers\\.${action}\\} size="sm" variant=\\{emphasis\\('${action}'\\)\\}`));
  assert.match(panel, /<BlockedButton reason=\{toolbar\.blockers\.add\} size="sm" variant="outline"/);
  // A narrow inspector keeps the three actions and their labels on one filled row; a label that cannot fit takes a full row.
  assert.match(panel, /<div className="test-toolbar @container flex flex-wrap items-center gap-2">\s*<div className="flex flex-wrap items-center gap-2 @max-md:w-full">/);
  assert.match(panel, /const NARROW_TOOL = '@max-md:flex-1 @max-md:\[&>svg\]:hidden';/);
  for (const label of ['<Sparkles />Generate', '<Plus />Add test', '<Play />Run selected']) assert.match(panel, new RegExp(`className=\\{NARROW_TOOL\\}[^\\n]*>${label.replace(/[/]/g, '\\/')}`));
  assert.match(panel, /<BlockedButton reason=\{targetBlocker\} size="sm" variant=\{primary === 'target' \? 'default' : 'outline'\} onClick=\{onTarget\}>Set target URL<\/BlockedButton>/);
  const blocked = panel.slice(panel.indexOf('function BlockedButton'), panel.indexOf('function InstallCommand'));
  assert.match(blocked, /<TooltipTrigger asChild><Button \{\.\.\.props\} variant=\{variant\} aria-disabled=\{reason \? true : undefined\}/);
  assert.match(blocked, /onClick=\{event => \{ if \(reason\) event\.preventDefault\(\); else onClick\?\.\(event\); \}\}/);
  assert.match(blocked, /reason\.split\('\\n'\)/, 'The Tooltip lists each blocker on its own line');
  assert.doesNotMatch(panel, /tabIndex=\{reason \? 0/, 'No focusable wrapper without a role or name');
  assert.doesNotMatch(panel, /<span[^>]*tabIndex=\{/);
  const readiness = panel.slice(panel.indexOf('function Readiness'), panel.indexOf('// Run-only account'));
  assert.match(readiness, /<ItemGroup aria-label="Readiness"/);
  assert.match(readiness, /<span className="sr-only">\{item\.ready \? ': ready' : ': missing'\}<\/span>/);
  assert.match(readiness, /item\.id === 'model' && <ItemActions><Button[^\n]*?onClick=\{\(\) => onAppSettings\?\.\(\)\}>Settings<\/Button>/);
  assert.match(readiness, /item\.command && <ItemFooter><InstallCommand command=\{item\.command\} \/><\/ItemFooter>/);
  assert.match(panel, /const showReadiness = !loading && readiness\.some\(item => !item\.ready\);/);
  assert.match(panel, /\{showReadiness && <Readiness items=\{readiness\}/);
  assert.doesNotMatch(panel, /browserSetupFix|setupFix/);
  const install = panel.slice(panel.indexOf('function InstallCommand'), panel.indexOf('function Readiness'));
  assert.doesNotMatch(install, /break-all/, 'Tokens such as playwright never split mid-word');
  assert.match(install, /\[overflow-wrap:anywhere\]/);
  assert.match(install, /command\.split\('\/'\)\.map\(\(part, index\) => index \? <Fragment key=\{index\}>\/<wbr \/>\{part\}<\/Fragment> : part\)/);
});
test('cancelling a live run asks first with Keep running as the default', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /<AlertDialogTrigger asChild><Button[^>]*>[^\n]*'Cancel run'/);
  assert.match(viewer, /<AlertDialogCancel>Keep running<\/AlertDialogCancel><AlertDialogAction variant="destructive" onClick=\{\(\) => \{ void stop\(\); \}\}>Cancel run<\/AlertDialogAction>/);
  assert.doesNotMatch(viewer, /onClick=\{stop\}/);
  // The viewer's own close is named apart from Cancel run.
  assert.match(viewer, /showCloseButton=\{false\}/);
  assert.match(viewer, /<DialogClose asChild><Button[^>]*aria-label="Close viewer"><X \/><\/Button><\/DialogClose>/);
});
test('watching a verification live follows its next attempt once the shown one ends, and marks its control run', async () => {
  const attempt = (id: string, status: string, number: number, verification = 'v1') => run(status, [], { id, verification: { id: verification, attempt: number, control: number === 4 } });
  // The viewer opened on these attempts while they ran, as Watch live does.
  const live = (id: string) => watchedRun(attempt(id, 'running', 1)), ended = attempt('a1', 'passed', 1);
  assert.equal(verificationAttempt(live('a1'), [attempt('a2', 'running', 2), ended])?.id, 'a2');
  assert.equal(verificationAttempt(live('a3'), [attempt('c4', 'queued', 4), attempt('a3', 'passed', 3)])?.id, 'c4', 'The control run is followed too.');
  // A running attempt stays, as does one whose verification has no attempt left, or another verification's.
  for (const runs of [[attempt('a1', 'running', 1)], [ended], [attempt('b1', 'running', 1, 'v2'), ended], [run('running', [], { id: 'other' }), ended]]) assert.equal(verificationAttempt(live('a1'), runs), null, JSON.stringify(runs.map(item => item.id)));
  assert.equal(verificationAttempt(watchedRun(run('running', [], { id: 'plain' })), [run('passed', [], { id: 'plain' }), run('running', [], { id: 'next' })]), null, 'A run outside a verification is watched alone.');
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /const next = verificationAttempt\(\{ id: watchedId, live: watchedLive \}, data\.runs\);/);
  assert.match(panel, /if \(next\) setWatching\(current => current\?\.live && current\.id && current\.id !== next\.id \? \{ \.\.\.watchedRun\(next\), focusCaseId: current\.focusCaseId \} : current\);/);
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /\{run\?\.verification\?\.control && <Badge variant="outline">Control<\/Badge>\}/, 'The viewer marks a control run as the Runs list does.');
});
test('an attempt a person opened after it ended stays open while its verification runs', async () => {
  const attempt = (id: string, status: string, number: number) => run(status, [], { id, verification: { id: 'v1', attempt: number, control: false } });
  const runs = [attempt('a2', 'running', 2), attempt('a1', 'passed', 1)];
  assert.equal(verificationAttempt(watchedRun(runs[1]), runs), null, 'Attempt 1 opened from the Runs list stays open.');
  assert.equal(verificationAttempt({ id: 'a1' }, runs), null, 'A run opened before its status is known is not followed.');
  // Wherever the panel opens a run, it opens it as watchedRun does, so only a run opened while it runs is followed.
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /onClick=\{\(\) => setWatching\(watchedRun\(run\)\)\}/, 'A Runs list row');
  assert.match(panel, /onClick=\{\(\) => setWatching\(watchedRun\(activeRun\)\)\}><Eye \/>Watch live/);
  assert.doesNotMatch(panel, /setWatching\((\{ \.\.\.)?(run|activeRun|next)\b/);
});
test('a finished run’s frame says when the run ended, never that it is live or paused', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /\{finished \? endedLabel\(run\?\.completedAt\) : frameError \|\| error \? 'Reconnecting' : freshFrame \? 'Live' : 'Waiting for frame'\}/);
  assert.match(viewer, /`Ended \$\{time\.toLocaleTimeString\(\[\], \{ hour: 'numeric', minute: '2-digit' \}\)\}` : 'Ended'/);
});
test('a failed browser action names its failure in text', () => {
  assert.equal(browserActionFailure({type:'click',status:'failed',errorCode:'navigation_not_allowed'}),'Navigation blocked');
  assert.equal(browserActionFailure({type:'click',status:'failed',errorCode:'unknown_code'}),'Failed');
  assert.equal(browserActionFailure({type:'click',status:'failed'}),'Failed');
  assert.equal(browserActionFailure({type:'click',status:'passed',errorCode:'navigation_not_allowed'}),'');
  assert.equal(browserActionFailure(undefined),'');
});
test('journey status text is at least 12px and unreached final checks never read as failures', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (file: string) => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  for (const file of ['BrowserTestingPanel.tsx','BrowserAgentViewer.tsx','BrowserLiveFrame.tsx','JourneyCard.tsx','JourneyEvidence.tsx','JourneySteps.tsx','RunJourneyGallery.tsx','StageJourney.tsx','StageJourneyList.tsx']) assert.doesNotMatch(await source(file), /text-\[(?:[0-9]|1[01])px\]/, file);
  const viewer = await source('BrowserAgentViewer.tsx');
  assert.match(viewer, /journeyCheckState\(assertion\)/);
  assert.match(viewer, /assertions\?\.some\(journeyCheckFailed\)/);
  assert.doesNotMatch(viewer, /assertion\.passed \?/);
});

test('the exploration view shows the agent summary of a finished discovery beside its error, with no added copy', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /\|\| run\?\.error\}<\/p>/, 'The run error stays in the viewer.');
  assert.match(viewer, /\{snapshot\?\.discovery\?\.summary && <p className="[^"]*whitespace-pre-wrap[^"]*">\{snapshot\.discovery\.summary\}<\/p>\}/);
});

test('a run is offered when every chosen journey has current code and Playwright has its browser, and its evidence is never an agent claim', () => {
  const other = { ...journey, id: 'other' }, current = { hash: 'a'.repeat(64), stale: false };
  assert.equal(runnableCode([journey, other], { happy: { approved: current }, other: { approved: current } }), true);
  assert.equal(runnableCode([journey, other], { happy: { approved: current }, other: { draft: current } }), true, 'A person may run a current draft.');
  assert.equal(runnableCode([journey], { happy: { approved: { ...current, stale: true }, draft: current } }), true, 'A current draft stands in for stale approved code.');
  for (const specs of [undefined, {}, { happy: { approved: current } }, { happy: { approved: current }, other: { approved: { ...current, stale: true } } }, { happy: { approved: current }, other: { generation: { status: 'running' } } }]) assert.equal(runnableCode([journey, other], specs), false, JSON.stringify(specs));
  assert.equal(runnableCode([], { happy: { approved: current } }), false);
  // No model or agent runtime is needed to run; Playwright's browser is.
  const noAgent = { runtimeInstalled: false, modelConfigured: false, playwright: { browserInstalled: true } };
  assert.equal(runReady(noAgent, [journey], { happy: { approved: current } }), true);
  assert.equal(runReady({ ...noAgent, playwright: { browserInstalled: false } }, [journey], { happy: { approved: current } }), false);
  assert.equal(runReady(noAgent, [journey], {}), false);
  // Only a final assertion evaluated on the reached end state fails the expected outcomes.
  const outcome = (result: Parameters<typeof checkedOutcome>[0]) => [checkedOutcome(result).label, checkedOutcome(result).variant];
  assert.deepEqual(outcome({ status: 'passed', assertions: [{ passed: true }] }), ['Checks · Passed', 'outline']);
  assert.deepEqual(outcome({ status: 'failed', assertions: [{ passed: false }] }), ['Checks · Failed', 'destructive']);
  assert.deepEqual(outcome({ status: 'failed', assertions: [] }), ['Checks · Not reached', 'outline'], 'A failed milestone check stopped the journey before its end state.');
  assert.deepEqual(outcome({ status: 'failed', assertions: [{ passed: false, reached: false }] }), ['Checks · Not reached', 'outline']);
  assert.deepEqual(outcome({ status: 'needs_review', assertions: [] }), ['Checks · Not confirmed', 'outline']);
  const steps = browserJourneySteps(journey, { steps: [{ id: 'login', status: 'completed', evidence: 'Reviewed checks passed.', provenance: 'agent' }] }, 'passed');
  assert.deepEqual([steps[0].evidence, 'provenance' in steps[0]], ['Reviewed checks passed.', false], 'An old run\'s agent provenance is not shown.');
});

test('journey code shows its approved code and the draft beside it, which is approvable only after a passed verification', () => {
  const hash = 'a'.repeat(64), draft = (verification?: CodeVerification): JourneySpec => ({ draft: { hash, stale: false, ...(verification ? { verification } : {}) } });
  assert.deepEqual(journeyCode(undefined), { approved: '', draft: '', hash: '', verificationError: '', generating: false, error: '', exists: false, verifying: false, verifiable: false, approvable: false, reusable: false });
  assert.deepEqual([journeyCode({ approved: { hash, stale: false } }).approved, journeyCode({ approved: { hash, stale: true } }).approved], ['Approved', 'Stale']);
  assert.deepEqual([journeyCode({ approved: { hash, stale: false } }).reusable, journeyCode({ approved: { hash, stale: true } }).reusable, journeyCode({ approved: { hash, stale: true }, draft: { hash, stale: false } }).reusable, journeyCode({ approved: { hash, stale: true }, draft: { hash, stale: true } }).reusable], [false, true, false, true], 'Stale approved code is reusable while no current draft exists.');
  const states: [CodeVerification | undefined, string, boolean, boolean][] = [
    [undefined, 'Draft', true, false], [{ status: 'running', passes: 2, control: null }, 'Verifying 2/3', false, false],
    [{ status: 'passed', passes: 3, control: 'caught' }, 'Verified', false, true], [{ status: 'failed', passes: 3, control: 'missed', error: 'The journey passed with every change blocked. Strengthen its checks.' }, 'Verification failed', true, false],
    [{ status: 'cancelled', passes: 1, control: null }, 'Draft', true, false],
  ];
  for (const [verification, label, verifiable, approvable] of states) {
    const code = journeyCode(draft(verification));
    assert.deepEqual([code.draft, code.verifiable, code.approvable, code.verifying, code.hash], [label, verifiable, approvable, verification?.status === 'running', hash], JSON.stringify(verification));
  }
  assert.equal(journeyCode(draft({ status: 'failed', passes: 3, control: 'missed', error: 'The journey passed with every change blocked. Strengthen its checks.' })).verificationError, 'The journey passed with every change blocked. Strengthen its checks.');
  const stale = journeyCode({ draft: { hash, stale: true, verification: { status: 'passed', passes: 3, control: 'caught' } } });
  assert.deepEqual([stale.draft, stale.verifiable, stale.approvable], ['Stale draft', false, false]);
  assert.deepEqual([journeyCode({ generation: { status: 'running', step: 'generating' } }).generating, journeyCode({ generation: { status: 'running' } }).exists], [true, false]);
  assert.equal(journeyCode({ ...draft(), generation: { status: 'failed', error: 'The code generator stopped.' } }).error, 'The code generator stopped.');
});

test('the graph runs a journey once Playwright can run its code, and only Regenerate waits for the browser agent', async () => {
  const { readFile } = await import('node:fs/promises');
  const list = await readFile(new URL('../client/src/StageJourneyList.tsx', import.meta.url), 'utf8');
  assert.match(list, /<StageJourney [^>]*disabled=\{busy \|\| !runReady\(capabilities, \[item\], specs\)\}/);
  assert.match(list, /const unavailable = busy \|\| Boolean\(browserUnavailable\(capabilities\)\);/);
  assert.match(list, /disabled=\{unavailable\} onClick=\{\(\) => open\(\{ caseId: JOURNEY_GENERATE_REQUEST \}\)\}/);
  // A runs-only setup runs approved code without the agent or a key, which only Generate lacks; without Playwright's browser nothing runs.
  const approved = { happy: { approved: { hash: 'a'.repeat(64), stale: false } } }, runsOnly = { runtimeInstalled: false, modelConfigured: false, playwright: { browserInstalled: true } };
  assert.deepEqual([runReady(runsOnly, [journey], approved), browserUnavailable(runsOnly)], [true, 'Install the browser runtime\nAdd an OpenRouter API Key']);
  assert.deepEqual([runReady({ runtimeInstalled: true, modelConfigured: true, playwright: { browserInstalled: false } }, [journey], approved), browserUnavailable({ runtimeInstalled: true, modelConfigured: true })], [false, '']);
});

test('a verifying journey keeps its actions open to Stop verifying while an attempt runs, and every other action waits', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /const locked = loading \|\| busy \|\| Boolean\(pending\), disabled = locked \|\| Boolean\(activeRun\);/);
  const menu = panel.slice(panel.indexOf('actions={<DropdownMenu>'), panel.indexOf('onSkip='));
  assert.match(menu, /<Button [^>]*disabled=\{code\.verifying \? locked : disabled\} aria-label=\{`Actions for \$\{item\.name\}`\}>/);
  assert.match(menu, /<DropdownMenuItem disabled=\{disabled \|\| !runnable\(\[item\]\) \|\| !validUrl\(config\.targetUrl\)\}/);
  assert.match(menu, /<DropdownMenuItem disabled=\{disabled\} onSelect=\{\(\) => setEditingCase\(item\)\}>/);
  assert.match(menu, /<DropdownMenuItem variant="destructive" disabled=\{disabled\} onSelect=\{\(\) => setDeletingCase\(item\)\}>/);
  // Inside it, generating, verifying, approving and discarding wait for the verification; stopping it does not.
  const actions = panel.slice(panel.indexOf('function CodeActions'), panel.indexOf('function ApproveCodeDialog'));
  assert.match(actions, /const busy = code\.generating \|\| code\.verifying;/);
  assert.match(actions, /\{code\.verifying \? <DropdownMenuItem onSelect=\{onStopVerifying\}>/);
  assert.match(actions, /<DropdownMenuItem disabled=\{!modelConfigured \|\| code\.verifying\} onSelect=\{onGenerate\}>/);
  for (const handler of ['onApprove', 'onDiscard']) assert.match(actions, new RegExp(`<DropdownMenuItem disabled=\\{busy\\} onSelect=\\{${handler}\\}>`), handler);
});

test('a person approves the draft as code, or as its line diff against the approved code', () => {
  assert.deepEqual(codeLines("a\nb\n"), [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
  assert.deepEqual(codeLines("a\nc\nd\n", "a\nb\nd\n"), [{ kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'c' }, { kind: 'same', text: 'd' }]);
});

test('a control run never counts as a journey\'s status, except in its own run view', () => {
  const passed = run('passed', [{ id: 'happy', status: 'passed' }], { id: 'attempt', createdAt: '2026-09-23T00:00:00Z', results: [{ caseId: 'happy', status: 'passed' }], verification: { attempt: 3, control: false } });
  const control = run('needs_review', [{ id: 'happy', status: 'needs_review' }], { id: 'control', createdAt: '2026-09-23T00:01:00Z', results: [{ caseId: 'happy', status: 'needs_review' }], verification: { attempt: 4, control: true } });
  assert.equal(browserCaseRun(journey, [passed, control])!.id, 'attempt');
  assert.equal(browserCaseState(journey, [passed, control]).status, 'passed');
  assert.equal(browserCaseRun(journey, [control]), null);
  assert.equal(orderJourneys([journey], control)[0].status, 'needs_review');
});

test('journey code is generated, verified, approved in a Dialog showing the code or its diff, or discarded, and every run is Playwright', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  const [panel, card, steps, evidence] = await Promise.all(['../client/src/BrowserTestingPanel.tsx', '../client/src/JourneyCard.tsx', '../client/src/JourneySteps.tsx', '../client/src/JourneyEvidence.tsx'].map(source));
  // The run dialog has no engine choice, and nothing labels a run or its evidence by engine or agent.
  const dialog = panel.slice(panel.indexOf('function RunTestsDialog'), panel.indexOf('function BusinessCaseEditor'));
  assert.doesNotMatch(dialog, /Engine|engine|Browser Use/);
  assert.doesNotMatch(card, />Playwright</);assert.doesNotMatch(steps, /provenance|'Agent'/);assert.doesNotMatch(evidence, /Agent ·|OUTCOMES|result\?\.outcomes/);
  const actions = panel.slice(panel.indexOf('function CodeActions'), panel.indexOf('function ApproveCodeDialog'));
  for (const label of ['Generating code', 'Stop generating', "'Regenerate code' : 'Generate code'", 'Stop verifying', 'Verify code', 'Approve code', 'Reuse approved code', 'Discard draft']) assert.ok(actions.includes(label), label);
  const approve = panel.slice(panel.indexOf('function ApproveCodeDialog'), panel.indexOf('function DeleteCaseDialog'));
  assert.match(approve, /return <Dialog open /);assert.ok(approve.includes('<DialogHeader><DialogTitle>Approve code</DialogTitle></DialogHeader>'));
  assert.match(approve, /api\(`\/api\/browser\/specs\/code\?\$\{new URLSearchParams\(\{ repoPath, stageId, caseId: item\.id \}\)\}`\)/);
  assert.match(approve, /codeLines\(code\.draft\.code, code\.approved\?\.code\)/);
  assert.match(approve, /<pre[^>]*className="[^"]*overflow-auto[^"]*font-mono/);
  assert.match(approve, /'added' \? 'bg-accent text-accent-foreground' : line\.kind === 'removed' \? 'text-muted-foreground'/);
  assert.match(approve, /<DialogFooter><Button type="button" variant="outline"[^>]*>Cancel<\/Button><Button type="button"[^>]*>\{saving && [^}]*\}Approve<\/Button><\/DialogFooter>/);
  assert.match(panel, /tx\.post\('specs\/approve', \{ caseId: approvingCase\.id, hash \}\)/, 'Approval takes the hash of the code the person saw.');
  assert.match(panel, /\{run\.verification\?\.control && <Badge variant="outline">Control<\/Badge>\}/);
  // The card shows the approved and draft states journeyCode names, and why a verification or generation failed.
  for (const label of ['{code.approved}', '{code.draft}', '{code.verificationError}', 'Generating', 'Generation failed']) assert.ok(card.includes(label), label);
});

test('a journey\'s latest run stays current across what its approval ignores, a rename or its isolation, as the gate runs it', () => {
  const passed = run('passed', [{ id: 'happy', status: 'passed' }], { id: 'latest', results: [{ caseId: 'happy', status: 'passed' }] });
  assert.equal(browserCaseRun({ ...journey, name: 'Renamed journey' }, [passed])?.id, 'latest');
  assert.equal(browserCaseState({ ...journey, isolation: 'isolated' }, [passed]).status, 'passed');
  // Its reviewed contract is what approval binds to: a changed step or outcome is a new definition with no run yet.
  assert.equal(browserCaseRun({ ...journey, goal: `${journey.goal} Again.` }, [passed]), null);
  assert.equal(browserCaseRun({ ...journey, steps: journey.steps.slice(1) }, [passed]), null);
  assert.equal(browserCaseRun({ ...journey, expectedOutcomes: [] }, [passed]), null);
});
