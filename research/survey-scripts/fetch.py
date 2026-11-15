import concurrent.futures as cf, json, re, sys, urllib.request, ssl, os
slugs = [s.strip() for s in open(sys.argv[1]) if s.strip()]
out = sys.argv[2]
ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
proxy = urllib.request.ProxyHandler({"https": os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")})
opener = urllib.request.build_opener(proxy, urllib.request.HTTPSHandler(context=ctx))
def get(slug):
    try:
        r = opener.open(urllib.request.Request(f"https://docs.composio.dev/toolkits/{slug}.md", headers={"user-agent": "survey"}), timeout=30)
        t = r.read().decode("utf-8", "replace")
    except Exception as e:
        return {"slug": slug, "error": str(e)[:100]}
    m = lambda p: (re.search(p, t) or [None, None])[1]
    title = m(r'^title:\s*"?([^"\n]+)') or m(r'^#\s+(.+)$')
    links = re.findall(r'https?://([a-z0-9.-]+\.[a-z]{2,})', t)
    doms = [d for d in dict.fromkeys(links) if not re.search(r'composio|github\.com/composio|googleapis\.com/composio', d)]
    return {"slug": slug, "name": title, "category": m(r'\*\*Category:\*\*\s*([^\n]+)'), "auth": m(r'\*\*Auth:\*\*\s*([^\n]+)'),
            "managed": m(r'\*\*Composio-managed OAuth available\?\*\*\s*([^\n]+)'), "domains": doms[:8], "len": len(t),
            "byo": bool(re.search(r'bring your own|own (OAuth )?app|client ID and client secret', t, re.I))}
res = []
with cf.ThreadPoolExecutor(8) as ex:
    for i, r in enumerate(ex.map(get, slugs)):
        res.append(r)
        if i % 250 == 0: print(i, file=sys.stderr)
json.dump(res, open(out, "w"))
print("done", len(res), "errors", sum(1 for r in res if "error" in r))
