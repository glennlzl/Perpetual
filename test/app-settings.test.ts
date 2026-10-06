import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppSettings } from '../client/src/lib/app-settings.ts';
import type { ModelSettingsReply, OpenRouterModelView } from '../contract/settings.ts';

const catalog: OpenRouterModelView = { models: ['a', 'b', 'c'].map(id => ({ id: `example/${id}`, name: `Model ${id}`, provider: 'example' })), defaultModel: 'example/b', defaultEscalationModel: 'example/c' };
const reply = (model: string): ModelSettingsReply => ({ capabilities: { provider: 'openrouter', model, escalationModel: 'example/c', baseUrl: 'https://openrouter.ai/api/v1', keyConfigured: true, modelConfigured: true } });

test('save completion retains later model and key edits and rebases Discard on the saved response', async () => {
  const held = Promise.withResolvers<ModelSettingsReply>(), writes: unknown[] = [];
  const settings = createAppSettings({ controller: async (path, input) => {
    if (input) { writes.push(input); return held.promise; }
    return path.endsWith('/models') ? catalog : reply('example/b');
  } });
  await settings.load();
  settings.edit({ model: 'example/a', apiKey: 'first-fixture-key' });
  const saving = settings.save();
  settings.edit({ model: 'example/c', apiKey: 'second-fixture-key' });
  const newer = settings.getSnapshot().draft;
  held.resolve(reply('example/a'));
  assert.equal(await saving, true);
  assert.equal(settings.getSnapshot().draft, newer);
  assert.equal(settings.getSnapshot().capabilities?.model, 'example/a');
  assert.equal(settings.getSnapshot().saved, false, 'A newer edit must not be presented as saved.');
  settings.discard();
  assert.equal(settings.getSnapshot().savedModel, 'example/a');
  assert.equal(settings.getSnapshot().draft, null);
  assert.deepEqual(writes, [{ model: 'example/a', escalationModel: 'example/c', apiKey: 'first-fixture-key' }]);
});

test('a read begun before saving cannot replace the newer confirmed settings', async () => {
  const stale = Promise.withResolvers<ModelSettingsReply>(); let reads = 0;
  const settings = createAppSettings({ controller: async (path, input) => input ? reply('example/a') : path.endsWith('/models') ? catalog : ++reads === 1 ? reply('example/b') : stale.promise });
  await settings.load();
  const reading = settings.load();
  settings.edit({ model: 'example/a' });
  await settings.save();
  stale.resolve(reply('example/b')); await reading;
  assert.equal(settings.getSnapshot().capabilities?.model, 'example/a');
  assert.equal(settings.getSnapshot().savedModel, 'example/a');
  assert.equal(settings.getSnapshot().draft, null);
  assert.equal(settings.getSnapshot().loading, false);
});

test('a failed save stays retryable after the page leaves, reopens and refreshes', async () => {
  let fail = true;
  const settings = createAppSettings({ controller: async (path, input) => {
    if (input && fail) throw new Error('Could not save settings.');
    return path.endsWith('/models') ? catalog : reply(input ? 'example/a' : 'example/b');
  } });
  await settings.load(); settings.edit({ model: 'example/a' });
  const submitted = settings.getSnapshot().draft;
  const unsubscribe = settings.subscribe(() => {}); unsubscribe();
  assert.equal(await settings.save(), false);
  await settings.load();
  assert.equal(settings.getSnapshot().draft, submitted);
  assert.equal(settings.getSnapshot().saveError, 'Could not save settings.');
  assert.equal(settings.getSnapshot().saving, false);
  fail = false;
  assert.equal(await settings.save(), true);
  assert.equal(settings.getSnapshot().draft, null);
  assert.equal(settings.getSnapshot().saveError, '');
});

test('returning during a pending save keeps one write and does not read stale settings', async () => {
  const held = Promise.withResolvers<ModelSettingsReply>(); let reads = 0, writes = 0;
  const settings = createAppSettings({ controller: async (path, input) => {
    if (input) { writes++; return held.promise; }
    reads++; return path.endsWith('/models') ? catalog : reply('example/b');
  } });
  await settings.load(); settings.edit({ model: 'example/a' });
  const first = settings.save(), second = settings.save(), reopened = settings.load();
  assert.equal(settings.getSnapshot().saving, true);
  held.resolve(reply('example/a'));
  assert.equal(await first, true); assert.equal(await second, true); await reopened;
  assert.equal(writes, 1); assert.equal(reads, 2);
  assert.equal(settings.getSnapshot().savedModel, 'example/a');
  assert.equal(settings.getSnapshot().saving, false);
});

test('catalog recovery never replaces an unsaved model or turns it into the saved baseline', async () => {
  let catalogFailed = true;
  const settings = createAppSettings({ controller: async path => {
    if (!path.endsWith('/models')) return reply('example/b');
    if (catalogFailed) throw new Error('Catalog unavailable.');
    return catalog;
  } });
  await settings.load(); settings.edit({ model: 'example/a' });
  catalogFailed = false; await settings.reloadModels();
  assert.equal(settings.getSnapshot().draft?.model, 'example/a');
  settings.discard();
  assert.equal(settings.getSnapshot().savedModel, 'example/b');
  assert.equal(settings.getSnapshot().modelsError, '');
});

test('a key saved without OpenRouter\'s answer carries its warning until the next edit', async () => {
  const warning = 'OpenRouter could not check this key.';
  const settings = createAppSettings({ controller: async (path, input) => input ? { ...reply('example/a'), warning } : path.endsWith('/models') ? catalog : reply('example/b') });
  await settings.load();
  settings.edit({ model: 'example/a', apiKey: 'fixture-key' });
  assert.equal(await settings.save(), true);
  assert.deepEqual([settings.getSnapshot().saved, settings.getSnapshot().saveWarning], [true, warning]);
  settings.edit({ model: 'example/c' });
  assert.equal(settings.getSnapshot().saveWarning, '');
});
