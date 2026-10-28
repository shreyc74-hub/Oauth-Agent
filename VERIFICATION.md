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

## Live agent runs (deployed site, Oct 28, 2026)

Five apps that are not in the library, chosen to vary the case: a vendor without OAuth, a consumer API with a quota program, a marketplace with review, a marketing platform and an HR platform.

| App | Case | Result |
|---|---|---|
| Claude (Anthropic) | No OAuth for third-party apps | Correctly reported no OAuth and named the real method: API keys. Stopped after the header and sources, as designed. |
| Spotify | Consumer API, quota and review program | Generated, saved, and checked claim by claim against Spotify's official pages (below). 11 of 11 key facts correct; 1 real blocker missed. |
| Zoom | Marketplace app review | Guide generated end to end. Claim-by-claim review: pending. |
| Constant Contact | Marketing API | Guide generated end to end. Claim-by-claim review: pending. |
| Greenhouse | HR platform with API keys and partner OAuth | Guide generated end to end. Claim-by-claim review: pending. |

### Spotify: agent output checked against official sources

The agent researched Spotify live and wrote the guide without help. We then checked its key claims against Spotify's own pages.

| Claim in the generated guide | Official source | Result |
|---|---|---|
| Development mode: up to 5 users, each on an allowlist; owner needs Premium | [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) | Correct |
| 5-user cap for new apps from Feb 11, 2026; existing apps from Mar 9, 2026 | [Spotify blog, Feb 6, 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security) | Correct. Many older blog posts still say 25 users; the agent did not repeat that. |
| Extended quota: organizations only since May 15, 2025 | [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) | Correct |
| Extended quota needs at least 250k MAU, a launched service, a company email | [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) | Correct |
| Review takes up to 6 weeks | [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) | Correct |
| Dev mode quota counted per developer account; up to 25 Client IDs share it (July 2026) | [Quota updates, Jul 23, 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates) | Correct |
| Quota overruns return 429 with `QUOTA_EXCEEDED`, unlike rate limits | [Quota updates, Jul 23, 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates) | Correct |
| Access tokens last 1 hour | [Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens) | Correct |
| Refresh tokens expire 6 months after the original authorization; refreshing doesn't extend it; existing apps from Jul 20, 2026; `400 invalid_grant` | [Refresh token expiration, Jun 18, 2026](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration) | Correct. The agent marked it "secondary" because it only saw a search snippet: cautious, not wrong. |
| `account_id` added May 2026 as the stable ID for linking accounts | [May 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/may-2026) | Correct |
| Rate limits use a rolling 30-second window, numbers not published | Rate limits page (cited by the agent) | Correct, and correctly marked "not verified" for numbers |

**What the agent missed:** Spotify's redirect URI rules. HTTPS is required except for loopback addresses, `localhost` is not allowed (use `http://127.0.0.1:PORT`), enforced for new apps from Apr 9, 2025 and for all apps by November 2025 ([Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)). Developers testing locally hit this first, so it belongs in Common blockers.

**What the self-check caught on its own:** an inconsistent scope count between the intro and the table, and a blocker whose cited source was about something else. Both were downgraded before the guide could be saved.

**Not verified by us either:** whether Composio offers a managed Spotify app (the agent found conflicting Composio pages and kept "no"), and Developer Policy details such as one Client ID per product.

**What we learned:** on a vendor with fast-moving 2026 rules, the agent got every checked fact right and leaned cautious when it hadn't read a full page. Its weak spot is completeness: a well-known blocker that sits on a page it didn't open. That is the case for the next step, a live verifier that opens each cited page and a checklist of standard blockers (redirect URI rules, token expiry, allowlists) for every guide.

Bugs found only in live runs, now fixed: thinking blocks were sent back empty when a research turn continued (API 400), and the progress list stalled because it waited for stage markers the model did not always write (now inferred from tool activity).

## Agent and product checks

- `npm test`: 76 unit and edge-case tests, all passing, against a fake Claude API that follows the documented streaming format: text, server tool use, `pause_turn` continuation, client tool rounds (skills, page rendering, library tools), tool errors, API and stream errors, and the round limit.
- Research agent end to end: the model loads a skill, renders a JavaScript page, searches, streams all 14 sections; the self-check lowers an unsupported claim; a failed review still finishes; a vendor without OAuth stops after header and evidence; an empty answer is an error, not an empty success.
- Chat agent end to end: reads another guide to compare and answers with citations; proposes research and corrections but cannot write; corrections are saved only through the approval endpoint.
- Server rules: library guides can't be replaced; generated guides are forced to "generated" and "tested" claims are downgraded; an existing guide needs explicit overwrite; private and internal URLs can't be rendered; per-network rate limits.
- `npm run validate`: all 8 library guides pass the schema. Tests also check that no guide or skill contains an em dash, every source is a link, and the bundled content matches the files.
- `npm run e2e` (browser, mock mode): 10 of 10 checks pass, including filters, instant library lookup, the confirm step for rough names, chat with citations, approve-to-save, a full research run with save, no sideways scrolling at phone width, and no JavaScript errors.
- Dependency audit: 0 production vulnerabilities after upgrading to Next.js 16.4.1 and React 19.3.1. Next.js 14 had critical advisories.
- Not run in the build sandbox: a live research pass against the real API (outbound network to api.anthropic.com is blocked there). DEPLOY.md step 4 is the first live run.
