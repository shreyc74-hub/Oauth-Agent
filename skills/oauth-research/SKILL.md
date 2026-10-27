---
name: oauth-research
description: The research order and source rules for writing an OAuth app readiness guide. Load at the start of any new guide.
---

# Researching an OAuth app readiness guide

Work in this order and mark each stage by writing its marker line on its own line before you start it.

1. `{"stage":"oauth"}` Confirm the vendor offers OAuth 2.0 for third-party apps. Search "<vendor> OAuth app developer". If you only find API keys, personal tokens or basic auth, load the `no-oauth` skill and follow it.
2. `{"stage":"docs"}` Official developer docs. You need, in this order of importance:
   - how to create the app and which app types or distribution modes exist
   - what is capped or blocked before review (install caps, user caps, rate limits, test-user lists)
   - the review, verification or marketplace process: when it is required, what you submit, how long, cost, renewal
   - scopes and how they are classified
   - token lifetimes, refresh behaviour, rotation
   - API terms on storing data and AI training
3. `{"stage":"changelog"}` The vendor's developer changelog for the last 18 months. Look for new restrictions, deprecations, review changes and rate-limit changes. A change dated in the future or "effective from" a date is important: say which date.
4. `{"stage":"secondary"}` Integration platforms' setup guides (Zapier, n8n, Make, Nango, Merge, Pipedream, Paragon) and developer forums, for real review times and the exact error messages people hit.
5. `{"stage":"composio"}` docs.composio.dev for whether this toolkit has a Composio-managed OAuth app. If no page confirms it, use "unknown". Never guess "yes".

## Source rules

- Official provider pages beat everything. Status "docs" means you read it on the provider's own domain or its official developer site.
- When two sources disagree, keep the official value in the guide and add an evidence line with status "conflict" that names both values and both sources.
- Never invent a number. If a review timeline is not published, write "Not published" and give the best secondary estimate with status "secondary".
- Never write status "tested". You did not create an app.
- Keep each claim next to where you read it, so the evidence table can name the page.

## Budget

You have about 10 searches and 8 page reads. Spend them on stage 2 first. If a page comes back empty or says to enable JavaScript, load `js-pages`.

## Skills worth loading

- `approval-programs` once you know which review program the vendor runs
- `scope-risk` before writing the scopes section
- `credential-handoff` before writing the credential handoff section
