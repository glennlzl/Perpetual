import type { ReadOnlyRequest } from '../../../contract/browser.ts';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseWorker, workerTimeoutMs, type BrowserWorkerInput, type WorkerEvent, type WorkerJob, type WorkerStartOptions } from '../../browser/runtime.ts';
import { validateRunCredentials, type RunCredentials } from '../../browser/run-credentials.ts';
import { HOST as TWIN_HOST } from '../../twin/compose.ts';
import { CHECK_VERSION, sameOrigin, type ApprovedCase } from './checks.ts';
import { createLifecycleRecorder, lifecycleEvent, lifecycleError } from './diagnostics.ts';
import { NAVIGATION_TIMEOUT_MS } from './navigation.ts';

/** A Playwright project of a journey workspace's config. */
export type JourneyProject = { name: string; testDir: string; testMatch?: string; testIgnore?: string };
export type JourneyWorkspaceOptions = { item: ApprovedCase; targetUrl: string; timeoutSeconds: number; projects?: JourneyProject[]; video?: boolean };
export type JourneyEnvironmentOptions = {
  hash: string; targetUrl: string; allowedOrigins?: string[]; readOnlyRequests?: ReadOnlyRequest[]; credentials?: RunCredentials; signInUrl?: string; videoDir?: string;
  checkTimeoutMs?: number; events?: boolean; blockWrites?: boolean; checkVersion?: number; diagnostics?: boolean;
};
/**
 * One journey run as the browser manager starts it: the approved case snapshot, its approved spec and the check version
 * that code was verified under (the current one unless given). signInUrl is the stage's sign-in page, on the
 * application URL's origin.
 */
export type JourneyRunInput = BrowserWorkerInput & {
  case: ApprovedCase; spec: { code: string; hash: string }; targetUrl: string; timeoutSeconds: number;
  allowedOrigins?: string[]; readOnlyRequests?: ReadOnlyRequest[]; credentials?: RunCredentials; signInUrl?: string; videoDir?: string; blockWrites?: boolean; checkVersion?: number;
};
export type PlaywrightCapabilities = { runtimeInstalled: boolean; browserInstalled: boolean };

const require = createRequire(import.meta.url);
/** The pinned Playwright: its CLI runs journeys, the test MCP server and init-agents. */
export const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');
export const PLAYWRIGHT_VERSION = String(require('@playwright/test/package.json').version);
const fixture = new URL('./fixture.ts', import.meta.url).href, reporter = fileURLToPath(new URL('./reporter.ts', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };
const TOKEN_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A run's token, journey.run: 8 random lowercase letters or digits, new for every journey process. */
export const runToken = () => Array.from({ length: 8 }, () => TOKEN_LETTERS[randomInt(TOKEN_LETTERS.length)]).join('');

/**
 * Writes what a journey's `playwright test` process needs into a private workspace: 'perpetual' resolving to the
 * generic fixture, the approved case snapshot and a generated config. Returns the config's path. The spec is
 * `journey.spec.mjs` in the workspace unless `projects` place the tests elsewhere.
 */
export async function writeJourneyWorkspace(workspace: string, { item, targetUrl, timeoutSeconds, projects, video = true }: JourneyWorkspaceOptions) {
  const shim = join(workspace, 'node_modules', 'perpetual');
  await mkdir(shim, { recursive: true, mode: 0o700 });
  await writeFile(join(shim, 'package.json'), JSON.stringify({ name: 'perpetual', type: 'module', exports: './index.mjs' }));
  await writeFile(join(shim, 'index.mjs'), `export * from ${JSON.stringify(fixture)};\n`);
  await writeFile(join(workspace, 'case.json'), JSON.stringify(item));
  // No retries: a pass that needed one is no pass, and a flaky pass fails the run.
  const config = {
    ...(projects ? { projects } : { testDir: workspace, testMatch: 'journey.spec.mjs' }), outputDir: join(workspace, 'output'), reporter: [[reporter]],
    timeout: timeoutSeconds * 1000, workers: 1, retries: 0, failOnFlakyTests: true,
    use: {
      baseURL: new URL(targetUrl).origin, viewport: VIEWPORT, video: video ? { mode: 'on', size: VIEWPORT } : 'off', trace: 'off', screenshot: 'off',
      actionTimeout: 10000, navigationTimeout: NAVIGATION_TIMEOUT_MS, serviceWorkers: 'block', acceptDownloads: false, headless: true,
      // As in discovery's browser, the twin's host name resolves to loopback.
      launchOptions: { args: [`--host-resolver-rules=MAP ${TWIN_HOST} 127.0.0.1`] },
    },
  };
  const path = join(workspace, 'playwright.config.mjs');
  await writeFile(path, `export default ${JSON.stringify(config)};\n`);
  return path;
}

/**
 * The fixture's and reporter's environment for one spec. The account and its sign-in page reach only this environment,
 * never a file; without events the fixture reports nothing and streams no frames. blockWrites makes it a verification's
 * control run, and checkVersion is what its reviewed checks read. Every call draws a new run token, so each journey process, and each
 * attempt of a verification, types its own values.
 */
export function journeyEnvironment(values: NodeJS.ProcessEnv, workspace: string, { hash, targetUrl, allowedOrigins = [], readOnlyRequests = [], credentials, signInUrl, videoDir, checkTimeoutMs = 10000, events = true, blockWrites = false, checkVersion = CHECK_VERSION, diagnostics = false }: JourneyEnvironmentOptions): Record<string, string> {
  // Playwright would otherwise write a failed test's page snapshot, filled password field included, to a file.
  const childEnv: Record<string, string> = { FORCE_COLOR: '0', PLAYWRIGHT_NO_COPY_PROMPT: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']) if (typeof values[key] === 'string') childEnv[key] = values[key];
  return Object.assign(childEnv, {
    ...(events ? { PERPETUAL_EVENT_CHANNEL: `@${randomBytes(16).toString('hex')}@` } : {}),
    PERPETUAL_CASE: join(workspace, 'case.json'), PERPETUAL_SPEC_HASH: hash, PERPETUAL_CHECK_TIMEOUT_MS: String(checkTimeoutMs), PERPETUAL_CHECK_VERSION: String(checkVersion),
    PERPETUAL_READ_REQUESTS: JSON.stringify(readOnlyRequests), PERPETUAL_TARGET_URL: targetUrl, PERPETUAL_ALLOWED_ORIGINS: JSON.stringify(allowedOrigins), PERPETUAL_RUN_TOKEN: runToken(),
    ...(videoDir ? { PERPETUAL_VIDEO_DIR: videoDir } : {}), ...(blockWrites ? { PERPETUAL_BLOCK_WRITES: '1' } : {}),
    ...(diagnostics && events && !blockWrites ? { PERPETUAL_LIFECYCLE_DIAGNOSTICS: '1' } : {}),
    ...(credentials ? { PERPETUAL_ACCOUNT_USERNAME: credentials.username, PERPETUAL_ACCOUNT_PASSWORD: credentials.password } : {}),
    ...(signInUrl ? { PERPETUAL_SIGN_IN_URL: signInUrl } : {}),
  });
}

/**
 * Runs one journey's code as its own `playwright test` process. A private workspace holds the approved case snapshot,
 * the spec and a generated config. input.blockWrites runs it as a verification's control run.
 */
export function createPlaywrightRuntime({ env = process.env, checkTimeoutMs = 10000, diagnosticsDir }: { env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv); checkTimeoutMs?: number; diagnosticsDir?: string } = {}) {
  let preflight: PlaywrightCapabilities | null = null, checkedAt = 0;
  return {
    async capabilities(): Promise<PlaywrightCapabilities> {
      if (!preflight || Date.now() - checkedAt > 15000) {
        const { chromium } = await import('@playwright/test');
        preflight = { runtimeInstalled: true, browserInstalled: await access(chromium.executablePath()).then(() => true, () => false) };
        checkedAt = Date.now();
      }
      return preflight;
    },
    start(input: JourneyRunInput, onEvent: (event: WorkerEvent) => void, { timeoutMs = workerTimeoutMs(input), cleanupGraceMs = 40000 }: WorkerStartOptions = {}): WorkerJob {
      const credentials = validateRunCredentials(input.credentials);
      if (input.mode !== 'run' || !input.case?.id || typeof input.spec?.code !== 'string' || !/^[a-f0-9]{64}$/.test(input.spec.hash || '')) throw new Error('A Playwright journey needs its approved case and spec.');
      const checkVersion = input.checkVersion ?? CHECK_VERSION;
      if (!Number.isInteger(checkVersion) || checkVersion < 1 || checkVersion > CHECK_VERSION) throw new Error('A Playwright journey needs a known check version.');
      const signInUrl: unknown = input.signInUrl;
      if (signInUrl !== undefined && (typeof signInUrl !== 'string' || !sameOrigin(signInUrl, input.targetUrl))) throw new Error('A Playwright journey’s sign-in page must be on its application URL’s origin.');
      const values = typeof env === 'function' ? env() : env;
      const diagnostic = createLifecycleRecorder({ directory: diagnosticsDir ?? values.PERPETUAL_PLAYWRIGHT_DIAGNOSTICS_DIR, blockWrites: input.blockWrites === true, secrets: credentials ? [credentials.username, credentials.password] : [] });
      let job: WorkerJob | null = null, cancelled = false, failed = false;
      const promise = (async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'perpetual-playwright-'));
        try {
          const config = await writeJourneyWorkspace(workspace, { item: input.case, targetUrl: input.targetUrl, timeoutSeconds: input.timeoutSeconds });
          await writeFile(join(workspace, 'journey.spec.mjs'), input.spec.code);
          const childEnv = journeyEnvironment(values, workspace, { hash: input.spec.hash, targetUrl: input.targetUrl, allowedOrigins: input.allowedOrigins, readOnlyRequests: input.readOnlyRequests, credentials, signInUrl, videoDir: input.videoDir, checkTimeoutMs, blockWrites: input.blockWrites === true, checkVersion, diagnostics: diagnostic.enabled });
          if (cancelled) throw new Error('Browser operation cancelled.');
          // Playwright finishes the test, its recordings and its reporter on SIGINT.
          job = superviseWorker({ command: process.execPath, args: [PLAYWRIGHT_CLI, 'test', '--config', config], cwd: workspace, env: childEnv, onEvent: event => {
            // Retention does not depend on optional diagnostic delivery. These are existing result facts,
            // observed without changing them or the controller's verdict.
            if (event.type === 'journey-step' && event.status === 'failed') failed = true;
            if (event.type === 'result' && event.result && typeof event.result === 'object') {
              const facts = event.result as Record<string, unknown>;
              if (facts.stopCause === 'action' || facts.stopCause === 'deadline' || Array.isArray(facts.assertions) && facts.assertions.some(value => value && typeof value === 'object' && value.passed === false)) failed = true;
            }
            onEvent(event);
          }, timeoutMs, cleanupGraceMs, stopSignal: 'SIGINT', secrets: [credentials?.password], errorSecrets: [credentials?.username], unavailable: 'Playwright is unavailable. Run npm install.',
            ...(diagnostic.enabled ? {
              onLifecycle: event => diagnostic.record({ ...event, source: 'supervisor' }),
              onDiagnostic: value => {
                const event = lifecycleEvent(value);
                if (!event || !['fixture', 'reporter'].includes(event.source)) return;
                if (event.source === 'reporter' && event.name === 'reporter-end' && event.failed === true) failed = true;
                diagnostic.record(event);
              },
            } : {}),
          });
          await job.promise;
        } catch (error) { failed = true; diagnostic.record({ source: 'runtime', name: 'runtime-end', error: lifecycleError(error) }); throw error; }
        finally {
          await rm(workspace, { recursive: true, force: true }).catch(() => {});
          diagnostic.record({ source: 'runtime', name: 'runtime-end', failed });
          // Optional filesystem I/O cannot hold the completed worker or its environment lease.
          void diagnostic.finish(failed);
        }
      })();
      return { promise, cancel() { cancelled = true; diagnostic.record({ source: 'runtime', name: 'runtime-cancel' }); job?.cancel(); } };
    },
  };
}
