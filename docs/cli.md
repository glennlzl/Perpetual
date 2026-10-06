# CLI

Run the CLI from the source directory with `node src/cli.ts <command>`. It needs Node.js 24.12 or later, which runs the TypeScript source directly by stripping its types; there is no compile step. After cloning, `npm run setup` installs the dependencies, builds the interface, installs Chromium and the browser runtime, fetches the pinned OpenCode release, and reports whether Node.js, [uv](https://docs.astral.sh/uv/), Docker and the GitHub CLI are present; run it again after installing one. To put `perpetual` on your path, run `npm link` there. The package has not been published to npm; a package with the same name on the registry is not this project.

Every command accepts `--data PATH` for the local data directory (default: `.perpetual` in the current directory) and `--repo PATH` for the repository (default: the current directory). An option's value follows it after a space or `=`; an unknown command or option, or an option without its value, is an error. Output is JSON unless noted.

The controller keeps the data directory private (mode 0700), resolving aliases for directory ownership while preserving the configured path used by existing twin resource labels. Its files hold the model key, test credentials and the launch secret, so `serve` prints where it is and gives it a `.gitignore` that ignores everything in it, unless it already has one: a repository the directory sits in never commits them. Its `state.json` snapshot is limited to 32 MiB on read and write; symbolic links and non-files are refused. Saves use a private temporary file and an atomic rename; a failed save removes its temporary file and keeps the previously published state. An unreadable snapshot, such as one in a newer build's schema, is preserved for recovery rather than overwritten.

Every API request needs the controller's launch secret, which the data directory keeps in `launch-secret` (mode 0600). The first start creates it and later starts reuse it, so a printed link stays valid; remove the file to get a new secret, which also signs browsers out. A local tool or agent sends the secret in an `X-Perpetual-Secret` header. The launch link `serve` prints signs a browser in with a browser secret derived from it, carried in the link's fragment, which a browser never sends to a server: the page drops it from the address, keeps it in its own origin's storage and sends it in an `X-Perpetual-Browser-Secret` header, and changes from the page also carry its session token. No credential is a cookie, which a browser would also send to every other port on the host, such as a twin's app. The browser secret is refused in the `X-Perpetual-Secret` header, and lasts as long as the launch secret, as the printed link does. The interface's own files hold no secret and need none.

## Commands

| Command | What it does |
| --- | --- |
| `perpetual serve --repo PATH [--port 4317] [--no-open]` | Starts the controller and the interface on `http://127.0.0.1:<port>`, prints the launch link, `http://127.0.0.1:<port>/#secret=…`, and opens it in the default browser. Use `--no-open` for a headless session. The server binds only to loopback. On Ctrl-C it prints `Stopping…` and exits once its work has drained; a second Ctrl-C stops it at once. |
| `perpetual scan --repo PATH` | Scans the repository: packages and configuration, Git identity, GitHub workflows and jobs, services, workspace dependencies and Vercel/Railway clues. It does not read `.env` files or execute project scripts. |
| `perpetual twin --repo PATH` | Scans, then reports what the repository's twin would run: the config detection proposes, each detected service with its provenance, the evidence that found it and the inputs a person supplies, and each app's unwired variables, those its code reads that no service provides. Names and paths only, with nothing run; [Onboarding with a coding agent](onboarding.md) reads it. |
| `perpetual providers --repo PATH` | Scans, then reads GitHub, Vercel and Railway status with the credentials in the environment; see [Provider connections](providers.md). |
| `perpetual failure --repo PATH --run RUN_ID` | Reads one GitHub Actions run: its jobs, failed steps, a redacted log excerpt and a rule-based diagnosis. |
| `perpetual init-ci --repo PATH [--output FILE]` | For a repository without workflows, writes a starter validation workflow from its scripts and package manager, by default to `<data>/exports/perpetual-ci.yml`. It refuses when workflows exist and never overwrites a file. Review the file before adding it to your repository. |
| `perpetual sandbox …` | The optional desktop sandbox; see [Desktop sandbox](desktop-sandbox.md). |

`npm start -- --repo PATH` builds the interface and then runs `serve`. After changing the client, run `npm run build`; a running server picks up the rebuilt assets.

If the browser cannot be opened, the controller keeps running and asks you to open the printed link. A new browser or cleared browser storage needs that link again: open it directly, or paste it into **Launch link** on the **Connect to Perpetual** page and choose **Connect**. Recovery accepts a full link for the current address, verifies it before saving access, and leaves refused credentials unsaved. Normal restarts over the same data directory preserve access.

## Examples

```sh
node src/cli.ts serve --repo /absolute/path/to/project
node src/cli.ts scan --repo /path/to/project
node src/cli.ts twin --repo /path/to/project
node src/cli.ts providers --repo /path/to/project
node src/cli.ts failure --repo /path/to/project --run 123456
node src/cli.ts init-ci --repo /path/to/project --output /tmp/proposed-ci.yml
```

## Scripts

`node scripts/validate-repository.ts <repo> <expectations.json>` checks discovery against an expectations file you write for a repository. The file is data, for example:

```json
{
  "workflows": ["CI"],
  "deployments": { "Vercel": 1 },
  "keepsExistingCi": true,
  "copiedTests": { "files": ["test/config.test.mjs"], "run": ["test/config.test.mjs"] }
}
```

- `workflows`: workflow names that must be detected.
- `deployments`: the minimum number of deployment targets per provider.
- `keepsExistingCi`: no starter workflow may be proposed.
- `copiedTests`: repository files copied into a temporary directory, and the `node --test` files run there, for configuration-contract tests. At least one copied test must pass.

Any other key, or a file that asserts nothing, is refused.

It does not install or start the application or run its full test suite. The report is printed and written to `artifacts/<expectations name>-validation.json`.

`node scripts/browser-agent-contract.ts` runs discovery through the controller, the browser agent and Chromium against a disposable local page with a deterministic model fixture; see [Business journeys](journeys.md#tests). CI runs it with the browser runtime tests.

## Tests

```sh
npm run typecheck      # type-checks both projects with tsc, which never emits: tsconfig.json and client/tsconfig.json
npm test               # runs the type check and the interface build first, then node --test test/*.test.ts
npm run test:browser   # Python discovery worker tests, after installing the browser runtime
npm run build          # production build of the interface with Vite
```

Journey tests in `npm test` run a real headless Chromium, which `npm run setup` installs (`npx playwright install chromium`).

`PERPETUAL_DOCKER_TESTS=1 node --test test/environment-twin-docker.test.ts` is an opt-in Docker acceptance test: it runs a disposable app and Mailpit as a real twin, checks the app reaches Mailpit, reads health and logs, and deletes the twin.

`PERPETUAL_REPAIR_DOCKER_TESTS=1 node --test test/repair-box-docker.test.ts` runs real [repair boxes](repair.md): a whole repair of a type error in a tiny repository, a box's confinement, and a box removed for writing past its limit.

The Docker tests workflow, `.github/workflows/docker.yml`, sets both variables and runs every `test/*-docker.test.ts` file, one at a time, every night and when started by hand. It is not a required check. Its runner's native Linux engine does not route a container to the host's loopback, which [twins](twins.md) need, so there the twin tests skip the parts that use that route, with the note setup gives for such an engine; any other skip fails the job.

The repair-agent bench under `bench/repair` is a dev-only package with its own dependencies; `npm ci`, `npm ci --prefix adapters/pi`, `npm run typecheck` and `npm test` there, which CI runs as its own job, and `BENCH_DOCKER=1 npm test` for the tests that start boxes. Its [README](../bench/repair/README.md) explains the paid bake-off.
