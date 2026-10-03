# 1. Gate and manual runs execute approved Playwright code

A journey gate must give the same verdict for the same commit, quickly and cheaply, but a model-driven browser agent performing every run was slow, varied between runs, paid for model tokens on every push and could route around a broken control. So an agent writes each reviewed journey's actions once as Playwright code, a person approves that code after it is verified, and gate and manual runs replay it with a generic fixture and no model.

Status: accepted.

## Context

When a Browser Use agent performed every run, each milestone took sequential model calls, verdicts could differ between runs of the same commit, and much of the Python worker existed to compensate: single-action enforcement, a code-driven milestone protocol, forced-finalization handling and reconciling agent observations with independent checks. In a trial on a real application's twin, a generated Playwright spec with a generic fixture ran a four-milestone journey in about 3 seconds with no model calls, where the agent needed 40 to 72 seconds; it passed 20 runs out of 20, and an injected persistence bug failed on a reviewed check.

## Decision

An agent (Playwright's generator agent, run headlessly by OpenCode) writes the actions of a reviewed journey as Playwright code. Gate and manual runs execute that code with the generic `perpetual` fixture and no model. The browser agent still discovers journeys but never acts in a run, and the agent run path is removed.

Four guardrails:

1. **Checks come only from the reviewed milestones; AI never writes them.** The spec grammar has no assertions: a milestone only awaits Playwright actions, and the fixture evaluates the checks it loads from the approved case snapshot.
2. **AI-changed code never takes effect or turns a run green by itself.** Generated or saved code is a draft beside the approved code until a person approves it, seeing the code or its diff against the approved code. The grammar allows exactly one plain `test(...)`, so a skipped, `fixme` or `only` test cannot exist.
3. **No automatic retries.** A pass that needed a retry is not a pass: the generated Playwright config keeps `retries: 0` and sets `failOnFlakyTests: true`.
4. **Before approval, the draft is verified.** It runs three times, then once as a control run in which every state-changing request is blocked (except while the fixture signs in) and answered without reaching the application, so its page can still be judged. The three runs must pass, and then an eligible reviewed outcome check must fail in the control run: a journey whose checks cannot tell that nothing it did was kept cannot be approved. Check version 3 below defines the required fresh-read evidence. A control run that passes, or that ends any other way, such as on an action the block broke, fails the verification. A verification holds only for the exact code and reviewed journey it ran.

## Consequences

- The agent run path is removed: the runner's run mode, milestone driver, final checks, reload tool, Stripe payment guard, recorder and run failure limits, and the agent-outcome parts of the verdict. `journeyResult` keeps only the checks-backed semantics; results of older agent runs still render, with less detail.
- Discovery is unchanged: the browser agent explores the application and proposes reviewable drafts.
- A run needs Playwright's Chromium and code for each journey, not a model. A journey without current code needs review without a browser; the gate runs approved code only, and a person's run may try a current draft.
- A verification holds its stage, so a gate waits for it; its runs never count as a journey's status or reach the gate.
- The original control run blocks by HTTP method, so it cannot tell a write from a read sent as a POST (GraphQL, RPC). Such a blocked read cannot establish a caught control. [ADR 0003](0003-review-fixed-post-reads.md) supersedes this limitation for exact person-reviewed JSON requests; unreviewed POST reads still cannot authorize approval.
- Writing code needs a more capable model than a run ever does, since a run needs none; a small model can fail to write a valid spec. Generation is a one-time cost per journey.
- Repairing code after the application changes is not automatic: a person generates, verifies and approves new code.

## Amendment: run-unique values and check versions

A fresh browser session does not reset the twin's data. A journey that saved a fixed value and later checked it therefore passed its control run once an earlier attempt had stored the value, so it could never be approved, and a broken save still passed every later gate run. Each journey process now gets a token of its own, which its code types as `journey.run` and a reviewed check names as `{run}`; the fixture fills the reviewed text in before judging the page. Checks still come only from the reviewed case: the token never changes which check runs, a spec cannot change it, and results keep each check as written with the text it looked for. Text checks also read what the application put in visible form fields, never a password field, so a saved value shown in an editable field can be checked; a field the journey edited on the current page, or one the browser restored on returning through history, is never read, so a journey's own typing cannot pass its check. Reading fields introduced check version 2; version 1 read visible text only. Each approval records the version its verification ran under. The policy through version 2 let older approved code keep running under that version; the version 3 amendment below replaces that policy. See [Run-unique values](../journeys.md#run-unique-values) and [Check version](../journeys.md#check-version).

## Amendment: fresh outcome reads in check version 3

A failed “Saved” acknowledgement or a blocked POST read could previously count as caught without testing what the application kept. Version 3 requires an eligible reviewed check to fail after a blocked request or socket send and a successful fresh top-level GET of the page being judged, with no later blocked request, failed read or unguarded write. The check must read run-owned text (`{run}`), or compare a finite observed number against a baseline captured before the blocked change; a missing number, static acknowledgement or URL alone cannot qualify. The fixture reports `controlRead` for that failed check, and the controller requires both pieces of evidence. Unsupported reads remain missed controls and refuse approval; this is bounded browser evidence, not an independent database or payment oracle.

Earlier approvals become stale while their code, approval records and history remain. A person may explicitly reuse the approved code as a draft, verify it under version 3, and approve it again; a saved-state load or controller restart starts no generation or verification.
