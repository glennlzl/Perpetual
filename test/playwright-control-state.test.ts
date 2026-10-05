import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { controlReads } from '../src/journeys/playwright/control.ts';
import type { EvaluatedCheck } from '../src/journeys/playwright/checks.ts';

// Network ordering around a judged document, independent of browser timing. Real browser/controller
// persistence and POST interference cases live in playwright-control-read.test.ts.
function setup() {
  const page = () => { let url = 'http://app.test/'; const events = new EventEmitter(), frame = { parentFrame: () => null, url: () => url }; return Object.assign(events, { mainFrame: () => frame, url: frame.url, isClosed: () => false, setUrl(value: string) { url = value; } }) as unknown as Page & EventEmitter & { setUrl(value: string): void }; };
  const first = page(), second = page(), context = Object.assign(new EventEmitter(), { pages: () => [first, second] });
  const reads = controlReads(context as unknown as BrowserContext);
  function request(target = first, method = 'GET') { const url = target.url(); return { frame: () => ({ page: () => target, parentFrame: () => null }), isNavigationRequest: () => true, method: () => method, url: () => url } as unknown as Request; }
  function fresh(target = first, status = 200) {
    const req = request(target); context.emit('request', req);
    context.emit('response', { request: () => req, ok: () => status === 200, status: () => status });
    target.emit('framenavigated', target.mainFrame()); context.emit('requestfinished', req); return req;
  }
  const failed: EvaluatedCheck = { type: 'text-visible', value: 'Name {run}', passed: false };
  return { reads, first, second, context, request, fresh, failed };
}

test('only the failing page fresh after its blocked change can certify a control failure', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh(f.second);
  assert.equal(f.reads.eligible(f.first, f.failed), false);
  assert.equal(f.reads.eligible(f.second, f.failed), false);
  f.fresh(); assert.equal(f.reads.eligible(f.first, f.failed), true);
  assert.equal(f.reads.eligible(f.first, { ...f.failed, passed: true }), false);
  for (const check of [{type:'text-visible',value:'Saved',passed:false},{type:'url-contains',value:'/{run}',passed:false}] as EvaluatedCheck[]) assert.equal(f.reads.eligible(f.first, check), false);
  f.reads.blocked(f.first); assert.equal(f.reads.eligible(f.first, f.failed), false);
});

test('failed reads, uncommitted documents and later blocked reads cannot certify persistence', () => {
  const f = setup(); f.reads.blocked(f.first);
  f.fresh(f.first, 503); assert.equal(f.reads.eligible(f.first, f.failed), false);
  const req = f.request(); f.context.emit('request', req); f.context.emit('response', {request:()=>req,ok:()=>true,status:()=>200}); f.context.emit('requestfinished',req);
  assert.equal(f.reads.eligible(f.first,f.failed),false);
  f.first.emit('framenavigated',f.first.mainFrame()); assert.equal(f.reads.eligible(f.first,f.failed),true);
  f.context.emit('requestfailed',f.request()); assert.equal(f.reads.eligible(f.first,f.failed),false);
  f.fresh(); f.reads.blockedRequest(f.request(f.first,'POST')); assert.equal(f.reads.eligible(f.first,f.failed),false);
});

test('numeric control evidence requires a finite read and baseline captured before the blocked change', () => {
  const f = setup(), failed: EvaluatedCheck = {type:'compare-number',label:'Notes',name:'after',op:'>',than:'before',observed:4,passed:false};
  f.reads.captured({type:'read-number',label:'Notes',name:'before',observed:4,passed:true});
  f.reads.blocked(f.first); f.fresh(); assert.equal(f.reads.eligible(f.first,failed),true);
  assert.equal(f.reads.eligible(f.first,{...failed,observed:undefined}),false);
  assert.equal(f.reads.eligible(f.first,{...failed,observed:NaN}),false);
  assert.equal(f.reads.eligible(f.first,{...failed,than:'missing'}),false);
  assert.equal(f.reads.eligible(f.first,{...failed,error:'Read failed'}),false);
  f.reads.captured({type:'read-number',label:'Notes',name:'before',observed:4,passed:true});
  assert.equal(f.reads.eligible(f.first,failed),false);
});

test('a fresh document that arrives during a failed observation cannot certify the earlier page', () => {
  const f = setup(); f.reads.blocked(f.first);
  const observed = f.reads.observation(f.first);
  f.fresh();
  assert.equal(observed(f.failed), undefined, 'The document was not ready when the check observed its failure.');
});

test('a control witness remains owned by its observed document through finalization', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh();
  const witness = f.reads.observation(f.first)(f.failed);
  assert.ok(witness);
  assert.equal(witness(), true);
  f.fresh();
  assert.equal(witness(), false, 'A later successful GET of the same URL cannot replace the checked document.');
});

test('a blocked read during observation cannot be erased by a new document before certification', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh();
  const observed = f.reads.observation(f.first);
  f.reads.blockedRequest(f.request(f.first, 'POST')); f.fresh();
  assert.equal(observed(f.failed), undefined);
});

test('a delayed blocked response does not invalidate the fresh document after that blocked change', () => {
  const f = setup(), write = f.request(f.first, 'POST');
  f.context.emit('request', write); f.reads.blockedRequest(write);
  f.fresh();
  const witness = f.reads.observation(f.first)(f.failed);
  assert.ok(witness);
  // A paired response wait can start the reload before Playwright delivers its response event.
  f.context.emit('response', { request: () => write, ok: () => false, status: () => 503 });
  assert.equal(witness(), true, 'This is the already blocked change, not a failed read of the new document.');
  const read = f.request();
  f.context.emit('response', { request: () => read, ok: () => false, status: () => 503 });
  assert.equal(witness(), false, 'An actual failed read still makes the new document unreadable.');
  f.fresh();
  f.context.emit('requestfailed', write);
  assert.equal(f.reads.eligible(f.first, f.failed), false, 'A failed transport remains inconclusive, even for a blocked request.');
  assert.equal(f.reads.observation(f.first).reason(f.failed)(), 'blocked-request-failed', 'An aborted blocked write is distinguished from an application read failure.');
});

test('a later blocked request invalidates the fresh document even when its response is ignored', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh();
  const witness = f.reads.observation(f.first)(f.failed);
  assert.ok(witness);
  const write = f.request(f.first, 'POST');
  f.context.emit('request', write); f.reads.blockedRequest(write);
  f.context.emit('response', { request: () => write, ok: () => false, status: () => 503 });
  assert.equal(witness(), false);
});

test('a canonicalized address explains rejection without qualifying the changed document', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh();
  f.first.setUrl('http://app.test/saved-name/');
  const observed = f.reads.observation(f.first);
  assert.equal(observed(f.failed), undefined);
  assert.equal(observed.reason(f.failed)(), 'url-changed');
});

test('a blocked communication after readback retains its rejection reason through finalization', () => {
  const f = setup(); f.reads.blocked(f.first); f.fresh();
  const observed = f.reads.observation(f.first), witness = observed(f.failed);
  assert.ok(witness); f.reads.blocked(f.first);
  assert.equal(witness(), false);
  assert.equal(observed.reason(f.failed)(), 'blocked-after-read');
});

test('a read arriving after the observation cannot replace its missing-read diagnosis', () => {
  const f = setup(); f.reads.blocked(f.first);
  const observed = f.reads.observation(f.first);
  f.fresh(); assert.equal(observed(f.failed), undefined);
  assert.equal(observed.reason(f.failed)(), 'no-fresh-document');
});

test('blocked HTTP evidence belongs to the judged page and omits request contents',()=>{
  const f=setup(), request={...f.request(f.first,'POST'),url:()=> 'http://viewer:private@app.test/save?token=private#private',postData:()=>{assert.fail('Evidence must not read request bodies');},headers:()=>{assert.fail('Evidence must not read headers');}} as unknown as Request;
  f.reads.blockedRequest(request);f.fresh();f.reads.blockedRequest({...request,url:()=> 'http://app.test/read'} as Request);
  const blocks=(f.reads as unknown as {blocks(page:Page):unknown}).blocks;
  assert.deepEqual(blocks(f.first),[{kind:'http',method:'POST',url:'http://app.test/save',afterRead:false},{kind:'http',method:'POST',url:'http://app.test/read',afterRead:true}]);
  assert.deepEqual(blocks(f.second),[]);assert.equal(f.reads.eligible(f.first,f.failed),false);
});

test('later socket blocks keep their read phase and evidence drops old distinct entries at ten',()=>{
  const f=setup();f.reads.blockedRequest(f.request(f.first,'POST'));f.fresh();
  f.reads.blocked(f.first,{kind:'socket',transport:'websocket'});f.reads.blocked(f.first,{kind:'socket',transport:'websocket'});
  assert.deepEqual(f.reads.blocks(f.first).at(-1),{kind:'socket',transport:'websocket',afterRead:true});
  assert.equal(f.reads.blocks(f.first).length,2);
  for(let i=0;i<11;i++)f.reads.blocked(f.first,{kind:'http',method:'PATCH',url:`http://app.test/resource/${i}`});
  const blocks=f.reads.blocks(f.first);assert.equal(blocks.length,10);
  assert.equal(blocks[0].kind==='http'&&blocks[0].url,'http://app.test/resource/1');
  assert.ok(blocks.every(block=>block.afterRead));
  blocks.pop();assert.equal(f.reads.blocks(f.first).length,10,'Evidence readers cannot mutate retained state.');
  assert.equal(f.reads.eligible(f.first,f.failed),false);
});

test('a failed request cannot erase the read phase of a later blocked transport',()=>{
  const f=setup();f.reads.blockedRequest(f.request(f.first,'POST'));f.fresh();
  f.reads.blocked(f.first,{kind:'socket',transport:'websocket'});
  f.context.emit('requestfailed',f.request());
  f.reads.blocked(f.first,{kind:'http',method:'POST',url:'http://app.test/read'});
  assert.equal(f.reads.blocks(f.first).at(-1)?.afterRead,true);
  assert.equal(f.reads.eligible(f.first,f.failed),false);
});
