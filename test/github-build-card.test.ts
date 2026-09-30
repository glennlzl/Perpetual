import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the real card and shadcn controls without starting a dev server or a browser.
const client = new URL('../client/src/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    const candidate = specifier.startsWith('@/') ? new URL(specifier.slice(2), client)
      : specifier.startsWith('.') && context.parentURL?.startsWith(client.href) ? new URL(specifier, context.parentURL) : null;
    if (candidate) for (const suffix of ['', '.ts', '.tsx']) {
      const path = fileURLToPath(candidate) + suffix;
      if (existsSync(path)) return next(pathToFileURL(path).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(client.href) && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } }).code };
    return next(url, context);
  },
});
const { default: Card } = await import(new URL('../client/src/GitHubActionsCard.tsx', import.meta.url).href);
const { useRememberedOpen } = await import(new URL('../client/src/lib/remembered-open.ts', import.meta.url).href);
function Expanded({ name }: { name: string }) { const [open, setOpen] = useRememberedOpen(name); if (!open) setOpen(true); return null; }
const repoPath = '/acme/app', A = 'a'.repeat(40), B = 'b'.repeat(40), file = '.github/workflows/ci.yml';
const base = `github-actions:${repoPath}`;
for (const name of [base, `${base}:${file}`, `${base}:${B}:${file}:20:101`, `${base}:${B}:${file}:20:102`]) renderToStaticMarkup(createElement(Expanded, { name }));
const run = { id: '20', workflowId: '7', name: 'CI', path: file, sha: B, branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', attempt: 1,
  url: 'https://github.com/acme/app/actions/runs/20', createdAt: null, startedAt: null, updatedAt: null,
  jobs: [
    { id: '101', name: 'Tests (1/2)', status: 'completed', conclusion: 'success', url: null, startedAt: null, completedAt: null, steps: [{ number: 1, name: 'Unit shard one', status: 'completed', conclusion: 'success' }] },
    { id: '102', name: 'Tests (2/2)', status: 'completed', conclusion: 'failure', url: null, startedAt: null, completedAt: null, steps: [{ number: 1, name: 'Unit shard two', status: 'completed', conclusion: 'failure' }] },
  ] };
const runs = { repoPath, repository: 'acme/app', scannedSha: A, sha: B, branch: 'main', source: 'watched', runs: [run] };

test('actual Build card renders separate observed matrix jobs and their own step verdicts before old configuration loads', () => {
  const html = renderToStaticMarkup(createElement(Card, { repoPath, scannedSha: A, scannedAt: 'old-scan', runs }));
  assert.match(html, /aria-label="Workflow: CI, Failed"/);
  assert.match(html, /aria-label="Job: Tests \(1\/2\), Passed"/);
  assert.match(html, /aria-label="Job: Tests \(2\/2\), Failed"/);
  assert.match(html, /Unit shard one<span class="sr-only">, Passed<\/span>/);
  assert.match(html, /Unit shard two<span class="sr-only">, Failed<\/span>/);
  assert.doesNotMatch(html, /Loading actions|matrix\.shard|Old step/);
});

test('unavailable job evidence is explicit and read errors contain no stale success rail', () => {
  const unavailable = renderToStaticMarkup(createElement(Card, { repoPath, scannedSha: A, runs: { ...runs, runs: [{ ...run, jobs: null }] } }));
  assert.match(unavailable, /Job details unavailable/);
  assert.match(unavailable, /href="https:\/\/github.com\/acme\/app\/actions\/runs\/20"/);
  assert.doesNotMatch(unavailable, /No jobs reported|Job: Tests/);
  const failed = renderToStaticMarkup(createElement(Card, { repoPath, scannedSha: A, runs: null, readError: 'Reconnect GitHub.' }));
  assert.match(failed, /role="alert"[^>]*>Reconnect GitHub\./);
  assert.doesNotMatch(failed, /Passed|Workflow: CI|Loading actions/);
});
