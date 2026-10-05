import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { missingInputs } from '../src/twin/inputs.ts';
import { createTwinRuntime } from '../src/twin/runtime.ts';
import type { Exec } from '../src/twin/runtime.ts';
import type { TwinService } from '../src/twin/registry.ts';

const SECRET = 'sk_test_hidden_value';

test('Service context runs host CLIs in its directory with the variables they set, shares machine state and redacts errors', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-twin-')), source = join(dataDir, 'source');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(source, 'jobs'), { recursive: true });
  const calls: { file: string; args: string[]; cwd?: string; env?: Record<string, string> }[] = [], seen: { project?: string; dir?: string; shared?: string } = {};
  const tool: TwinService = { id: 'tool', title: 'Tool', fidelity: 'official-sandbox',
    inputs: [{ name: 'KEY', label: 'Key', secret: true, pattern: /^sk_test_/ }, { name: 'EXTRA', label: 'Extra', optional: true }],
    setup: async ctx => {
      Object.assign(seen, { project: ctx.project, dir: ctx.dir, shared: ctx.shared });
      await ctx.exec('tool-cli', ['start']);
      await ctx.exec('tool-cli', ['status'], { cwd: ctx.source, env: { HOST_ONLY: '' } });
      return {};
    },
    containers: () => [{ name: 'worker', image: 'node:22-bookworm-slim', directory: 'jobs', command: ['node', 'worker.js'] }],
    env: () => ({}) };
  const exec: Exec = async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd, ...(options.env ? { env: options.env } : {}) });
    if (file === 'tool-cli' && args[0] === 'fail') throw Object.assign(new Error('x'), { stderr: `bad key ${SECRET}` });
    return { stdout: '' };
  };
  const runtime = createTwinRuntime({ exec, services: { tool }, owner: 'o', isFree: async () => true });
  const result = await runtime.prepare({ dataDir, id: 'beta', config: { services: { tool: {} } }, source, inputs: { tool: { KEY: SECRET } } });
  assert.equal(result.status, 'ready', 'an optional input may be missing');
  const twin = join(dataDir, 'environments', 'beta', 'twin');
  assert.deepEqual(seen, { project: 'perpetual-beta', dir: join(twin, 'services', 'tool'), shared: join(dataDir, 'twin-services', 'tool') });
  assert.deepEqual(calls.filter(call => call.file === 'tool-cli'), [
    { file: 'tool-cli', args: ['start'], cwd: seen.dir }, { file: 'tool-cli', args: ['status'], cwd: source, env: { HOST_ONLY: '' } }]);
  const worker = YAML.parse(await readFile(join(twin, 'compose.yaml'), 'utf8')).services['tool-worker'];
  assert.equal(worker.working_dir, '/workspace/jobs');
  assert.deepEqual(worker.volumes, [{ type: 'volume', source: 'workspace', target: '/workspace' }, { type: 'volume', source: 'package-cache', target: '/perpetual-cache' }]);

  tool.setup = ctx => ctx.exec('tool-cli', ['fail']);
  await assert.rejects(runtime.prepare({ dataDir, id: 'beta', config: { services: { tool: {} } }, source, inputs: { tool: { KEY: SECRET } } }),
    (error: Error) => error.message === 'Tool: bad key [redacted]');
  tool.containers = () => [{ name: 'worker', image: 'node:22-bookworm-slim', directory: '../outside' }];
  tool.setup = undefined;
  await assert.rejects(runtime.prepare({ dataDir, id: 'gamma', config: { services: { tool: {} } }, source, inputs: { tool: { KEY: SECRET } } }), /stay inside the repository/);
});

test('Optional inputs never block a service', () => {
  const service = { inputs: [{ name: 'KEY', pattern: /^k/ }, { name: 'EXTRA', pattern: /^e/, optional: true }] };
  assert.deepEqual(missingInputs(service, {}), ['KEY']);
  assert.deepEqual(missingInputs(service, { KEY: 'k1', EXTRA: 'wrong' }), []);
});
