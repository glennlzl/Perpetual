# Allow optional broker routing for Slack and Jira

Keep local Better Auth as Slack and Jira's default authorization path, while allowing an installation to select the paired Composio broker through a provider-specific private pairing file. This supports profile-only broker verification without forcing every installation to deploy the broker; switching an existing local binding requires explicit disconnect because grants are never migrated automatically.

**Status:** accepted.
