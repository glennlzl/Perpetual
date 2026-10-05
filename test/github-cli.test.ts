import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { GITHUB_MESSAGES, githubEnvironment, githubFailureKind, githubGetArgs, isRepository, notModified, parseGitHubResponse, runGitHub } from '../src/github-cli.ts';

test('gh runs with its own configuration and none of the inherited git or debug settings', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: '/elsewhere/.git', GIT_SSH_COMMAND: 'ssh -v', GH_DEBUG: 'api', GH_FORCE_TTY: '1', GH_TOKEN: 'keep', HOME: '/home/u', SSH_ASKPASS: '/bin/ask', DEBUG: '*' });
    const env = githubEnvironment();
    assert.equal(Object.keys(env).some(key => key.startsWith('GIT_')), false);
    assert.equal(env.GH_DEBUG, undefined);
    assert.equal(env.GH_FORCE_TTY, undefined);
    assert.deepEqual([env.GH_HOST, env.GH_PROMPT_DISABLED, env.GH_PAGER, env.GH_TOKEN, env.HOME, env.SSH_ASKPASS], ['github.com', '1', 'cat', 'keep', '/home/u', '/bin/ask'], 'The token, home and keychain settings stay.');
    const login = githubEnvironment({ strip: ['DEBUG', 'SSH_ASKPASS'], set: { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' } });
    assert.deepEqual([login.DEBUG, login.SSH_ASKPASS, login.NO_COLOR, login.GIT_TERMINAL_PROMPT], [undefined, undefined, '1', '0'], 'A caller strips more and sets its own.');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a repository is owner/name, never a path', () => {
  assert.deepEqual(['acme/app', 'acme/app.js', 'a-b/c_d.e', 'mona_acme/dotfiles'].map(isRepository), [true, true, true, true], 'An Enterprise Managed User owns repositories as handle_shortcode.');
  assert.deepEqual(['acme', 'acme/', '/app', 'acme/.', 'acme/..', 'owner/repo/../../user', 'acme/app/x', '_acme/app', 42, null].map(isRepository), [false, false, false, false, false, false, false, false, false, false]);
});

test('a gh api reply parses to its status, tag, headers and body, and a 304 comes back bare', () => {
  const reply = 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\nX-Custom: value\r\n\r\n{"ok":true}';
  assert.deepEqual(parseGitHubResponse(reply), { status: 200, etag: 'W/"abc"', headers: { etag: 'W/"abc"', link: '<https://api.github.com/x?page=2>; rel="next"', 'x-custom': 'value' }, data: { ok: true } });
  assert.equal(parseGitHubResponse('HTTP/2.0 200 OK\nEtag: bad\n\n[]').etag, null, 'An invalid entity tag is null.');
  assert.deepEqual(parseGitHubResponse('HTTP/2.0 304 Not Modified\n\n'), { status: 304 });
  assert.throws(() => parseGitHubResponse('not a response'), /unreadable response. Update gh/);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 200 OK\n\n{oops'), /unreadable response. Try again/);
  class Own extends Error {}
  assert.throws(() => parseGitHubResponse('garbage', message => new Own(message)), Own, 'The caller keeps its own error type.');
  assert.deepEqual(githubGetArgs('repos/acme/app/x', 'W/"1"'), ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'If-None-Match: W/"1"', 'repos/acme/app/x']);
  assert.equal(githubGetArgs('repos/acme/app/x').includes('-H'), true);
  assert.equal(githubGetArgs('repos/acme/app/x').some(arg => arg.startsWith('If-None-Match')), false);
  assert.equal(notModified({ stdout: 'HTTP/2.0 304 Not Modified\n' }, 'W/"1"'), true);
  assert.equal(notModified({ stdout: 'HTTP/2.0 304 Not Modified\n' }, null), false, 'Without a tag, a 304 was not asked for.');
});

test('a failure is classified from its exit and output, which never leave', () => {
  const cases: [unknown, string][] = [
    [{ code: 'ENOENT' }, 'missing'], [{ killed: true }, 'timeout'], [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ stderr: 'API rate limit exceeded' }, 'rate-limit'], [{ stderr: 'gh: Bad credentials (HTTP 401) token gho_secret' }, 'unauthenticated'],
    [{ stderr: 'fatal: could not read Username for https://github.com' }, 'unauthenticated'],
    [{ stderr: 'HTTP 404: Not Found' }, 'not-found'], [{ stderr: "fatal: couldn't find remote ref main" }, 'not-found'],
    [{ stderr: 'HTTP 403: Resource not accessible by integration' }, 'denied'],
    [{ stderr: 'something else' }, 'other'], [null, 'other'],
  ];
  for (const [error, kind] of cases) assert.equal(githubFailureKind(error), kind, JSON.stringify(error));
  assert.match(GITHUB_MESSAGES.unauthenticated, /gh auth login --hostname github\.com/);
});

test('GitHub refusing a push or a request is denied, as git and gh print it', () => {
  const refused = (line: string) => `${line}\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403`;
  for (const [stderr, kind] of [
    [refused('remote: Permission to acme/app.git denied to octocat.'), 'denied'],
    [refused('remote: Write access to repository not granted.'), 'denied'],
    [refused("remote: The 'acme' organization has enabled or enforced SAML SSO."), 'denied'],
    ['GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (createPullRequest)', 'denied'],
    ["fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 401", 'unauthenticated'],
    ["fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 429", 'rate-limit'],
  ]) assert.equal(githubFailureKind(Object.assign(new Error('Command failed: git push'), { stderr })), kind, stderr);
});

test('a name or a local path that holds a refusal word never makes a failure GitHub\'s refusal', () => {
  for (const error of [
    { stderr: "Cloning into '/data/sources/github-1/payment-processor'...\nfatal: unable to access 'https://github.com/acme/payment-processor.git/': Could not resolve host: github.com" },
    { stderr: 'Get "https://api.github.com/repos/acme/lessons/actions/runs?per_page=50": net/http: TLS handshake timeout' },
    { stderr: 'Patch "https://api.github.com/repos/acme/app/branches/feature%2Fsso-login": unexpected EOF' },
    { stderr: 'Get "https://api.github.com/repos/acme/saml-toolkit/branches": unexpected EOF' },
    { stderr: 'error: could not lock config file /Users/rosso/.perpetual/sources/github-1/app/.git/config: Permission denied' },
    // execFile's message repeats the command line; with no output there is no reply to read.
    Object.assign(new Error('Command failed: gh api repos/acme/sso-portal/pulls/7 --method PATCH'), { stderr: '' }),
  ]) assert.equal(githubFailureKind(error), 'other', JSON.stringify(error));
});

test('runGitHub passes gh, the arguments, the environment and the limits to the runner it is given', async () => {
  const calls: unknown[] = [];
  const run = async (file: string, args: string[], options: Record<string, unknown>) => { calls.push([file, args, options.timeout, options.maxBuffer, options.encoding, options.windowsHide, (options.env as NodeJS.ProcessEnv).GH_HOST]); return { stdout: 'ok' }; };
  assert.deepEqual(await runGitHub(['api', 'x'], { run }), { stdout: 'ok' });
  assert.deepEqual(calls, [['gh', ['api', 'x'], 20_000, 4 * 1024 * 1024, 'utf8', true, 'github.com']]);
  await runGitHub(['x'], { run, timeout: 5, maxBuffer: 6 });
  assert.deepEqual((calls[1] as unknown[]).slice(2, 4), [5, 6]);
});

test('the repository pattern, the gh environment and the failure families are written once', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'github-cli.ts');
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\[a-z\\d\]\[a-z\\d_?-\]\{0,38\}/, `${file} spells the repository pattern`);
    assert.doesNotMatch(text, /GH_PROMPT_DISABLED/, `${file} builds a gh environment of its own`);
    assert.doesNotMatch(text, /\/\^\[a-f\\d\]\{40\}\$\/i/, `${file} spells the commit id pattern`);
    assert.doesNotMatch(text, /rate limit\|secondary rate/, `${file} classifies gh failures itself`);
  }
});
