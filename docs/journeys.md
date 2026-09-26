# Business journeys

A business journey is a complete user flow, from entry and prerequisites to a business outcome, run in a real browser against a running application. For a Next.js app with Supabase and Stripe, one journey might sign in, choose a plan, pay in Stripe test mode, return to the app and check that the account shows the new plan. Beta and Gamma (Sandbox) stages hold a stage's journeys.

The controller owns every verdict. A successful click, finished code or a recording is never a pass on its own, and an application environment that is Ready says nothing about whether a journey passes.

Each journey has a reviewed goal, preconditions, ordered business milestones, fixed expected outcomes and independent checks. Every run executes the journey's Playwright code in a dedicated local Chromium, with no model:

- A **browser agent** (Browser Use) explores the application and drafts journeys. It never acts in a run.
- An **agent writes the code**: Playwright's generator agent turns a reviewed journey into Playwright actions. The code holds no checks; the reviewed checks come from the journey at run time.
- **A person approves the code** after its verification: three passing runs, then a control run with every write blocked in which a reviewed check must fail. See [Journey code](#journey-code).

The design is recorded in [Browser-first business testing](architecture/browser-first.md), [Journey contract](architecture/journey-contract.md), [Playwright journeys](architecture/playwright-journeys.md) and [ADR 0001](adr/0001-gate-runs-approved-playwright-code.md).

## Install

Use Node 24.12 or later and [uv](https://docs.astral.sh/uv/), which supplies Python 3.11–3.13. Runs need Playwright's Chromium; discovery needs the browser agent's own runtime, which shares that Chromium because both Playwright packages pin the same version. `npm run setup` installs both:

```sh
npx playwright install chromium
uv sync --project integrations/browser-use --frozen
```

Linux hosts may also need Chromium's system libraries (`npx playwright install-deps chromium`). `PERPETUAL_BROWSER_PYTHON` can name an absolute Python executable that has the pinned browser dependencies. Code generation runs a pinned OpenCode release through `npx`, which setup fetches and which otherwise downloads on first use. Do not use a personal browser profile or production login state.

## Configure a model

Discovery, drafting and code generation use a model; runs do not. Open the app-wide **Settings** page from the sidebar. Enter an **OpenRouter API Key** and choose a model; the list comes from OpenRouter's catalog of models that take text and images and support tools, and the saved model, else `openai/gpt-5.4-mini`, is preselected when the catalog has it. Or export the settings before starting the controller:

```sh
export OPENROUTER_API_KEY='your-key'
export PERPETUAL_MODEL='openai/gpt-5.4-mini'                   # optional
export PERPETUAL_MODEL_BASE_URL='https://openrouter.ai/api/v1'  # optional
node src/cli.ts serve --repo /absolute/path/to/your/repo
```

`PERPETUAL_MODEL_API_KEY` with `PERPETUAL_MODEL` and `PERPETUAL_MODEL_BASE_URL` selects another OpenAI-compatible endpoint for discovery. Saved settings take precedence over the environment. They are stored in the controller's data directory with mode 0600, and no response returns the key.

The model receives the task, bounded source excerpts, requirements and observed page content. Drafting a journey from a description, dictation and code generation need an OpenRouter key and model in Settings, and use OpenRouter credits. Writing code needs a more capable model than exploring; a small model can fail to write valid code.

## Where journeys run

A stage's journeys run against one application URL, set beside the stage's application link.

| Situation | What is needed |
| --- | --- |
| An existing preview or Beta URL | The test browser only |
| An application already running on localhost | The test browser only |
| Source exists but the app is not running | A [twin](twins.md) of the stage, or the app and its dependencies started some other way |
| An independent, resettable database is needed | A twin, which starts its services from scratch |

Code generation needs the stage's application URL to be the stage's ready twin. A twin's data persists between runs until the twin is rebuilt; the [journey gate](gate.md) rebuilds it for every commit it tests.

When a new twin is Ready and a person has not chosen another URL, the target becomes the twin's one web-frontend app, or else its only app; otherwise a person chooses. A newly ready twin also prepares journey drafts once, when a model, the browser runtime and an unambiguous URL are available and the stage has no tests yet. Missing setup stays visible without failing the twin. Opening a page or restarting the controller never starts this paid discovery again. A twin that becomes ready while its stage runs journeys or saves model settings takes over the stage's automatic URL at once, and during a verification once the verification ends; it is prepared once the stage is idle, without spending its one attempt on the busy stage. A restart drops such a deferred preparation.

A fresh browser context resets cookies and storage, not database rows or external service state. Browser navigation is limited to the application's origins plus, for runs, the stage's reviewed external origins; that is not network isolation, and application assets and API requests can still reach the application's configured dependencies.

## Workflow

1. Open **Integration tests** on a Beta or Gamma stage and set the application URL.
2. Choose **Generate** to explore the application, optionally with a test focus. The agent receives bounded, redacted source context sampled across UI, API, product documentation and shared code, and proposes up to four journeys as unselected drafts. Generate can replace the current tests after a successful, nonempty discovery; a failed or empty replacement keeps them. To add one journey instead, choose **Add test**, enter its **Description** (typed, or dictated with **Dictate**) and choose **Generate test**. This turns the description and source context into one draft without opening the application.
3. Review the draft's goal, preconditions, milestones, checks and expected outcomes, then save. Add missing account or fixture requirements. Cases need no CSS selectors or authored click steps.
4. From the reviewed journey's actions menu choose **Generate code**. The generator writes the journey's actions as a draft. **Verify code** runs the draft three times and then once with every change blocked; **Approve code** shows the draft, or its diff against the approved code, and approves exactly that code. **Discard draft** drops it.
5. Select reviewed journeys and run them. The run dialog's **Test account** offers the twin's test accounts (the first by default), a manually entered account, or none; without twin accounts, **Use test account** takes a manually entered one. Entered values stay in the dialog for one request. Each journey runs its approved code or, in a person's run, its current draft when no approved code is current; the gate runs approved code only. Running needs Playwright's Chromium and code for every chosen journey, not a model. Closing the live viewer does not cancel the run; **Stop** does.
6. Read the result. The reviewed checks run inside each journey; a journey with no check or final assertion stays **Needs review**.

**Add test** appears only on Sandbox stages. A stage holds at most 60 cases; a run takes 1 to 30 of them.

**Dictate** records a description after microphone permission. **Stop** sends the recording through the local controller to OpenRouter's transcription endpoint and appends the transcript to the editable description. Audio is not written to application storage. Recording stops automatically at two minutes and is capped at 8 MiB; closing the dialog discards an unfinished recording and cancels a pending transcription. Typing stays available when the browser cannot use a microphone.

## Cases and milestones

A reviewed case has a name, goal, preconditions, expected outcomes, final assertions, `isolation` (`shared` by default, or `isolated`) and ordered milestones, `steps: [{id, title, checks?}]`. A case saved as reviewed needs 2 to 12 milestones, unless it is identical to a stored case from before milestones (selecting or deselecting it is allowed). Generated and drafted cases always stay drafts until a person saves a review; generation never approves or runs them.

A milestone may carry up to 6 checks, which the fixture evaluates on the live page after the milestone's actions, each waiting up to 10 seconds for its condition:

- `url-contains`, `text-visible` or `text-absent`, with a `value`;
- `read-number` with a `label` and a `name`: captures the number shown after the visible label;
- `compare-number` with `label`, `name`, `op` (`<`, `>`, `=` or `!=`) and `than`, the name of a `read-number` from an earlier milestone or earlier in the same one.

A text check's value or a number check's label may name the run's token as `{run}`; see [Run-unique values](#run-unique-values).

`text-visible` also passes when a visible text field, text area or select holds the text as the application put it there, matched as visible text is (ignoring case and runs of whitespace), so a saved value shown in an editable field can be checked; `text-absent` passes exactly when `text-visible` would fail. A password field is never read, nor a field the journey edited on the current page, nor any field of a page the browser returned to through history, which restores what was typed before. A journey's own typing therefore never passes its check: reloading or reopening the page shows what was kept.

Final assertions (`url-contains`, `text-visible`, `text-absent`) describe the page the journey ends on. These checks observe page text, form fields the application filled, URLs and numbers; they do not independently prove database persistence, payment settlement or email delivery.

## Discovery

Discovery explores the target read-only: the browser blocks mutating HTTP requests. With a test account, discovery may also sign in, and may POST to up to three configured auth endpoints on the application host, each with a path other than `/`; a twin's test account supplies its own sign-in endpoint. The result records whether it signed in, and where its account signed in becomes the stage's [sign-in page](#test-accounts) while the stage has none. Without an account, authenticated screens can stay unexplored; such gaps become preconditions, not invented coverage. The stage's `maxSteps` (1 to 100, default 60) bounds the agent's actions.

Source evidence is limited to supplied repository paths and line numbers; a citation of a line that was not supplied is dropped. A journey that is invalid for another reason is left out and named, with its reason, at the end of the discovery summary (at most 4000 characters). Discovery fails when it accepts no journey and either proposed one or was replacing tests; existing tests are kept.

Source and page text are untrusted content: they cannot authorize tools or change expected outcomes. Discovery is not recorded.

## Runs

- **Code.** Each journey runs as one `playwright test` process. A journey without code needs review with *Generate and approve code for this journey.*, one whose approved code is stale with *The approved code is for an earlier version of this journey.*, and one whose stored code the current grammar rejects with *Generate code for this journey again: …*. These, and code that signs in with no account available (blocked), are settled without a browser while the run's other journeys still run.
- **Concurrency.** A run takes `concurrency` 1 to 4 (default 2). Each journey has its own browser, session, frames and progress. Journeys with shared test data run one at a time; only journeys a person marked `isolated` can overlap. A single test account forces serial scheduling. A fresh browser profile does not isolate balances, subscriptions or other backend state.
- **Time.** `journeyTimeoutSeconds` is 60 to 1800 (default 900) per journey. There are no automatic retries: the generated Playwright config sets `retries: 0` and `failOnFlakyTests: true`.
- **Origins.** Runs may also open up to 10 reviewed `externalOrigins`: HTTPS origins with no path, query or credentials, such as a Stripe checkout. Every document request, redirect hops included, is checked against the allowed origins. A top-level Stripe page loads only when its path shows test mode (`cs_test_` or `/test_`, never `cs_live_` or `/live_`), and nothing live from Stripe loads in any frame. A refused top-level navigation, or a page no check can judge, stops the journey for review, never as a failed check.
- **Blocked services.** When a twin service is blocked for missing inputs, the code still runs, and a journey that does not pass is reported blocked on that service, since nothing tells whether the missing service caused the failure.
- **Skip and stop.** A queued journey can be skipped without launching, and one skipped before its run settles the journeys without code stays skipped. An active journey becomes `skipping` until its browser has cleaned up, then `skipped`; other journeys keep their results. Skipping cannot undo actions already performed. **Stop** cancels the whole run. Uncertain browser cleanup quarantines the twin.
- **Restart.** After a controller restart, journeys that never started become `cancelled`, running ones `failed`, and skipping ones `skipped`; a milestone still `running` becomes `unconfirmed`. A verification's interrupted attempt ends `cancelled`, and so does its verification.

Drafts and case saves can happen during a run, because a run uses its own snapshot of the reviewed cases; they cannot overlap discovery or another case write. Each run keeps that snapshot and names the code each journey ran, so historical results stay tied to the exact reviewed case and code.

### Test accounts

Runs and discovery accept either a run-only `credentials` account or a twin `accountId`, not both. Without either, a ready twin's first test account signs in; `accountId: null` uses none. Account values reach only the current browser process and are never saved with cases, configuration, code or run requests. The controller reads a twin account's password from the twin's private state; views list only its id, label and username.

A run's code signs in with `journey.signIn()`, which fills the account into the page's one visible sign-in form; a sign-up form, whose password is marked `new-password` or asked for twice, is not one. The application URL may be a landing page without that form, so a stage can name a **sign-in page** beside its application URL: when the current page shows no sign-in form within 2 seconds, `signIn()` opens the sign-in page and signs in there. Without a sign-in page it waits the action timeout, as a slowly rendered form needs, then stops the milestone with *The application URL shows no sign-in form. Set the sign-in page.*; a sign-in page that shows no form stops it with *The sign-in page shows no sign-in form. Check the sign-in page.* The account is entered only on the application URL's origin. The fixture takes the account, the sign-in page and the run's token out of the process environment before any code runs, so neither the code nor the browser it drives can read them.

The sign-in page is an http(s) URL on the application URL's origin, without credentials, of at most 2048 characters. It keeps its hash, since a hash-routed application shows its form only on its route, such as `#/login`. A save whose sign-in page is not on the application URL's origin is refused, so moving the application URL to another origin means moving or clearing the sign-in page too. When a new twin moves the automatic application URL to another origin, as a changed port does, the sign-in page moves with it, keeping its path, query and hash; a twin with no single application URL clears both, and the path waits for the next twin. Discovery records only the path of the page where its account signed in, on the application URL's origin: a page with a hash is ignored, and a path segment's `;` parameters, such as `;jsessionid=`, are dropped, since they can carry tokens. Discovery never replaces a person's sign-in page.

In discovery, the worker gives Browser Use placeholders instead of the values. Before substituting them it checks the exact scheme, host, port, top-level frame and input type, and a password goes only into a password field. With an account, the agent can also call `sign_in_with_test_account`, which fills the page's one visible sign-in form, submits it and reports `signed_in`, `still_on_sign_in`, `no_sign_in_form` or `error`, never a value. Account-backed discovery sends the model page text without screenshots, with the account values redacted. Cross-origin and iframe sign-in are not supported.

Twin test accounts are generated local test data, so evidence, results, live frames and recordings show what the run observed about them. Model API keys and `Bearer` tokens are scrubbed from free text. Use dedicated test accounts, never production ones.

## Journey code

Journey code is the Playwright actions of one reviewed journey, saved as stage data. A journey has at most one **approved** code and one **draft** beside it. Generated or saved code is always the draft and never replaces the approved code by itself. Editing the goal, preconditions, milestones, checks, expected outcomes or final assertions makes both stale; renaming or selecting does not. Stale approved code whose actions still fit the edited journey's milestones can be taken as its draft again with **Reuse approved code**, to verify and approve like any draft, so an edit to a check needs no model. Removing a case removes its code. Code references call it the journey's spec.

### Grammar

Code runs in the same process as the fixture that judges it, so `src/journeys/playwright/specs.ts` accepts a grammar rather than arbitrary JavaScript. Code is at most 200 KB, parsed by Playwright's bundled Babel, and has exactly `import { test } from 'perpetual'` and one plain `test(title, async ({ page, journey }) => { … })`, never `test.skip`, `test.fixme`, `test.only` or another modifier. Its body only awaits `journey.milestone('<id>', async () => { … })`, with literal IDs for exactly the case's milestones, in order. A milestone only awaits `journey.signIn()` or one Playwright action on `page`, its locators and frame locators, `page.keyboard` or `page.mouse` (`goto` to an http(s) URL or path, `reload`, `click`, `fill`, `press`, `selectOption`, `waitForURL`, …), with literal, options-object or locator arguments. The one value an argument may read is the run's token, `journey.run`, alone or in a template literal such as `` `QA ${journey.run}` ``, and `goto` still takes only a literal address. The text of a typing action (`fill`, `type` or `pressSequentially` on a locator, `keyboard.type` or `keyboard.insertText`) may hold it in any milestone. Anywhere else, such as a locator's name, a filter or `waitForURL`, it may name an element or address only in a milestone after one with a check that fails when this run's data is missing: a `text-visible`, `read-number` or `compare-number` check whose text reads `{run}`. Before such a check, a control run's blocked save would make the action looking for the data fail, which catches nothing, so the draft could never be verified. A `text-absent` check passes with nothing saved and an address can carry typed text without a save, so neither unlocks it. No other identifier, declaration, assignment, computed access, function or control flow is accepted, so `expect`, page scripts, routing, direct requests, `process` and other globals cannot be written. Milestone IDs are judged in order before a milestone's actions. A run validates the stored code again, so an approval kept from an older grammar never runs.

### Run-unique values

A fresh browser session does not reset the twin's data, so a journey that saves a fixed value and later checks it passes once any earlier run stored it: its control run passes with nothing saved (`missed`), and so does a later gate run of a broken save. Each journey process therefore gets a token, 8 random lowercase letters or digits, new for every run and every verification attempt. Code reads it only as `journey.run`, and a reviewed check names it as `{run}`: before judging the page, the fixture replaces every `{run}` in a text check's value, in milestone checks and final assertions, or in a number check's label with the token. Code types data a later check reads with the token (`` `QA ${journey.run}` ``), and the check reads `QA {run}`, so a control run looks for a value no run stored.

The token only fills in the reviewed text: it never changes which check runs, and code cannot change it. Results keep each check as written with `resolved`, the text it looked for, and milestone evidence shows both, such as `Text visible “QA {run}” (“QA k3m9x2qa”)`. The review interface shows checks as written.

### Check version

A control run is evidence only for the checks it ran, so approved code keeps them. The check version is 2 since text checks read form fields, and 1 before (`CHECK_VERSION` in `src/journeys/playwright/checks.ts`). A verification counts only when its attempts ran under the current version, and an approval records the version; code approved before versions were recorded is version 1. Approved code runs under its version, so under version 1 a text check reads visible text only, as that code's control run did. A draft and a verification always run under the current version, so a draft an older controller verified is verified again.

### Verification

A draft must pass its verification before it can be approved. **Verify code** runs, one after another, up to four ordinary runs of exactly that draft for its one journey, selected or not, with a person's account rules:

1. Attempts 1 to 3 must pass; the verification stops at the first that does not, with that journey's error.
2. Attempt 4 is the **control run**. Every request whose method is not GET, HEAD or OPTIONS, on every origin and form submissions included, is answered without being sent, except while `journey.signIn()` runs: a form submission gets 204, which leaves its page as it was, and any other request 503, so the page can still be judged. Once the journey acts on a page after one of its WebSockets opened, by clicking, typing, pressing a key or selecting, that socket drops what the page sends, except while `journey.signIn()` runs. Until then, a socket's opening messages and subscriptions still reach the application, so a page that loads again reads its data, and messages from the server always arrive. The control run is **caught** only when a reviewed check fails in it: a milestone check, or a final assertion on the end state it reached. A pass is **missed** (*The journey passed with every change blocked. Strengthen its checks.*); any other end judged nothing (*No reviewed check noticed the blocked changes.*). Both fail the verification.

Blocking goes by method, and for a socket by direction once the journey acts, so a read sent as a POST (GraphQL, RPC), or over a socket after the journey acted on its page (such as the subscriptions of an in-app navigation), is blocked too. A journey whose application reads that way fails its checks in the control run for that reason alone, which counts as caught although it proves nothing about the checks. Heartbeats are dropped the same way, so a server that closes silent sockets may close one during a longer control run.

Playwright cannot route a worker's WebSocket, a page's WebSocketStream or anything a shared worker sends, and a socket that opens after the journey acted sends freely until the journey acts again, so it may carry a write. When a socket message the fixture did not route was sent, a socket that opened after an action since the fixture last signed in on its page sent anything, or a shared worker ran, a control run in which every check passed is inconclusive rather than missed: it ends for review with *The control run could not block everything the pages sent.*, and the verification fails. Code for a journey whose application keeps its changes only that way cannot be verified.

A verification holds only for the draft's code, the reviewed journey it ran against and the current [check version](#check-version): the same code saved again for changed checks is unverified, and an attempt that could not run that draft, because its journey changed meanwhile, fails the verification. One verification runs per stage. While it runs, it holds its stage, so a gate waits, and a person's run, discovery, code generation in the stage, saving model settings and saving, approving or discarding that journey's code are refused; an attempt waits while a person's test save holds the stage instead of failing on it. It holds its twin from its start to its end, so a health check or another operation never takes the twin between attempts, and every attempt runs with the test settings and on the twin the verification started with: when that twin is gone or no longer ready, the verification fails with *The environment changed during its verification. Verify its code again.* **Stop verifying** cancels it; a controller restart ends an unfinished one as cancelled.

The draft keeps its latest verification's record, written as it starts, after each attempt and at its end, a stopping controller included, so neither a restart nor a run history that no longer holds its attempts loses its verdict or brings back an older verification's. The run history keeps the controller's latest 50 runs across all stages, and every attempt of a verification still running. A verification that an older controller left without a record is judged from its attempts, and once one of them is no longer kept, it verified nothing and must run again. Control runs never count as a journey's current status and show `Control` in the Runs list and the run viewer; verification runs never reach the gate.

### Approval

**Approve code** opens a dialog with the draft or, when approved code exists, its line diff against it. Approving makes exactly that draft the approved code and clears the draft; it is refused unless the draft is current and its latest verification passed. **Discard draft** removes the draft and keeps the approved code.

Approved code names the four runs of the verification it was approved on, even once the run history no longer holds them, and its [check version](#check-version). Writes of one journey's code (a save, an approval, a discard or a generated draft) are judged in order as they commit, so a second writer is refused against the first one's code instead of silently overwriting it. Code approved without all four runs, as code was after a single passing run before verification existed, loads as a draft with its code and provenance, and a draft already beside it, being newer, stays instead. Until that draft is verified and approved, a gate settles its journey as `needs_review` without a browser.

The journey card shows the approved code as `Approved` or `Stale`, and the draft as `Draft`, `Verifying n/3`, `Verified`, `Verification failed` with its error, or `Stale draft`, beside `Generating` or `Generation failed` with its error.

### Generating code

**Generate code** writes a reviewed journey's code with existing tools: the Playwright Test generator agent that `playwright init-agents --loop=opencode` emits, run headlessly by [OpenCode](https://opencode.ai) (`opencode-ai@1.18.32`) against OpenRouter. Perpetual writes no agent loop or MCP client (`src/journeys/playwright/generation.ts`). It needs a reviewed case with milestones, an OpenRouter model in Settings, and the stage's application URL on the stage's ready twin. It holds that twin like a run, one generation per case at a time, and is refused while a verification runs in the stage; **Stop generating** cancels it. Nothing else starts a generation: not a view, a restart or the gate.

When the twin has a test account, the generation first signs in once, as a journey does and on the stage's sign-in page when one is set, through the runtime that runs journeys and with no model. One that cannot sign in fails with *The test account could not sign in:* and the fixture's reason, and one that cannot open the application fails with *The application could not be opened:* and the reason, before the harness starts, so no model call is spent and no draft is written from pages the generator never saw. The generator's plan holds the grammar's rules, including typing data a later check reads with `journey.run`, and the reviewed check texts that hold `{run}`.

The generation works in a private folder that is removed when it ends. The generator can write only test files in its own `tests/` folder; the config, seed, fixture mapping, plan and OpenCode configuration are read-only and must stay unchanged. OpenCode runs with its own `HOME`, so it reads none of your global OpenCode configuration, plugins or instructions, and only OpenCode receives the model key. Each harness call has 10 minutes.

The written file is validated against the grammar. An invalid or missing file gets one repair attempt with the validation error; a still-invalid file fails the generation and nothing is saved. A valid file is saved as the draft with its provenance (harness, generator and model) and still needs verification and approval. The test suite drives the pinned test MCP server with a fake harness (`test/fixtures/fake-opencode.ts`); whether a given model writes good code for a real journey is not covered by it.

## Verdicts

A journey's process reports facts, never a status: how it stopped (`none`, `deadline` or `action`), its milestone states and check results, and its final assertion results; the controller adds `exception` for a process that failed and blockers for a missing account or service. `journeyResult` in `src/browser/results.ts` is the only verdict, applied once per journey on every path, including a process stopped by its time limit and a journey interrupted by a restart. Precedence, highest first:

1. `failed`: a milestone check failed, a final assertion on the reached end state failed, or the journey stopped on an error.
2. `blocked`: a milestone was blocked or a blocker was reported, such as code that signs in with no account, or a blocked twin service for a journey that did not pass.
3. `needs_review`: the deadline passed, an action could not complete (including a milestone skipped or run out of order, code that differs from its approval, and a journey with no current code), a milestone is incomplete, the final assertions were not evaluated, or the journey has no reviewed check or final assertion at all.
4. `passed`: every milestone completed with its checks, every final assertion was checked and passed, and the journey has at least one check or final assertion.

Final assertions describe the end state, so when a journey stopped short of it (a blocked or failed milestone, a reported blocker, or an early stop) they are shown as not reached and neither fail nor pass the journey. Expected outcomes are backed by the checks alone: `Checks · Failed` only when a final assertion on the reached end state failed, and `Checks · Not reached` when the journey stopped earlier. A run rolls up as `failed`, `blocked`, `needs_review`, `cancelled`, `completed` (the run had skips) or `passed`, in that order. Results of older agent runs still render, without their agent observations.

## Live view and recordings

Beta and Gamma cards list the stage's journeys with their queued, running and result states. Selecting a journey focuses its expanded card in the inspector, which has two views: **Integration tests** and **Runs**. Each running journey streams JPEG frames of its own browser viewport (1280×800), about three per second, and its milestones update with the evidence of their reviewed checks as the controller accepts them. No sample footage or synthetic progress replaces an unavailable stream.

Watching a verification follows it as a whole: when the shown attempt ends, the viewer opens the next one, its control run included, so **Cancel run** stays reachable until the verification settles. An attempt a person opens after it ended stays open, so earlier attempts can be reviewed while the verification runs.

Every tab of a run journey is recorded as WebM; discovery is not recorded. A finished journey plays its recordings (one tab per recording); one without a recording shows its **Last frame**, never presented as live activity. A stage keeps the recordings of its latest 5 runs. A missing recorder leaves a journey unrecorded without failing it; a killed process reports no recording.

Frames and recordings may show test data. They stay behind the local, scoped controller.

## API

The main routes are below. Every request is scoped to `repoPath` and a Sandbox `stageId`. Mutations need the controller session token and a same-origin request.

| Method and route | Input |
| --- | --- |
| `GET /api/browser` | The stage's configuration, cases, code states, runs and preparation state. |
| `POST /api/browser/config` | `config`: target URL, `signInUrl`, scope, requirements, `maxSteps`, `journeyTimeoutSeconds`, `externalOrigins`, `authEndpoints`. |
| `POST /api/browser/cases` | `cases`, `baseCases`; a stale `baseCases` returns 409. |
| `POST /api/browser/draft` | `description`: one draft from a description. |
| `POST /api/browser/transcribe` | A dictated recording. |
| `POST /api/browser/discover` | Starts discovery; optional `replaceCaseIds`, `credentials` or `accountId`. |
| `POST /api/browser/run` | Optional `caseIds`, `concurrency`, `credentials` or `accountId`. |
| `POST /api/browser/skip` | `id`, `caseId` |
| `POST /api/browser/stop` | `id` |
| `GET /api/browser/runs/:id` | Full run progress. |
| `GET /api/browser/runs/:id/frame` | `caseId`: the journey's latest JPEG frame. |
| `GET /api/browser/runs/:id/video` | `caseId`, `file`: a recording the journey reported, with byte ranges. |
| `GET /api/browser/specs/code` | `caseId`: the draft and approved code, for review. |
| `POST /api/browser/specs` | `caseId`, `code`: saves the draft. |
| `POST /api/browser/specs/verify` | `caseId`, `hash`; `POST /api/browser/specs/verify/cancel` with `caseId` stops it. |
| `POST /api/browser/specs/approve` | `caseId`, `hash`: approves the verified draft. |
| `POST /api/browser/specs/discard` | `caseId`, `hash`: removes the draft. |
| `POST /api/browser/specs/reuse` | `caseId`: takes the stale approved code as the draft, when it still fits the journey. |
| `POST /api/browser/specs/generate` | `caseId`; `POST /api/browser/specs/generate/cancel` stops it. |

App-wide model settings are not scoped to a stage: `GET` and `POST /api/settings/model` read and save the OpenRouter model and key, and `GET /api/settings/models` lists the eligible models.

## Implementation

- `src/business/browser-cases.ts`: case validation and redacted, bounded source context.
- `src/browser/`: scoped state, process supervision, scheduling, model settings, frames, recordings, verification and the verdict (`results.ts`).
- `src/journeys/playwright/`: the code grammar, fixture, checks, reporter, runtime and code generation.
- `src/agents/opencode.ts`: the OpenCode harness that code generation and [twin config generation](twins.md#generated-twin-config) share.
- `integrations/browser-use/`: the pinned Python discovery worker (Browser Use and Playwright for Python), its sign-in helper and frames. Its [README](../integrations/browser-use/README.md) documents the worker protocol.
- `client/src/BrowserTestingPanel.tsx`, `BrowserAgentViewer.tsx` and the journey components: the interface.

## Tests

- `npm test` type-checks both TypeScript projects, then covers the controller, case validation, verdicts, scheduling, the code grammar and the API, and runs journey code, verification and its control run in a real Chromium.
- `npm run test:browser` runs the Python discovery worker's tests, including a real Chromium against disposable local pages.
- `node scripts/browser-agent-contract.ts` runs discovery through the real controller, Browser Use and Chromium against a disposable page with a deterministic model fixture, and checks that its drafts need review and that live frames stream.

These use deterministic fixtures. They establish contracts and failure behaviour, not a real model's accuracy on a real application.
