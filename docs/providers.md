# Provider connections

Perpetual reads provider state. Its optional [release channel](releases.md) requests an exact-commit deployment through a configured GitHub handler; the Vercel and Railway adapters remain read-only. A repository that mentions a provider is not proof that the provider is connected.

Export credentials into the server process environment. `.env.example` lists the variable names; the server does not load `.env` files. Credentials are not returned to the browser or persisted in Perpetual's state.

## GitHub

GitHub uses the GitHub CLI session (`gh auth login`) or `GH_TOKEN`/`GITHUB_TOKEN`, with access to the repository and read permission for Actions. With the connected account it reads branch heads and reports commit statuses for the [journey gate](gate.md). [Build repair](repair.md) may rerun a transient failure once or push a fix to its own repair branch through a pull request. Its merge follows CI, the exact-head journey gates and the Build Autopilot mode.

For an existing local project with a GitHub remote and no previous connection choice, Perpetual reuses the machine's GitHub CLI session after a successful account check. A remote URL alone never counts as authentication. A source chosen through that reused session stays with the account that chose it: after `gh auth switch` to another account, Perpetual asks you to connect GitHub again. The branch selector and Source settings share this connection state. An explicit **Disconnect** stays in effect, and an explicitly connected account is not silently replaced by a different CLI account.

When GitHub does not answer the account check, on a timeout, a rate limit, or a network or server failure, the connection is **unreachable**, not disconnected: it keeps its account, Source settings shows **Unreachable** with the reason and **Try again**, and the branch selector shows the reason with **Try again** rather than offering to connect. A request that needs the account answers with the reason (HTTP 502). Work in progress waits it out and asks again: the [journey gate](gate.md) keeps its gates waiting and its reports pending, a [build repair](repair.md) and its merge wait up to 15 minutes, and a [release](releases.md) keeps observing its requests. A signed-out CLI, a refused token or another account is still not connected.

### Connect

In **Source → Settings**, **Connect GitHub** opens a shadcn Dialog:

- **Continue as …** uses the verified local account.
- **Sign in with GitHub** shows a one-time code; **Copy code and open GitHub** copies it and opens GitHub's device authorization page. Completing it connects the account and loads the repository and branch choices.

This uses [GitHub CLI's browser authorization](https://cli.github.com/manual/gh_auth_login), not a hosted GitHub App. CLI credentials stay in the CLI's credential store and never enter browser responses or Perpetual's state. Perpetual requests no additional OAuth scopes; GitHub CLI's standard consent screen names the authorizing application and its permissions. Device sign-in is cancelled when the dialog closes and expires after 15 minutes; cancelling does not revoke credentials already authorized on GitHub. An environment-token login can use **Continue as …** but cannot be replaced through the browser flow.

**Disconnect** detaches GitHub from this Perpetual instance. It does not sign the machine out of GitHub CLI or delete the last scanned graph.

### Choose a source

After connecting, choose a repository, a branch and a Root Directory (`/` or a subdirectory such as `/apps/web`). The repository and branch lists come from GitHub, with pagination.

Saving clones the selected branch into a private directory under the server's data directory (`.perpetual/sources` by default) and scans only the selected root, and the repository's GitHub Actions workflows at its top level, without executing project scripts. Your local checkout is untouched. The root must exist inside the managed checkout and cannot pass through symbolic links. A failed selection leaves the previously saved source and graph in place. Saving the same repository and root again keeps its pipeline definitions and its stages' twins across branch changes; another repository or root deletes the outgoing source's twins (see [Twins](twins.md#shared-use-and-recovery)).

Selecting a branch does not create a webhook or turn on automatic deployments.

### Workflow runs

The GitHub adapter reads workflow runs, failed steps and redacted error excerpts, applies rule-based diagnosis and reports a mismatch between the scanned commit and the run's commit.

### Deployments

With the connected account, Perpetual reads the [deployments GitHub records](https://docs.github.com/en/rest/deployments/deployments) for the scanned commit and each one's latest status. Vercel, Railway, Netlify and other Git integrations create these records when they build a commit, so Production lists a provider configured on the provider's side, with no file in the repository, by its environment name, state and address. The read needs no provider credential and the standard `repo` scope of the CLI session; it never creates or changes a deployment. GitHub lists a commit's records newest first, and the newest 1,000 are read; when GitHub holds older ones, the reply says so (`more`) and Production links to the repository's deployments on GitHub, since an environment whose records are all older is not among those read. A record is the reporting app's account of its own deployment, kept under its name, and a provider that records nothing on GitHub is discovered only from repository files.

## Vercel

Vercel reads `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` (comma-separated IDs for several projects) and an optional `VERCEL_TEAM_ID`. The adapter is read-only and lists deployments for those projects.

## Railway

Railway reads `RAILWAY_API_TOKEN` for an account or workspace token, or `RAILWAY_TOKEN` for an environment-scoped project token, plus `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID`. Project tokens use the `Project-Access-Token` header. The adapter is read-only.

The Vercel and Railway adapters need independent provider access and have not been validated against live accounts. The GitHub release channel uses the connected GitHub account; the configured workflow supplies its own deployment credentials.

## References

[GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [Vercel deployment listing](https://vercel.com/docs/rest-api/deployments/list-deployments), [Railway public API](https://docs.railway.com/integrations/api).
