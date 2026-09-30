# Playwright journeys

Status: accepted and implemented, with four guardrails recorded in [ADR 0001](../adr/0001-gate-runs-approved-playwright-code.md). Every gate and manual run executes a journey's Playwright code; the browser agent only discovers journeys. Behaviour is documented in [Business journeys](../journeys.md#journey-code).

1. Checks come only from the reviewed milestones; AI never writes them.
2. AI-changed code never takes effect or turns a run green by itself: it is a draft beside the approved code until a person approves it, seeing the code or its diff.
3. No automatic retries: `retries: 0` and `failOnFlakyTests: true`.
4. Before approval, the draft passes three runs, then a control run in which every state-changing request is blocked; a reviewed check must fail in the control run.

## Problem

A journey gate must give the same verdict for the same commit, quickly and cheaply. When an agent performs every gate run:

- it is slow, bounded by sequential model calls;
- its verdicts can vary between runs;
- every push pays for model tokens;
- an adaptive agent can route around a broken control and still reach the end.

Much of the Browser Use worker existed to compensate: single-action enforcement, the code-driven milestone protocol, forced-finalization handling, and reconciling agent observations with independent checks.

Replaying generated Playwright code removes the model from the run. Authoring the code needs a capable model, but it is a one-time cost per journey, and running it needs none. Playwright's own test agents (planner, generator, healer) already emit ordinary specs, so Perpetual reuses them instead of writing an agent loop.

## Design

1. **The reviewed contract stays the source of truth**: goal, preconditions, 2–12 ordered milestones with their checks, expected outcomes and final assertions ([Journey contract](journey-contract.md)).
2. **Generate once.** Playwright's generator agent, run headlessly by OpenCode against OpenRouter, writes the actions of a spec from a reviewed journey. The spec uses a generic Perpetual fixture:
   - Its read-only plan includes the complete reviewed goal, preconditions, ordered milestones and every check, expected outcomes and final assertions, preserving their values. These are acceptance input, not checks the agent may rewrite into its code. The same protected plan is available to a grammar-repair attempt.
   - Authoring instructions require the generator to stop and report the milestone and observed blocker if a prerequisite is missing or the application fails before a required action. It must not substitute recovery controls, old entities or guessed remaining steps for the reviewed business flow. These instructions do not prove the generated actions are semantically correct: independent verification and human approval remain required.
   - `journey.milestone(stepId, actions)` wraps `test.step`, runs the generated actions, then evaluates that milestone's reviewed checks from the approved snapshot. Generated code never contains checks: a spec is an allowlisted grammar of awaited Playwright actions with no identifiers beyond `page` and `journey`, so neither generation nor repair can weaken them.
   - `journey.signIn()` fills the twin's test account into the page's sign-in form, on the stage's sign-in page when the application URL shows none.
   - `journey.run` is a token new in every run, which code types into data a reviewed check names as `{run}`, so a fresh run never passes on a value an earlier run stored.
   - The navigation allow-list and the Stripe live-mode guard apply to every document request.
   - Milestone events and screencast frames reach the controller for the live view, and Playwright's video for replay.
3. **Keep a draft beside the approved code.** Generated or saved code is always the draft. Both are bound to the reviewed contract's hash, so editing the contract makes both stale.
4. **Verify.** A draft runs three times, then once as a control run in which every request whose method is not GET, HEAD or OPTIONS is answered without reaching the application, and a page's WebSocket drops what the page sends once the journey has acted on it since the socket opened, except while the fixture signs in. The three runs must pass, and a reviewed check must fail in the control run; otherwise the checks cannot tell that nothing the journey did was kept. A control run whose checks all pass after a write could have got around the block is inconclusive, not missed. A verification holds only for the exact code, the reviewed journey and the check version it ran under, and holds its stage and its twin so a gate waits and nothing else takes the twin between attempts. The draft keeps the verification's record, so its verdict outlives the run history.
5. **Approve.** A person approves exactly the verified draft, seeing the code or its line diff against the approved code. The draft becomes the approved code, naming the four runs of its verification and the check version they ran under; approved code keeps running under that version. Code approved without all four, as code was after a single passing run before verification existed, loads as a draft, so no gate runs it until it is verified and approved.
6. **Run.** Gate runs execute approved code only; a person's run may try a current draft while no approved code is current. No model is needed. `journeyResult` still owns the verdict:
   - a reviewed check or final assertion fails → `failed`;
   - code that signs in without a test account → `blocked` before launch; with a twin service blocked for missing inputs, a journey that does not pass → `blocked`;
   - an action cannot complete, the deadline passes, the code or milestone coverage does not match its approval, or the journey has no current code → `needs_review`.

## Consequences

- The Browser Use run path is removed: the runner's run mode, milestone driver, final checks, reload tool, Stripe payment guard, recorder and run failure limits. Results of older agent runs still render, without their agent observations.
- The control run blocks by method, and a socket by direction once the journey acts, so a read sent as a POST (GraphQL, RPC), or over a socket after the journey acted on its page, is blocked too. Such an application's journey fails its checks in the control run for that reason alone, which counts as caught although it proves nothing. Heartbeats are dropped too, so a server that closes silent sockets may close one during a longer control run.
- A socket's opening messages and subscriptions still reach the application until the journey acts, so a page that loads again, as after a reload, reads its data.
- A fresh browser session does not reset the twin's data, so a fixed value an earlier run stored would satisfy a later run's check with nothing saved. Data a later check reads is typed with the run's token, and the check names it as `{run}` ([Run-unique values](../journeys.md#run-unique-values)).
- Reading form fields made the checks stronger, so approvals record the [check version](../journeys.md#check-version) their control run was caught with, and a draft verified under an older one is verified again.
- Playwright routes neither a worker's WebSocket, a page's WebSocketStream nor anything a shared worker sends, and a socket that opens after an action sends until the journey acts again. The fixture notices a socket message it did not route, anything such a socket sends and any shared worker, so such a control run cannot be missed, but a journey whose application keeps its changes only that way cannot be verified.

## Proposed next steps

These are not implemented.

- **Repair.** When an action fails, Playwright's healer proposes a patch in a private workspace. The result stays `needs_review` with the diff and the recording until a person verifies and approves it. A healed spec is never an automatic pass.
- Discovery keeps the Browser Use agent until Playwright's planner proves equally good at authenticated journeys.
