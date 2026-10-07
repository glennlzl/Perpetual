# Autopilot

Autopilot is a stage's standing permission to make changes for the repository on its own: fix a failed build, and later fix a failed deployment, update dependencies, resolve a dependency conflict, follow a runtime deprecation. Every change is a pull request on a branch of the pipeline's own, verified by the stage before it merges. The interface ([Pipeline interface](../pipeline-ui.md#autopilot)) renders whatever the controller records. The first kind of change, [build repair](../repair.md), is built; this document is the design the built part follows and the order for the rest. The decision it rests on is [ADR 0002](../adr/0002-repairs-merge-after-ci-and-journey-gates.md).

## Why this and not an existing fixer

Existing fixers verify only inside their own silo: GitHub Copilot's fix for failing Actions, Nx Cloud Self-Healing CI, the Railway Agent and Dependabot alerts assigned to an agent each re-run the step that broke. None of them knows whether the product still works. Perpetual already rebuilds a stateful Beta twin and runs reviewed business journeys at a commit, and a change uses exactly that as its bar. GitHub's own runners stay the judge of CI, the journey gate stays the judge of the product, and Renovate or Dependabot will find version bumps.

## Principles

- **A change is a pull request.** Autopilot never commits to the target branch. A change lives on `perpetual/<kind>/<sha7>` and reaches the target branch only through GitHub's merge API, so branch protection, required checks and review rules apply to Autopilot as they do to anyone.
- **The stage verifies, then Autopilot merges.** Build verifies with the pull request's checks and with every Sandbox stage's journey gate at the pull request head; Production will verify with the deployment the provider records for the head. A change never turns a failed gate into a passed one; the merged commit runs the stage again like any push.
- **Two modes per stage**, saved with the pipeline: `merge` (the default) merges once verified; `ask` stops at the open pull request, which then reads `Needs review` until a person merges or closes it on GitHub.
- **The agent edits in a box; the controller pushes.** A change's code is written by an AI SDK tool loop whose tools act only inside a Docker repair box holding a copy of the failing commit: no host mount, no socket, no credential, and no route to the host or the local network. The host copy alone commits and pushes, as the connected account, and only its own branch.
- **Detection is free, authoring costs a model call.** Signals come from GitHub reads that cost a `304` when nothing changed. The model runs only once a change has a trigger and a rule-based triage sent it to the agent; credentials and permission failures never become changes.
- **Bounded.** One change per stage at a time, four authoring attempts per change (two with the Settings model, two with the escalation model), a hundred steps and fifteen minutes per attempt, a cost cap per change, and a change that cannot be verified or merged ends with its reason and its pull request left open. A change Autopilot starts by itself also stops short of the agent, for a person, once three changes of the same failure failed in a row or the pipeline's changes cost a fixed daily cap, and spends no more than what is left of that cap; an attempt cut short still records what it cost. A restart never starts paid work.
- **Nothing product-specific.** Triggers, commands and prompts come from what the scan detected (workflows, package managers, deployment targets), never from a particular application.

## Components

```
src/repair/
  manager.ts    the loop: the watched head, triage, one repair at a time, persisted through src/store.ts, the loop guard
  triage.ts     which runs a repair opens for, and what triage does with their failures, without a model
  clone.ts      the host copy of the failing commit, its staged change, commit and push, and the gate checkout
  box.ts        the repair box: the container, its limits, its diff, its disk watchdog
  egress.ts     the box's proxy: public addresses only
  tools.ts      the agent's tools, its only permissions, each run inside the box
  context.ts    what the agent is told, and what its pull request says
  workflow.ts   the failing job's command and toolchain, read from the workflow file
  changes.ts    the change rules a diff meets before every push
  agent.ts      the attempt loop, CI at the pull request head, the pull request's lifecycle
  github.ts     failed runs, reruns, pushes, pull requests, checks and the merge, through src/github-cli.ts
  merge.ts      the journey gates at the pull request head, then the merge
  view.ts       repairs as the interface's changes: GET /api/autopilot and the state's autopilot field
```

The manager mirrors `src/gate/manager.ts`: `createRepairManager({ dataDir, source, github, steps })` with seams for GitHub and for the agent step, so tests drive it with fakes; records in `<data>/repairs/state.json` through `src/store.ts` with restart recovery; `idle()` and `close()` for tests and shutdown. The gate manager runs a change's journey gates (`runRepair`) over a checkout the change owns, beside the target branch's gates, which they never supersede or promote.

### The agent loop

The loop is Perpetual's own, on the AI SDK 7 with the OpenRouter provider, the way the twin config author loop is. It was measured against pi, OpenCode, mini-swe-agent, the OpenAI Agents SDK and Codex in a [bake-off](../../bench/repair/README.md) of 1264 attempts over 20 repair cases ([reports](../../bench/repair/reports/README.md)): every harness produced a correct change about as often, and what separated them was ending cleanly. With a verified ending, an attempt that stops calling tools after changing files ends done when the failing step's own script passes in the box, the loop matches the best harness within noise at half its cost, and the loop, its permissions and its security boundary stay Perpetual's. Codex was excluded: it leaked the key it uses into every command's environment, and did poorly with a small model.

## The change loop

Each change records the five steps the interface shows, with the facts each step is allowed to state. Step names differ by trigger; states are `pending`, `active`, `done`, `failed` and `waiting`.

| Step | Build repair (built) | Proactive changes (next) | Facts in the detail |
| --- | --- | --- | --- |
| 1 | Read the failure | Found | the failed run and commit; an alert or the versions to move |
| 2 | Diagnose | Plan | the rule-based cause; a rerun that passed |
| 3 | Change | Change | the attempt and model, the cost, the pull request, what holds it |
| 4 | Verify | Verify | CI on the pull request, each journey gate's verdict at the head |
| 5 | Merge | Merge | the pull request, target branch and merge commit, or why it waits |

States: a change is `queued` while it waits without starting steps; `running` while the manager works; `merged`; `passed` when the failure cleared without a change, such as a rerun that passed; `needs-review` when it waits for a person with an open pull request (the mode is `ask`, a change rule held it, a gate did not pass, or protection refused the merge); `needs-attention` when the controller needs a person without an open pull request, with its reason visible even while collapsed; `not-merged` when it otherwise ended without a fix, or its pull request is closed. The full mapping is in [Build repair](../repair.md#interface).

Concurrency: one change per stage at a time. Observed commits arriving during active work enter the durable Build queue in FIFO order; a new head never aborts active work. Each queued commit's own CI is checked before repair starts, after the previous change and its cleanup finish. A restart pauses the saved queue until Resume queue; a head first seen at start is still a baseline that opens nothing by itself. Polling is not a complete push-event history.

## Triggers and verification

| Stage | Trigger | Read from | Kind, title | Verified by | State |
| --- | --- | --- | --- | --- | --- |
| Build | a workflow run for the head failed | `/actions/runs?head_sha=`, then `gh run view --log-failed` and `diagnoseFailure` | `fix`, Fixing build | the pull request's checks, then every Sandbox journey gate at its head | built |
| Build | a network or deadline failure | the same | `rerun`, Rerunning build | the rerun; a second failure goes to the agent | built |
| Build | an open Dependabot or Renovate pull request | `/pulls?state=open` by bot author | `update`, Updating dependencies (adopted) | its own checks and the gates; a conflict is rebased and its lockfile regenerated in the box | next |
| Build | a Dependabot alert | `/dependabot/alerts?state=open`, when the session may read them | `update`, Fixing a vulnerability | checks and gates | next |
| Build | outdated packages, once a day | the ecosystem's outdated command in the box | `update`, Updating dependencies | checks and gates | next |
| Production | a deployment for the head failed | `src/github-deployments.ts` | `fix`, Fixing deployment | a successful deployment recorded for the pull request's head | next |
| Production | a runtime the provider deprecates | the failed deployment's description and the config files | `runtime`, Updating runtime | as above | next |

Major version updates will take the `ask` path even where the journey gate passed, because a green build and a passing journey rarely prove a major upgrade for every caller.

## Data and routes

`<data>/repairs/state.json` holds the repairs, each the client's change plus `key`, `branch`, `sha`, `login`, `trigger`, `attempts`, `holds`, `gates`, `pushed` and the pull request, `autoMerge` per pipeline key, which the Build stage's mode reads and writes, and `passed` per pipeline key, when a watched head last passed, which ends a run of failed repairs. The newest 100 repairs per pipeline are kept, and a finished repair keeps its failures in brief; a save that would pass 8 MB drops the oldest finished repairs that hold no cleanup, those with a merge or a pull request that may be open last, and a start reads back up to 128 MB, so an older controller's larger file loads and its first save trims it.

- `GET /api/autopilot?repoPath=` returns the contract's `AutopilotView` (`contract/autopilot.ts`) for the active source, `409` otherwise; `GET /api/state` carries the same view as `autopilot`, and its presence is what enables the interface.
- `POST /api/autopilot/mode` with `{ repoPath, stageId, mode }` saves the Build stage's mode, validated as `unknown`.
- `POST /api/autopilot/repair` with `{ repoPath, stageId, runId }` starts a person's repair of a failed run at the watched head.
- `POST /api/autopilot/stop` with `{ repoPath, stageId, id }` stops the change under way.

## Phases

1. **Build repair** (built): the manager, its state file and restart recovery; the view and mode routes; the repair box, its proxy and the host copy; the agent with the attempt loop and the escalation model; pull request, CI, the journey gates at the head, and the merge; Repair and Stop.
2. **Dependencies.** Adopted bot pull requests, with rebase and lockfile regeneration in the box; Dependabot alerts; the daily outdated check; a **Check now** action. The same repair loop, given a change to start from and the failures it causes.
3. **Production.** The failed-deployment trigger, config changes, verification by the recorded deployment for the pull request's head, runtime deprecations; Railway and Vercel build and runtime logs as another failure source. Platform settings, such as a missing variable, are listed for a person, or applied through the provider's API only with that person's approval.
4. **Modes per stage.** Once Production makes changes, its mode is saved beside Build's; today only Build carries Autopilot, and the other cards show nothing about it.

## Failure handling and limits

- A controller restart ends a running change as `needs-person` with `Interrupted by a controller restart.`, keeps its branch and pull request, removes its box and directory, and reports it `Needs review` with an open pull request or `Needs attention` without one; nothing is retried on its own.
- A box is removed when its change ends; a branch is never deleted while its pull request is open.
- A repository without a GitHub connection, or a session without write access, records no changes; the first refused write ends the change with the message the gate uses for the same refusal.
- Rate limits and network failures are tried again at the next poll; while CI runs, GitHub may stay unreadable for 15 minutes before the change ends.
- Logs, model output and pull request bodies are redacted through `src/redaction.ts` before storage, and the OpenRouter key reaches only the model provider, never the box, a command, a log or a report.
