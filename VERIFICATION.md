# Verification log

On Oct 28, 2026 an AI agent (Claude in Chrome) created real OAuth apps in the developer consoles below, in the product owner's own signed-in browser. A person signed in and approved every create, terms acceptance and policy agreement. Client secrets were never revealed to the agent. Detailed logs: [`attempts/`](attempts/).

## Results

| App | Time to working app | Review to go public? | What we tested |
|---|---|---|---|
| Slack | ~5 min | No (Marketplace to lift limits) | App from manifest, install, distribution activated |
| Linear | ~4 min | No | Public app created, consent screen viewed |
| Notion | ~4 min | No (Marketplace optional) | OAuth connection created, capabilities read |
| Confluence | ~5 min | No to share (Marketplace separate) | App, scopes, callback; sharing requirements read |
| Gmail | ~10 min | Yes (verification; CASA for read access) | Project, consent configuration in Testing, Gmail scopes |

HubSpot, Salesforce and LinkedIn are docs-only.

## What changed because of the attempts

| App | Before (docs or our draft) | After (seen in the console) |
|---|---|---|
| Linear | Any workspace can authorize | **Apps are private by default**; a Public toggle is needed. Corrected. |
| Notion | Main trap: choosing "Selected workspaces" | **Default auth method is a single-workspace API token**; "Any workspace" is now the OAuth default. Install scope confirmed read-only after creation. Default capabilities include reading user emails. |
| Slack | Create, then install, then distribute | **"Create and Install" is one step**; settings moved to app.slack.com; owning workspace can't be changed; **deactivating distribution uninstalls everywhere**; distribution needed no review (was secondary, now tested); token rotation and PKCE are opt-in. |
| Gmail | 100-user cap (secondary source) | **Console states 100 users counted over the app's lifetime** (now tested). Internal type disabled without Google Workspace. **Uploading a logo triggers verification.** Gmail scopes hidden until the API is enabled. Console grouped `gmail.send` as sensitive and `gmail.readonly` as restricted. |
| Confluence | Not in the first draft | **Rotating refresh tokens are mandatory**; Resource-level vs Account-level access chosen at creation; apps start private; sharing needs a **personal data declaration** (Yes if caching over 24 hours); console warns about classic vs granular scopes. |

## Corrections from documentation checks

- `gmail.metadata` is **restricted**, not sensitive (Gmail scopes page).
- LinkedIn states 365-day refresh tokens, but its example shows `refresh_token_expires_in: 525600` seconds (about 6 days). Marked as a conflict.
- HubSpot's private OAuth limit is 10 on one official page and 10 or 100 (Solution Partners) on another. Marked as a conflict.
- Slack's original May 2025 post says existing unlisted installs aren't throttled; Slack's changelog index says they are from March 3, 2026. Marked as a conflict.

## Not verified

- Provider review durations (no app was submitted).
- Whether Slack's manifest API returns credentials suitable for a zero-exposure handoff.
- Notion token lifetimes; HubSpot and LinkedIn behaviour beyond their docs.
- How packaged Salesforce External Client Apps behave across customer orgs (unresolved community thread).
- Which toolkits have Composio-managed apps beyond Gmail, Slack and GitHub.

## Agent code path checks

- `npm run validate` checks all 8 library guides against the schema.
- The research agent was run end to end against a fake Claude API (tool use, `pause_turn` continuation, JSON lines split across stream chunks): all 14 sections parsed and streamed in order.
- `AGENT_MOCK=1` replays a guide through the real streaming UI and save flow; save refused a duplicate without confirmation and refused overwriting a library guide.
- Not run in the build sandbox: a live research pass against the real API (outbound network to api.anthropic.com was blocked there). Run one after deploying.
