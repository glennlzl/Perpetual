import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCheckoutAt } from '../src/gate/checkout.ts';

// A twin copies a local checkout as it is on disk, so a gate reports on a commit only from a clean checkout at it.
test('a gate builds a twin from a local checkout only while it is clean and at the gate\'s commit', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'perpetual-gate-checkout-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(repo, 'server.js'), 'send("FIXED")\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  await assertCheckoutAt(repo, first);
  // Files the snapshot never copies do not count: Perpetual's own storage, installed packages and env files.
  await mkdir(join(repo, '.perpetual'), { recursive: true }); await writeFile(join(repo, '.perpetual', 'state.json'), '{}');
  await mkdir(join(repo, 'node_modules', 'x'), { recursive: true }); await writeFile(join(repo, 'node_modules', 'x', 'index.js'), '');
  await writeFile(join(repo, '.env'), 'SECRET=1\n');
  await assertCheckoutAt(repo, first);
  const dirty = /uncommitted changes, which a twin would copy/;
  await writeFile(join(repo, 'server.js'), 'send("BROKEN")\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'An edit of a tracked file.');
  git('checkout', '--quiet', '--', 'server.js');
  await writeFile(join(repo, 'extra.js'), 'export {};\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'A new file the snapshot would copy.');
  git('add', 'extra.js'); git('commit', '--quiet', '-m', 'second');
  await assert.rejects(assertCheckoutAt(repo, first), new RegExp(`The checkout is at ${git('rev-parse', 'HEAD').slice(0, 7)}, not ${first.slice(0, 7)}`), 'A commit made after the scan.');
  await assert.rejects(assertCheckoutAt(join(repo, 'missing'), first), /The checkout is at no commit/);
});

// A twin copies a package manager's config without its credential lines, so a change to those alone is no change of the twin.
test('a package manager config that differs from the commit\'s only in its credentials is no change a twin would copy', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'perpetual-gate-checkout-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  // The configs count whatever the user's own excludes say.
  git('config', 'core.excludesFile', join(repo, '.git', 'no-excludes'));
  await writeFile(join(repo, '.npmrc'), 'legacy-peer-deps=true\n');
  await writeFile(join(repo, 'server.js'), 'send("FIXED")\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  // A registry token added to the committed config, and an untracked config, staged or not, that holds only credentials.
  await writeFile(join(repo, '.npmrc'), 'legacy-peer-deps=true\n//registry.npmjs.org/:_authToken=fixture-npm-token\n');
  await mkdir(join(repo, 'packages', 'web'), { recursive: true });
  await writeFile(join(repo, 'packages', 'web', '.yarnrc.yml'), 'npmAuthToken: fixture-berry-token\n');
  await writeFile(join(repo, 'packages', '.npmrc'), 'registry=https://fixture-fury-token:@npm.fury.io/acme/\n');
  git('add', 'packages/.npmrc');
  await assertCheckoutAt(repo, first);
  const dirty = /uncommitted changes, which a twin would copy/;
  // A setting the copy keeps is a change, in a committed config or a new one, and so is a config deleted.
  await writeFile(join(repo, '.npmrc'), 'legacy-peer-deps=false\n//registry.npmjs.org/:_authToken=fixture-npm-token\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'A committed setting changed.');
  git('checkout', '--quiet', '--', '.npmrc');
  await writeFile(join(repo, 'packages', 'web', '.yarnrc.yml'), 'nodeLinker: pnp\nnpmAuthToken: fixture-berry-token\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'A new config with a setting.');
  await rm(join(repo, 'packages'), { recursive: true });
  git('rm', '--quiet', '--cached', 'packages/.npmrc');
  await rm(join(repo, '.npmrc'));
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'A committed config deleted.');
});
