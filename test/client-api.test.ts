import test from 'node:test';
import assert from 'node:assert/strict';
import { api, sourceBusy, type ApiError } from '../client/src/lib/api.ts';
import { fetchJourneyFrame } from '../client/src/lib/frame-store.ts';

// The page's own request helper, with fetch replaced as a stopped controller or an aborted request would answer.
test('a controller that refuses the connection reads as unavailable, while an aborted request keeps its reason', async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api('/api/state'), { message: 'The local server is unavailable. Try reconnecting.' });
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); throw new DOMException('The operation was aborted.', 'AbortError'); };
  await assert.rejects(api('/api/state', undefined, { signal: controller.signal }), { name: 'AbortError' });
  globalThis.fetch = async () => Response.json({ error: 'Choose a Sandbox stage.' }, { status: 400 });
  await assert.rejects(api('/api/browser'), { message: 'Choose a Sandbox stage.', statusCode: 400 });
});

// Journey frames are fetched outside api(), and word a stopped controller the same way.
test('a frame the stopped controller cannot send reads as unavailable, while an aborted fetch keeps its reason', async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const source = { repoPath: '/acme/app', stageId: 'beta', runId: '11111111-1111-4111-8111-111111111111', caseId: 'save' };
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(fetchJourneyFrame(source, new AbortController().signal), { message: 'The local server is unavailable. Try reconnecting.' });
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); throw new DOMException('The operation was aborted.', 'AbortError'); };
  await assert.rejects(fetchJourneyFrame(source, controller.signal), { name: 'AbortError' });
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await fetchJourneyFrame(source, new AbortController().signal), null);
});

// The controller marks a refusal made only while it saves a source change; polls keep what they last read on it.
test('a refusal while a source change saves carries its mark, and no other refusal does', async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => Response.json({ error: 'A source change is still being saved. Please wait.', sourceBusy: true }, { status: 409 });
  const busy = await api('/api/releases').catch((error: unknown) => error) as ApiError;
  assert.deepEqual([busy.message, busy.statusCode, busy.sourceBusy, sourceBusy(busy)], ['A source change is still being saved. Please wait.', 409, true, true]);
  globalThis.fetch = async () => Response.json({ error: 'The active repository changed. Reload its pipeline.' }, { status: 409 });
  const changed = await api('/api/releases').catch((error: unknown) => error) as ApiError;
  assert.deepEqual([changed.message, changed.statusCode, 'sourceBusy' in changed, sourceBusy(changed)], ['The active repository changed. Reload its pipeline.', 409, false, false]);
  for (const value of [null, 'busy', { sourceBusy: 'true' }, new Error('A source change is still being saved. Please wait.')]) assert.equal(sourceBusy(value), false);
});
