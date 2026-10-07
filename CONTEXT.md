# Perpetual

## Language

**Project** — A configured repository and source root whose delivery and business verification Perpetual manages. A Project initially owns one Pipeline and remains when that Pipeline is removed.

**Pipeline** — A Project's connected stages through which its source, delivery and business verification progress. Disconnecting GitHub retains the Pipeline; removing it cleans up its owned environments and test workspace.

**Production branch** — A Pipeline's explicitly chosen GitHub branch from which Perpetual may request a Release. It is saved independently of the branch being viewed and never inferred from a repository default or a branch name. Its current commit still needs Build and every Sandbox journey gate to permit deployment.

**Stage** — A named point in a pipeline, such as Source, Build, Beta or Production. A stage's environment readiness and test results are separate states.

**Build** — The fixed stage holding the repository's workflow runner, GitHub Actions. A passing workflow is not a deployment.

**Release** — An explicit request to deploy one tested commit through a configured GitHub deployment handler. It binds the confirmed commit and target to the ordinary Sandbox gates and follows the resulting deployment ID. Gate readiness permits a request; only the handler's reported success makes the release Deployed. An uncertain request is observed, never automatically repeated, until it ends or a person abandons it, which ends only Perpetual's record of it.

**Production** — The fixed last stage, holding the deployment targets the repository configures, such as a Railway service or a Vercel project; those are its production deployments. Beside them it lists the deployments GitHub records for the scanned commit, as the app that made them, such as a Vercel or Railway Git integration, reported them. Configuration alone never verifies a target or a release, and a record is the provider's report, not the journey gate's verdict.

**Autopilot** — A stage's standing permission to make changes for the repository on its own. In its default mode a change merges once the stage's own verification passes; in _Ask first_ it opens a pull request and waits for a person. Source has none.

**Change** — One piece of work Autopilot does for a stage, reactive to a failure, such as fixing a build or a deployment, or proactive, such as updating dependencies or resolving a dependency conflict: a pull request on a branch of the pipeline's own, with the steps that led to it, verified by the stage before it merges. A change never turns a failed gate into a passed one; the merged commit runs the stage again. A build repair is Build's change; Build is the only stage that makes any today.

**Stage removal** — A confirmed operation that cleans up a Stage's owned environments before removing the Stage. It continues independently of the page that requested it; incomplete cleanup retains the Stage and its resource ownership for retry.

**Managed source** — Perpetual's own copy of a connected GitHub branch, which the pipeline scans and shows at its scanned commit; the user's own checkout is never fetched or moved. A Journey gate moves it to the commit it checks out. A pipeline without a Sandbox stage has no gate, so the copy follows the branch head its watcher reads, once no other source change or stage removal is under way.

**Test workspace** — The current source and stage's integration cases, test configuration, application environments and run history, together with changes the user has not yet saved. Changing source must not carry those changes into another source's workspace.

**Business journey** — A coherent sequence of user actions leading to a meaningful business outcome, preserving session and business state along the way. Avoid treating an isolated click or internal function check as a journey.

**Business milestone** — An ordered part of a reviewed journey, such as saving and reopening a workflow or verifying a credit change. A milestone completes only when its reviewed checks pass after its actions; completing its actions alone is not a passing result.

**Journey queue** — Bounded execution of the reviewed journeys in a run. Each journey has its own browser worker. Shared application data creates an exclusive barrier; independent test data permits parallel workers. Skipping stops the owned worker but does not roll back application side effects.

**Application callback binding** — A person's reviewed association of one application id with an exact local hostname alias. For the stage's unambiguous selected application in a ready owned twin, it follows the current published port; a fixed external site never does. Its scope, application and hostname identify the permission for code verification and approval.

**Reviewed case** — A business journey with a user-approved goal, preconditions, expected outcomes and independent checks. Generating a draft does not approve or execute it.

**Journey code** — The Playwright actions of one reviewed case, with no checks of its own: the reviewed checks are evaluated from the case at run time. A case has at most one _approved_ code and one _draft_ beside it. Generated or saved code is always the draft and never replaces the approved code by itself; a person approves a draft after its verification passed, seeing the code or its diff. A gate runs approved code only; a person's run may try a current draft when no approved code is current. Editing the reviewed case makes both stale. Code references call it the journey spec.

**Verification** — The runs a draft must pass before it can be approved: three ordinary runs of exactly that code, then a control run. It holds only for that code, the reviewed case and its reviewed POST-read policy, so the same code saved for changed checks is unverified. It stops at the first run that does not pass, holds its stage so a gate waits, and a controller restart ends an unfinished one as cancelled.

**Control run** — A verification's last run, which blocks state-changing requests and, after the journey acts, its page's socket sends, except while the fixture signs in. It is caught only by an eligible reviewed outcome check failing after a blocked change and a successful fresh read of the judged page, with no later blocked request, failed read or unguarded write. A missing acknowledgement or an unreadable page alone cannot qualify. A control run never counts as the journey's current status; [Verification](docs/journeys.md#verification) defines its evidence.

**Reviewed POST read** — One fixed application URL and complete JSON request body that a person has reviewed as read-only. Discovery and the control run admit only that exact POST, not other operations at the same endpoint. Its policy identity binds verification and approved code; editing it requires verification again.

**Run-unique value** — A value a journey's code types with its run's token, `journey.run`, and that a reviewed check names as `{run}`. A fresh browser session does not reset application data, so a fixed value an earlier run stored would still satisfy a later run's check with nothing saved; a run-unique value is new in every run, a control run included. The token only fills in the reviewed check's text and never changes which check runs.

**Check version** — The fixture's check semantics and required control evidence, recorded with a verification's attempts and approval. An approval under an older version is stale: its code and history remain, and a person can reuse the code, verify it under the current version and approve it again. Restarting the controller starts none of that work.

**Expected outcome** — A fixed acceptance condition for a reviewed case. Neither generated code nor a run can change it; a run's reviewed checks back it.

**Agent observation** — The browser agent's reported evidence while it discovers journeys. It is not an independent check or proof of an external side effect, and no run reports one.

**Independent check** — A reviewed condition the fixture evaluates on the live page from the approved case, never one the journey's code contains. Current browser checks observe page text, the values the application put in visible form fields, URLs and numbers; they do not independently establish database or payment outcomes.

**Test run** — One execution of reviewed cases' journey code against an application, retaining the approved case snapshot and its results. Each case keeps its browser session throughout its journey; a fresh session does not reset application data. There are no automatic retries.

**Sign-in page** — The page of a stage's application where a journey's test account signs in when the application URL shows no sign-in form, such as a landing page. A person sets it, or discovery records where its account signed in while the stage has none; discovery never replaces a person's value.

**Journey gate** — The decision whether one commit may leave one Sandbox stage: the stage's twin is rebuilt at that commit and its reviewed, selected journeys run their approved journey code; a journey without it needs review. A failed journey fails the gate; any other incomplete result needs a person's release. A passed or released gate moves the commit to the next Sandbox stage, and Production is Ready only for a commit every Sandbox gate passed or released. A gate reports a GitHub commit status; it never deploys. A _repair gate_ judges a repair's pull request head the same way, over a checkout Perpetual owns: it never moves the source, promotes, supersedes a target-branch gate or makes Production Ready.

**Repair** — An agent's fix for one failed build of the target branch, delivered as a pull request. It merges itself only when CI and every Sandbox journey gate passed at its exact head, no change rule held it for a person and the Build stage's Autopilot mode is `Autopilot` rather than `Ask first`; credential and permission failures never become repairs. A repair's merge that fails again needs a person, never another automatic repair. Avoid calling a rerun that passed a repair: it is recorded as flaky.

**Build queue** — Commits waiting for Build to finish its current change, in the order Perpetual observed them. New commits keep their place without interrupting active work; a waiting commit is checked before a repair starts.

**Repair box** — The Docker container that is a repair agent's whole workspace: a copy of the failing commit, where every agent tool runs. It has no host mount, Docker socket or credential, and no route to the host: it reaches public addresses only through its egress proxy. Only the host copy it came from pushes, and only the repair branch.

**Application environment** — The running application and dependencies targeted by a test. Its availability alone does not mean a business journey passed. Users call it a _twin_, such as the Beta twin.

**Twin service** — One supported dependency of an application environment, such as a database, payment processor, job runner, model or mail server, defined in one file. The file says how the service is detected in a repository, which test credentials the user supplies once or, where the vendor allows it, Perpetual creates on the user's request, how it starts and which standard variables it provides. A service uses the vendor's official simulation or test mode when one exists and `emulate` only when none does. Product-specific settings live in the twin config, never in a service. Avoid calling a service a mock.

**Generated twin config** — A Sandbox stage's twin config written by an agent from the detected skeleton and the repository, when a person creates the environment of a stage whose config is still detected. It becomes the stage's config only once the twin built from it is ready, every app answers and, where a service can, a test account exists; it records its provenance. Four failed attempts leave it as the stage's draft instead, and so does a generated config that later fails to build for a reason in the config, with its failure: the next generation a person starts begins from that draft. A gate rebuilds from the saved config and never generates one. A repair gate, at a pull request head that may never merge, changes neither the stage's config nor its draft.

**Owned guest** — An isolated execution environment created and identified by Perpetual, whose operations and cleanup belong to that environment. It is optional for browser tests against an existing URL.
