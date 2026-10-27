---
name: approval-programs
description: Patterns in provider review and verification programs, what they gate, and what to look for. Load when writing the approval, limits or one-way doors sections.
---

# Approval programs: what to look for

Providers gate real users in a handful of recurring ways. Identify which ones apply, then find the provider's current numbers. The examples below are patterns from guides we already checked. Treat them as hints of where to look, never as facts for a new vendor.

## The five gate types

1. **No review.** Any account can install once the app is public or shared. Look for a "public" or "distribution" toggle and whether turning it off later uninstalls everyone (Slack does).
2. **Install or user cap until review.** A hard number of installs, workspaces or users before review. Example patterns: a cap on unverified users counted over the app's lifetime (Google), a cap on installs for unlisted apps (HubSpot). Find the number and whether it is lifetime or concurrent.
3. **Rate limits for unreviewed apps.** Some providers throttle unlisted apps far below listed ones (Slack throttles history reads for unlisted apps). These break agents that read history, so call them out in limits and one-way doors.
4. **Formal review or marketplace listing.** A submission with screenshots, a demo video, a privacy policy and test credentials. Find: published timeline, what counts as "started", typical rejection reasons, cost, and whether listing requires a minimum number of active installs.
5. **Security assessment.** A third-party audit for sensitive data (Google restricted scopes need an annual CASA assessment). Find: which scopes trigger it, who pays, renewal.

## Questions to answer for every vendor

- What works with no review at all, and for how many users?
- What exactly triggers review: a scope, a user count, listing in a marketplace, or a branding change? (Uploading a logo can trigger Google verification.)
- Are there admin approvals inside the customer's org that block installs even after provider approval (Microsoft admin consent, Salesforce connected app policies, Atlassian admin allow lists)?
- Is the decision reversible? Owning workspace, app type, single vs multi tenant, and region are often permanent.

## Writing it

- Hands-on time and waiting time are separate numbers. "2 hours of work, then 4 to 6 weeks of waiting".
- Put each wait in `approval.stages` with its own duration.
- Every cap or limit needs an evidence line.
