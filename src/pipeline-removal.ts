import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from './store.ts';
import { failureText } from './redaction.ts';
import type { PipelineRemoval } from '../contract/pipeline.ts';

export interface RemovalScope { project: string; key: string; stageIds: string[] }
interface Removal extends PipelineRemoval { scope: RemovalScope }
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const stamp = () => new Date().toISOString();
const publicRemoval = ({ scope, ...record }: Removal): PipelineRemoval => structuredClone(record);
function checkedScope(input: unknown): RemovalScope {
  if (!input || typeof input !== 'object') throw new Error('Invalid pipeline removal scope.');
  const value = input as Record<string, unknown>;
  if (typeof value.project !== 'string' || !value.project || value.project.length > 4096
    || typeof value.key !== 'string' || !value.key || value.key.length > 4096
    || !Array.isArray(value.stageIds) || value.stageIds.length > 2000
    || value.stageIds.some(id => typeof id !== 'string' || !id || id.length > 200)
    || new Set(value.stageIds).size !== value.stageIds.length) throw new Error('Invalid pipeline removal scope.');
  return { project: value.project, key: value.key, stageIds: value.stageIds as string[] };
}

/** Deletion intent survives its page and controller. Failed cleanup requires an explicit retry. */
export async function createPipelineRemovalManager({ dataDir, guard, cleanStage, removePipeline }: {
  dataDir: string; guard(scope: RemovalScope): void;
  cleanStage(scope: RemovalScope, stageId: string): Promise<void>;
  removePipeline(scope: RemovalScope): Promise<void>;
}) {
  const root = await privateDirectory(join(dataDir, 'pipeline-removals'), 'Pipeline removal storage must not be a symbolic link.', { resolveAliases: false });
  const file = join(root, 'state.json'), saved = await readStateFile(file, { limit: 4 * 1024 * 1024, invalid: 'Invalid pipeline removal state.' });
  let records: Removal[] = [];
  if (saved !== undefined) {
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1
      || !('removals' in saved) || !Array.isArray(saved.removals) || saved.removals.length > 2000) throw new Error('Invalid pipeline removal state.');
    const keys = new Set<string>();
    records = saved.removals.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid pipeline removal state.');
      const record = value as Record<string, unknown>, scope = checkedScope(record.scope);
      if (keys.has(scope.key) || typeof record.id !== 'string' || !['queued', 'removing', 'completed', 'failed'].includes(String(record.status))
        || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
        || record.error !== undefined && typeof record.error !== 'string') throw new Error('Invalid pipeline removal state.');
      keys.add(scope.key);
      return { id: record.id, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.error === undefined ? {} : { error: record.error }), scope } as Removal;
    });
  }
  const saves = createSaveQueue(), jobs = new Map<string, Promise<void>>(), admissions = new Map<string, Promise<unknown>>();
  let closed = false;
  const persist = () => saves.run(() => {
    const content = JSON.stringify({ version: 1, removals: records });
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Pipeline removal history is full.');
    return writeStateFile(file, content, { removeTemporary: true });
  });
  function launch(record: Removal) {
    if (closed || jobs.has(record.scope.key)) return;
    const job = Promise.resolve().then(async () => {
      try {
        record.status = 'removing'; record.updatedAt = stamp(); delete record.error; await persist();
        for (const id of record.scope.stageIds) {
          if (closed) { record.status = 'queued'; await persist(); return; }
          await cleanStage(record.scope, id);
        }
        if (closed) { record.status = 'queued'; await persist(); return; }
        await removePipeline(record.scope);
        record.status = 'completed'; record.updatedAt = stamp(); await persist();
      } catch (error) {
        record.status = 'failed'; record.error = failureText(error, 1500); record.updatedAt = stamp(); await persist();
      }
    }).finally(() => jobs.delete(record.scope.key));
    jobs.set(record.scope.key, job);
    job.catch(error => process.stderr.write(`Pipeline removal: ${failureText(error, 1500)}\n`));
  }
  const manager = {
    view(project: string) { const record = records.findLast(item => item.scope.project === project); return record ? publicRemoval(record) : null; },
    blocks(project: string) { return records.some(item => item.scope.project === project && item.status !== 'completed'); },
    async start(value: RemovalScope) {
      if (closed) throw conflict('The controller is shutting down.');
      const scope = checkedScope(value);
      if (admissions.has(scope.key)) {
        await admissions.get(scope.key);
        const accepted = records.find(item => item.scope.key === scope.key);
        if (!accepted) throw conflict('Pipeline deletion was not accepted. Retry its deletion.');
        return publicRemoval(accepted);
      }
      let record = records.find(item => item.scope.key === scope.key);
      if (record && (jobs.has(scope.key) || record.status === 'completed')) return publicRemoval(record);
      guard(scope);
      const previous = record ? structuredClone(record) : null;
      if (!record) {
        if (records.length >= 2000) throw new Error('Pipeline removal history is full.');
        record = { id: randomUUID(), scope, status: 'queued', createdAt: stamp(), updatedAt: stamp() }; records.push(record);
      }
      record.scope.stageIds = [...new Set([...record.scope.stageIds, ...scope.stageIds])];
      record.status = 'queued'; record.updatedAt = stamp(); delete record.error;
      const accepted = persist(); admissions.set(scope.key, accepted);
      try { await accepted; launch(record); return publicRemoval(record); }
      catch (error) { if (previous) Object.assign(record, previous); else records = records.filter(item => item !== record); throw error; }
      finally { admissions.delete(scope.key); }
    },
    async awaitIdle(key: string) { await admissions.get(key); await jobs.get(key); },
    resume() { for (const record of records) if (['queued', 'removing'].includes(record.status)) launch(record); },
    async close() { closed = true; await Promise.allSettled([...admissions.values()]); await Promise.allSettled([...jobs.values()]); await persist(); },
  };
  return manager;
}
export type PipelineRemovalManager = Awaited<ReturnType<typeof createPipelineRemovalManager>>;
