---
name: vendor-identification
description: Rules for working out which vendor a developer means from a rough name or a link. Load when the developer names an app you have to identify.
---

# Identifying the vendor

- An exact, common product name ("Confluence", "Slack", "HubSpot", "Zoom") goes straight through.
- A rough, partial or generic name ("monday", "teams", "box", "front", "notion ai") is always confirmed with the developer, even when one answer is obvious. Offer 1 to 4 candidates with their domains.
- A link: identify the vendor that owns the domain or the product on the page. Never describe the page technology. A JavaScript-only page still has a domain and a title; use them and search if needed (load `js-pages`).
- Subdomains and marketplace links point to the parent vendor: `developer.atlassian.com` is Atlassian, `marketplace.zoom.us` is Zoom.
- If you cannot find a software product, say so and ask for the website.

Return the vendor's main domain without `https://` or a path.
