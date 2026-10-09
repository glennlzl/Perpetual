# Twins and the journey gate

Status: implemented. Behaviour is documented in [Twins](../twins.md) and [Journey gate](../gate.md).

## Decisions

- Web twins run the product's actual code under Docker Compose. The Cua desktop is only for desktop applications.
- Each external dependency comes from the vendor's official simulation or local mode first, then [`vercel-labs/emulate`](https://github.com/vercel-labs/emulate), and anything else is decided case by case. There are no hand-written API mocks or mock model servers.
- Reviewed journeys are a CI/CD gate that runs on every push to the target branch and on a manual re-run, not an optional schedule.
- Perpetual never branches on a particular product. A product's twin config, fixtures and journeys are data.

## Twin

A twin is a generated Docker Compose project plus a `.env` file. It runs the product's actual app code and the services that code depends on. The runtime writes `compose.yaml` and `.env` (mode 0600) under `<dataDir>/environments/<id>/twin/`, runs each service's setup, runs the install, fixtures and each app's build as one-shot steps, then runs `docker compose up --wait`. Teardown runs `docker compose down --volumes` plus each service's teardown, removes the containers interrupted one-shot commands left, running `down` again when it removed any, and confirms that none of the twin's volumes remain. Compose already handles ordering (`depends_on`) and health checks, so Perpetual does not reimplement either.

- Apps run the repository's own code from the source snapshot on a Node image of the major the repository declares, else the current LTS. The user's checkout is never mounted.
  - A one-shot `source` service copies the snapshot into the twin's own `workspace` volume, and the install, apps, repository-code services and command fixtures run from that volume. Writing dependencies and build output through a host bind mount is several times slower on Docker Desktop.
  - Package managers keep downloads in a package cache that the twins of one repository share: an external volume, `perpetual-package-cache-<digest>`, named from a digest of the repository's identity (its pipeline key), which Perpetual owns and which deleting a twin keeps. Another repository's twins never mount it. pnpm's store is named there explicitly.
  - A repair gate's twin builds a pull request head no person has reviewed, so its cache is its own: an empty volume of its project, like `workspace`, removed with it, so nothing that code writes reaches a later twin. The `source` service mounts it too, so Compose creates it before a command fixture mounts it by name.
  - Verified local install/build archives are separate from package downloads and live in owned Docker volumes, with private metadata through `src/store.ts`. `local-build-identity.ts` binds commit, filtered source contents and filesystem identity, frozen installation, immutable image/platform, and, for builds, resolved variables and effective commands. The runtime copies a matching archive into a fresh workspace; unknown host outputs are never assumed to match. Independent service setups overlap source preparation and matching install restoration; placeholder dependencies still wait for their providers. Ownership writes are serialized, and failure cancels and joins the started work before cleanup. Only service-free, fixture-free builds are eligible for complete build reuse. With services, installation can be reused but builds run again against fresh state. Repair twins never consume or publish these archives. See [Reusing local builds](../twins.md#reusing-local-builds) for eligibility and lifecycle limits.
  - Each twin records how long every preparation step took, so a slow or failed twin shows where its time went.
  - Each app's build is a one-shot Compose service under its own profile, like the install, run once before any app starts, with its own time limit and exit code. The app's container only starts the app, so its health check's start period is minutes: an app that never answers below 500 fails the twin then, not at the command's time limit.
- Ports are allocated upward from a base in a block per twin and published on 127.0.0.1.
- Internal `url` placeholders use `http://host.docker.internal:<port>`. Browser-consumed URLs explicitly use `publicUrl`, which selects `http://127.0.0.1:<port>` for either an app or a service's named port. App links use loopback too. Perpetual's Chromium keeps its Docker-host mapping for older plans, but ordinary host browsers need public addresses; saved plans and service outputs are never rewritten from variable-name prefixes.

## Services

Each supported service is one file, `src/twin/services/<id>.ts`, in a shape similar to `vercel-labs/emulate` packages. Adding a service means adding that file and registering it.

```js
export default {
  id: 'mailpit', title: 'Mailpit', fidelity: 'actual',          // actual | official-sandbox | emulate
  detect: { packages: ['nodemailer'], env: [/^SMTP_/] },           // how a repository shows it needs this service
  includes: [],                                                  // optional: services it already runs, e.g. supabase: ['postgres']
  inputs: [],                                                    // values the user supplies once, e.g. a Stripe test key
  provision: { inputs: [], run: async ctx => ({ values, details }) }, // optional: creates the inputs on the user's action
  setup: async ctx => ({}),                                      // optional work before containers start; returns outputs
  containers: ctx => [{ name: 'mailpit', image: 'axllent/mailpit:v1.31.2', ports: { smtp: 1025, web: 8025 } }],
  env: ctx => ({ SMTP_HOST: ctx.host, SMTP_PORT: ctx.port('smtp') }),   // the standard variables it provides
  accounts: async ctx => [],                                     // optional: test accounts [{ id, label, username, password }]
  teardown: async ctx => {},                                     // optional
  describe: { summary, options: { user: '…' }, provides: ['SMTP_HOST'], ports: ['smtp', 'web'] }, // the config author's catalog entry
  validate: options => {},                                       // optional: its setup's option checks, run before anything starts
};
```

- `ctx` has four groups of values:
  - `options`: this service's section of the twin config;
  - `inputs` and `outputs`;
  - addressing: `host`, `port(name)`, `url(name, path)`, `apps` (the twin's app ids), `app(id).url` and `app(id).publicUrl`, and `sharedPort(name, current?)`, the port of a service's machine-wide instance, reserved once in `<dataDir>/twin-services/ports.json` outside every twin's port block;
  - `run(image, args)` for a pinned CLI image, and `exec(file, args, { cwd, env })` for a pinned CLI on the host that drives Docker itself, with `env` set over the controller's environment, which it otherwise inherits. The Docker socket is never mounted into a container.
- Inputs are test credentials only. They are validated by pattern, stored locally (mode 0600), never sent to the client and reused across twins. The low-level twin runtime represents a missing input as a **blocked** service and never substitutes for it. Pipeline preparation checks declared required inputs before starting services or builds and stops with their names; a runtime-reported blocked dependency also prevents environment readiness. Business journeys keep their own verdicts.
- A service may declare `provision: { inputs: [{ name, label, default? }], run }` to create its inputs on the user's explicit action. `run(ctx)` gets `{ inputs, docker(args, { timeoutMs }), tempDir }`, where `tempDir` is a private, empty 0700 directory removed afterwards, and returns `{ values, details: { expiresAt, claimUrl?, account? } }`. `default: 'git-email'` pre-fills an input from `git config --global user.email`.
  - `values` are the service's own inputs, checked by their patterns like a manual save. The record `{ inputs, expiresAt, claimUrl, account, provisionedAt }` is kept apart in `<dataDir>/twin-provisions.json` (0600).
  - A manual save of that service's keys ends the record and replaces every value it provided, so none outlives it or pairs with another account's keys.
  - Values whose record has expired (`expiresAt` today or earlier, UTC) are never used, so the service is blocked.
  - Only that explicit action provisions. Creating a twin, a gate's rebuild included, uses the stored values without provisioning again or sending the stored inputs, so an expired service stays blocked until a person provisions it again or saves valid keys. Views and teardowns never provision either.
  - One provisioning runs per service at a time; another request gets 409. The claim link appears only in the local Services view, never in logs, errors, gate reasons or commit statuses.
- **Choosing a source:** if the vendor offers an official simulation or test mode, use it. Use `emulate` only for services that have none. If an official mode needs a user connection that is missing, the service is blocked; it never falls back to `emulate`.

| id | Source |
|---|---|
| `postgres`, `redis`, `mongodb`, `mailpit` | Actual, from the official images. |
| `llm` | Actual. The App Settings OpenRouter key and model by default, or the app's own development values with `source: app`. |
| `secrets` | Actual. Internal secrets that several apps share, generated per twin. |
| `supabase` | Official local mode through the Supabase CLI, an exact dependency that `package-lock.json` locks with its whole tree. The CLI fixes the local database password to `postgres` and binds its own ports; this is accepted because the CLI is the official local mode. |
| `stripe` | Official sandbox: test keys, the user's own or from a sandbox Perpetual creates for them (below), `stripe listen` and `stripe fixtures`, which run once per sandbox and fixtures document and whose exported ids later twins reuse. |
| `trigger-dev` | Official local mode. One shared self-hosted instance per machine; each twin gets a project and a dev worker. `version` is an exact CLI version, built once into a local image; the worker signs in from a 0600 profile file, never from its environment. |
| `emulate` | Only for services with no official simulation: Google and GitHub OAuth sign-in, AWS, Linear, the Vercel API and Apple. |

The Stripe sandbox needs no Stripe account and no pasted key, and it is still Stripe's official hosted sandbox, so the dependency order is unchanged. It is created only on the user's explicit action, Connect → Create sandbox, because the email is sent to Stripe: `stripe sandbox create --email <email> --non-interactive` in the pinned `stripe/stripe-cli` image, against a fresh empty config in `tempDir`, with a 90-second timeout and telemetry off. The CLI prints a JSON object with a restricted `rkcs_test_` secret key, a publishable key, a claim URL, an account id and an expiry date; the sandbox expires after 7 days unless it is claimed. If the CLI cannot provision, it falls back to a browser login, and with a key already in its config it does nothing, so anything but the expected object fails with one fixed message; the CLI's output holds keys and is never shown. The restricted key covers `stripe listen`, fixtures, Checkout, subscriptions, the billing portal and webhooks; test clocks and the balance API need a claimed sandbox's full keys, entered with Connect → Use keys.

Services with official test modes get their own files as they are needed, never an `emulate` section: for example Twilio (test credentials), Clerk, Okta and Auth0 (development instances), Resend (test addresses) and Slack (a development workspace).

## Twin config

One config per stage, stored as data. Detection proposes a skeleton, an agent may write the rest (see [Generated twin config](#generated-twin-config)), and the user reviews it. For a Next.js app with Supabase and Stripe:

```yaml
services:
  supabase: { directory: backend/supabase, users: [{ id: owner, email: owner@example.test }] }
  stripe:   { webhook: "{{apps.api.url}}/stripe/webhook" }
  llm: {}
  mailpit: {}
install: { directory: ., command: pnpm install --frozen-lockfile }
apps:
  web: { directory: web, build: pnpm build, start: pnpm start, port: 3000,
         env: { NEXT_PUBLIC_API_URL: "{{apps.api.publicUrl}}" } }
  api: { directory: api, start: pnpm start, port: 8080 }
fixtures:
  - { service: supabase, sql: seed/twin.sql }
```

- An app variable that has the same name as a service's standard variable, such as `STRIPE_SECRET_KEY`, is filled automatically. Other names map explicitly to service variables or addresses. Use `{{apps.<id>.publicUrl}}` and `{{services.<id>.publicUrl.<port>}}` for browser requests, and the existing `url` forms for container requests, based on the source that consumes the value.
- `{{services.<id>.url.<port>}}` is a service's address on one of its named ports, such as Supabase's `api`. Ports are allocated before any setup, so an address adds no setup order and is kept whether or not its service is blocked. An address on a port the service never uses fails the twin's preparation.
- Setup runs in the order that `{{service.VAR}}` placeholders imply. Circular references are rejected when the config is saved.
- A service option named `env` is an environment, like an app's: a variable that references a blocked service is left out. Any other option that references a blocked service blocks its service too.
- Supabase edge functions: `functions: { directory?, env?, noVerifyJwt? }`.
  - `supabase start` serves the project's `supabase/functions`, or `directory` when the repository keeps them elsewhere.
  - `env` is written to the functions' env file (mode 0600).
  - Functions listed in `noVerifyJwt` accept requests without a JWT, such as a vendor's webhook.
  - A webhook that a function receives uses the address, never a variable, because the function's env needs the webhook's signing secret:

```yaml
services:
  supabase: { functions: { env: { STRIPE_WEBHOOK_SECRET: "{{stripe.STRIPE_WEBHOOK_SECRET}}" }, noVerifyJwt: [stripe-webhook] } }
  stripe:   { webhook: "{{services.supabase.url.api}}/functions/v1/stripe-webhook" }
```

- Supabase Auth: `auth: { siteUrl?, redirectUrls? }`. Auth's Site URL, where a browser goes when a sign-in or email link names no other address, is the `publicUrl` of the twin's only app unless `siteUrl` names another; with several apps and no `siteUrl` it stays the project's. `redirectUrls` replaces the project's `additional_redirect_urls`.

- Fixtures run after services are ready and before apps start.
- Test accounts come from a service's `accounts(ctx)` hook, which runs once services are ready and before the install and fixtures. Supabase creates its `users: [{ id, email, emailConfirmed?, metadata? }]` through its local Auth admin API.
  - Each account gets a generated password, stored only in the twin's own state file (mode 0600) and redacted from its output.
  - Environment and browser views list accounts as id, label and username only.
  - A run or exploration uses the chosen account; with no choice it uses the first, so automatic gate runs need no input. One account forces serial journeys.
  - Rebuilding a twin replaces the passwords.
- `install` (optional) runs once in its directory, as a one-shot Compose service under its own profile, after services are ready and before fixtures and apps, since command fixtures such as seed scripts need workspace dependencies. Detection proposes it when two or more apps share one workspace lockfile, and removes that install from their builds.

## Generated twin config

Detection alone does not give a new user a working twin: it finds services and apps but not the wiring, such as app variables mapped to service variables, test accounts, seed data, required secrets, or an edge function's variables and webhook route. An agent writes that wiring as data, and the controller verifies it by building the twin. This is the split of [ADR 0001](../adr/0001-gate-runs-approved-playwright-code.md): AI authors, and a deterministic runtime executes.

- When: a person's Create on a stage whose config is still detected, with an OpenRouter model in App Settings. Without a model, creation builds the detected config. Opening a page, restarting the controller and a gate never generate; a gate uses the saved config, else the detected one.
- Before authoring a detected stage with no draft, the manager offers verified generated configs from sibling stages at the same pipeline and commit. Only configs still matching a successful non-repair environment and without a donor draft qualify. The runtime compares their source hashes with the copied execution snapshot, rejects ambiguity, and validates the config against the current service registry. A match skips authoring but still provisions and verifies a separate twin, saving its original provenance only after readiness. A failed reuse can become the destination's draft through the same saved-generated-config failure path. Existing environment retention bounds these candidates; there is no additional cache store or running pool.
- `PERPETUAL_TWIN_AUTHOR=structured` is the default (`src/twin/config-author.ts`), with provenance `perpetual-config@1`. Detection still supplies the skeleton. The controller prepares a bounded, read-only evidence packet and the service catalog; the model has no tools and returns only JSON-encoded edits at permitted paths plus unresolved blockers. `src/twin/config-decisions.ts` applies edits to the original draft and validates the resulting config, references, IDs and service options. Reserved paths, credential literals, unsupported data and unresolved configuration choices produce no candidate. Missing catalogued credential values do not prevent wiring their placeholders; they block preparation. The author preserves existing startup commands and works from bounded evidence, without having to establish every call path or business flow. An omission note alone is not a blocker.
- `src/twin/config-evidence.ts` supplements the cached repository digest with actual cited source snippets and manifests, without another model-directed search. The packet is at most 32 KiB, with at most 48 files of 128 KiB each, parallel reads and a cooperative three-second collection limit. Complete source reads are redacted before line selection and clipping; traversal, links, private paths, binary files and oversized files are omitted. Explicit omission notes keep partial evidence from implying complete dependency or callback coverage.
- The runtime shares 30 seconds of configuration-authoring allowance across one creation's invocations, charging evidence preparation and elapsed authoring work before passing the remainder to the next invocation. An invocation makes at most two model calls: the initial decision and, when a local validation error and remaining time permit, one correction using the same original draft and evidence. The correction stays within the apps, services or other top-level sections the failed decision touched. Each request has at most 20 seconds or the remaining allowance, with SDK retries and automatic provider fallback disabled. Blockers, provider failures, incomplete responses, credentials and deadlines are terminal; there is no implicit agent fallback.
- That allowance is not a 30-second readiness guarantee or a measured success rate. Source copying, Docker availability, image pulls, service setup, installation, builds and health checks remain separate operations with their own limits. Required cancellation and cleanup may extend observed wall time. A config returned within budget still has to build a real twin and pass the usual availability checks.
- The environment persists authoring `configTimings`: milliseconds for `evidence`, `context`, `model`, `validation` and `cleanup`, with attempt, call and outcome metadata. Model calls add reported input, output and reasoning token counts and time to first output when available. Timing records contain no prompts or secrets and do not replace the environment's preparation `timings` or journey results.
- The preparation loop remains the controller's, with at most four attempts and a bounded Docker availability check before each. Attempts 1–2 use the Settings model and attempts 3–4 use its saved Escalation model, or the Settings model when none is saved; structured invocations still consume the same remaining allowance:
  1. The structured author returns a locally validated candidate, or an explicitly selected agent harness writes `twin.json` in its private workspace. A terminal author refusal ends the loop immediately.
  2. The controller applies `validateTwinConfig`, then each service's `validate` and its described option names, before preparing anything.
  3. Before preparation, the controller rereads required inputs for the validated candidate. Missing inputs stop creation without a repair attempt and preserve a typed `pendingInputs` draft containing the config and author provenance. A person's Retry validates and prepares that candidate without a model lookup, including after restart; gates continue using saved plans. The pending candidate becomes a saved generated plan only after readiness, while a subsequent real config failure replaces the pending state with scoped repair feedback. Saved verified plans remain saved when their inputs are unavailable.
  4. The environment's own twin is prepared with the usual ownership, cleanup and steps (`Writing twin config (attempt n of 4)`, `Preparing twin`, …). A failed preparation records the failed step, identified app, service, install or fixture, its error and the last 150 lines of the failed containers' logs, redacted of the model key and every secret input. The failed twin is torn down before another attempt. A Docker engine failure ends generation without another paid attempt or a draft attributed to config.
  5. A structured runtime retry is permitted only for an existing app identified by a `build`, `healthy` or `answers` failure, and may edit that app only. Unsupported service, fixture or account failures and missing scope stop before a model call. The failed draft stores trusted repair scope separately from feedback text; a refusal or restart preserves it. Old feedback without scope metadata cannot authorize broad regeneration.
  6. It counts when the twin is ready, every app answers its address below 500, and a test account exists when a ready service can create one. Only then is the config saved as the stage's plan with `provenance: { generatedAt, harness, model, attempts }`. A failed completed candidate remains a draft; opening a page or restarting the controller never resumes paid work.
  7. A terminal refusal or the fourth failed preparation ends creation with its failure and retained draft. For explicit agent harnesses, processes whose termination cannot be confirmed leave `cleanup_failed` and ownership until a person deletes the environment.
- Deeper exploration is an explicit operator choice: `PERPETUAL_TWIN_AUTHOR=opencode` uses the shared OpenCode harness (`src/agents/opencode.ts`); `PERPETUAL_TWIN_AUTHOR=loop` uses the AI SDK tool loop (`src/twin/author-loop.ts`). Each keeps its existing private workspace, 15-minute and 100-step limits, redaction, cancellation and source-integrity checks. The workspace holds `repo/` (an author-only source copy), `twin.json` (the draft), `feedback.md`, `EVIDENCE.md` and `TWIN.md` (format, rules and service catalog). OpenCode can read, search and list files and edit `twin.json` only; all paths outside the project are denied, git metadata is kept beside it, and the controller refuses any other file change. Neither explicit harness is selected automatically after a structured refusal.
- The author must keep the repository's own commands unless evidence establishes a change, wire variables by their actual browser or container use, preserve fixtures and service wiring, use official service modes and report unresolved concrete configuration choices as blockers. Required credential values are checked by the controller before preparation and never inferred from a redacted prompt. A valid config or an HTTP response never substitutes for business journey acceptance.
- The stage's Services show one `Generated` Badge; there is no config editor.

## CI gate

- **Watch.** The controller polls the target branch head through the GitHub connection, with an ETag, every 60 seconds while it runs, and offers a manual **Run now**. There are no inbound webhooks and no public URL.
  - Only a managed GitHub source is watched, and only with the connected account. The first head seen for a branch or account is a baseline, not a push.
  - **Run now** tests the watched head of a managed source, otherwise the scanned commit. A twin copies a local checkout as it is on disk, so its gate rebuilds only while the checkout is at that commit with no change the copy would take (ignored files and those the snapshot never copies aside, and a package manager's config that differs only in the credential lines the copy removes); otherwise it needs release with what to do.
- **On a new commit:**
  1. Wait for Build: the commit's own GitHub Actions runs on the target branch must pass before anything moves. Until then the gate is `waiting-build`, or `build-failed` when Build did not pass; both are rechecked while the controller runs, and neither starts a twin or a journey. A commit with no push or dispatch run 15 minutes after a push or Run now queued it needs release instead; later stages count from the same time. See [Journey gate](../gate.md#what-a-gate-does).
  2. Update the managed source copy to that commit in place (fetch it, then reset), so environments stay attached to its path. The user's own checkout is never changed. The move waits until every twin of the pipeline has copied the source: a create admitted but not yet recorded counts, and so does a twin whose preparation still reads the checkout, as generating a twin config or building a generated one does until it settles.
  3. Rebuild the stage's twin: delete the stage's twins that hold resources, create a new one (a new snapshot, fresh service data, fixtures, accounts) and wait for its browser preparation, which points an automatic application URL at it.
  4. Run the reviewed, selected journeys' approved Playwright code against the rebuilt twin, with no model and no automatic retries. A journey without current approved code needs review; draft code never runs in a gate.
  5. Record the gate per stage and commit in `<dataDir>/gates/state.json`.
- Gates run one at a time, the furthest stage first, so a promoted commit finishes before a newer push moves the source. A stage busy with a person's run, a code generation or verification, or an environment operation keeps its gate queued and is retried every 10 seconds without holding back other stages.
- If a newer commit arrives while a gate runs, the current gate finishes and only the newest pending commit runs next. The skipped commits are recorded as superseded.
- **Verdicts:**
  - `waiting-build` while Build has no runs yet, is running or cannot be read, and `build-failed` when it did not pass; neither can be released;
  - `passed` only when the run passed;
  - `failed` only when a journey failed;
  - everything else needs release, with its reason: a commit with no push or dispatch Build run 15 minutes after a push or Run now queued it, blocked or needs-review journeys, skipped journeys, a cancelled run, a run that stopped without a failed journey, no reviewed journeys (nothing is rebuilt), a twin that could not be rebuilt, an application URL that is not the rebuilt twin, and a gate interrupted by a controller restart.
- **Commit status** `perpetual/<stage>` through the GitHub API, posted only with the connected account, under the stage's current name, a commit run again after a rename included. Every gate whose status changed since it was reported is reported, wherever it is stored; the 50 most recently updated are retried after a failed report, except a refusal GitHub would repeat (HTTP 403, 404 or 422), which waits for **Run now**, the gate's next status or another connected account:
  - `pending` "Waiting for Build" while waiting for Build, and `failure` "Build did not pass" for a failed Build;
  - `pending` "Running" while rebuilding or running;
  - `success` for passed, `failure` for failed;
  - blocked or needs-review stays `pending` with "Needs release" until a person releases it in Perpetual, then becomes `success` ("Released by <user>");
  - queued gates report nothing; a superseded gate reports only to end a `pending` status it left, with `error` "Superseded by <sha7>", or "Superseded" when it records no newer commit (a stopped repair's gate, or one an earlier version superseded). A failed report is kept on the gate and retried; it never holds back the gate or its promotion.
- **Release** needs the connected GitHub account. A failed gate is never released.
- **Promotion:**
  - A passed or released gate starts the next Sandbox stage at the same commit. A commit older than one that already reached that stage is recorded there as superseded.
  - Production shows "Ready" only when every Sandbox gate for that commit is passed or released.
  - Perpetual does not deploy Production. Existing deployment workflows can require the commit status.
- Only reviewed, selected journeys run, from approved code. Drafts, draft code, discovery and code generation never run automatically, and a code verification holds its stage, so a gate waits for it; see [Playwright journeys](playwright-journeys.md).

## Interface

- The pipeline shows a commit moving through the stages, driven only by real records: Source shows the scanned commit, Build shows GitHub Actions results for it, a Sandbox stage shows its twin rebuilding and its journeys running, then the gate result, and Production shows readiness.
- The stage card Badge shows the gate state (`Waiting for Build`, `Build failed`, `Queued`, `Running`, `Passed`, `Failed`, `Needs release`, `Released`) with the commit; its Tooltip gives the reason or a status report error. Production's Badge shows `Ready` with the commit.
- The stage footer offers **Run now**. Needs release offers a shadcn Alert Dialog **Release** action. Failed never offers release.
- When a gate moves the managed source, the page reloads the scan and keeps the test workspace and its drafts.
- Each twin service's provenance appears as a compact Badge in the stage card's Services list, with no explanatory copy.

## Verification

- Unit tests cover Compose file generation, placeholder resolution, secret redaction, port allocation, the gate state machine (supersede, release, promotion) and commit status mapping.
- An opt-in integration test runs a disposable Compose project with one app and Mailpit.
- Acceptance on a real application means a Beta twin with its actual services, such as local Supabase, the LLM service and a Stripe sandbox, and its reviewed journeys run from a real push. Unavailable dependencies stay blocked.
