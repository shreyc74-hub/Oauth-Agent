# Slack setup attempt

- Date: 2026-10-28, about 00:48 to 00:58 IST
- Driven by: Claude in Chrome, in the user's signed-in browser
- Account: user's own "Test" workspace (created for this exercise)
- App: "OAuth Readiness Test", created from a manifest

## Timeline

| Time spent | Step | Who |
|---|---|---|
| ~1 min | Opened api.slack.com/apps (blocked until user signed in) | You |
| ~2 min | Create app > From a manifest > typed manifest (scopes, Composio redirect URL, rotation off) > picked workspace | Agent |
| — | Approved "Create and Install" | You |
| ~10 s | App created and installed in one step | Slack |
| ~2 min | Read Manage Distribution and OAuth & Permissions | Agent |
| — | Approved activating public distribution | You |
| ~5 s | Distribution active immediately, no review | Slack |

Working, distributable app: about 5 minutes of agent work plus two human approvals and one sign-in.

## Differences from the docs and existing guides

1. Create dialog now has an "AI agent" template alongside Starter app, From a manifest, Blank app. Sidebar has "Agents" and "MCP Servers (New)".
2. Workspace choice warns it cannot be changed later, and leaving the workspace loses access to the app.
3. Final button is "Create and Install": creation and install into the dev workspace are one step.
4. App settings now live at app.slack.com/app-settings/<team>/<app>/..., not api.slack.com/apps/<app>.
5. Default manifest includes "token_rotation_enabled": false. Console confirms token rotation is opt-in.
6. PKCE is a separate opt-in on OAuth & Permissions; required only for custom URI scheme redirects.
7. Distribution checklist has 4 items. With redirect URLs and HTTPS in the manifest, 3 were already green. The 4th ("Remove Hard Coded Information") is a self-attestation checkbox.
8. Activating public distribution took effect immediately, no review. Confirms the secondary source (Nango).
9. After activation, the page shows "Installation Count": installs on active workspaces, users active in the past 28 days, updated every 24 hours. This is the counter behind the Marketplace "10 active workspaces" requirement; it read 0 even though the app was installed in the dev workspace minutes earlier.
10. Deactivating distribution later removes the app from every other workspace that installed it, and re-activating requires everyone to reinstall. One-way door in practice.
11. Marketplace submission has 5 steps in the console: Your App Listing, Review scopes, Security and compliance, Testing information, Automated checks.

## Agent vs human boundary (observed)

- Agent did: writing the manifest, choosing scopes, filling forms, reading settings, ticking the attestation (with approval).
- Human had to: sign in, approve creation and install, approve distribution. Client secret was not opened, so it never passed through the agent.

## Not tested

- conversations.history throttle (needs a second workspace and an API call with the bot token).
- Whether token rotation can be turned off after opting in.
