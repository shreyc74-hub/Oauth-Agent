---
name: credential-handoff
description: How to rate whether a client ID and secret can reach Composio without a person seeing the secret. Load before writing the credential handoff section.
---

# Credential handoff

The developer wants the client ID and secret in a Composio auth config or a secrets manager, never in a chat, a spreadsheet or a screenshot.

## Levels

1. **Fully automatic.** The provider has an API that creates the app (for example an app manifest API) and returns the credentials to a backend. A tool can pass them straight to Composio. Nobody sees the secret.
2. **Browser copy-paste.** Console only. An agent driving a browser can use the console's copy button and paste into Composio without reading or screenshotting the value.
3. **Human required.** The provider forces a human step to reveal the secret: an email code, re-entering a password, an owner-only role, or a secret shown once.

## How to decide

- Search "<vendor> create app API" or "app manifest API". If an API returns `client_secret`, it is level 1.
- If the console shows the secret behind a "reveal" or "regenerate" button with no extra verification, level 2.
- If revealing needs a code, a password prompt or is shown only once, level 3.
- If you could not tell, pick 2 and give status "unverified".

## Also say

- Whether the secret can be rotated without breaking existing connections.
- Whether there is a separate signing secret or webhook secret the agent also needs.
