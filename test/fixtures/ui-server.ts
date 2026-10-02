import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type InlineConfig } from 'vite';

// Concurrent UI fixtures use different Vite plugins. Their optimizers must never replace
// another live server's dependency cache, including the user's development server's cache.
export async function createUiServer(t: TestContext, options: InlineConfig) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'perpetual-ui-cache-'));
  try {
    const server = await createServer({ ...options, cacheDir });
    t.after(async () => {
      try { await server.close(); }
      finally { await rm(cacheDir, { recursive: true, force: true }); }
    });
    return server;
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
