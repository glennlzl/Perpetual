import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

type Workflow = { jobs: Record<string, { if?: string; steps: { if?: string }[] }> };
const SIGN = 'I have read the CLA Document and I hereby sign the CLA';

/** Evaluates the job's condition for one event, reading a missing property as null as GitHub's expressions do. */
function runs(condition: string, github: object): boolean {
  const script = condition.replace(/\bgithub((?:\.\w+)+)/g, (_, path: string) => `github${path.replaceAll('.', '?.')}`);
  return Boolean(new Function('github', `return (${script});`)(github));
}

test('the CLA check runs for a pull request’s own events and its signing comments, never to lock an unmerged one', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/cla.yml', import.meta.url), 'utf8')) as Workflow;
  const { if: condition = 'true', steps } = workflow.jobs.cla;
  assert.ok(steps.every(step => step.if === undefined), 'The job decides whether a runner starts at all.');
  const pull = (action: string, merged = false) => ({ event_name: 'pull_request_target', event: { action, pull_request: { merged } } });
  const comment = (body: string, onPullRequest = true) => ({ event_name: 'issue_comment', event: { action: 'created', comment: { body }, issue: onPullRequest ? { pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/1' } } : {} } });
  for (const event of [pull('opened'), pull('synchronize'), pull('closed', true), comment('recheck'), comment(SIGN)]) assert.equal(runs(condition, event), true, JSON.stringify(event));
  // The action locks the conversation on every close, so an unmerged pull request would lose its thread.
  for (const event of [pull('closed'), comment('Looks good'), comment('recheck', false), comment(SIGN, false)]) assert.equal(runs(condition, event), false, JSON.stringify(event));
});
