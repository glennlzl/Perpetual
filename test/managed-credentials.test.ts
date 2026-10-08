import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialManager, type CredentialAuthority, type CredentialContext } from '../src/authorization/manager.ts';
import { createVercelAuthorization, type VercelTokens } from '../src/authorization/vercel.ts';
import type { CredentialBinding } from '../src/repair/credentials.ts';
import { redact } from '../src/redaction.ts';
import { runGitHub } from '../src/github-cli.ts';
import { credentialReferences } from '../src/repair/recovery.ts';
const callback='http://127.0.0.1:4317/authorization/vercel/callback';
const context: CredentialContext={key:'pipeline:one',repository:'acme/app',login:'developer',runs:[{id:'12',attempt:1,name:'Preview',url:'https://github.com/acme/app/actions/runs/12',workflow:'.github/workflows/preview.yml',observedAt:'2026-10-07T00:00:00Z',secrets:['DEPLOY_ACCESS'],vercelSecret:'DEPLOY_ACCESS',environment:null,binding:'references',settingsUrl:'https://github.com/acme/app/settings/secrets/actions'}]};
async function fixture(t: TestContext) {
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-credentials-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let now=Date.parse('2026-10-07T00:00:00Z'),account:CredentialAuthority|null=context,refreshes=0,writes=0,exchanges=0,failWrite=false,failRefresh=false;
  let binding:CredentialBinding={runId:'12',name:'DEPLOY_ACCESS',environment:null,scope:'repository',updatedAt:new Date(now).toISOString()};
  const tokens=():VercelTokens=>({access:`vca_${String(exchanges+refreshes).padStart(30,'x')}`,refresh:`vcr_${String(exchanges+refreshes).padStart(30,'y')}`,expiresAt:now+3600_000});
  const options={dataDir,clientId:'cl_perpetual',clock:()=>now,authority:async()=>account,
    metadata:async()=>({revision:'a'.repeat(64),bindings:[{...binding}]}),
    provider:{url:({state,verifier}:{state:string;verifier:string;callback:string})=>`https://vercel.com/oauth/authorize?state=${state}&code_challenge=${verifier}`,exchange:async()=>{exchanges++;return tokens();},refresh:async()=>{refreshes++;if(failRefresh)throw new Error('private provider details');return tokens();},identity:async()=>({id:'user_one',name:'Developer'})},
    write:async(input:{repository:string;name:string;environment:string|null},value:string)=>{writes++;assert.equal(input.repository,'acme/app');assert.equal(input.name,'DEPLOY_ACCESS');assert.match(value,/^vca_/);if(failWrite)throw new Error(value);binding.updatedAt=new Date(now+1000*writes).toISOString();},
  };
  let manager=await createCredentialManager(options);t.after(()=>manager.close());
  async function connect(){const url=new URL(await manager.begin(context,callback));await manager.complete({state:url.searchParams.get('state')!,code:'issuer-code',callback});}
  return {get manager(){return manager},connect,options,dataDir,get counts(){return {refreshes,writes,exchanges}},advance:(ms:number)=>{now+=ms},authority:(value:CredentialAuthority|null)=>{account=value},metadata:(value:Partial<CredentialBinding>)=>{binding={...binding,...value}},failWrite:()=>{failWrite=true},failRefresh:()=>{failRefresh=true},restart:async()=>{await manager.close();manager=await createCredentialManager(options)}};
}

test('one authorization enables private renewal and CI synchronization without further UI actions',async t=>{
  const f=await fixture(t);await f.connect();assert.deepEqual(f.counts,{refreshes:0,writes:1,exchanges:1});
  assert.equal(f.manager.view(context)?.status,'ready');
  assert.equal(JSON.stringify(f.manager.view(context)).includes('vca_'),false);
  f.advance(46*60_000);await Promise.all([f.manager.check(),f.manager.check()]);
  assert.deepEqual(f.counts,{refreshes:1,writes:2,exchanges:1});
  await f.restart();await f.manager.check();assert.deepEqual(f.counts,{refreshes:1,writes:2,exchanges:1});
  assert.equal((await stat(join(f.dataDir,'credentials','state.json'))).mode&0o777,0o600);
});

test('revoked grants and uncertain writes never loop or replay after restart',async t=>{
  for(const kind of ['refresh','write'])await t.test(kind,async t=>{
    const f=await fixture(t);
    if(kind==='write')f.failWrite();
    await f.connect();
    if(kind==='refresh'){f.failRefresh();f.advance(46*60_000);await f.manager.check();}
    const before=f.counts;assert.equal(f.manager.view(context)?.status,kind==='write'?'held':'reconnect');
    await f.restart();await f.manager.check();await f.manager.check();assert.deepEqual(f.counts,before);
  });
});

test('a crash during token exchange, renewal or secret write requires reconnection, never replay',async t=>{
  for(const status of ['refreshing','writing'])await t.test(status,async t=>{
    const f=await fixture(t);await f.connect();await f.manager.close();
    const path=join(f.dataDir,'credentials','state.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.bindings[0].status=status;await writeFile(path,JSON.stringify(saved));
    await f.restart();f.advance(60*60_000);await f.manager.check();assert.deepEqual(f.counts,{refreshes:0,writes:1,exchanges:1});assert.notEqual(f.manager.view(context)?.status,'ready');
  });
});

test('changed account, Project, environment shadow and external secret changes prevent credential writes',async t=>{
  for(const kind of ['account','project','shadow','external'])await t.test(kind,async t=>{
    const f=await fixture(t);await f.connect();f.advance(46*60_000);
    if(kind==='account')f.authority({...context,login:'someone-else'});
    if(kind==='project')f.authority({...context,key:'pipeline:two'});
    if(kind==='shadow')f.metadata({scope:'environment'});
    if(kind==='external')f.metadata({updatedAt:'2026-10-08T00:00:00Z'});
    await f.manager.check();assert.deepEqual(f.counts,{refreshes:0,writes:1,exchanges:1});
  });
});

test('organization credentials, unknown references and unsafe callbacks cannot receive managed credentials',async t=>{
  const f=await fixture(t);f.metadata({scope:'organization'});await assert.rejects(f.manager.begin(context,callback),/organization/);
  for(const url of ['https://untrusted.example/callback','http://localhost:4317/authorization/vercel/callback',`${callback}?return=other`])await assert.rejects(f.manager.begin(context,url));
  await assert.rejects(f.manager.begin({...context,runs:[{...context.runs[0],vercelSecret:undefined}]},callback));
  assert.deepEqual(f.counts,{refreshes:0,writes:0,exchanges:0});
});

test('OAuth callbacks are single use, bound to the exact redirect and current authorized Project',async t=>{
  const f=await fixture(t),url=new URL(await f.manager.begin(context,callback)),state=url.searchParams.get('state')!;
  for(const input of [{state:'wrong',code:'code',callback},{state,code:'code',callback:callback+'/' }])await assert.rejects(f.manager.complete(input));
  assert.equal(f.counts.exchanges,0);
  await f.manager.complete({state,code:'code',callback});await assert.rejects(f.manager.complete({state,code:'code',callback}));assert.equal(f.counts.exchanges,1);
});

test('provider uses fixed endpoints, PKCE, refresh rotation and bounded validated replies',async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const provider=createVercelAuthorization({id:'cl_test'}, {clock:()=>1000,fetcher:async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json(String(url).endsWith('userinfo')?{sub:'user_one',preferred_username:'Developer'}:{access_token:'vca_'+'a'.repeat(30),refresh_token:'vcr_'+'b'.repeat(30),expires_in:3600,token_type:'Bearer',scope:'openid profile offline_access'});}});
  const url=new URL(provider.url({callback,state:'state',verifier:'verifier'}));assert.equal(url.origin,'https://vercel.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.notEqual(url.searchParams.get('code_challenge'),'verifier');
  const tokens=await provider.exchange({code:'code',verifier:'verifier',callback});await provider.identity(tokens);await provider.refresh(tokens);
  assert.ok(calls.every(call=>call.url.startsWith('https://api.vercel.com/login/oauth/')&&call.init.redirect==='error'));
  assert.equal(new URLSearchParams(String(calls[2].init.body)).get('grant_type'),'refresh_token');
  for(const body of [{access_token:'private',refresh_token:'private'}, {access_token:'vca_'+'a'.repeat(30),refresh_token:'vcr_'+'b'.repeat(30),expires_in:3600,token_type:'Bearer',scope:'openid'}]){
    const bad=createVercelAuthorization({id:'cl_test'},{fetcher:async()=>Response.json(body)});await assert.rejects(bad.refresh(tokens),/renewal/);
  }
});

test('direct provider references are verified and values never enter argv, logs or views',async()=>{
  const yaml='jobs:\n  deploy:\n    steps:\n      - name: Deploy\n        env:\n          VERCEL_TOKEN: ${{ secrets.DEPLOY_ACCESS }}\n        run: vercel deploy\n';
  assert.equal(credentialReferences(yaml,[{id:'1',name:'deploy',conclusion:'failure',failedSteps:['Deploy']}]).vercelSecret,'DEPLOY_ACCESS');
  assert.equal(credentialReferences(yaml.replace('${{ secrets.DEPLOY_ACCESS }}','${{ inputs.token }}'),[{id:'1',name:'deploy',conclusion:'failure',failedSteps:['Deploy']}]).vercelSecret,undefined);
  const token='vca_'+'a'.repeat(30);assert.equal(redact(`request failed ${token}`),'request failed [REDACTED]');
  await runGitHub(['secret','set','DEPLOY_ACCESS','--repo','acme/app'],{input:token,run:async(_file,args,options)=>{assert.equal(args.includes(token),false);assert.equal(options.input,token);return {stdout:''};}});
});

test('integration grant checks the actual installation and never invents a refresh expiry', async () => {
  const { createVercelIntegration } = await import('../src/authorization/vercel.ts');
  const calls: { url: URL; init: RequestInit }[] = [];
  let configuration = { id: 'icfg_one', integrationId: 'oac_app', userId: 'user_one', teamId: 'team_one', ownerId: 'team_one', status: 'ready' };
  const provider = createVercelIntegration({ id: 'oac_app', secret: 'app-confidential-secret', slug: 'acme-recovery' }, { fetcher: async (url, init) => {
    calls.push({ url: new URL(String(url)), init: init! });
    return Response.json(String(url).includes('access_token') ? { token_type: 'Bearer', access_token: 'a'.repeat(30), installation_id: 'icfg_one', user_id: 'user_one', team_id: 'team_one' } : configuration);
  } });
  const url = new URL(provider.url({ callback, state: 'csrf-state', verifier: 'unused' }));
  assert.equal(url.pathname, '/integrations/acme-recovery/new'); assert.equal(url.searchParams.get('state'), 'csrf-state');
  const grant = await provider.exchange({ code: 'one-time-code', callback, verifier: 'unused' });
  assert.equal(grant.expiresAt, undefined); assert.equal(grant.refresh, undefined);
  assert.deepEqual(await provider.identity(grant), { id: 'icfg_one', name: 'team_one' });
  assert.equal(calls[1].url.searchParams.get('teamId'), 'team_one');
  assert.equal(calls[0].url.pathname, '/v2/oauth/access_token');
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('redirect_uri'), callback);
  assert.ok(calls.every(call => call.url.origin === 'https://api.vercel.com' && call.init.redirect === 'error'));
  for (const bad of [{ integrationId: 'oac_other' }, { userId: 'other' }, { teamId: 'team_other' }, { ownerId: 'team_other' }, { status: 'suspended' }]) {
    const original = configuration; configuration = { ...configuration, ...bad };
    await assert.rejects(provider.identity(grant), /unavailable/); configuration = original;
  }
});

test('long-lived installations synchronize once, check health and stop without further writes', async t => {
  const f = await fixture(t); await f.manager.close();
  let checks = 0;
  const provider = { ...f.options.provider,
    exchange: async () => ({ access: 'vca_' + 'g'.repeat(30), installation: { id: 'icfg_one', userId: 'user_one', teamId: null } }),
    identity: async () => { checks++; return { id: 'icfg_one', name: 'Developer' }; },
  };
  const manager = await createCredentialManager({ ...f.options, provider }); t.after(() => manager.close());
  const url = new URL(await manager.begin(context, callback));
  await manager.complete({ state: url.searchParams.get('state')!, code: 'code', callback });
  assert.equal(f.counts.writes, 1); assert.equal(checks, 1);
  await assert.rejects(manager.begin(context, callback), /already managed/);
  f.advance(24 * 3600_000); await manager.check();
  assert.equal(checks, 2); assert.equal(f.counts.writes, 1); assert.equal(f.counts.refreshes, 0);
  await manager.disable(context); f.advance(24 * 3600_000); await manager.check();
  assert.equal(checks, 2); assert.equal(f.counts.writes, 1);
  const saved = await readFile(join(f.dataDir, 'credentials', 'state.json'), 'utf8');
  assert.equal(saved.includes('vca_'), false); assert.equal(manager.view(context)?.status, 'not-connected');
});

test('interrupted code exchange and expired authorization cannot replay or write', async t => {
  for (const status of ['exchanging', 'expired']) await t.test(status, async t => {
    const f = await fixture(t), url = new URL(await f.manager.begin(context, callback));
    await f.manager.close();
    const file = join(f.dataDir, 'credentials', 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (status === 'exchanging') saved.pending[0].status = 'exchanging';
    else f.advance(11 * 60_000);
    await writeFile(file, JSON.stringify(saved)); await f.restart();
    await assert.rejects(f.manager.complete({ state: url.searchParams.get('state')!, code: 'code', callback }));
    assert.deepEqual(f.counts, { refreshes: 0, writes: 0, exchanges: 0 });
    assert.equal(f.manager.view(context)?.status, 'reconnect');
  });
});
