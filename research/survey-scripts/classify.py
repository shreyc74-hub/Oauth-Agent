import json, re, csv, sys, collections
sys.path.insert(0, ".")
from platforms import platform_of
d = json.load(open("toolkits.json")); dcr = json.load(open("dcr.json"))
# Known non-browser creation routes (from documentation knowledge; marked unverified in the output).
MGMT_API = {
 "Microsoft Entra ID (app registration)": "Microsoft Graph: POST /applications, then addPassword for a client secret",
 "Slack apps": "apps.manifest.create with an app configuration token (already used by this agent)",
 "Zendesk": "OAuth Clients API: POST /api/v2/oauth/clients",
 "Snowflake": "SQL: CREATE SECURITY INTEGRATION ... OAUTH_CLIENT = CUSTOM, then SYSTEM$SHOW_OAUTH_CLIENT_SECRETS",
 "Databricks": "Account API: custom OAuth app integrations",
 "ServiceNow": "Instance REST Table API on oauth_entity (free Personal Developer Instance)",
 "Dropbox Sign": "API: POST /v3/api_app (creates the OAuth app)",
}
CLI = {
 "Shopify": "Shopify CLI: app config TOML, shopify app deploy",
 "HubSpot": "HubSpot CLI: hs project upload (2025.2+ developer platform)",
 "Salesforce (Connected / External Client App)": "sf CLI: deploy a Connected App / External Client App as metadata",
}
MANIFEST = {"GitHub": "GitHub App manifest flow: one click, then POST /app-manifests/{code}/conversions returns client ID, secret and key"}
GATED = {  # no self-serve test setup, or OAuth only after partner/vendor approval
 "Workday": "customer tenant or partner programme", "Workday Adaptive Planning": "customer tenant or partner programme", "Rippling": "partner programme",
 "Coupa": "customer instance", "Anaplan": "customer workspace", "Sage Intacct": "partner/subscription", "Netsuite": "paid NetSuite account (DCR is per account)",
 "ServiceTitan": "developer programme application", "Personio": "customer account", "Carta": "partner programme", "Deel": "partner programme", "Navan": "customer account",
 "Tipalti": "customer account", "Ramp": "business account", "Brex": "business account / partner", "Lever": "partner programme", "Greenhouse": "partner programme",
 "Gong": "customer account", "D2L Brightspace": "institution instance", "Blackboard": "institution / partner", "Canvas": "admin of a Canvas instance",
 "Linkedin Ads": "Marketing Developer Platform approval", "TikTok for Developers": "app review for most scopes", "Snapchat": "Marketing API approval",
 "Reddit apps": "ads API access approval", "Amazon": "SP-API / LWA approval", "Zoominfo": "customer account", "Ironclad": "customer account", "Smokeball": "partner programme",
}
mcp_path = lambda u: bool(u and re.search(r"/mcp(/|$)|//mcp\.", u))
rows, plat_rows = [], {}
for r in d:
    auth = (r.get("auth") or "NONE").replace(" ", "")
    schemes = set(auth.split(","))
    oauth_app = bool(schemes & {"OAUTH2", "OAUTH1", "S2S_OAUTH2"})
    name = r.get("name") or r["slug"]
    if not oauth_app:
        bucket = "DCR, already used by Composio" if "DCR_OAUTH" in schemes else "No OAuth app needed"
        rows.append({"toolkit": r["slug"], "name": name, "auth": auth, "platform": "", "method": bucket, "detail": "", "evidence": "Composio docs"})
        continue
    plat, dom = platform_of(r["slug"], name)
    v = dcr.get(plat, {})
    main = v.get("dcr_api") if v.get("dcr_api") and not mcp_path(v.get("dcr_api")) else None
    mcp = v.get("dcr_mcp") or (v.get("dcr_api") if mcp_path(v.get("dcr_api")) else None)
    if plat in GATED or name in GATED:
        m, det, ev = "Human / partner-gated", GATED.get(plat) or GATED.get(name), "knowledge (unverified)"
    elif main:
        m, det, ev = "DCR on the main OAuth server", main, "measured: registration_endpoint in public metadata"
    elif plat in MGMT_API:
        m, det, ev = "Management API", MGMT_API[plat], "knowledge (vendor docs)"
    elif plat in CLI:
        m, det, ev = "CLI / infrastructure as code", CLI[plat], "knowledge (vendor docs)"
    elif plat in MANIFEST:
        m, det, ev = "Manifest + one click", MANIFEST[plat], "knowledge (vendor docs)"
    elif mcp:
        m, det, ev = "Browser (DCR only on the MCP server)", mcp, "measured: MCP server registration_endpoint"
    else:
        m, det, ev = "Browser automation", f"no registration endpoint found ({v.get('metadata_found', 0)} metadata documents)", "measured: no DCR; no known API"
    extra = []
    if main and m != "DCR on the main OAuth server": extra.append(f"also advertises DCR at {main}")
    if mcp and m != "Browser (DCR only on the MCP server)": extra.append(f"MCP DCR at {mcp}")
    if "API_KEY" in schemes: extra.append("API key also supported")
    row = {"toolkit": r["slug"], "name": name, "auth": auth, "platform": plat, "method": m, "detail": det + (f" | {'; '.join(extra)}" if extra else ""), "evidence": ev}
    rows.append(row); plat_rows.setdefault(plat, {**row, "toolkits": []})["toolkits"].append(r["slug"])
order = ["DCR on the main OAuth server", "Management API", "CLI / infrastructure as code", "Manifest + one click", "Browser (DCR only on the MCP server)", "Browser automation", "Human / partner-gated", "DCR, already used by Composio", "No OAuth app needed"]
tk = collections.Counter(r["method"] for r in rows); pl = collections.Counter(p["method"] for p in plat_rows.values())
print(f"{'method':42} toolkits platforms")
for k in order: print(f"{k:42} {tk[k]:8} {pl.get(k, '')}")
print("total", sum(tk.values()), "oauth platforms", len(plat_rows))
with open("toolkit_methods.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["toolkit", "name", "auth", "platform", "method", "detail", "evidence"]); w.writeheader(); w.writerows(rows)
json.dump({"toolkits": rows, "platforms": [{**p, "toolkit_count": len(p["toolkits"])} for p in plat_rows.values()], "order": order,
           "counts": {k: {"toolkits": tk[k], "platforms": pl.get(k, 0)} for k in order}}, open("survey_result.json", "w"))
