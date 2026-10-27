---
name: no-oauth
description: What to write when a vendor does not offer OAuth for third-party apps. Load as soon as you suspect the vendor only offers API keys, personal tokens or basic auth.
---

# Vendor without OAuth

Before deciding, check twice: search "<vendor> OAuth 2.0" and "<vendor> partner integration OAuth". Some vendors only offer OAuth to approved partners. That is still OAuth: write the full guide and treat the partner program as the approval gate.

If there really is no OAuth for third-party apps:

1. Emit `header` with `oauth.supported` = false. In `oauth.note` say, in two or three sentences:
   - what it uses instead (API keys created per account, personal access tokens, basic auth, service accounts)
   - who creates the key (each customer, an admin, only the account owner)
   - what that means on Composio: users paste a key instead of clicking Connect, and the developer has no app to register or get approved
2. Write the verdict for that case, for example "There is no OAuth app to create. Each customer creates an API key in their own account and pastes it in."
3. Emit `evidence` with the pages that show it.
4. Stop. Do not emit the other sections.
