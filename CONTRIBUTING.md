# Contributing to Perpetual

Thanks for helping. Issues, bug reports and pull requests are welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

- [docs/README.md](docs/README.md) indexes the architecture and behaviour docs.
- Issues labelled [good first issue](https://github.com/willlzl/Perpetual/labels/good%20first%20issue) are small and well scoped.
- Ask questions and discuss ideas in [GitHub Discussions](https://github.com/willlzl/Perpetual/discussions).
- Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## Before you open a pull request

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Read [AGENTS.md](AGENTS.md). It holds the product rules every change follows, for people and coding agents alike: minimal interface copy with native shadcn components, no product-specific code, and journeys that are complete business flows.
3. Write TypeScript in strict mode. The controller, scripts and tests (`src`, `scripts`, `test`) run directly on Node.js 24.12 or later, which strips their types, so they use erasable syntax only (no `enum`, `namespace` or parameter properties) and relative imports that name their `.ts` file. There is no compile step: `tsc` only checks types, and Vite bundles the client in `client/src`. Validate untrusted input (HTTP bodies, files, worker events, model output, environment) as `unknown`.
4. Run the checks:

   ```sh
   npm run setup
   npm run typecheck
   npm test
   npm run test:browser
   ```

   `npm run setup` installs the dependencies, builds the interface, installs Chromium and, with [uv](https://docs.astral.sh/uv/), the Python browser runtime that `npm run test:browser` needs. `npm run typecheck` checks both TypeScript projects, `tsconfig.json` and `client/tsconfig.json`, which both include `contract/`, the reply shapes the controller implements and the client imports as types, and must report no errors; `npm test` runs it first, serves the built interface and runs journey code in that Chromium. Tests that need Docker are skipped unless you set `PERPETUAL_DOCKER_TESTS=1`, or `PERPETUAL_REPAIR_DOCKER_TESTS=1` for the repair box tests. CI runs the same checks on every pull request.

## Contributor License Agreement

Perpetual is licensed under [AGPL-3.0-only](LICENSE), and the maintainer may also offer it under commercial terms. So that every contribution can be distributed both ways, each contributor signs the [Contributor License Agreement](CLA.md) once. You keep the copyright in your contribution.

When you open your first pull request, the CLA Assistant bot asks you to sign by commenting:

> I have read the CLA Document and I hereby sign the CLA

Comment `recheck` if the check does not update. If you contribute on behalf of your employer, make sure you are allowed to (section 5 of the CLA).
