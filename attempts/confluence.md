# Confluence (Atlassian) setup attempt

- Date: 2026-10-28, about 01:26 to 01:33 IST
- Driven by: Claude in Chrome, in the user's signed-in browser
- Account: user's Atlassian account
- App: "OAuth Readiness Test" (OAuth 2.0 (3LO) integration, resource-level)

## Timeline

| Time spent | Step | Who |
|---|---|---|
| — | Allowed the extension on developer.atlassian.com, signed in | You |
| ~1 min | Console > Create > OAuth 2.0 integration; name; access type | Agent |
| — | Approved agreeing to Atlassian developer terms and Create | You |
| instant | App created: distribution "Not sharing", no scopes | Atlassian |
| ~1 min | Opened distribution controls to read the sharing requirements, cancelled without saving | Agent |
| ~2 min | Permissions: added Confluence API, 3 classic read scopes | Agent |
| ~1 min | Authorization: added OAuth 2.0 (3LO) with the Composio callback | Agent |

Private working app: about 5 minutes. Sharing with other customers needs vendor details, policy links and a personal data declaration (self-serve, no review for OAuth apps; Marketplace listing is separate).

## Differences from the docs and from our assumptions

1. **Rotating refresh tokens are mandatory** for new OAuth 2.0 integrations (banner on the create page). Reusing an old refresh token is detected.
2. **New "Access type" at creation:** Resource-level (only the site the user selects, e.g. acme.atlassian.net) or Account-level (every site in the customer's account). Neither is pre-selected.
3. New "Developer Space" selector in the console, and a "Contributors (NEW)" page on the app.
4. **Apps start private ("Not sharing").** "Only you can install and use it." To share: switch to Sharing and provide vendor name, privacy policy, terms of service, customer support contact.
5. **Personal data declaration is required to share.** You must answer Yes if you store personal data tied to user references (such as account ID) in your own systems, or cache data for longer than 24 hours. Agents that keep memory or index pages will usually be Yes, which brings Atlassian's personal data reporting API obligations.
6. Stopping sharing later "may affect existing app users".
7. Scopes are added per API (Confluence, Jira, User identity, Personal data reporting, Goals, Projects, and others). Atlassian recommends no more than 50 scopes and suggests classic scopes to keep the count down.
8. **Two scope systems, classic and granular.** After adding only classic scopes, the authorization page warned that the Confluence API had no granular scopes and to add them. Newer endpoints need granular scopes; mixing them up is a common cause of 401 errors.
9. OAuth 2.0 (3LO) authorization must be added separately on the Authorization page; up to 30 callback URLs. The page then generates an authorization URL (using the first callback URL).

## Agent vs human boundary (observed)

- Agent did: everything in the console after sign-in, including scopes and callback.
- Human had to: grant the browser extension access to the site, sign in, approve the developer terms.
- Human needed later: vendor details, real privacy policy and terms URLs, the personal data decision (a legal and product call, not a form-filling one).

## Not tested

- Switching to Sharing (needs real privacy policy and terms URLs).
- Consent screen and token exchange.
- Personal data reporting API cadence.
