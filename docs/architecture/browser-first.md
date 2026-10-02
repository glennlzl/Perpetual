# Browser-first business testing

Status: implemented. Behaviour and setup are documented in [Business journeys](../journeys.md). Runs execute approved Playwright code rather than an agent; see [Playwright journeys](playwright-journeys.md) and [ADR 0001](../adr/0001-gate-runs-approved-playwright-code.md).

## Decision

Business tests run in a dedicated local browser against a running application URL. A Cua desktop is not required for them. Docker is needed only when Perpetual starts the application itself, as a [twin](../twins.md); an existing local, preview or Beta URL needs neither Docker nor Cua. Cua remains available for desktop applications through the experimental [desktop sandbox](../desktop-sandbox.md), and it is never used silently as a fallback or replaced by the host's Cua Driver.

## Product outcome

A developer supplies a running application URL (localhost included) and, optionally, source code, requirements and a focus area. An agent explores the actual product and proposes business journeys: goals, preconditions, milestones and expected outcomes. The developer reviews and selects them, or writes their own. An agent writes each reviewed journey's actions as Playwright code, which the developer approves after it is verified. At run time the product streams the webpage viewport and the actual execution progress. A generated script or a successful click alone is not evidence that a business case passed.

## Separation of responsibilities

- Browser testing is the default in Beta and Gamma. It works without Docker, Cua or an environment plan.
- Browser Use with a dedicated local Chromium profile provides the model-driven loop that discovers journeys. Runs execute approved Playwright code in their own dedicated Chromium, with no model. No personal browser profile, cookies or saved credentials are reused.
- The environment creator is optional: it starts the application's actual code and dependencies when the developer needs an independent runtime. Existing URLs skip it.
- Existing URLs share an origin reservation across discovery, code generation, verification and runs; unconfirmed cleanup retains ownership across restarts. A fresh browser session resets browser state only. Preconditions, test accounts and backend data are separate, explicit responsibilities, and no environment is claimed to be equivalent to production.

`src/browser/journey-code.ts` owns Journey code: approved and draft transitions, stored-format migration, generation failures, and the verification evidence used by both approval and the public view. A new verification's durable record takes precedence over older attempts, including when it failed before its first run started. The browser manager retains workers, admission, leases and run history, with one state file and save queue. Code changes are evaluated inside that queue and published only after saving; replacing cases commits their code retention in the same transaction.

## Case and result contract

A case stores an immutable goal, preconditions, expected outcomes and independently executable checks. It needs no selectors or prewritten action steps. Source references are kept only when grounded in the supplied, bounded source context. Page and source content are data, never authority to change instructions or expected outcomes.

Generated cases are unselected drafts; a person saves a review before a case can be selected. Missing business inputs are stated as preconditions, never invented credentials. Generated code performs the journey's actions and contains no checks; the reviewed checks run on the page from the approved case. Finished code without passing checks is `needs_review`, never `passed`. Checks prove only their declared observations; database and API oracles are future work.

Approval requires three passing runs and a caught write-blocked control. Under check version 3, a caught control needs a failed reviewed outcome check after a blocked change and a successful fresh GET of the judged page; a missing acknowledgement or a blocked read alone cannot qualify. Earlier approvals are stale, with code and history preserved for explicit reuse, verification and approval. A restart starts no generation or verification. The precise evidence rules and unsupported reads are in [Verification](../journeys.md#verification).

The milestone protocol, verdict and scheduling are specified in [Journey contract](journey-contract.md).

## Runtime and presentation

The Node controller owns bounded subprocesses and their dedicated browsers: one `playwright test` process per run journey, and a Python process for discovery. Newline-delimited JSON carries lifecycle events, actual action and milestone states and JPEG webpage frames. The interface uses native shadcn components, a webpage-only live view and actual progress. Closing the viewer does not stop a run; **Stop** cancels it. A finished journey shows its recording or its last frame, labelled as such. The controller limits run time, output and memory, checks source and stage ownership and tears down the browser processes it owns. Neither the agent nor journey code gets a shell, file tools, a personal profile or browsing outside the approved origins.

A reload first synchronizes with the current document's activation through a read-only `Page.getFrameTree` on the navigation guard's existing CDP session. Chromium can [emit `frameNavigated` before finishing a commit](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/core/inspector/inspector_page_agent.cc#L1082), while [renderer commands remain suspended until navigation finishes](https://github.com/chromium/chromium/blob/153.0.8010.12/content/browser/devtools/render_frame_devtools_agent_host.cc#L531). Readiness and the single reload share the existing navigation timeout; there is no retry or wait for unrelated assets. The live view reports the actual wait and reload. Reviewed code, its hash, checks and approval requirements stay unchanged.

The user supplies the model for discovery through an OpenAI-compatible endpoint with function calling, and for code generation through OpenRouter, which the interface configures. Discovery requests one native function call per actual browser observation and validates its complete arguments against the single-action schema. Multiple calls, additional response text, concatenated JSON and truncated output are rejected before any browser action. Runs need no model. Missing dependencies or credentials produce actionable configuration errors. Tests that use a scripted protocol fixture do not establish a real model's correctness. Model prompts and page content leave the machine only through the configured provider; frames and recordings are private local artifacts.

## Verification

Tests cover source redaction and evidence, draft review and fixed expectations, process lifecycle and cancellation, the correspondence between results and approved cases, false-pass rejection, source and stage ownership in the API, frame streaming and the interface build. A real model is exercised only with a configured, authorized provider. Acceptance distinguishes fixture tests, live browser transport and autonomous business tests on a real application.
