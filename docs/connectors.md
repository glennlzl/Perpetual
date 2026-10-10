# Connectors

Connectors is app-wide, independent of Project and Pipeline selection. The page keeps the connected-app list, search, refresh, app picker and confirmed disconnect. Settings remains OpenRouter-only.

GitHub uses the existing verified CLI account and browser sign-in. Connecting or disconnecting updates the shared GitHub connection while preserving projects, pipelines and run evidence. CLI tokens never reach the page; an unreachable account remains Unverified.

Slack, Linear and Jira use Better Auth inside the local controller by default, with Node's built-in SQLite. Starting Perpetual initializes its database and installation secret automatically. Gmail uses the local Composio broker. Slack, Linear and Jira can use that broker when their private pairing files are configured; without a pairing, their direct OAuth setup remains available. Linear's optional broker path predates [ADR 0007](adr/0007-gmail-uses-the-local-composio-broker.md); Slack and Jira routing is recorded in [ADR 0008](adr/0008-optional-slack-jira-broker-routing.md).

## Local Composio broker trial

For the isolated experiment in [`bench/connector-broker`](../bench/connector-broker/README.md), set `PERPETUAL_LINEAR_BROKER_PAIRING`, `PERPETUAL_GMAIL_BROKER_PAIRING`, `PERPETUAL_SLACK_BROKER_PAIRING` or `PERPETUAL_JIRA_BROKER_PAIRING` to that provider's private client pairing file when starting the controller. The ordinary **Connect app** action then uses the paired service. Keep the broker running at its fixed loopback address. The controller receives only its paired client credential; the Composio project key stays in the separate service process. Linear, Slack and Jira remain direct OAuth providers when their pairing is unset. Gmail always uses the broker and no longer accepts Google OAuth client credentials.

Pairings are optional for Slack and Jira and do not create or approve a provider grant. The account holder must open the hosted authorization link, review the provider's consent screen and approve the requested access. Slack broker verification allows only `SLACK_WHO_AM_I` and returns an account id and display label. Jira allows only `JIRA_GET_CURRENT_USER` and returns an active account id and display label; the broker does not invent or require an email address. Configure the broker with the exact Slack user scopes and Jira OAuth scope list that it verifies, as described in its setup guide. The controller stores only the verified display label and connection metadata, not provider tokens.

If a Slack, Linear or Jira pairing is enabled while a direct account or sign-in attempt is saved, controller startup stops and asks for that account to be disconnected first. Temporarily unset the pairing, start Perpetual on the direct route, disconnect the account in Connectors, then stop Perpetual and set the pairing again. Perpetual does not migrate or revoke an existing grant automatically. Unset the pairing to return to the direct OAuth route.

The page opens the hosted authorization link, observes its status, and displays Connected only after the service verifies the account profile. Composio's managed Gmail grant includes broad Google scopes, including full mailbox access, while the broker permits only `GMAIL_GET_PROFILE`, which returns the account address and mailbox counts; the broker exposes no message-reading or mailbox-action route. Cancel and Disconnect act on the paired service's owned connection. Controller snapshots retain only display metadata and the expiring handoff; neither a saved label nor a callback parameter proves a connection. Service outages remain unverified and never fall back to asking the account holder for provider app credentials.

This is a localhost trial, not a public or zero-configuration connection service. The broker stores each paired client's connection mapping in private state beside its principals file. Restart restores the mapping and verifies its owner and current status before use; saved metadata alone never proves authorization. Uncertain connection creation stays blocked across restarts to prevent duplicate grants. Composio stores and refreshes Gmail's third-party token and processes the permitted profile result. Maintainer hosting, verified end-user login and callback identity verification still need implementation before public distribution.

## Installation setup

The installation administrator registers OAuth applications for providers using direct authorization and supplies their credentials to the controller. Better Auth initializes local storage, but cannot issue provider client IDs or approve consent screens. Perpetual bundles no provider client secrets. A configured broker pairing selects the Composio path for that provider and requires its provider auth config on the separate broker. Existing direct grants are not transferred. The broker remains a local operator-paired trial, not public or zero-configuration authorization.

Copy the relevant variables from [`.env.example`](../.env.example) into the Perpetual installation's `.env`, or export them in its shell. The CLI does not load `.env` automatically. To load that file and keep a fixed callback port, start from the Perpetual directory with:

```sh
node --env-file-if-exists=.env src/cli.ts serve --port 4317
```

Restart after changing client credentials. These are installation credentials, never values read from the repository being tested.

| App | Environment variables | Registration and requested permissions |
| --- | --- | --- |
| Slack | `PERPETUAL_SLACK_CLIENT_ID` or `PERPETUAL_SLACK_BROKER_PAIRING` | Without a pairing, enable public-client PKCE and register the callback. The direct flow requests user scopes `users:read` and `users:read.email`, with no bot scopes or client secret. For broker setup, configure the allowlisted `SLACK_WHO_AM_I` profile tool and match the exact bot and user scope lists; the current verified config has `users:read` in each. [Slack setup](https://docs.slack.dev/authentication/using-pkce/), [broker setup](../bench/connector-broker/README.md) |
| Linear | `PERPETUAL_LINEAR_CLIENT_ID`; optional `PERPETUAL_LINEAR_CLIENT_SECRET` or `PERPETUAL_LINEAR_BROKER_PAIRING` | Without a pairing, register the callback; direct OAuth uses PKCE and the `read` scope. Broker setup allows `LINEAR_GET_CURRENT_USER` only. [Linear setup](https://linear.app/developers/oauth-2-0-authentication), [broker setup](../bench/connector-broker/README.md) |
| Gmail | `PERPETUAL_GMAIL_BROKER_PAIRING` | Point to the private client pairing file for the local Composio broker. Configure the broker's Gmail auth config to allow `GMAIL_GET_PROFILE` only. The controller does not accept Google OAuth client credentials. [Broker setup](../bench/connector-broker/README.md) |
| Jira | `PERPETUAL_JIRA_CLIENT_ID` and `PERPETUAL_JIRA_CLIENT_SECRET`, or `PERPETUAL_JIRA_BROKER_PAIRING` | Without a pairing, register an Atlassian OAuth 2.0 (3LO) app and callback. The direct flow requests `read:me`, `read:jira-user`, `read:jira-work` and `offline_access`. For broker setup, configure `JIRA_GET_CURRENT_USER` and match its exact OAuth scopes; the current verified config uses `read:jira-user` and `offline_access`. [Atlassian setup](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), [broker setup](../bench/connector-broker/README.md) |

For the command above, callbacks are:

```text
http://localhost:4317/connectors/auth/callback/slack
http://127.0.0.1:4317/connectors/auth/callback/linear
http://127.0.0.1:4317/connectors/auth/callback/jira
```

These callbacks use the controller's actual port. Register that exact URL for Slack, Linear and Jira; changing the port requires updating their registration. Slack uses `localhost`, matching its documented public-client PKCE redirect; the other providers use `127.0.0.1`. Gmail authorization is completed through Composio and has no controller OAuth callback. A provider without its required credentials or pairing stays unavailable with a setup error. Local initialization alone does not connect an account.

## Local authorization and storage

When using the direct route, Better Auth owns OAuth state, code exchange, encrypted access and refresh token storage, and token refresh for Slack, Linear and Jira. Their provider adapters normalize OAuth responses and verify accounts through provider APIs. Slack and Linear use PKCE S256; Jira uses its confidential-client flow. Refresh occurs when an authorized account read needs a fresh access token. With the broker route, provider tokens stay with Composio; the local pairing file contains only the broker URL and client credential.

For direct providers, starting a connection creates an explicit, ten-minute pending attempt tied to its provider and controller origin. Only `GET /connectors/auth/callback/{provider}` accepts a callback on the provider's loopback host and the controller's exact port. The controller handles Slack's callback internally at its canonical `127.0.0.1` origin. All connection-management routes retain the launch-session and origin checks. Better Auth's general account and session endpoints are not mounted; its session cookies stay inside the controller and are never sent to the browser. Broker requests use `/trial/{provider}/{connect,status,profile,disconnect}`; Linear keeps its legacy `/trial/{action}` route.

Cancelled, expired, mismatched, duplicate and replayed callbacks cannot create a connection. A pending code exchange is persisted before the exchange starts; an uncertain exchange is not automatically repeated after restart. The user starts a new sign-in to recover. A successfully exchanged grant is Connected only after the provider verifies the bound account; network failures retain it as Unverified, while rejected authorization requires sign-in again.

Under the controller data directory, `connectors/auth.sqlite` contains Better Auth's accounts, encrypted tokens and OAuth state for direct providers. `connectors/auth.json` contains the installation secret, local owner identifier, provider bindings and pending attempts. The directory is private (0700), the files are private (0600), and the SQLite path is guarded against symlinks. Back up and restore both files together; the database's token encryption depends on the secret in `auth.json`. Broker metadata is stored separately per provider in `connectors/{provider}-broker.json` (Linear uses `broker-trial.json`); it contains no provider token.

Disconnect removes a direct provider's local Better Auth account, token records, pending attempt and binding. It does not revoke consent at that provider; that remains available in the provider's account settings. Broker disconnect uses the paired broker's tracked connection. Connecting through Composio requires fresh account-holder consent. Any removal of old direct Gmail records was a one-time local development cleanup, not a shipped migration; it says nothing about whether Google revoked a server-side grant.

## Connection status

The first list reads local bindings and the GitHub account before displaying rows, with GitHub first. It does not wait for the external services. Remote verification follows quietly and runs across providers concurrently. In-memory observations belong to a specific binding and remain fresh for 30 seconds; stale or unobserved accounts show Checking until a fresh result arrives. Restart retains private credentials and bindings but discards observations. A snapshot never authorizes a connection operation.

Focus and visibility checks run quietly; only an explicit Check connection shows loading and its result on that app. Concurrent equivalent reads share one request in the page and controller, and reads following a connection mutation wait for it. Pending sign-in is checked while the page is visible. Unverified and Sign-in required accounts need explicit recovery and do not start a polling loop.

## Acceptance

Local protocol and browser fixtures can check callbacks, persistence and interface behavior without provider accounts. They do not establish real Slack, Linear, Gmail or Jira acceptance. Each provider still needs a person's consent and successful verification before its connection can be claimed as working. Gmail's profile-only trial requires a real Composio Gmail auth config and fresh account consent; no live acceptance is implied by these docs.
