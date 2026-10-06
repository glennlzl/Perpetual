# Releases

Production can request a deployment of a tested commit through GitHub. The repository's deployment workflow performs the release; Perpetual records the request and follows the status of that deployment. Vercel and Railway discovery remain read-only.

## Configure a target

1. Connect a GitHub repository and branch. The connected account needs permission to create deployments.
2. Add a deployment handler to the repository, following the contract below. Keep it on both the selected commit and the default branch; Perpetual checks both before accepting the target.
3. In Production, choose **Configure deployment**, enter the GitHub environment and handler's `.github/workflows/` file, and set whether it is a production environment. Saving verifies the handler; it does not deploy.
4. Build must pass and every current Sandbox stage must pass or be explicitly released at the same commit. Their GitHub status reports must also succeed.
5. Choose **Deploy** and confirm the exact commit and target. A newer observed source commit, changed target, pending or failed Build, or changed gate evidence refuses the request.

The target is scoped to the connected repository, root and branch. Deploying checks the branch head and Build again, sends the full SHA, disables GitHub's automatic merge, and requires the recorded journey status contexts. It never substitutes the latest branch tip for the confirmed SHA. A manual journey release is retained in the release evidence; it does not become a passing test.

## Handler contract

GitHub broadcasts a `deployment` event; the workflow filename in the request is metadata, not a routing mechanism. Every handler must ignore requests it does not own. Review existing handlers and provider autodeploy before enabling this channel: an existing push-triggered deployment can bypass Perpetual's gate.

The configured handler must:

- Listen for `deployment` and accept only its intended environment and `payload.perpetual.workflowPath`.
- Check that `payload.perpetual.sha` equals the deployment's SHA, then check out and deploy `github.event.deployment.sha` or an immutable artifact built from that exact SHA. Never deploy the current branch tip.
- Use repository or environment credentials on the runner; no deployment credential enters a twin or browser.
- Reference a job environment with `deployment: false`, as the example does. Otherwise GitHub Actions creates a deployment of its own for the job, and its success marks a non-production release Inactive. An environment with custom deployment protection rules cannot be used this way.
- Report `in_progress`, then `success` or `failure` to the original deployment ID. Report success only after the provider confirms the real deployment; include its URL and logs.
- Handle a duplicate delivery idempotently, using the deployment ID. Serialize incompatible releases to the same environment.

Start from [the example handler](examples/github-deployment.yml.example). Its deployment step deliberately fails until replaced with a real provider command; copying it cannot report a fabricated success. Match the configured filename and environment to its guards. The handler is repository-owned code: checking its event and jobs does not prove that it fulfills this contract.

## State and recovery

**Requesting**, **Queued** and **Deploying** describe the actual request and provider status. **Deployed** means GitHub reports success for the exact deployment ID, SHA, environment and release identifier. It is the handler's report, not a new business-test verdict. Production's earlier **Ready** Badge only meant that journey gates allowed promotion.

Requests and their gate evidence are saved after the read-only checks of the branch head and Build, right before the deployment request is sent to GitHub. An ambiguous network outcome becomes **Check deployment**, blocks another request, and is reconciled by its release identifier. Unresolved requests are observed in the background, every 5 seconds at first and up to a minute apart while GitHub reports nothing new. Restart resumes observation and never repeats a deployment POST. **Check status** reads them at once, along with the current commit's finished requests other than abandoned ones. The connected account reads them, whichever account requested them, so a request survives an account switch or a renamed login. If GitHub has no matching record, the uncertainty remains visible rather than risking a duplicate deployment. A deployment whose handler never reports, for example because its guard skipped the request, also stays unresolved and blocks Deploy and Configure; reporting a `failure` or `inactive` status to that deployment on GitHub ends it at the next read. A deployment GitHub no longer has, which GitHub answers with 404 for its ID while the repository itself is readable, ends an unresolved request as **Deploy failed** (`The deployment no longer exists on GitHub.`); a request that already ended, such as a **Deployed** one, keeps its status and shows that message. A definitive refusal or provider failure allows an explicit retry after its cause is resolved.

**Abandon** ends an unresolved request after a person confirms that request: Perpetual marks it **Abandoned** with the connected login, never reads it again, and allows Deploy and Configure. It changes nothing on GitHub: a handler that is still running keeps running, and a deployment GitHub has keeps its record there.

Perpetual keeps up to 1,000 release records across repositories and branches. Beyond that, a new request first removes the oldest finished records, keeping every unresolved request and the latest record of each target.

The first channel does not provision a cloud project, create provider credentials, disable provider autodeploy, configure branch protection, roll back a deployment, or deploy automatically when a gate passes. Build admission evaluates reported Actions runs; it does not maintain an inventory of required workflows that have not yet appeared. Validate the complete workflow against a dedicated deployment target before relying on it for production.

The protocol follows [GitHub's deployment API](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment) and [deployment workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#deployment).
