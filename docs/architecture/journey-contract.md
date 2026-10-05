# Journey contract

Status: implemented. The Playwright fixture and reporter (`src/journeys/playwright/`), the Python discovery worker (`integrations/browser-use/`), the Node controller (`src/browser/`) and the client agree on every field below. Nothing here permits simulated pages, fixture success or inferred business outcomes. User-facing behaviour is described in [Business journeys](../journeys.md).

## Journeys and live runs

- A reviewed case is a journey: a goal, prerequisites, ordered business milestones, fixed expected outcomes, independent checks and source evidence. Runtime actions come from the journey's approved Playwright code ([Playwright journeys](playwright-journeys.md)); the browser agent only discovers journeys.
- Discovery proposes up to four coherent journeys from source and observed product behaviour. Regeneration replaces the chosen current cases only after a successful discovery; immutable run snapshots stay available.
- Each journey owns one browser process and keeps its session across milestones. A run holds the environment's reservation until every process has finished cleanup.
- Run concurrency is 1 to 4, default 2. Cases default to shared application data and run exclusively; only a reviewed case that declares independent test data can overlap other such cases. Browser profile isolation does not isolate account balances or application data.
- A queued journey can be skipped without launching. An active journey enters `skipping`, cancels its process and becomes `skipped` after cleanup. Skip never rewinds side effects or becomes success. Uncertain cleanup quarantines the owned environment.
- Frames are scoped by source, stage, run and case. Milestone events carry the evidence of their reviewed checks. Real activity drives all motion in the interface, which respects reduced-motion preferences, and no preview footage is invented.

## Case and milestone shape

```
case.steps: [{ id, title, checks?: MilestoneCheck[] }]   // 2–12 for new or edited reviewed cases
MilestoneCheck =
  | { type: 'url-contains' | 'text-visible' | 'text-absent', value }        // 1–4000 chars
  | { type: 'read-number', label, name }                                   // capture
  | { type: 'compare-number', label, name, op: '<'|'>'|'='|'!=', than }     // compare with an earlier capture
```

- `label`: 1–120 characters of visible text next to the number, such as `Credits`. `name` and `than`: `/^[a-z][A-Za-z0-9]{0,39}$/`.
- A step has at most 6 checks. `than` must name a `read-number` in an earlier step or earlier in the same step.
- A text check's `value` or a number check's `label` may name the run's token as `{run}` ([Run-unique values](../journeys.md#run-unique-values)).
- Step ids are stable. Editors keep existing ids by title match and mint unused ids for new lines.
- Cases from before milestones (`steps: []`) stay readable. A case saved as reviewed (`needsReview: false`) needs 2–12 steps unless it is identical to a stored earlier case. Journey code calls one milestone per step, and code generation needs steps.
- `isolation` is `shared` (default) or `isolated`.

## Independent milestone checks

- The fixture evaluates a step's checks itself, on the live page, after the step's actions, each waiting up to 10 seconds for its condition. The checks come from the approved case snapshot; journey code contains none and never supplies an observed value.
- `text-absent`, `read-number` and `compare-number` also hold on a page whose data has not arrived yet, which a new document, a route change within one or a refetch can still be bringing. Once one holds, the page is observed again after none of its requests has been in flight for half a second, and only that observation passes it, or the one at the 10-second limit for a page that never goes quiet.
- Before judging the page, the fixture replaces every `{run}` in a check with the run's token. Under [check version](../journeys.md#check-version) 2, `text-visible` also reads visible text fields, text areas and selects the application filled, never a password field or a field the journey edited on the current page, nor visible text inside an editable region (`contenteditable`) the journey edited there; `text-absent` passes exactly when `text-visible` would fail.
- `read-number` finds visible elements whose own text contains `label`, walks up at most 3 ancestors, and parses the first number after the label. Where the page shows the label on its own, not within a longer word (`Total`, not the end of `Subtotal`), that occurrence is read; a label found only within longer words, as in scripts that write words without spaces, is read where it first occurs. Since an ancestor's text includes its siblings, only separators (no letters or digits) may sit between the label and the number. It accepts `1,240`, `1240.5`, `-3` and `$12.00`, and fails if it finds no number, or a number that another format continues, such as `1.240,50`, `12,5`, `1'240`, `1 240` grouped with a no-break space, or `1.2k`, rather than reading its first part. Captured values are kept per case.
- `compare-number` reads the value the same way and compares it with the named capture.
- Each result is `{type, …definition, passed, observed?, resolved?, error?}` with provenance `independent`. `resolved` is the text a check with `{run}` looked for; the controller accepts it only as the check's text with one token in place of every `{run}`, and none for a check without `{run}`.
- A failed check makes the step `failed`, and the controller's verdict fails the case. A step whose checks all pass is `completed`.
- The step event carries the results: `{type: 'journey-step', caseId, stepId, status, evidence?, checks?}`.

## Fixture-driven milestones

- The code drives milestones through the fixture: `journey.milestone(id, actions)` emits `running`, runs the actions in a `test.step`, evaluates the step's checks and emits `completed` or `failed` with evidence of the checks.
- The fixture enforces the reviewed order. Code that skips a milestone, runs one out of order or does not run every milestone stops for review; nothing runs after a failed milestone.
- `journey.signIn()` fills the run's account into the page's one visible sign-in form, opening the stage's sign-in page when the current page shows none. `journey.run` is the run's token. The fixture removes the account, the sign-in page, the token and the event channel from the process environment before any code runs.

## Progress events and transitions

- Step statuses: `pending | running | completed | blocked | failed | unconfirmed | skipped | cancelled`.
- The only transitions the controller accepts are `pending → running` for the first unfinished step, then `running → completed | blocked | failed` (`failed` only from an independent check). `completed`, `blocked` and `failed` are terminal; nothing may follow a blocked or failed step.
- A `running` event has no evidence; every other status needs 1–2000 characters of evidence, which are stored.
- Twin test accounts are generated local test data. Evidence, results, summaries and frames keep what was observed about them; in discovery, only the text sent to the model is redacted.
- When the run ends, the controller turns a step still `running` into `unconfirmed`, or into `skipped` or `cancelled` for a skipped or cancelled journey. It never becomes `blocked`.
- Progress has a monotonic `progress.revision`, incremented on every accepted event, including frames and queue changes, and a per-case `actionCount` (the total, not truncated) and `lastAction`. The controller keeps the worker's `frameCapturedAt` separately from its own `frameUpdatedAt`.

## Worker facts and the controller verdict

- A run launches one process per journey with its reviewed `case`, its code and hash, its check version, a new run token, `allowedOrigins`, `timeoutSeconds`, the account, the stage's sign-in page when set, its recording folder and, in a verification's control run, `blockWrites`.
- The process reports facts, never a status or verdict message. Its final event is `{type: 'result', result: {caseId, stopCause, assertions, error?}}`:
  - `stopCause`: `none` (the code ran to its end or to a failed check), `deadline` (the journey's time limit) or `action` (an action, the milestone order or the approved code could not be carried out, with its `error`). The controller adds `exception` for a process that failed.
  - `assertions` are the final assertions `{type, value, passed, resolved?}` checked on the page the journey ended on, or `[]` when that page was never checked.
  - `blockers` are `[{stepId?, kind: 'account'|'fixture'|'integration'|'permission'|'environment', evidence}]`, at most 10, added by the controller for code that signs in without an account; a malformed list is discarded, and the case cannot pass.
  - Milestone states are not repeated; the controller has them from `journey-step` events.
- A cancelled process reports no result. Stop, Skip and the kill timer are controller decisions, and `cancelled` and `skipped` come only from them.
- One function, `journeyResult` in `src/browser/results.ts`, owns a journey's status and message. It validates the facts against the approved snapshot and combines them with the accepted milestone states. The manager calls it exactly once per journey: for a reported result, for a process its kill timer stopped (with the facts reported before, or `stopCause: 'deadline'`), for a process error (`stopCause: 'exception'`), for a journey settled without a browser (no current code, or code that signs in without an account) and for a journey interrupted by a controller restart.
- Final assertions describe the journey's end state, and the controller derives whether it was reached. The journey stopped short of its end state when a milestone is `blocked` or `failed`, a blocker was reported, or it stopped for any cause other than `none` before every milestone completed (a case without milestones never shows that it finished). Its final assertion results then carry `reached: false` and can neither fail nor pass the case. A `reached` value from the worker is ignored.
- Case statuses: `passed | failed | blocked | needs_review | cancelled | skipped`. The verdict applies this order, and its messages are the only journey messages:
  1. `failed`: a milestone check failed (*Milestone check failed: title.*), a reached final assertion did not pass (*A final assertion failed.*), or the stop cause is `exception` (its sanitized detail).
  2. `blocked`: a milestone is `blocked` or a blocker was reported (*Blocked at milestone: title.*, or *Blocked: kind prerequisite unavailable.* without a milestone).
  3. `needs_review`: the stop cause is `deadline` (*Journey exceeded its time limit.*) or `action` (its error, such as *Generate and approve code for this journey.*), a milestone is incomplete, the final assertions were not evaluated, or the case has no reviewed check or final assertion.
  4. `passed`: every milestone completed, every approved final assertion was checked and passed, valid blockers, and at least one check or final assertion.
- A twin service blocked for missing inputs stays visible on the environment and adds no blocker: the journey keeps its own verdict, since nothing tells whether the missing service caused it.
- Results carry `engine: 'playwright'`. Results of older agent runs still render, without their agent observations.
- Error text is presentation, never a signal. Model API keys, `Bearer` tokens and URL queries are scrubbed from free text only; protocol fields (`type`, `status`, `stopCause`, ids, `kind`, `op`, approved assertion `value`) are never rewritten.
- `blocked` is never counted as passed or failed.
- Run roll-up order: `failed > blocked > needs_review > cancelled > completed (had skips) > passed`.

## Time

- `journeyTimeoutSeconds` is 60–1800, default 900; a stored config without it uses the default. It is the journey's Playwright test timeout.
- The generated Playwright config has `retries: 0` and `failOnFlakyTests: true`: a pass that needed a retry is no pass.
- The controller's kill timer fires at `timeoutSeconds + 45` seconds, after Playwright's own timeout, so the process can finish its recording and report. The verdict judges a process it stopped from the facts reported before, or from `stopCause: 'deadline'`: `needs_review` unless a milestone failed or was blocked. Uncertain cleanup still fails the journey and quarantines its environment.

## Origins, payments and authenticated discovery

- `externalOrigins`: HTTPS origins only, at most 10, with no credentials, path or query, set in the stage's test settings. A run receives `allowedOrigins = [target origin, ...environment app origins, ...externalOrigins]`. Discovery stays on the target environment's origins, except for the sign-in exchange below.
- Every page pauses each document request, redirect hops included, and a context route covers a popup's first request. A document outside the allowed origins is refused.
- Payment test-mode guard on `*.stripe.com`: a top-level Stripe page loads only when its URL path contains `cs_test_` or `/test_`; a `cs_live_` or `/live_` path is always refused, and nothing live from Stripe loads in any frame.
- A refused top-level navigation, or a page no check can judge (off the allowed origins, a browser error page, no page, or a page no observation can read by the check's time limit, as a crashed page or one whose main thread is blocked), stops the journey for review (*Navigation is outside approved origins.*, *Payment pages accept input only in Stripe test mode.*), never as a failed check.
- Discovery may take run-only `credentials` (never persisted). `authEndpoints` holds at most 3 absolute URLs on the target host (any port), each with a path other than `/`, and a twin's test account can supply its own. Discovery permits a POST to one of them (for example `http://127.0.0.1:54321/auth/v1/token`), its sub-paths or query variants, matched on whole path segments so `/auth/v1/token-revoke` is not included, and still blocks every other mutation. With credentials, discovery uses the credential tools and guards of the [browser agent](../../integrations/browser-use/README.md), including `sign_in_with_test_account`, without screenshots. The discovery result records `authenticated`. After `signed_in`, the worker reports the page the form was on in a `sign-in-page` event; the controller keeps only its path on the target origin, ignores a page with a hash and drops a segment's `;` parameters, and saves it as the stage's sign-in page while the stage has none.

## Drafting guidance

Drafts from a description are asked to follow these rules, which a reviewer checks before saving:

- For credit, usage or balance outcomes, read the starting value in the first relevant milestone and compare the final value at the end, after a milestone that observed the run's own success.
- For asynchronous work, wait and observe again instead of assuming completion.
- The first milestone confirms the required starting state (plan, balance, account).
- A settings journey records the original value and ends by restoring it.
- Payment happens only in Stripe test mode with Stripe's test cards.

## Scheduling and API

- `effectiveConcurrency` is 1 when a test account is shared or fewer than 2 cases are isolated; otherwise `min(concurrency, isolated cases)`. The run records `concurrencyLimit: 'shared-data' | 'account' | null`, and a queued journey's `queueReason` is `account`, `shared-data` or `browser`.
- The discovery summary is limited to 4000 characters in both Python and Node.
- Restart recovery turns journeys that never started (`queued` or `pending`) into `cancelled` (*Controller stopped before this journey started*), `running` ones into `failed` (a verification attempt's into `cancelled`), `skipping` ones into `skipped` and `cancelling` ones into `cancelled`. Running steps become `unconfirmed`, and matching result rows are added.
- `draft` and `saveCases` are allowed during an active run, because the run uses an immutable snapshot. They stay exclusive with discovery and with other case writes.
- `/api/state` summaries include `progress` only for active runs and each case's latest run, without `actions` (they keep `actionCount`, the last action, steps, `queueReason` and frame timestamps). A verification's control run never counts as a case's latest run. Full progress stays in `runProgress`.
