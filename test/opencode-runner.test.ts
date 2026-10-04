import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeRunner, openrouterRefusal, type RunFailure } from '../src/agents/opencode.ts';

const refusal = 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.';
const advice = 'Wait for active OpenRouter requests to finish or add credits, then try again.';
const secret = 'fixture-provider-key-8291';
const messages = { cancelled: 'Writing code cancelled.', timedOut: 'Writing code timed out.', stopped: 'The code generator stopped.', unavailable: 'The code generator is unavailable.' };
// Readiness uses a real clock even when a deadline test advances the supervisor's clock.
const realSetTimeout = setTimeout;

async function setup(t: TestContext, message: string, { keepAlive = false, ignoreTermination = false }: { keepAlive?: boolean; ignoreTermination?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'perpetual-opencode-refusal-'));
  const ready = join(cwd, 'ready');
  let calls = 0;
  const runner = createOpencodeRunner({ model: 'example/model', cwd, env: { OPENROUTER_API_KEY: secret }, secrets: [secret],
    timeoutMs: 30_000, cleanupGraceMs: 100, messages,
    harness: () => {
      calls++;
      return { command: process.execPath, args: ['--input-type=module', '-e', `
        import { writeFileSync } from 'node:fs';
        ${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}
        console.error('tool: read requirements; key=' + process.env.OPENROUTER_API_KEY);
        console.error('Error: ' + ${JSON.stringify(message)});
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        ${keepAlive ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 1;'}
      `] };
    },
  });
  t.after(async () => { runner.cancel(); await rm(cwd, { recursive: true, force: true }); });
  return { runner, calls: () => calls, async ready() {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      if (await readFile(ready, 'utf8').catch(() => '') === 'ready') return;
      await new Promise(resolve => realSetTimeout(resolve, 10));
    }
    throw new Error('The local refusal fixture did not start.');
  } };
}

test('in-flight credit reservations give wait-or-add guidance without claiming an empty account', () => {
  assert.equal(openrouterRefusal(`Error: ${refusal}`), advice);
  assert.equal(openrouterRefusal(`tool: searched for "${refusal}"`), undefined, 'A tool match is not a provider refusal.');
});

for (const [message, expected] of [
  [refusal, advice],
  ['This request requires more credits, or fewer max_tokens.', 'Add credits to your OpenRouter account and try again.'],
  ['Invalid API key', 'Check your OpenRouter API key in Settings.'],
  ['{"code":400,"message":"The provider rejected a request parameter."}', 'The selected model does not work with this agent. Choose another model in Settings.'],
] as const) test(`a stopped provider refusal presents only its action while retaining redacted diagnostics: ${message}`, async t => {
  const f = await setup(t, message);
  await assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.message, expected);
    assert.equal(error.reason, expected);
    assert.match(error.output, /tool: read requirements/);
    assert.ok(error.output.includes(message));
    assert.ok(!JSON.stringify({ message: error.message, reason: error.reason, output: error.output }).includes(secret));
    assert.equal(error.timedOut, undefined);
    assert.equal(error.cleanupIncomplete, undefined);
    return true;
  });
  assert.equal(f.calls(), 1, 'A refusal never retries the agent.');
});

test('an unrecognized agent failure keeps its diagnostic in the displayed error', async t => {
  const f = await setup(t, 'The test file could not be written.');
  await assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.match(error.message, /The test file could not be written/);
    assert.match(error.output, /tool: read requirements/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(f.calls(), 1);
});

async function capture(t: TestContext, chunks: string[], { exit = 0, secrets = [], env = {}, harnessEnv = {}, structuredOutput = false }: { structuredOutput?: boolean; exit?: number; secrets?: string[]; env?: Record<string, string>; harnessEnv?: Record<string, string> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'perpetual-opencode-output-'));
  await writeFile(join(cwd, 'chunks.json'), JSON.stringify(chunks));
  const runner = createOpencodeRunner({ model: 'example/model', cwd, env, secrets, structuredOutput, timeoutMs: 30_000, cleanupGraceMs: 1000, messages,
    harness: () => ({ command: process.execPath, env: harnessEnv, args: ['--input-type=module', '-e', `
      import {readFile} from 'node:fs/promises';
      for (const chunk of JSON.parse(await readFile('chunks.json','utf8'))) {
        await new Promise(resolve => process.${exit && !structuredOutput ? 'stderr' : 'stdout'}.write(chunk, resolve));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      process.exitCode = ${exit};
    `] }) });
  t.after(async () => { runner.cancel(); await rm(cwd, { recursive: true, force: true }); });
  return runner.run('Write the reviewed data.');
}

test('agent output redacts complete credential blocks before retaining a success or failure tail', async t => {
  for (const exit of [0, 1]) await t.test(`exit ${exit}`, async t => {
    const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(300), '-----END PRIVATE KEY-----\nFinished.\n'], { exit });
    const result = exit ? await promise.catch((error: RunFailure) => error) : await promise;
    assert.ok(!result.output.includes('private-fixture-body'));
    assert.ok(result.output.includes('Finished.'), 'Ordinary diagnostic text remains useful.');
    if ('reason' in result) assert.equal(result.reason, messages.stopped);
  });
});

test('an agent that stops inside a credential block never returns its unfinished body', async t => {
  const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(300)], { exit: 1 });
  await assert.rejects(promise, (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.ok(!error.output.includes('private-fixture-body'));
    assert.ok(error.output.includes('[REDACTED]'));
    return true;
  });
});

test('agent output hides a supplied value across stream chunks without retaining a suffix', async t => {
  const secret = `supplied-fixture-${'q'.repeat(5000)}-end`;
  const result = await capture(t, [secret.slice(0, 4500), secret.slice(4500), '\nFinished.\n'], { secrets: [secret] });
  assert.ok(!result.output.includes('q'.repeat(30)));
  assert.ok(result.output.includes('[REDACTED]'));
  assert.ok(result.output.includes('Finished.'));
});

test('agent output protects the effective process model key before clipping without requiring duplicate secrets', async t => {
  const key = `private-model-credential-${'q'.repeat(40)}`;
  for (const input of [{ env: { OPENROUTER_API_KEY: key } }, { harnessEnv: { OPENROUTER_API_KEY: key } }]) {
    const result = await capture(t, [`${key}${'.'.repeat(3970)}`], input);
    assert.ok(!result.output.includes('q'.repeat(10)));
  }
});

test('incomplete captured output is withheld while the actual agent outcome remains known', async t => {
  const promise = capture(t, ['-----BEGIN PRIVATE KEY-----\n', 'private-fixture-body\n'.repeat(30_000), '-----END PRIVATE KEY-----\n'], { exit: 1 });
  await assert.rejects(promise, (error: RunFailure) => {
    assert.equal(error.reason, messages.stopped);
    assert.equal(error.timedOut, undefined);
    assert.ok(!error.output.includes('private-fixture-body'));
    assert.match(error.output, /output.*withheld/i);
    return true;
  });
});

test('cancellation takes precedence over provider refusal output', async t => {
  const f = await setup(t, refusal, { keepAlive: true });
  const failed = assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.equal(error.reason, messages.cancelled);
    assert.equal(error.message, messages.cancelled);
    assert.equal(error.output, '');
    assert.equal(error.timedOut, undefined);
    return true;
  });
  await f.ready();
  f.runner.cancel();
  await failed;
  assert.equal(f.calls(), 1);
});

for (const ignoreTermination of [false, true]) test(`deadline and cleanup ownership take precedence over provider refusal (forced cleanup: ${ignoreTermination})`, async t => {
  const f = await setup(t, refusal, { keepAlive: true, ignoreTermination });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(f.runner.run('Write the reviewed test.'), (error: RunFailure) => {
    assert.ok(error.reason.startsWith(messages.timedOut));
    assert.equal(error.timedOut, true);
    assert.equal(error.cleanupIncomplete, ignoreTermination ? true : undefined);
    if (ignoreTermination) assert.match(error.reason, /Cleanup incomplete/);
    assert.ok(error.output.includes(refusal), 'The process actually emitted the provider refusal before the deadline.');
    assert.ok(!error.message.includes(advice), 'The refusal must not override the deadline.');
    assert.ok(!error.output.includes(secret));
    return true;
  });
  await f.ready();
  t.mock.timers.tick(30_000);
  if (ignoreTermination) t.mock.timers.tick(100);
  await failed;
  assert.equal(f.calls(), 1);
});

const jsonTool=(tool='playwright-test_browser_click',status='completed')=>JSON.stringify({type:'tool_use',timestamp:1700000000000,sessionID:'ses_private',part:{id:'prt_private',type:'tool',tool,callID:'private-call',state:{status,input:{url:'https://private.invalid/account',password:'personal-password'},output:'Private page and account contents',time:{start:1700000000000,end:1700000000001}}}})+'\n';
const jsonFinish=JSON.stringify({type:'step_finish',timestamp:1700000000002,part:{type:'step-finish',reason:'stop',cost:0.001,tokens:{input:10,output:20,reasoning:2,cache:{read:3,write:0}}}})+'\n';
test('a JSON tool failure retains its safe category after the event limit, never its page or error text',async t=>{
  const failure=JSON.stringify({type:'tool_use',part:{type:'tool',tool:'playwright-test_browser_handle_dialog',state:{status:'error',error:'Error: No dialog visible\nPrivate account contents and personal-password',input:{password:'personal-password'}}}})+'\n';
  const result=await capture(t,[jsonTool().repeat(65),failure,jsonFinish],{structuredOutput:true});
  assert.deepEqual(result.evidence.lastToolError,{tool:'browser_handle_dialog',kind:'no-native-dialog'});
  assert.equal(result.evidence.events.length,64);
  assert.equal(result.output,'');
  for(const privateText of ['Private account','personal-password','No dialog visible'])assert.ok(!JSON.stringify(result).includes(privateText));
});

test('tool failures allowlist categories and hide supplied values before classifying',async t=>{
  for(const [text,kind,secrets] of [
    ['Ref e12 not found in the current page snapshot. Private page','stale-reference',[]],
    ['locator.click: strict mode violation: private account','ambiguous-locator',[]],
    ['TimeoutError: private request','timeout',[]],
    ['Unknown private request failure','unknown',[]],
    ['TimeoutError: private request','unknown',['TimeoutError']],
  ] as const)await t.test(kind,async t=>{
    const event=JSON.stringify({type:'tool_use',part:{type:'tool',tool:'playwright-test_browser_click',state:{status:'error',error:text}}})+'\n';
    const result=await capture(t,[event],{structuredOutput:true,secrets:[...secrets]});
    assert.deepEqual(result.evidence.lastToolError,{tool:'browser_click',kind});
    assert.ok(!JSON.stringify(result).includes('private'));
  });
});

test('the actual harness stream retains only structured safe tool outcomes and provider metadata',async t=>{
  const result=await capture(t,[jsonTool(),jsonFinish]) as unknown as {evidence:{outcome:string;events:unknown[];reportedFinishReason:string;usage:unknown;outputHash:string;outputBytes:number}};
  assert.ok(result.evidence,'Successful harness output must retain safe authoring evidence.');
  assert.equal(result.evidence.outcome,'completed');
  assert.deepEqual(result.evidence.events,[{tool:'browser_click',outcome:'completed'}]);
  assert.equal(result.evidence.reportedFinishReason,'stop');
  assert.deepEqual(result.evidence.usage,{input:10,output:20,reasoning:2,cacheRead:3,cacheWrite:0,cost:0.001});
  assert.match(result.evidence.outputHash,/^[a-f0-9]{64}$/);
  for(const sensitive of ['private.invalid','personal-password','Private page','ses_private','private-call'])assert.ok(!JSON.stringify(result.evidence).includes(sensitive));
});

test('unstructured comments, unknown tool names and terminal prose never become authoring facts',async t=>{
  const result=await capture(t,['Clicked Save successfully; budget exhausted.\n',jsonTool('custom-secret-tool'),JSON.stringify({type:'step_finish',part:{type:'step-finish',reason:'private account ran out of money',tokens:{input:'12'}}})+'\n']) as unknown as {evidence:{events:unknown[];reportedFinishReason:string;usage:unknown}};
  assert.ok(result.evidence);
  assert.deepEqual(result.evidence.events,[{tool:'unknown',outcome:'completed'}]);
  assert.equal(result.evidence.reportedFinishReason,'unknown');
  assert.equal(result.evidence.usage,null);
  assert.ok(!JSON.stringify(result.evidence).includes('private account'));
});

test('structured output split across chunks hides supplied values before projection and bounds oversized events',async t=>{
  const event=jsonTool('playwright-test_browser_click');
  const result=await capture(t,[event.slice(0,event.indexOf('browser_click')+8),event.slice(event.indexOf('browser_click')+8),JSON.stringify({type:'text',part:{text:'sk-fixture-secret-value-'+ 'a'.repeat(300000)}})+'\n',jsonFinish],{secrets:['browser_click']}) as unknown as {evidence:{events:unknown[];eventsTruncated:boolean;reportedFinishReason:string;outputBytes:number}};
  assert.ok(result.evidence);
  assert.deepEqual(result.evidence.events,[{tool:'unknown',outcome:'completed'}],'A supplied secret must never survive even as a tool identifier.');
  assert.equal(result.evidence.eventsTruncated,true);
  assert.equal(result.evidence.reportedFinishReason,'stop');
  assert.ok(!JSON.stringify(result.evidence).includes('fixture-secret'));
});


test('JSON-mode failures never turn tool inputs or page contents into a displayed tail',async t=>{
  const event=jsonTool('playwright-test_browser_click','error');
  await assert.rejects(capture(t,[event],{exit:1,structuredOutput:true}),(error:RunFailure)=>{
    assert.equal(error.message,messages.stopped);assert.equal(error.output,'');
    assert.ok(!JSON.stringify(error).includes('private.invalid'));assert.ok(!JSON.stringify(error).includes('personal-password'));
    return true;
  });
});

test('JSON-mode structured provider errors retain fixed actionable refusal guidance',async t=>{
  const event=JSON.stringify({type:'error',error:{name:'APIError',data:{message:refusal,responseBody:'private provider payload',responseHeaders:{authorization:'private header'}}}})+'\n';
  await assert.rejects(capture(t,[event],{exit:1,structuredOutput:true}),(error:RunFailure)=>{
    assert.equal(error.message,advice);assert.equal(error.output,'');assert.equal(error.evidence?.reportedFinishReason,'unknown');
    return true;
  });
});


test('authoring output hashes ignore stream chunk boundaries and event count is bounded',async t=>{
  const output=jsonTool().repeat(70)+jsonFinish;
  const first=await capture(t,[output]),second=await capture(t,[output.slice(0,177),output.slice(177)]);
  assert.equal(first.evidence.outputHash,second.evidence.outputHash);
  assert.equal(first.evidence.events.length,64);assert.equal(first.evidence.eventsTruncated,true);
  assert.equal(first.evidence.reportedFinishReason,'stop');
});

test('a JSON provider refusal with zero exit retains fixed guidance without retaining its payload',async t=>{
  const event=JSON.stringify({type:'error',error:{name:'APIError',data:{message:refusal,responseBody:'private provider payload'}}})+'\n';
  const result=await capture(t,[event],{structuredOutput:true});
  assert.equal(result.output,advice);assert.equal(result.evidence.outcome,'completed');assert.equal(result.evidence.reportedFinishReason,'unknown');
  assert.ok(!JSON.stringify(result).includes('private provider payload'));
});
