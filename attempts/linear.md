# Linear setup attempt

- Date: 2026-10-28, about 00:59 to 01:05 IST
- Driven by: Claude in Chrome, in the user's signed-in browser
- Workspace: user's new Linear workspace
- App: "OAuth Readiness Test" (public)

## Timeline

| Time spent | Step | Who |
|---|---|---|
| ~1 min | Settings link opened the Linear desktop app first; needed "Open here instead" | Agent |
| ~1 min | New workspace onboarding ("Set up your profile") blocked Settings > API | You |
| ~2 min | Filled Create new application form, turned on Public | Agent |
| — | Approved Create | You |
| instant | App created, "Availability: Publicly available", client ID shown, secret masked | Linear |
| ~1 min | Opened the authorize URL to view the consent screen (did not approve) | Agent |

Working public app: about 4 minutes of agent work, plus onboarding and one approval.

## Differences from the docs and from our draft guide

1. **Correction to our draft:** apps are private by default. The form has a "Public: Allow this application to be installed by other workspaces" toggle, off by default. Our draft said any workspace could authorize. Without this toggle, a developer's first customer cannot connect.
2. Developer URL is required for public apps, and it is shown to users.
3. No scopes are configured on the app. Scopes are requested in the authorize URL.
4. Client credentials and webhooks are separate opt-in toggles on the form.
5. App page offers a "Developer token" ("Create & copy token") for testing without running the OAuth flow.
6. No review step. Public availability was immediate.
7. Consent screen lists permissions in plain language ("Read access to your workspace", "Create issues for your workspace") and adds **Team access: All public teams / Only select teams**. Users can limit the agent to some teams, so an agent may see fewer issues than expected. Private teams are not in "All public teams".
8. Consent screen has no "unverified app" warning.
9. Consent screen footer says the app's use of data is governed by the app's own terms and privacy policy, and that owners and admins can revoke the connection in Settings.
10. Linear links open the desktop app if installed; browser-based setup needs "Open here instead". New workspaces must finish onboarding before Settings are reachable.

## Agent vs human boundary (observed)

- Agent did: fill all fields, set Public, read the result, build and open the authorize URL.
- Human had to: sign in, finish onboarding, approve creation. Client secret was never revealed.

## Not tested

- Completing authorization and the token exchange (would need Composio auth config with the secret).
- 24-hour access token expiry and refresh rotation (needs a real token over a day).
