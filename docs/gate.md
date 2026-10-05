# Journey gate

The journey gate decides whether one commit may leave one Sandbox stage. For each new commit on the target branch, and on a manual **Run now**, the controller:

1. waits for GitHub Actions Build to pass at that exact branch commit;
2. rebuilds the stage's [twin](twins.md) at that commit;
3. replays the approved code of the stage's reviewed, selected [business journeys](journeys.md) against it, with no model;
4. reports the verdict as a GitHub commit status, `perpetual/<stage name>`, that branch protection or a deployment workflow can require.

A failed journey fails the gate. Blocked and needs-review results wait for a person to release them. A passed or released gate moves the commit to the next Sandbox stage. The gate never deploys anything.

The design is recorded in [Twins and the journey gate](architecture/twins-and-gate.md) and [ADR 0001](adr/0001-gate-runs-approved-playwright-code.md). The code is in `src/gate/`.

## Requirements

- A managed GitHub source: a repository and branch chosen in **Source → Settings** (see [Provider connections](providers.md#choose-a-source)), and a connected GitHub account that may write commit statuses.
- For a managed source, a GitHub Actions workflow that runs on `push` to the target branch, or is dispatched on it. A commit without such a run, such as one built only by a pull request or skipped by CI, waits for Build until a newer push or a dispatched run at that commit.
- A Sandbox stage with a twin config and at least one reviewed, selected journey.
- An application URL that points at the stage's twin. When a new twin becomes Ready with one web-frontend app, or only one app, and a person has not chosen another URL, the URL points at it automatically.
- Playwright's Chromium (`npx playwright install chromium`) and [approved code](journeys.md#journey-code) for each journey. The journeys' runs need no model; Perpetual uses the model to draft journeys and write their code, and an application that calls a model does so through its twin's `llm` service.

**Run now** also works on a local checkout without a managed source; it then tests the scanned commit and cannot move the source to another one. A twin copies a local checkout as it is on disk, so the gate rebuilds only while the checkout is at that commit with no change the copy would take (ignored files and those the snapshot never copies aside). Otherwise the gate needs release and says what to do, such as `The checkout has uncommitted changes, which a twin would copy. Commit or discard them, then run the gate.`

## Watching the target branch

While the controller runs, it polls the head of the managed source's branch through the connected account every 60 seconds, with an ETag, so an unchanged head costs a `304` and no rate limit. There are no inbound webhooks and no public URL.

- The first head seen for a branch, or by another connected account, is a baseline, not a push, and queues no gate of its own. While the saved head is another branch's or another account's, the branch's gates wait for that poll. A first Sandbox stage gate it finds still pending for another commit, such as one queued before a branch switch or by the previous account, gives way to the head, which is queued in its place as after a push, rather than move the source back. Heads are saved, so a push made while the controller was stopped is picked up by the first poll after it starts; a gate queued before the stop may run first, and the newer head runs after it.
- A new head queues a gate for the first Sandbox stage.
- **Run now** refreshes the managed source's head as its connected account before queuing the stage's gate; a failed read, disconnected account, GitHub [unreachable](providers.md#github) or changed source/account refuses the request with its reason, without falling back to a saved head or the scanned commit. Saved heads remain push baselines. An unmanaged local source uses its scanned commit. It runs a finished gate again.
- Without a Sandbox stage no gate moves the source, so the managed copy follows the branch head: the watcher moves and rescans it whenever the head differs from the scanned commit, and waits for its next poll while another source change or a stage removal is under way.

## What a gate does

Before moving the managed source or creating a twin, the gate reads the branch's GitHub Actions runs for its exact commit. Only `push` and `workflow_dispatch` runs backed by a repository workflow count. The newest run of each workflow replaces its older runs; every counted workflow must succeed, conclude neutral or be skipped, and at least one must succeed or conclude neutral. Pull-request, scheduled, other-branch and other-commit runs cannot authorize the target branch's gate. The reader checks all pages, up to 1,000 runs, and incomplete evidence never passes.

No runs yet, a running workflow, a disconnected account, GitHub [unreachable](providers.md#github) or an unreadable response leaves an already queued gate **Waiting for Build**, with the reason. Failed, cancelled, action-required and all-skipped builds show **Build failed**. Both states are rechecked while the controller runs, so a successful rerun at the same commit can proceed without another push. Neither state offers Release, neither starts a journey, and a newer push supersedes it. A restart resumes these checks. An already-finished journey is never retried this way; a manual release rechecks Build before accepting the release.

Build admission reads Actions runs, never the `perpetual/*` commit statuses its own journeys must produce. A deployment workflow that waits for these statuses must start after the gates, rather than join the branch's Build runs; otherwise it would wait on its own prerequisite. This admission covers the workflow runs GitHub has reported, not a configured list of required workflows that have yet to appear. Repair gates keep their existing CI-first admission through the repair controller, and may verify the repair while the target branch is waiting for Build. Local, unmanaged checkouts retain manual gates without GitHub CI.

1. **Prepare.** A stage busy with a person's run, a code generation, a code verification or an environment operation, or a pipeline with a twin still reading the source (one being created, including a creation accepted but not yet recorded, or one whose preparation still reads the checkout, as generating a twin config does), keeps the gate queued; it is retried every 10 seconds without holding back other stages. The managed source copy then moves to the commit in place (fetch that commit, then reset), so environments stay attached to its path, and the repository is scanned again; GitHub unreachable as the copy moves also keeps the gate queued and retried, never a verdict. Your own checkout never changes. A newer commit that reaches the stage meanwhile supersedes the gate before its twin is rebuilt. If a health check takes a twin between admission and rebuild, the gate stays queued, unless a newer commit is queued at the stage, which supersedes it. If it takes the newly ready twin before the browser starts, the gate waits for browser admission and rechecks the target URL, as it does while a person's operation in the stage or a model settings save holds it then. Neither wait retries a journey that already started.
2. **Check for journeys.** With no reviewed, selected journeys the gate needs release (`No reviewed journeys.`) and nothing is rebuilt.
3. **Rebuild.** The stage's twins that hold resources are deleted, and a new one is created: a new snapshot, fresh service data, fixtures and test accounts. Existing dependency credentials are reused while valid. An expired provision, such as a [Stripe sandbox Perpetual created](twins.md#a-stripe-sandbox-without-an-account), stays blocked until a person creates another sandbox or supplies valid test keys; a gate never renews it or sends its stored email. The twin is built from the stage's saved config, or the detected one when there is none; a gate never generates a config. The gate waits for the twin to be Ready, which needs every app to answer and a test account where a service can create one, and for its browser preparation.
4. **Run.** The application URL must be the rebuilt twin, both when the gate checks it and when the browser admits the run (`Set the application URL to the rebuilt twin.` otherwise, and a run the browser admitted for another application is stopped). The stage's reviewed, selected journeys run their approved code with the default concurrency and the twin's first test account, and no automatic retries. The gate never runs draft code: a journey without approved code, or whose approved code is stale because its reviewed journey or the check version changed, needs review without a browser, while the other journeys still run.
5. **Record.** The verdict is saved per stage and commit in `<data>/gates/state.json`. A save that fails keeps the verdict and is tried again at each poll.

Gates run one at a time, the furthest stage first, so a commit finishes its way through the stages before a newer push moves the source. When a newer commit reaches a stage, that stage's older queued gate is superseded; a gate already running finishes first. An older commit that reaches a stage after a newer one is recorded there as superseded.

## Verdicts

| Gate | When |
| --- | --- |
| `waiting-build` | Build is still running, has no runs, or its evidence cannot be read. No twin or journey has started. |
| `build-failed` | Build did not pass. It is checked again for a successful rerun; it cannot be manually released. |
| `passed` | The run passed. |
| `failed` | A journey failed. |
| `needs-release` | Anything else, with its reason: a blocked or needs-review journey (including one without current approved code), a skipped journey, a cancelled run, a run that stopped without a failed journey (for example a browser runtime error), no reviewed journeys, a twin that could not be rebuilt, an application URL that is not the rebuilt twin, or a gate interrupted by a controller restart. |
| `released` | A person released a gate that needed release. |
| `superseded` | A newer commit reached the stage first. |

## Commit status

Statuses are posted through the connected account's GitHub CLI session, with the context `perpetual/<stage name>` under the stage's current name. Renaming a stage changes the context of its later gates, a commit run again after the rename included.

| Gate | Status | Description |
| --- | --- | --- |
| Waiting for Build | `pending` | Waiting for Build |
| Build failed | `failure` | Build did not pass |
| Rebuilding or running | `pending` | Running |
| Passed | `success` | Passed |
| Failed | `failure` | Failed |
| Needs release | `pending` | Needs release |
| Released | `success` | Released by `<login>` |

Queued and superseded gates report nothing. Every gate whose status changed since it was last reported is reported, however long ago it ran. A source switch during an account lookup cannot redirect a report to another repository; it remains pending for its own source. A report that fails is kept on the gate, and the 50 most recently updated gates are retried with each poll; a failed report never holds back the gate or its promotion. Without a connected account the gate records `Connect GitHub to report commit status.`; while GitHub is unreachable it records the reason, and the report is tried again at the next poll.

## Release and promotion

**Release** needs the connected GitHub account, and while GitHub is unreachable it answers with the reason; it is offered only for a gate that needs release, and a failed gate is never released. The status becomes `success` with `Released by <login>`.

A passed or released gate queues the next Sandbox stage (for example Gamma) at the same commit. Production shows **Ready** for the newest commit that every Sandbox gate passed or released. A gate never deploys by itself. A separate, explicitly configured [release](releases.md) can deploy that commit after a person confirms it; existing deployment workflows can also require the commit status.

## Repair gates

A [build repair](repair.md) whose pull request passed CI runs each Sandbox stage's gate at the pull request head, in pipeline order, through the same one-at-a-time queue, after every queued gate of the target branch. Such a repair gate rebuilds the stage's twin from a checkout Perpetual owns at that head, runs the reviewed, selected journeys' approved code under the same verdict rules, and reports `perpetual/<stage name>` on the pull request head, so a required check can wait for it. It never moves the managed source, never promotes, never supersedes a target-branch gate or is superseded by one, and never makes Production Ready; the stage keeps showing its target-branch gate, while its twin is the pull request head's until the next gate. A repair gate that needs release is released through the same API with the pull request head, which reports success there and promotes nothing. The repair merges only once every gate passed at its exact head.

## Requiring the status on GitHub

The gate tests commits after they reach the target branch, not pull request heads. Require its status where commits are promoted from that branch:

- Protect a release branch and require `perpetual/<stage name>` on pull requests into it from the target branch. The pull request's head is a commit the gate tested. A `Needs release` status stays `pending`, so the check blocks merging until a person releases it in Perpetual.
- Or have a deployment workflow read the commit's status before it deploys.

A status appears in GitHub's list of checks only after it has been reported once.

## Interface

The Sandbox card's Badge shows the gate state (`Waiting for Build`, `Build failed`, `Queued`, `Running`, `Passed`, `Failed`, `Needs release`, `Released`) with the short commit, and its tooltip gives the reason or a status report error. The card footer offers **Run now**, and **Release** opens a shadcn Alert Dialog for a gate that needs release. When a gate moves the managed source, the page reloads the scan and keeps the test workspace and its drafts.

## API

| Method and route | Input |
| --- | --- |
| `GET /api/gate` | Returns `repoPath`, the scanned `sha`, the gate each Sandbox stage shows, `production` and any `watchError`. |
| `POST /api/gate/run` | `repoPath`, `stageId` |
| `POST /api/gate/release` | `repoPath`, `stageId`, `sha` |

## Limits

- The gate runs only while the local controller runs, and only for the active source and branch.
- Only reviewed, selected journeys run, from their approved code. Drafts, draft code, discovery, code generation and verification never run on their own, and verification runs never reach the gate.
- A run's verdict is only as strong as its journeys' independent checks; see [Business journeys](journeys.md#verdicts).
