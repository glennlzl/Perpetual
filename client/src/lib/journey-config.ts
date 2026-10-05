import type { BrowserCase } from './browser-test-ui.ts';
import type { ScanNode } from '../../../contract/scanner.ts';
import { localBrowserHost } from '../../../src/browser/local-host.ts';

export const MAX_CASES = 60;
// The controller keeps at most MAX_CASES and discovery returns up to four journeys.
export const MAX_DISCOVERED = 4;
export const DEFAULT_JOURNEY_TIMEOUT = 900;
// The URL constructor reads its argument as a string.
const parse = (value: unknown) => { try { return new URL(String(value)); } catch { return null; } };
export const validUrl = (value: unknown) => ['http:', 'https:'].includes(parse(value)?.protocol ?? '');
export const sameUrl = (left: unknown, right: unknown) => validUrl(left) && validUrl(right) && parse(left)!.href === parse(right)!.href;

const VERCEL_ALIAS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i;
const BRANCH = /^[\w./-]{1,255}$/;
// Only literal branch names reported by the scan or the sandbox record; nothing is inferred from a URL.
const branchesOf = (values: unknown) => [...new Set((Array.isArray(values) ? values : [values]).filter((value): value is string => typeof value === 'string' && BRANCH.test(value)))];
/** A scanned node's fields that can name a preview; each is checked before use. */
export type PreviewNode = Partial<Pick<ScanNode, 'provider'>> & { previewAlias?: unknown; label?: unknown; projectName?: unknown; deployBranches?: unknown };
/** A scanned preview URL and, when the scan reports them, the branches it deploys. */
export interface PreviewTarget { url: string; label: string; branches?: string[] }
// Scanned Vercel preview aliases are real application URLs; account access stays unverified.
export function previewTargets(scan: { nodes?: (PreviewNode | null)[] } | null | undefined): PreviewTarget[] {
  return (Array.isArray(scan?.nodes) ? scan.nodes : [])
    .filter((node): node is PreviewNode & { previewAlias: string } => node?.provider === 'Vercel' && typeof node.previewAlias === 'string' && VERCEL_ALIAS.test(node.previewAlias))
    .map(node => {
      const branches = branchesOf(node.deployBranches);
      return { url: `https://${node.previewAlias.toLowerCase()}`, label: String(node.label || node.projectName || node.previewAlias), ...(branches.length ? { branches } : {}) };
    });
}
// The one wording for a URL that deploys another branch than the scanned one.
export const branchMismatchNote = (branches: string[], scanned: string) => `Deploys ${branches.join(', ')}, not ${scanned}`;
// Target suggestions come only from a ready sandbox's apps and services and scanned previews; nothing is guessed.
// Sandbox URLs lead; within each group a URL deploying another branch than the scanned one follows.
/** A known URL to test: a ready sandbox's app or service, or a scanned preview, flagged when it deploys another branch. */
export interface TargetSuggestion { url: string; label: string; branches: string[]; mismatch: boolean; scannedBranch?: string }
/** The sandbox fields suggestions read. */
export interface SuggestionEnvironment { status?: string; sourceBranch?: string | null; apps?: ({ id?: string; url?: string } | null)[]; services?: ({ id?: string; name?: string; url?: string } | null)[] }
export function targetSuggestions({ environment, previews = [], branch = '' }: { environment?: SuggestionEnvironment | null; previews?: PreviewTarget[]; branch?: string } = {}): TargetSuggestion[] {
  const ready = environment?.status === 'ready';
  // A twin's apps carry its URLs; a sandbox's services may too.
  const apps = ready && Array.isArray(environment.apps) ? environment.apps : [];
  const services = ready && Array.isArray(environment.services) ? environment.services : [];
  const tag = (item: { url: string | undefined; label: string }, values: unknown, sandbox: boolean) => {
    const branches = branchesOf(values);
    const mismatch = Boolean(branch && branches.length && !branches.includes(branch));
    return { ...item, branches, mismatch, ...(mismatch ? { scannedBranch: branch } : {}), sandbox };
  };
  const items = [...apps.map(app => tag({ url: app?.url, label: String(app?.id || 'App') }, environment?.sourceBranch, true)),
    ...services.map(service => tag({ url: service?.url, label: String(service?.name || service?.id || 'Sandbox') }, environment?.sourceBranch, true)), ...previews.map(preview => tag(preview, preview?.branches, false))];
  const seen = new Set();
  return items.filter((item): item is typeof item & { url: string } => {
    if (!validUrl(item?.url)) return false;
    const key = parse(item.url)!.href;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.sandbox) - Number(a.item.sandbox) || Number(a.item.mismatch) - Number(b.item.mismatch) || a.index - b.index)
    .slice(0, 8).map(({ item: { sandbox: _sandbox, ...item } }) => item);
}

// Regeneration offers to replace only step-less legacy cases and unreviewed drafts.
export const replaceableCase = (item: Pick<BrowserCase, 'needsReview' | 'steps'>) => Boolean(item.needsReview) || !item.steps?.length;
export const defaultReplaceIds = (cases: Pick<BrowserCase, 'id' | 'needsReview' | 'steps'>[]) => cases.filter(replaceableCase).map(item => item.id);
export const generateRoom = (total: number, replacing: number) => MAX_CASES - total + replacing;
// Generate needs room for a full discovery result, or the controller would drop journeys silently.
export function generateError(total: number, replacing: number) {
  const missing = MAX_DISCOVERED - generateRoom(total, replacing);
  return missing > 0 ? `Select ${missing} more ${missing === 1 ? 'test' : 'tests'} to replace.` : '';
}
export const journeyTimeoutMinutes = (config: { journeyTimeoutSeconds?: number }) => String(Number(((config.journeyTimeoutSeconds ?? DEFAULT_JOURNEY_TIMEOUT) / 60).toFixed(2)));

function originError(value: string) {
  const url = parse(value);
  if (!url) return 'Enter an HTTPS origin.';
  // Match the application target's local hosts; the controller also refuses its own port and internal addresses.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localBrowserHost(url.hostname))) return 'Use HTTPS.';
  if (url.username || url.password) return 'Remove the credentials.';
  return url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value) ? 'Remove the path and query.' : '';
}
const authHost = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(hostname) ? '127.0.0.1' : hostname;
function endpointError(value: string, target: URL | null) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? parse(value) : null;
  if (!url) return 'Enter an absolute URL.';
  if (!['http:', 'https:'].includes(url.protocol)) return 'Use HTTP or HTTPS.';
  if (url.username || url.password) return 'Remove the credentials.';
  if (!target || authHost(url.hostname) !== authHost(target.hostname)) return 'Use the target host.';
  if (url.search || url.hash || /[?#]/.test(value)) return 'Remove the query.';
  // Discovery allows any POST that starts with this URL, so it must not cover an origin or the target page's parents.
  const sameOrigin = url.protocol === target.protocol && url.port === target.port && authHost(url.hostname) === authHost(target.hostname);
  const covers = sameOrigin && target.pathname.startsWith(url.pathname) && (url.pathname.endsWith('/') || url.pathname !== target.pathname);
  return url.pathname === '/' || covers ? 'Use a specific endpoint path.' : '';
}
// The sign-in page is on the target URL's origin, and at most 2048 characters as it is sent, as the controller requires.
function signInError(value: string, target: URL | null) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? parse(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol)) return 'Enter an HTTP or HTTPS URL.';
  if (url.username || url.password) return 'Remove the credentials.';
  if (!target || url.origin !== target.origin) return 'Use the target URL’s origin.';
  return signInHref(url).length > MAX_SIGN_IN ? `Use at most ${MAX_SIGN_IN} characters.` : '';
}
const MAX_SIGN_IN = 2048;
function list(values: string[], check: (value: string) => string, normalize: (value: string) => string, limit: number, noun: 'origin' | 'endpoint') {
  const entries = values.map(value => value.trim()), seen = new Set<string>(), items: string[] = [];
  const errors = entries.map(value => {
    if (!value) return '';
    const error = check(value);
    if (error) return error;
    const normal = normalize(value);
    if (seen.has(normal)) return `Duplicate ${noun}.`;
    seen.add(normal); items.push(normal); return '';
  });
  return { items, errors, list: entries.filter(Boolean).length > limit ? `Use at most ${limit} ${noun === 'origin' ? 'origins' : 'endpoints'}.` : '' };
}

// A sign-in page keeps its hash, as a hash-routed application shows its form only on its route, such as #/login; an
// empty hash is none.
const signInHref = (url: URL) => { if (!url.hash) url.hash = ''; return url.href; };

// Provider origins are run-only navigation targets; discovery stays on the application origin. The sign-in page is
// optional.
export function validateTestSettings({ targetUrl, signInUrl = '', externalOrigins = [], authEndpoints = [], timeoutMinutes }: { targetUrl: string; signInUrl?: string; externalOrigins?: string[]; authEndpoints?: string[]; timeoutMinutes: string | number }) {
  const target = validUrl(targetUrl.trim()) ? parse(targetUrl.trim()) : null;
  const signIn = signInUrl.trim(), signInProblem = signIn ? signInError(signIn, target) : '';
  const signInPage = signIn && !signInProblem ? signInHref(parse(signIn)!) : '';
  // A value is normalized only once its check passed, so it parses.
  const origins = list(externalOrigins, originError, value => parse(value)!.origin, 10, 'origin');
  const endpoints = list(authEndpoints, value => endpointError(value, target), value => parse(value)!.href, 3, 'endpoint');
  const minutes = String(timeoutMinutes).trim() ? Number(timeoutMinutes) : NaN, seconds = Math.round(minutes * 60);
  const errors = { targetUrl: target ? '' : 'Enter an HTTP or HTTPS target URL.', signInUrl: signInProblem, externalOrigins: origins.errors, externalOriginsList: origins.list, authEndpoints: endpoints.errors, authEndpointsList: endpoints.list, timeout: Number.isFinite(seconds) && seconds >= 60 && seconds <= 1800 ? '' : 'Use 1–30 minutes.' };
  const valid = !errors.targetUrl && !errors.signInUrl && !errors.externalOriginsList && !errors.authEndpointsList && !errors.timeout && [...origins.errors, ...endpoints.errors].every(error => !error);
  return { valid, errors, values: { targetUrl: targetUrl.trim(), signInUrl: signInPage, externalOrigins: origins.items, authEndpoints: endpoints.items, journeyTimeoutSeconds: seconds } };
}
