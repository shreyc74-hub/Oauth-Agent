"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Guide } from "@/lib/schema";
import { validateGuide } from "@/lib/schema";
import GuideView from "./GuideView";
import { Toolbar } from "./GuidePage";

type Candidate = { name: string; website: string; description?: string };
type Resolve =
  | { kind: "library"; slug: string; name: string }
  | { kind: "confirm"; candidates: Candidate[]; reason?: string }
  | { kind: "new"; vendor: Candidate; slug: string; existing?: boolean }
  | { kind: "notfound"; message: string };

type Phase =
  | { p: "idle" }
  | { p: "resolving" }
  | { p: "confirm"; r: Extract<Resolve, { kind: "confirm" }> }
  | { p: "offer"; vendor: Candidate; slug: string; overwrite: boolean }
  | { p: "generating"; vendor: Candidate }
  | { p: "review"; vendor: Candidate; overwrite: boolean }
  | { p: "saved"; slug: string }
  | { p: "error"; message: string };

export default function Explorer({ agentOn }: { agentOn: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<Phase>({ p: "idle" });
  const [guide, setGuide] = useState<Partial<Guide>>({});
  const [log, setLog] = useState<string[]>([]);
  const ctl = useRef<AbortController | null>(null);

  // "Research again" from a generated guide lands here with the vendor prefilled.
  useEffect(() => {
    const name = params.get("regenerate");
    if (name) setPhase({ p: "offer", vendor: { name, website: params.get("website") || "" }, slug: "", overwrite: true });
  }, [params]);

  async function resolve(query: string) {
    setPhase({ p: "resolving" });
    try {
      const res = await fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      const r = (await res.json()) as Resolve & { error?: string };
      if (!res.ok) throw new Error(r.error || "Could not look that up.");
      if (r.kind === "library") { router.push(`/guides/${r.slug}`); return; }
      if (r.kind === "confirm") { setPhase({ p: "confirm", r }); return; }
      if (r.kind === "new") {
        if (r.existing) { router.push(`/guides/${r.slug}`); return; }
        setPhase({ p: "offer", vendor: r.vendor, slug: r.slug, overwrite: false }); return;
      }
      setPhase({ p: "error", message: r.message });
    } catch (e) {
      setPhase({ p: "error", message: (e as Error).message });
    }
  }

  async function pick(c: Candidate) {
    // A confirmed vendor may already have a guide.
    setPhase({ p: "resolving" });
    const res = await fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: c.website || c.name, confirmed: c }) });
    const r = (await res.json()) as Resolve;
    if (r.kind === "library" || (r.kind === "new" && r.existing)) { router.push(`/guides/${(r as { slug: string }).slug}`); return; }
    setPhase({ p: "offer", vendor: c, slug: r.kind === "new" ? r.slug : "", overwrite: false });
  }

  async function generate(vendor: Candidate, overwrite: boolean) {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    setGuide({}); setLog([]);
    setPhase({ p: "generating", vendor });
    const g: Partial<Guide> = {};
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(vendor), signal: c.signal });
      if (!res.ok || !res.body) throw new Error((await res.text()) || "The research agent is unavailable.");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { type: string; text?: string; section?: string; data?: any; message?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "status") setLog((l) => [...l.slice(-40), ev.text!]);
          if (ev.type === "error") throw new Error(ev.message);
          if (ev.type === "section" && ev.section) {
            if (ev.section === "header") Object.assign(g, ev.data, { evidenceLevel: "generated" });
            else if (ev.section === "evidence") { g.evidence = ev.data.evidence; g.sources = ev.data.sources; }
            else (g as Record<string, unknown>)[ev.section] = ev.data;
            setGuide({ ...g });
          }
        }
      }
      const problems = validateGuide(g);
      if (problems.length) throw new Error("The agent's guide is incomplete: " + problems.join("; "));
      setPhase({ p: "review", vendor, overwrite });
    } catch (e) {
      if ((e as Error).name === "AbortError") { setPhase({ p: "idle" }); return; }
      setPhase({ p: "error", message: (e as Error).message });
    }
  }

  async function save(overwrite: boolean) {
    const res = await fetch("/api/guides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guide, overwrite }) });
    const r = await res.json();
    if (!res.ok) { setPhase({ p: "error", message: r.error || "Could not save." }); return; }
    setPhase({ p: "saved", slug: r.slug });
    router.refresh();
  }

  const busy = phase.p === "resolving" || phase.p === "generating";

  return (
    <div>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) resolve(q.trim()); }}>
        <input id="app-query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="App name or link, e.g. Zoom, monday, https://calendly.com" aria-label="App name or link" disabled={busy} />
        <button className="btn primary" type="submit" disabled={busy || !q.trim()}>{phase.p === "resolving" ? "Looking it up…" : "Find guide"}</button>
      </form>

      {phase.p === "confirm" && (
        <div className="panel">
          <h3>Which app do you mean?</h3>
          {phase.r.reason && <p className="small">{phase.r.reason}</p>}
          <div className="row">
            {phase.r.candidates.map((c) => (
              <button key={c.website + c.name} className="btn" type="button" onClick={() => pick(c)}>{c.name} <span className="small">{c.website}</span></button>
            ))}
            <button className="btn" type="button" onClick={() => setPhase({ p: "idle" })}>Something else</button>
          </div>
        </div>
      )}

      {phase.p === "offer" && (
        <div className="panel">
          <h3>{phase.overwrite ? `Research ${phase.vendor.name} again?` : `There's no guide for ${phase.vendor.name} yet.`}</h3>
          <p className="small">{phase.vendor.website} {phase.vendor.description ? `· ${phase.vendor.description}` : ""}</p>
          <p>{agentOn ? "The agent can research it now: official docs first, then changelogs and other sources. It takes about 2 to 3 minutes and fills the same 14-section guide. Nothing is saved until you say so." : "The research agent isn't configured on this deployment (no API key)."}</p>
          <div className="row">
            <button className="btn primary" type="button" disabled={!agentOn} onClick={() => generate(phase.vendor, phase.overwrite)}>Create guide</button>
            <button className="btn" type="button" onClick={() => setPhase({ p: "idle" })}>Not now</button>
          </div>
        </div>
      )}

      {phase.p === "generating" && (
        <div className="panel">
          <div className="live"><span className="pulse" /> Researching {phase.vendor.name}… <button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button></div>
          <div className="log" aria-live="polite">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      )}

      {phase.p === "review" && (
        <div className="panel">
          <h3>{phase.overwrite ? "Replace the saved guide with this one?" : "Save this guide to the library?"}</h3>
          <p className="small">Saving makes it available to everyone at its own link. It stays marked as generated until a person reviews it.</p>
          <div className="row">
            <button className="btn primary" type="button" onClick={() => save(phase.overwrite)}>{phase.overwrite ? "Replace saved guide" : "Save to library"}</button>
            <button className="btn" type="button" onClick={() => setPhase({ p: "idle" })}>Don't save</button>
          </div>
        </div>
      )}

      {phase.p === "saved" && (
        <div className="panel"><h3>Saved.</h3><a className="btn primary" href={`/guides/${phase.slug}`}>Open the guide</a></div>
      )}

      {phase.p === "error" && <div className="notice err">{phase.message} <button className="btn" type="button" onClick={() => setPhase({ p: "idle" })}>OK</button></div>}

      {(phase.p === "generating" || phase.p === "review") && (
        <div style={{ marginTop: 24 }}>
          {phase.p === "review" && <Toolbar g={guide as Guide} />}
          <GuideView g={guide} streaming={phase.p === "generating"} />
        </div>
      )}
    </div>
  );
}
