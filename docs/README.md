# Documentation

## Guides

- [Onboarding with a coding agent](onboarding.md): the steps an agent walks through with a person after `npm run setup`: the model key, connecting GitHub, the target branch, what the twin can and cannot simulate, and the Beta environment.
- [Pipeline interface](pipeline-ui.md): the canvas, stage cards, Build and Production, the branch selector and the Git graph.
- [Business journeys](journeys.md): reviewed browser journeys, discovery, journey code and its verification, runs, live view and recordings.
- [Twins](twins.md): Compose application environments and their services, with provenance.
- [Journey gate](gate.md): rebuilding a twin for each pushed commit, running its journeys and reporting a GitHub commit status.
- [Releases](releases.md): requesting an exact-commit deployment through a configured GitHub handler and following its real result.
- [Build repair](repair.md): the agent that fixes a failed build in a Docker box, its change rules, its pull request, the journey gates at its head and the merge.
- [Provider connections](providers.md): GitHub, Vercel and Railway.
- [CLI](cli.md): commands, scripts and tests.
- [Desktop sandbox](desktop-sandbox.md): the optional, experimental Cua desktop for desktop applications.
- [Asset provenance](ASSETS.md): logos, fonts, registry components and their licenses.

## Architecture

- [Browser-first business testing](architecture/browser-first.md): why journeys run in a local browser against a URL.
- [Journey contract](architecture/journey-contract.md): the case, milestone, progress and verdict contract between the journey fixture and the controller.
- [Twins and the journey gate](architecture/twins-and-gate.md): the design of Compose twins, twin services and the CI/CD gate.
- [Playwright journeys](architecture/playwright-journeys.md): running approved, generated Playwright code instead of an agent, and its guardrails.
- [Autopilot](architecture/autopilot.md): how a stage fixes and updates the repository through verified pull requests, what is built, the agent loop's bake-off and the order for the rest.

## Decisions

- [Architecture decision records](adr/README.md): the convention and the index.
- [ADR 0001: Gate and manual runs execute approved Playwright code](adr/0001-gate-runs-approved-playwright-code.md).
- [ADR 0002: A repair merges itself only after CI and every journey gate pass at its exact head](adr/0002-repairs-merge-after-ci-and-journey-gates.md).

## Project

- [Domain vocabulary](../CONTEXT.md): the terms used across the code and these documents.
- [Roadmap](../ROADMAP.md) and [changelog](../CHANGELOG.md).
- [Issue tracker](agents/issue-tracker.md), [triage labels](agents/triage-labels.md) and [domain docs](agents/domain.md) for contributors and coding agents.
