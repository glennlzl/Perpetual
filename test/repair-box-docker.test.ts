// The repair box in a real Docker container, only with PERPETUAL_REPAIR_DOCKER_TESTS=1. Its containers and networks are
// labelled perpetual.owner=repair-test and removed by the test; no model runs (a scripted one makes the fix) and nothing
// reaches GitHub (the push and the pull request are recorded). The box reaches the public npm registry through its proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { diagnoseFailure } from '../src/providers.ts';
import { createRepairAgent } from '../src/repair/agent.ts';
import { createRepairBoxes, type RepairBoxes } from '../src/repair/box.ts';
import { createRepairHost } from '../src/repair/clone.ts';
import type { CommandRunner, PullRequestRef } from '../src/repair/github.ts';
import { createRepairManager, type Repair, type RepairGitHub, type RepairSource } from '../src/repair/manager.ts';
import type { WorkflowRun } from '../src/github-runs.ts';
import { brokenRepository, managedCopy, typeErrorRepository } from './fixtures/repair-box.ts';
import { scriptedModel, type ModelCall, type ScriptedStep } from './fixtures/scripted-model.ts';

const enabled = process.env.PERPETUAL_REPAIR_DOCKER_TESTS === '1';
const skip = !enabled && 'Set PERPETUAL_REPAIR_DOCKER_TESTS=1 to run the repair box in Docker.';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const containers = (label: string) => docker('ps', '-aq', '--filter', `label=${label}`).split('\n').filter(Boolean);
const networks = (label: string) => docker('network', 'ls', '-q', '--filter', `label=${label}`).split('\n').filter(Boolean);
const cleanup = (id: string) => {
  for (const container of containers(`perpetual.repair=${id}`)) docker('rm', '-f', '-v', container);
  for (const network of networks(`perpetual.repair=${id}`)) docker('network', 'rm', network);
};

test('a repair box is confined: labelled, capped, without mounts, socket or credentials, and with no route to the host', { skip, timeout: 20 * 60_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-docker-')), source = await mkdtemp(join(tmpdir(), 'perpetual-repair-docker-source-'));
  const boxes = createRepairBoxes({ dataDir, owner: 'repair-test' }), id = randomUUID(), other = randomUUID();
  t.after(async () => {
    cleanup(id); cleanup(other);
    await rm(dataDir, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
  });
  await brokenRepository(source);
  assert.equal(await boxes.available(), null);
  const box = await boxes.create({ id, image: 'node:22-bookworm', source });
  const [inspected] = JSON.parse(docker('inspect', `perpetual-repair-test-${id}`));
  assert.deepEqual([inspected.Config.Labels['perpetual.owner'], inspected.Config.Labels['perpetual.repair']], ['repair-test', id]);
  assert.deepEqual([inspected.HostConfig.CapDrop, inspected.HostConfig.SecurityOpt, inspected.HostConfig.NetworkMode, inspected.HostConfig.PidsLimit, inspected.HostConfig.Memory], [['ALL'], ['no-new-privileges'], `perpetual-repair-test-${id}`, 1024, 4 * 1024 ** 3]);
  assert.equal(docker('network', 'inspect', '--format', '{{.Internal}}', `perpetual-repair-test-${id}`), 'true', 'The box\'s network has no route out.');
  assert.deepEqual([inspected.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind'), inspected.HostConfig.Binds ?? []], [[], []], 'No host mount, and no Docker socket.');
  assert.ok(!JSON.stringify(inspected.Config.Env).match(/TOKEN|OPENROUTER|API_KEY|GH_/), 'No credential reaches the box.');
  const outside = await box.exec(['sh', '-c', 'ls /var/run/docker.sock 2>&1; id -u']);
  assert.match(outside.stdout, /No such file/);
  // A listener on the host's loopback, as the controller and the twins are, is out of reach directly and through the proxy.
  const hits: string[] = [], host = createServer((incoming, answer) => { hits.push(incoming.url ?? ''); answer.end('controller'); });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  t.after(() => { host.close(); });
  const port = (host.address() as AddressInfo).port;
  const direct = await box.exec(['curl', '-sS', '-m', '5', '--noproxy', '*', `http://host.docker.internal:${port}/api/session`]);
  const proxied = await box.exec(['curl', '-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', `http://host.docker.internal:${port}/api/session`]);
  const tunnelled = await box.exec(['curl', '-sS', '-m', '5', `https://host.docker.internal:${port}/api/session`]);
  assert.notEqual(direct.exitCode, 0);
  assert.notEqual(proxied.stdout.trim(), '200');
  assert.notEqual(tunnelled.exitCode, 0);
  assert.deepEqual(hits, [], 'Nothing from the box reached the host.');
  const registry = await box.exec(['curl', '-sS', '-m', '30', '-o', '/dev/null', '-w', '%{http_code}', 'https://registry.npmjs.org/'], { timeoutMs: 60_000 });
  assert.equal(registry.stdout.trim(), '200', 'Public registries are reached through the proxy.');
  await box.remove();
  assert.deepEqual([containers(`perpetual.repair=${id}`), networks(`perpetual.repair=${id}`)], [[], []], 'Remove leaves no container or network.');
  await boxes.create({ id: other, image: 'node:22-bookworm', source });
  await boxes.removeLeftovers();
  assert.deepEqual([containers(`perpetual.repair=${other}`), networks(`perpetual.repair=${other}`)], [[], []], 'Leftovers of this data directory are removed by their labels.');
});

test('a real box that writes more than its disk limit is removed while its command runs', { skip, timeout: 10 * 60_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-docker-')), source = await mkdtemp(join(tmpdir(), 'perpetual-repair-docker-source-'));
  const id = randomUUID(), boxes = createRepairBoxes({ dataDir, owner: 'repair-test', disk: { limit: 50 * 1024 * 1024, checkMs: 500 } });
  t.after(async () => { cleanup(id); await rm(dataDir, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); });
  await brokenRepository(source);
  const box = await boxes.create({ id, image: 'node:22-bookworm', source });
  await assert.rejects(box.exec(['sh', '-c', 'head -c 200000000 /dev/zero > /big; sleep 120'], { timeoutMs: 180_000 }), /The repair box wrote more than 50 MB and was removed\./);
  assert.deepEqual(containers(`perpetual.repair=${id}`), [], 'The box and its proxy are gone.');
});

const exec = promisify(execFile) as CommandRunner;
const A = 'a'.repeat(40);
const TYPE_ERROR = "src/add.ts(1,55): error TS2322: Type 'string' is not assignable to type 'number'.";
// What a capable model does: install as the workflow does, reproduce, fix, see the check pass, done.
const FIX: ScriptedStep[] = [
  { calls: [{ tool: 'run', input: { command: 'npm install --no-package-lock --no-audit --no-fund', timeoutSeconds: 600 } }] },
  { calls: [{ tool: 'run', input: { command: 'npm run typecheck', timeoutSeconds: 300 } }] },
  { calls: [{ tool: 'edit', input: { path: 'src/add.ts', old: '`${a + b}`', new: 'a + b' } }] },
  { calls: [{ tool: 'run', input: { command: 'npm run typecheck', timeoutSeconds: 300 } }] },
  { calls: [{ tool: 'done', input: { summary: 'add() returned a string where its type says number; it returns the sum. npm run typecheck passes.' } }] },
];
const run = (id: string, sha: string, conclusion: string, { branch = 'main', event = 'push' } = {}): WorkflowRun =>
  ({ id, workflowId: '7', name: 'CI', path: '.github/workflows/ci.yml', event, status: 'completed', conclusion, attempt: 1, sha, branch, url: null, createdAt: null, startedAt: null, updatedAt: null, jobs: [] });
const failure = (runId: string) => ({ runId, jobs: [{ id: `job-${runId}`, name: 'test', conclusion: 'failure', failedSteps: ['Typecheck'] }], log: TYPE_ERROR, tail: TYPE_ERROR, diagnosis: diagnoseFailure(TYPE_ERROR), observedAt: '2026-09-25T10:00:00.000Z' });

test('a repair fixes a real type error end to end: its box reproduces and fixes it, the host copy pushes the fix, and green CI readies the pull request', { skip, timeout: 20 * 60_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-repair-docker-'));
  const { checkoutPath, sha } = await managedCopy(dataDir, typeErrorRepository);
  const real = createRepairBoxes({ dataDir, owner: 'repair-test' }), ids: string[] = [];
  const boxes: RepairBoxes = { ...real, create: input => { ids.push(input.id); return real.create(input); } };
  // GitHub: the connected account, the branch head and each commit's runs; the push and pull request writes are recorded.
  const connection = { login: 'developer', repository: 'owner/app' }, heads = { sha: A }, runs: Record<string, WorkflowRun[]> = {};
  const pushes: { sha: string; lease: string; branch: string; files: string; add: string }[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    if (args.includes('ls-remote')) return { stdout: '' };
    if (!args.includes('push')) return exec(file, args, options);
    const directory = args[args.indexOf('-C') + 1], lease = args.find(arg => arg.startsWith('--force-with-lease='))!, [commit, ref] = args.at(-1)!.split(':');
    const git = async (...rest: string[]) => (await exec('git', ['-C', directory, ...rest], options)).stdout;
    pushes.push({ sha: commit, lease: lease.split(':')[1], branch: ref.replace('refs/heads/', ''), files: (await git('show', '--name-only', '--format=', commit)).trim(), add: await git('show', `${commit}:src/add.ts`) });
    runs[commit] = [run('101', commit, 'success', { branch: ref.replace('refs/heads/', ''), event: 'pull_request' })];
    return { stdout: '' };
  };
  const pull: PullRequestRef = { number: 7, url: 'https://github.com/owner/app/pull/7', draft: true };
  const records = { created: [] as { title: string; body: string }[], labels: [] as string[], ready: [] as number[] };
  const pullRequests = {
    async account() { return { login: 'developer', id: 1234 }; },
    async find() { return null; },
    async create(input: { title: string; body: string }) { records.created.push(input); return pull; },
    async update() {},
    async ready({ number }: { number: unknown }) { records.ready.push(number as number); },
    async label({ label }: { label: string }) { records.labels.push(label); },
    async comment() {},
    async state() { return { state: 'open' as const, mergeCommit: null }; },
    async close() {},
  };
  const calls: ModelCall[] = [];
  const agent = createRepairAgent({
    models: async () => ({ apiKey: 'sk-or-v1-fedcba9876543210fedcba9876543210', model: 'openai/gpt-6-luna', escalationModel: 'anthropic/claude-sonnet-5' }),
    boxes, host: createRepairHost({ dataDir, run: runner }), model: () => scriptedModel(FIX, { onCall: call => calls.push(call) }),
    ci: { pollMs: 200, noRunMs: 60_000, waitMs: 120_000 },
    github: { connection: async () => connection, runs: async ({ sha: commit }) => ({ runs: runs[commit] ?? [] }), failure: async ({ runId }) => failure(runId), pullRequests },
  });
  const current: RepairSource = { key: 'github:owner/app:/', branch: 'main', repository: 'owner/app', checkoutPath, rootDirectory: '/' };
  const github: RepairGitHub = {
    connection: async () => connection,
    async head(input) { const etag = `"${heads.sha.slice(0, 7)}"`; return input.etag === etag ? { status: 304 } : { status: 200, sha: heads.sha, etag }; },
    runs: async ({ sha: commit }) => ({ runs: runs[commit] ?? [] }),
    failure: async ({ runId }) => failure(runId),
    async rerun() { throw new Error('unused'); },
  };
  const manager = await createRepairManager({ dataDir, source: () => current, github, steps: { unavailable: () => boxes.available(), repair: agent.repair, state: agent.state, close: agent.close, recover: agent.recover } });
  t.after(async () => {
    await manager.close();
    for (const id of ids) cleanup(id);
    await real.removeLeftovers();
    await rm(dataDir, { recursive: true, force: true });
  });
  await manager.check(); await manager.idle(); // head A is the baseline
  heads.sha = sha;
  runs[sha] = [run('2', sha, 'failure')];
  await manager.check();
  for (let waited = 0; !['ready', 'failed', 'needs-person'].includes(manager.view().repairs[0]?.status ?? '') && waited < 18 * 60_000; waited += 500) await new Promise(done => setTimeout(done, 500));
  await manager.idle();
  const [repair] = manager.view().repairs;
  assert.deepEqual([repair.status, repair.reason, repair.pullRequest], ['ready', undefined, { number: 7, url: pull.url, draft: false }]);
  const [stored]: Repair[] = JSON.parse(await readFile(join(dataDir, 'repairs', 'state.json'), 'utf8')).repairs;
  assert.deepEqual(stored.attempts?.map(attempt => [attempt.number, attempt.reproduced, attempt.failure]), [[1, true, undefined]], 'The attempt ran the Typecheck step\'s command and saw it fail first.');
  const results = calls.map(call => JSON.stringify(call.prompt));
  assert.match(results[2], /TS2322/, 'The box reproduced the type error.');
  assert.match(results[4], /"exitCode":0/, 'The typecheck passes in the box before done.');
  const branch = `perpetual/repair/${sha.slice(0, 7)}`;
  assert.deepEqual(pushes.map(push => [push.branch, push.lease, push.files, push.add]), [[branch, '', 'src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n']], 'Only the fix is pushed: no installed package or lockfile.');
  assert.deepEqual([records.created.map(item => item.title), records.labels, records.ready], [[`Fix the failed CI build at ${sha.slice(0, 7)}`], ['perpetual-repair'], [7]]);
  for (const expected of ['TS2322', '### Change', 'src/add.ts', '+1 −1', 'openai/gpt-6-luna']) assert.ok(records.created[0].body.includes(expected), expected);
  assert.equal(ids.length, 1);
  assert.deepEqual([containers(`perpetual.repair=${ids[0]}`), networks(`perpetual.repair=${ids[0]}`)], [[], []], 'The box, its proxy and its network are removed.');
});
