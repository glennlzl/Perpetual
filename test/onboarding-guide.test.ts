import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IN_PROGRESS } from '../src/environments/usage.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// The onboarding guide is what a coding agent runs, so every route and command it names must exist as written.
test('the onboarding guide names only API routes the controller serves and CLI commands the CLI has', async () => {
  const [guide, server, cli] = await Promise.all([read('docs/onboarding.md'), read('src/server.ts'), read('src/cli.ts')]);
  const routes = [...new Set([...guide.matchAll(/`(?:GET|POST) (\/api\/[\w/-]+)/g)].map(match => match[1]))];
  assert.ok(routes.length >= 10, `The guide drives the controller through its API: ${routes.join(', ')}`);
  const served = (route: string) => server.includes(`'${route}'`)
    // Environment operations are dispatched by the path's last segment.
    || (route.startsWith('/api/environments/') && server.includes(`operation==='${route.slice('/api/environments/'.length)}'`));
  assert.deepEqual(routes.filter(route => !served(route)), []);
  const commands = [...new Set([...guide.matchAll(/node src\/cli\.ts (\w+)/g)].map(match => match[1]))].sort();
  assert.deepEqual(commands, ['serve', 'twin']);
  for (const command of commands) assert.ok(cli.includes(`command==='${command}'`), command);
  // The guide's steps are ordered, and the person is asked before each account, source or environment change.
  for (const step of ['## 1. Start the controller', '## 2. The model key', '## 3. Connect GitHub', '## 4. The target branch', '## 5. What the twin will run', '## 6. Create Beta', '## 7. Hand over']) assert.ok(guide.includes(step), step);
  assert.ok(guide.indexOf('## 3.') < guide.indexOf('## 5.') && guide.indexOf('## 5.') < guide.indexOf('## 6.'));
  // Each question is written out for the agent's own question tool: its text, then its options as a list.
  const questions = [...guide.matchAll(/\*\*Ask:\*\* ([^\n]+)\n\n((?:- [^\n]+\n)+)/g)].map(match => ({ text: match[1], options: match[2].trim().split('\n').length }));
  assert.ok(questions.length >= 6, `Questions: ${questions.map(question => question.text).join(' | ')}`);
  for (const question of questions) assert.ok(question.options >= 2, question.text);
  assert.equal(guide.match(/\*\*Ask:\*\*/g)?.length, questions.length, 'Every question lists its options.');
  for (const text of ['Connect your GitHub account to Perpetual?', 'Which branch should Perpetual gate?', 'Create the Beta environment?']) assert.ok(questions.some(question => question.text.startsWith(text)), text);
});

test('the guide waits for every state the controller can settle in, and reads the sign-in code once it exists', async () => {
  const [guide, github, auth, environments] = await Promise.all([read('docs/onboarding.md'), read('contract/github.ts'), read('src/github-auth.ts'), read('src/environments/manager.ts')]);
  const union = (source: string, name: string) => [...(new RegExp(`export type ${name} = ([^;]+);`).exec(source)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map(match => match[1]);
  const step = (number: number) => guide.slice(guide.indexOf(`## ${number}.`), guide.indexOf(`## ${number + 1}.`));
  const unnamed = (text: string, states: string[]) => states.filter(state => !text.includes(`\`${state}\``));
  // A browser sign-in ends in every status but starting and pending, and its start reply carries no code yet.
  const signIn = union(github, 'SignInStatus');
  assert.ok(signIn.includes('pending') && signIn.includes('complete'), signIn.join(', '));
  assert.deepEqual(unnamed(step(3), signIn.filter(status => !['starting', 'pending'].includes(status))), []);
  assert.match(step(3), /`pending`[^\n]*`userCode`/);
  // Cancelling ends a sign-in without an error, so the guide relays `error` for exactly the end states that set one.
  const unset = new Set([...auth.matchAll(/finish\(session, '(\w+)'\)/g)].map(match => match[1]));
  assert.ok(unset.has('complete'), [...unset].join(', '));
  const relayed = /\bon ([^;.]+), give them its `error`/i.exec(step(3))?.[1] ?? '';
  const failed = signIn.filter(status => !['starting', 'pending', 'complete'].includes(status));
  assert.deepEqual(failed.filter(status => relayed.includes(`\`${status}\``)), failed.filter(status => !unset.has(status)));
  // A creation settles in every status that is neither in progress nor a deletion's.
  const settled = union(environments, 'EnvironmentStatus').filter(status => !IN_PROGRESS.includes(status) && status !== 'destroyed');
  assert.deepEqual(settled, ['ready', 'failed', 'cleanup_failed']);
  assert.deepEqual(unnamed(step(6), settled), []);
  // Only an OpenRouter model writes the twin config, drafts and code, so another provider's model does not end step 2.
  assert.match(step(2), /`capabilities\.provider: "openrouter"`/);
});
