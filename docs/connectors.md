# Connectors

Connectors is app-wide, independent of repository and pipeline selection. The page keeps the neutral shadcn connected-app list, search, refresh, app picker and confirmed disconnect. Settings remains OpenRouter-only.

GitHub uses the existing verified CLI account and browser sign-in. Connecting or disconnecting updates the shared GitHub connection while preserving projects, pipelines and run evidence. CLI tokens never reach the page; an unreachable account remains Unverified.

## Browser sign-in

Slack, Linear, Gmail and Jira default to browser authorization through the [Composio consumer MCP](https://docs.composio.dev/docs/composio-connect). Click Connect app, then Connect beside an app. Perpetual opens Composio sign-in directly; users do not create a Platform project, copy its key or configure OAuth. Composio login and the application's consent remain human actions. A single existing active account is reused; multiple active accounts require an explicit account choice.

The official MCP SDK discovers the protected resource and authorization server, registers a public client, and exchanges an authorization code with PKCE S256. OAuth traffic is pinned to the observed Composio origins. One persisted state nonce, verifier, provider, callback URL and expiry bind the loopback callback to an explicit Connect action. The callback accepts cross-site navigation only at `127.0.0.1:<controller-port>/connectors/oauth/callback`; every other route retains the launch-session and origin checks. Cancelled, mismatched, expired and replayed callbacks cannot create an app connection. Uncertain exchanges are held until a new explicit sign-in.

Client registration and tokens stay in `connectors/browser-auth.json`, guarded through the private store (directory 0700, file 0600). Tokens never appear in HTTP replies. Refresh happens only to perform an authorized account read or explicit connection operation. Revoked authorization requires browser sign-in again; restarting or opening the page never starts consent or registers a client.

Account management uses only `COMPOSIO_MANAGE_CONNECTIONS`. Perpetual validates its advertised schema before calling it and requires an explicit `list` action for reads and `add` for consent initiation. A changed interface fails closed; a read cannot fall back to an action that creates authorization. No provider tool, remote workbench or remote shell executes while managing accounts. Only an ACTIVE account of the selected provider is Connected. Failed reads retain the binding as Unverified; authorization alone does not prove an application account is usable.

Consumer bindings live separately in `connectors/browser-connections.json`. Disconnect removes the local binding, preserving the shared Composio account for other clients. This does not revoke provider consent or delete an account globally. An uncertain add reply retains its persisted intent, including after restart, and is never automatically repeated. Continue sign-in opens only the saved, validated link. Cancellation checks that a saved pending account has not already become active.

## Optional Platform project

The connection settings menu contains **Project API Key…** and **Use browser sign-in**. An explicit project-key setup selects the Platform path for new connections; switching back preserves existing accounts and credentials. Old project-owned accounts retain their original verification and cleanup rules.

Get a project key from **Platform → your project → API Keys**. Setup verifies and privately saves it, sends it only as `x-api-key`, and never returns it to the page. Consumer `ck_` and user `uak_` keys are rejected before transmission. [Consumer and Platform resources are separate](https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection).

The project path reuses an enabled OAuth2 configuration; several require a choice. With no configuration, explicit sign-in checks managed OAuth support and creates a managed configuration. Disabled configurations, denied write permissions and unsupported managed OAuth remain actionable blockers. It persists a unique name before configuration creation and a unique alias before account creation. Uncertain replies recover by those identities without duplicate writes; opening the page, setup and restart create no configuration or account.

Only accounts matching this installation's user id, provider and configuration are Connected. Project disconnect deletes only its owned account in Composio and clears the local record after confirmed cleanup. Failures retain ownership for retry. Configuration blueprints stay available. A replacement key must preserve access to every saved account and unfinished configuration setup.

## Validation

Protocol fixtures cover OAuth callback security, PKCE, consent cancellation, restart recovery, revoked refresh credentials, binding ownership, secret exclusion, uncertain account writes and local disconnect. Desktop browser fixtures cover direct sign-in, optional project setup, multiple-account selection, pending state, refresh and confirmed disconnect. These fixtures do not establish real vendor account acceptance; that requires a person's Composio authorization and application consent. Real endpoint discovery and client registration were verified separately from application authorization.
