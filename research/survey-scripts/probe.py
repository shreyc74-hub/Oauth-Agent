import json, re, sys, ssl, os, urllib.request, concurrent.futures as cf
sys.path.insert(0, ".")
from platforms import platform_of
EXTRA = {"google.com": ["accounts.google.com"], "microsoftonline.com": ["login.microsoftonline.com/common/v2.0", "login.microsoftonline.com/organizations/v2.0"],
         "salesforce.com": ["login.salesforce.com"], "zoho.com": ["accounts.zoho.com"], "slack.com": ["slack.com"], "x.com": ["api.x.com", "twitter.com"],
         "atlassian.com": ["auth.atlassian.com", "mcp.atlassian.com"], "intuit.com": ["oauth.platform.intuit.com", "appcenter.intuit.com"], "paypal.com": ["api-m.paypal.com"],
         "facebook.com": ["graph.facebook.com", "www.facebook.com"], "linkedin.com": ["www.linkedin.com"], "squareup.com": ["connect.squareup.com"], "sentry.io": ["mcp.sentry.dev"]}
ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
op = urllib.request.build_opener(urllib.request.ProxyHandler({"https": os.environ.get("HTTPS_PROXY")}), urllib.request.HTTPSHandler(context=ctx))
def get(url):
    try:
        r = op.open(urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "oauth-survey/1.0"}), timeout=8)
        if r.status != 200: return None
        return json.loads(r.read(200000).decode("utf-8", "replace"))
    except Exception: return None
base = lambda h: ".".join(h.split("/")[0].split(".")[-2:])
def probe(domain):
    hosts = [domain, f"www.{domain}", f"api.{domain}", f"auth.{domain}", f"mcp.{domain}"] + EXTRA.get(domain, [])
    docs = []
    for h in dict.fromkeys(hosts):
        origin, path = (h.split("/", 1) + [""])[:2]
        p = f"/{path}" if path else ""
        docs += [f"https://{origin}/.well-known/oauth-authorization-server{p}", f"https://{origin}{p}/.well-known/openid-configuration"]
    found = []
    def check(url, kind):
        j = get(url)
        if not isinstance(j, dict) or not (j.get("authorization_endpoint") or j.get("token_endpoint") or j.get("issuer")): return
        reg = j.get("registration_endpoint")
        ok = bool(reg and reg.startswith("https://") and base(re.sub(r"^https://", "", reg)) in {base(re.sub(r"^https://", "", url)), domain})
        found.append({"url": url, "kind": kind, "registration": reg if ok else None})
    for u in docs: check(u, "mcp" if "//mcp." in u else "api")
    # MCP protected resource metadata, plain and path forms
    for h in [x for x in dict.fromkeys(hosts) if x.startswith("mcp.")]:
        for pr in [f"https://{h}/.well-known/oauth-protected-resource", f"https://{h}/.well-known/oauth-protected-resource/mcp", f"https://{h}/.well-known/oauth-protected-resource/sse"]:
            j = get(pr)
            for s in (j or {}).get("authorization_servers", [])[:3] if isinstance(j, dict) else []:
                s = s.rstrip("/"); o = re.match(r"https://[^/]+", s)
                if not o: continue
                rest = s[len(o.group(0)):]
                check(f"{s}/.well-known/oauth-authorization-server", "mcp")
                if rest: check(f"{o.group(0)}/.well-known/oauth-authorization-server{rest}", "mcp")
    api = next((f for f in found if f["registration"] and f["kind"] == "api"), None)
    mcp = next((f for f in found if f["registration"] and f["kind"] == "mcp"), None)
    return {"domain": domain, "metadata_found": len(found), "dcr_api": api["registration"] if api else None, "dcr_mcp": mcp["registration"] if mcp else None, "docs": [f["url"] for f in found][:6]}
d = json.load(open("toolkits.json"))
need = [r for r in d if re.search(r"OAUTH2|OAUTH1|S2S_OAUTH2", r.get("auth") or "")]
plats = {}
for r in need:
    p, dom = platform_of(r["slug"], r.get("name") or r["slug"]); plats.setdefault(p, dom)
with cf.ThreadPoolExecutor(16) as ex:
    res = dict(zip(plats, ex.map(probe, plats.values())))
json.dump(res, open("dcr.json", "w"), indent=1)
print("platforms", len(res), "with OAuth metadata", sum(1 for v in res.values() if v["metadata_found"]),
      "DCR on main API", sum(1 for v in res.values() if v["dcr_api"]), "DCR only via MCP", sum(1 for v in res.values() if v["dcr_mcp"] and not v["dcr_api"]))
for p, v in res.items():
    if v["dcr_api"] or v["dcr_mcp"]: print(f"  {p}: api={v['dcr_api']} mcp={v['dcr_mcp']}")
