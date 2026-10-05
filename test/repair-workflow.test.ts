import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE, boxImage, failingStep, fallbackImages, reproduces, toolVersion, versionFromFile } from '../src/repair/workflow.ts';

const workflow = (steps: string, extra = '') => `name: CI\non: push\njobs:\n  test:\n    name: Test\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const NODE = '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm ci\n      - name: Typecheck\n        run: npm run typecheck\n        working-directory: web\n';

test('the box image follows the failing job\'s setup action and its version', () => {
  const image = (steps: string, extra?: string) => boxImage(failingStep(workflow(steps, extra), 'Test', []).toolchain);
  assert.equal(image(NODE), 'node:22-bookworm');
  assert.equal(image('      - uses: actions/setup-node@v4\n        with:\n          node-version: 20.x\n'), 'node:20-bookworm');
  assert.equal(image('      - uses: actions/setup-node@v4\n        with:\n          node-version: lts/*\n'), 'node:lts-bookworm');
  assert.equal(image('      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n'), 'python:3.12-bookworm');
  assert.equal(image('      - uses: actions/setup-go@v5\n        with:\n          go-version: "1.22.3"\n'), 'golang:1.22.3-bookworm');
  assert.equal(image('      - uses: actions/setup-go@v5\n        with:\n          go-version: stable\n'), 'golang:1-bookworm');
  assert.equal(image('      - uses: actions/checkout@v4\n      - run: make test\n'), DEFAULT_IMAGE);
  assert.equal(boxImage(null), 'buildpack-deps:bookworm');
});

test('a box falls back from a toolchain tag the registry lacks to the same version\'s default base, then to the default image', () => {
  assert.deepEqual(fallbackImages('node:14-bookworm'), ['node:14', DEFAULT_IMAGE]);
  assert.deepEqual(fallbackImages('python:3.15-bookworm'), ['python:3.15', DEFAULT_IMAGE]);
  assert.deepEqual(fallbackImages(DEFAULT_IMAGE), []);
});

test('a version that is not a plain version never reaches the image name', () => {
  for (const value of ['20; rm -rf /', '$(id)', '../../evil', '22:latest', 'node@22', '>=18', '999999']) assert.equal(toolVersion('node', value), null, value);
  assert.equal(boxImage({ tool: 'node', version: '20 && curl evil' }), 'node:lts-bookworm');
  assert.equal(boxImage({ tool: 'python', version: '2.7' }), 'python:3-bookworm');
  assert.equal(boxImage({ tool: 'go', version: 'tip' }), 'golang:1-bookworm');
});

test('a matrix version is the one in the failed job\'s name, and a version file is read when named', () => {
  const matrix = '    strategy:\n      matrix:\n        node: [18, 20, 22]\n';
  const steps = '      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm test\n';
  assert.equal(failingStep(workflow(steps, matrix), 'Test (20)', ['Run npm test']).toolchain?.version, '20');
  assert.equal(failingStep(workflow(steps, matrix), 'Test', ['Run npm test']).toolchain?.version, '18');
  const file = failingStep(workflow('      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n'), 'Test', []).toolchain;
  assert.deepEqual(file, { tool: 'node', version: null, file: '.nvmrc' });
  assert.equal(versionFromFile('node', '.nvmrc', 'v20.11.0\n'), '20.11.0');
  assert.equal(versionFromFile('python', '.python-version', '# pinned\n3.11.9\n'), '3.11.9');
  assert.equal(versionFromFile('go', 'go.mod', 'module example.com/app\n\ngo 1.23.1\n'), '1.23.1');
  assert.equal(versionFromFile('node', 'package.json', '{"engines":{"node":">=20"}}'), null);
});

// asdf lists tools alphabetically, so another tool's line often comes first.
test('.tool-versions is read on the tool\'s own line, never another tool\'s', () => {
  const tools = '# toolchain\ngolang 1.22.1\nnodejs 20.11.0 18.19.0 # fallbacks\npython 3.12.1\n';
  assert.deepEqual([versionFromFile('node', '.tool-versions', tools), versionFromFile('python', 'web/.tool-versions', tools), versionFromFile('go', '.tool-versions', tools)], ['20.11.0', '3.12.1', '1.22.1']);
  assert.equal(versionFromFile('node', '.tool-versions', 'golang 1.22.1\npython 3.12.1\n'), null, 'A file without the tool names no version, so the image keeps its default tag.');
  assert.equal(boxImage({ tool: 'node', version: versionFromFile('node', '.tool-versions', 'golang 1.22.1\n') }), 'node:lts-bookworm');
});

test('the failed step\'s run command and working directory are read by name, or by GitHub\'s default name', () => {
  assert.deepEqual(failingStep(workflow(NODE), 'Test', ['Typecheck']), {
    job: 'Test', step: 'Typecheck', run: 'npm run typecheck', workingDirectory: 'web', toolchain: { tool: 'node', version: '22', file: null },
  });
  assert.equal(failingStep(workflow(NODE), 'test', ['Run npm ci']).run, 'npm ci', 'A job is found by its id too, and an unnamed step by its first line.');
  const reusable = failingStep(workflow(NODE), 'Test / build', ['Typecheck']);
  assert.equal(reusable.run, 'npm run typecheck');
  assert.deepEqual(failingStep('jobs: [', 'Test', ['Typecheck']), { job: 'Test', step: 'Typecheck', run: null, workingDirectory: null, toolchain: null }, 'Unreadable YAML reads as nothing.');
  assert.equal(failingStep(workflow(NODE), 'Other', ['Typecheck']).run, 'npm run typecheck', 'A workflow with one job is that job.');
});

test('a command reproduces a failing step only when it runs one of that step\'s own commands', () => {
  const script = 'npm ci\ncd web && CI=true npm run typecheck -- --pretty \\\n  false | tee typecheck.log\n# npm run lint\necho done';
  for (const command of ['npm run typecheck -- --pretty false', 'cd web && npm run typecheck -- --pretty false', 'CI=1 npm run typecheck -- --pretty false 2>&1', 'npm ci', '(npm ci)'])
    assert.equal(reproduces(command, [script]), true, command);
  for (const command of ['pnpm ci', 'npm run typecheck', 'npm run lint', 'echo done', 'cd web', 'cat missing-file', 'npm cinnamon', 'tee typecheck.log.bak'])
    assert.equal(reproduces(command, [script]), false, command);
  assert.equal(reproduces('tee typecheck.log', [script]), true, 'Each command of a pipeline counts.');
  const matrix = 'npm run test:${{ matrix.suite }}\nnode ${{ matrix.script }}';
  assert.equal(reproduces('npm run test:unit', [matrix]), true, 'A command with an expression is matched up to it.');
  assert.equal(reproduces('node -e "process.exit(1)"', [matrix]), false, 'A program alone before an expression names no check.');
  assert.equal(reproduces('npm test', []), false, 'Without a known step command nothing reproduces.');
  assert.equal(reproduces('go test ./...', ['make lint', 'go test ./...']), true, 'Any failing step counts.');
});
