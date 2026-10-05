#!/usr/bin/env node
// One command after a clone, `npm run setup`: installs what Perpetual runs with and says what the machine still lacks.
// It runs before node_modules exists, so it imports only Node's own modules; the OpenCode pin is read once the
// dependencies are installed. It never touches the repository Perpetual will test.
import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
// Windows resolves npm, uv, docker and gh through the shell.
const shell = process.platform === 'win32';
const exec = promisify(execFile);
/** The command that starts the controller once setup is done. */
export const SERVE = 'node src/cli.ts serve --repo /path/to/your/app';

/** Whether a Node.js version (`v24.12.0`) is at least the `major.minor` that package.json's engines names (`>=24.12`). */
export function nodeSatisfies(version: string, minimum: string): boolean {
  const parse = (text: string) => (/(\d+)\.(\d+)/.exec(text) ?? []).slice(1, 3).map(Number);
  const [major, minor] = parse(version), [least, leastMinor] = parse(minimum);
  return major > least || (major === least && minor >= leastMinor);
}

/** A tool Perpetual runs but does not install, and what to do when the machine lacks it. */
export type Tool = { name: string; ready: boolean; fix: string };

async function available(command: string, args: string[], timeout = 15000) {
  try { await exec(command, args, { cwd: root, timeout, shell, windowsHide: true }); return true; } catch { return false; }
}

/** uv installs the browser runtime, so setup runs again after it; Docker and the GitHub CLI are used only at run time. */
async function tools(): Promise<Tool[]> {
  const compose = await available('docker', ['compose', 'version']);
  return [
    { name: 'uv', ready: await available('uv', ['--version']), fix: 'Install uv (https://docs.astral.sh/uv/getting-started/installation/), then run npm run setup again.' },
    compose
      ? { name: 'Docker', ready: await available('docker', ['info'], 30000), fix: 'Start Docker.' }
      : { name: 'Docker', ready: false, fix: 'Install Docker with Compose (https://docs.docker.com/get-started/get-docker/).' },
    { name: 'GitHub CLI', ready: await available('gh', ['--version']), fix: 'Install the GitHub CLI (https://cli.github.com/).' },
  ];
}

type Step = { title: string; command: string; args: string[] };
/** npm ci leaves out devDependencies where NODE_ENV is production, and the interface build needs them. */
export const INSTALL: Step = { title: 'Install dependencies', command: 'npm', args: ['ci', '--include=dev'] };

/** Runs one install step in the repository root with its output shown, and fails with the step's title. */
function run({ title, command, args }: Step): Promise<void> {
  console.log(`\n→ ${title}: ${[command === process.execPath ? 'node' : command, ...args].join(' ')}`);
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell, windowsHide: true });
    child.once('error', error => fail(new Error(`${title} failed: ${error.message}`)));
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${title} failed${code === null ? '' : ` with exit code ${code}`}.`)));
  });
}

/** What setup installed, each missing tool with its fix, and how to start. */
export function report({ installed, tools, notes = [] }: { installed: string[]; tools: Tool[]; notes?: string[] }): string {
  const missing = tools.filter(tool => !tool.ready);
  return [
    `Installed: ${installed.join(', ')}.`,
    ...notes,
    ...(missing.length ? ['Missing:', ...missing.map(tool => `  ${tool.name}: ${tool.fix}`)] : []),
    missing.length ? 'Then start Perpetual:' : 'Start Perpetual:',
    `  ${SERVE}`,
  ].join('\n');
}

async function main() {
  const { engines } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
  if (!nodeSatisfies(process.version, engines.node)) throw new Error(`Perpetual needs Node.js ${engines.node.replace(/^\D+/, '')} or later; this is ${process.version}. https://nodejs.org/en/download`);
  const found = await tools();
  const installed: string[] = [], notes: string[] = [];
  await run(INSTALL);
  installed.push('dependencies');
  await run({ title: 'Build the interface', command: 'npm', args: ['run', 'build'] });
  installed.push('the interface');
  // Playwright's Node and Python packages pin the same version, so the browser runtime shares this Chromium.
  await run({ title: 'Install Chromium', command: process.execPath, args: ['node_modules/playwright/cli.js', 'install', 'chromium'] });
  installed.push('Chromium');
  if (process.platform === 'linux') notes.push('If Chromium fails to start, install its system libraries: npx playwright install-deps chromium');
  if (found[0].ready) {
    await run({ title: 'Install the browser runtime', command: 'uv', args: ['sync', '--project', 'integrations/browser-use', '--frozen'] });
    installed.push('the browser runtime');
  }
  const { OPENCODE_VERSION } = await import('../src/agents/opencode.ts');
  try {
    await run({ title: `Fetch OpenCode ${OPENCODE_VERSION}`, command: 'npx', args: ['-y', `opencode-ai@${OPENCODE_VERSION}`, '--version'] });
    installed.push(`OpenCode ${OPENCODE_VERSION}`);
  } catch { notes.push(`OpenCode ${OPENCODE_VERSION} was not fetched; it downloads on first use.`); }
  console.log(`\n${report({ installed, tools: found, notes })}`);
  if (found.some(tool => !tool.ready)) process.exitCode = 1;
}

/** Whether this process runs setup itself, named through a link or not; Node gives the module its real path. */
export function isEntryPoint(entry = process.argv[1]) {
  try { return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
