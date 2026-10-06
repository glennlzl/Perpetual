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
else if (command === 'create' && (state.missing || []).includes(args[args.indexOf('--pull') + 2])) {
  const image = args[args.indexOf('--pull') + 2], reference = 'docker.io/library/' + image;
  process.stderr.write(state.containerd ? 'Unable to find image \\'' + image + '\\' locally\\nError response from daemon: failed to resolve reference "' + reference + '": ' + reference + ': not found'
    : 'Error response from daemon: manifest for ' + image + ' not found: manifest unknown: manifest unknown'); process.exit(1);
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
async function fake(t: TestContext, state: Partial<{ size: number; availableKb: number; containers: string[]; networks: string[]; removeFailure: boolean; listFailure: boolean; missing: string[]; containerd: boolean }> = {}, disk: Partial<typeof DISK> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-fake-docker-')), docker = join(dir, 'docker');
  // A fake Docker call still finishing may add a file while the directory is removed.
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
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
  assert.equal(network[network.indexOf('com.docker.network.bridge.inhibit_ipv4=true') - 1], '-o', 'Its bridge has no address on the host, which a host service listening everywhere would answer on.');
  const proxied = calls.find(call => call[0] === 'create' && call[2] === proxy)!;
  for (const flag of ['--read-only', '--init']) assert.ok(proxied.includes(flag), flag);
  assert.deepEqual([proxied[proxied.indexOf('--cap-drop') + 1], proxied[proxied.indexOf('--user') + 1], proxied[proxied.indexOf('--network') + 1]], ['ALL', 'node', 'bridge']);
  assert.deepEqual(proxied.slice(-5), ['node:22-bookworm-slim', 'node', '-e', EGRESS_SCRIPT, '3128']);
  assert.ok(calls.some(call => call.join(' ') === `network connect --alias proxy ${name} ${proxy}`));
  const created = calls.find(call => call[0] === 'create' && call[2] === name)!;
  assert.equal(created[created.indexOf('--network') + 1], name, 'The box joins only its internal network.');
  assert.ok(!created.includes('bridge') && !created.includes('host') && !created.some(arg => /^(?:-v|--volume|--mount|--privileged)$/.test(arg) || arg.includes('docker.sock')));
  assert.ok(created.includes('HTTPS_PROXY=http://proxy:3128') && created.includes('NO_PROXY=localhost,127.0.0.1,::1'));
  // A case-insensitive host holds one file for paths that differ only in case; the box checks the commit out itself.
  const filled = calls.slice(calls.indexOf(created) + 1).filter(call => call[0] !== 'container' && !call.includes('df')).map(call => call.join(' '));
  assert.deepEqual(filled, [`start ${name}`, `cp ${f.dir}/. ${name}:/workspace`, `exec ${name} chown -R 0:0 /workspace`, `exec -w /workspace ${name} git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.ignorecase=false -c core.precomposeunicode=false reset --hard --quiet`]);
  await box.remove();
  assert.deepEqual((await f.read()).resources, [], 'Box, proxy and network are confirmed absent.');
});

test('a toolchain image the registry has no tag for gives way to the next image named, and the last one\'s failure ends the creation', async t => {
  const f = await fake(t, { missing: ['node:14-bookworm'] });
  const box = await f.boxes.create({ id: 'old', image: 'node:14-bookworm', fallbacks: ['node:14', 'buildpack-deps:bookworm'], source: f.dir });
  const images = (await f.calls()).filter(call => call[0] === 'create' && call[2] === 'perpetual-repair-unit-old').map(call => call[call.indexOf('--pull') + 2]);
  assert.deepEqual([box.image, images], ['node:14', ['node:14-bookworm', 'node:14']]);
  await box.remove();
  // The containerd image store, the default of new Docker installs, words a missing tag its own way.
  const containerd = await fake(t, { missing: ['node:14-bookworm'], containerd: true });
  const resolved = await containerd.boxes.create({ id: 'store', image: 'node:14-bookworm', fallbacks: ['node:14', 'buildpack-deps:bookworm'], source: containerd.dir });
  assert.equal(resolved.image, 'node:14');
  await resolved.remove();
  const none = await fake(t, { missing: ['node:14-bookworm', 'node:14', 'buildpack-deps:bookworm'] });
  await assert.rejects(none.boxes.create({ id: 'none', image: 'node:14-bookworm', fallbacks: ['node:14', 'buildpack-deps:bookworm'], source: none.dir }), /Could not create the repair box from buildpack-deps:bookworm: .*manifest unknown/);
  assert.deepEqual((await none.read()).resources, [], 'Its network and proxy are removed.');
  await assert.rejects(f.boxes.create({ id: 'bad', image: 'node:22-bookworm', fallbacks: ['ubuntu:latest'], source: f.dir }), /Invalid repair box/);
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

test('a box within its bounds keeps working, and an idle one is still read', async t => {
  const f = await fake(t);
  const box = await f.boxes.create({ id: 'r4', image: 'node:22-bookworm', source: f.dir });
  assert.equal((await box.exec(['true'])).exitCode, 0);
  for (const started = Date.now(); !(await f.calls()).some(call => call[0] === 'container') && Date.now() - started < 10_000;) await new Promise(done => setTimeout(done, 20));
  assert.ok((await f.calls()).some(call => call[0] === 'container'), 'Its writes are read after it worked.');
  assert.equal(box.signal?.aborted, false);
  await box.remove();
});

// A command the agent left running in the background, such as one started with nohup, writes while no tool runs.
test('an idle box that writes past its disk limit is removed', async t => {
  const f = await fake(t, {}, { limit: 1024 ** 3 });
  const box = await f.boxes.create({ id: 'r5', image: 'node:22-bookworm', source: f.dir });
  await f.write({ size: 2 * 1024 ** 3 });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The watchdog did not read the idle box.')), 10_000);
    box.signal!.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  assert.match(String(box.signal?.reason), /wrote more than 1 GB/);
  await assert.rejects(box.exec(['true']), /wrote more than 1 GB and was removed/);
  assert.deepEqual((await f.read()).resources, []);
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
  const box = await f.boxes.create({ id: 'owned', image: 'node:22-bookworm', source: f.dir });
  const state = await f.read();
  const foreign = state.resources.map((resource: { id: string; name: string; labels: string[] }) => ({ ...resource, id: 'a'.repeat(64), name: 'foreign', labels: resource.labels.map(label => label === 'perpetual.repair=owned' ? 'perpetual.repair=other' : label) }));
  await f.write({ resources: [...state.resources, ...foreign] });
  const boxes = createRepairBoxes({ dataDir: f.dir, owner: 'repair-unit', docker: join(f.dir, 'docker') });
  await rm(join(f.dir, 'docker'));
  await assert.rejects(boxes.remove('owned'), /cleanup/i);
  await writeFile(join(f.dir, 'docker'), FAKE, { mode: 0o755 });
  await boxes.remove('owned');
  assert.deepEqual((await f.read()).resources, foreign);
  // The first controller's box would end with its process; its disk watchdog would otherwise keep calling Docker.
  await box.remove();
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
