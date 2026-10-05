import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'node:http';
import { startServer, type Controller, type ServerOptions } from '../src/server.ts';
import { DISCOVERY_VERSION } from '../src/scanner.ts';
import type { GitHubSession } from '../src/github-source.ts';

const SIGNED_IN = (login: string): GitHubSession => ({ available: true, authenticated: true, account: { login, name: null } });
const NO_SIGN_IN = { isPending: () => false, dispose() {}, start(): never { throw new Error('unused'); }, status(): never { throw new Error('unused'); }, cancel(): never { throw new Error('unused'); } };

/** A controller over a scanned acme/app checkout with a Beta stage; GitHub is the seams given, so no gh runs. */
async function scanned(t: TestContext, { github = {}, state = {} }: { github?: ServerOptions['github']; state?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-scanned-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'app', sha: 'a'.repeat(40), branch: 'main', remote: 'https://github.com/acme/app.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-23T10:00:00.000Z' };
  const stages = [['source', 'Source'], ['build', 'Build'], ['beta', 'Beta'], ['production', 'Production']].map(([id, name]) => ({ id, name, kind: id === 'beta' ? 'sandbox' : id, collapsed: false }));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan, providers: [], pipelines: { [dir]: { repoPath: dir, stages } }, ...state } }));
  const app = await startServer({ port: 0, repo: dir, dataDir, github: { auth: NO_SIGN_IN, ...github } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  return { dir, dataDir, app, token };
}

test('controller state refuses a linked snapshot and releases ownership after refusing it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-linked-state-')), dataDir = join(dir, 'data');
  let app: Controller | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(dataDir);
  const content = JSON.stringify({ schema: 1, state: { scan: null, providers: [], pipelines: {} } });
  await writeFile(join(dir, 'outside.json'), content);
  await symlink(join(dir, 'outside.json'), join(dataDir, 'state.json'));
  await assert.rejects(async () => { app = await startServer({ port: 0, repo: dir, dataDir }); }, /Cannot load saved state/);
  assert.equal(await readFile(join(dir, 'outside.json'), 'utf8'), content);
  await rm(join(dataDir, 'state.json'));
  app = await startServer({ port: 0, repo: dir, dataDir });
  assert.equal((await fetch(app.url + '/api/state')).status, 200);
});

test('controller state keeps an existing data directory private', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-private-state-')), dataDir = join(dir, 'data');
  let app: Controller | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(dataDir); await chmod(dataDir, 0o755);
  app = await startServer({ port: 0, repo: dir, dataDir });
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
});

test('a data directory inside a repository is ignored by it, and a person\'s own ignore file is kept', async t => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-ignored-data-')), dataDir = join(dir, '.perpetual');
  let app: Controller | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);
  await git('init', '-q');
  app = await startServer({ port: 0, repo: dir, dataDir });
  await writeFile(join(dataDir, 'browser-model.json'), '{}');
  assert.equal(await readFile(join(dataDir, '.gitignore'), 'utf8'), '*\n');
  assert.equal((await git('status', '--porcelain', '--untracked-files=all')).stdout, '', 'Nothing in the data directory is offered to the repository.');
  await app.close();
  await writeFile(join(dataDir, '.gitignore'), 'state.json\n');
  app = await startServer({ port: 0, repo: dir, dataDir });
  assert.equal(await readFile(join(dataDir, '.gitignore'), 'utf8'), 'state.json\n');
});

test('GitHub is never read with the ambient CLI session: no provider route, and older observations are dropped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-providers-')), dataDir = join(dir, 'data');
  let app: Controller | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(dataDir);
  const providers = [{ provider: 'GitHub', status: 'connected', detail: 'acme/app', runs: [] }];
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state: { scan: null, providers, pipelines: {}, githubConnection: null } }));
  app = await startServer({ port: 0, repo: dir, dataDir });
  assert.deepEqual((await (await fetch(app.url + '/api/state')).json()).providers, []);
  assert.equal((await fetch(app.url + '/api/providers')).status, 404);
});

test('controller state refuses an oversized JSON snapshot without overwriting it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-large-state-')), dataDir = join(dir, 'data');
  let app: Controller | undefined;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(dataDir);
  const snapshot = JSON.stringify({ schema: 1, state: { scan: null, providers: [], pipelines: {} } });
  const content = snapshot + ' '.repeat(32 * 1024 * 1024);
  await writeFile(join(dataDir, 'state.json'), content);
  await assert.rejects(async () => { app = await startServer({ port: 0, repo: dir, dataDir }); }, /Cannot load saved state/);
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), content);
  await writeFile(join(dataDir, 'state.json'), snapshot);
  app = await startServer({ port: 0, repo: dir, dataDir });
  assert.equal((await fetch(app.url + '/api/state')).status, 200);
});

test('saving controller state does not follow a pre-existing temporary-file alias', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-state-write-')), dataDir = join(dir, 'data');
  const app = await startServer({ port: 0, repo: dir, dataDir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const outside = join(dir, 'untouched.txt');
  await writeFile(outside, 'keep this content');
  await symlink(outside, join(dataDir, 'state.json.tmp'));
  const { token } = await (await fetch(app.url + '/api/session')).json();
  const response = await fetch(app.url + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Perpetual-Token': token }, body: JSON.stringify({ path: dir }) });
  assert.equal(response.status, 200);
  assert.equal(await readFile(outside, 'utf8'), 'keep this content');
});

test('preview CSP binds runtime styles to a fresh response nonce while keeping scripts and style attributes restricted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-csp-'));
  const app=await startServer({port:0,repo:dir,dataDir:join(dir,'data')});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const response=await fetch(app.url);
  assert.equal(response.status,200);
  const policy=response.headers.get('content-security-policy')!;
  const directives=Object.fromEntries(policy.split(';').map(part=>part.trim().split(/\s+/)).filter(parts=>parts[0]).map(([name,...values])=>[name,values]));
  const html=await response.text();
  const nonce=html.match(/<meta name="style-nonce" content="([A-Za-z0-9+/=]+)"\s*\/>/)?.[1];
  assert.ok(nonce,'The page must supply its runtime style nonce');
  assert.ok(Buffer.from(nonce,'base64').length>=16,'The nonce must contain sufficient random bytes');
  assert.deepEqual(directives['style-src-elem'],["'self'",`'nonce-${nonce}'`,"'sha256-UjmwW5hqkbmZat2z0a4MIudqMdHHunQ57o+t2nldQPQ='"]);
  assert.deepEqual(directives['style-src'],["'self'"]);
  assert.deepEqual(directives['style-src-attr'],["'none'"]);
  assert.deepEqual(directives['script-src'],["'self'"]);
  assert.deepEqual(directives['default-src'],["'self'"]);
  assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.doesNotMatch(html,/__PERPETUAL_STYLE_NONCE__/);
  assert.doesNotMatch(html,/<style\b|\sstyle\s*=/i);
  const stylesheets=[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match=>match[1]);
  assert.ok(stylesheets.length>0,'The built page must load a stylesheet');
  for(const href of stylesheets) {
    assert.match(href,/^\/build\/assets\/[A-Za-z0-9_-]+\.css$/);
    const stylesheet=await fetch(new URL(href,app.url));
    assert.equal(stylesheet.status,200);
    assert.match(stylesheet.headers.get('content-type')!,/^text\/css/);
    assert.ok((await stylesheet.text()).length>0);
  }
  const secondResponse=await fetch(app.url);
  const secondHtml=await secondResponse.text();
  const secondNonce=secondHtml.match(/<meta name="style-nonce" content="([A-Za-z0-9+/=]+)"\s*\/>/)?.[1];
  assert.ok(secondNonce);
  assert.notEqual(secondNonce,nonce,'A later response must not reuse the prior nonce');
  assert.ok(secondResponse.headers.get('content-security-policy')!.includes(`'nonce-${secondNonce}'`));
});

test('a rebuild while the server runs serves the new hashed assets without a restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-assets-')),publicDir=join(dir,'public'),assets=join(publicDir,'build/assets');
  await mkdir(assets,{recursive:true});
  await writeFile(join(publicDir,'build/index.html'),'<script type="module" src="/build/assets/index-old.js"></script>');
  await writeFile(join(assets,'index-old.js'),'old');
  const app=await startServer({port:0,repo:dir,dataDir:join(dir,'data'),publicDir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  assert.equal((await fetch(`${app.url}/build/assets/index-old.js`)).status,200);
  await writeFile(join(assets,'index-new.js'),'new');
  await writeFile(join(publicDir,'build/index.html'),'<script type="module" src="/build/assets/index-new.js"></script>');
  const rebuilt=await fetch(`${app.url}/build/assets/index-new.js`);
  assert.equal(rebuilt.status,200);
  assert.match(rebuilt.headers.get('content-type')!,/^text\/javascript/);
  assert.equal(await rebuilt.text(),'new');
  for(const name of ['secret.txt','.env','index-new.js.map']) {
    await writeFile(join(assets,name),'secret');
    assert.equal((await fetch(`${app.url}/build/assets/${name}`)).status,404,`Rescans still serve only generated asset names (${name})`);
  }
  assert.equal((await fetch(`${app.url}/build/assets/missing.js`)).status,404);
  await rm(join(assets,'index-old.js'));
  const removed=await fetch(`${app.url}/build/assets/index-old.js`);
  assert.equal(removed.status,404,'An asset removed by a rebuild is not found rather than a server error');
  assert.doesNotMatch(await removed.text(),/public/);
});

test('API requires same-origin session for mutations, scans real fixture and persists state',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-server-'));let restarted: Controller|undefined;
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'server-fixture',scripts:{build:'node build.mjs'}}));
  const app=await startServer({port:0,repo:dir,dataDir:join(dir,'data')});t.after(async()=>{try{await restarted?.close();await app.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const url=app.url;
  const session=await (await fetch(`${url}/api/session`)).json();
  const malformedStatus=await new Promise((resolve,reject)=>{const req=request(`${url}`,{path:'//[',headers:{Host:new URL(url).host}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(malformedStatus,400);
  assert.equal((await fetch(`${url}/api/scan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:dir})})).status,403);
  assert.equal((await fetch(`${url}/api/state`,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`${url}/api/scan`,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':session.token},body:JSON.stringify({path:dir})})).status,200);
  const state=await (await fetch(`${url}/api/state`)).json();assert.equal(state.scan.repo.name,'server-fixture');
  const savedState=await readFile(join(dir,'data/state.json'));
  await rm(join(dir,'data/state.json'));await mkdir(join(dir,'data/state.json'));
  const rescan=()=>fetch(`${url}/api/scan`,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':session.token},body:JSON.stringify({path:dir})});
  assert.equal((await rescan()).status,400);
  await rm(join(dir,'data/state.json'),{recursive:true});await writeFile(join(dir,'data/state.json'),savedState);
  assert.equal((await rescan()).status,200,'Persistence recovers after a transient filesystem failure');
  await app.close();
  restarted=await startServer({port:0,repo:dir,dataDir:join(dir,'data')});
  const saved=await (await fetch(`${restarted.url}/api/state`)).json();assert.equal(saved.scan.repo.name,'server-fixture');
});

test('configuration edit links need the branch on GitHub, and the original checkout stays reachable read-only',async t=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const dir=await mkdtemp(join(tmpdir(),'perpetual-links-')),repo=join(dir,'repo'),bin=join(dir,'bin'),path=process.env.PATH;
  await mkdir(repo);await mkdir(bin);
  const git=(...args: string[])=>promisify(execFile)('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Perpetual','-c','user.email=perpetual@example.com','-C',repo,...args]);
  await writeFile(join(repo,'package.json'),JSON.stringify({name:'links-fixture'}));
  await git('init','-q','-b','feature/local');
  await git('remote','add','origin','https://github.com/acme/widgets.git');
  await git('add','package.json');await git('commit','-q','-m','fixture');
  // A signed-out gh stub keeps the connection read offline.
  await writeFile(join(bin,'gh'),'#!/bin/sh\necho "not logged in" >&2\nexit 1\n',{mode:0o755});
  process.env.PATH=`${bin}:${path}`;
  let app: Controller|undefined;
  t.after(async()=>{process.env.PATH=path;try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}});
  app=await startServer({port:0,repo,dataDir:join(dir,'data')});
  const session=await (await fetch(`${app.url}/api/session`)).json();
  assert.equal((await fetch(`${app.url}/api/scan`,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':session.token},body:JSON.stringify({path:repo})})).status,200);
  const files=async()=>{
    const response=await fetch(`${app.url}/api/service-config?${new URLSearchParams({repoPath:repo,nodeId:'repository'})}`);
    assert.equal(response.status,200);
    return (await response.json()).files;
  };
  assert.deepEqual(await files(),[{path:'package.json',local:true}],'A branch only in the local checkout gets no GitHub edit link');
  await git('update-ref','refs/remotes/origin/feature/local','HEAD');
  assert.deepEqual(await files(),[{path:'package.json',editUrl:'https://github.com/acme/widgets/edit/feature%2Flocal/package.json'}]);
  const head=(await git('rev-parse','HEAD')).stdout;
  const connection=await (await fetch(`${app.url}/api/github/connection`)).json();
  assert.equal(connection.connected,false);
  assert.deepEqual(connection.localCheckout,{path:repo,branch:'feature/local'});
  await git('checkout','-q','--detach');
  assert.deepEqual((await (await fetch(`${app.url}/api/github/connection`)).json()).localCheckout,{path:repo,branch:null});
  assert.equal((await git('rev-parse','HEAD')).stdout,head,'Reading the original checkout never moves it');
});

test('closing the controller ends a polling page\'s connection with 503, so shutdown finishes', async t => {
  const asked = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>();
  const f = await scanned(t, { github: { runs: {
    async session() { asked.resolve(); await answer.promise; return SIGNED_IN('developer'); },
    async read(input) { return { repository: String(input.repository), sha: String(input.sha), runs: [] }; },
  } } });
  // One kept-alive connection, as a polling page holds one.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const get = (path: string) => new Promise<{ status: number; connection?: string }>((resolve, reject) => {
    const req = request(f.app.url + path, { agent }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, connection: res.headers.connection })); });
    req.on('error', reject); req.end();
  });
  const inFlight = get(`/api/github/runs?${new URLSearchParams({ repoPath: f.dir })}`);
  await asked.promise;
  let closed = false;
  const closing = f.app.close().then(() => { closed = true; });
  answer.resolve();
  assert.equal((await inFlight).status, 200, 'A request in flight at shutdown still gets its reply.');
  const polls: { status: number; connection?: string }[] = [];
  for (const deadline = Date.now() + 10_000; !closed && Date.now() < deadline;) {
    // A refused connection is the controller gone.
    polls.push(await get('/api/state').catch(() => ({ status: 0 })));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(closed, true, `Shutdown finished while the page polled: ${JSON.stringify(polls)}`);
  await closing;
  for (const poll of polls) assert.ok(poll.status === 0 || poll.status === 503 && poll.connection === 'close', JSON.stringify(poll));
});
