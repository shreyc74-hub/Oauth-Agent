# How each Composio toolkit's OAuth app can be created

Survey of all 1,745 toolkits on docs.composio.dev, run on 2026-11-15. Each toolkit is mapped to the first method that can create its OAuth app without a person, cheapest and most reliable first. Full table: `oauth-app-creation-methods.csv` (one row per toolkit). Raw registration probe results: `dcr-probe-results.json`. Scripts: `survey-scripts/`.

| Method | Toolkits | Platforms |
|---|---|---|
| DCR on the main OAuth server (measured) | 39 | 34 |
| Management API (Microsoft Graph, Slack, Zendesk, Snowflake, Databricks, ServiceNow, Dropbox Sign) | 28 | 7 |
| CLI or infrastructure as code (Shopify, HubSpot) | 2 | 2 |
| Manifest plus one click (GitHub) | 1 | 1 |
| Browser; DCR only on the vendor's MCP server (measured) | 47 | 46 |
| Browser automation | 157 | 109 |
| Human or partner-gated | 31 | 26 |
| DCR, already used by Composio (DCR_OAUTH in its docs) | 110 | |
| No OAuth app needed (API key, basic, bearer, no auth) | 1,330 | |

305 toolkits need an OAuth app, on 225 platforms: many toolkits share one platform (26 Google toolkits, 21 Microsoft, 14 Zoho).

## Build and test order

1. Microsoft Graph app registration: one API, 21 toolkits.
2. Dynamic Client Registration on the main OAuth server: one code path, 34 platforms. One real registration per platform first; some endpoints need an initial access token or are per account.
3. Browser playbooks for Google Cloud and the Zoho API Console: 40 toolkits.
4. Fixed routes: Slack (built), GitHub manifests, Shopify and HubSpot CLIs, Zendesk, Snowflake, Databricks, ServiceNow, Dropbox Sign.
5. The long tail by browser, about 150 platforms. 46 of them accept self-registration on their MCP server, an alternative for MCP-based toolkits.
6. 26 gated platforms to a person.

## How it was measured, and what wasn't

- Registration support is measured: code fetched the vendors' public OAuth and OpenID metadata and MCP protected-resource metadata and looked for `registration_endpoint` (https, vendor's own domain only). Nothing was registered. An advertised endpoint is not proof of open registration.
- Management APIs, CLIs, manifest flows, the gated list, and vendor domains for toolkits whose docs page names none come from documentation knowledge. They are a starting list to verify.
