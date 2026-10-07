# Connectors

**Connectors** is an app-wide sidebar page at `#connectors`, separate from **Project** and **Settings**. It uses the same neutral shadcn controls and a centered content area capped at 64rem. The breadcrumb is **Connectors**.

The page lists connected accounts in flat rows with provider marks, a verified connection Badge, account identity, **Refresh**, and a menu containing **Disconnect**. Search filters provider names and accounts. **Connect app** opens the available-provider picker, then the existing sign-in dialog. Today GitHub is the supported account connector; discovered deployment targets are not account connections. OpenRouter configuration remains in Settings.

Connection management reads and changes the controller's existing GitHub connection. It never selects a repository, creates a pipeline or changes its Production branch. Other project views observe the same connection. Disconnect requires confirmation, retains projects and tests, and keeps the viewer on Connectors; a canvas disconnect still returns to Project. Refresh failures preserve the last row as **Unverified** with retry, and an unreachable account is never presented as disconnected. Failed disconnects retain the confirmation and allow retry. No credential reaches the frontend.
