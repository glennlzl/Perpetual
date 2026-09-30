import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// contract/ holds the reply shapes the controller implements and the client reads. Node strips
// the files and Vite erases the imports only while both sides import them as types, so the seam
// stays type-only: no runtime code in contract/, no value import of it anywhere.
const root = new URL('../', import.meta.url);
const files = async (dir: string) => (await readdir(new URL(dir, root), { recursive: true })).filter(file => /\.tsx?$/.test(file)).map(file => `${dir}${file}`);
const source = (file: string) => readFile(new URL(file, root), 'utf8');

test('the contract holds types only, and every side imports it as types', async () => {
  const contract = await files('contract/');
  assert.ok(contract.length >= 3, 'gate, github and autopilot');
  for (const file of contract) {
    const text = await source(file);
    assert.doesNotMatch(text, /^\s*export\s+(const|let|var|function|class|enum)\b/m, `${file} holds runtime code`);
    assert.doesNotMatch(text, /^\s*import\s+(?!type\b)/m, `${file} imports a value`);
  }
  for (const file of [...await files('src/'), ...await files('client/src/'), ...await files('test/')]) {
    const text = await source(file);
    for (const line of text.split('\n')) {
      if (!/^\s*(import|export)\b.*contract\/[\w-]+\.ts['"]/.test(line)) continue;
      assert.match(line, /^\s*(import type|export type)\b/, `${file}: ${line.trim()}`);
    }
  }
});

test('the controller replies with the contract\'s shapes and the client reads them from it', async () => {
  const pairs: [string, string][] = [
    ['src/browser/manager.ts', 'contract/browser.ts'], ['src/browser/journey-code.ts', 'contract/browser.ts'], ['src/browser/results.ts', 'contract/browser.ts'], ['src/business/browser-cases.ts', 'contract/browser.ts'],
    ['client/src/lib/browser-test-ui.ts', 'contract/browser.ts'], ['client/src/lib/test-workspace.ts', 'contract/browser.ts'],
    ['src/gate/manager.ts', 'contract/gate.ts'], ['src/github-runs.ts', 'contract/github.ts'], ['src/github-deployments.ts', 'contract/github.ts'], ['src/repair/view.ts', 'contract/autopilot.ts'],
    ['client/src/lib/stage-gate.ts', 'contract/gate.ts'], ['client/src/lib/pipeline-github.ts', 'contract/github.ts'], ['client/src/lib/pipeline-deployments.ts', 'contract/github.ts'], ['client/src/lib/pipeline-autopilot.ts', 'contract/autopilot.ts'],
  ];
  for (const [file, contract] of pairs) assert.match(await source(file), new RegExp(contract.replace('.', '\\.')), `${file} imports ${contract}`);
  // The shapes are declared once: the client keeps no interface of its own for them.
  for (const [file, names] of [['client/src/lib/stage-gate.ts', ['StageGate', 'GateView', 'ProductionGate']], ['client/src/lib/pipeline-github.ts', ['GitHubRun', 'GitHubJob', 'GitHubStep', 'GitHubRuns']], ['client/src/lib/pipeline-deployments.ts', ['GitHubDeployment', 'GitHubDeployments']]] as [string, string[]][]) {
    const text = await source(file);
    for (const name of names) assert.doesNotMatch(text, new RegExp(`^export interface ${name}\\b`, 'm'), `${file} re-declares ${name}`);
  }
});
