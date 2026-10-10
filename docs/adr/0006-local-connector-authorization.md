# Self-host connector authorization inside the local controller

Perpetual is locally installed open-source software, and its Connector accounts should be authorized directly without requiring users to create a separate hosted connector account. Embed Better Auth in the controller and initialize its private SQLite database and installation secret on startup, replacing the Composio authorization paths while retaining GitHub's existing CLI connection. This keeps grants and token refresh local with no extra service to deploy; installation administrators still register provider OAuth apps, and old Composio connections require fresh consent because their grants cannot transfer. This decision remains accepted for Slack, Linear and Jira.

**Status:** accepted for Slack, Linear and Jira; Gmail superseded by ADR-0007. Slack and Jira may opt into broker routing under ADR-0008.
