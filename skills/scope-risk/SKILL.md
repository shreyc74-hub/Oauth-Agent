---
name: scope-risk
description: How to pick scopes for agent use cases and rate what each one costs in review. Load before writing the scopes section.
---

# Scope risk

Write the scopes table from the agent's point of view: what the agent needs to do, then the smallest scopes that allow it.

## Use cases to cover (pick those that apply)

- Read items (messages, records, pages, issues)
- Search
- Create and update items
- Read history or older data (often the expensive one)
- Act as the user vs act as a bot or app identity
- Webhooks or events instead of polling
- Offline access or refresh tokens

## Levels for `level`

- `none`: no review needed beyond creating the app
- `limited`: works, but capped or throttled until review
- `review`: needs the provider's app review or marketplace approval
- `audit`: needs a security assessment or partner approval

## Rules

- Prefer granular scopes when the provider has both classic and granular. Say which family the guide uses.
- Read-only scopes are not automatically safe. Some providers classify "metadata" or read-only mail scopes as restricted. Check the provider's own classification page.
- Offline access is usually a separate scope or parameter. An unattended agent needs it. Say what it is called.
- `minimalSets`: give 1 to 3 starter sets, for example "Read-only assistant" and "Can post or create".
- `changingLater`: what happens when you add a scope after users connected: re-consent for every user, a new review, or nothing. This is the most asked question after launch.
