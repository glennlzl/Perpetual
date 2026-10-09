import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHistoryCache } from '../client/src/lib/git-history-cache.ts';
import type { GitHistory } from '../contract/git-history.ts';

const history = (branch: string): GitHistory => ({ commits: [], branch, repository: 'acme/app', refCount: 1, localBranchCount: 1, remoteBranchCount: 0, shallow: false, hasMore: false, limit: 100, scope: 'current', readAt: '2026-01-01T00:00:00Z', source: 'local' });

test('refresh invalidates every page and late reads cannot replace refreshed history', async () => {
  const old = Promise.withResolvers<GitHistory>();
  const urls: string[] = [];
  const cache = createGitHistoryCache('/acme/app', async path => {
    urls.push(path);
    return urls.length === 1 ? old.promise : history('updated');
  });
  const pending = cache.load();
  assert.equal(cache.load(), pending);
  await cache.load('all');
  await cache.load('current', 100, true);
  assert.equal(cache.peek('all'), undefined, 'Refresh must not retain the old all-branches page.');
  old.resolve(history('old'));
  await pending;
  assert.equal(cache.peek()?.branch, 'updated');
  assert.equal(new URL(urls[2], 'http://localhost').searchParams.get('refresh'), '1');
});

test('a failed preload is retried when the viewer opens history', async () => {
  let reads = 0;
  const cache = createGitHistoryCache('/acme/app', async () => {
    if (++reads === 1) throw new Error('Source is changing');
    return history('main');
  });
  await assert.rejects(cache.load(), /Source is changing/);
  assert.equal(cache.peek(), undefined);
  assert.equal((await cache.load()).branch, 'main');
  assert.equal(reads, 2);
});

test('continuations are coalesced by cursor and cannot replace the first page', async () => {
  const urls: string[] = [];
  const continuation = { ...history('preview'), commits: [{ hash: 'b'.repeat(40), parents: [], author: { name: 'Example' }, date: '2026-01-01T00:00:00Z', message: 'Older commit' }] };
  const cache = createGitHistoryCache('/acme/app', async path => {
    urls.push(path);
    return new URL(path, 'http://localhost').searchParams.has('cursor') ? continuation : history('preview');
  });
  await cache.load();
  const pending = cache.load('current', 100, false, 'page-two');
  assert.equal(cache.load('current', 100, false, 'page-two'), pending);
  assert.equal(await pending, continuation);
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('cursor'), 'page-two');
  assert.equal(cache.peek()?.commits.length, 0);
  await cache.load('current', 100, true);
  await cache.load('current', 100, false, 'page-two');
  assert.equal(urls.length, 4, 'Refresh also invalidates continuation pages.');
});

test('a previous source finishing cannot populate a new source snapshot', async () => {
  const pending = Promise.withResolvers<GitHistory>();
  const old = createGitHistoryCache('/acme/app', () => pending.promise);
  const current = createGitHistoryCache('/acme/app', async () => history('preview'));
  const beforeSwitch = old.load();
  await current.load();
  pending.resolve(history('main'));
  await beforeSwitch;
  assert.equal(current.peek()?.branch, 'preview');
});
