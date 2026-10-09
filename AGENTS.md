# Model policy

- Use GPT-6 Luna (`openai/gpt-6-luna` on OpenRouter) for every real model call made for this workspace, including benchmarks, configuration and journey authoring, build repairs, retries and escalation. Keep both the primary and escalation settings on Luna. If it is unavailable, stop and report the blocker; do not substitute another model.
- When selecting a model for a Codex subagent, use `gpt-6-luna`. This policy remains in force until the user explicitly changes it.

# UI preferences

Read `docs/pipeline-ui.md` before changing the Pipeline canvas, stage cards, Build and Production, the branch selector or the Git graph.

- Keep interface copy minimal: titles, field labels, actions, concise state and actionable errors. Add explanatory paragraphs, helper copy, subtitles or redundant labels only when the user explicitly asks for them.
- Use actual shadcn components for interface controls, and keep the neutral black and gray theme.
- Keep authentic provider brand colors; in the dark theme, invert only monochrome marks.
- Show a stage's configuration or execution status in a native shadcn Badge to the right of the stage title, never in a separate status subtitle row.
- The pipeline inspector has no Details tab.
- Enter Pipeline with the left navigation collapsed; users expand it manually.
- Keep one Pipeline graph layout for every entry URL. Place a prominent native shadcn branch Select at the upper left of the canvas, listing the repository's actual branches through the GitHub connection. Never infer Production from a branch name.
- Let stage cards grow with visible content: wrap long labels and use natural height without internal scrolling. Place following stages from measured widths, preserve zoom during nested expansion, and keep manual Fit View. The canvas toolbar holds zoom and Fit View only, with no Jump to stage control.
- Present stage actions and nested workflow steps on a continuous vertical rail, with circular marks on the left and content on the right, composed from the official Item, Separator and Collapsible components.
- Build and Production start expanded, showing their provider rows; every provider group and its nested content starts collapsed.
- Build holds only the workflow runner, labelled GitHub Actions. Production holds the actual deployment targets the repository configures, such as Railway and Vercel: they are its production deployments, never Build steps. A discovered application directory, such as `frontend`, stays in the underlying scan and is never promoted to a deployment step.
- Render backend delivery groups as supplied: infer no provider groups and hide no deployment targets. Keep workflow runners distinct from deployment targets, and preserve explicit configuration and binding evidence. The deployments GitHub records for the scanned commit join their provider's group in Production as the reporting app's account; a record for another commit never counts, and none changes the stage Badge.
- A stage with an Autopilot record carries it: a Badge beside the status Badge shows its mode, `Autopilot` (merge once verified, the default) or `Ask first`, or the work under way, and opens a native shadcn Dropdown Menu for the mode. A change under way lights the Magic UI Border Beam around the card, lists its steps on the rail, expanded, and offers Stop; a failed workflow row offers Repair for the watched head's failed run. The interface shows only the modes and changes the controller records and fabricates no progress; today only Build records any, for a managed GitHub source.
- Group GitHub workflow actions under one provider card, with a nested native shadcn Collapsible list of workflow, job and step names. Offer no workflow selection or detailed YAML settings.
- Keep discovered Vercel project previews in a separate expandable Vercel provider group in Production, while every workflow stays under GitHub Actions. Discovery does not imply authorized cloud access.
- The Railway drawer holds only configuration file links, with no read-only Build and Deploy field sections.
- Offer Add test only in Sandbox stages, such as Beta and Gamma.
- Beta and Gamma cards show complete business journeys, each with its own queued, running or result state. Clicking a journey focuses its expanded live card; Review and Edit stay explicit actions. Environment readiness never implies test success.
- The environment inspector has exactly two tabs, Integration tests and Runs, and no environment settings page or header gear. Build it from shadcn Sheet, Tabs, Item, Collapsible, Button and Badge primitives, without explanatory subtitles.
- Sandbox stage settings only rename the stage. The stage card footer holds the single delete entry: deletion is confirmed, and the stage's owned sandboxes are cleaned up before the stage is removed.
- Model and API key configuration lives on the app-wide Settings page, reached from the main sidebar and independent of repository or stage selection. Target URL editing stays beside the application link, and the optional test focus stays with Generate.
- App Settings is OpenRouter-only: label the credential OpenRouter API Key, link to API key creation, and offer a native shadcn model Select backed by the actual eligible OpenRouter catalog, with a default preselected, and a second Select for the Escalation model build repairs escalate to, with the same model preselected. Expose no model ID text input, provider endpoint or Advanced section, and keep a simple layout without nested cards.
- Branch relationships use the actual `@jalco/commit-graph` community registry component inside the existing non-modal right-hand shadcn Sheet. Show real repository commits and parent hashes, never sample data or inferred ancestry; keep provenance and label local or shallow history. Custom branch cards, PR arrows and a centered modal do not replace it.
- A managed GitHub source copy loads complete commit ancestry and remote branch refs before showing the Git graph; a depth-one source scan is not graph history. The graph defaults to the selected branch's history. Never fetch into or change the user's original checkout to repair a managed copy.
- An unconnected pipeline shows Connect your GitHub with one Connect GitHub button bearing the GitHub mark, which opens the Connect GitHub dialog directly. There is no Configure repository entry.
- Connect GitHub opens a native shadcn Dialog offering a verified existing account and browser sign-in, then loads real repository and branch choices. A repository remote is never treated as an authorized account, and CLI tokens never reach the frontend.

# Business testing scope

Read `docs/journeys.md` before changing journey discovery, review, runs, code generation or the live view.

- Product-facing integration tests follow complete, coherent user journeys, from entry and prerequisites through the final business outcome. Prioritize end-to-end completion across the application and its dependencies.
- Generate cases around a user's goal, not isolated clicks, individual functions, internal schemas or implementation details. Preserve session and business state between the steps of one journey.
- For example, in a SaaS app a journey may sign in, create and configure a workflow, save and reopen it, run it, and see the account's credits decrease. Intermediate checks support the journey; an opened page or a successful click alone does not prove completion.
- API, database and external-service observations support the user's outcome where needed; they never replace exercising the journey. A missing account, fixture or integration stays an explicit blocker, never a simulated business pass.
- Prefer two to four complete product journeys, each with ordered business milestones. Keep the count honest: sign-in, page access and internal schema checks are milestones or checks, not journeys of their own.
- Show the actual browser journey live. Keep implementation and unit tests separate from customer-facing business cases and their acceptance results.
- Each journey owns its browser session and live viewport. Queued and active journeys can be skipped; completed evidence is kept, and resources are released only after browser cleanup. Motion follows actual execution; never fabricate progress or video.
- Browser isolation does not reset server state. Journeys that share an account or data run exclusively; parallel scheduling needs explicitly reviewed independent test data, and a single supplied test account forces serial execution.
- A newly ready environment prepares integration-test drafts when a model, a browser runtime and an unambiguous application URL are available, preserving existing cases and reviews. Generated cases are never approved or run automatically, and opening a page or restarting the controller never starts paid discovery.

# Generality

- Perpetual builds twins and journeys for almost any system.
- Add no product-specific code, heuristics, file-path weights, prompts or fixtures for a particular application.
- A specific product is only acceptance data. Its plans, fixtures and journeys are generated or configured per repository and stored as data, never branched on in code.
- Tests, fixtures and docs use neutral example names, such as `acme/app`, never a real private repository, deployment, run ID or local path.

# CI/CD gate

Read `docs/gate.md` before changing `src/gate`.

- Business journeys are a CI/CD gate, not an optional schedule.
- On every push to the target branch, and on a manual re-run, the Perpetual controller:
  1. waits for GitHub Actions Build to pass at that exact commit, for a managed GitHub source; until then the gate is `waiting-build`, or `build-failed` when Build did not pass, or `needs-release` when no push or dispatch run arrives within 15 minutes of the push or re-run, and starts no twin or journey;
  2. rebuilds the Sandbox stage's twin at that commit, starting with the first Sandbox stage, such as Beta;
  3. runs the approved code of the stage's reviewed, selected journeys;
  4. reports a `perpetual/<Stage>` GitHub commit status that branch protection can require.
- Gate rule:
  - A failed journey blocks promotion.
  - Blocked and needs-review results require a manual release.
  - Passed promotes: the commit moves to the next Sandbox stage.
- Only reviewed journeys with approved code run automatically. Generated drafts, draft code and discovery never run on their own.

# Build repair

Read `docs/repair.md` before changing `src/repair`, and `docs/architecture/autopilot.md` before adding a kind of change.

- A repair fixes one failed build of the target branch through a pull request on `perpetual/repair/<sha7>`. Its agent's tools act only inside a Docker repair box with no host mount, socket, credential or route to the host; the host copy alone commits and pushes, as the connected account, and only that branch.
- Triage runs without a model: credential and permission failures need a person, network and deadline failures rerun once. Change rules run before every push: credential text, `.git`, submodules, `.github/` and deploy configuration are refused; tests and large changes are held for a person.
- A repair merges itself only when CI and every Sandbox journey gate pass at its exact head, nothing holds it and Build's Autopilot mode is `Autopilot` (ADR 0002). A repair gate never moves the source, promotes or makes Production Ready. A restart never starts paid work, and a merged repair that fails again needs a person.
- The bench under `bench/repair` is a dev-only package with its own dependencies; it imports the product's repair modules and never joins the root build or tests.

# Twin dependencies

Read `docs/twins.md` before adding or changing a twin service in `src/twin/services`.

- Twins run the product's actual code. Supply each external dependency in this order:
  1. The vendor's official simulation or local mode: local Supabase, the Stripe sandbox with test clocks and `stripe listen`, Mailpit, and a real model for AI features.
  2. `vercel-labs/emulate`, when no official mode exists.
  3. Anything else, decided case by case.
- Never hand-write API mocks or mock model servers. Record each dependency's fidelity (`actual`, `official-sandbox` or `emulate`) with run results.
- Web twins use Docker Compose. The Cua desktop image is for desktop applications only.

# Browser and Cua integration

Read `docs/architecture/browser-first.md` before changing how journeys run, and `docs/adr/0001-gate-runs-approved-playwright-code.md` before changing how journey code is generated, verified, approved or run. Read `docs/desktop-sandbox.md` before changing the desktop sandbox (`src/sandbox`, `integrations/cua`); it records the reviewed upstream revision, local and Fleet differences, and SDK and Driver pins.

- Business tests run in an independent local Chromium worker against a user-selected URL. Docker and Cua are optional application and desktop runtimes, not prerequisites.
- A browser case is a reviewed goal, preconditions, milestones and fixed expected outcomes. Gate and manual runs execute Playwright code that an agent generated from the reviewed journey; the agent writes code and discovers journeys but never acts in a run. Checks come only from the reviewed case, never from generated code. AI-written code is a draft until a person approves it after 3 passing runs and a caught write-blocked control run, and there are no automatic retries. Finished code without independent passing checks is not a business pass. A fresh browser session does not reset backend state.
- Application environments run as Compose twins (`src/twin`). Cua stays behind the `perpetual sandbox` desktop CLI; never route an unconfigured local sandbox to Fleet, `Localhost` or the host's Cua Driver. The browser worker does not use Cua Driver.
- Container API readiness, a successful click or a recording is never a passing business assertion. A running twin provides no business oracles; readiness is not a pass.
- Preserve cleanup failures and resource ownership. Never copy production credentials, personal browser profiles, host mounts or the Docker socket into a guest.

# Code

- Node 24.12+ runs the TypeScript directly (`node src/cli.ts`). Write erasable syntax only, keep `npm run typecheck` at zero errors, and validate untrusted input (HTTP bodies, files, worker events, model output, env) as `unknown`.
- Secrets leave text through `src/redaction.ts` only: `redact` for every secret shape, `hide` for the values a process was given, `failureText` to redact before clipping. Add a shape to its catalogue rather than a pattern at a call site.
- Every gh call runs through `src/github-cli.ts`: its environment, runner, reply parser, repository and commit id patterns and failure classifier live there once; a caller keeps only its own words for a failure.
- Read-only git and a docker CLI pinned to a local engine run through `src/process.ts`; the twin runtime's docker inherits the environment on purpose, and the Git graph keeps its stricter git reader.
- A manager's state file is kept, read and written through `src/store.ts` (private directory, guarded read, atomic write, save queue); the stage id, the in-progress statuses and the owned-environment rule come from `src/environments/usage.ts`. Each manager keeps its own limits, words and restart recovery.
- The shapes a route replies with live once, in `contract/`: the controller implements them and the client imports them with `import type` only. Declare a new reply shape there, never twice.

## Agent skills

### Issue tracker

Track requirements, specs and implementation tickets in this repository's GitHub Issues. Before reading or publishing tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Triage with the five canonical role labels. Before triaging an issue, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `CONTEXT.md` and `docs/adr/`. Before exploring or changing domain concepts, read `docs/agents/domain.md`.
