# 2. A repair merges itself only after CI and every journey gate pass at its exact head

Status: accepted, 2026-09-25.

## Context

Perpetual is meant to be a self-healing pipeline. When a build fails, an agent fixes it through a pull request, and the pipeline should become green again without a person reading logs. Other fixers (GitHub Copilot's fix for failing Actions, Nx Cloud Self-Healing CI, the Railway Agent) verify a fix only by re-running the step that broke. A fix can make a build pass and still break the product. Perpetual already has a stronger bar: the journey gate rebuilds the stateful Beta twin at a commit and runs its reviewed business journeys.

## Decision

A repair's pull request merges itself when all of these hold at the same head sha:

- every CI check succeeded, a passing run of each workflow whose failure opened the repair among them (amended 2026-10-05);
- every Sandbox journey gate *passed*;
- the target branch has not moved since the verified base;
- no change rule turned auto-merge off.

Auto-merge is on by default, as the Build stage's Autopilot mode `Autopilot`, and a person turns it off by choosing `Ask first`.

Guardrails:

1. **Humans keep the judges.** The agent never changes what judges its fix.
   - A diff touching tests, or the configuration and scripts that decide how CI tests, lints and type-checks the code (amended 2026-10-05), or larger than the size limit, is opened but not merged automatically.
   - A diff touching CI or deploy configuration is refused before it is pushed, because a pushed branch runs its own workflows with the repository's secrets (amended 2026-09-25).
   - A diff that adds the redaction marker, which the agent's tools show in place of hidden text, is refused too, since it stands where real code was (amended 2026-10-05).
   - Checks still come only from reviewed cases (ADR 0001).
2. **Only a pass merges.**
   - A released gate is a person's decision, so a person merges.
   - A stage without reviewed journeys needs release, so it never auto-merges.
3. **Exact head.**
   - The merge names the verified sha (`--match-head-commit`; as built, the REST merge's equivalent `sha`, amended 2026-09-25).
   - A moved base is verified again. A new push therefore does not supersede a repair whose gates or merge are under way until that push passes (amended 2026-09-25).
4. **Bounded.**
   - Four attempts, escalating the model after two, under a cost cap.
   - A repair Perpetual opens by itself goes to a person, without the agent, after three repairs of the same failure failed in a row or once the pipeline's repairs cost a fixed daily cap, which also bounds what it spends; a person's Repair may still start it (amended 2026-10-05).
   - A failure of a commit Perpetual merged from a repair needs a person.
   - The agent never pushes the target branch.

## Consequences

- An auto-merged repair can trigger the user's own deployment workflows. The journey gate itself still never deploys.
- Repairs cost one or more twin rebuilds per PR head. Gates remain one at a time.
- Credential and permission failures never become code changes. They wait for a person.
- A repository without a Sandbox stage merges repairs on CI alone.
- GitHub's merge guards only the head, so the target branch can still move in the moment between Perpetual's last read of it and the merge. Such a merge is named in the repair's reason, and the target branch's push gate judges it (amended 2026-09-25).
- The same bar will apply to every change Autopilot makes; the design and the order to build the rest in are in [Autopilot](../architecture/autopilot.md).
