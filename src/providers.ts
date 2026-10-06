import { runGitHub } from './github-cli.ts';
import { parseGitHubRemote } from './github-remote.ts';
import type { Scan } from './scanner.ts';
import { redact } from './redaction.ts';
import type { ProviderRun, ProviderStatus, FailureDiagnosis } from '../contract/providers.ts';
export type { ProviderRun, ProviderStatus, FailureDiagnosis } from '../contract/providers.ts';

// Provider API responses are external data, read as unknown: each list must be a list of objects, or the reply is of
// another shape and throws inside the caller's try/catch, so the provider is not connected; each field is text or null.
const isRecord=(value: unknown): value is Record<string, unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const text=(value: unknown,limit=500)=>typeof value==='string'?value.slice(0,limit):null;
const field=(value: unknown,key: string)=>isRecord(value)?value[key]:undefined;
function records(value: unknown,provider: string): Record<string, unknown>[] {
  if(!Array.isArray(value)||!value.every(isRecord))throw new Error(`${provider} returned an unreadable reply.`);
  return value;
}

// Redaction lives in src/redaction.ts; the name stays exported here for its callers.
export { redact };
export { parseGitHubRemote };
export function normalizeGitHubRuns(runs: unknown,sha: unknown): ProviderRun[] {
  return records(runs,'GitHub').map(r=>{
    if(typeof r.id!=='number'&&typeof r.id!=='string')throw new Error('GitHub returned an unreadable reply.');
    const head=text(r.head_sha);
    return {id:String(r.id),name:text(r.name),status:text(r.status),conclusion:text(r.conclusion),sha:head,url:text(r.html_url),branch:text(r.head_branch),createdAt:text(r.created_at),matchesCommit:!!sha&&head===sha};
  });
}
async function gh(args: string[]) {
  const {stdout}=await runGitHub(args,{maxBuffer:1024*1024});
  return stdout;
}
async function jsonFetch(url: string,options: RequestInit={}): Promise<unknown> {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check credentials and scope.`);
  return response.json();
}
function disconnected(provider: string,detail: string): ProviderStatus {return {provider,status:'not-connected',detail,runs:[]};}

export async function getProviderStatus(scan: Pick<Scan,'repo'>,env: NodeJS.ProcessEnv=process.env): Promise<ProviderStatus[]> {
  const github=async(): Promise<ProviderStatus>=>{
    const repo=parseGitHubRemote(scan?.repo?.remote);
    if(!repo)return disconnected('GitHub','No GitHub remote detected. Create or connect a repository first.');
    try {
      const data: unknown=JSON.parse(await gh(['api',`repos/${repo}/actions/runs?per_page=12`]));
      return {provider:'GitHub',status:'connected',detail:'Read-only live workflow runs. Results from other commits do not verify this checkout.',observedAt:new Date().toISOString(),runs:normalizeGitHubRuns(field(data,'workflow_runs'),scan.repo.sha)};
    } catch {return disconnected('GitHub','Cannot read workflow runs. Check network access and gh auth login, or provide GH_TOKEN with Actions read permission.');}
  };
  const vercel=async(): Promise<ProviderStatus>=>{
    if(!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID)return disconnected('Vercel','Set VERCEL_TOKEN and VERCEL_PROJECT_ID (comma-separated for multiple projects); optional VERCEL_TEAM_ID.');
    try {
      const runs: ProviderRun[]=[];
      for(const project of env.VERCEL_PROJECT_ID.split(',').map(x=>x.trim()).filter(Boolean).slice(0,10)) {
        const params=new URLSearchParams({projectId:project,limit:'5'});if(env.VERCEL_TEAM_ID)params.set('teamId',env.VERCEL_TEAM_ID);
        const data=await jsonFetch(`https://api.vercel.com/v6/deployments?${params}`,{headers:{Authorization:`Bearer ${env.VERCEL_TOKEN}`}});
        for(const d of records(field(data,'deployments'),'Vercel')) {
          const sha=text(field(d.meta,'githubCommitSha')),state=text(d.state),url=text(d.url);
          runs.push({id:text(d.uid),name:text(d.name),status:state,conclusion:state,sha,url:url?`https://${url}`:null,matchesCommit:!!sha&&sha===scan?.repo?.sha});
        }
      }
      return {provider:'Vercel',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. READY is not a business integration result.',runs};
    }catch(e){return disconnected('Vercel',redact((e as Error).message));}
  };
  const railway=async(): Promise<ProviderStatus>=>{
    if(!(env.RAILWAY_API_TOKEN||env.RAILWAY_TOKEN)||!env.RAILWAY_PROJECT_ID||!env.RAILWAY_ENVIRONMENT_ID)return disconnected('Railway','Set RAILWAY_API_TOKEN (account/workspace) or RAILWAY_TOKEN (project token), RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID.');
    try {
      const headers={'Content-Type':'application/json',...(env.RAILWAY_API_TOKEN?{Authorization:`Bearer ${env.RAILWAY_API_TOKEN}`}:{'Project-Access-Token':env.RAILWAY_TOKEN!})};
      const data=await jsonFetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers,body:JSON.stringify({query:'query($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status createdAt meta } } } }',variables:{input:{projectId:env.RAILWAY_PROJECT_ID,environmentId:env.RAILWAY_ENVIRONMENT_ID}}})});
      const errors=field(data,'errors');
      if(errors!==undefined&&errors!==null&&(!Array.isArray(errors)||errors.length))throw new Error('Railway query failed. Check token scope, project and environment.');
      const runs=records(field(field(field(data,'data'),'deployments'),'edges'),'Railway').map(edge=>{
        if(!isRecord(edge.node))throw new Error('Railway returned an unreadable reply.');
        const d=edge.node,sha=text(field(d.meta,'commitHash')),status=text(d.status);
        return {id:text(d.id),name:text(field(d.meta,'serviceName'))||'Railway deployment',status,conclusion:status,sha,createdAt:text(d.createdAt),matchesCommit:!!sha&&sha===scan?.repo?.sha};
      });
      return {provider:'Railway',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. Service reachability and business checks are separate.',runs};
    }catch(e){return disconnected('Railway',redact((e as Error).message));}
  };
  return Promise.all([github(),vercel(),railway()]);
}

export function diagnoseFailure(log: unknown): FailureDiagnosis {
  const text=redact(log);
  const access='Credentials or permissions need attention. Supply them in the provider settings; a source patch cannot grant access.';
  const assertion='An existing test failed. Reproduce this exact test and patch application code without weakening its assertion.';
  // The first rule that matches decides. Credentials and permissions are read with their case and wording, as CI, CLIs
  // and HTTP clients print them, so an application's own compile errors and failed tests about a token, 401, 403 or
  // unauthorized stay code. A dependency or compile error outranks a network error in the same log, since a rerun
  // cannot fix it. An explicit assertion failure also outranks incidental timeout output from other tests;
  // a FAIL header alone may instead describe a refused connection or deadline, which still reruns first.
  const rules: [RegExp,string,string][]=[
    // An environment credential that is not set, such as VERCEL_TOKEN is required.
    [/\b(?:[A-Z][A-Z\d]*_)*(?:TOKEN|API_KEY|SECRET(?:_KEY)?)\b(?: environment variable)?(?: is| was)? (?:required|missing|not set)\b/,'configuration',access],
    // A required action input left empty (a workflow's inputs are not the repair's to change), GITHUB_TOKEN without a
    // permission, a push the token may not make, GitHub refusing a token, git asking for or refusing credentials, gh,
    // curl or a registry answering 401 or 403, and a registry asking for authentication.
    [/Input required and not supplied: |Resource not accessible by (?:integration|personal access token)|\bPermission to \S+ denied to |HttpError\]?: Bad credentials|"message":\s*"Bad credentials"|Authentication failed for '|could not read Username for '|\bHTTP 40[13]\b|returned error: 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|\bcode E40[13]\b|\bENEEDAUTH\b/,'configuration',access],
    [/ERR_PNPM_OUTDATED_LOCKFILE|npm ci.*lock|lockfile.*(?:outdated|mismatch)/i,'dependency','Dependency manifest and lockfile disagree. Regenerate with the pinned package manager, then rerun the original build.'],
    [/error TS\d+|Type error:|Cannot find module/i,'build','Compilation or module resolution failed. Reproduce with the pinned toolchain and workspace root.'],
    [/\b(?:AssertionError(?: \[[^\]\r\n]+\])?|TestingLibraryElementError):/,'test-regression',assertion],
    // Network and deadline errors only: an identifier such as timeout or setTimeout in a type or lint error is code.
    [/\btimed out\b|\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b|socket hang up|i\/o timeout|handshake timeout|could not resolve host|temporary failure in name resolution/i,'availability','A dependency is unavailable or exceeded its deadline. Check the upstream service and target URL before changing code.'],
    [/AssertionError|TestingLibraryElementError|FAIL\s|expected .*received/i,'test-regression',assertion],
  ];
  // An assertion's own lines, such as expected '401 Unauthorized' to equal '200 OK', Jest's Expected: "403 Forbidden" or
  // Received string:, and node:test's expected: '401 Unauthorized', tell what the application answered, never which
  // credentials the run had.
  const facts=text.split('\n').filter(line=>!/\b(?:AssertionError(?: \[[^\]\r\n]+\])?|TestingLibraryElementError):|^\s*(?:expected|received|actual)(?: [a-z]+)?:/i.test(line)).join('\n');
  const rule=rules.find(([pattern,category])=>pattern.test(category==='configuration'?facts:text));
  return {method:'rule-based',category:rule?.[1]||'unknown',summary:rule?.[2]||'Inspect the failed step and reproduce its unchanged command before changing code.'};
}
