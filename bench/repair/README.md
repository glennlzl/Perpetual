# Repair-agent bake-off

This is a reproducible comparison of agent frameworks for Perpetual's build repair agent ([docs/repair.md](../../docs/repair.md)). Each framework makes one repair attempt per case.

What every framework shares:
- the product's repair box, egress proxy and failure context;
- the product's prompt and instructions;
- the product's change rules;
- the same judge;
- the same model gateway, which does all the accounting.

The bench is a dev-only package with its own `package.json`, lockfile, `tsconfig.json` and `node_modules`. The product's dependencies, build and root `npm test` are untouched. It imports product modules from `../../src/repair/*.ts`, and their bare imports (`ai`, `@openrouter/ai-sdk-provider`, `yaml`, `jsonc-parser`) resolve from the root `node_modules`, as the product runs them.

Eight adapters are registered, as [adapters/README.md](adapters/README.md) defines them: on OpenRouter, the baseline `aisdk` and `pi`, `opencode`, `miniswe` and `openai-agents`; on the OpenAI track, `aisdk-openai`, `agents-openai` and `codex`. Every adapter ran the first two paid rounds on 2026-09-25, and the third re-ran the two arms that use the product loop, `aisdk` and `aisdk-openai` ([reports](reports/README.md)).

A run has one provider. OpenRouter is the default, as in the product. The OpenAI track (`--provider openai`) runs bare OpenAI model ids against OpenAI's API through the same gateway, which prices each request from [prices/openai.json](prices/openai.json), since OpenAI reports no dollars. Each adapter declares the providers it runs against and the wire API it speaks to each, and a run refuses the others.

## Setup and tests

```sh
cd bench/repair
npm ci
npm ci --prefix adapters/pi        # the pi adapter's own dependencies (adapters/README.md)
node run.ts setup                  # pulls the box images the corpus picks and node:22-bookworm(-slim) with an empty DOCKER_CONFIG; lists adapter readiness (syncing miniswe's uv environment)
npm run typecheck                  # also type-checks the product modules the bench imports
npm test                           # pure tests: no Docker, no network, no model
BENCH_DOCKER=1 npm test            # plus real boxes: corpus self-check, box confinement, baseline smoke, dry-run pipeline
```

**Docker tests.** They are skipped unless `BENCH_DOCKER=1`. They never set the product's `PERPETUAL_DOCKER_TESTS`. `BENCH_CASES=a,b` narrows the corpus self-check and the dry-run pipeline test. The opencode and codex smoke tests fetch their pinned Linux builds into `.cache/` on first use.

**Resources and credentials.**
- Every container and network the bench creates is labelled `perpetual.owner=repair-bench`, `perpetual.repair=<id>` and `perpetual.data=<data hash>`, and is removed by whoever created it.
- docker always runs with `DOCKER_CONFIG=bench/repair/.cache/docker-config`, an empty `{}`. So the user's credential helper and context are never asked.

## Dry run: the whole pipeline at $0

```sh
node run.ts run --dry-run --frameworks all --cases all --seeds 1
```

**What stands in for the model.** The dry run uses the fake upstream instead of OpenRouter. It is an OpenAI-compatible server on 127.0.0.1 with scripted replies, tool calls, streaming and `usage.cost`.

**What it scripts.** Its solver works for any framework:
1. It runs the failing CI commands through the framework's shell tool.
2. It applies the case's reference patch.
3. It runs CI again.
4. It finishes the framework's way.

**Everything else is real.** Every box, the gateway process, the judge and the report run as in a paid run. `aisdk` solved 8/8 when the core shipped; every adapter then ran the paid rounds ([reports](reports/README.md)). `all` skips an adapter that cannot run here, such as one not installed or without uv or tar, and says so.

**The OpenAI track.** `node run.ts run --dry-run --provider openai --frameworks all --cases all --seeds 1` uses the fake OpenAI (`fake-openai.ts`) instead: chat completions and Responses, JSON and SSE, usage without dollars, and OpenAI's store rules (see below). The model is the price table's first, `gpt-6-luna`, so the report's dollars are what the fake usage would cost at its real prices. `aisdk-openai`, `agents-openai` and `codex` declare `openai`; none of their dry runs has been run, and the solver cannot drive codex yet, whose shell tool is `exec_command` ([adapters/README.md](adapters/README.md#codex)).

## Paid bake-off, run by a person

This needs an OpenRouter key.

**The key.** The controller's App Settings key lives in `<controller data dir>/browser-model.json`. The data directory is `.perpetual/` under the directory the controller was started in, or `--data`. Its `model` and `escalationModel` become the default `--models`.

```sh
cd bench/repair
node run.ts run --key-file /path/to/.perpetual/browser-model.json --frameworks all --seeds 1 --budget 30
node run.ts report --out results/<run folder>
node run.ts cleanup --out results/<run folder>     # only if a run was killed; runs remove their own boxes
```

**Other ways to pass the key.** `OPENROUTER_API_KEY=… node run.ts run --models <id>,<id> …` works as well.

**Where the key goes.**
- The runner deletes the key from its own environment before loading any adapter.
- It hands the key to the gateway process over IPC (or the gateway reads the key file itself).
- The key is never printed, logged, written to a result, or passed into a box.
- Every file the bench writes is redacted with the product's `redact()` and then scrubbed of the key.
- A key file whose `baseUrl` is not OpenRouter is refused.

**Resuming.** Re-running with the same `--out` resumes: judged cells are skipped, and runner errors and budget-skipped cells are retried. A folder holds one provider's run under one set of settings: resuming it with the other provider, or as a dry run of a paid one or the reverse, or with other limits, reasoning, `--provider-only` or prices of its models, is refused before any box or gateway starts.

**Flags:**
- `--provider openrouter|openai` (default openrouter)
- `--frameworks all|aisdk,…` and `--models id,…|settings`
- `--cases all|name,…` and `--seeds N`
- `--concurrency 2`, `--budget 30` (the global hard cap, in $) and `--attempt-cap 0.5`
- `--steps 100` and `--minutes 15`
- `--reasoning default|native|low|medium|high`
- `--provider-only <slug>`
- `--gateway-host <ip>`: a Linux engine's bridge address, so in-box harnesses reach the gateway
- `--out <dir>` and `--dry-run`

### The OpenAI track

This needs an OpenAI API key, and only ever takes it from a key file.

```sh
cd bench/repair
# ~/openai-key.json holds {"apiKey": "sk-…"}: write it in an editor, never on a command line, and chmod 600 it.
node run.ts run --provider openai --key-file ~/openai-key.json --models gpt-6-luna --frameworks all --seeds 1 --budget 30
```

**The key file.** A regular JSON file, not a link, of at most 16 KB, with `apiKey`. `model` and `escalationModel` in it become the default `--models`, as in `browser-model.json`. A `baseUrl`, if present, must be `https://api.openai.com/v1`. An OpenRouter key (`sk-or-…`) or a file whose `baseUrl` is OpenRouter's is refused, and the OpenRouter track likewise refuses an OpenAI key (`sk-proj-`, `sk-svcacct-`, `sk-admin-`), so neither key ever reaches the other provider.

**Where the key goes.** As on OpenRouter: only the gateway process reads it, over IPC or from the file. The runner deletes `OPENROUTER_API_KEY` and `OPENAI_API_KEY` from its own environment before loading any adapter, and never reads `OPENAI_API_KEY`, so an in-process framework cannot fall back to a key of the host's.

**Models.** Bare OpenAI ids that the price table lists: `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `gpt-5.3-codex` (Responses only) and `gpt-5-nano`. An unlisted id is refused before any box starts. `--provider-only` does not apply.

### Budget math

- **Worst case per attempt.** An attempt stops at its cap, plus at most the one request that crossed it.
- **Admission.** An attempt starts only if `spent + reserved + cap ≤ budget`. `reserved` is every open attempt's unspent cap. So total spend stays at or below `budget + concurrency × (cost of one request)`. Once admission fails, the remaining cells are recorded as `skipped: budget`.
- **Full matrix.** 5 frameworks × 2 models × 20 cases × 3 seeds = 600 attempts. At the $0.50 cap that is $300 worst case, but the $30 default budget stops it at about $30. At a typical $0.05–0.15 per attempt, 600 attempts cost about $30–90.
- **Recommended first run.** 1 model × 1 seed, which is 5 × 20 = 100 attempts. That is at most $50 if every attempt hits its cap, which the $30 default budget stops at about $30, and typically $5–15.
- **The OpenAI track.** The same caps and admission hold, on dollars the gateway computes from each response's usage. A request whose usage never arrived (a stream the client abandoned) is recorded as cost `unknown` and not charged, since OpenAI keeps no generation record to recover it from; the report counts such attempts.

## How an attempt runs

For each (framework, model, case, seed), in an interleaved order (seed → case → model → frameworks), shuffled per seed with a fixed PRNG so a budget cut or latency drift falls on every framework alike:

1. **Case preparation**, once per run.
   - The snapshot is materialized as one commit, with a fixed identity and date, on `perpetual/repair/<short>`, as the product's host copy is.
   - Its CI runs once in a throwaway box to capture the real failure. The capture must be the case's stated one, failing first at `meta.failingStep` with a log matching `expect.logRegex`, as the self-check requires: one that is not, such as a registry timeout or a CI that passes, is captured again once, then the case is left out of the run before any paid attempt, and such a capture is never kept for a resume.
   - That failure goes through the product's `getGitHubFailure` (fed by a fake `gh`), then `describeFailures`, `chooseImage`, `repositoryDigest`, and `attemptPrompt` (attempt 1 of 4, no feedback).
   - `cases/<case>/prompt.md` and `failure.json` are kept for audit.
2. **Attempt.**
   - A fresh product repair box starts from the snapshot, in its own data directory.
   - The adapter prepares, untimed.
   - The gateway opens a token with the cap, a deadline and a limit of 120 requests.
   - The adapter runs ONE attempt: 100 steps and 15 minutes by default, with 30 s of grace before the runner aborts it.
   - The gateway closes the token, the adapter's `harnessPaths` are removed, the runner takes `box.diff` (the product's DIFF_SCRIPT), and the box is removed.
3. **Judge**, in a brand-new box from the clean snapshot, never on the macOS host.
   1. Apply the diff (a diff that does not apply fails with `patch`).
   2. Run the product's change rules on the diff and again on what git stages, as the product checks a push:
      - a rejection fails with `rule`;
      - a test change fails with `test-changed`;
      - a size hold, and one for check configuration, is only recorded.
   3. Check the universal guard: no `package.json` `scripts` changed, and no `.npmrc`, which can change how scripts run. What git staged, whether the commit holds a staged `package.json` (`git ls-tree`, which lists nothing for one the change added) and the one it holds are read whole: a read that fails, times out or is cut off is a runner error, never an empty change or an added file.
   4. Check the case's guards.
   5. Add the holdout tests.
   6. Run the CI steps.

   **Success** means all of these hold: the attempt ended at `done`, every CI step exited 0, and nothing was rejected, no test or CI file changed, and every guard held. `passedWithoutDone` is reported separately.

**Recorded per attempt** in `results.jsonl`:
- success, the final reason and the adapter's own reason;
- the gateway's requests, tool calls, tokens, cost and cost sources (`usage`, `generation` or `unknown`), refusals, model violations and providers;
- wall time and setup time;
- diff size;
- rule rejections and holds, guards, and each judge CI step's exit code and time;
- `reproduced`.

**Kept in `attempts/<cell>/`:** `change.diff`, `gateway.json` (the request log, without bodies), `events.json` and `judge.json`.

**The final reason** is a gateway refusal first (cost, budget, requests → steps, deadline → time), then the runner's deadline, then the adapter's reason.

**The report** (`node run.ts report --out …`) covers each framework and model:
- success k/n with a Wilson 95% interval;
- $ per success and per attempt;
- median and p90 time, and median requests and tool calls;
- how attempts ended;
- rule violations and judge failures by CI step;
- cost-unknown attempts.

It then gives a per-case matrix and the unique solves. With 20 cases and a few seeds, differences under about 20 percentage points are noise.

## The model gateway (gateway.ts)

- **Listening and auth.** On 127.0.0.1, one run's provider:
  - OpenRouter: `POST /api/v1/chat/completions` (JSON or SSE);
  - OpenAI: `POST /api/v1/chat/completions` → `https://api.openai.com/v1/chat/completions` and `POST /api/v1/responses` → `https://api.openai.com/v1/responses`, JSON or SSE.

  Anything else gets 404. It authenticates each caller by a random per-attempt token, stored as a hash. Caps, refusals, the model check and the in-box route (`boxUrl` through the relay) are the same for both providers.
- **Rewrites.** It forwards to `https://openrouter.ai/api/v1` with the real key and forces `provider.data_collection = "deny"` and `usage.include = true`. Everything else passes through untouched: messages and their `reasoning_details`, tools, temperature and max_tokens. The response is returned byte for byte.
- **OpenAI's rewrites.** The real key goes to `https://api.openai.com/v1`. Messages, input items and their reasoning items, tools, temperature and max tokens pass through untouched, and the response is returned byte for byte, but:
  - **The store rule.** A Responses request that does not use `previous_response_id` (absent, null or empty) is sent with `store: false`, whatever it said, so OpenAI does not retain it. For a reasoning model (the price table's `reasoning`, every listed model) the gateway also adds `reasoning.encrypted_content` to `include`, so the reasoning items a framework replays still work without stored state. A request that uses `previous_response_id` keeps `store` and `include` as sent. Consequences: a framework must replay whole items (reasoning with its encrypted content) and never `item_reference`s to earlier output; and a `previous_response_id` chain cannot start, because its first request names no previous response and so is not stored. Chat requests keep `store` as sent (OpenAI's default for chat is not to store).
  - **Usage.** A streamed chat completion gets `stream_options.include_usage = true`, without which OpenAI sends no usage. A Responses stream always ends with it.
  - **The tier.** Both wires get `service_tier: "default"`, the Standard tier the table prices, whatever the request or the project's default says.
  - **Refused before forwarding** (400): a model the table does not price, and hosted tools, since OpenAI bills them per call beside the tokens it reports and they reach the network outside the box. Only `function` and `custom` tools, which run in the box, are forwarded; `web_search`, `file_search`, `code_interpreter`, `image_generation`, `mcp` and the like, and chat's `web_search_options`, are not.
- **Reasoning.** `--reasoning default` removes `reasoning`, `reasoning_effort` and `include_reasoning`, so every framework runs the model's OpenRouter default, as the product does. `low`, `medium` and `high` set `reasoning.effort` uniformly. `native` leaves requests as the framework sends them.
  - On OpenAI the policy acts on Responses requests only: `default` removes `reasoning.effort` (keeping `reasoning.summary`), so the model's default applies (medium on GPT-6), and a level sets it. A chat request keeps its `reasoning_effort` under every policy, because GPT-6 Sol and Luna call functions over chat completions only with `reasoning_effort: "none"`, which a chat-wire adapter must send itself.
- **Model.** The request's `model` must equal the attempt's model. Anything else, such as a small or title model, gets 400 and is recorded as a violation.
- **Accounting.**
  - Usage and cost come from the JSON body or the final SSE chunk, as the product's `stepCost` reads them: `usage.cost` plus `cost_details.upstream_inference_cost` for BYOK.
  - When usage never arrived (an abort or a lost chunk), the cost is recovered from `GET /generation?id=`, with 3 tries over 10 s. If that fails too, the request is marked `unknown`.
  - On OpenAI the dollars are computed, from the usage in the JSON body, the final chat chunk or Responses' `response.completed` (also `response.incomplete` and `response.failed`):
    - input = `input_tokens` (Responses) or `prompt_tokens` (chat), which includes cached reads (`…_tokens_details.cached_tokens`) and cache writes (`…_tokens_details.cache_write_tokens`); output = `output_tokens` or `completion_tokens`, reasoning included;
    - dollars = ((input − cached − cache writes) × input rate + cached × cached rate + cache writes × cache-write rate + output × output rate) / 10⁶, with a model's long-context rates for the whole request once input exceeds their threshold (272,000 on GPT-6), times the factor of the tier the response reports (1 for `default`; Flex 0.5, Fast mode 2; a tier the table does not list gets its highest);
    - there is no recovery: a response without usage is `unknown`. `costSource` `usage` means computed from usage on this track.
  - Tool calls are counted once per call id: chat's tool-call ids, and Responses' `function_call` and `custom_tool_call` items by item id, however many events name them.
  - Tokens are recorded as prompt, completion, reasoning, cached and cache writes.
- **Refusals** (HTTP 402, `x-bench-refusal`, which no client retries):
  - `cost`: the attempt reached its cap;
  - `budget`: the run reached its budget;
  - `requests`: more than 120 requests;
  - `deadline`: past the attempt's time limit;
  - `closed`: the attempt has ended.
- **Isolation.** It runs in its own process (`node gateway.ts --ipc`), whose argv and environment hold no key (`OPENROUTER_API_KEY` and `OPENAI_API_KEY` are removed). Under `node --test` it refuses to target openrouter.ai or openai.com.

## The bench box network rule (box.ts, relay.ts)

**The base box.** A bench box is the product's repair box, unchanged:
- an internal network with no route anywhere;
- the egress proxy, which forwards only to public addresses;
- the product's capabilities, no-new-privileges, and limits of 4 GB, 2 CPUs and 1024 processes;
- no mounts, no socket and no host environment;
- the disk watchdog.

**The one addition.** For in-box harnesses only, `attachGateway(port)` adds exactly one endpoint:
- A relay container `perpetual-repair-bench-<id>-gateway` (`node:22-bookworm-slim`, `--read-only --cap-drop ALL --security-opt no-new-privileges --user node`, 128 MB, 0.5 CPU, 64 processes, labelled as the box) sits on a private uplink network of its own, `perpetual-repair-bench-<id>-uplink`, labelled as the box.
- The relay joins the box's internal network with the alias `gateway`, and pipes every TCP connection on port 8080 to `host.docker.internal:<gateway port>`, and nowhere else. A Linux engine gets `--add-host host.docker.internal:host-gateway`.
- The harness is started with `gatewayEnvironment()`: the box's proxy settings, plus `gateway` in `NO_PROXY`. It reaches `http://gateway:8080/api/v1` directly, and the gateway still demands the attempt's token and model and enforces every cap.

**What stays out of reach** (tested in `test/box.docker.test.ts`):
- `host.docker.internal` directly, since the internal network has no route to it;
- `host.docker.internal` through the proxy, which answers 403 because it is a private address, the gateway's own port included;
- `gateway` through the proxy, which answers 403 because it is a private address. So a client that ignores `NO_PROXY` fails closed;
- any other port of `gateway`, since the relay listens on 8080 only;
- any other host listener.

**Removal.** `box.remove()` removes the relay and the uplink before the product's `remove()`.

## Corpus (corpus/)

Each case is a tiny repository snapshot in `repo/`. Its workflow has one job, whose setup action picks the box image as the product picks it:
- **Node 22** (`actions/setup-node@v4`, `node:22-bookworm`): `npm ci`, then `npm test` = `node --test`, with `npm run build` for the TypeScript cases and `npm run lint` for `lint-real-bugs`. `workspace-money-units` is an npm workspaces monorepo whose root runs `npm test --workspaces`, and `npm-peer-eresolve` commits no lockfile and installs with `npm install`.
- **Python 3.13** (`actions/setup-python@v5`, `python:3.13-bookworm`): `python -m unittest discover -s tests -t . -v`, on the standard library only.
- **Go 1.26** (`actions/setup-go@v5`, `golang:1.26-bookworm`): `go vet ./...`, then `go test ./...`, on the standard library only.

Alongside it:
- `meta.json`, which the agent never sees;
- `reference.patch`, which proves the case is solvable;
- holdout tests in `holdout/`, copied into the snapshot only at judge time, so hard-coding fails: `test/holdout/*.test.js` in a Node package, `tests/test_holdout_*.py` for Python, `holdout_test.go` in a Go package;
- `decoys/*.patch`, tempting hacks the judge must fail.

**Dependencies.** Four cases install packages from the registry, through the egress proxy: `typescript` 5.9.3 in the three TypeScript cases, and `@biomejs/biome` 2.5.14 with its platform packages in `lint-real-bugs`. Every other Node dependency is a `file:vendor/*.tgz` built from `corpus/_vendor` (a `<name>@<version>` folder, or `<case>/<name>@<version>` for a package only that case uses) by `node corpus/build-vendor.ts`, which also generates each lockfile with the box image's npm 10.9, and skips the Python and Go cases. The tarballs and lockfiles are reproducible byte for byte; three round-2 lockfiles (`workspace-money-units`, `quadratic-merge-budget` and `tz-calendar-dates`) came from the same npm command outside build-vendor.ts, which has not regenerated them yet. The vendored names, and the workspace packages' names, 404 on npm (checked 2026-09-25).

The first eight cases are round 1's. The other twelve were added for round 2, because the first eight could not rank the frameworks ([round 1](reports/2026-09-25-round1.md)).

| Case | Repository | Class | Fails at | Diagnosis | Decoys (judge reason) |
| --- | --- | --- | --- | --- | --- |
| logic-tier-boundary | acme/invoice | logic bug caught by a unit test (`>` vs `>=` at a tier boundary) | Run npm test | test-regression | special-case the tested value (ci) |
| ts-refactor-rename | acme/directory | TypeScript error after a refactor (`name`→`displayName`, `findUser` may return undefined) | Build | build | non-null assertion (ci), strict off (guard) |
| esm-import-path | acme/reports | wrong import path, then a missing export (`formatBytes` kept as an alias) | Run npm test | build | drop the alias (ci) |
| lock-drift | acme/slugs | package-lock.json out of sync with package.json | Run npm ci | dependency | delete the lock (ci), revert the dependency (guard) |
| dep-major-bump | acme/notices | vendored dependency 1→2 with a breaking API (`render`→`compile`, `{{x}}`, strict by default) | Run npm test | test-regression | keep strict mode (ci) |
| esm-cjs-mismatch | acme/config | `"type": "module"` with CommonJS `require`, `module.exports` and `__dirname` left | Run npm test | test-regression | read defaults relative to cwd (ci), drop `"type"` (guard) |
| ts-strict-flag | acme/inventory | `noUncheckedIndexedAccess` exposes three latent bugs in three files | Build | build | non-null assertions (ci), drop the flag (guard) |
| test-trap | acme/ledger | the tempting fix edits the test, but the test is right | Run npm test | test-regression | edit the test (test-changed) |
| workspace-money-units | acme/storefront | cross-package API change in an npm workspaces monorepo (`@acme/money` 2.0 moves to integer minor units; receipts breaks in silence) | Run npm test | test-regression | revert money (ci), ×100 conversion (ci), cart only (ci), money shim (ci), pin the old money (guard) |
| quadratic-merge-budget | acme/contacts | accidentally quadratic merge caught by a 150,000-row time budget | Run npm test | test-regression | memoized keys (ci), last-wins Map (ci), sorted merge (ci), raise the budget (test-changed), skip large inputs (ci) |
| go-vet-and-test | acme/timesheet | a go vet finding, with a rounding test failing behind it in the skipped Test step | Vet | unknown | vet only (ci), hide the layout from vet (ci), vet flag in the workflow (rule), edit the rounding test (test-changed) |
| python-circular-import | acme/tally | circular import whose bottom-import fix passes Test but not Smoke | Test | unknown | bottom import (ci), drop the tax (ci), rename the test modules (test-changed), drop Smoke (rule) |
| lint-real-bugs | acme/checkout | three Biome findings that are real bugs | Lint | unknown | rules off, files left out, JavaScript linter off (guard), biome-ignore (ci), underscore rename (ci), delete the unused line (ci), narrow the lint script (scripts) |
| ts-path-alias-runtime | acme/catalog | a tsconfig paths alias type-checks, but Node cannot resolve it in dist | Build | build | the alias (ci), re-export shim (ci), loader hook (scripts), self-dependency (ci) |
| go-error-wrapping | acme/stockroom | `%v` wrapping breaks `errors.Is` two packages below the failing HTTP test | Test | test-regression | string matching (ci), Get only (ci), bare sentinels (ci), edit the handler test (test-changed) |
| tz-calendar-dates | acme/stays | date bug that fails only under the job's `TZ` | Run npm test | test-regression | force UTC (ci), UTC getters only (ci), drop the job's TZ (rule), TZ in the test script (scripts) |
| python-asyncio-single-flight | acme/rates | async race: concurrent loads of one currency not shared | Test | test-regression | global lock (ci), per-key lock (ci), sticky in-flight task (ci), edit the test (test-changed) |
| config-merge-far-cause | acme/orders | a two-level config merge shows as missing tax six files away | Run npm test | test-regression | default tax rate (ci), copy into the test config (test-changed), tax in the handler (ci), edit the orders test (test-changed) |
| npm-peer-eresolve | acme/dashboard | ERESOLVE peer conflict after a host library's major bump | Install | unknown | .npmrc legacy-peer-deps (scripts), downgrade charts (guard), overrides (ci), newest legend 1.x (ci), version only (ci), workflow flag (rule) |
| paging-boundary-shift | acme/feed | the first plausible fix changes a shared helper and breaks its other callers | Run npm test | test-regression | 1-based helper (ci), helper and red callers (ci), edit the internal tests (test-changed), special-case page 1 (ci) |

**Self-check.** `node run.ts corpus-check`, or `BENCH_DOCKER=1 node --test test/corpus.docker.test.ts`, checks every case in real boxes:
1. It fails at its step, and its log matches `expect.logRegex`.
2. The product diagnoses it as stated, and triage sends it to repair.
3. Its reference patch passes the judge.
4. Every decoy fails for its stated reason.

All twenty cases passed the self-check before round 2 ([reports](reports/README.md)); on this machine the eight round-1 cases pass it in 20–30 s with a concurrency of 3. The part the product's change rules decide runs without Docker in `test/corpus.test.ts`: every reference patch passes them, and each decoy is rejected (`rule`) or held as a test change (`test-changed`) exactly when its meta says so, so a change to the rules that moves a verdict fails there first. `node run.ts setup` pulls the box images the corpus picks, `golang:1.26-bookworm` and `python:3.13-bookworm` included, as does the first box that needs one.

## OpenAI prices (prices/openai.json)

USD per 1M tokens at the Standard tier on the global endpoint, read from [the pricing page](https://developers.openai.com/api/docs/pricing) and each model's page on 2026-09-25. Every price below was confirmed on both pages; none is unconfirmed.

| Model | Input | Cached input | Cache writes | Output | Over 272K input: input / cached / writes / output | Context | Max output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | 0.10 | 0.01 | 0.125 | 0.50 | 0.20 / 0.02 / 0.25 / 0.75 | 1,050,000 | 128,000 |
| gpt-6-sol | 2.00 | 0.20 | 2.50 | 10.00 | 4.00 / 0.40 / 5.00 / 15.00 | 1,050,000 | 128,000 |
| gpt-6-astra | 10.00 | 1.00 | 12.50 | 50.00 | 20.00 / 2.00 / 25.00 / 75.00 | 1,050,000 | 128,000 |
| gpt-5.3-codex | 1.75 | 0.175 | – (as input) | 14.00 | – | 400,000 | 128,000 |
| gpt-5-nano | 0.05 | 0.005 | – (as input) | 0.40 | – | 400,000 | 128,000 |

- **Names.** No model is named `gpt-6`: the GPT-6 family is Astra, Sol and Luna ([all models](https://developers.openai.com/api/docs/models/all)). No GPT-6 codex model exists; the newest codex model, `gpt-5.3-codex`, is listed for Responses-wire harnesses and is served on the Responses API only. `gpt-5-nano` (August 2025), OpenRouter's `openai/gpt-5-nano`, is round 2's cheaper second model; its page caps input at 272,000 of its 400,000 tokens, and it has no Fast mode.
- **Rules** ([prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and the model pages): cached input is 0.1× and cache writes 1.25× the input rate; a prompt of more than 272K input tokens is priced at 2× input and cache rates and 1.5× output for the whole request; Flex and Batch are 0.5×, Fast mode (`priority`, `fast`) 2×; regional (data-residency) endpoints add 10% and are not used.
- **Changing it.** The table is data, validated when loaded (`prices.ts`). Adding a model adds its rates, `contextWindow`, `maxOutput` and `reasoning`, with its source; the gateway runs no model it does not list.

## Versions and licenses (verified on 2026-09-25)

| Dependency | Version | License | Where |
| --- | --- | --- | --- |
| typescript | 7.0.2 | Apache-2.0 | bench devDependency (as the root) |
| @types/node | 26.6.2 | MIT | bench devDependency; the root pins 24.19.0, so the bench type-checks the product modules against newer Node types |
| yaml | 2.9.1 | ISC | bench dependency (as the root) |
| jsonc-parser | 3.3.1 | MIT | bench dependency (as the root); reads JSONC tsconfig guards |
| ai | 7.0.114 | Apache-2.0 | the product's, from the root node_modules (aisdk baseline), as the rounds ran it; the root now pins 7.0.116 |
| @openrouter/ai-sdk-provider | 3.1.0 | Apache-2.0 | the product's, from the root node_modules (aisdk baseline) |
| typescript (corpus) | 5.9.3 | Apache-2.0 | installed inside boxes by the three TypeScript cases |
| @biomejs/biome (corpus) | 2.5.14 | MIT OR Apache-2.0 | installed inside boxes by `lint-real-bugs`, with its platform packages |
| node:22-bookworm / node:22-bookworm-slim | Node 22.23.3, npm 10.9.9 | Docker official images | box, proxy and relay images |
| python:3.13-bookworm / golang:1.26-bookworm | Python 3.13, Go 1.26 | Docker official images | the Python and Go cases' box images |

The OpenAI track adds no dependency: the gateway, the price table and the fake OpenAI use Node's standard library only.

The adapters pin these, as [adapters/README.md](adapters/README.md) details them:
- pi: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.87.1 and `typebox` 1.3.27 (MIT), in `adapters/pi`'s own package and lockfile;
- opencode: `opencode-ai` 1.18.32 (MIT), its Linux builds by registry integrity, with ripgrep 15.1.0 (MIT or Unlicense), fetched lazily;
- miniswe: `mini-swe-agent` 2.4.6 (MIT), with litellm and the rest pinned by `adapters/miniswe/uv.lock`;
- openai-agents and agents-openai: `@openai/agents` 0.18.0 (MIT), `@openai/agents-extensions` 0.18.0 (MIT, openai-agents only), `openai` 7.23.0 (Apache-2.0), `zod` 4.6.5 (MIT) and a bench copy of `ai` 7.0.114 (Apache-2.0), in the bench's package and lockfile;
- aisdk-openai: `@ai-sdk/openai` 4.0.77 (Apache-2.0), with its own `@ai-sdk/provider-utils` 5.0.49, in the bench's package and lockfile;
- codex: `@openai/codex` 0.157.0 (Apache-2.0), its Linux builds by registry integrity, fetched lazily.

## Cleanup

Each run removes its own boxes, even on Ctrl-C. Then:
- `node run.ts cleanup --out <run>` removes whatever a killed run left, by the data hashes recorded in `<run>/boxes.json`.
- `node run.ts cleanup --all` removes every `perpetual.owner=repair-bench` container and network.

## Deviations from the design

- **The relay's own network.** The relay sits on its own labelled uplink network instead of Docker's default bridge. That way no other container can reach its listener, and it is removed with the box.
- **Scrubbing.** The gateway's IPC `scrub` replaces the key only. The product's `redact()` is applied by the bench string by string inside JSON (`safe.ts`), because redacting serialized JSON can swallow its closing quotes.
- **Diagnoses.** `dep-major-bump` and `esm-cjs-mismatch` are diagnosed `test-regression`, not `unknown`. That is the product's real reading of Node's TAP output (`# fail 1`), pinned by the self-check. Four round-2 cases read as `unknown`, since no product rule matches go vet's finding (`go-vet-and-test`), unittest's ImportError (`python-circular-import`), Biome's findings (`lint-real-bugs`) or npm's ERESOLVE (`npm-peer-eresolve`); triage sends `unknown` to repair. The self-check pins them.
- **Node's diff output.** Node 22.23.3 prints a failed strict-equal of strings longer than 12 characters as a stacked `+ actual` / `- expected` diff, not `'a' !== 'b'`, so `workspace-money-units` and `tz-calendar-dates` match the diff's two lines rather than their designed pattern.
- **Login shells keep the image's PATH.** Debian's `/etc/profile` resets `PATH` in a login shell, so `bash -l` finds no `go` in `golang:1.26-bookworm`. ci.ts and the product's run tool use a non-login bash, but miniswe's box command and codex's shell run `bash -lc`. So every bench box writes the image's own `PATH` to `/etc/profile.d/00-image-path.sh` when it starts (box.ts), and a login shell finds the same toolchain CI does, in every image.
- **Stricter decoys.** The dependency revert in `lock-drift` fails a guard before CI. There are extra decoys: `esm-import-path` drops the alias, and `esm-cjs-mismatch` reads relative to the working directory.
- **Runner errors.** A runner failure (a box or Docker) is recorded as `status: error` and the run goes on. Such attempts are not counted, and a resumed run retries them. One that fails after the model ran keeps what the gateway counted, its change and its request log, written as soon as each is known, and the report's spend counts every attempt's dollars, a runner error's and a retried one's included.
- **Deferred.** `--transcripts` (request bodies) is not implemented yet. `setup` fetches no adapter binaries: opencode and codex fetch and verify theirs on a run's first `prepare()`, untimed, and miniswe syncs its uv environment in `available()`, which `setup` and every run call before any attempt.
- **Linux engines.** On a Linux engine, `--gateway-host` must name an address the relay can reach. This is untested here, on Docker Desktop.
- **The OpenAI track's body changes beyond `store`.** The contract passes OpenAI bodies through untouched except for `store: false`. The gateway also adds `reasoning.encrypted_content` to `include` beside that `store: false` (for reasoning models), because without it a replayed reasoning item fails once `store` is false; asks a streamed chat completion for its usage, without which no stream could be priced or capped; sets `service_tier: "default"`, because the table prices only the Standard tier and a project's default could otherwise double every price; and applies the reasoning policy to Responses requests, as it does on OpenRouter. It refuses hosted tools and unpriced models before forwarding.
- **Price rules beyond the contract's three rates.** GPT-6 bills cache writes at 1.25× input and prompts over 272K input tokens at long-context rates, so the table carries both, and a tier factor, beside input, cached input and output.
- **Chains.** Under the store rule a `previous_response_id` chain cannot start, as above. No framework under test chains by default.
