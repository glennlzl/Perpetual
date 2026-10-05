# Onboarding with a coding agent

You are a coding agent setting Perpetual up for the person you work with, in the repository they want tested. Perpetual is cloned beside it and `npm run setup` has passed, as the README's Quickstart describes. Their repository stays as it is: Perpetual reads it and clones the branch they choose into its own data directory.

Work through the steps in order; each ends when its check holds. Each **Ask** below is a question for the person: put it to them through your own question tool, one at a time, with the options listed, their own answer always possible, and continue from what they choose. Fill each `<…>` from what you read.

Throughout:

- Run every Perpetual command from the clone, so its `.perpetual` data directory is created there.
- API keys, passwords and sign-ins are theirs to enter, in Perpetual's interface or their browser; the values, and their `.env` files, stay unread.
- Journeys are reviewed, approved and run by a person in the interface. Your work ends when the environment is ready.

## The controller API

The interface's own API, at the address of the link `serve` prints (`http://127.0.0.1:4317` by default). Every request carries the header `x-perpetual-secret` with the controller's launch secret, which you read from the clone's `.perpetual/launch-secret`. Pipeline and environment calls carry `repoPath`, the `pipeline.repoPath` of `GET /api/pipeline`: the managed clone's path once a source is chosen. Bodies are JSON; a refusal is `{ "error": "…" }` with a 4xx status, and says what to do. A `409` that also carries `"sourceBusy": true` came while a source change was being saved: send the same request again shortly.

## 1. Start the controller

In the clone, `node src/cli.ts serve --repo <their repository>`, kept running in the background. It prints a link, `http://127.0.0.1:4317/#secret=…`, that signs the person's browser in and opens the interface: whenever a step sends them to the interface, give them that link. Done when `GET /api/state` answers and you have the link.

## 2. The model key

A model writes the twin config, drafts journeys and writes their code; runs use none.

**Ask:** Perpetual needs an OpenRouter API key (https://openrouter.ai/keys). Open `<link>`, then Settings, and save the key there.

- Saved: continue.
- Continue without a model: the twin is built from the detected config, and no journey is drafted until a key is saved.

Done when `GET /api/settings/model` reports `capabilities.provider: "openrouter"` and `modelConfigured: true` (a model from another provider writes no twin config, draft or code), or they chose to continue without.

## 3. Connect GitHub

Read `GET /api/github/connection`. With `connected: true`, go to step 4.

**Ask:** Connect your GitHub account to Perpetual? It reads the repository through the account and reports a commit status on each push to the branch it gates.

- Use `<account>`, signed in with the GitHub CLI on this machine (offered when `authenticated: true`): `POST /api/github/connect` with `{}`.
- Sign in in the browser: `POST /api/github/auth/start` with `{}`, then read `POST /api/github/auth/status` with its `{ "id": … }`. Once `status` is `pending`, give them its `userCode` and `verificationUrl`, and read on until it is `complete`, then `POST /api/github/connect`. On `error` or `expired`, give them its `error`; on `cancelled`, which carries none, tell them the sign-in was cancelled; then ask again.
- Not now: stop here, since every later step needs the connection, and tell them the interface's **Connect GitHub** does the same.

Done when `GET /api/github/connection` says `connected: true` and names the `account`.

## 4. The target branch

From their repository, read the GitHub repository (`git remote get-url origin`), the branch checked out and the remote's default branch.

**Ask:** Which branch should Perpetual gate? On every push to it, the twin is rebuilt at that commit and the approved journeys run before the commit moves on: the branch you deploy to production from.

- `<default>`, the remote's default branch (recommended).
- `<checked out>`, the branch checked out here (offered when it differs).
- Another branch: they name it.

When the repository holds more than one application, or the application lives in a subdirectory:

**Ask:** Which directory holds the application to test?

- `/`, the repository root.
- `<directory>`, one option per application directory the repository has.

Then `POST /api/source/github` with `{ "repository": "<owner>/<name>", "branch": "<branch>", "rootDirectory": "<directory>" }`. Done when the response holds `source` and `pipeline`; keep `pipeline.repoPath`.

## 5. What the twin will run

In the clone, `node src/cli.ts twin --repo <pipeline.repoPath>` prints JSON computed from names and paths only, with nothing run. Tell them, in their application's terms:

- `config.apps`: the apps the twin starts, and how.
- `services`: each dependency Perpetual supplies, with its `fidelity` (`actual`: the real service; `official-sandbox`: the vendor's local mode or sandbox; `emulate`: vercel-labs/emulate, and `config.services.emulate.services` names the vendors) and the `evidence` that found it.
- `unwired`: for each app, the variables its code reads that no service provides, with the file and line of the first read. Read those lines and name the integration behind each variable. The config agent gives a secret the app makes for itself a generated value, and another app's address its URL; a third-party API stays unsimulated, its variable empty, and a journey that reaches it fails or needs review, never passes.

For each service with `inputs`:

**Ask:** `<service title>` needs `<input labels>`. How should the twin get them?

- I enter them under the stage's **Services → Connect** once the environment exists.
- Perpetual creates them for me, there too (offered when `provision` is true; for Stripe, a sandbox without an account).
- Leave it: the service stays blocked, and a journey that reaches it fails or needs review.

Then:

**Ask:** Create the Beta environment? It builds the twin with Docker, which takes minutes the first time, and uses your OpenRouter key once to write the twin config.

- Create it.
- Not yet: stop here, and tell them **Create Beta environment** on the stage card does the same later.

## 6. Create Beta

`GET /api/pipeline`: use its Sandbox stage (`kind: "sandbox"`), or add one with `POST /api/pipeline/action` and `{ "repoPath": …, "action": "add-stage", "name": "Beta" }`. Then `POST /api/environments/create` with `{ "repoPath": …, "stageId": … }`, which returns the `environment` and its `id`. Read `GET /api/environments?repoPath=…&stageId=…` until that environment's `status` is `ready`, `failed` or `cleanup_failed`, reporting its `step` as it changes:

- `ready`: report the `apps` with their `url` and each service's `status`. A `blocked` service lists its `missing` inputs: point them to **Services → Connect** in the stage card, as they chose in step 5.
- `failed`: give them the `error` and the `step` it failed at.
- `cleanup_failed`: give them the `error`, the `step` and the `cleanupError`. Its processes could not be confirmed stopped, so the environment stays until it is deleted.

## 7. Hand over

With the twin ready, Perpetual drafts journeys from it. Tell them: review each draft under the stage's **Integration tests**, then **Generate code**, **Verify code** and **Approve code** from its menu; a push to the target branch then reports `perpetual/Beta` on the commit, which branch protection can require. Done.
