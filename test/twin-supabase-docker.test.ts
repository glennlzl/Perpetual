import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import { failureText, redact } from '../src/redaction.ts';
import { supabaseEdgeFiles, supabaseLegacyEdgeFiles } from './fixtures/twin/supabase-edge.ts';

const skip = process.env.PERPETUAL_DOCKER_TESTS === '1' ? false : 'Set PERPETUAL_DOCKER_TESTS=1 to run the pinned Supabase CLI against Docker.';

// Top-level tests run serially; after() releases this stack before the next claims the same port range.
for (const [kind, files] of [['deno.json', supabaseEdgeFiles], ['legacy import_map', supabaseLegacyEdgeFiles]] as const) {
test(`Supabase edge functions survive rebuilding the same environment with ${kind}`, { skip, timeout: 1200000 }, async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-supabase-smoke-'))), source = join(dataDir, 'source');
  const id = `edge-${randomBytes(4).toString('hex')}`, runtime = createTwinRuntime({ portBase: 47100 });
  let preparing: ReturnType<typeof runtime.prepare> | undefined;
  t.after(async () => {
    // A timeout aborts preparation; join its child processes before tearing down their owned containers.
    await preparing?.catch(() => {});
    await runtime.destroy({ dataDir, id });
    await rm(dataDir, { recursive: true, force: true });
  });
  for (const [path, content] of Object.entries(files)) {
    const file = join(source, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  let response = { status: 0, body: '' };
  try {
    // Rebuild deletes and recreates the bind's ancestors; a first start alone missed a Docker Desktop copy failure.
    for (let iteration = 1; iteration <= 2; iteration++) {
      response = { status: 0, body: '' };
      preparing = runtime.prepare({ dataDir, id, source, signal: t.signal, config: { services: { supabase: { functions: { noVerifyJwt: ['hello'] } } } } });
      assert.equal((await preparing).status, 'ready');
      // The service runs outside Compose; its reserved address is controller-owned runtime state.
      const state = JSON.parse(await readFile(join(dataDir, 'environments', id, 'twin', 'twin.json'), 'utf8')) as { ports: Record<string, number> };
      const url = `http://127.0.0.1:${state.ports['supabase.api']}/functions/v1/hello`;
      // GET readiness only: the first request boots the function worker. Other statuses fail immediately.
      const warmup = AbortSignal.any([t.signal, AbortSignal.timeout(120000)]);
      while (!warmup.aborted) {
        try {
          const reply = await fetch(url, { signal: AbortSignal.any([warmup, AbortSignal.timeout(20000)]) });
          response = { status: reply.status, body: await reply.text() };
        } catch (error) { response = { status: 0, body: failureText(error, 2000) }; }
        if (![0, 502, 503, 504].includes(response.status)) break;
        await delay(2000, undefined, { signal: warmup }).catch(() => {});
      }
      assert.equal(response.status, 200, `preparation ${iteration}`);
      assert.deepEqual(JSON.parse(response.body), { message: 'hello acme', suffix: 'acme' });
      t.diagnostic(`Preparation ${iteration}: function returned HTTP 200 with the expected imports`);
    }
  } catch (error) {
    const logs = await runtime.logs({ dataDir, id }).catch(failure => failureText(failure, 2000));
    throw new Error(redact(`${failureText(error, 2000)}\nResponse ${response.status}: ${response.body}\nTwin logs:\n${logs}`));
  }
});
}
