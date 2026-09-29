import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const steps = [{id:'create',title:'Create and save workflow'},{id:'verify',title:'Reopen and verify the saved workflow'}];
const scenario = (changes: Record<string, unknown> = {}) => ({ id: 'persist-workflow', name: 'Workflow persists', goal: 'Create a workflow, save it, reload and reopen it.', preconditions: ['A dedicated test account exists.'], expectedOutcomes: ['The saved workflow and its nodes remain after reload.'], assertions: [{ type: 'text-visible', value: 'My test workflow' }], selected: false, needsReview: true, ...changes });

test('browser cases preserve business goals and reject executable script fields', async () => {
  const { validateBrowserCases } = await import('../src/business/browser-cases.ts');
  const [result] = validateBrowserCases([scenario()]);
  assert.equal(result.goal, scenario().goal);
  assert.deepEqual(result.expectedOutcomes, scenario().expectedOutcomes);
  assert.equal(result.selected, false);
  assert.throws(() => validateBrowserCases([scenario({ steps: [{ type: 'click', selector: '#save' }] })]), /Unsupported/);
  assert.throws(() => validateBrowserCases([scenario({ assertions: [{ type: 'evaluate', value: 'document.cookie' }] })]), /assertion/i);
});

test('review gates selection; unverified goals can exist without falsely acquiring assertions', async () => {
  const { validateBrowserCases } = await import('../src/business/browser-cases.ts');
  assert.throws(() => validateBrowserCases([scenario({ selected: true })]), /review/i);
  const [reviewed] = validateBrowserCases([scenario({ needsReview: false, selected: true })]);
  assert.equal(reviewed.selected, true);
  assert.equal(validateBrowserCases([scenario({ assertions: [] })])[0].assertions.length, 0);
  assert.throws(() => validateBrowserCases([scenario({ expectedOutcomes: [] })]), /outcome/i);
  assert.throws(() => validateBrowserCases([scenario(), scenario()]), /duplicate/i);
  assert.throws(() => validateBrowserCases([scenario({ selected: 'true' })]), /boolean/i);
  assert.throws(() => validateBrowserCases([scenario({ goal: 'x'.repeat(5000) })]), /goal/i);
});

test('review refuses a journey without independent checks while keeping its incomplete draft', async () => {
  const { validateBrowserCases, assertReviewedJourneys } = await import('../src/business/browser-cases.ts');
  const draft = validateBrowserCases([scenario({ steps, assertions: [] })]);
  assert.doesNotThrow(() => assertReviewedJourneys(draft));
  assert.deepEqual(draft[0].assertions, []);
  const reviewed = [{ ...draft[0], needsReview: false }];
  assert.throws(() => assertReviewedJourneys(reviewed, draft), /check/i);
  assert.doesNotThrow(() => assertReviewedJourneys(reviewed, reviewed), 'Old cases stay readable without inventing checks.');
  assert.throws(() => assertReviewedJourneys([{ ...reviewed[0], goal: 'A changed goal' }], reviewed), /check/i);
  for (const checked of [
    { ...reviewed[0], assertions: [{ type: 'text-visible' as const, value: 'Saved workflow' }] },
    { ...reviewed[0], steps: [steps[0], { ...steps[1], checks: [{ type: 'text-visible' as const, value: 'Saved workflow' }] }] },
  ]) assert.doesNotThrow(() => assertReviewedJourneys([checked], draft));
});

test('discovery context uses bounded redacted source and skips instructions, secrets and symlinks', async t => {
  const { browserDiscoveryContext } = await import('../src/business/browser-cases.ts');
  const root = await mkdtemp(join(tmpdir(), 'browser-goals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/app.ts'), 'export const feature = "Save workflow";\nconst api_key = "DO_NOT_SEND_ME";\n');
  await writeFile(join(root, '.env'), 'SECRET=PRIVATE_ENV');
  await writeFile(join(root, 'AGENTS.md'), 'INSTRUCTION_ONLY_TOKEN');
  await writeFile(join(root, 'outside.txt'), 'SYMLINK_ONLY_TOKEN');
  await symlink(join(root, 'outside.txt'), join(root, 'src/link.ts'));
  const context = await browserDiscoveryContext({ repoPath: root, scope: 'Workflow persistence', requirements: 'Users must be able to reopen saved workflows.' });
  assert.equal(typeof context, 'string');
  assert.match(context, /Save workflow/);
  assert.match(context, /Workflow persistence/);
  assert.doesNotMatch(context, /DO_NOT_SEND_ME|PRIVATE_ENV|INSTRUCTION_ONLY_TOKEN|SYMLINK_ONLY_TOKEN/);
  const parsed = JSON.parse(context);
  assert.equal(parsed.files[0].path, 'src/app.ts');
  assert.match(parsed.files[0].source, /1: export/);
});

test('agent drafts cannot invent source references or self-approve', async () => {
  const { validateDiscoveredBrowserCases } = await import('../src/business/browser-cases.ts');
  const context = JSON.stringify({ files: [{ path: 'src/app.ts', source: '1: function saveWorkflow() {}\n2: export default saveWorkflow;' }] });
  const [draft] = validateDiscoveredBrowserCases([scenario({ steps, isolation:'isolated', selected: true, needsReview: false, evidence: [{ path: 'src/app.ts', line: 1 }] })], context);
  assert.equal(draft.selected, false);
  assert.equal(draft.needsReview, true);
  assert.equal(draft.isolation, 'shared');
  assert.deepEqual(draft.steps, steps);
  // An unsupplied citation is dropped; the journey stays a reviewable draft.
  for (const evidence of [[{ path: 'src/fiction.ts', line: 1 }], [{ path: 'src/app.ts', line: 20 }], [{ path: '../secret', line: 1 }], [null, 'src/app.ts:2'], [{ path: 'src/app.ts', line: 2 }, { path: 'src/app.ts', line: 20 }]]) {
    const [kept] = validateDiscoveredBrowserCases([scenario({ steps, evidence })], context);
    assert.deepEqual(kept.evidence, evidence.filter(ref => typeof ref === 'object' && ref?.path === 'src/app.ts' && ref.line <= 2), JSON.stringify(evidence));
  }
});

test('one bad citation or invalid journey never discards the rest of a paid discovery', async () => {
  const { discoveredBrowserCases, validateDiscoveredBrowserCases } = await import('../src/business/browser-cases.ts');
  const context = JSON.stringify({ files: [{ path: 'src/app.ts', source: '1: function saveWorkflow() {}' }] });
  const cited = scenario({ id: 'cited', steps, evidence: [{ path: 'src/app.ts', line: 1 }, { path: 'src/fiction.ts', line: 1 }] });
  const invalid = scenario({ id: 'invalid', name: 'Single step journey', steps: [steps[0]] });
  const { cases, omitted } = discoveredBrowserCases([cited, invalid], context);
  assert.deepEqual(cases.map(item => [item.id, item.evidence, item.needsReview]), [['cited', [{ path: 'src/app.ts', line: 1 }], true]]);
  assert.deepEqual(omitted, [{ name: 'Single step journey', reason: 'Generated journeys need at least two ordered business steps.' }]);
  assert.deepEqual(validateDiscoveredBrowserCases([invalid, cited], context).map(item => item.id), ['cited']);
  assert.deepEqual(discoveredBrowserCases([cited, { ...cited, name: 'Copy' }, scenario({ id: 'bell', name: 'Bell\u0007', steps }), 'text'], context).omitted, [
    { name: 'Copy', reason: 'Duplicate browser case ID.' }, { name: 'Bell', reason: 'Case name must contain 1–120 characters.' }, { name: 'Untitled journey', reason: 'Unsupported browser case field: 0' },
  ]);
  assert.throws(() => validateDiscoveredBrowserCases([invalid, scenario({ id: 'secret', steps, goal: 'Use [REDACTED] input' })], context), /two ordered business steps\. Redacted source content/, 'A single drafted case fails when it is invalid.');
  // A discovery without an acceptable journey still returns every omission, so the caller can keep the reasons.
  assert.deepEqual(discoveredBrowserCases([invalid, scenario({ id: 'secret', name: 'Secret input', steps, goal: 'Use [REDACTED] input' })], context), { cases: [], omitted: [
    { name: 'Single step journey', reason: 'Generated journeys need at least two ordered business steps.' }, { name: 'Secret input', reason: 'Redacted source content cannot be used as test input.' },
  ] });
  assert.deepEqual(discoveredBrowserCases([], context), { cases: [], omitted: [] });
  assert.throws(() => discoveredBrowserCases(Array.from({ length: 5 }, (_, i) => scenario({ id: String(i), steps })), context), /four/i);
});

test('browser discovery balances a large monorepo and prioritizes scoped UI and API evidence', async t => {
  const { businessSourceContext } = await import('../src/business/discovery.ts');
  const root = await mkdtemp(join(tmpdir(), 'browser-balanced-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['backend/routes', 'frontend/pages', 'docs']) await mkdir(join(root, folder), { recursive: true });
  await Promise.all(Array.from({ length: 230 }, (_, index) => writeFile(join(root, `backend/routes/resource-${String(index).padStart(3, '0')}.ts`), `export const unrelated = ${index};\n${'// filler\n'.repeat(800)}`)));
  await writeFile(join(root, 'backend/routes/workflows.ts'), 'export async function saveWorkflow() {}\n');
  await writeFile(join(root, 'frontend/pages/workflows.tsx'), 'export function Workflows() { return "Save workflow"; }\nconst password = "DO_NOT_SEND_ME";\n');
  await writeFile(join(root, 'frontend/pages/account.tsx'), 'export function Account() {}\n');
  await writeFile(join(root, 'docs/product.md'), '# Product\nUsers create and reopen workflows.\n');
  const context = await businessSourceContext(root, { scope: 'workflow persistence' });
  const names = context.files.map(file => file.path);
  assert.ok(names.includes('frontend/pages/workflows.tsx'));
  assert.ok(names.includes('backend/routes/workflows.ts'));
  assert.ok(names.includes('docs/product.md'));
  assert.ok(names.indexOf('backend/routes/workflows.ts') < names.indexOf('backend/routes/resource-000.ts'));
  assert.match(context.files.find(file => file.path === 'frontend/pages/workflows.tsx')!.source, /^1: export function Workflows/);
  assert.doesNotMatch(JSON.stringify(context), /DO_NOT_SEND_ME/);
  assert.ok(context.files.length <= 60);
  assert.ok(context.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.source), 0) <= 180 * 1024);
});


test('journey milestones are bounded, non-executable, ordered and legacy-compatible', async () => {
  const {validateBrowserCases,validateDiscoveredBrowserCases}=await import('../src/business/browser-cases.ts');
  const [legacy]=validateBrowserCases([scenario()]);
  assert.deepEqual(legacy.steps,[]);assert.equal(legacy.isolation,'shared');
  const [journey]=validateBrowserCases([scenario({steps,isolation:'isolated'})]);
  assert.deepEqual(journey.steps,steps);assert.equal(journey.isolation,'isolated');
  for(const invalid of [[...steps,steps[0]],[{id:'../save',title:'Save'}],[{id:'save',title:''}],[{id:'save',title:'x'.repeat(241)}],[{id:'save',title:'Save',selector:'#save'}]])assert.throws(()=>validateBrowserCases([scenario({steps:invalid})]),/step/i);
  assert.throws(()=>validateBrowserCases([scenario({isolation:'auto'})]),/data/i);
  assert.throws(()=>validateDiscoveredBrowserCases([scenario()]),/step/i);
  assert.throws(()=>validateDiscoveredBrowserCases(Array.from({length:5},(_,i)=>scenario({id:String(i),steps}))),/four/i);
});

test('source sampling includes billing, settings and useful interior lines without historical plans',async t=>{
  const {businessSourceContext}=await import('../src/business/discovery.ts');
  const root=await mkdtemp(join(tmpdir(),'browser-journey-source-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const folder of ['backend/routes','frontend/pages','docs/user','docs/superpowers'])await mkdir(join(root,folder),{recursive:true});
  await Promise.all(Array.from({length:80},(_,i)=>writeFile(join(root,`backend/routes/workflow-${i}.ts`),'export const item="Workflow";\n'+'// filler\n'.repeat(500))));
  await writeFile(join(root,'backend/routes/stripe.ts'),'// header\n'.repeat(400)+'export function checkout() { return "subscription updated"; }\n');
  await writeFile(join(root,'frontend/pages/settings.tsx'),'export function Settings() { return "Workspace settings"; }\n');
  await writeFile(join(root,'frontend/pages/login.tsx'),'export function Login() { return "Sign in"; }\n');
  await writeFile(join(root,'docs/user/quickstart.md'),'# User journey\nCreate, save and execute a workflow.\n');
  await writeFile(join(root,'docs/superpowers/old-plan.md'),'OLD_IMPLEMENTATION_PLAN');
  const context=await businessSourceContext(root,{scope:'workflow workflow workflow user tests'});
  const billing=context.files.find(f=>f.path==='backend/routes/stripe.ts');
  assert.ok(billing);assert.match(billing.source,/401: export function checkout/);
  for(const file of ['frontend/pages/settings.tsx','frontend/pages/login.tsx','docs/user/quickstart.md'])assert.ok(context.files.some(f=>f.path===file),file);
  assert.doesNotMatch(JSON.stringify(context),/OLD_IMPLEMENTATION_PLAN/);
  assert.ok(context.files.reduce((n,f)=>n+Buffer.byteLength(f.source),0)<=180*1024);
});

test('milestone checks mirror the runner schema: bounded types, capture names and earlier read-number references',async()=>{
  const {validateBrowserCases,validateDiscoveredBrowserCases}=await import('../src/business/browser-cases.ts');
  const credits=[{id:'start',title:'Confirm the starting balance',checks:[{type:'read-number',label:'Credits',name:'before'},{type:'text-visible',value:' Workspace '}]},{id:'run',title:'Run the workflow and see credits decrease',checks:[{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'},{type:'url-contains',value:'/runs/'}]}];
  const [item]=validateBrowserCases([scenario({steps:credits})]);
  assert.deepEqual(item.steps[0].checks,[{type:'read-number',label:'Credits',name:'before'},{type:'text-visible',value:'Workspace'}]);
  assert.deepEqual(item.steps[1].checks![0],{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'});
  assert.equal('checks' in validateBrowserCases([scenario({steps:[{...steps[0],checks:[]},steps[1]]})])[0].steps[0],false,'Empty checks normalize to a plain milestone.');
  const same=[{id:'balance',title:'Record and compare',checks:[{type:'read-number',label:'Credits',name:'before'},{type:'compare-number',label:'Credits',name:'same',op:'=',than:'before'}]},steps[1]];
  assert.equal(validateBrowserCases([scenario({steps:same})])[0].steps[0].checks!.length,2);
  for(const op of ['<','>','=','!=']){const compared=validateBrowserCases([scenario({steps:[{...steps[0],checks:[{type:'read-number',label:'Credits',name:'a1'},{type:'compare-number',label:'Credits',name:'b',op,than:'a1'}]},steps[1]]})])[0].steps[0].checks![1];assert.equal(compared.type==='compare-number'&&compared.op,op);}
  const invalid=[
    [{type:'evaluate',value:'document.cookie'}],[{type:'text-visible',value:''}],[{type:'text-visible',value:'x'.repeat(4001)}],[{type:'text-visible',value:'Saved',selector:'#x'}],[{type:'text-visible',value:'Saved',label:'Credits'}],
    [{type:'read-number',label:'',name:'before'}],[{type:'read-number',label:'x'.repeat(121),name:'before'}],[{type:'read-number',label:'Credits',name:'Before'}],[{type:'read-number',label:'Credits',name:'a'.repeat(41)}],[{type:'read-number',label:'Credits',name:'before-run'}],[{type:'read-number',label:'Credits',name:'before',op:'<'}],
    [{type:'compare-number',label:'Credits',name:'after',op:'<',than:'missing'}],[{type:'compare-number',label:'Credits',name:'after',op:'<=',than:'before'}],[{type:'compare-number',label:'Credits',name:'after',op:'<'}],
    Array.from({length:7},()=>({type:'text-visible',value:'Saved'})),'text-visible',[null],
  ];
  for(const checks of invalid)assert.throws(()=>validateBrowserCases([scenario({steps:[{...steps[0],checks},steps[1]]})]),/check/i,JSON.stringify(checks));
  assert.equal(validateBrowserCases([scenario({steps:[{...steps[0],checks:Array.from({length:6},()=>({type:'text-visible',value:'Saved'}))},steps[1]]})])[0].steps[0].checks!.length,6);
  assert.throws(()=>validateBrowserCases([scenario({steps:[{...steps[0],checks:[{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'},{type:'read-number',label:'Credits',name:'before'}]},steps[1]]})]),/earlier/i,'A comparison cannot reference a later capture in the same step.');
  assert.throws(()=>validateBrowserCases([scenario({steps:[{...steps[0],checks:[{type:'compare-number',label:'Credits',name:'after',op:'>',than:'before'}]},{...steps[1],checks:[{type:'read-number',label:'Credits',name:'before'}]}]})]),/earlier/i,'A comparison cannot reference a later step.');
  assert.throws(()=>validateBrowserCases([scenario({steps:[{...steps[0],checks:[{type:'read-number',label:'Credits',name:'before'},{type:'compare-number',label:'Credits',name:'after',op:'>',than:'before'},{type:'compare-number',label:'Credits',name:'again',op:'>',than:'after'}]},steps[1]]})]),/earlier/i,'A compare-number name is not a capture.');
  const [draft]=validateDiscoveredBrowserCases([scenario({steps:credits})]);
  assert.deepEqual(draft.steps,item.steps,'Discovered and drafted journeys may carry checks.');
});

test('new or edited reviewed cases are 2–12 milestone journeys, while unchanged stored legacy cases stay runnable',async()=>{
  const {validateBrowserCases,assertReviewedJourneys}=await import('../src/business/browser-cases.ts');
  const legacy=validateBrowserCases([scenario({needsReview:false,selected:true})]);
  assert.doesNotThrow(()=>assertReviewedJourneys(legacy,legacy));
  assert.doesNotThrow(()=>assertReviewedJourneys([{...legacy[0],selected:false}],legacy),'Choosing whether a legacy case runs is not an edit.');
  assert.throws(()=>assertReviewedJourneys([{...legacy[0],name:'Edited'}],legacy),/2–12 milestones/);
  assert.throws(()=>assertReviewedJourneys(validateBrowserCases([scenario({needsReview:false})]),[]),/2–12 milestones/);
  assert.throws(()=>assertReviewedJourneys(validateBrowserCases([scenario({needsReview:false,steps:[steps[0]]})]),[]),/2–12 milestones/);
  assert.throws(()=>assertReviewedJourneys(legacy,validateBrowserCases([scenario()])),/2–12 milestones/,'Approving a stored step-less draft is an edit.');
  assert.throws(()=>assertReviewedJourneys(legacy,validateBrowserCases([scenario({id:'other',needsReview:false})])),/2–12 milestones/,'Identity is per case ID.');
  assert.doesNotThrow(()=>assertReviewedJourneys(validateBrowserCases([scenario({needsReview:false,steps})]),[]));
  assert.doesNotThrow(()=>assertReviewedJourneys(validateBrowserCases([scenario()]),[]),'Drafts may stay incomplete.');
});
