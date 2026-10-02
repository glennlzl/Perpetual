import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { controlReads } from '../src/journeys/playwright/control.ts';
import type { EvaluatedCheck } from '../src/journeys/playwright/checks.ts';

// Network ordering around a judged document, independent of browser timing. Real browser/controller
// persistence and POST interference cases live in playwright-control-read.test.ts.
function setup() {
  const page = () => { const events = new EventEmitter(), frame = { parentFrame: () => null, url: () => 'http://app.test/' }; return Object.assign(events, { mainFrame: () => frame, url: frame.url, isClosed: () => false }) as unknown as Page & EventEmitter; };
  const first = page(), second = page(), context = Object.assign(new EventEmitter(), { pages: () => [first, second] });
  const reads = controlReads(context as unknown as BrowserContext);
  function request(target = first, method = 'GET') { return { frame: () => ({ page: () => target, parentFrame: () => null }), isNavigationRequest: () => true, method: () => method, url: () => target.url() } as unknown as Request; }
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
