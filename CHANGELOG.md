# Changelog

## 0.1.0 — unreleased

The first public release: a local, single-user control room that runs on your machine and binds only to loopback.

### Pipeline

- Repository discovery without executing project scripts or reading `.env` files: packages and configuration, GitHub workflows, jobs and steps, services, workspace dependencies, and Vercel and Railway clues.
- A Pipeline canvas of Source → Build → Production, with Sandbox stages such as Beta and Gamma, stage status Badges, GitHub Actions results for the scanned commit in Build, the repository's deployment targets in Production, and saved transition controls. See [Pipeline interface](docs/pipeline-ui.md).
- A GitHub connection through the local GitHub CLI session or browser device sign-in, repository and branch selection with a managed source checkout, and a Git graph of real commits and branch refs.
- Production lists the deployments GitHub records for the scanned commit, as Vercel, Railway and other Git integrations report them, each by its environment with its state and address: a provider set up on the provider's side, with no file in the repository, appears this way, beside the targets discovered from files.
- Read-only GitHub, Vercel and Railway adapters, failed-run diagnosis, and a starter CI workflow for repositories without one.
- The Autopilot interface: a Badge beside a stage's status with the mode, merge once verified or ask first, or the work under way; a beam along the card while a change runs; each change's steps on the rail with Stop; and Repair on a failed workflow row. It renders the controller's records, and today only Build makes changes, for a managed GitHub source. See [Autopilot](docs/pipeline-ui.md#autopilot).

### Business journeys

- Reviewed browser journeys with ordered business milestones, independent checks and fixed expected outcomes, run as approved Playwright code in a dedicated local Chromium against any application URL, with no model at run time and no automatic retries. See [Business journeys](docs/journeys.md).
- Discovery of journey drafts by a local Browser Use agent from the running application and bounded source context, drafting from a typed or dictated description, and review before anything runs.
- Journey code: Playwright's generator agent, run by OpenCode, writes a reviewed journey's actions as a draft beside the approved code. A person approves it, seeing the code or its diff, after it passes three runs and a control run with every write blocked, including what a page sends over a WebSocket once the journey acts, in which a reviewed check fails. A control run that a write could get around is inconclusive rather than missed. See [ADR 0001](docs/adr/0001-gate-runs-approved-playwright-code.md).
- Code approved without the four runs of a verification, as it was after a single passing run before verification existed, loads as a draft, and a control run verifies only after its three passing runs, so a gate never runs unverified code. A draft keeps its latest verification's record, so the verdict outlives the run history, and a verification holds its twin from its first attempt to its last.
- Run-unique values: journey code types data with the run's token, `journey.run`, and a reviewed check names it as `{run}`, so a control run never passes on a value an earlier run stored. Text checks also read the values the application put in visible form fields; approvals record the check version their control run was caught under. See [Run-unique values](docs/journeys.md#run-unique-values).
- A stage's sign-in page, where `journey.signIn()` signs in when the application URL shows no sign-in form; discovery records where its account signed in. Code generation first checks that the test account can sign in, before any model call.
- Parallel journeys with shared-data scheduling, test accounts, skip and stop, live frames, recordings and one controller-owned verdict.
- App-wide OpenRouter model settings.

### Twins and the journey gate

- Twins: a Sandbox stage's application environment as a Docker Compose project running the product's actual code, with services from official local or sandbox modes (PostgreSQL, Redis, MongoDB, Mailpit, a real LLM, generated secrets, Supabase, Stripe, Trigger.dev) and `vercel-labs/emulate` where no official mode exists. Stripe takes the user's test keys or a Stripe sandbox that Perpetual creates on request, without a Stripe account, and renews before it expires. Apps run on the Node.js major the repository declares. See [Twins](docs/twins.md).
- Generated twin configs: when a stage's config is still the detected skeleton and App Settings has a model, an agent writes the config from the repository's evidence, and the controller keeps it only once the twin it describes is ready, every app answers and a test account exists. See [Generated twin config](docs/twins.md#generated-twin-config).
- The journey gate: for each push to the target branch, or on **Run now**, rebuild the stage's twin at that commit, replay its reviewed journeys' approved code and report a `perpetual/<stage>` GitHub commit status, with release and promotion to the next stage. A local checkout's gate rebuilds only while the checkout is at the tested commit without uncommitted changes. See [Journey gate](docs/gate.md).

### Build repair

- When the target branch's head fails its GitHub Actions runs, a repair opens: triage without a model sends credential and permission failures to a person and reruns network and deadline failures once; everything else goes to an AI SDK tool loop that reproduces and fixes the failure inside a Docker repair box with no host mount, socket, credential or route to the host, up to four attempts under a cost cap, the last two on the Escalation model of App Settings. See [Build repair](docs/repair.md).
- Change rules before every push refuse credential text, `.git`, submodules, `.github/` and deploy configuration, and hold tests and large changes for a person. The host copy alone commits and pushes, to `perpetual/repair/<sha7>` only, and opens a draft pull request with the failure, diagnosis, change, attempts, models and cost, redacted.
- The pull request merges itself only once its CI and every Sandbox stage's journey gate pass at its exact head, nothing holds it and Build's Autopilot mode is Merge changes; Ask before merging leaves it ready for a person. A merged repair that fails again opens no repair by itself. See [ADR 0002](docs/adr/0002-repairs-merge-after-ci-and-journey-gates.md).
- The agent loop was chosen in a bake-off of six harnesses over 20 repair cases, kept as the dev-only package `bench/repair` with its reports. See [the bench](bench/repair/README.md).

### Other

- `npm run setup` after a clone: installs the dependencies, the interface, one Chromium for both Playwright packages and the browser runtime, fetches the pinned OpenCode release, and says which of Node.js, uv, Docker and the GitHub CLI the machine still lacks. The README opens with a prompt to paste into a coding agent, which runs it and then follows [Onboarding with a coding agent](docs/onboarding.md), whose questions it puts through its own question tool: the model key, connecting GitHub, the branch to gate, what the twin can and cannot simulate, and the Beta environment.
- `perpetual twin --repo PATH`: what a repository's twin would run, from names and paths only: the detected config, each service with its provenance, evidence and inputs, and each app's unwired variables.
- TypeScript in strict mode throughout, run directly by Node.js 24.12+'s type stripping with no build step for the controller; `npm run typecheck` checks both projects.
- An experimental Cua desktop sandbox for desktop applications, through the `perpetual sandbox` CLI. See [Desktop sandbox](docs/desktop-sandbox.md).
- Licensed under AGPL-3.0-only, with a Contributor License Agreement for pull requests.
