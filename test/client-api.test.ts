import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../client/src/lib/api.ts';

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
