import test from 'node:test';
import assert from 'node:assert/strict';
import {draftBrowserCase,transcribeBrowserAudio} from '../src/browser/openrouter-input.ts';

// The chat request the fake OpenRouter received.
type Received={messages:{content:string}[]};

const configuration={modelConfigured:true as const,baseUrl:'https://openrouter.ai/api/v1',model:'fixture-model',apiKey:'fixture-key'};
const candidate={name:'Change workspace settings',goal:'Sign in, change the workspace name, then reopen it and verify the saved name.',steps:[{id:'login',title:'Sign in to the dedicated workspace'},{id:'settings',title:'Change and save the workspace name'},{id:'verify',title:'Reopen the workspace and verify its saved name'}],preconditions:['A dedicated test account and workspace exist'],expectedOutcomes:['The new workspace name remains after reopening'],assertions:[],evidence:[]};

test('natural-language case drafts retain ordered milestones without authorizing parallel data or execution',async t=>{
  let received:Received|undefined;
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    received=JSON.parse(String(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:{...candidate,isolation:'isolated',selected:true,needsReview:false}})}}]}),{headers:{'Content-Type':'application/json'}});
  });
  const draft=await draftBrowserCase({configuration,description:'Change our workspace settings and verify the name persists.',sourceContext:'{}'});
  assert.deepEqual(draft.steps,candidate.steps);
  assert.equal(draft.isolation,'shared');assert.equal(draft.selected,false);assert.equal(draft.needsReview,true);
  assert.match(received!.messages[0].content,/ordered business milestones/);
  assert.match(received!.messages[0].content,/FINAL browser page/);
});

test('drafts may carry milestone checks and the prompt asks for credit, payment and settings evidence without simulated success',async t=>{
  let received:Received|undefined;
  const steps=[{id:'start',title:'Confirm the starting plan and credit balance',checks:[{type:'read-number',label:'Credits',name:'before'}]},{id:'pay',title:'Buy credits with a Stripe test card',checks:[{type:'url-contains',value:'/billing'}]},{id:'verify',title:'Verify the credit balance increased',checks:[{type:'compare-number',label:'Credits',name:'after',op:'>',than:'before'}]}];
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    received=JSON.parse(String(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:{...candidate,name:'Buy credits',steps}})}}]}),{headers:{'Content-Type':'application/json'}});
  });
  const draft=await draftBrowserCase({configuration,description:'Buy credits and verify the balance increases.',sourceContext:'{}'});
  assert.deepEqual(draft.steps,steps);assert.equal(draft.needsReview,true);
  const prompt=received!.messages[0].content;
  for(const pattern of [/read-number/,/compare-number/,/at most 6 checks/i,/never supplies observed values/i,/starting value/i,/Stripe test mode/i,/starting state[^.]*blocked/i,/restor/i,/wait and re-observe/i,/happy path[^.]*completed, successful result[^.]*before any milestone that compares the final credit/i,/comparison follows the observed success/i,/failed run that still lowers credits is a product bug[^.]*never a pass/i])assert.match(prompt,pattern);
  let proposal={...candidate,steps:[{...steps[0],checks:[{type:'compare-number',label:'Credits',name:'after',op:'>',than:'missing'}]},steps[1]]};
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:proposal})}}]}),{headers:{'Content-Type':'application/json'}}));
  await assert.rejects(draftBrowserCase({configuration,description:'Buy credits.',sourceContext:'{}'}),/valid test/,'An unreferenced comparison is rejected, not repaired.');
  proposal={...candidate,steps:[{...steps[0],checks:[{type:'evaluate',value:'document.cookie'}]},steps[1]]};
  await assert.rejects(draftBrowserCase({configuration,description:'Buy credits.',sourceContext:'{}'}),/valid test/);
});

test('a fragmented or executable model proposal is rejected instead of inventing journey milestones',async t=>{
  let proposal:Record<string,unknown>={...candidate,steps:[]};
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:proposal})}}]}),{headers:{'Content-Type':'application/json'}}));
  await assert.rejects(draftBrowserCase({configuration,description:'Verify workspace settings.',sourceContext:'{}'}),/valid test/);
  proposal={...candidate,steps:[{id:'click',title:'Change name',selector:'#name'},{id:'verify',title:'Verify'}]};
  await assert.rejects(draftBrowserCase({configuration,description:'Verify workspace settings.',sourceContext:'{}'}),/valid test/);
});

test('draft requests distinguish completed business evidence from unchanged controls and retain evidence gaps for review',async t=>{
  let received:Received|undefined;
  const description='Publish a report, run it and read the completed report containing the supplied totals.';
  const proposal={...candidate,name:'Publish and run a report',goal:description,
    steps:[{id:'publish',title:'Publish the report'},{id:'result',title:'Run and read the finished report'}],
    preconditions:['Confirm the report success state and result contents before review'],
    expectedOutcomes:['The completed report contains the supplied totals'],selected:true,needsReview:false};
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    received=JSON.parse(String(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:proposal})}}]}),{headers:{'Content-Type':'application/json'}});
  });
  const draft=await draftBrowserCase({configuration,description,sourceContext:'{}'});
  const instructions=received!.messages[0].content;
  for(const pattern of [
    /check could still pass if the intended action failed or never ran/i,
    /buttons, navigation tabs, headings and unchanged starting states/i,
    /terminal success state and goal-specific result contents/i,
    /whole operation[^.]*individual step/i,
    /queued, running or accepted[^.]*not completion/i,
    /leave the unsupported checks empty[^.]*evidence gap/i,
    /saving a draft[^.]*persisted draft/i,
  ])assert.match(instructions,pattern);
  assert.equal(JSON.parse(received!.messages[1].content).description,description);
  assert.deepEqual(draft.steps,proposal.steps);assert.deepEqual(draft.assertions,[]);
  assert.equal(draft.needsReview,true);assert.equal(draft.selected,false);
});

test('an unsupplied source citation is dropped from a draft instead of discarding the draft',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({case:{...candidate,evidence:[{path:'src/settings.ts',line:1},{path:'src/settings.ts',line:9},{path:'src/fiction.ts',line:1}]}})}}]}),{headers:{'Content-Type':'application/json'}}));
  const draft=await draftBrowserCase({configuration,description:'Change workspace settings.',sourceContext:JSON.stringify({files:[{path:'src/settings.ts',source:'1: export function renameWorkspace() {}'}]})});
  assert.deepEqual(draft.evidence,[{path:'src/settings.ts',line:1}]);assert.equal(draft.needsReview,true);
});

test('a transcription reply without text is an upstream error, whatever JSON it is',async t=>{
  let body='null';
  t.mock.method(globalThis,'fetch',async()=>new Response(body,{headers:{'Content-Type':'application/json'}}));
  for(const reply of ['null','7','[]','{"text":5}']){
    body=reply;
    await assert.rejects(transcribeBrowserAudio({configuration,audio:Buffer.from('audio').toString('base64'),format:'wav'}),{statusCode:502,message:/Transcription returned invalid text/});
  }
});

test('a draft exhausted by reasoning reports the output limit without retrying or exposing provider content',async t=>{
  let calls=0;
  let content:unknown=null;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return Response.json({choices:[{finish_reason:'length',message:{content,reasoning:'private provider reasoning'}}],usage:{completion_tokens:4096,completion_tokens_details:{reasoning_tokens:4096}}});
  });
  const draft=()=>draftBrowserCase({configuration,description:'Create, save, reopen and run a workflow twice, checking its credits and history.',sourceContext:'{}'});
  await assert.rejects(draft(),{statusCode:502,message:'The model reached its output limit before finishing the test. Shorten the description or choose another model in Settings.'});
  assert.equal(calls,1,'An incomplete paid response is never retried automatically');
  // Even parseable content is incomplete when the provider explicitly says it was truncated.
  content=JSON.stringify({case:candidate});
  await assert.rejects(draft(),/output limit/);
  assert.equal(calls,2);
});

test('case drafting uses the catalog-selected effort without excluding lower-output-limit models',async t=>{
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    const request=JSON.parse(String(options.body));
    assert.equal(request.reasoning?.max_tokens,undefined);
    assert.equal(request.reasoning?.effort,'low');
    assert.equal(request.reasoning?.exclude,true,'Internal reasoning is not needed to validate a draft');
    assert.equal(request.max_tokens,4096,'Keep the existing total cap for selectable models limited to 4096 output tokens');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({case:candidate})}}]});
  });
  const result=await draftBrowserCase({configuration,description:'Save and reopen workspace settings.',sourceContext:'{}',reasoning:{effort:'low',exclude:true}});
  assert.equal(result.needsReview,true);
  assert.equal(result.selected,false);
});


test('a single standalone JSON fence is accepted without accepting prose, partial or multiple proposals',async t=>{
  const json=JSON.stringify({case:candidate});
  let content=`  \n\x60\x60\x60json\n${json}\n\x60\x60\x60\n `,finish='stop';
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{finish_reason:finish,message:{content}}]}));
  const draft=()=>draftBrowserCase({configuration,description:'Save and reopen workspace settings.',sourceContext:'{}'});
  const accepted=await draft();
  assert.equal(accepted.needsReview,true);assert.equal(accepted.selected,false);assert.deepEqual(accepted.steps,candidate.steps);
  for(const invalid of [`Here is the test:\n${content}`,`${content}Extra text`,`${content}\n${content}`,`\x60\x60\x60json\n${json}`,`\x60\x60\x60json\n{broken}\n\x60\x60\x60`, `\x60\x60\x60json\n${JSON.stringify({case:{...candidate,steps:[]}})}\n\x60\x60\x60`]){
    content=invalid;await assert.rejects(draft(),/valid test/);
  }
  content=`\x60\x60\x60json\n${json}\n\x60\x60\x60`;finish='length';
  await assert.rejects(draft(),/output limit/);
});
