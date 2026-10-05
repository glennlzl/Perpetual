// The runner's own files without Docker: the boxes list cleanup reads, and the settings a resumed folder holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrices, priceFor } from '../prices.ts';
import { readScopes, runBench, type RunOptions } from '../run.ts';

// A run killed while it rewrote boxes.json leaves it empty or cut off; resume and cleanup still read what it names.
test('the boxes list is read whole, torn or missing', async t => {
  const out = await mkdtemp(join(tmpdir(), 'bench-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const file = join(out, 'boxes.json'), [a, b] = ['0123456789abcdef', 'fedcba9876543210'];
  assert.deepEqual(await readScopes(file), [], 'A run that made no box has none.');
  await writeFile(file, JSON.stringify([a, b], null, 2));
  assert.deepEqual(await readScopes(file), [a, b]);
  await writeFile(file, `[\n  "${a}",\n  "${b.slice(0, 5)}`);
  assert.deepEqual(await readScopes(file), [a], 'A torn list keeps the scopes it still names whole.');
  await writeFile(file, '');
  assert.deepEqual(await readScopes(file), []);
});

// An OpenAI dry run prices the table's first real model, so its scripted solves could stand in for a paid run's.
test('a resumed folder refuses settings other than those its attempts ran under, before any box or gateway starts', async t => {
  const out = await mkdtemp(join(tmpdir(), 'bench-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const limits = { cost: 0.5, steps: 100, timeMs: 900_000 }, prices = await loadPrices(), model = Object.keys(prices.models)[0];
  await writeFile(join(out, 'run.json'), JSON.stringify({ provider: 'openai', dryRun: true, limits, reasoning: 'default', providerOnly: null, prices: { models: { [model]: priceFor(prices, model) } } }));
  const options: RunOptions = { frameworks: ['aisdk-openai'], models: [model], cases: 'all', seeds: 1, concurrency: 1, budget: 1, limits, reasoning: 'default', provider: 'openai', out, dryRun: true, prices, log: () => {} };
  await assert.rejects(runBench({ ...options, dryRun: false, key: { file: join(out, 'key.json') } }), /holds a run with other dryRun; resume it with the same settings/);
  await assert.rejects(runBench({ ...options, reasoning: 'high', limits: { ...limits, steps: 50 } }), /other limits, reasoning;/);
  const repriced = { ...prices, models: { ...prices.models, [model]: { ...priceFor(prices, model)!, input: 99 } } };
  await assert.rejects(runBench({ ...options, prices: repriced }), /other prices;/);
});
