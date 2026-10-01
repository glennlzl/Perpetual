import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepairBoxes, type DISK } from '../src/repair/box.ts';
import { EGRESS_SCRIPT } from '../src/repair/egress.ts';

// A docker CLI double: it records each call's arguments and answers from state.json beside it. `exec ... sleep` runs
// until the box is removed, as a command in a real box dies with it. No Docker runs.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const dir = __dirname, args = process.argv.slice(2), [command, ...rest] = args;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const removed = () => fs.existsSync(path.join(dir, 'removed'));
const out = text => process.stdout.write(text);
if (command === 'version') out('29.0.0\\n');
else if (command === 'ps' || command === 'network' && rest[0] === 'ls') {
  if (state.listFailure) { process.stderr.write('Docker is unavailable'); process.exit(1); }
  const kind = command === 'ps' ? 'containers' : 'networks';
  const filters = args.filter((arg, i) => args[i - 1] === '--filter').map(arg => arg.slice(6));
  out([...state[kind], ...(state.resources || []).filter(r => r.kind === kind && filters.every(label => r.labels.includes(label))).map(r => r.id)].join('\\n'));
}
else if (command === 'network' && rest[0] === 'create' || command === 'create') {
  const name = command === 'create' ? args[args.indexOf('--name') + 1] : args.at(-1);
  const id = crypto.createHash('sha256').update(name).digest('hex');
  (state.resources ||= []).push({ name, id, kind: command === 'create' ? 'containers' : 'networks', labels: args.filter((arg, i) => args[i - 1] === '--label') });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state)); out(id + '\\n');
}
else if (command === 'container') out(String(state.size) + '\\n');
else if (command === 'rm' || command === 'network' && rest[0] === 'rm') {
  if (state.removeFailure) { process.stderr.write('simulated Docker removal failure'); process.exit(23); }
  const kind = command === 'rm' ? 'containers' : 'networks';
  state[kind] = state[kind].filter(id => !args.includes(id));
  state.resources = (state.resources || []).filter(r => r.kind !== kind || !args.includes(r.id) && !args.includes(r.name));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  if (command === 'rm') fs.writeFileSync(path.join(dir, 'removed'), rest.join(' '));
}
else if (command === 'exec' && rest.includes('df')) out('Filesystem 1024-blocks Used Available Capacity Mounted on\\noverlay 100000000 1000 ' + state.availableKb + ' 1% /\\n');
else if (command === 'exec' && rest.includes('sleep')) { const timer = setInterval(() => { if (removed()) process.exit(137); }, 10); setTimeout(() => { clearInterval(timer); }, 5000); }
`;
async function fake(t: TestContext, state: Partial<{ size: number; availableKb: number; containers: string[]; networks: string[]; removeFailure: boolean; listFailure: boolean }> = {}, disk: Partial<typeof DISK> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-fake-docker-')), docker = join(dir, 'docker');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(docker, FAKE, { mode: 0o755 });
  const read = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const write = async (next: object) => writeFile(join(dir, 'state.json'), JSON.stringify({ size: 1000, availableKb: 50 * 1024 * 1024, containers: [], networks: [], ...await read().catch(() => ({})), ...next }));
  await write(state);
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  return { boxes: createRepairBoxes({ dataDir: dir, owner: 'repair-unit', docker, disk: { checkMs: 20, ...disk } }), calls, write, read, dir };
}

test('a box sits alone on an internal network, reaching out only through its egress proxy, and is removed with both', async t => {
  const f = await fake(t, { containers: ['c'.repeat(64)], networks: ['d'.repeat(64)] });
  const box = await f.boxes.create({ id: 'r1', image: 'node:22-bookworm', source: f.dir });
  const calls = await f.calls(), name = 'perpetual-repair-unit-r1', proxy = `${name}-proxy`;
  assert.ok(calls.some(call => call.join(' ') === `rm -f -v ${'c'.repeat(64)}`) && calls.some(call => call.join(' ') === `network rm ${'d'.repeat(64)}`), 'Leftover boxes, proxies and networks go first.');
  const network = calls.find(call => call[0] === 'network' && call[1] === 'create')!;
  assert.deepEqual([network.includes('--internal'), network.at(-1), network.filter(arg => arg.startsWith('perpetual.')).length], [true, name, 3]);
  const proxied = calls.find(call => call[0] === 'create' && call[2] === proxy)!;
  for (const flag of ['--read-only', '--init']) assert.ok(proxied.includes(flag), flag);
  assert.deepEqual([proxied[proxied.indexOf('--cap-drop') + 1], proxied[proxied.indexOf('--user') + 1], proxied[proxied.indexOf('--network') + 1]], ['ALL', 'node', 'bridge']);
  assert.deepEqual(proxied.slice(-5), ['node:22-bookworm-slim', 'node', '-e', EGRESS_SCRIPT, '3128']);
  assert.ok(calls.some(call => call.join(' ') === `network connect --alias proxy ${name} ${proxy}`));
  const created = calls.find(call => call[0] === 'create' && call[2] === name)!;
  assert.equal(created[created.indexOf('--network') + 1], name, 'The box joins only its internal network.');
  assert.ok(!created.includes('bridge') && !created.includes('host') && !created.some(arg => /^(?:-v|--volume|--mount|--privileged)$/.test(arg) || arg.includes('docker.sock')));
  assert.ok(created.includes('HTTPS_PROXY=http://proxy:3128') && created.includes('NO_PROXY=localhost,127.0.0.1,::1'));
  await box.remove();
  assert.deepEqual((await f.read()).resources, [], 'Box, proxy and network are confirmed absent.');
});

test('a box that writes more than its disk limit is removed while it works, and its commands reject with why', async t => {
  const f = await fake(t, {}, { limit: 1024 ** 3 });
  const box = await f.boxes.create({ id: 'r2', image: 'node:22-bookworm', source: f.dir });
  await f.write({ size: 2 * 1024 ** 3 });
  await assert.rejects(box.exec(['sleep', '5']), /The repair box wrote more than 1 GB and was removed\./);
  assert.equal(box.signal?.aborted, true);
  await assert.rejects(box.exec(['true']), /wrote more than 1 GB/, 'A removed box runs nothing.');
  assert.deepEqual((await f.read()).resources, []);
});

test('a box is removed when Docker runs low on disk space, whoever filled it', async t => {
  const f = await fake(t, {}, { floor: 2 * 1024 ** 3 });
  const box = await f.boxes.create({ id: 'r3', image: 'node:22-bookworm', source: f.dir });
  await f.write({ availableKb: 1024 * 1024 });
  await assert.rejects(box.exec(['sleep', '5']), /Docker has less than 2 GB of disk space left, so the repair box was removed\./);
});

test('an idle box is not read, and one within its bounds keeps working', async t => {
  const f = await fake(t);
  const box = await f.boxes.create({ id: 'r4', image: 'node:22-bookworm', source: f.dir });
  await new Promise(done => setTimeout(done, 100));
  assert.ok(!(await f.calls()).some(call => call[0] === 'container'), 'Nothing is read while the box is idle.');
  assert.equal((await box.exec(['true'])).exitCode, 0);
  await new Promise(done => setTimeout(done, 100));
  assert.ok((await f.calls()).some(call => call[0] === 'container'), 'Its writes are read after it worked.');
  assert.equal(box.signal?.aborted, false);
  await box.remove();
});


test('failed box removal is visible, stops commands and can be retried', async t => {
  const f = await fake(t);
  const box = await f.boxes.create({ id: 'retry', image: 'node:22-bookworm', source: f.dir });
  await f.write({ removeFailure: true });
  await assert.rejects(box.remove(), /remov|cleanup/i);
  assert.equal((await f.read()).resources.length, 3);
  await assert.rejects(box.exec(['true']), /remov|cleanup/i);
  await f.write({ removeFailure: false });
  await box.remove();
  assert.deepEqual((await f.read()).resources, []);
  await assert.rejects(box.exec(['true']), /remov|cleanup/i);
});

test('leftover cleanup refuses unconfirmed deletion and blocks creating another box', async t => {
  const f = await fake(t, { containers: ['c'.repeat(64)], networks: ['d'.repeat(64)], removeFailure: true });
  await assert.rejects(f.boxes.removeLeftovers(), /remov|cleanup/i);
  await assert.rejects(f.boxes.create({ id: 'refused', image: 'node:22-bookworm', source: f.dir }), /remov|cleanup/i);
  assert.ok(!(await f.calls()).some(call => call[0] === 'create'));
  await f.write({ removeFailure: false });
  await f.boxes.removeLeftovers();
  assert.deepEqual([(await f.read()).containers, (await f.read()).networks], [[], []]);
});

test('an unavailable Docker resource list never confirms cleanup', async t => {
  const f = await fake(t, { listFailure: true });
  await assert.rejects(f.boxes.removeLeftovers(), /Docker|cleanup/i);
});

test('rehydrated cleanup removes only the named repair and retries a failed Docker launch', async t => {
  const f = await fake(t);
  await f.boxes.create({ id: 'owned', image: 'node:22-bookworm', source: f.dir });
  const state = await f.read();
  const foreign = state.resources.map((resource: { id: string; name: string; labels: string[] }) => ({ ...resource, id: 'a'.repeat(64), name: 'foreign', labels: resource.labels.map(label => label === 'perpetual.repair=owned' ? 'perpetual.repair=other' : label) }));
  await f.write({ resources: [...state.resources, ...foreign] });
  const boxes = createRepairBoxes({ dataDir: f.dir, owner: 'repair-unit', docker: join(f.dir, 'docker') });
  await rm(join(f.dir, 'docker'));
  await assert.rejects(boxes.remove('owned'), /cleanup/i);
  await writeFile(join(f.dir, 'docker'), FAKE, { mode: 0o755 });
  await boxes.remove('owned');
  assert.deepEqual((await f.read()).resources, foreign);
});

test('a watchdog whose removal fails reports pending cleanup, never confirmed removal', async t => {
  const f = await fake(t, {}, { limit: 1024 ** 3 });
  const box = await f.boxes.create({ id: 'watchdog-failure', image: 'node:22-bookworm', source: f.dir });
  await f.write({ size: 2 * 1024 ** 3, removeFailure: true });
  const stopped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The watchdog did not stop the box.')), 10_000);
    box.signal!.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  await box.exec(['true']).catch(() => {});
  await stopped;
  assert.equal(box.signal?.aborted, true);
  await assert.rejects(box.exec(['true']), /cleanup/i);
  assert.doesNotMatch(String(box.signal?.reason), /was removed/);
  assert.equal((await f.read()).resources.length, 3);
  await f.write({ removeFailure: false });
  await box.remove();
  assert.deepEqual((await f.read()).resources, []);
});
