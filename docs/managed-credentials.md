# Managed CI credentials

A person's one-time **Authorize recovery** binds a provider grant to the exact GitHub repository and effective Secret used by a failed workflow. The host controller synchronizes access and resumes original failed jobs without Recheck/Rerun clicks. Neither the repair model nor its Docker box receives credentials. This capability never edits workflow/deploy configuration or bypasses journey gates.

## Vercel connection

The controller uses Vercel's generally available **Integration OAuth** flow. Its installation grant is long-lived, with no documented refresh token or fixed one-hour expiry. Perpetual validates the installation with Vercel, synchronizes it once and monitors its continued availability. Revocation, disabled installation or loss of team membership requires a new owner authorization; the controller cannot grant itself access.

A failed step is eligible only when its effective environment directly binds `VERCEL_TOKEN: ${{ secrets.NAME }}`. Dynamic and ambiguous references remain unsupported. Workflow names do not select a provider. GitHub environment, repository and organization precedence is read from complete metadata. Organization-owned credentials remain with their owner; Perpetual never creates a silent repository override. Two Projects cannot maintain competing grants for the same destination.

### Operator setup

Register a dedicated connectable-account Integration, initially Private for acceptance testing, with the exact redirect `http://127.0.0.1:<port>/authorization/vercel/callback`. Configure `PERPETUAL_VERCEL_CLIENT_ID`, `PERPETUAL_VERCEL_CLIENT_SECRET` and `PERPETUAL_VERCEL_INTEGRATION_SLUG` on the controller. The controller needs Installation Read permission to verify the installation. Select additional deployment permissions from the workflow's actual operations and restrict installation access to its intended Vercel projects. The original workflow must verify operation-level compatibility; an installation check alone does not establish it.

The integration developer must supply its identity, contact/support details, website and required listing materials, accept Vercel's integration agreement, and protect its client secret. This setup is a product-operator responsibility, not a repeated recovery step for customers. A distributed local client must use a hosted authorization broker or an operator-owned integration; never bundle a shared confidential secret. The current controller adapter supports operator-owned local installations. A hosted broker for distribution is not implemented here.

Sign in with Vercel is a different authorization system. Its resource permissions are currently private beta; a normal login does not grant deployment API access. Its PKCE/rotating-refresh adapter remains tested in isolation but is not selected by the controller. Do not configure an identity-only Vercel App as the Integration.

References: [Integration tokens and scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations), [registration and external installation](https://vercel.com/docs/integrations/create-integration/submit-integration), [installation access and disabled accounts](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference), [Sign in resource permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions).

## Execution and ownership

`src/authorization/manager.ts` owns the grant, GitHub account/Project/destination binding and write receipts in `<data>/credentials/state.json`. Directory mode is 0700 and file mode 0600. `src/store.ts` provides guarded reads, atomic writes and a save queue. Public replies contain safe status, destination and account display data only.

The external install URL carries a random state. The controller accepts only its saved, unexpired state and exact callback, persists a single-use exchange receipt before exchanging the code, and verifies the issuer's installation ID, integration ID, user and team. It checks the active GitHub account and Project before storing or using the grant. Provider requests use fixed endpoints, timeouts, bounded replies and no redirects. Callback codes never enter responses; other cross-origin control requests remain refused.

While online and the same GitHub account and Project are active, the controller observes owned credentials every minute and checks long-lived installation health every five minutes. A temporary read failure retries without writing credentials. GitHub receives a value only through `gh secret set` stdin, which gh encrypts locally; no value enters argv, transfer files, repair records or model tools. Metadata is checked before and after a write. An external edit or newly shadowing environment Secret holds further writes. GitHub offers no atomic conditional Secret update, so another owner should stop managed access before changing that same Secret concurrently.

The recovery observer detects the synchronized revision, reruns the original failed jobs at the current branch head and verifies the exact commit, run and newer attempt. Three distinct credential revisions without recovery stop automatic retries. Actual successful workflow evidence is required for **Build recovered**. Production and Sandbox gate rules remain unchanged.

**Stop** cancels credential maintenance for that recovery binding. **Stop managing access** also remains available on a completed recovery. Both discard local grant material and pending authorizations; they do not remove the provider installation or the last GitHub Secret. Installation removal remains available in Vercel. Restart continues previously authorized maintenance, starts no paid work, and never replays an exchange, rotating refresh or Secret write whose outcome is uncertain.

## Verification and remaining acceptance

Automated tests cover consent through the actual local HTTP callback, private synchronization, automatic original-run retry, callback replay/CSRF, exact destination, provider response validation, token rotation, long-lived grants, restart uncertainty, external edits, account/Project changes, stop and redaction. UI tests verify controller-driven progress without manual retry actions. These tests use provider transports and do not claim cloud acceptance.

Real acceptance still requires a registered Integration, explicit installation consent, an observed GitHub Secret synchronization and the original failed workflow passing. Record each separately. A hosted distribution broker remains separate work; this increment is not a completed public SaaS connection.
