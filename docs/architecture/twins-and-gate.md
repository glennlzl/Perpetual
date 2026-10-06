# Twins and the journey gate

Status: implemented. Behaviour is documented in [Twins](../twins.md) and [Journey gate](../gate.md).

## Decisions

- Web twins run the product's actual code under Docker Compose. The Cua desktop is only for desktop applications.
- Each external dependency comes from the vendor's official simulation or local mode first, then [`vercel-labs/emulate`](https://github.com/vercel-labs/emulate), and anything else is decided case by case. There are no hand-written API mocks or mock model servers.
- Reviewed journeys are a CI/CD gate that runs on every push to the target branch and on a manual re-run, not an optional schedule.
- Perpetual never branches on a particular product. A product's twin config, fixtures and journeys are data.

## Twin

A twin is a generated Docker Compose project plus a `.env` file. It runs the product's actual app code and the services that code depends on. The runtime writes `compose.yaml` and `.env` (mode 0600) under `<dataDir>/environments/<id>/twin/`, runs each service's setup, then runs `docker compose up --wait`. Teardown runs `docker compose down --volumes` plus each service's teardown, removes the containers interrupted one-shot commands left, running `down` again when it removed any, and confirms that none of the twin's volumes remain. Compose already handles ordering (`depends_on`) and health checks, so Perpetual does not reimplement either.

- Apps run the repository's own code from the source snapshot on a Node image of the major the repository declares, else the current LTS. The user's checkout is never mounted.
  - A one-shot `source` service copies the snapshot into the twin's own `workspace` volume, and the install, apps, repository-code services and command fixtures run from that volume. Writing dependencies and build output through a host bind mount is several times slower on Docker Desktop.
  - Package managers keep downloads in a package cache that the twins of one repository share: an external volume, `perpetual-package-cache-<digest>`, named from a digest of the repository's identity (its pipeline key), which Perpetual owns and which deleting a twin keeps. Another repository's twins never mount it. pnpm's store is named there explicitly.
  - A repair gate's twin builds a pull request head no person has reviewed, so its cache is its own: an empty volume of its project, like `workspace`, removed with it, so nothing that code writes reaches a later twin. The `source` service mounts it too, so Compose creates it before a command fixture mounts it by name.
  - Each twin records how long every preparation step took, so a slow or failed twin shows where its time went.
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
  - addressing: `host`, `port(name)`, `url(name, path)`, `app(id).url`, and `sharedPort(name, current?)`, the port of a service's machine-wide instance, reserved once in `<dataDir>/twin-services/ports.json` outside every twin's port block;
  - `run(image, args)` for a pinned CLI image, and `exec(file, args, { cwd, env })` for a pinned CLI on the host that drives Docker itself, with `env` set over the controller's environment, which it otherwise inherits. The Docker socket is never mounted into a container.
- Inputs are test credentials only. They are validated by pattern, stored locally (mode 0600), never sent to the client and reused across twins. A service with a missing input is **blocked**: its variables are left out, and nothing substitutes for it. A journey on the twin keeps its own verdict, since nothing tells whether the missing service caused it.
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
| `supabase` | Official local mode through the Supabase CLI. The CLI fixes the local database password to `postgres` and binds its own ports; this is accepted because the CLI is the official local mode. |
| `stripe` | Official sandbox: a test key, the user's own or from a sandbox Perpetual creates for them (below), `stripe listen` and `stripe fixtures`. |
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
- The loop is the controller's, at most four attempts, after a bounded check that Docker's engine answers; attempts 1–2 use the Settings model and attempts 3–4 use its saved Escalation model, falling back to the Settings model when none is saved:
  1. The agent writes `twin.json` in its workspace.
  2. `validateTwinConfig`, then each service's `validate` and its described option names. An invalid config is the next attempt's feedback.
  3. The environment's own twin is prepared from it, with the usual ownership, cleanup and steps (`Writing twin config (attempt n of 4)`, `Preparing twin`, …). A failed preparation that names an app, a service, the install or a fixture is feedback: the failed step, its error and the last 150 lines of the failed containers' logs, redacted of the model key and every secret input. The twin is torn down before the next attempt. One that names none, such as Docker's own failure, ends generation with its error and no draft.
  4. It counts when the twin is ready, every app answers its address below 500, and a test account exists when a ready service can create one. The config is then saved as the stage's plan with `provenance: { generatedAt, harness, model, attempts }`, and the environment continues as any ready environment.
  5. After four failed attempts the environment fails with the last failure. The last `twin.json` and its feedback are the stage's draft, not its plan; the next creation starts from them.
  6. An agent whose processes could not be confirmed stopped, after a time limit or a cancellation, leaves the environment `cleanup_failed`, its error saying so, until a person deletes it, as a browser run's uncertain cleanup does.
- The agent is OpenCode through the harness journey code generation shares (`src/agents/opencode.ts`), in a private workspace: `repo/` (the source snapshot, read-only), `twin.json` (the draft), `feedback.md`, `EVIDENCE.md` (the repository's evidence, names and paths only) and `TWIN.md` (format, rules and a catalog generated from the registry, `src/twin/catalog.ts`). Its `opencode.json` allows reading, searching and listing files and an edit of `twin.json` only, and turns off snapshots, formatters and language servers. Every folder outside the project is denied, and the project's git metadata is kept beside it, so a GPT model's `apply_patch`, whose move checks only its destination, cannot move `twin.json` out of reach. The controller also refuses an attempt that changed any other file in the project, `.git` included. `PERPETUAL_TWIN_AUTHOR=loop` runs Perpetual's own AI SDK tool loop (`src/twin/author-loop.ts`) in the same workspace instead.
- The prompt asks it to make the repository's own apps run against the twin's services, wire each variable the code reads, add test accounts on the auth service the app uses, add fixtures for the main flows' data, list required secrets under `secrets`, never invent a vendor stand-in, and keep the config minimal.
- The stage's Services show one `Generated` Badge; there is no config editor.

## CI gate

- **Watch.** The controller polls the target branch head through the GitHub connection, with an ETag, every 60 seconds while it runs, and offers a manual **Run now**. There are no inbound webhooks and no public URL.
  - Only a managed GitHub source is watched, and only with the connected account. The first head seen for a branch or account is a baseline, not a push.
  - **Run now** tests the watched head of a managed source, otherwise the scanned commit. A twin copies a local checkout as it is on disk, so its gate rebuilds only while the checkout is at that commit with no change the copy would take (ignored files and those the snapshot never copies aside, and a package manager's config that differs only in the credential lines the copy removes); otherwise it needs release with what to do.
- **On a new commit:**
  1. Wait for Build: the commit's own GitHub Actions runs on the target branch must pass before anything moves. Until then the gate is `waiting-build`, or `build-failed` when Build did not pass; both are rechecked while the controller runs, and neither starts a twin or a journey. See [Journey gate](../gate.md#what-a-gate-does).
  2. Update the managed source copy to that commit in place (fetch it, then reset), so environments stay attached to its path. The user's own checkout is never changed. The move waits until every twin of the pipeline has copied the source: a create admitted but not yet recorded counts, and so does a twin whose preparation still reads the checkout, as generating a twin config or building a generated one does until it settles.
  3. Rebuild the stage's twin: delete the stage's twins that hold resources, create a new one (a new snapshot, fresh service data, fixtures, accounts) and wait for its browser preparation, which points an automatic application URL at it.
  4. Run the reviewed, selected journeys' approved Playwright code against the rebuilt twin, with no model and no automatic retries. A journey without current approved code needs review; draft code never runs in a gate.
  5. Record the gate per stage and commit in `<dataDir>/gates/state.json`.
- Gates run one at a time, the furthest stage first, so a promoted commit finishes before a newer push moves the source. A stage busy with a person's run, a code generation or verification, or an environment operation keeps its gate queued and is retried every 10 seconds without holding back other stages.
- If a newer commit arrives while a gate runs, the current gate finishes and only the newest pending commit runs next. The skipped commits are recorded as superseded.
- **Verdicts:**
  - `waiting-build` while Build has no runs, is running or cannot be read, and `build-failed` when it did not pass; neither can be released;
  - `passed` only when the run passed;
  - `failed` only when a journey failed;
  - everything else needs release, with its reason: blocked or needs-review journeys, skipped journeys, a cancelled run, a run that stopped without a failed journey, no reviewed journeys (nothing is rebuilt), a twin that could not be rebuilt, an application URL that is not the rebuilt twin, and a gate interrupted by a controller restart.
- **Commit status** `perpetual/<stage>` through the GitHub API, posted only with the connected account, under the stage's current name, a commit run again after a rename included. Every gate whose status changed since it was reported is reported, wherever it is stored; the 50 most recently updated are retried after a failed report:
  - `pending` "Waiting for Build" while waiting for Build, and `failure` "Build did not pass" for a failed Build;
  - `pending` "Running" while rebuilding or running;
  - `success` for passed, `failure` for failed;
  - blocked or needs-review stays `pending` with "Needs release" until a person releases it in Perpetual, then becomes `success` ("Released by <user>");
  - queued and superseded gates report nothing. A failed report is kept on the gate and retried; it never holds back the gate or its promotion.
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
