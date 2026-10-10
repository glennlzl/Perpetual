# Local connection-broker trial

This trial checks whether an untrusted local client can use a maintainer's Composio project without receiving its project API key or choosing another client's connection. It supports profile-only verification for Linear, Gmail, Slack and Jira. Slack is restricted to `SLACK_WHO_AM_I`; Jira is restricted to `JIRA_GET_CURRENT_USER`; Gmail is restricted to `GMAIL_GET_PROFILE`; Linear is restricted to `LINEAR_GET_CURRENT_USER`.

**Status: local trial. Not a public service, zero-configuration service or completed provider acceptance.** Fixture tests prove request isolation, not successful provider consent. Each live Composio auth config and profile response must be verified before real acceptance can be claimed.

## Run

Use Node 24.12+ and the root checkout's development dependencies. No additional package or database is needed. From this directory:

```sh
npm run typecheck
npm test
node setup.ts /absolute/private/trial-directory
```

Setup creates two separately paired test clients, A and B. Each client file contains only the loopback broker URL and a random client bearer credential; the server pairing file contains the two identities and credential hashes. Files are private (0600) and directories private (0700). Pairing never overwrites an existing file. The broker stores Linear and Gmail connection metadata separately in `server/connections.json` and `server/gmail-connections.json` beside `principals.json`; these files contain no provider tokens or API keys and are atomically saved with private permissions. The broker validates restored records against the current paired principals and checks provider ownership and configured auth before use. This operator-mediated pairing is a test fixture, not a public user-login flow.

In the maintainer's Composio dashboard, configure each provider with an enabled OAuth auth config and an execution allowlist containing only its profile tool. Linear uses `read`. Gmail uses Composio's managed default scopes exactly: `userinfo.profile`, `userinfo.email`, `contacts.readonly`, `contacts.other.readonly`, `profile.language.read`, `user.addresses.read`, `user.birthday.read`, `user.emails.read`, `user.phonenumbers.read`, `profile.emails.read`, and `https://mail.google.com/`, all under `https://www.googleapis.com/auth/` except the final URL. The broker verifies this exact scope set and only allows `GMAIL_GET_PROFILE`; Google's managed grant is broad and includes full mailbox access, while the broker returns only the account address and mailbox counts. Do not replace these managed defaults with a guessed scope set. For Slack, use the `slack` user toolkit and configure `credentials.user_scopes`; bot `scopes` are checked independently. The broker requires exact operator-provided expectations for both lists. The observed Slack managed config currently reports `users:read` in each list. For Jira, match the broker's expected scopes to the exact configured OAuth scope list. The Slack and Jira expected scope lists are explicit operator configuration because managed configs can vary; the broker rejects a missing or mismatched list. Confirm actual provider consent and profile behavior before claiming live acceptance. These auth configs belong to the maintainer's project. Create a dedicated project key with Tools read, Auth configs read, Connected accounts read/write, and Tool execution write. Do not grant Proxy execute, MCP, Sessions, or project administration. The key is still project-level; the server enforces each client's narrower permissions.

Store these variables in a private file outside the repository, then start the service process only with that file:

```text
COMPOSIO_API_KEY=<server-only project key>
BROKER_TRIAL_LINEAR_AUTH_CONFIG_ID=<Linear auth config ID>
BROKER_TRIAL_GMAIL_AUTH_CONFIG_ID=<Gmail auth config ID>
BROKER_TRIAL_SLACK_AUTH_CONFIG_ID=<Slack auth config ID>
BROKER_TRIAL_SLACK_EXPECTED_SCOPES=<comma-separated exact Slack bot scopes; empty is allowed>
BROKER_TRIAL_SLACK_EXPECTED_USER_SCOPES=<comma-separated exact Slack user scopes; empty is allowed>
BROKER_TRIAL_JIRA_AUTH_CONFIG_ID=<Jira auth config ID>
BROKER_TRIAL_JIRA_EXPECTED_SCOPES=<comma-separated exact Jira OAuth scopes>
BROKER_TRIAL_PRINCIPALS=/absolute/private/trial-directory/server/principals.json
```

```sh
node --env-file=/absolute/private/server.env serve.ts
node client.ts status /absolute/private/trial-directory/clients/a.json
node client.ts connect /absolute/private/trial-directory/clients/a.json /absolute/private/trial-directory/clients/link.json
```

On macOS, install the broker as a per-user LaunchAgent when it should stay available after the terminal closes and restart after a crash. From this directory, run `npm run service -- install --env-file /absolute/private/server.env`; then use `npm run service -- status` and `npm run service -- uninstall`. The command requires an absolute, mode-0600 configuration file owned by the current user and stored outside the checkout. It passes the file path to Node's `--env-file` option; the Composio key is never copied into the LaunchAgent. launchd starts the service at login, keeps it running, and throttles restarts. Its output files live in the private `~/.config/perpetual/connector-broker-service` directory (or `$XDG_CONFIG_HOME/perpetual/connector-broker-service`). Uninstall stops the LaunchAgent and removes only the matching managed plist; broker connection state and logs remain available for review.

Open the private link only in the intended account holder's browser. Review the actual provider permissions before consenting. Do not paste the authorization link, project key, client credential, or raw provider responses into tickets, logs, or the public repository. The profile command only reports verification success, not the returned personal fields:

```sh
node client.ts status /absolute/private/trial-directory/clients/a.json
node client.ts profile /absolute/private/trial-directory/clients/a.json
node client.ts disconnect /absolute/private/trial-directory/clients/a.json
node client.ts status /absolute/private/trial-directory/clients/b.json
node client.ts profile /absolute/private/trial-directory/clients/b.json
```

A should eventually verify its profile; B must remain not connected and its profile request must fail. These are live acceptance steps, not performed by the fixture suite. This script does not approve consent, read issues, send messages, start models, or run business journeys.

To try Linear from the product's Connectors page, start the controller with `PERPETUAL_LINEAR_BROKER_PAIRING` pointing to a private client pairing file. Give the controller only that pairing file, never the service's Composio key. Keep the broker running throughout authorization. The normal Linear dialog starts hosted sign-in and checks status; this path remains opt-in. Slack, Jira and Gmail have independent `/trial/{provider}/{connect,status,profile,disconnect}` routes and separate server-side connection files. Linear also retains `/trial/{action}` for its existing client.

Gmail uses `PERPETUAL_GMAIL_BROKER_PAIRING` with its private client pairing file. The broker exposes `/trial/gmail/{connect,status,profile,disconnect}` to the paired controller. Gmail no longer uses `PERPETUAL_GOOGLE_CLIENT_ID` or `PERPETUAL_GOOGLE_CLIENT_SECRET`; account holders create a fresh Composio connection through consent. Any removal of old direct Gmail records was a one-time local development cleanup, not a shipped migration, and does not establish that Google's server-side grant was revoked. The broker's Gmail connection mapping stays in `gmail-connections.json`, separate from Linear's `connections.json`.

## Boundaries and limitations

- The listener is hardcoded to `127.0.0.1`, validates its Host header, rejects browser-origin requests, and offers no CORS or general proxy. Do not expose it through a tunnel or reverse proxy.
- Per-client credentials select identities on the server. Caller-provided user IDs, connection IDs, tool names, URLs, arguments, and query parameters are rejected. The client gets only the hosted authorization link, a concise state, or the allowed profile fields.
- Before every profile call, the server verifies the upstream connection's owner, provider toolkit, expected auth config, `PRIVATE` account type and active state. No callback parameters can assert success. Gmail profile verification permits only the configured `GMAIL_GET_PROFILE` operation.
- Pending connection IDs and consent links survive a broker restart and expire after ten minutes. Before requesting a new link, the broker durably writes an uncertain-start tombstone; if the request outcome or subsequent state save is uncertain, it blocks another attempt rather than risking a duplicate. Connect reuses an unexpired link only while its upstream account remains pending. It can replace a tracked account when Composio reports `REVOKED`, `EXPIRED`, `FAILED` or `INACTIVE`, after verifying owner, provider toolkit and auth config both before cleanup and immediately before deletion. A consent link that expires locally while Composio still reports a pending account remains blocked for explicit cancellation. Active, unknown, mismatched and uncertain records remain blocked. An uncertain disconnect retains the mapping for explicit retry. Disconnect verifies the tracked connection's owner, provider toolkit, auth config, and private account type, then asks Composio to revoke its upstream credentials and delete the account. Restart does not revoke or delete Composio grants. Inspect and clean up grants from before the explicit disconnect operation in the dashboard; do not repeatedly restart to create new attempts blindly.

For a manually approved recovery of an already verified Linear mapping, `connections.json` has this shape (timestamps are Unix milliseconds; omit `redirectUrl` if no live consent link remains):

```json
{"version":1,"connections":[{"principalId":"broker-trial-<uuid>","id":"<verified Composio connected-account ID>","createdAt":0,"linked":true}]}
```

An uncertain start is represented by `{"principalId":"broker-trial-<uuid>","createdAt":0,"failed":true}`. Import only an account whose owner, Linear toolkit, configured auth config, enabled state, and `PRIVATE` account type have been verified. The broker rejects unknown principals, duplicate IDs, unsupported fields, and malformed state.
- A paired principal is **not proof of who completed the provider consent**. Production must add authenticated browser return verification (such as Composio's callback identity verification), durable single-use transactions, and verified user login. A copied Connect Link can otherwise attach the wrong consenting person's account. This is why the local experiment cannot be used as a public multi-user service.
- The two local processes demonstrate credential separation by inputs and HTTP boundaries, not operating-system isolation: processes running as the same OS user can read that user's files. A real deployment keeps the maintainer key on a separate server.

## Target production flow

The user signs in to the maintainer's service; Better Auth can manage that service's user identity and session. An authenticated device pairing produces a scoped, revocable Perpetual device credential. The local controller stores only that credential. The broker derives Composio's stable user ID from its verified user, starts provider consent, verifies the returning user, and keeps the connection ownership mapping server-side. On normal calls, the broker permits specific operations, checks ownership and quota, and calls Composio with its server key.

Composio holds and refreshes the third-party OAuth tokens. Authorized API results pass through Composio and the broker before returning to the local controller; both services can process those contents. Retention and payload logging are separate settings, not a consequence of token encryption. This model does not promise that all private data stays local. Provider approval requirements and managed-app limitations still apply; registering a custom OAuth app remains a maintainer task when a managed app is insufficient.

Production deployment, Better Auth user login/device pairing, callback identity verification, and billing/abuse limits are not implemented by this trial. Gmail's Composio path is the local product path for this provider; it does not claim public availability or zero-configuration setup. [ADR 0007](../../docs/adr/0007-gmail-uses-the-local-composio-broker.md) records the Gmail decision and [ADR 0006](../../docs/adr/0006-local-connector-authorization.md) is superseded for Gmail.

## References

- [Composio connected accounts and callback identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts)
- [Managed-app scope configuration](https://docs.composio.dev/docs/authentication/controlling-scopes)
- [Scoped project keys](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions)
- [Token custody](https://docs.composio.dev/docs/security/token-custody)
