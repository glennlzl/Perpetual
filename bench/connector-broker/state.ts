import { basename, dirname, resolve, join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../../src/store.ts';
import type { BrokerState, BrokerStateStore } from './broker.ts';

const INVALID = 'Invalid broker connection state.';

/** Opens the private, atomic state file kept beside principals.json. */
export async function createBrokerStateStore(file: string): Promise<BrokerStateStore> {
  const directory = await privateDirectory(dirname(resolve(file)), INVALID);
  const path = join(directory, basename(file));
  const queue = createSaveQueue();
  return {
    async load() {
      try { return await readStateFile(path, { limit: 64 * 1024, invalid: INVALID }); }
      catch { throw new Error(INVALID); }
    },
    save(state: BrokerState) {
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) return Promise.reject(new Error(INVALID));
      return queue.run(() => writeStateFile(path, serialized, { prefix: '.connections-' }));
    },
  };
}
