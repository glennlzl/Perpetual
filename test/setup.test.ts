import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TWINS_NEED_DESKTOP, engineNote, nodeSatisfies, report, SERVE } from '../scripts/setup.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('setup admits the Node.js versions package.json engines names, and refuses older ones', async () => {
  const { engines } = JSON.parse(await read('package.json')) as { engines: { node: string } };
  assert.equal(engines.node, '>=24.12');
  for (const version of ['v24.12.0', 'v24.13.1', 'v26.7.0']) assert.ok(nodeSatisfies(version, engines.node), version);
  for (const version of ['v24.11.9', 'v22.18.0', 'v23.6.0']) assert.ok(!nodeSatisfies(version, engines.node), version);
});

test('the setup report names what was installed, each missing tool with its fix, and the command that starts Perpetual', () => {
  const tools = [
    { name: 'uv', ready: true, fix: 'Install uv.' },
    { name: 'Docker', ready: false, fix: 'Start Docker.' },
    { name: 'GitHub CLI', ready: false, fix: 'Install the GitHub CLI (https://cli.github.com/).' },
  ];
  assert.equal(report({ installed: ['dependencies', 'Chromium'], tools, notes: ['OpenCode 1.0.0 was not fetched; it downloads on first use.'] }),
    ['Installed: dependencies, Chromium.', 'OpenCode 1.0.0 was not fetched; it downloads on first use.', 'Missing:', '  Docker: Start Docker.',
      '  GitHub CLI: Install the GitHub CLI (https://cli.github.com/).', 'Then start Perpetual:', `  ${SERVE}`].join('\n'));
  assert.equal(report({ installed: ['dependencies'], tools: tools.map(tool => ({ ...tool, ready: true })) }), `Installed: dependencies.\nStart Perpetual:\n  ${SERVE}`);
});

test('setup says twins need Docker Desktop on a native Linux engine, which stays ready for build repair', () => {
  // `docker info --format {{.OperatingSystem}}` names the engine's system: the distribution on a native engine.
  assert.equal(engineNote('linux', 'Ubuntu 24.04.1 LTS\n'), TWINS_NEED_DESKTOP);
  for (const [platform, system] of [['linux', 'Docker Desktop\n'], ['darwin', 'Docker Desktop\n'], ['win32', 'Docker Desktop'], ['linux', null]] as const) assert.equal(engineNote(platform, system), null, `${platform}: ${system}`);
  const tools = [{ name: 'Docker', ready: true, fix: 'Start Docker.' }];
  assert.equal(report({ installed: ['dependencies'], tools, notes: [TWINS_NEED_DESKTOP] }), `Installed: dependencies.\n${TWINS_NEED_DESKTOP}\nStart Perpetual:\n  ${SERVE}`);
});

test('the Quickstart, the contributor guide and package.json name the one setup command', async () => {
  const { scripts } = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
  assert.equal(scripts.setup, 'node scripts/setup.ts');
  const readme = await read('README.md');
  const prompt = /```text\n([\s\S]*?)\n```/.exec(readme)?.[1] ?? '';
  assert.match(prompt, /^[^\n]+$/, 'The coding-agent prompt is one copyable block.');
  for (const part of ['npm run setup', 'docs/onboarding.md', 'Leave this repository unchanged']) assert.ok(prompt.includes(part), part);
  assert.match(readme, /```sh\ngit clone https:\/\/github\.com\/willlzl\/Perpetual\.git && cd Perpetual\nnpm run setup\nnode src\/cli\.ts serve --repo \/path\/to\/your\/app\n```/);
  assert.doesNotMatch(readme, /uv sync|playwright install/, 'The README leaves the install steps to setup.');
  assert.match(await read('CONTRIBUTING.md'), /npm run setup/);
});
