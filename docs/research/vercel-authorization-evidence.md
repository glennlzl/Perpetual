# Vercel authorization failures: evidence and read-only diagnosis

Researched 2026-10-07 against official documentation and Vercel source. This note describes current public behavior and proposed investigation steps; it does not establish the cause of any private repository incident or record an executed authenticated probe.

## What the error establishes

Vercel documents `error.code: forbidden` with `error.message: Not authorized` as a general endpoint authorization failure. The text is not a unique diagnosis of expiration, revocation, missing team permission, or a bad resource binding. Preserve the HTTP status and structured error fields instead of printing only the message. [Vercel REST API errors](https://vercel.com/docs/rest-api/errors)

The API requires a Bearer access token. The documented team deployment-list request includes `teamId`, and the token must have access to that team. A project identifier matching current configuration does not, by itself, establish that the request's token can access it. [Using an API access token](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token)

The current deployment-list reference describes `/v7/deployments`; the access-token guide still illustrates `/v6/deployments`. That difference alone is not evidence that `/v6` caused an authorization failure. Reproduce the actual failing endpoint before substituting versions. [Deployment list reference](https://vercel.com/docs/rest-api/deployments/list-deployments)

No public official contract found in this research defines an `invalidToken: true` response field as uniquely identifying expiration versus revocation. Vercel CLI itself maps HTTP 403 from `/v2/user` to its generic `InvalidToken` error. Treat an observed field as evidence about that response, not as proof of an undocumented specific cause. [CLI user reader](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/get-user.ts)

## Read-only probes that can distinguish causes

Use only an already authorized credential, directly against `api.vercel.com`, and report selected metadata. A successful connector request proves that connector's access, not the access of a separate CI credential.

| Probe | Evidence available | Important limit |
| --- | --- | --- |
| Repeat the original deployment-list GET with the original CI credential and resource parameters | Whether that request is accepted now; status, error code and selected error fields | Does not establish why the historical request failed; a rerun with updated secrets is a different credential context |
| `GET /v5/user/tokens/current` using the credential under investigation | Metadata for the exact token used in this HTTP request | Request can itself be refused; an unavailable metadata endpoint is not a diagnosis |
| `GET /v6/user/tokens` with an authorized account credential | Authentication-token inventory for the current user | A name or similar creation time is not an exact match to an opaque GitHub Secret |
| `GET /v3/events` with appropriate account access and a bounded time window | Account events and, with `teamId`, team events | Authorization and retained history limit visibility; no returned event is not proof that no change occurred |

The token metadata endpoint explicitly supports the special token ID `current`. Its schema includes `createdAt`, `activeAt`, `expiresAt`, `revokedAt`, `leakedAt`, and scopes with their own expiration information. Read only the fields needed for diagnosis, and do not print the credential or its prefix/suffix. Exact token identity and timestamps can support an expiration or revocation conclusion; another token's metadata cannot. [Token metadata](https://vercel.com/docs/rest-api/authentication/get-auth-token-metadata), [Token inventory](https://vercel.com/docs/rest-api/authentication/list-auth-tokens)

The event API supports `since`, `until`, `types`, and optional `teamId`. Its response can include timestamps, event types, actor information, and token identifiers. Relevant documented activity types include `user-token-created`, `user-token-deleted`, `user-tokens-deleted`, and integration credential rotation/revocation events. Retain only pertinent, redacted observations. [User events API](https://vercel.com/docs/rest-api/user/list-user-events), [Activity types](https://vercel.com/docs/activity-log)

Enterprise audit-log export is a separate capability restricted to team owners. Do not assume that ordinary project-read access includes audit access. [Audit logs](https://vercel.com/docs/audit-log)

## Resolve the actual GitHub Secret source

GitHub's repository Secret GET API returns metadata without its encrypted value; source and repository access cannot recover that secret value. The API can establish existence and creation/update timestamps, not token validity. [GitHub Actions Secrets API](https://docs.github.com/en/rest/actions/secrets#get-a-repository-secret)

For same-name secrets, an environment secret takes precedence over repository and organization secrets; a repository secret takes precedence over an organization secret. Organization and repository secrets are read when a run is queued, while environment secrets are read when the referencing job starts. Inspect the workflow's job environment and secret references before attributing a run to repository-level metadata. [GitHub Actions secrets reference](https://docs.github.com/en/actions/reference/security/secrets)

A nonempty-secret guard confirms only that a nonempty value reached that process. An unchanged Secret timestamp does not establish its provider-side validity or explain when provider-side access changed. This is an inference from the metadata and precedence limits above.

## Token type and local CLI caveats

Do not apply the lifetime of one token type to another. Sign in with Vercel documents one-hour access tokens and rotating refresh tokens; these are not a basis for assigning a one-hour lifetime to an unidentified manually created CI token. The CLI knowledge-base article also describes inactivity expiration for its CLI login context. Identify the token kind and inspect available metadata before attributing an incident to either rule. [Sign-in token types](https://vercel.com/docs/sign-in-with-vercel/tokens), [CLI login expiry guidance](https://vercel.com/kb/guide/why-is-vercel-cli-asking-me-to-log-in)

On macOS, the documented default directory for CLI `config.json` and `auth.json` is `~/Library/Application Support/com.vercel.cli`, subject to `XDG_DATA_HOME`; `--global-config` can select a different directory. The current source checks Vercel data directories first, then legacy `~/.now` and legacy `now` data directories. [Global CLI configuration](https://vercel.com/docs/project-configuration/global-configuration), [Global option](https://vercel.com/docs/cli/global-options#global-config), [Path implementation](https://github.com/vercel/vercel/blob/main/packages/cli-config/src/paths.ts)

Current CLI source can select file or OS-keyring storage. An absent token in `auth.json` therefore does not prove that no CLI account is connected. Inspect presence and storage metadata without printing credential values; never copy local credentials into a repair guest. [Credential storage implementation](https://github.com/vercel/vercel/blob/main/packages/cli-config/src/cred-storage.ts)

## Evidence needed for a final conclusion

- **Expired:** the identified CI token's metadata shows an expiry before the failed request, or the provider returns an explicit expiry diagnostic for that token.
- **Revoked:** a matching token record or provider event establishes revocation before failure.
- **Scope or membership:** that token is recognized, but its documented scope or permissions exclude the requested team/resource; corroborate with the actual request response.
- **Wrong binding:** source/configuration and provider metadata establish that the request targets the wrong resource or owner, with a corresponding successful authorized read after correcting only that binding.
- **Unresolved:** generic denial without enough identity, response, or provider history. Preserve the uncertainty rather than naming a more specific cause.

These are investigation criteria, not claims that every provider exposes sufficient evidence. Any new CI diagnostic run should perform only fixed read requests and emit an allowlisted, redacted result; do not rerun a deployment or alias-changing workflow merely to obtain an authorization error.
