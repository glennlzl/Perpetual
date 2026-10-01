import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { listGitHubRepositories } from '../src/github-source.ts';

test('repository choices expose only text display metadata while retaining validated identity and pagination', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-github-replies-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  const body = [
    { full_name: 'acme/ordinary', name: 'ordinary', private: true, default_branch: 'main' },
    { full_name: 'acme/unreadable', name: { unexpected: 'object' }, private: false, default_branch: ['main'] },
    { full_name: 'acme/absent' },
  ];
  const response = 'HTTP/2.0 200 OK\nLink: <https://api.github.com/user/repos?page=2>; rel="next"\n\n' + JSON.stringify(body);
  await writeFile(join(directory, 'gh'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(response)});\n`, { mode: 0o755 });
  process.env.PATH = directory + delimiter + (previousPath ?? '');
  assert.deepEqual(await listGitHubRepositories(), {
    repositories: [
      { fullName: 'acme/ordinary', name: 'ordinary', private: true, defaultBranch: 'main' },
      { fullName: 'acme/unreadable', name: null, private: false, defaultBranch: null },
      { fullName: 'acme/absent', name: null, private: false, defaultBranch: null },
    ],
    nextPage: 2,
  });
});
