"use client";
// The search box and the agent's decision points:
// A. rough name -> confirm the vendor   B. no guide yet -> offer research (runs on /research)
// library hit -> open the guide          unknown -> say so and ask for the website
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BUDGET } from "@/lib/agent/budget";

type Candidate = { name: string; website: string; description?: string };
type Resolve =
  | { kind: "library"; slug: string; name: string }
  | { kind: "confirm"; candidates: Candidate[]; reason?: string }
  | { kind: "new"; vendor: Candidate; slug: string }
  | { kind: "notfound"; message: string }
  | { kind: "agentoff"; query: string; message: string };

type Phase =
  | { p: "idle" }
  | { p: "resolving"; q: string }
  | { p: "opening"; name: string }
  | { p: "confirm"; q: string; r: Extract<Resolve, { kind: "confirm" }> }
  | { p: "offer"; vendor: Candidate; overwrite: boolean }
  | { p: "notfound"; message: string }
  | { p: "agentoff"; message: string }
  | { p: "error"; message: string };

export function researchHref(v: Candidate, overwrite = false) {
  const q = new URLSearchParams({ name: v.name, website: v.website || "" });
  if (overwrite) q.set("overwrite", "1");
  return `/research?${q.toString()}`;
}

const TRIES = ["Slack", "monday", "https://calendly.com", "Zoom"];

export default function Explorer({ agentOn }: { agentOn: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<Phase>({ p: "idle" });
  const ran = useRef("");

  async function post(body: unknown): Promise<Resolve> {
    const res = await fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = (await res.json().catch(() => ({}))) as Resolve & { error?: string };
    if (!res.ok) throw new Error(r.error || "Could not look that up. Try again.");
    return r;
  }

  function route(r: Resolve, query: string) {
    if (r.kind === "library") { setPhase({ p: "opening", name: r.name }); router.push(`/guides/${r.slug}`); return; }
    if (r.kind === "confirm") { setPhase({ p: "confirm", q: query, r }); return; }
    if (r.kind === "new") { setPhase({ p: "offer", vendor: r.vendor, overwrite: false }); return; }
    if (r.kind === "agentoff") { setPhase({ p: "agentoff", message: r.message }); return; }
    setPhase({ p: "notfound", message: r.message });
  }

  async function resolve(query: string) {
    const v = query.trim();
    if (!v) return;
    setQ(v);
    setPhase({ p: "resolving", q: v });
    try { route(await post({ query: v }), v); }
    catch (e) { setPhase({ p: "error", message: (e as Error).message }); }
  }

  async function pick(c: Candidate) {
    setPhase({ p: "resolving", q: c.name });
    try { route(await post({ query: c.website || c.name, confirmed: c }), c.name); }
    catch (e) { setPhase({ p: "error", message: (e as Error).message }); }
  }

  // ?q=Calendly runs a lookup (links from chat); ?regenerate=Name&website=x offers research again.
  useEffect(() => {
    const regen = params.get("regenerate");
    const query = params.get("q");
    const key = `${regen}|${query}`;
    if (ran.current === key) return;
    ran.current = key;
    if (regen) setPhase({ p: "offer", vendor: { name: regen, website: params.get("website") || "" }, overwrite: true });
    else if (query) resolve(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Puts "https://" in the box and the cursor after it, so the developer only types the domain.
  function tryWebsite() {
    setQ("https://");
    setPhase({ p: "idle" });
    requestAnimationFrame(() => {
      const el = document.getElementById("app-query") as HTMLInputElement | null;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }

  const busy = phase.p === "resolving" || phase.p === "opening";

  return (
    <div>
      <form className="ask" role="search" onSubmit={(e) => { e.preventDefault(); resolve(q); }}>
        <label className="sr" htmlFor="app-query">App name or link</label>
        <input id="app-query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="App name or link, e.g. Zoom, monday, https://calendly.com" disabled={busy} autoComplete="off" />
        <button className="btn primary" type="submit" disabled={busy || !q.trim()}>{phase.p === "resolving" ? <><span className="spin" /> Looking it up</> : "Find guide"}</button>
      </form>
      <div className="tries"><span>Try</span>{TRIES.map((t) => <button key={t} type="button" className="chip" disabled={busy} onClick={() => resolve(t)}>{t}</button>)}</div>

      <div aria-live="polite">
        {phase.p === "opening" && <div className="card"><p><span className="spin" /> Opening the {phase.name} guide…</p></div>}

        {phase.p === "confirm" && (
          <div className="card">
            <div className="kicker">You typed “{phase.q}”</div>
            <h3>Which app do you mean?</h3>
            {phase.r.reason && <p>{phase.r.reason}</p>}
            <div className="cands">
              {phase.r.candidates.map((c, i) => (
                <button key={c.website + c.name} type="button" className={`cand ${i === 0 ? "best" : ""}`} onClick={() => pick(c)}>
                  <span><span className="n">{c.name}</span><span className="d">{[c.website, c.description].filter(Boolean).join(" · ")}</span></span>
                  <span className="go">{i === 0 ? "Yes, this one" : "Choose"}</span>
                </button>
              ))}
            </div>
            <div className="row"><button className="btn" type="button" onClick={() => { setPhase({ p: "idle" }); document.getElementById("app-query")?.focus(); }}>Something else</button></div>
          </div>
        )}

        {phase.p === "offer" && (
          <div className="card">
            <div className="kicker">{phase.overwrite ? "Research again" : "Vendor found, no guide yet"}</div>
            <h3>{phase.overwrite ? `Research ${phase.vendor.name} again?` : `There's no guide for ${phase.vendor.name} yet.`}</h3>
            {phase.vendor.website && <p className="small">{phase.vendor.website}{phase.vendor.description ? ` · ${phase.vendor.description}` : ""}</p>}
            <p>{agentOn
              ? "The agent can research it now: official developer docs first, then the changelog, other sources and Composio's docs. It takes about 2 to 4 minutes and fills the same 14-section guide. Nothing is saved until you say so."
              : "The research agent isn't configured on this deployment (no API key), so it can't research new apps."}</p>
            <div className="row">
              <button className="btn primary lg" type="button" disabled={!agentOn} onClick={() => router.push(researchHref(phase.vendor, phase.overwrite))}>Research {phase.vendor.name}</button>
              <button className="btn lg" type="button" onClick={() => setPhase({ p: "idle" })}>Not now</button>
            </div>
            <div className="foot"><span>Up to {BUDGET.searches} searches</span><span>Up to {BUDGET.fetches} pages read</span><span>Self-check before you see it</span></div>
          </div>
        )}

        {phase.p === "notfound" && (
          <div className="card">
            <h3>We couldn't place that app.</h3>
            <p>{phase.message}</p>
            <p className="small">A link usually works better than a name, for example https://calendly.com.</p>
            <div className="row"><button className="btn primary" type="button" onClick={tryWebsite}>Try its website</button></div>
          </div>
        )}

        {phase.p === "agentoff" && (
          <div className="card">
            <div className="kicker">Not in the library</div>
            <h3>There's no guide for that app yet.</h3>
            <p>{phase.message}</p>
            <div className="row">
              <button className="btn" type="button" onClick={() => { setPhase({ p: "idle" }); document.querySelector(".libhead")?.scrollIntoView({ behavior: "smooth" }); }}>Browse the library</button>
            </div>
          </div>
        )}

        {phase.p === "error" && (
          <div className="card err">
            <h3>Something went wrong.</h3>
            <p>{phase.message}</p>
            <div className="row"><button className="btn" type="button" onClick={() => resolve(q)}>Try again</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
