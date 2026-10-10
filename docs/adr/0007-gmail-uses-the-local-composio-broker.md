# Route Gmail through the local Composio broker

Keep Gmail authorization in the local Composio broker trial, where Composio holds and refreshes the Google grant, and allow only profile verification through `GMAIL_GET_PROFILE`. The controller stores a paired broker credential and connection metadata rather than Gmail tokens; account holders create a fresh Composio connection through consent. Removal of old direct Gmail records was a one-time local development cleanup, not a shipped migration, and does not claim that Google revoked a server-side grant. The trial remains local and operator-paired until hosted identity, callback verification and deployment are implemented.

**Status:** accepted.

**Consequences:** Better Auth remains the default direct authorization path for Slack, Linear and Jira. Linear keeps its existing opt-in broker route; [ADR 0008](0008-optional-slack-jira-broker-routing.md) records the Slack and Jira opt-in routes.
