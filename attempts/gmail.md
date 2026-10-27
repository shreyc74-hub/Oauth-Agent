# Gmail (Google Auth Platform) setup attempt

- Date: 2026-10-28, about 01:17 to 01:26 IST
- Driven by: Claude in Chrome, in the user's signed-in browser
- Account: personal Google account, no Google Workspace organization
- Project: "oauth-readiness-test" (new Google Cloud project, no billing)

## Timeline

| Time spent | Step | Who |
|---|---|---|
| ~1 min | New project form (name) | Agent |
| — | Approved project creation | You |
| ~15 s | Project created; console stayed on a different project until switched | Google |
| ~4 min | Google Auth Platform setup wizard: app name, support email, audience, contact email | Agent |
| — | Approved agreeing to the Google API Services User Data Policy and Create | You |
| ~10 s | Configuration created in Testing status | Google |
| ~3 min | Data Access: pasted gmail.send and gmail.readonly, saw classification | Agent |
| — | Approved Save | You |
| ~1 min | Read Audience, Verification Center and Branding pages | Agent |

Testing-mode app with Gmail scopes: about 10 minutes, three approvals. Production use is blocked until verification.

## Differences from the docs and from our draft guide

1. The consent screen is now "Google Auth Platform" with Overview, Branding, Audience, Clients, Data Access, Verification Center, Settings. Older guides say "OAuth consent screen".
2. **Internal user type is disabled for accounts without Google Workspace.** The tooltip says only external (general audience) is possible. Solo developers and startups without Workspace cannot use the verification-free internal route.
3. User support email can only be your own account email or a Google Group you manage. A shared support inbox has to be a Google Group.
4. Setup requires agreeing to the Google API Services User Data Policy.
5. **Confirmed in console (was secondary):** "Allowed user cap prior to app verification is 100, and is counted over the entire lifetime of the app." Audience page shows "0 users (0 test, 0 other) / 100 user cap".
6. Gmail scopes do not appear in the scope picker until the Gmail API is enabled on the project. The picker offers "Manually paste scopes" as a workaround.
7. **Confirmed in console:** gmail.send lands under "Your sensitive scopes"; gmail.readonly lands under "Your restricted scopes" ("highly sensitive user data").
8. Verification Center in Testing status says verification is not required. It does not preview the requirements until you move toward production.
9. Branding page: uploading a logo means you must submit for verification (unless internal or in Testing), even with no sensitive scopes. Homepage, privacy policy and terms links, and authorized domains are needed to publish. Authorized domains must be verified in Google Search Console.
10. Publishing needs the Branding page completed first ("To publish your app, you must complete your configuration on the Branding page").

## Agent vs human boundary (observed)

- Agent did: fill the wizard, pick audience, add scopes by pasting, read every status page.
- Human had to: be signed in, approve project creation, approve the policy agreement, approve saving scopes.
- Cannot be done by an agent at all: domain verification in Search Console (needs DNS or site access), demo video, CASA assessment, responding to Google reviewers.

## Not tested

- Publishing to production and submitting for verification (needs a real homepage, privacy policy and verified domain).
- 7-day refresh token expiry in Testing (needs a real token over a week).
- OAuth client creation (client secret behaviour).
