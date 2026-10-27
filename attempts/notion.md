# Notion setup attempt

- Date: 2026-10-28, about 01:13 to 01:17 IST
- Driven by: Claude in Chrome, in the user's signed-in browser
- Workspace: user's existing Notion workspace (labelled "Development" in the form)
- Connection: "OAuth Readiness Test" (OAuth, installable in any workspace)

## Timeline

| Time spent | Step | Who |
|---|---|---|
| ~1 min | notion.so/profile/integrations redirected to app.notion.com/developers/connections | Agent |
| ~3 min | New connection: name, OAuth method, installable in, redirect URI | Agent |
| — | Approved "Create connection" (also accepts Notion Developer Terms) | You |
| instant | Connection created; client ID, masked secret, ready-made authorization URL shown | Notion |

Working OAuth connection: about 4 minutes, one approval. No review.

## Differences from the docs and from our draft guide

1. Integrations are now "Connections" under "Developer tools" at app.notion.com/developers. The area also has Workers (New), Personal access tokens and MCP tokens.
2. **New first choice: Authentication method.** "API token" is selected by default: workspace-scoped, shared across collaborators, limited to 1 workspace, not Marketplace-eligible. "OAuth" is user-scoped, multi-workspace, Marketplace-eligible. A developer who keeps the default cannot serve customers.
3. For OAuth, "Installable in" defaults to "Any workspace". Our draft warned about choosing "Selected workspaces only"; the safe option is now the default, so the main trap moved to the authentication method.
4. Confirmed: after creation, "Installable in" shows as read-only ("Public", greyed out). The scope cannot be changed later.
5. Redirect URIs are entered as chips; the typed value must be picked from the suggestion list or it is not saved. Rules on the page: HTTPS only, no URL fragments, relative paths, wildcards, or public IP addresses.
6. Creating the connection states that you agree to Notion's Developer Terms.
7. **Default capabilities are broad:** Read, Update and Insert content are all on, and user capabilities default to "Read user information including email addresses". Comments are off. Privacy-minded developers should narrow these before launch.
8. The connection page gives a ready-made authorization URL (owner=user) and an option to "Duplicate a Notion page to a user's workspace during OAuth" (template duplication).
9. Marketplace listing shows "Unpublished" with a "Publish to Marketplace" link. Not needed for OAuth to work.
10. Danger zone: deleting the connection revokes access for everyone who installed it.

## Agent vs human boundary (observed)

- Agent did: navigate, choose OAuth, set install scope, enter redirect, read configuration.
- Human had to: sign in, approve creation (which accepts Developer Terms). Secret stayed masked.

## Not tested

- The consent page (page picker) and token exchange.
- Marketplace publishing review.
