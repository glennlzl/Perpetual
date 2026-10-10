import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLoadedAgentIsOwned, buildLaunchAgentPlist, launchAgentIsLoaded, stopLaunchAgent, validInstallState } from './service.ts';

const state = { schema: 1 as const, envFile: '/private/server.env', servicePath: '/old/checkout/bench/connector-broker/serve.ts', nodePath: '/opt/node/bin/node' };
const files = { directory: '/private/service', state: '/private/service/install.json', out: '/private/service/out.log', err: '/private/service/err.log', plist: '/user/Library/LaunchAgents/com.perpetual.connector-broker-trial.plist' };

test('plist regeneration derives its working directory from the saved service path', () => {
  const contents = buildLaunchAgentPlist(state, files);
  assert.match(contents, /<key>WorkingDirectory<\/key><string>\/old\/checkout<\/string>/u);
  assert.match(contents, /<string>--env-file=\/private\/server\.env<\/string>/u);
  assert.doesNotMatch(contents, /COMPOSIO_API_KEY=/u);
});

test('install state rejects non-string paths before checking absoluteness', () => {
  assert.equal(validInstallState(state), true);
  assert.equal(validInstallState({ ...state, envFile: 7 }), false);
  assert.equal(validInstallState({ ...state, servicePath: null }), false);
  assert.equal(validInstallState({ ...state, nodePath: {} }), false);
});

test('an unrelated loaded label is never adopted or restarted', () => {
  assert.throws(() => assertLoadedAgentIsOwned(true, false, false), /not owned/u);
  assert.throws(() => assertLoadedAgentIsOwned(true, true, false), /not owned/u);
  assert.doesNotThrow(() => assertLoadedAgentIsOwned(true, true, true));
  assert.doesNotThrow(() => assertLoadedAgentIsOwned(false, false, false));
});

test('launchctl state errors are not mistaken for an absent service', async () => {
  await assert.rejects(launchAgentIsLoaded(async () => { throw Object.assign(new Error('failed'), { code: 5 }); }, 'gui/501/example'), /determine/u);
  assert.equal(await launchAgentIsLoaded(async () => { throw Object.assign(new Error('absent'), { code: 113 }); }, 'gui/501/example'), false);
});

test('uninstall verifies the service is absent after bootout before allowing file cleanup', async () => {
  const calls: string[][] = [];
  const stillRunning = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'print') return {};
    throw new Error('bootout failed');
  };
  await assert.rejects(stopLaunchAgent(stillRunning, 'gui/501/example'), /still running/u);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'print']);

  const stoppedCalls: string[][] = [];
  await stopLaunchAgent(async args => {
    stoppedCalls.push(args);
    if (args[0] === 'print') throw Object.assign(new Error('absent'), { code: 113 });
    throw new Error('already absent');
  }, 'gui/501/example');
  assert.deepEqual(stoppedCalls.map(args => args[0]), ['bootout', 'print']);
});
