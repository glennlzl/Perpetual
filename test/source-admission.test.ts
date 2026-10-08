import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The controller admits a request for a source once, in createController's helpers: one hold on the
// source, one active-scan check before and after the work, one Sandbox stage lookup. A route that
// copied them by hand is where the rule drifted before.
const source = () => readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
const count = (text: string, needle: string | RegExp) => (text.match(needle instanceof RegExp ? needle : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

test('the source is held in one place, and every change to it runs under that hold', async () => {
  const text = await source();
  assert.equal(count(text, 'sourceBusy=true;'), 1, 'withSourceHeld sets the hold');
  assert.equal(count(text, 'sourceBusy=false;'), 1, 'and releases it in its finally');
  assert.equal(count(text, 'withSourceHeld('), 6, 'the move, connect, disconnect, source, scan and Production branch changes');
  assert.match(text, /guard\(\);sourceBusy=true;try\{return await work\(\);\}finally\{sourceBusy=false;\}/, 'The guard runs before the hold, and the hold outlives a failed save.');
});

test('a reply never describes another source: one check before the work and one after it', async () => {
  const text = await source();
  // Source changes during asynchronous gate and release requests are exercised by their API tests;
  // the number of source guards is not itself a behavioral invariant.
  assert.equal(count(text, /!scan ?\|\| ?(?:input|requestUrl\.searchParams\.get\('repoPath'\))/g), 0, 'No route compares repoPath by hand.');
  assert.equal(count(text, 'stages.find(item=>item.id==='), 2, 'sandboxStage, and the removal that outlives its stage');
  assert.equal(count(text, "'Choose a Sandbox stage.'"), 2);
  assert.equal(count(text, 'error.statusCode=409'), 1, 'Only the pipeline action, inside its save transaction, builds a 409 by hand.');
  // Sign-in start refuses only while the source is held, as busy: a pending sign-in returns its own snapshot.
  assert.match(text, /path==='\/api\/github\/auth\/start'\) \{\n\s+await body\(req\);\n\s+if\(sourceBusy\)throw busy\(\);/);
  // Every refusal while the source is held is marked busy, so a page's polls keep what they last read.
  assert.equal(count(text, 'conflict(SOURCE_BUSY)'), 1, 'busy() alone builds it');
  // The gate view takes no repoPath and refuses nothing: the client compares what it names with its own scan.
  assert.match(text, /path==='\/api\/gate'\)return reply\(res,200,\{repoPath:scan\.repo\.path,sha:scan\.repo\.sha\|\|null,\.\.\.gates\.view\(\)\}\)/);
});
